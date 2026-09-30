// 로그인 시 로컬(비회원) 필터와 서버 저장 필터를 어떻게 처리할지 결정한다(순수 함수).
import { DEFAULT_FILTERS } from "./feed";
import type { Filters } from "./types";

export type SyncDecision =
  | { action: "adopt-server" } // 서버 값을 쓰고 로컬은 지운다
  | { action: "push-local" } // 서버에 없으므로 로컬 값을 서버에 저장
  | { action: "ask" } // 둘 다 있고 다르다: 사용자가 선택
  | { action: "keep" }; // 바꿀 것 없음

/** 계정에 저장할 수 있는 값인가(DB 제약과 같은 기준: 최소 면적 ≤ 최대 면적, 음수 없음). */
const AREA_MAX = 99_999_999.99; // numeric(10,2)의 최대값
export function filtersSavable(f: Filters): boolean {
  const area = (v: number | null) => v === null || (Number.isFinite(v) && v > 0 && v <= AREA_MAX); // 스키마: 면적 > 0
  const money = (v: number | null) => v === null || (Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER); // bigint 정수, 음수 불가
  if (!area(f.minAreaSqm) || !area(f.maxAreaSqm) || !money(f.budgetMaxKrw)) return false;
  return !(f.minAreaSqm !== null && f.maxAreaSqm !== null && f.minAreaSqm > f.maxAreaSqm);
}

export function sameFilters(a: Filters, b: Filters): boolean {
  const norm = (f: Filters) => JSON.stringify({ ...f, regionCodes: [...f.regionCodes].sort(), families: [...f.families].sort() });
  return norm(a) === norm(b);
}

export function isDefaultFilters(f: Filters): boolean {
  return sameFilters({ ...f, areaUnit: DEFAULT_FILTERS.areaUnit }, DEFAULT_FILTERS);
}

/** local: 브라우저에 저장된 비회원 필터(없으면 null), server: 계정의 저장 필터(없으면 null). */
export function decideFilterSync(local: Filters | null, server: Filters | null): SyncDecision {
  const hasLocal = local !== null && !isDefaultFilters(local);
  if (server && hasLocal) return sameFilters(local!, server) ? { action: "keep" } : { action: "ask" };
  if (server) return { action: "adopt-server" };
  if (hasLocal) return { action: "push-local" };
  return { action: "keep" };
}
