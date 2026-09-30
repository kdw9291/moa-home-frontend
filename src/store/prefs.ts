"use client";
import { create } from "zustand";
import { DEFAULT_FILTERS, type Sort, type Tab } from "@/lib/feed";
import type { AreaUnit, Family, Filters } from "@/lib/types";

// 비회원 필터·정렬·탭 선호는 브라우저에만 저장한다. 정적 HTML과 첫 클라이언트 렌더는 기본값을 쓰고
// 마운트 후 hydrate()로 복원한다(hydration 불일치 방지). 개인 데이터는 서버로 보내지 않는다.
const KEY = "moahome.prefs.v1";

interface Prefs {
  filters: Filters;
  tab: Tab;
  sort: Sort;
}

export const PREFS_KEY = KEY;

interface State extends Prefs {
  hydrated: boolean;
  /** guest: 브라우저(localStorage)에만 저장. account: 계정(서버)이 단일 기준이며 브라우저 저장은 하지 않는다. */
  mode: "guest" | "account";
  syncing: boolean; // 로그인 직후 계정 필터를 불러오는 중
  /** 계정 모드 자동 저장 상태. invalid: 저장할 수 없는 조합(예: 최소>최대), error: 서버 저장 실패, load-error: 계정 조건 조회 실패 */
  saveStatus: "idle" | "saved" | "invalid" | "error" | "load-error";
  setSaveStatus: (s: State["saveStatus"]) => void;
  conflict: { local: Filters; server: Filters } | null; // 로컬/서버 필터가 달라 사용자 선택을 기다리는 중
  setMode: (m: "guest" | "account") => void;
  setSyncing: (b: boolean) => void;
  setConflict: (c: State["conflict"]) => void;
  applyFilters: (f: Filters) => void;
  resetToGuest: () => void;
  hydrate: () => void;
  setFilters: (patch: Partial<Filters>) => void;
  resetFilters: () => void;
  setAreaUnit: (u: AreaUnit) => void;
  setTab: (t: Tab) => void;
  setSort: (s: Sort) => void;
}

const FAMILIES: Family[] = ["apt", "remndr", "urbty_ofctl"];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** 저장된 값을 신뢰하지 않고 검증해 기본값 위에 얹는다(손상·구버전 데이터 방어). */
export function sanitizePrefs(raw: unknown): Prefs {
  const base: Prefs = { filters: { ...DEFAULT_FILTERS }, tab: "open", sort: "latest" };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const f = (r.filters ?? {}) as Record<string, unknown>;
  const filters: Filters = {
    regionCodes: Array.isArray(f.regionCodes) ? f.regionCodes.filter((x): x is string => typeof x === "string") : [],
    families: Array.isArray(f.families) ? f.families.filter((x): x is Family => FAMILIES.includes(x as Family)) : [],
    budgetMaxKrw: num(f.budgetMaxKrw),
    minAreaSqm: num(f.minAreaSqm),
    minAreaInclusive: f.minAreaInclusive !== false,
    maxAreaSqm: num(f.maxAreaSqm),
    maxAreaInclusive: f.maxAreaInclusive !== false,
    areaUnit: f.areaUnit === "pyeong" ? "pyeong" : "sqm",
    keyword: typeof f.keyword === "string" ? f.keyword.slice(0, 100) : "",
  };
  const tab: Tab = r.tab === "remndr" || r.tab === "closed" ? r.tab : "open";
  const sort: Sort = r.sort === "deadline" || r.sort === "price" || r.sort === "supply" ? r.sort : "latest";
  return { filters, tab, sort };
}

export const usePrefs = create<State>((set, get) => ({
  filters: { ...DEFAULT_FILTERS },
  tab: "open",
  sort: "latest",
  hydrated: false,
  mode: "guest",
  syncing: false,
  saveStatus: "idle",
  setSaveStatus: (saveStatus) => set({ saveStatus }),
  conflict: null,
  setMode: (mode) => set({ mode }),
  setSyncing: (syncing) => set({ syncing }),
  setConflict: (conflict) => set({ conflict }),
  applyFilters: (filters) => set({ filters }),
  resetToGuest: () => {
    // 로그아웃·계정 전환: 이전 사용자의 필터를 남기지 않는다(브라우저 저장본도 제거)
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* 무시 */
    }
    set({ filters: { ...DEFAULT_FILTERS }, tab: "open", sort: "latest", mode: "guest", syncing: false, conflict: null, saveStatus: "idle" });
  },
  hydrate: () => {
    if (get().hydrated) return;
    let parsed: unknown = null;
    try {
      const raw = window.localStorage.getItem(KEY);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null; // 저장소 접근 불가·JSON 손상: 기본값으로 진행
    }
    set({ ...sanitizePrefs(parsed), hydrated: true });
  },
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  resetFilters: () => set((s) => ({ filters: { ...DEFAULT_FILTERS, areaUnit: s.filters.areaUnit } })), // 표시 단위 선호는 유지
  setAreaUnit: (areaUnit) => set((s) => ({ filters: { ...s.filters, areaUnit } })),
  setTab: (tab) => set({ tab }),
  setSort: (sort) => set({ sort }),
}));

if (typeof window !== "undefined") {
  usePrefs.subscribe((s) => {
    // 복원 전·계정 모드·계정 동기화 중(로그인 직후 조회 대기·충돌 선택 대기)에는 브라우저에 저장하지 않는다
    if (!s.hydrated || s.mode !== "guest" || s.syncing) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ filters: s.filters, tab: s.tab, sort: s.sort }));
    } catch {
      /* 저장 실패는 무시: 기능은 세션 메모리로 계속 동작 */
    }
  });
}
