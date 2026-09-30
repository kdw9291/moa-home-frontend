import { cursorOrFilter, type Cursor } from "./cursor";
import { supabase } from "./supabase";
import type { Announcement, Family } from "./types";

export const PAGE_SIZE = 200;

const HOUSING = "id, source_model_key, house_ty, exclusive_area_sqm, supply_area_sqm, general_supply_count, special_supply_count, price_max_krw, price_raw, price_source_unit";
const EVENTS = "source_event_code, scope_code, starts_on, ends_on";
const BASE = "id, source_family, source_subtype, house_manage_no, pblanc_no, house_nm, house_secd, house_dtl_secd, rcrit_pblanc_de, hssply_adres, source_region_code, source_region_name, tot_suply_hshldco, bsns_mby_nm, mdhs_telno, pblanc_url, min_price_krw, max_price_krw, last_seen_at";

function client() {
  if (!supabase) throw new Error("Supabase 공개 설정이 없습니다(.env.local의 NEXT_PUBLIC_SUPABASE_URL / PUBLISHABLE_KEY).");
  return supabase;
}

/** 모집공고일 최신순·id 오름차순의 키셋 페이지. cursor가 없으면 첫 페이지, 있으면 그 다음부터. */
export async function fetchAnnouncementsPage(cursor: Cursor | null, limit = PAGE_SIZE): Promise<Announcement[]> {
  let q = client()
    .from("cheongyak_announcements")
    .select(`${BASE}, cheongyak_housing_types(${HOUSING}), announcement_events(${EVENTS})`);
  if (cursor) q = q.or(cursorOrFilter(cursor));
  const { data, error } = await q
    .order("rcrit_pblanc_de", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Announcement[];
}

/** 전량 로딩 상한: 이 개수를 넘으면 잘렸음을 화면에 알린다(전체 백필 약 5,200건 기준 여유). */
export const MAX_LOAD = 8000;

export interface DetailAnnouncement extends Announcement {
  cheongyak_housing_types: (Announcement["cheongyak_housing_types"][number] & {
    housing_type_special_supply: { category_code: string; supply_count: number }[];
  })[];
}

export async function fetchAnnouncement(family: Family, houseManageNo: string, pblancNo: string): Promise<DetailAnnouncement | null> {
  const { data, error } = await client()
    .from("cheongyak_announcements")
    .select(`${BASE}, cheongyak_housing_types(${HOUSING}, housing_type_special_supply(category_code, supply_count)), announcement_events(${EVENTS})`)
    .eq("source_family", family)
    .eq("house_manage_no", houseManageNo)
    .eq("pblanc_no", pblancNo)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as DetailAnnouncement | null) ?? null;
}

export async function fetchBookmarkedAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await client()
    .from("user_bookmarks")
    .select(`created_at, cheongyak_announcements(${BASE}, cheongyak_housing_types(${HOUSING}), announcement_events(${EVENTS}))`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as { cheongyak_announcements: Announcement | null }[])
    .map((r) => r.cheongyak_announcements)
    .filter((a): a is Announcement => a !== null);
}

export async function fetchLastSuccessfulSync(): Promise<string | null> {
  const { data, error } = await client().from("data_status").select("last_successful_sync_at").eq("singleton_id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { last_successful_sync_at: string | null } | null)?.last_successful_sync_at ?? null;
}
