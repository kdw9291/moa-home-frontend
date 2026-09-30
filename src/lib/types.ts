// DB(DATABASE_SCHEMA.sql) 행 형태. numeric/bigint는 PostgREST가 숫자 또는 문자열로 줄 수 있어 Number로 정규화해 쓴다.
export type Family = "apt" | "remndr" | "urbty_ofctl";

export interface HousingType {
  id: string;
  source_model_key: string;
  house_ty: string;
  exclusive_area_sqm: number | string | null;
  supply_area_sqm: number | string | null;
  general_supply_count: number | null;
  special_supply_count: number | null;
  price_max_krw: number | string | null;
  price_raw: string | null;
  price_source_unit: "KRW" | "MANWON" | "UNKNOWN";
}

export interface AnnouncementEvent {
  source_event_code: string;
  scope_code: string;
  starts_on: string | null; // YYYY-MM-DD (KST 달력 날짜)
  ends_on: string | null;
}

export interface Announcement {
  id: string;
  source_family: Family;
  source_subtype: string | null;
  house_manage_no: string;
  pblanc_no: string;
  house_nm: string;
  house_secd: string | null;
  house_dtl_secd: string | null;
  rcrit_pblanc_de: string | null;
  hssply_adres: string | null;
  source_region_code: string | null;
  source_region_name: string | null;
  tot_suply_hshldco: number | null;
  bsns_mby_nm: string | null;
  mdhs_telno: string | null;
  pblanc_url: string | null;
  min_price_krw: number | string | null;
  max_price_krw: number | string | null;
  last_seen_at: string | null;
  cheongyak_housing_types: HousingType[];
  announcement_events: AnnouncementEvent[];
}

export type Verdict = "match" | "no" | "unknown";
export type AreaUnit = "sqm" | "pyeong";

export interface Filters {
  regionCodes: string[]; // 원천 공급지역코드(청약홈 자체 코드). 표준 시도/시군구 코드 매핑은 미확인
  families: Family[]; // 빈 배열 = 전체
  budgetMaxKrw: number | null; // 원, null = 무제한
  minAreaSqm: number | null; // 전용면적 ㎡ 정규값
  minAreaInclusive: boolean;
  maxAreaSqm: number | null;
  maxAreaInclusive: boolean;
  areaUnit: AreaUnit; // 표시 선호일 뿐 검색에는 영향이 없다
  keyword: string;
}
