import type { Filters } from "./types";

export type AreaPresetKey = "small" | "mid" | "large";

// PRD 초기 프리셋: 소형 <59, 중형 59~84(84 포함), 대형 >84 (전용면적 ㎡ 정규값)
export const AREA_PRESETS: Record<AreaPresetKey, { label: string; range: Pick<Filters, "minAreaSqm" | "minAreaInclusive" | "maxAreaSqm" | "maxAreaInclusive"> }> = {
  small: { label: "소형 (59㎡ 미만)", range: { minAreaSqm: null, minAreaInclusive: true, maxAreaSqm: 59, maxAreaInclusive: false } },
  mid: { label: "중형 (59~84㎡)", range: { minAreaSqm: 59, minAreaInclusive: true, maxAreaSqm: 84, maxAreaInclusive: true } },
  large: { label: "대형 (84㎡ 초과)", range: { minAreaSqm: 84, minAreaInclusive: false, maxAreaSqm: null, maxAreaInclusive: true } },
};

export function activePreset(f: Filters): AreaPresetKey | null {
  for (const [k, p] of Object.entries(AREA_PRESETS) as [AreaPresetKey, (typeof AREA_PRESETS)[AreaPresetKey]][]) {
    const r = p.range;
    if (f.minAreaSqm === r.minAreaSqm && f.maxAreaSqm === r.maxAreaSqm &&
        (r.minAreaSqm === null || f.minAreaInclusive === r.minAreaInclusive) &&
        (r.maxAreaSqm === null || f.maxAreaInclusive === r.maxAreaInclusive)) return k;
  }
  return null;
}
