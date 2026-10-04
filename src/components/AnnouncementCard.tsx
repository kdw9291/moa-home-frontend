"use client";
import Link from "next/link";
import { areaValueText } from "@/lib/chips";
import { safeOfficialUrl } from "@/lib/links";
import { formatKrw } from "@/lib/money";
import { FAMILY_LABEL, phaseLabel, subtypeLabel } from "@/lib/labels";
import { kstDateOf, summarizeHousing, unknownReasons } from "@/lib/summary";
import type { FeedRow } from "@/lib/feed";
import type { Filters } from "@/lib/types";
import { BookmarkButton } from "./AccountUI";
import { Badge, Unknown } from "./ui";

function range(min: number | null, max: number | null, fmt: (n: number) => string): string | null {
  if (min === null || max === null) return null;
  return min === max ? fmt(min) : `${fmt(min)} ~ ${fmt(max)}`;
}

export function detailHref(a: FeedRow["a"]): string {
  const q = new URLSearchParams({ f: a.source_family, h: a.house_manage_no, p: a.pblanc_no });
  return `/detail/?${q.toString()}`;
}

export function AnnouncementCard({ row, filters }: { row: FeedRow; filters: Filters }) {
  const { a, status, match } = row;
  const pool = match.matched.length ? match.matched : a.cheongyak_housing_types;
  const s = summarizeHousing(pool);
  const reasons = match.verdict === "unknown" ? unknownReasons(a.cheongyak_housing_types, filters) : [];
  const exclusive = range(s.exclusiveMin, s.exclusiveMax, (n) => areaValueText(n, filters.areaUnit));
  const supply = range(s.supplyMin, s.supplyMax, (n) => areaValueText(n, filters.areaUnit)); // 공급면적도 선택한 표시 단위로(라벨은 '공급면적'으로 전용면적과 구분)
  const price = range(s.priceMin, s.priceMax, (n) => formatKrw(n) ?? "");
  const checked = kstDateOf(a.last_seen_at);
  const sub = subtypeLabel(a);
  const officialUrl = safeOfficialUrl(a.pblanc_url);
  const phaseTone = status.phase.kind === "ongoing" || status.phase.kind === "today" ? "brand" : status.phase.kind === "upcoming" ? "mint" : "gray";

  return (
    <article className="rounded-xl border border-line bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={phaseTone}>{phaseLabel(status.phase)}</Badge>
        <Badge tone="mint">{FAMILY_LABEL[a.source_family]}</Badge>
        {sub && sub !== FAMILY_LABEL[a.source_family] && <Badge tone="gray">{sub}</Badge>}
        <span className="ml-auto"><BookmarkButton announcementId={a.id} name={a.house_nm} /></span>
      </div>
      <h3 className="mt-2 text-lg font-bold leading-snug">
        <Link href={detailHref(a)} prefetch={false} className="hover:underline">{a.house_nm}</Link>
      </h3>
      <p className="text-sm text-muted">
        {a.source_region_name ? `${a.source_region_name} · ` : ""}{a.hssply_adres ?? "주소 확인 필요"}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">전용면적</dt>
          <dd className="font-semibold">{exclusive ? `전용 ${exclusive}` : <Unknown>확인 필요</Unknown>}</dd>
          {supply && <dd className="text-xs text-muted">공급면적 {supply}</dd>}
        </div>
        <div>
          <dt className="text-xs text-muted">주택형 최고 분양가</dt>
          <dd className="font-semibold">{price ?? <Unknown>확인 필요</Unknown>}</dd>
          {s.priceUnknown > 0 && s.count > 0 && <dd className="text-xs text-warn">가격 미확인 {s.priceUnknown}개 주택형</dd>}
        </div>
        <div>
          <dt className="text-xs text-muted">총 세대수</dt>
          <dd className="font-semibold">{a.tot_suply_hshldco !== null ? `${a.tot_suply_hshldco.toLocaleString("ko-KR")}세대` : <Unknown>확인 필요</Unknown>}</dd>
        </div>
      </dl>

      {match.verdict === "match" && (filters.budgetMaxKrw !== null || filters.minAreaSqm !== null || filters.maxAreaSqm !== null) && (
        <p className="mt-3 rounded-md bg-mint px-3 py-2 text-xs text-brand-dark">
          설정한 검색 조건에 맞는 주택형 {match.matched.length}개 있음 (자격·당첨 가능성과는 다릅니다)
        </p>
      )}
      {reasons.length > 0 && (
        <p className="mt-3 rounded-md bg-warn-bg px-3 py-2 text-xs text-warn">판정 미확인: {reasons.join(" · ")}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
        <span>출처: 청약홈 · {checked ? `${checked.replaceAll("-", ".")} 확인` : "확인일 미상"}</span>
        <span className="flex gap-3">
          <Link href={detailHref(a)} prefetch={false} className="font-semibold text-brand underline">상세 보기</Link>
          {officialUrl ? (
            <a href={officialUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand underline">공식 공고</a>
          ) : (
            <Unknown>공식 링크 확인 필요</Unknown>
          )}
        </span>
      </div>
    </article>
  );
}
