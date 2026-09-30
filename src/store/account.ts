// 계정 연동: 로그인 시 필터 동기화(로컬/서버 충돌은 사용자가 선택), 계정 모드 자동 저장, 로그아웃 시 개인 데이터 제거.
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

function readLocalFilters(): Filters | null {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? sanitizePrefs(JSON.parse(raw)).filters : null;
  } catch {
    return null;
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
    const { error } = await supabase!.from("user_filter_settings").upsert(filtersToRow(userId, f, next), { onConflict: "user_id" });
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
  if (choice === "local") reportSave(gen, await saveLatest(userId, gen));
  if (stale(gen)) return; // 저장 중 계정이 바뀜: 이전 계정의 필터를 적용하지 않는다
  setConflict(null);
  clearLocal();
  usePrefs.getState().setSyncing(false);
  startAutosave(userId, gen);
}

/** 조회 실패 뒤 '다시 시도': 같은 계정으로 동기화를 처음부터 다시 한다. */
export async function retryAccountSync(): Promise<void> {
  const u = currentUser;
  if (!u) return;
  currentUser = null;
  await onUserChanged(u);
}

/** 로그인/계정 변경/로그아웃 때 호출. userId가 null이면 개인 데이터를 모두 제거한다. */
export async function onUserChanged(userId: string | null): Promise<void> {
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
    if (hadUser) usePrefs.getState().resetToGuest();
    return;
  }
  if (hadUser) usePrefs.getState().resetToGuest(); // 계정 전환: 이전 계정의 필터가 섞이지 않게 먼저 비운다
  if (!supabase) return;
  usePrefs.getState().setSaveStatus("idle");
  usePrefs.getState().setSyncing(true);
  try {
    const local = hadUser ? null : readLocalFilters();
    const server = await fetchServer(userId);
    if (stale(gen)) return; // 조회 중 계정이 바뀜(같은 사용자로 되돌아온 경우 포함)
    revision = server?.revision ?? 0;
    const d = decideFilterSync(local, server?.filters ?? null);
    const p = usePrefs.getState();
    if (d.action === "ask") {
      p.setConflict({ local: local!, server: server!.filters });
      return; // 선택 전에는 저장하지 않는다. resolveConflict가 이어서 처리
    }
    p.setMode("account"); // 필터를 적용하기 전에 계정 모드로: 적용된 값이 브라우저 저장소에 쓰이지 않게
    if (d.action === "adopt-server") p.applyFilters(server!.filters);
    if (d.action === "keep" && server) p.applyFilters(server.filters);
    if (d.action === "push-local") {
      p.applyFilters(local!);
      const r = await saveLatest(userId, gen);
      if (stale(gen)) return; // 저장 중 계정이 바뀜
      reportSave(gen, r);
    }
    if (local) clearLocal(); // 계정 모드에서는 브라우저에 필터를 남기지 않는다
    startAutosave(userId, gen);
  } catch {
    if (!stale(gen)) {
      // 서버 조회 실패: 로그인 상태인데 비회원 저장 모드에 남으면 이후 변경이 브라우저에 쓰이므로 계정 모드로 전환한다
      // (저장·자동 저장은 하지 않음). 화면이 실패를 알리고 '다시 시도'를 제공한다.
      usePrefs.getState().setMode("account");
      usePrefs.getState().setSaveStatus("load-error");
    }
  } finally {
    if (!stale(gen) && !usePrefs.getState().conflict) usePrefs.getState().setSyncing(false);
  }
}
