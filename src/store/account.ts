// 계정 연동: 로그인 시 필터 동기화(로컬/서버 충돌은 사용자가 선택), 계정 모드 자동 저장, 로그아웃 시 개인 데이터 제거.
import { decideFilterSync, filtersSavable, isDefaultFilters, sameFilters } from "@/lib/filtersync";
import { supabase } from "@/lib/supabase";
import type { Filters } from "@/lib/types";
import { PREFS_KEY, sanitizePrefs, usePrefs } from "./prefs";

// user_filter_settings에 없는 UI 값(면적 경계 포함 여부·표시 단위)은 qualification_preferences의 예약 토큰으로 보관한다.
// 임시 방편이며 전용 컬럼 추가는 설계 검토 대상이다(경계 포함 여부를 잃으면 '59㎡ 미만' 같은 조건의 결과가 달라진다).
const TOK_MIN_EXCL = "_ui:min_excl";
const TOK_MAX_EXCL = "_ui:max_excl";
const TOK_PYEONG = "_ui:unit:pyeong";

interface Row {
  user_id: string;
  preferred_region_codes: string[];
  budget_max_krw: number | string | null;
  min_area_sqm: number | string | null;
  max_area_sqm: number | string | null;
  housing_families: string[];
  qualification_preferences: string[];
  revision: number;
}

const num = (v: number | string | null): number | null => (v === null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function rowToFilters(r: Omit<Row, "user_id">): Filters {
  const q = r.qualification_preferences ?? [];
  return sanitizePrefs({
    filters: {
      regionCodes: r.preferred_region_codes ?? [],
      families: r.housing_families ?? [],
      budgetMaxKrw: num(r.budget_max_krw),
      minAreaSqm: num(r.min_area_sqm),
      minAreaInclusive: !q.includes(TOK_MIN_EXCL),
      maxAreaSqm: num(r.max_area_sqm),
      maxAreaInclusive: !q.includes(TOK_MAX_EXCL),
      areaUnit: q.includes(TOK_PYEONG) ? "pyeong" : "sqm",
      keyword: "",
    },
  }).filters;
}

export function filtersToRow(userId: string, f: Filters, revision: number): Row {
  const q: string[] = [];
  if (f.minAreaSqm !== null && !f.minAreaInclusive) q.push(TOK_MIN_EXCL);
  if (f.maxAreaSqm !== null && !f.maxAreaInclusive) q.push(TOK_MAX_EXCL);
  if (f.areaUnit === "pyeong") q.push(TOK_PYEONG);
  return {
    user_id: userId,
    preferred_region_codes: f.regionCodes,
    budget_max_krw: f.budgetMaxKrw,
    min_area_sqm: f.minAreaSqm,
    max_area_sqm: f.maxAreaSqm,
    housing_families: f.families,
    qualification_preferences: q,
    revision,
  };
}

let currentUser: string | null = null;
// 사용자가 바뀔 때마다 증가하는 세대 번호. 같은 사용자로 돌아와도(A→B→A) 이전 세대의 fetch·save 결과는 버린다.
let epoch = 0;
let revision = 0;
let lastSaved: Filters | null = null; // 마지막으로 서버에 저장된 조건(저장 중 더 바뀌었는지 판단)
let timer: ReturnType<typeof setTimeout> | null = null;
let unsub: (() => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();
const stale = (gen: number) => gen !== epoch;

/** 저장 요청이 이 시간 안에 끝나지 않으면 중단하고 실패로 본다(멈춘 요청이 이후 모든 저장을 막지 않게). */
let saveTimeoutMs = 15_000;
export function setSaveTimeoutForTests(ms: number) {
  saveTimeoutMs = ms;
}

function readLocalFilters(): Filters | null {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? sanitizePrefs(JSON.parse(raw)).filters : null;
  } catch {
    return null;
  }
}

// 저장하지 못한 계정 조건의 복구 사본. 비회원 저장 키와 분리하고 계정마다 키를 따로 두어, 다른 계정에 섞이거나 서로 덮지 않게 한다.
const pendingKey = (userId: string) => `moahome.pending.v2:${userId}`;

function writePending(userId: string, filters: Filters = usePrefs.getState().filters) {
  try {
    window.localStorage.setItem(pendingKey(userId), JSON.stringify({ userId, filters }));
  } catch {
    /* 무시 */
  }
}

const LEGACY_PENDING_KEY = "moahome.pending.v1"; // 이전 버전의 단일 키(사용자 id가 일치할 때만 읽고, 정리 때 함께 지운다)

function readPending(userId: string): Filters | null {
  try {
    const raw = window.localStorage.getItem(pendingKey(userId)) ?? legacyRaw(userId);
    if (!raw) return null;
    const p = JSON.parse(raw) as { userId?: string; filters?: unknown };
    return p.userId === userId ? sanitizePrefs({ filters: p.filters }).filters : null;
  } catch {
    return null;
  }
}

function legacyRaw(userId: string): string | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_PENDING_KEY);
    return raw && (JSON.parse(raw) as { userId?: string }).userId === userId ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 그 계정의 복구 사본을 지운다. saved를 주면 '방금 저장된 값과 같은 사본'만 지운다
 * (같은 계정의 다른 탭이 나중에 남긴 더 새로운 사본을 지우지 않는다).
 */
function clearPending(owner: string, saved?: Filters) {
  try {
    if (saved) {
      const cur = readPending(owner);
      if (cur && !sameFilters(cur, saved)) return;
    }
    window.localStorage.removeItem(pendingKey(owner));
    if (legacyRaw(owner)) window.localStorage.removeItem(LEGACY_PENDING_KEY);
  } catch {
    /* 무시 */
  }
}

// 미저장 초안 모델: 계정 모드에서 조건이 바뀌는 즉시 계정별 초안에 기록하고(서버 저장만 800ms 늦춘다),
// 서버 저장이 성공했을 때 '저장된 값과 같은 초안'만 지운다. 저장 시작·실패 때 따로 쓰지 않는다.
let draftFor: string | null = null;
let draftLast = "";

function startDraft(userId: string) {
  draftFor = userId;
  draftLast = JSON.stringify(usePrefs.getState().filters);
}

usePrefs.subscribe((s) => {
  if (!draftFor || s.mode !== "account" || s.conflict) return;
  const cur = JSON.stringify(s.filters);
  if (cur === draftLast) return;
  draftLast = cur;
  writePending(draftFor, s.filters);
});

function clearLocal() {
  try {
    window.localStorage.removeItem(PREFS_KEY);
  } catch {
    /* 무시 */
  }
}

async function fetchServer(userId: string): Promise<{ filters: Filters; revision: number } | null> {
  const { data, error } = await supabase!.from("user_filter_settings").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { filters: rowToFilters(data as Row), revision: (data as Row).revision } : null;
}

type SaveResult = "saved" | "error" | "invalid" | "load-error" | "conflict" | "ignored";

// ---- 필터 저장 RPC(public.save_user_filter_settings) -----------------------------------------------------------------
// 서버가 expected_revision 으로 원자적으로 비교·갱신하고, request_id 로 시간 초과 뒤 재시도를 멱등 처리한다(docs/API_SPEC.md).
type FilterRow = Omit<Row, "user_id">;

interface RpcArgs {
  p_preferred_region_codes: string[];
  p_budget_max_krw: string | null; // 안전 정수를 넘는 값도 잃지 않도록 십진 문자열로 보낸다
  p_min_area_sqm: number | null;
  p_max_area_sqm: number | null;
  p_housing_families: string[];
  p_qualification_preferences: string[];
  p_expected_revision: number;
  p_request_id: string;
}

interface SaveRequest {
  args: RpcArgs;
  filters: Filters; // 이 요청이 저장하려는 조건(성공 때 lastSaved)
}

type RpcOutcome =
  | { kind: "saved"; applied: number; replayed: boolean }
  | { kind: "conflict"; current: FilterRow }
  | { kind: "invalid" | "error" | "unknown" };

function newRequestId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function buildRequest(f: Filters, expected: number): SaveRequest {
  const row = filtersToRow("", f, expected);
  return {
    filters: f,
    args: {
      p_preferred_region_codes: row.preferred_region_codes,
      p_budget_max_krw: row.budget_max_krw === null ? null : String(row.budget_max_krw),
      p_min_area_sqm: row.min_area_sqm as number | null,
      p_max_area_sqm: row.max_area_sqm as number | null,
      p_housing_families: row.housing_families,
      p_qualification_preferences: row.qualification_preferences,
      p_expected_revision: expected,
      p_request_id: newRequestId(),
    },
  };
}

const EMPTY_ROW: FilterRow = { preferred_region_codes: [], budget_max_krw: null, min_area_sqm: null, max_area_sqm: null, housing_families: [], qualification_preferences: [], revision: 0 };

// 결과를 알 수 없는(시간 초과·네트워크 오류) 직전 요청: 다음 시도에서 재조회한 뒤 같은 request_id·같은 입력으로 다시 보낸다.
let unknownReq: SaveRequest | null = null;

/** SQLSTATE가 있는 응답은 서버가 판단한 결과다. 22023/22003/23514는 입력 문제(invalid), 나머지는 서버·권한 오류(error). 코드가 없으면 결과를 알 수 없다. */
function classifyError(e: { code?: string } | null | undefined): RpcOutcome {
  const code = e?.code ?? "";
  if (code === "22023" || code === "22003" || code === "23514") return { kind: "invalid" };
  return code ? { kind: "error" } : { kind: "unknown" };
}

/** RPC 한 번: 시간 제한을 두고, 제한을 넘기면 요청을 중단하고 '알 수 없음'으로 본다(이미 반영됐을 수 있다). */
async function callRpc(req: SaveRequest): Promise<RpcOutcome> {
  const ctrl = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timeoutId = setTimeout(() => {
      ctrl.abort();
      resolve({ timedOut: true });
    }, saveTimeoutMs);
  });
  try {
    const q = supabase!.rpc("save_user_filter_settings", req.args) as unknown as PromiseLike<{ data: unknown; error: { code?: string } | null }> & {
      abortSignal?: (s: AbortSignal) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
    };
    const call = typeof q.abortSignal === "function" ? q.abortSignal(ctrl.signal) : q;
    const res = await Promise.race([Promise.resolve(call), timeout]);
    if ("timedOut" in res) return { kind: "unknown" };
    if (res.error) return classifyError(res.error);
    const d = res.data as { status?: string; applied_revision?: number; replayed?: boolean; current?: FilterRow } | null;
    if (d?.status === "saved" && Number.isInteger(d.applied_revision)) return { kind: "saved", applied: d.applied_revision!, replayed: !!d.replayed };
    if (d?.status === "conflict" && d.current) return { kind: "conflict", current: d.current };
    return { kind: "error" };
  } catch {
    return { kind: "unknown" }; // 네트워크 오류 등: 서버에 도달했는지 모른다
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 저장은 한 번에 하나씩 순서대로 실행하고, 저장할 값은 '실행 시점의 최신 필터'를 읽는다.
 * 서버가 예상 revision 이 같을 때만 갱신하므로 늦게 도착한 오래된 요청·다른 탭의 저장이 덮어쓰지 못한다.
 * - conflict: 서버 값(응답의 current)과 내 조건을 충돌 선택창으로 넘긴다(초안은 유지).
 * - 결과를 모르는 요청(시간 초과 등): 서버를 재조회한 뒤 같은 request_id·같은 입력으로 한 번 더 보내 이미 반영됐는지 확인한다.
 * 세대가 바뀌었으면(로그아웃·계정 전환) 저장하지 않고 'ignored'를 돌려준다.
 */
function saveLatest(userId: string, gen: number, afterConflictChoice = false): Promise<SaveResult> {
  const run = async (): Promise<SaveResult> => {
    if (stale(gen) || currentUser !== userId) return "ignored";
    // 충돌 선택창이 열려 있는 동안에는 대기 중이던 자동 저장이 서버 값을 덮어쓰지 않는다(선택 결과를 저장하는 호출만 예외).
    if (!afterConflictChoice && usePrefs.getState().conflict) return "ignored";
    const resumed = unknownReq !== null; // 직전 요청의 결과를 모른 채 시작하는가
    let req = unknownReq;
    let refetched: { revision: number; filters: Filters } | null = null;
    let out: RpcOutcome = { kind: "unknown" };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (req) {
        // 직전 요청의 결과를 모른다: 먼저 본인 필터를 재조회한다. 재조회가 실패하면 서버 상태를 모른 채 보내지 않는다.
        try {
          const s = await fetchServer(userId);
          refetched = { revision: s?.revision ?? 0, filters: s?.filters ?? rowToFilters(EMPTY_ROW) };
        } catch {
          return stale(gen) ? "ignored" : "load-error";
        }
        if (stale(gen)) return "ignored";
      } else {
        const f = usePrefs.getState().filters;
        if (!filtersSavable(f)) return "invalid"; // DB 제약에 걸릴 값은 서버로 보내지 않는다
        req = buildRequest(f, revision);
      }
      out = await callRpc(req);
      if (stale(gen)) return "ignored"; // 저장 중 계정이 바뀜: 새 세대의 개정 번호·상태를 건드리지 않는다
      if (out.kind !== "unknown") break;
      unknownReq = req; // 결과를 모른다: 같은 request_id·입력으로 재확인한다
    }
    if (out.kind === "unknown") return "error";
    unknownReq = null;
    if (out.kind === "saved") {
      // 재생(replayed)이면 applied_revision 은 원래 요청의 값이라 이후 다른 저장으로 서버가 더 앞서 있을 수 있다: 재조회한 revision 을 우선한다.
      if (refetched && refetched.revision > out.applied) {
        // 내 요청은 반영됐지만(재생) 그 뒤 다른 기기가 더 새 조건을 저장했다: 서버가 앞서 있으므로 그 값을 덮어쓰지 않고 선택하게 한다.
        revision = refetched.revision;
        const local = usePrefs.getState().filters;
        if (sameFilters(local, refetched.filters)) {
          lastSaved = local;
          return "saved";
        }
        usePrefs.getState().setConflict({ local, server: refetched.filters });
        return "conflict";
      }
      revision = out.applied;
      lastSaved = req!.filters;
      // 결과를 모르던 요청을 마무리하는 동안 사용자가 조건을 더 바꿨다면, 그 최신 조건도 이어서 저장한다(새 요청).
      if (resumed && !sameFilters(usePrefs.getState().filters, req!.filters)) return run();
      return "saved";
    }
    if (out.kind === "conflict") {
      revision = out.current.revision;
      const server = rowToFilters(out.current);
      const local = usePrefs.getState().filters;
      if (sameFilters(local, server)) {
        lastSaved = local; // 서버가 이미 같은 조건이다
        return "saved";
      }
      usePrefs.getState().setConflict({ local, server });
      return "conflict";
    }
    return out.kind; // invalid | error
  };
  const job: Promise<SaveResult> = queue.then(run);
  queue = job.catch(() => undefined);
  return job.catch(() => "error" as const);
}

function reportSave(gen: number, r: SaveResult) {
  if (r === "ignored" || stale(gen)) return;
  usePrefs.getState().setSaveStatus(r === "conflict" ? "idle" : r); // 충돌은 선택창이 안내한다
  // 저장 성공: 저장된 값과 같은 초안만 지운다(저장하는 사이 더 바뀐 값이나 다른 탭의 더 새로운 초안은 남는다). 실패·invalid는 초안을 그대로 둔다.
  if (currentUser && r === "saved") clearPending(currentUser, lastSaved ?? undefined);
}

/** 저장 실패 뒤 사용자가 누르는 '다시 저장': 현재 필터를 같은 경로로 다시 저장한다. */
export async function retrySave(): Promise<void> {
  const userId = currentUser;
  const gen = epoch;
  if (!userId) return;
  const r = await saveLatest(userId, gen);
  reportSave(gen, r);
  if (r === "saved" && !stale(gen)) clearLocal(); // 서버에 저장됐으니 남겨 둔 로컬 사본을 정리
}

function startAutosave(userId: string, gen: number, baseline?: Filters) {
  unsub?.();
  // baseline: 첫 저장에 실제로 쓴 값. 첫 저장을 기다리는 동안 더 바뀌었다면 그 차이를 바로 저장 대기열에 올린다.
  let last = JSON.stringify(baseline ?? usePrefs.getState().filters);
  const now = JSON.stringify(usePrefs.getState().filters);
  if (now !== last) {
    last = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void saveLatest(userId, gen).then((r) => reportSave(gen, r)), 800);
  }
  unsub = usePrefs.subscribe((s) => {
    if (s.mode !== "account" || s.syncing || s.conflict || stale(gen)) return;
    const cur = JSON.stringify(s.filters);
    if (cur === last) return;
    last = cur;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void saveLatest(userId, gen).then((r) => reportSave(gen, r)), 800);
  });
}

export async function resolveConflict(choice: "local" | "server"): Promise<void> {
  const { conflict, applyFilters, setConflict } = usePrefs.getState();
  const userId = currentUser;
  const gen = epoch;
  if (!conflict || !userId) return;
  const chosen = choice === "local" ? conflict.local : conflict.server;
  // 계정 모드로 먼저 전환한다: 이후의 필터 적용·충돌 해제가 브라우저 저장소에 다시 쓰이지 않게(계정 모드는 로컬에 저장하지 않는다).
  // 이후 await 동안 계정이 바뀌면 onUserChanged가 resetToGuest로 되돌린다.
  usePrefs.getState().setMode("account");
  applyFilters(chosen);
  startDraft(userId);
  // 선택이 끝났으니 비회원 저장본과 이전 복구 사본은 정리한다. 내 조건 저장이 실패하면 reportSave가 사용자 전용 복구 사본을 새로 남긴다
  // (비회원 저장 키는 다른 계정에 넘어갈 수 있어 계정 조건을 남기지 않는다).
  clearLocal();
  let saved: Filters | undefined;
  if (choice === "local") {
    writePending(userId, chosen); // 저장이 끝나기 전에 탭이 닫혀도 선택한 조건을 잃지 않게 먼저 남기고, 저장 성공 때 지운다
    const r = await saveLatest(userId, gen, true);
    reportSave(gen, r);
    if (r === "conflict") return; // 그 사이 서버가 또 바뀌었다: 새 충돌 선택창을 그대로 둔다
    if (r === "saved") saved = lastSaved ?? undefined;
  } else {
    clearPending(userId);
  }
  if (stale(gen)) return; // 저장 중 계정이 바뀜: 이전 계정의 필터를 적용하지 않는다
  setConflict(null);
  usePrefs.getState().setSyncing(false);
  startAutosave(userId, gen, saved);
}

/**
 * 조회 실패 뒤 '다시 불러오기': 같은 계정으로 동기화를 처음부터 다시 한다.
 * 실패 상태에서 사용자가 바꾼 화면 속 조건은 버리지 않고 '로컬 후보'로 넘겨, 서버 값과 다르면 선택창을 띄운다.
 */
export async function retryAccountSync(): Promise<void> {
  const u = currentUser;
  if (!u) return;
  if (unknownReq) {
    // 결과를 모르는 저장이 남아 있으면 같은 request ID로 먼저 확인한다(재동기화가 그 ID를 버리면 늦게 도착한 요청이 서버 값을 바꿀 수 있다).
    const gen = epoch;
    const r = await saveLatest(u, gen);
    reportSave(gen, r);
    if (r === "load-error" || r === "conflict" || r === "ignored") return; // 아직 확인하지 못했거나 이미 선택창이 열렸다
  }
  const inMemory = usePrefs.getState().filters;
  currentUser = null;
  await onUserChanged(u, { localOverride: inMemory });
}

/** 로그인/계정 변경/로그아웃 때 호출. userId가 null이면 개인 데이터를 모두 제거한다. */
export async function onUserChanged(userId: string | null, opts: { localOverride?: Filters } = {}): Promise<void> {
  if (userId === currentUser) return;
  unsub?.();
  unsub = null;
  if (timer) clearTimeout(timer);
  const prevUser = currentUser;
  const hadUser = prevUser !== null;
  currentUser = userId;
  epoch += 1;
  draftFor = null; // 이전 계정의 초안 기록을 멈춘다(새 계정은 동기화 결정 뒤 다시 시작)
  const gen = epoch;
  revision = 0;
  lastSaved = null;
  unknownReq = null;
  if (!userId) {
    if (hadUser) {
      usePrefs.getState().resetToGuest();
      clearPending(prevUser!); // 로그아웃하면 그 계정이 이 브라우저에 남긴 저장 못 한 조건도 지운다(다른 계정의 사본은 건드리지 않음)
    }
    return;
  }
  if (hadUser) {
    usePrefs.getState().resetToGuest(); // 계정 전환: 이전 계정의 필터가 섞이지 않게 먼저 비운다
    clearPending(prevUser!);
  }
  if (!supabase) return;
  usePrefs.getState().setSaveStatus("idle");
  usePrefs.getState().setSyncing(true); // 동기화 중에는 비회원 저장 훅이 브라우저에 쓰지 않는다(prefs.ts)
  try {
    // 재시도 때 넘어온 화면 조건이 기본값이면 '바꾼 적 없음'으로 보고 복구 사본·비회원 저장본을 우선한다.
    const override = opts.localOverride && !isDefaultFilters(opts.localOverride) ? opts.localOverride : undefined;
    let local = hadUser ? null : (override ?? readPending(userId) ?? readLocalFilters());
    const startSnap = usePrefs.getState().filters;
    const server = await fetchServer(userId);
    if (stale(gen)) return; // 조회 중 계정이 바뀜(같은 사용자로 되돌아온 경우 포함)
    // 조회를 기다리는 동안 사용자가 조건을 바꿨다면 그 값을 '로컬 후보'로 삼아 서버 값에 덮이지 않게 한다.
    const live = usePrefs.getState().filters;
    if (!sameFilters({ ...live, areaUnit: startSnap.areaUnit }, startSnap)) local = live;   // 표시 단위(㎡/평)만 바꾼 것은 조건 변경이 아니다
    revision = server?.revision ?? 0;
    const d = decideFilterSync(local, server?.filters ?? null);
    const p = usePrefs.getState();
    if (d.action === "ask") {
      writePending(userId, local!); // 선택창을 연 채 새로고침해도 후보를 잃지 않게(선택이 끝나면 정리)
      p.setConflict({ local: local!, server: server!.filters });
      return; // 선택 전에는 저장하지 않는다. resolveConflict가 이어서 처리
    }
    p.setMode("account"); // 필터를 적용하기 전에 계정 모드로: 적용된 값이 브라우저 저장소에 쓰이지 않게
    if (d.action === "adopt-server") p.applyFilters(server!.filters);
    if (d.action === "keep" && server) p.applyFilters(server.filters);
    if (d.action !== "push-local") clearPending(userId); // 서버 값을 쓰는 경우 이전 복구 사본은 더 쓰지 않는다
    if (local) clearLocal(); // 계정 모드에서는 비회원 저장본에 필터를 남기지 않는다(실패한 저장은 사용자 전용 복구 사본이 맡는다)
    startDraft(userId);
    let savedFirst: Filters | undefined;
    if (d.action === "push-local") {
      p.applyFilters(local!);
      writePending(userId, local!); // 저장이 끝나기 전 종료에 대비해 먼저 남기고, 성공 시 reportSave가 지운다
      const r = await saveLatest(userId, gen);
      if (stale(gen)) return; // 저장 중 계정이 바뀜
      reportSave(gen, r);
      savedFirst = r === "saved" ? (lastSaved ?? undefined) : undefined;
    }
    startAutosave(userId, gen, savedFirst);
  } catch {
    if (!stale(gen)) {
      // 서버 조회 실패: 로그인 상태인데 비회원 저장 모드에 남으면 이후 변경이 브라우저에 쓰이므로 계정 모드로 전환한다
      // (저장·자동 저장은 하지 않음). 화면이 실패를 알리고 '다시 불러오기'를 제공한다.
      usePrefs.getState().setMode("account");
      usePrefs.getState().setSaveStatus("load-error");
    }
  } finally {
    if (!stale(gen) && !usePrefs.getState().conflict) usePrefs.getState().setSyncing(false);
  }
}
