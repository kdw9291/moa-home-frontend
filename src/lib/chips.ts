import { formatKrw } from "./money";
import { activePreset, AREA_PRESETS } from "./presets";
import type { Filters } from "./types";
import { formatPyeong, formatSqm } from "./units";

/** 면적 값을 선택된 표시 단위로 문구화한다(표시용, 저장·비교값은 ㎡ 그대로). */
export function areaValueText(sqm: number, unit: Filters["areaUnit"]): string {
  return unit === "pyeong" ? formatPyeong(sqm) : formatSqm(sqm);
}

export function areaChipLabel(f: Filters): string | null {
  if (f.minAreaSqm === null && f.maxAreaSqm === null) return null;
  const p = activePreset(f);
  const u = f.areaUnit;
  if (p === "small") return `전용 ${areaValueText(59, u)} 미만`;
  if (p === "large") return `전용 ${areaValueText(84, u)} 초과`;
  const lo = f.minAreaSqm !== null ? areaValueText(f.minAreaSqm, u) : null;
  const hi = f.maxAreaSqm !== null ? areaValueText(f.maxAreaSqm, u) : null;
  if (lo && hi) return `전용 ${lo} ~ ${hi}`;
  if (lo) return `전용 ${lo} ${f.minAreaInclusive ? "이상" : "초과"}`;
  return `전용 ${hi} ${f.maxAreaInclusive ? "이하" : "미만"}`;
}

export function budgetChipLabel(f: Filters): string | null {
  const b = formatKrw(f.budgetMaxKrw);
  return b ? `최고 분양가 ${b} 이하` : null;
}

export function presetLabel(k: keyof typeof AREA_PRESETS): string {
  return AREA_PRESETS[k].label;
}
