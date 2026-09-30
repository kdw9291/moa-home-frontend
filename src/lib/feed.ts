// 피드 구성: 탭 분류, 조건 필터, 정렬. 화면과 분리한 순수 함수라 단위 테스트로 고정한다.
import { announcementMatch, type AnnouncementMatch } from "./matching";
import { announcementStatus, type AnnouncementStatus } from "./labels";
import type { Announcement, Filters } from "./types";
import { toNumber } from "./units";

export type Tab = "open" | "remndr" | "closed";
export type Sort = "latest" | "deadline" | "price" | "supply";

export const DEFAULT_FILTERS: Filters = {
  regionCodes: [],
  families: [],
  budgetMaxKrw: null,
  minAreaSqm: null,
  minAreaInclusive: true,
  maxAreaSqm: null,
  maxAreaInclusive: true,
  areaUnit: "sqm",
  keyword: "",
};

export interface FeedRow {
  a: Announcement;
  status: AnnouncementStatus;
  match: AnnouncementMatch;
}

export function tabOf(a: Announcement, status: AnnouncementStatus): Tab {
  if (!status.active) return "closed";
  return a.source_family === "remndr" ? "remndr" : "open";
}

function passesBasic(a: Announcement, f: Filters): boolean {
  if (f.families.length && !f.families.includes(a.source_family)) return false;
  if (f.regionCodes.length && !(a.source_region_code && f.regionCodes.includes(a.source_region_code))) return false;
  const kw = f.keyword.trim().toLowerCase();
  if (kw && !`${a.house_nm} ${a.hssply_adres ?? ""} ${a.source_region_name ?? ""}`.toLowerCase().includes(kw)) return false;
  return true;
}

function minPrice(row: FeedRow): number | null {
  const pool = row.match.matched.length ? row.match.matched : row.a.cheongyak_housing_types;
  const prices = pool.map((h) => toNumber(h.price_max_krw)).filter((n): n is number => n !== null);
  return prices.length ? Math.min(...prices) : null;
}

const nullsLast = (x: number | string | null, y: number | string | null, asc = true) => {
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
};

function compare(sort: Sort) {
  return (x: FeedRow, y: FeedRow): number => {
    let c = 0;
    if (sort === "latest") c = nullsLast(x.a.rcrit_pblanc_de, y.a.rcrit_pblanc_de, false);
    else if (sort === "deadline") c = nullsLast(x.status.nextEndsOn, y.status.nextEndsOn);
    else if (sort === "price") c = nullsLast(minPrice(x), minPrice(y));
    else c = nullsLast(x.a.tot_suply_hshldco, y.a.tot_suply_hshldco, false);
    return c !== 0 ? c : x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0; // 안정적인 보조 정렬키
  };
}

export interface Feed {
  matches: FeedRow[]; // 지정 조건이 확인·충족된 공고(조건 없으면 전체)
  unknown: FeedRow[]; // 판정 미확인 공고: 기본 일치 결과와 분리
  tabCounts: Record<Tab, number>;
}

export function buildFeed(items: Announcement[], f: Filters, tab: Tab, sort: Sort, today: string): Feed {
  const tabCounts: Record<Tab, number> = { open: 0, remndr: 0, closed: 0 };
  const matches: FeedRow[] = [];
  const unknown: FeedRow[] = [];
  for (const a of items) {
    if (!passesBasic(a, f)) continue;
    const status = announcementStatus(a, today);
    const t = tabOf(a, status);
    const match = announcementMatch(a, f);
    if (match.verdict !== "no") tabCounts[t] += 1;
    if (t !== tab) continue;
    const row = { a, status, match };
    if (match.verdict === "match") matches.push(row);
    else if (match.verdict === "unknown") unknown.push(row);
  }
  const cmp = compare(sort);
  return { matches: matches.sort(cmp), unknown: unknown.sort(cmp), tabCounts };
}

/** 화면에 나올 수 있는 지역 선택지: 실제 수집된 원천 공급지역코드/명 쌍(표준 코드 매핑은 미확인이라 원천 값 그대로). */
export function regionOptions(items: Announcement[]): { code: string; name: string }[] {
  const m = new Map<string, string>();
  for (const a of items) if (a.source_region_code) m.set(a.source_region_code, a.source_region_name ?? a.source_region_code);
  return [...m].map(([code, name]) => ({ code, name })).sort((x, y) => x.name.localeCompare(y.name, "ko"));
}
