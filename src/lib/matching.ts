// 동일 주택형 행 매칭. 백엔드 moahome/contract.py와 같은 의미를 따른다.
//  - 가격은 주택형 '최고 분양가': 최고가 ≤ 예산이면 충족, 초과면 확정 불일치가 아니라 미확인(일부 세대 초과 가능).
//  - 면적은 확인된 전용면적만 비교한다. 공급면적·주택형 문자열로 대체하지 않는다. 없으면 미확인.
//  - 한 행의 모든 지정 조건이 충족될 때만 match. 확정 불일치가 하나라도 있으면 no, 아니면 미확인이 있으면 unknown.
import type { Announcement, Filters, HousingType, Verdict } from "./types";
import { toNumber } from "./units";

export interface HousingVerdict {
  verdict: Verdict;
  budget: Verdict | "n/a";
  area: Verdict | "n/a";
}

export function housingTypeVerdict(row: HousingType, f: Filters): HousingVerdict {
  let budget: HousingVerdict["budget"] = "n/a";
  let area: HousingVerdict["area"] = "n/a";

  if (f.budgetMaxKrw !== null) {
    const price = toNumber(row.price_max_krw);
    budget = price === null ? "unknown" : price <= f.budgetMaxKrw ? "match" : "unknown";
  }

  if (f.minAreaSqm !== null || f.maxAreaSqm !== null) {
    const a = toNumber(row.exclusive_area_sqm);
    if (a === null) {
      area = "unknown";
    } else {
      const okMin = f.minAreaSqm === null || (f.minAreaInclusive ? a >= f.minAreaSqm : a > f.minAreaSqm);
      const okMax = f.maxAreaSqm === null || (f.maxAreaInclusive ? a <= f.maxAreaSqm : a < f.maxAreaSqm);
      area = okMin && okMax ? "match" : "no";
    }
  }

  const parts = [budget, area].filter((x): x is Verdict => x !== "n/a");
  const verdict: Verdict = parts.includes("no") ? "no" : parts.includes("unknown") ? "unknown" : "match";
  return { verdict, budget, area };
}

export interface AnnouncementMatch {
  verdict: Verdict;
  matched: HousingType[]; // 모든 조건이 확인·충족된 주택형
  unknown: HousingType[]; // 미확인이 남은 주택형
}

/** 공고 단위 판정: 확정 일치 행이 있으면 match, 없고 미확인 행이 있으면 unknown, 그 외 no. */
export function announcementMatch(a: Announcement, f: Filters): AnnouncementMatch {
  const active = f.budgetMaxKrw !== null || f.minAreaSqm !== null || f.maxAreaSqm !== null;
  const rows = a.cheongyak_housing_types;
  if (!active) return { verdict: "match", matched: rows, unknown: [] };
  if (rows.length === 0) return { verdict: "unknown", matched: [], unknown: [] }; // 주택형 정보 없음: 판정 불가
  const matched: HousingType[] = [];
  const unknown: HousingType[] = [];
  for (const r of rows) {
    const v = housingTypeVerdict(r, f).verdict;
    if (v === "match") matched.push(r);
    else if (v === "unknown") unknown.push(r);
  }
  return { verdict: matched.length ? "match" : unknown.length ? "unknown" : "no", matched, unknown };
}
