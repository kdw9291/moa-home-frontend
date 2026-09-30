// 계정 연동: 로그인 시 필터 동기화(로컬/서버 충돌은 사용자가 선택), 계정 모드 자동 저장, 로그아웃 시 개인 데이터 제거.
import { DEFAULT_FILTERS } from "@/lib/feed";
import { decideFilterSync, filtersSavable } from "@/lib/filtersync";
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

export function rowToFilters(r: Row): Filters {
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

// 저장에 실패한 계정 조건의 복구 사본. 비회원 저장 키와 분리하고 사용자 id를 붙여, 다른 계정에 섞이지 않게 한다.
const PENDING_KEY = "moahome.pending.v1";

function writePending(userId: string) {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ userId, filters: usePrefs.getState().filters }));
  } catch {
    /* 무시 */
  }
}

function readPending(userId: string): Filters | null {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { userId?: string; filters?: unknown };
    return p.userId === userId ? sanitizePrefs({ filters: p.filters }).filters : null;
  } catch {
    return null;
  }
}

function clearPending() {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    /* 무시 */
  }
}

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

type SaveResult = "saved" | "error" | "invalid" | "ignored";

/** upsert 한 번: 시간 제한을 두고, 제한을 넘기면 요청을 중단한다(abortSignal을 지원하면 사용). */
async function upsertWithTimeout(row: Row): Promise<{ error: unknown }> {
  const ctrl = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ error: unknown }>((resolve) => {
    timeoutId = setTimeout(() => {
      ctrl.abort();
      resolve({ error: new Error("timeout") });
    }, saveTimeoutMs);
  });
  try {
    const q = supabase!.from("user_filter_settings").upsert(row, { onConflict: "user_id" }) as unknown as PromiseLike<{ error: unknown }> & { abortSignal?: (s: AbortSignal) => PromiseLike<{ error: unknown }> };
    const req = typeof q.abortSignal === "function" ? q.abortSignal(ctrl.signal) : q;
    return await Promise.race([Promise.resolve(req), timeout]);
  } catch (e) {
    return { error: e };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 저장은 한 번에 하나씩 순서대로 실행하고, 저장할 값은 '실행 시점의 최신 필터'를 읽는다.
 * 그래서 느린 이전 저장이 나중 저장을 덮어쓰지 못하고, 개정 번호도 순서대로 증가한다.
 * 세대가 바뀌었으면(로그아웃·계정 전환) 저장하지 않고 'ignored'를 돌려준다.
 */
function saveLatest(userId: string, gen: number): Promise<SaveResult> {
  const job: Promise<SaveResult> = queue.then(async () => {
    if (stale(gen) || currentUser !== userId) return "ignored";
    const f = usePrefs.getState().filters;
    if (!filtersSavable(f)) return "invalid"; // DB 제약에 걸릴 값은 서버로 보내지 않는다
    const next = revision + 1;
    const { error } = await upsertWithTimeout(filtersToRow(userId, f, next));
    if (stale(gen)) return "ignored"; // 저장 중 계정이 바뀜: 새 세대의 개정 번호·상태를 건드리지 않는다
    if (error) return "error";
    revision = next;
    return "saved";
  });
  queue = job.catch(() => undefined);
  return job.catch(() => "error" as const);
}

function reportSave(gen: number, r: SaveResult) {
  if (r === "ignored" || stale(gen)) return;
  usePrefs.getState().setSaveStatus(r);
  if (currentUser) {
    if (r === "saved") clearPending();
    else if (r === "error" || r === "invalid") writePending(currentUser); // 새로고침해도 저장 못 한 조건을 잃지 않게(같은 계정일 때만 복구)
  }
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

function startAutosave(userId: string, gen: number) {
  unsub?.();
  let last = JSON.stringify(usePrefs.getState().filters);
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
  // 선택이 끝났으니 비회원 저장본과 이전 복구 사본은 정리한다. 내 조건 저장이 실패하면 reportSave가 사용자 전용 복구 사본을 새로 남긴다
  // (비회원 저장 키는 다른 계정에 넘어갈 수 있어 계정 조건을 남기지 않는다).
  clearLocal();
  clearPending();
  if (choice === "local") reportSave(gen, await saveLatest(userId, gen));
  if (stale(gen)) return; // 저장 중 계정이 바뀜: 이전 계정의 필터를 적용하지 않는다
  setConflict(null);
  usePrefs.getState().setSyncing(false);
  startAutosave(userId, gen);
}

/**
 * 조회 실패 뒤 '다시 불러오기': 같은 계정으로 동기화를 처음부터 다시 한다.
 * 실패 상태에서 사용자가 바꾼 화면 속 조건은 버리지 않고 '로컬 후보'로 넘겨, 서버 값과 다르면 선택창을 띄운다.
 */
export async function retryAccountSync(): Promise<void> {
  const u = currentUser;
  if (!u) return;
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
  const hadUser = currentUser !== null;
  currentUser = userId;
  epoch += 1;
  const gen = epoch;
  revision = 0;
  if (!userId) {
    if (hadUser) {
      usePrefs.getState().resetToGuest();
      clearPending(); // 로그아웃하면 이 브라우저에 남은 저장 못 한 조건도 지운다
    }
    return;
  }
  if (hadUser) {
    usePrefs.getState().resetToGuest(); // 계정 전환: 이전 계정의 필터가 섞이지 않게 먼저 비운다
    clearPending();
  }
  if (!supabase) return;
  usePrefs.getState().setSaveStatus("idle");
  usePrefs.getState().setSyncing(true); // 동기화 중에는 비회원 저장 훅이 브라우저에 쓰지 않는다(prefs.ts)
  try {
    // 재시도 때 넘어온 화면 조건이 기본값이면 '바꾼 적 없음'으로 보고 복구 사본·비회원 저장본을 우선한다.
    const override = opts.localOverride && JSON.stringify(opts.localOverride) !== JSON.stringify(DEFAULT_FILTERS) ? opts.localOverride : undefined;
    let local = hadUser ? null : (override ?? readPending(userId) ?? readLocalFilters());
    const startSnap = JSON.stringify(usePrefs.getState().filters);
    const server = await fetchServer(userId);
    if (stale(gen)) return; // 조회 중 계정이 바뀜(같은 사용자로 되돌아온 경우 포함)
    // 조회를 기다리는 동안 사용자가 조건을 바꿨다면 그 값을 '로컬 후보'로 삼아 서버 값에 덮이지 않게 한다.
    const live = usePrefs.getState().filters;
    if (JSON.stringify(live) !== startSnap) local = live;
    revision = server?.revision ?? 0;
    const d = decideFilterSync(local, server?.filters ?? null);
    const p = usePrefs.getState();
    if (d.action === "ask") {
      p.setConflict({ local: local!, server: server!.filters });
      return; // 선택 전에는 저장하지 않는다. resolveConflict가 이어서 처리
    }
    p.setMode("account"); // 필터를 적용하기 전에 계정 모드로: 적용된 값이 브라우저 저장소에 쓰이지 않게
    clearPending(); // 후보는 이미 읽었다. 저장이 실패하면 reportSave가 복구 사본을 다시 남긴다
    if (d.action === "adopt-server") p.applyFilters(server!.filters);
    if (d.action === "keep" && server) p.applyFilters(server.filters);
    if (local) clearLocal(); // 계정 모드에서는 비회원 저장본에 필터를 남기지 않는다(실패한 저장은 사용자 전용 복구 사본이 맡는다)
    if (d.action === "push-local") {
      p.applyFilters(local!);
      const r = await saveLatest(userId, gen);
      if (stale(gen)) return; // 저장 중 계정이 바뀜
      reportSave(gen, r);
    }
    startAutosave(userId, gen);
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
