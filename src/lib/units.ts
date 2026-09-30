// 전용면적 ㎡ / 평 변환. 정규값은 항상 ㎡이며 평은 표시와 입력 변환에만 쓴다.
export const SQM_PER_PYEONG = 3.305785;

export function sqmToPyeong(sqm: number): number {
  return sqm / SQM_PER_PYEONG;
}

/** 표시용: 소수 첫째 자리와 '약'. 이 값을 다시 저장하거나 비교에 쓰지 않는다. */
export function formatPyeong(sqm: number): string {
  return `약 ${sqmToPyeong(sqm).toFixed(1)}평`;
}

export function formatSqm(sqm: number): string {
  const s = Number.isInteger(sqm) ? String(sqm) : sqm.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${s}㎡`;
}

/** 전용면적 표시 문자열. 선택 단위에 따라 바뀌며 검색 결과와 무관하다. */
export function formatExclusiveArea(sqm: number, unit: "sqm" | "pyeong"): string {
  return unit === "pyeong" ? `전용 ${formatPyeong(sqm)}` : `전용 ${formatSqm(sqm)}`;
}

/** 사용자가 평으로 직접 입력한 값을 ㎡ 정규값으로 한 번만 환산한다(소수 둘째 자리, DB numeric(10,2)와 동일). */
export function pyeongInputToSqm(pyeong: number): number {
  return Math.round(pyeong * SQM_PER_PYEONG * 100) / 100;
}

export type AreaInputResult = { kind: "unchanged" } | { kind: "invalid" } | { kind: "commit"; sqm: number | null };

/** 입력칸 확정 결정. 표시값(반올림)과 같으면 아무것도 저장하지 않아 ㎡ 정규값이 표시 단위에 따라 변하지 않는다. */
const AREA_INPUT = /^\d{1,5}([.,]\d{1,4})?$/; // 지수·16진수·부호·과대값을 받지 않는다
const MAX_AREA_INPUT = 100_000;

export function parseAreaInput(text: string, shown: string, unit: "sqm" | "pyeong"): AreaInputResult {
  const t = text.trim();
  if (t === "") return shown.trim() === "" ? { kind: "unchanged" } : { kind: "commit", sqm: null };
  if (!AREA_INPUT.test(t)) return { kind: "invalid" };
  const v = Number(t.replace(",", "."));
  if (!Number.isFinite(v) || v > MAX_AREA_INPUT) return { kind: "invalid" };
  // 표시값과 수치가 같으면(예: 17.8 vs 17.80) 서식만 바뀐 것이므로 저장값을 건드리지 않는다
  const s = shown.trim();
  if (s !== "" && Number(s) === v) return { kind: "unchanged" };
  const sqm = unit === "pyeong" ? pyeongInputToSqm(v) : Math.round(v * 100) / 100;
  return Number.isFinite(sqm) ? { kind: "commit", sqm } : { kind: "invalid" };
}

export function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
