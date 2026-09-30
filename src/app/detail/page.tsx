"use client";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { BookmarkButton } from "@/components/AccountUI";
import { UnitToggle } from "@/components/FilterPanel";
import { Badge, Notice, Unknown } from "@/components/ui";
import { areaValueText } from "@/lib/chips";
import { formatDateDots, kstToday, receiptPhase } from "@/lib/dates";
import { announcementStatus, eventLabel, FAMILY_LABEL, phaseLabel, receiptEvents, subtypeLabel } from "@/lib/labels";
import { safeOfficialUrl } from "@/lib/links";
import { formatKrw } from "@/lib/money";
import { fetchAnnouncement, type DetailAnnouncement } from "@/lib/queries";
import { kstDateOf, summarizeHousing } from "@/lib/summary";
import { formatSqm, toNumber } from "@/lib/units";
import type { Family } from "@/lib/types";
import { usePrefs } from "@/store/prefs";

const FAMILIES: Family[] = ["apt", "remndr", "urbty_ofctl"];

// APT 주택형에서만 확인된 특별공급 범주(원천 필드 접두어 기준 이름)
const CATEGORY_LABEL: Record<string, string> = {
  mnych: "다자녀가구", nwwds: "신혼부부", lfe_frst: "생애최초", old_parnts_suport: "노부모부양",
  instt_recomend: "기관추천", etc: "기타", transr_instt_enfsn: "이전기관", ygmn: "청년", nwbb: "신생아",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-2 text-sm last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function DetailView() {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const family = params.get("f") as Family | null;
  const hmn = params.get("h");
  const pno = params.get("p");
  const hydrate = usePrefs((s) => s.hydrate);
  const unit = usePrefs((s) => s.filters.areaUnit);
  const [a, setA] = useState<DetailAnnouncement | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
    setToday(kstToday());
  }, [hydrate]);

  useEffect(() => {
    if (!family || !FAMILIES.includes(family) || !hmn || !pno) {
      setA(null);
      return;
    }
    fetchAnnouncement(family, hmn, pno).then(setA).catch((e: unknown) => setError(e instanceof Error ? e.message : "불러오지 못했습니다."));
  }, [family, hmn, pno]);

  const status = useMemo(() => (a && today ? announcementStatus(a, today) : null), [a, today]);
  const events = useMemo(
    () => [...(a?.announcement_events ?? [])].sort((x, y) => (x.starts_on ?? x.ends_on ?? "9999").localeCompare(y.starts_on ?? y.ends_on ?? "9999")),
    [a],
  );

  if (error) return <Notice tone="warn">불러오기 실패: {error}</Notice>;
  if (a === undefined || !today) return <p className="text-sm text-muted">불러오는 중…</p>;
  if (a === null) {
    return (
      <div className="space-y-3">
        <Notice tone="warn">해당 공고를 찾을 수 없습니다. 삭제됐거나 주소가 잘못됐을 수 있습니다.</Notice>
        <Link href="/" className="text-sm font-semibold text-brand underline">공고 목록으로</Link>
      </div>
    );
  }

  const types = a.cheongyak_housing_types;
  const s = summarizeHousing(types);
  const checked = kstDateOf(a.last_seen_at);
  const sub = subtypeLabel(a);
  const officialUrl = safeOfficialUrl(a.pblanc_url);
  const price = s.priceMin !== null && s.priceMax !== null
    ? (s.priceMin === s.priceMax ? formatKrw(s.priceMin) : `${formatKrw(s.priceMin)} ~ ${formatKrw(s.priceMax)}`)
    : null;
  const hasExclusive = s.exclusiveMin !== null;
  const hasSpecialCategories = types.some((t) => t.housing_type_special_supply.length > 0);

  return (
    <article className="space-y-4">
      <Link href="/" className="text-sm text-muted underline">← 공고 목록</Link>

      <header className="rounded-xl bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          {status && <Badge tone={status.phase.kind === "ended" ? "gray" : "brand"}>{phaseLabel(status.phase)}</Badge>}
          <Badge tone="mint">{FAMILY_LABEL[a.source_family]}</Badge>
          {sub && sub !== FAMILY_LABEL[a.source_family] && <Badge tone="gray">{sub}</Badge>}
          <span className="ml-auto"><BookmarkButton announcementId={a.id} name={a.house_nm} /></span>
        </div>
        <h1 className="mt-2 text-2xl font-extrabold">{a.house_nm}</h1>
        <p className="mt-1 text-sm text-muted">{a.source_region_name ? `${a.source_region_name} · ` : ""}{a.hssply_adres ?? "주소 확인 필요"}</p>
        <p className="mt-1 text-xs text-muted">출처: 청약홈 · {checked ? `${formatDateDots(checked)} 확인` : "확인일 미상"}{a.rcrit_pblanc_de ? ` · 모집공고일 ${formatDateDots(a.rcrit_pblanc_de)}` : ""}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          {officialUrl ? (
            <a href={officialUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-navy px-5 py-2.5 text-sm font-bold text-white">공식 공고 확인 →</a>
          ) : (
            <Unknown>공식 공고 링크 확인 필요</Unknown>
          )}
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-base font-bold">주요 정보</h2>
          <dl>
            <Row label="주택형 최고 분양가">{price ?? <Unknown />}</Row>
            <Row label="전용면적">
              {hasExclusive ? `전용 ${s.exclusiveMin === s.exclusiveMax ? areaValueText(s.exclusiveMin!, unit) : `${areaValueText(s.exclusiveMin!, unit)} ~ ${areaValueText(s.exclusiveMax!, unit)}`}` : <Unknown>확인 필요</Unknown>}
            </Row>
            <Row label="공급면적">{s.supplyMin !== null ? (s.supplyMin === s.supplyMax ? formatSqm(s.supplyMin) : `${formatSqm(s.supplyMin)} ~ ${formatSqm(s.supplyMax!)}`) : <span className="text-muted">제공 정보 없음</span>}</Row>
            <Row label="총 세대수">{a.tot_suply_hshldco !== null ? `${a.tot_suply_hshldco.toLocaleString("ko-KR")}세대` : <Unknown />}</Row>
            <Row label="사업주체">{a.bsns_mby_nm ?? <Unknown />}</Row>
            <Row label="문의">{a.mdhs_telno ?? <Unknown />}</Row>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            분양가는 주택형별 <strong>최고</strong> 분양가이며 세대별 확정 가격이 아닙니다. 혜택·최초/현재 공급가격·잔여 수량은 이 공고 데이터에 없어 표시하지 않습니다.
          </p>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-base font-bold">출처와 확인 상태</h2>
          <dl>
            <Row label="공식 공고">{officialUrl ? <span className="text-brand">확인 가능 (청약홈)</span> : <Unknown />}</Row>
            <Row label="주택형 최고 분양가">{s.count > 0 && s.priceUnknown === 0 ? <span className="text-brand">확인</span> : s.count > 0 ? <Unknown>일부 미확인 ({s.priceUnknown}/{s.count})</Unknown> : <Unknown />}</Row>
            <Row label="전용면적">{hasExclusive ? <span className="text-brand">확인</span> : <Unknown>미확인 (원천이 공급면적만 제공)</Unknown>}</Row>
            <Row label="특별공급 범주별 수">{hasSpecialCategories ? <span className="text-brand">확인 (APT)</span> : <span className="text-muted">제공 정보 없음</span>}</Row>
            <Row label="표준 지역 코드">
              <Unknown>미확인</Unknown>
            </Row>
            <Row label="역 도보 시간"><span className="text-muted">미제공</span></Row>
          </dl>
        </div>
      </section>

      <section className="rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-bold">주택형별 정보 ({types.length})</h2>
          <span className="flex items-center gap-2 text-xs text-muted">전용면적 표시 <UnitToggle /></span>
        </div>
        {types.length === 0 ? (
          <p className="text-sm"><Unknown>주택형 정보 없음</Unknown></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2 pr-3">주택형</th><th className="pr-3">전용면적</th><th className="pr-3">공급면적</th>
                  <th className="pr-3">일반/특별 공급</th><th>최고 분양가</th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => {
                  const ex = toNumber(t.exclusive_area_sqm), su = toNumber(t.supply_area_sqm), pr = toNumber(t.price_max_krw);
                  return (
                    <tr key={t.id} className="border-b border-line align-top last:border-b-0">
                      <td className="py-2 pr-3 font-medium">{t.house_ty}</td>
                      <td className="pr-3">{ex !== null ? `전용 ${areaValueText(ex, unit)}` : <Unknown>확인 필요</Unknown>}</td>
                      <td className="pr-3">{su !== null ? formatSqm(su) : <span className="text-muted">—</span>}</td>
                      <td className="pr-3">
                        {t.general_supply_count ?? "—"} / {t.special_supply_count ?? "—"}
                        {t.housing_type_special_supply.length > 0 && (
                          <div className="mt-1 text-xs text-muted">
                            {t.housing_type_special_supply.filter((c) => c.supply_count > 0).map((c) => `${CATEGORY_LABEL[c.category_code] ?? c.category_code} ${c.supply_count}`).join(" · ") || "범주별 0"}
                          </div>
                        )}
                      </td>
                      <td>{pr !== null ? formatKrw(pr) : <Unknown>확인 필요</Unknown>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-base font-bold">일정</h2>
        <p className="mb-3 text-xs text-muted">원천 필드 기준으로 표시한 날짜입니다. 일정은 변동될 수 있으니 반드시 공식 공고를 확인하세요.</p>
        {events.length === 0 ? (
          <p className="text-sm"><Unknown>일정 정보 없음</Unknown></p>
        ) : (
          <ol className="space-y-2">
            {events.map((e) => {
              const isReceipt = receiptEvents(a).includes(e);
              const p = isReceipt ? receiptPhase(today, e.starts_on, e.ends_on) : null;
              return (
                <li key={`${e.source_event_code}-${e.scope_code}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 text-sm last:border-b-0">
                  <span className="font-medium">{eventLabel(e)}</span>
                  <span className="flex items-center gap-2 text-muted">
                    {e.starts_on ? formatDateDots(e.starts_on) : "?"}{e.ends_on && e.ends_on !== e.starts_on ? ` ~ ${formatDateDots(e.ends_on)}` : ""}
                    {p && <Badge tone={p.kind === "ended" ? "gray" : "mint"}>{phaseLabel(p)}</Badge>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </article>
  );
}

export default function DetailPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">불러오는 중…</p>}>
      <DetailView />
    </Suspense>
  );
}
