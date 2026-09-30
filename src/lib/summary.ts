import { housingTypeVerdict } from "./matching";
import type { Filters, HousingType } from "./types";
import { toNumber } from "./units";

export interface HousingSummary {
  count: number;
  exclusiveMin: number | null;
  exclusiveMax: number | null;
  supplyMin: number | null;
  supplyMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  priceUnknown: number;
}

const bounds = (xs: (number | null)[]): [number | null, number | null] => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? [Math.min(...v), Math.max(...v)] : [null, null];
};

/** 주택형 목록의 참고 요약. 최고 분양가 범위는 확정 단일 가격이 아니다. */
export function summarizeHousing(rows: HousingType[]): HousingSummary {
  const [exclusiveMin, exclusiveMax] = bounds(rows.map((r) => toNumber(r.exclusive_area_sqm)));
  const [supplyMin, supplyMax] = bounds(rows.map((r) => toNumber(r.supply_area_sqm)));
  const prices = rows.map((r) => toNumber(r.price_max_krw));
  const [priceMin, priceMax] = bounds(prices);
  return { count: rows.length, exclusiveMin, exclusiveMax, supplyMin, supplyMax, priceMin, priceMax, priceUnknown: prices.filter((p) => p === null).length };
}

/** 판정 미확인 공고가 왜 미확인인지(사람이 읽는 사유). 원인을 숨기지 않는다. */
export function unknownReasons(rows: HousingType[], f: Filters): string[] {
  if (rows.length === 0) return ["주택형 정보 없음"];
  const reasons = new Set<string>();
  for (const r of rows) {
    const v = housingTypeVerdict(r, f);
    if (v.verdict !== "unknown") continue;
    if (v.budget === "unknown") {
      reasons.add(toNumber(r.price_max_krw) === null ? "가격 미확인" : "최고가가 예산 초과(더 저렴한 세대가 있을 수 있음)");
    }
    if (v.area === "unknown") reasons.add("전용면적 미확인");
  }
  return [...reasons];
}

const kst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
/** 타임스탬프를 KST 달력 날짜(YYYY-MM-DD)로. */
export function kstDateOf(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : kst.format(new Date(t));
}
