"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnnouncementCard } from "@/components/AnnouncementCard";
import { FilterPanel, UnitToggle } from "@/components/FilterPanel";
import { Badge, Notice } from "@/components/ui";
import { areaChipLabel, budgetChipLabel } from "@/lib/chips";
import { isStale, kstToday } from "@/lib/dates";
import { buildFeed, regionOptions, type Sort, type Tab } from "@/lib/feed";
import { loadAll, newProgress, type LoadProgress } from "@/lib/loadAll";
import { retryAccountSync, retrySave } from "@/store/account";
import { fetchAnnouncementsPage, fetchLastSuccessfulSync, MAX_LOAD, PAGE_SIZE } from "@/lib/queries";
import { kstDateOf } from "@/lib/summary";
import { supabaseConfigured } from "@/lib/supabase";
import type { Announcement } from "@/lib/types";
import { usePrefs } from "@/store/prefs";

const TABS: { key: Tab; label: string }[] = [
  { key: "open", label: "접수 예정·진행 중" },
  { key: "remndr", label: "잔여세대" },
  { key: "closed", label: "종료·일정 확인 필요" },
];
const SORTS: { key: Sort; label: string }[] = [
  { key: "latest", label: "최신순" },
  { key: "deadline", label: "마감 임박순" },
  { key: "price", label: "최고 분양가 낮은 순" },
  { key: "supply", label: "공급 세대수순" },
];

export default function BrowsePage() {
  const { filters, tab, sort, hydrated, hydrate, setFilters, setTab, setSort, syncing, mode, saveStatus } = usePrefs();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false); // 상한(MAX_LOAD)에서 잘렸는가
  const [attempt, setAttempt] = useState(0); // 오류 뒤 '다시 시도'로 마지막 커서부터 이어 받기
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null | undefined>(undefined);
  const [today, setToday] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
    setToday(kstToday());
  }, [hydrate]);

  // 전량 자동 로딩: 키셋 커서로 빈 페이지가 나올 때까지 받는다(서버의 행 수 제한에도 조용히 끊기지 않는다).
  // 오류 뒤 '다시 시도'는 마지막 커서부터 이어 받는다. (공개 출시 때는 서버 측 필터가 필요하다: 전송량이 공고 수에 비례.)
  const progress = useRef<LoadProgress>(newProgress());
  useEffect(() => {
    if (!supabaseConfigured) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await loadAll<Announcement>({
          fetchPage: fetchAnnouncementsPage,
          pageSize: PAGE_SIZE,
          max: MAX_LOAD,
          progress: progress.current,
          isCancelled: () => cancelled,
          onPage: (fresh, isFirst) => setItems((prev) => (isFirst ? fresh : [...prev, ...fresh])),
        });
        if (!cancelled) setTruncated(r.truncated);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "공고를 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    fetchLastSuccessfulSync().then((v) => !cancelled && setLastSync(v)).catch(() => !cancelled && setLastSync(null));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const feed = useMemo(() => (today ? buildFeed(items, filters, tab, sort, today) : null), [items, filters, tab, sort, today]);
  const regions = useMemo(() => regionOptions(items), [items]);
  const chips = [budgetChipLabel(filters), areaChipLabel(filters)].filter((c): c is string => !!c);
  const ready = hydrated && today !== null && !syncing;
  const partial = loading || error !== null || truncated; // 전부 받기 전·오류·상한 초과면 개수는 '일부'다
  const counted = ready && !(loading && items.length === 0); // 첫 로딩 중에는 0건으로 보이지 않게 숫자를 숨긴다

  return (
    <div className="space-y-4">
      <section className="rounded-xl bg-white p-5 shadow-sm">
        <p className="text-sm text-muted">청약부터 잔여세대까지, 출처와 확인일을 함께</p>
        <h1 className="mt-1 text-2xl font-extrabold sm:text-3xl">내 조건에 맞는 주택형을 한눈에</h1>
        <label className="mt-4 block">
          <span className="sr-only">단지명·주소·지역 검색</span>
          <input
            type="search"
            value={filters.keyword}
            onChange={(e) => setFilters({ keyword: e.target.value })}
            placeholder="단지명, 주소, 지역으로 검색"
            className="w-full rounded-lg border border-line px-4 py-2.5 text-sm"
          />
        </label>
        {chips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="적용 중인 조건">
            {chips.map((c) => <Badge key={c} tone="mint">{c}</Badge>)}
            <span className="ml-1 inline-flex items-center gap-2 text-xs text-muted">면적 표시 <UnitToggle /></span>
          </div>
        )}
      </section>

      {mode === "account" && saveStatus === "load-error" && (
        <Notice tone="warn">
          계정에 저장된 검색 조건을 불러오지 못했습니다. 지금 바꾸는 조건은 저장되지 않습니다.{" "}
          <button type="button" onClick={() => void retryAccountSync()} className="font-semibold underline">다시 불러오기</button>
        </Notice>
      )}
      {mode === "account" && saveStatus === "invalid" && (
        <Notice tone="warn">최소 면적이 최대 면적보다 커서 이 조건은 계정에 저장하지 않았습니다. 값을 고치면 다시 저장됩니다.</Notice>
      )}
      {mode === "account" && saveStatus === "error" && (
        <Notice tone="warn">
          검색 조건을 계정에 저장하지 못했습니다. 이 화면에서는 적용되지만 다른 기기에는 반영되지 않습니다.{" "}
          <button type="button" onClick={() => void retrySave()} className="font-semibold underline">다시 저장</button>
        </Notice>
      )}
      {!supabaseConfigured && <Notice tone="warn">Supabase 공개 설정이 없어 공고를 불러올 수 없습니다(.env.local 확인).</Notice>}
      {supabaseConfigured && lastSync !== undefined && (
        isStale(lastSync) ? (
          <Notice tone="warn">
            <strong>정보 갱신 지연</strong> — {lastSync ? `마지막 수집 성공 ${kstDateOf(lastSync)?.replaceAll("-", ".")}` : "수집 성공 기록이 없습니다"}. 최신 내용은 공식 공고에서 확인하세요.
          </Notice>
        ) : (
          <Notice>마지막 데이터 수집 성공 {kstDateOf(lastSync)?.replaceAll("-", ".")} · 공식 출처(청약홈)의 정보를 바탕으로 제공합니다.</Notice>
        )
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <aside>
          <details className="lg:hidden rounded-xl border border-line bg-white">
            <summary className="cursor-pointer px-4 py-3 text-sm font-bold">필터 열기{chips.length ? ` (${chips.length})` : ""}</summary>
            <div className="p-2"><FilterPanel regions={regions} /></div>
          </details>
          <div className="hidden lg:block"><FilterPanel regions={regions} /></div>
        </aside>

        <section>
          <div role="group" aria-label="공고 구분" className="flex flex-wrap gap-2">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-full border px-4 py-1.5 text-sm ${tab === t.key ? "border-brand bg-brand font-semibold text-white" : "border-line bg-white text-muted"}`}
              >
                {t.label}{feed && counted ? ` ${feed.tabCounts[t.key]}` : ""}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between text-sm">
            <p className="text-muted" aria-live="polite">
              {counted && feed ? <>{partial ? "지금까지 불러온 공고 중" : "조건에 맞는"} 공고 <strong className="text-navy">{feed.matches.length}</strong>건{feed.unknown.length > 0 && <> · 판정 미확인 {feed.unknown.length}건</>}</> : "공고를 불러오는 중…"}
            </p>
            <select aria-label="정렬" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-md border border-line bg-white px-2 py-1.5 text-sm">
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>

          {error && <div className="mt-3"><Notice tone="warn">불러오기 실패: {error}</Notice></div>}

          <div className="mt-3 space-y-3">
            {ready && feed && feed.matches.map((row) => <AnnouncementCard key={row.a.id} row={row} filters={filters} />)}
            {ready && feed && feed.matches.length === 0 && !loading && (
              <p className="rounded-xl border border-dashed border-line bg-white p-6 text-center text-sm text-muted">
                이 구분에서 조건이 확인·충족된 공고가 없습니다.{feed.unknown.length > 0 ? " 아래 판정 미확인 공고를 확인해 보세요." : ""}
              </p>
            )}
            {ready && feed && feed.unknown.length > 0 && (
              <details className="rounded-xl border border-amber-300 bg-warn-bg/40 p-3" open={feed.matches.length === 0}>
                <summary className="cursor-pointer text-sm font-bold text-warn">판정 미확인 {feed.unknown.length}건 (일치 결과에 포함되지 않음)</summary>
                <div className="mt-3 space-y-3">
                  {feed.unknown.map((row) => <AnnouncementCard key={row.a.id} row={row} filters={filters} />)}
                </div>
              </details>
            )}
          </div>

          <div className="mt-4 text-center text-xs text-muted">
            {loading && <p>공고를 불러오는 중… 지금까지 {items.length.toLocaleString("ko-KR")}건 (개수·정렬은 모두 불러온 뒤 확정됩니다)</p>}
            {!loading && supabaseConfigured && !error && !truncated && <p>불러온 시점 기준 전체 {items.length.toLocaleString("ko-KR")}건을 모두 불러왔습니다. (수집이 진행되는 동안 새로 생긴 공고는 새로고침 뒤에 보입니다)</p>}
            {!loading && truncated && <p role="status" className="text-warn">공고가 너무 많아 최근 {items.length.toLocaleString("ko-KR")}건까지만 불러왔습니다. 오래된 공고는 목록에 없을 수 있습니다.</p>}
            {!loading && error && (
              <p className="text-warn">
                일부만 불러왔습니다({items.length.toLocaleString("ko-KR")}건).{" "}
                <button type="button" onClick={() => setAttempt((n) => n + 1)} className="font-semibold underline">다시 시도</button>
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
