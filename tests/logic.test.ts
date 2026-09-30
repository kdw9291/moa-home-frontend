import { describe, expect, it } from "vitest";
import { dDay, isStale, kstToday, receiptPhase } from "@/lib/dates";
import { buildFeed, DEFAULT_FILTERS, regionOptions } from "@/lib/feed";
import { announcementStatus, phaseLabel, subtypeLabel } from "@/lib/labels";
import { announcementMatch, housingTypeVerdict } from "@/lib/matching";
import { eokToKrw, formatKrw } from "@/lib/money";
import { AREA_PRESETS, activePreset } from "@/lib/presets";
import type { Announcement, Filters, HousingType } from "@/lib/types";
import { formatExclusiveArea, formatPyeong, pyeongInputToSqm, toNumber } from "@/lib/units";

const f = (over: Partial<Filters> = {}): Filters => ({ ...DEFAULT_FILTERS, ...over });

let n = 0;
const ht = (over: Partial<HousingType> = {}): HousingType => ({
  id: `h${++n}`, source_model_key: String(n), house_ty: "X", exclusive_area_sqm: null, supply_area_sqm: null,
  general_supply_count: null, special_supply_count: null, price_max_krw: null, price_raw: null,
  price_source_unit: "UNKNOWN", ...over,
});
const ann = (over: Partial<Announcement> = {}): Announcement => ({
  id: `a${++n}`, source_family: "apt", source_subtype: null, house_manage_no: "1", pblanc_no: "1", house_nm: "단지",
  house_secd: "01", house_dtl_secd: null, rcrit_pblanc_de: "2026-09-01", hssply_adres: "주소", source_region_code: "100",
  source_region_name: "서울", tot_suply_hshldco: 100, bsns_mby_nm: null, mdhs_telno: null, pblanc_url: "https://x",
  min_price_krw: null, max_price_krw: null, last_seen_at: null, cheongyak_housing_types: [], announcement_events: [], ...over,
});

describe("㎡ / 평 단위", () => {
  it("59㎡는 전용 약 17.8평, 84㎡는 약 25.4평", () => {
    expect(formatPyeong(59)).toBe("약 17.8평");
    expect(formatPyeong(84)).toBe("약 25.4평");
    expect(formatExclusiveArea(59, "pyeong")).toBe("전용 약 17.8평");
    expect(formatExclusiveArea(59, "sqm")).toBe("전용 59㎡");
  });
  it("평 직접 입력은 ㎡로 한 번만 환산한다", () => {
    expect(pyeongInputToSqm(17.8)).toBe(58.84);
    expect(pyeongInputToSqm(25)).toBe(82.64);
  });
  it("표시 단위를 바꿔도 검색 결과가 같다(임계값은 ㎡ 정규값)", () => {
    const rows = [ht({ exclusive_area_sqm: "59.0000", price_max_krw: 500_000_000 }), ht({ exclusive_area_sqm: "58.9" })];
    const a = ann({ cheongyak_housing_types: rows });
    const sqm = announcementMatch(a, f({ minAreaSqm: 59, areaUnit: "sqm" }));
    const pyeong = announcementMatch(a, f({ minAreaSqm: 59, areaUnit: "pyeong" }));
    expect(pyeong.matched.map((h) => h.id)).toEqual(sqm.matched.map((h) => h.id));
    expect(sqm.matched).toHaveLength(1);
  });
  it("toNumber는 문자열 numeric을 처리하고 빈 값은 null", () => {
    expect(toNumber("84.9760")).toBe(84.976);
    expect(toNumber("")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber("abc")).toBeNull();
  });
});

describe("금액 표시", () => {
  it("원 단위를 억/만원으로", () => {
    expect(formatKrw(580_000_000)).toBe("5억 8,000만원");
    expect(formatKrw(600_000_000)).toBe("6억원");
    expect(formatKrw(30_760_0000)).toBe("3억 760만원");
    expect(formatKrw(99_995_000)).toBe("1억원"); // 반올림 올림 자리
    expect(formatKrw(null)).toBeNull();
    expect(eokToKrw(6)).toBe(600_000_000);
  });
});

describe("KST 날짜", () => {
  it("한국 자정 경계에서 오늘이 바뀐다", () => {
    expect(kstToday(new Date("2026-09-29T14:59:59Z"))).toBe("2026-09-29");
    expect(kstToday(new Date("2026-09-29T15:00:00Z"))).toBe("2026-09-30");
  });
  it("D-Day와 접수 상태", () => {
    expect(dDay("2026-09-29", "2026-10-02")).toBe(3);
    expect(dDay("2026-09-29", "2026-09-28")).toBe(-1);
    expect(receiptPhase("2026-09-29", "2026-10-02", "2026-10-03")).toEqual({ kind: "upcoming", days: 3 });
    expect(receiptPhase("2026-10-02", "2026-10-02", "2026-10-03")).toEqual({ kind: "today" });
    expect(receiptPhase("2026-10-03", "2026-10-02", "2026-10-03")).toEqual({ kind: "ongoing", endsInDays: 0 });
    expect(receiptPhase("2026-10-04", "2026-10-02", "2026-10-03")).toEqual({ kind: "ended" });
    expect(receiptPhase("2026-10-04", null, null)).toEqual({ kind: "unknown" });
    expect(phaseLabel({ kind: "upcoming", days: 3 })).toBe("접수 예정 D-3");
  });
  it("갱신 지연은 26시간 초과 또는 기록 없음", () => {
    const now = new Date("2026-09-30T00:00:00Z");
    expect(isStale("2026-09-29T00:00:01Z", now)).toBe(false);
    expect(isStale("2026-09-28T21:59:59Z", now)).toBe(true);
    expect(isStale(null, now)).toBe(true);
  });
});

describe("동일 주택형 매칭", () => {
  it("59/84㎡ 경계: 중형은 59 이상 84 이하, 대형은 84 초과, 소형은 59 미만", () => {
    const mid = AREA_PRESETS.mid.range, large = AREA_PRESETS.large.range, small = AREA_PRESETS.small.range;
    const v = (area: number, r: typeof mid) => housingTypeVerdict(ht({ exclusive_area_sqm: area }), f(r)).verdict;
    expect([v(58.99, mid), v(59, mid), v(84, mid), v(84.0001, mid)]).toEqual(["no", "match", "match", "no"]);
    expect([v(84, large), v(84.01, large)]).toEqual(["no", "match"]);
    expect([v(58.99, small), v(59, small)]).toEqual(["match", "no"]);
    expect(activePreset(f(mid))).toBe("mid");
    expect(activePreset(f({ minAreaSqm: 60 }))).toBeNull();
  });
  it("최고가가 예산 이하면 충족, 초과면 미확인(불일치 아님), 가격 없으면 미확인", () => {
    const v = (price: number | null) => housingTypeVerdict(ht({ price_max_krw: price }), f({ budgetMaxKrw: 600_000_000 }));
    expect(v(600_000_000).verdict).toBe("match");
    expect(v(600_000_001).verdict).toBe("unknown");
    expect(v(null).verdict).toBe("unknown");
  });
  it("전용면적이 없으면(apt/잔여세대) 공급면적이 있어도 미확인", () => {
    const row = ht({ exclusive_area_sqm: null, supply_area_sqm: 84.1, price_max_krw: 100 });
    expect(housingTypeVerdict(row, f({ minAreaSqm: 59, maxAreaSqm: 85 })).verdict).toBe("unknown");
  });
  it("한 행의 조건이 다른 행 값으로 채워지지 않는다", () => {
    const a = ann({ cheongyak_housing_types: [
      ht({ exclusive_area_sqm: 59, price_max_krw: 700_000_000 }), // 면적 충족, 최고가 예산 초과 -> 미확인
      ht({ exclusive_area_sqm: 40, price_max_krw: 400_000_000 }), // 예산 충족, 면적 미달 -> 불일치
    ] });
    const m = announcementMatch(a, f({ budgetMaxKrw: 600_000_000, minAreaSqm: 59 }));
    expect(m.verdict).toBe("unknown");
    expect(m.matched).toHaveLength(0);
  });
  it("확정 불일치는 미확인보다 우선, 주택형이 없으면 미확인", () => {
    expect(housingTypeVerdict(ht({ exclusive_area_sqm: 40 }), f({ budgetMaxKrw: 1, minAreaSqm: 59 })).verdict).toBe("no");
    expect(announcementMatch(ann(), f({ budgetMaxKrw: 1 })).verdict).toBe("unknown");
    expect(announcementMatch(ann(), f()).verdict).toBe("match");
  });
});

const ev = (code: string, s: string | null, e: string | null, scope = "all") =>
  ({ source_event_code: code, scope_code: scope, starts_on: s, ends_on: e });

describe("탭과 피드", () => {
  const today = "2026-09-29";
  const open = ann({ id: "o", announcement_events: [ev("rcept", "2026-10-01", "2026-10-02")], cheongyak_housing_types: [ht({ exclusive_area_sqm: 59, price_max_krw: 500_000_000 })] });
  const rem = ann({ id: "r", source_family: "remndr", source_subtype: "04", announcement_events: [ev("subscrpt_rcept", "2026-09-29", "2026-09-30")] });
  const closed = ann({ id: "c", announcement_events: [ev("rcept", "2026-09-01", "2026-09-02"), ev("przwner_presnatn", "2026-10-05", "2026-10-05")] });
  const items = [open, rem, closed];

  it("당첨자 발표·계약 일정은 접수 상태에 영향을 주지 않는다", () => {
    expect(announcementStatus(closed, today).active).toBe(false);
    expect(announcementStatus(open, today).phase).toEqual({ kind: "upcoming", days: 2 });
  });
  it("탭 분류와 건수", () => {
    const feed = buildFeed(items, f(), "open", "latest", today);
    expect(feed.matches.map((r) => r.a.id)).toEqual(["o"]);
    expect(feed.tabCounts).toEqual({ open: 1, remndr: 1, closed: 1 });
    expect(buildFeed(items, f(), "remndr", "latest", today).matches.map((r) => r.a.id)).toEqual(["r"]);
    expect(buildFeed(items, f(), "closed", "latest", today).matches.map((r) => r.a.id)).toEqual(["c"]);
  });
  it("미확인 공고는 일치 결과와 분리된다", () => {
    const feed = buildFeed(items, f({ budgetMaxKrw: 600_000_000 }), "remndr", "latest", today);
    expect(feed.matches).toHaveLength(0);
    expect(feed.unknown.map((r) => r.a.id)).toEqual(["r"]);
  });
  it("지역·유형·키워드 필터와 정렬", () => {
    const b = ann({ id: "b", source_region_code: "410", source_region_name: "경기", house_nm: "가나다 아파트", rcrit_pblanc_de: "2026-09-10",
      announcement_events: [ev("rcept", "2026-10-01", "2026-10-01")], tot_suply_hshldco: 500 });
    const all = [open, b];
    expect(buildFeed(all, f({ regionCodes: ["410"] }), "open", "latest", today).matches.map((r) => r.a.id)).toEqual(["b"]);
    expect(buildFeed(all, f({ families: ["remndr"] }), "open", "latest", today).matches).toHaveLength(0);
    expect(buildFeed(all, f({ keyword: "가나다" }), "open", "latest", today).matches.map((r) => r.a.id)).toEqual(["b"]);
    expect(buildFeed(all, f(), "open", "latest", today).matches.map((r) => r.a.id)).toEqual(["b", "o"]); // 최신 모집공고일 순
    expect(buildFeed(all, f(), "open", "deadline", today).matches[0]!.a.id).toBe("b"); // 10-01 마감이 더 이르다
    expect(buildFeed(all, f(), "open", "supply", today).matches[0]!.a.id).toBe("b");
    expect(regionOptions(all).map((r) => r.code).sort()).toEqual(["100", "410"]);
  });
  it("가격순은 확인된 최고가가 낮은 순, 가격 없는 공고는 뒤", () => {
    const cheap = ann({ id: "cheap", announcement_events: [ev("rcept", "2026-10-01", "2026-10-02")], cheongyak_housing_types: [ht({ price_max_krw: 300_000_000 })] });
    const none = ann({ id: "none", announcement_events: [ev("rcept", "2026-10-01", "2026-10-02")] });
    const feed = buildFeed([none, open, cheap], f(), "open", "price", today);
    expect(feed.matches.map((r) => r.a.id)).toEqual(["cheap", "o", "none"]);
  });
});

describe("유형 라벨은 원천 코드만 사용", () => {
  it("알려진 코드는 이름, 모르는 코드는 코드 표시, 공고명 추정 없음", () => {
    expect(subtypeLabel(ann({ source_family: "remndr", source_subtype: "06" }))).toBe("불법행위 재공급");
    expect(subtypeLabel(ann({ source_family: "urbty_ofctl", source_subtype: "0202" }))).toBe("오피스텔");
    expect(subtypeLabel(ann({ source_family: "apt", house_secd: "10" }))).toBe("신혼희망타운");
    expect(subtypeLabel(ann({ source_family: "remndr", source_subtype: "99", house_nm: "무순위 재공급" }))).toBe("원천 코드 99");
  });
});

import { areaChipLabel, budgetChipLabel } from "@/lib/chips";

describe("필터 칩 문구", () => {
  it("단위 토글은 칩 문구만 바꾸고 조건값(㎡)은 그대로", () => {
    const base = f({ ...AREA_PRESETS.mid.range });
    expect(areaChipLabel({ ...base, areaUnit: "sqm" })).toBe("전용 59㎡ ~ 84㎡");
    expect(areaChipLabel({ ...base, areaUnit: "pyeong" })).toBe("전용 약 17.8평 ~ 약 25.4평");
    expect(areaChipLabel(f({ minAreaSqm: 59, areaUnit: "pyeong" }))).toBe("전용 약 17.8평 이상");
    expect(areaChipLabel(f({ ...AREA_PRESETS.large.range, areaUnit: "pyeong" }))).toBe("전용 약 25.4평 초과");
    expect(areaChipLabel(f())).toBeNull();
    expect(budgetChipLabel(f({ budgetMaxKrw: 600_000_000 }))).toBe("최고 분양가 6억원 이하");
  });
});

import { kstDateOf, summarizeHousing, unknownReasons } from "@/lib/summary";

describe("요약과 미확인 사유", () => {
  it("요약은 확인된 값만 범위로, 가격 없는 주택형 수를 센다", () => {
    const s = summarizeHousing([
      ht({ exclusive_area_sqm: 59, price_max_krw: 500_000_000 }),
      ht({ exclusive_area_sqm: null, supply_area_sqm: 84.1, price_max_krw: null }),
      ht({ exclusive_area_sqm: "84", price_max_krw: "700000000" }),
    ]);
    expect(s).toMatchObject({ count: 3, exclusiveMin: 59, exclusiveMax: 84, supplyMin: 84.1, priceMin: 500_000_000, priceMax: 700_000_000, priceUnknown: 1 });
  });
  it("미확인 사유를 구분해 보여 준다", () => {
    const rows = [ht({ price_max_krw: null, exclusive_area_sqm: 60 }), ht({ price_max_krw: 900_000_000, exclusive_area_sqm: null })];
    const r = unknownReasons(rows, f({ budgetMaxKrw: 600_000_000, minAreaSqm: 59 }));
    expect(r).toContain("가격 미확인");
    expect(r).toContain("전용면적 미확인");
    expect(r.some((x) => x.includes("최고가가 예산 초과"))).toBe(true);
    expect(unknownReasons([], f({ budgetMaxKrw: 1 }))).toEqual(["주택형 정보 없음"]);
  });
  it("확인 시각은 KST 날짜로", () => {
    expect(kstDateOf("2026-09-29T15:30:00Z")).toBe("2026-09-30");
    expect(kstDateOf(null)).toBeNull();
    expect(kstDateOf("bad")).toBeNull();
  });
});

import { safeOfficialUrl } from "@/lib/links";
import { parseAreaInput } from "@/lib/units";

describe("면적 입력 확정", () => {
  it("평 표시값을 손대지 않고 blur하면 ㎡ 정규값이 바뀌지 않는다", () => {
    const shown = (59 / 3.305785).toFixed(1); // '17.8'
    expect(parseAreaInput(shown, shown, "pyeong")).toEqual({ kind: "unchanged" });
    expect(parseAreaInput("59", "59", "sqm")).toEqual({ kind: "unchanged" });
    expect(parseAreaInput("", "", "sqm")).toEqual({ kind: "unchanged" });
  });
  it("사용자가 실제로 바꾼 값만 ㎡로 한 번 환산해 저장한다", () => {
    expect(parseAreaInput("20", "17.8", "pyeong")).toEqual({ kind: "commit", sqm: 66.12 });
    expect(parseAreaInput("60.5", "59", "sqm")).toEqual({ kind: "commit", sqm: 60.5 });
    expect(parseAreaInput("", "59", "sqm")).toEqual({ kind: "commit", sqm: null });
    expect(parseAreaInput("abc", "59", "sqm")).toEqual({ kind: "invalid" });
    expect(parseAreaInput("-1", "59", "sqm")).toEqual({ kind: "invalid" });
  });
});

describe("한쪽 날짜만 있는 접수 일정", () => {
  const today = "2026-09-29";
  it("시작만 있으면 시작 전/당일만 말하고 이후는 종료로 단정하지 않는다", () => {
    expect(receiptPhase(today, "2026-10-01", null)).toEqual({ kind: "upcoming", days: 2 });
    expect(receiptPhase(today, "2026-09-29", null)).toEqual({ kind: "today" });
    expect(receiptPhase(today, "2026-09-20", null)).toEqual({ kind: "unknown" });
  });
  it("종료만 있으면 지났을 때만 종료, 아니면 알 수 없음", () => {
    expect(receiptPhase(today, null, "2026-09-28")).toEqual({ kind: "ended" });
    expect(receiptPhase(today, null, "2026-09-30")).toEqual({ kind: "unknown" });
  });
  it("종료 여부를 모르는 접수는 마감 탭으로 보내지 않는다", () => {
    const a = ann({ announcement_events: [ev("rcept", "2026-09-20", null)] });
    const st = announcementStatus(a, today);
    expect(st.active).toBe(true);
    expect(st.phase).toEqual({ kind: "unknown" });
    expect(buildFeed([a], f(), "open", "latest", today).matches).toHaveLength(1);
    // 확실히 끝난 접수만 있으면 종료
    const done = ann({ announcement_events: [ev("rcept", "2026-09-01", "2026-09-02")] });
    expect(announcementStatus(done, today).active).toBe(false);
  });
});

describe("공식 링크 검증", () => {
  it("청약홈 https 주소만 공식 링크로 인정한다", () => {
    expect(safeOfficialUrl("https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=1&pblancNo=1")).toContain("applyhome.co.kr");
    expect(safeOfficialUrl("https://applyhome.co.kr/x")).not.toBeNull();
    expect(safeOfficialUrl("http://www.applyhome.co.kr/x")).toBeNull();
    expect(safeOfficialUrl("https://applyhome.co.kr.evil.com/x")).toBeNull();
    expect(safeOfficialUrl("https://evil.com/applyhome.co.kr")).toBeNull();
    expect(safeOfficialUrl("javascript:alert(1)")).toBeNull();
    expect(safeOfficialUrl("https://user:pw@www.applyhome.co.kr/x")).toBeNull();
    expect(safeOfficialUrl(null)).toBeNull();
    expect(safeOfficialUrl("not a url")).toBeNull();
  });
});

describe("면적 입력 서식·경계", () => {
  it("수치가 같은 서식 변경(17.80 vs 17.8, 쉼표 소수점)은 저장값을 바꾸지 않는다", () => {
    expect(parseAreaInput("17.80", "17.8", "pyeong")).toEqual({ kind: "unchanged" });
    expect(parseAreaInput("17,8", "17.8", "pyeong")).toEqual({ kind: "unchanged" });
    expect(parseAreaInput("59.0", "59", "sqm")).toEqual({ kind: "unchanged" });
    expect(parseAreaInput("17.9", "17.8", "pyeong")).toMatchObject({ kind: "commit" });
  });
  it("지수·16진수·부호·과대값·무한대는 거부한다", () => {
    for (const bad of ["1e3", "1e999", "0x10", "-5", "+5", "Infinity", "NaN", "12345678", "1.23456", ".5", "5.", "1 2"]) {
      expect(parseAreaInput(bad, "59", "sqm")).toEqual({ kind: "invalid" });
    }
  });
  it("정상 입력은 ㎡ 정규값으로 한 번 환산", () => {
    expect(parseAreaInput("25", "", "pyeong")).toEqual({ kind: "commit", sqm: 82.64 });
    expect(parseAreaInput("84,5", "59", "sqm")).toEqual({ kind: "commit", sqm: 84.5 });
  });
});

describe("마감 임박 정렬은 실제 종료일만 사용", () => {
  const today = "2026-09-29";
  it("시작일만 있는 접수는 종료일을 시작일로 대신하지 않는다", () => {
    const startOnly = ann({ id: "s", announcement_events: [ev("rcept", "2026-09-20", null)] });
    expect(announcementStatus(startOnly, today).nextEndsOn).toBeNull();
    const known = ann({ id: "k", announcement_events: [ev("rcept", "2026-09-29", "2026-10-05")] });
    expect(announcementStatus(known, today).nextEndsOn).toBe("2026-10-05");
    const sorted = buildFeed([startOnly, known], f(), "open", "deadline", today).matches.map((r) => r.a.id);
    expect(sorted).toEqual(["k", "s"]); // 종료일 모르는 공고는 뒤
  });
});

import { decideFilterSync, isDefaultFilters } from "@/lib/filtersync";
import { isIos, pushAvailability, urlBase64ToBytes, type PushEnv } from "@/lib/push";

const penv = (over: Partial<PushEnv> = {}): PushEnv => ({
  userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120", maxTouchPoints: 0, platform: "Win32", standalone: false,
  hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: "default", hasVapidKey: true, ...over,
});

describe("푸시 사용 가능 상태", () => {
  it("일반 브라우저는 켤 수 있고 거부·미지원·미설정을 구분한다", () => {
    expect(pushAvailability(penv())).toEqual({ state: "ready" });
    expect(pushAvailability(penv({ permission: "denied" }))).toEqual({ state: "denied" });
    expect(pushAvailability(penv({ hasPushManager: false }))).toEqual({ state: "unsupported" });
    expect(pushAvailability(penv({ hasVapidKey: false }))).toEqual({ state: "not-configured" });
  });
  it("iOS/iPadOS는 홈 화면 설치 전에는 설치 안내, 설치 후에는 사용 가능", () => {
    const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", platform: "iPhone" };
    const ipad = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 };
    expect(isIos(penv(iphone))).toBe(true);
    expect(isIos(penv(ipad))).toBe(true);
    expect(isIos(penv({ platform: "MacIntel", maxTouchPoints: 0 }))).toBe(false);
    expect(pushAvailability(penv({ ...iphone, hasPushManager: false }))).toEqual({ state: "ios-install" });
    expect(pushAvailability(penv({ ...iphone, standalone: true }))).toEqual({ state: "ready" });
  });
  it("공개 키 변환", () => {
    expect(Array.from(urlBase64ToBytes("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToBytes("_-8"))).toEqual([255, 239]);
  });
});

describe("로그인 시 필터 동기화 결정", () => {
  const custom = f({ budgetMaxKrw: 600_000_000 });
  const other = f({ budgetMaxKrw: 500_000_000 });
  it("서버와 로컬이 모두 있고 다르면 사용자에게 묻는다", () => {
    expect(decideFilterSync(custom, other)).toEqual({ action: "ask" });
    expect(decideFilterSync(custom, custom)).toEqual({ action: "keep" });
  });
  it("한쪽만 있으면 있는 쪽을 쓴다", () => {
    expect(decideFilterSync(null, custom)).toEqual({ action: "adopt-server" });
    expect(decideFilterSync(f(), custom)).toEqual({ action: "adopt-server" }); // 기본값 로컬은 없는 것과 같다
    expect(decideFilterSync(custom, null)).toEqual({ action: "push-local" });
    expect(decideFilterSync(null, null)).toEqual({ action: "keep" });
  });
  it("표시 단위만 다른 로컬은 기본값으로 본다, 배열 순서는 무시", () => {
    expect(isDefaultFilters(f({ areaUnit: "pyeong" }))).toBe(true);
    expect(decideFilterSync(f({ regionCodes: ["100", "410"], budgetMaxKrw: 1 }), f({ regionCodes: ["410", "100"], budgetMaxKrw: 1 }))).toEqual({ action: "keep" });
  });
});

import { filtersToRow, rowToFilters } from "@/store/account";

describe("계정 필터 저장 형식", () => {
  it("면적 경계 포함 여부와 표시 단위가 서버 왕복 후에도 보존된다", () => {
    const small = f({ ...AREA_PRESETS.small.range, budgetMaxKrw: 600_000_000, areaUnit: "pyeong", regionCodes: ["410"], families: ["apt"] });
    const back = rowToFilters({ ...filtersToRow("u", small, 3), budget_max_krw: "600000000", max_area_sqm: "59.00" });
    expect(back).toMatchObject({ maxAreaSqm: 59, maxAreaInclusive: false, minAreaSqm: null, areaUnit: "pyeong", budgetMaxKrw: 600_000_000, regionCodes: ["410"], families: ["apt"] });
    expect(activePreset(back)).toBe("small");
    const large = rowToFilters(filtersToRow("u", f({ ...AREA_PRESETS.large.range }), 1));
    expect(large).toMatchObject({ minAreaSqm: 84, minAreaInclusive: false });
  });
  it("행에는 사용자 ID와 개정 번호가 들어가고 키워드 같은 기기 UI 값은 저장하지 않는다", () => {
    const row = filtersToRow("user-1", f({ keyword: "비공개 검색어" }), 7);
    expect(row.user_id).toBe("user-1");
    expect(row.revision).toBe(7);
    expect(JSON.stringify(row)).not.toContain("비공개 검색어");
  });
});

import { compareByCursorOrder, cursorOf, cursorOrFilter } from "@/lib/cursor";

describe("키셋 커서", () => {
  const id = "0a1b2c3d-0000-4000-8000-000000000001";
  it("날짜 커서는 더 이른 날짜·같은 날짜의 더 큰 id·날짜 없는 행을 가리킨다", () => {
    expect(cursorOrFilter({ rcrit: "2026-09-18", id })).toBe(
      `rcrit_pblanc_de.lt.2026-09-18,and(rcrit_pblanc_de.eq.2026-09-18,id.gt.${id}),rcrit_pblanc_de.is.null`);
  });
  it("null 커서 뒤에는 날짜 없는 행만 남는다", () => {
    expect(cursorOrFilter({ rcrit: null, id })).toBe(`and(rcrit_pblanc_de.is.null,id.gt.${id})`);
  });
  it("형식이 잘못된 값(필터 구문 주입 시도)은 거부한다", () => {
    for (const bad of [{ rcrit: "2026-09-18),id.gt.0", id }, { rcrit: "2026-9-1", id }, { rcrit: null, id: "x),or(a.eq.1" }, { rcrit: "2026-09-18", id: "" }]) {
      expect(() => cursorOrFilter(bad)).toThrow();
    }
  });
  it("정렬 비교: 최신 날짜 먼저, 같으면 id 오름차순, null은 마지막", () => {
    const rows = [
      { rcrit: null, id: "b" }, { rcrit: "2026-09-10", id: "z" }, { rcrit: "2026-09-18", id: "b" },
      { rcrit: "2026-09-18", id: "a" }, { rcrit: null, id: "a" },
    ];
    expect([...rows].sort(compareByCursorOrder).map((r) => `${r.rcrit ?? "null"}/${r.id}`)).toEqual([
      "2026-09-18/a", "2026-09-18/b", "2026-09-10/z", "null/a", "null/b"]);
    expect(cursorOf({ rcrit_pblanc_de: "2026-09-18", id: "a" })).toEqual({ rcrit: "2026-09-18", id: "a" });
  });
});

import { filtersSavable } from "@/lib/filtersync";

describe("계정 저장 가능 여부(DB 제약과 같은 기준)", () => {
  it("최소 면적이 최대보다 크거나 음수 값이면 저장할 수 없다", () => {
    expect(filtersSavable(f())).toBe(true);
    expect(filtersSavable(f({ minAreaSqm: 59, maxAreaSqm: 84 }))).toBe(true);
    expect(filtersSavable(f({ minAreaSqm: 84, maxAreaSqm: 84 }))).toBe(true);   // 같아도 DB는 허용
    expect(filtersSavable(f({ minAreaSqm: 100, maxAreaSqm: 50 }))).toBe(false);
    expect(filtersSavable(f({ minAreaSqm: 100 }))).toBe(true);                    // 한쪽만 있으면 비교 없음
    expect(filtersSavable(f({ budgetMaxKrw: -1 }))).toBe(false);
    expect(filtersSavable(f({ minAreaSqm: 0 }))).toBe(false);                     // 스키마: 면적 > 0
    expect(filtersSavable(f({ maxAreaSqm: Number.NaN }))).toBe(false);
    expect(filtersSavable(f({ minAreaSqm: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(filtersSavable(f({ minAreaSqm: 1e9 }))).toBe(false);                   // numeric(10,2) 범위 초과
    expect(filtersSavable(f({ minAreaSqm: 99_999_999.99 }))).toBe(true);
    expect(filtersSavable(f({ budgetMaxKrw: 1.5 }))).toBe(false);                 // bigint는 정수
    expect(filtersSavable(f({ budgetMaxKrw: 0 }))).toBe(true);
    expect(filtersSavable(f({ minAreaSqm: 0.001 }))).toBe(false);                  // numeric(10,2) 반올림 뒤 0.00 -> > 0 위반
    expect(filtersSavable(f({ maxAreaSqm: 0.004 }))).toBe(false);
    expect(filtersSavable(f({ minAreaSqm: 0.01 }))).toBe(true);
  });
});
