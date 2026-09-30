"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AnnouncementCard } from "@/components/AnnouncementCard";
import { NotificationSettings } from "@/components/NotificationSettings";
import { Notice } from "@/components/ui";
import { kstToday } from "@/lib/dates";
import { DEFAULT_FILTERS, type FeedRow } from "@/lib/feed";
import { announcementStatus } from "@/lib/labels";
import { announcementMatch } from "@/lib/matching";
import { fetchBookmarkedAnnouncements } from "@/lib/queries";
import type { Announcement } from "@/lib/types";
import { usePrefs } from "@/store/prefs";
import { useSession } from "@/store/session";

export default function BookmarksPage() {
  const { ready, user, openLogin, bookmarkIds } = useSession();
  const filters = usePrefs((s) => s.filters);
  const hydrate = usePrefs((s) => s.hydrate);
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
    setToday(kstToday());
  }, [hydrate]);

  const userId = user?.id ?? null;
  useEffect(() => {
    setItems(null); // 사용자가 바뀌면 이전 사용자의 목록을 즉시 비운다
    setError(null);
    if (!userId) return;
    let cancelled = false;
    fetchBookmarkedAnnouncements()
      .then((r) => !cancelled && setItems(r))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "불러오지 못했습니다."));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // 이 화면에서 북마크를 해제하면 목록에서 바로 빠진다(서버 상태는 store가 관리)
  const rows: FeedRow[] = useMemo(() => {
    if (!items || !today) return [];
    return items
      .filter((a) => bookmarkIds.has(a.id))
      .map((a) => ({ a, status: announcementStatus(a, today), match: announcementMatch(a, DEFAULT_FILTERS) }))
      .sort((x, y) => (x.status.nextEndsOn ?? "9999").localeCompare(y.status.nextEndsOn ?? "9999"));
  }, [items, today, bookmarkIds]);

  if (!ready) return <p className="text-sm text-muted">불러오는 중…</p>;
  if (!user) {
    return (
      <div className="space-y-3 rounded-xl bg-white p-6 shadow-sm">
        <h1 className="text-xl font-extrabold">관심 공고</h1>
        <p className="text-sm text-muted">관심 공고 저장과 접수일 알림은 로그인 후 사용할 수 있습니다.</p>
        <button onClick={() => openLogin("관심 공고를 저장하고 접수일 알림을 받으려면 로그인해 주세요.")} className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white">로그인</button>
        <div><Link href="/" className="text-sm text-muted underline">← 공고 목록</Link></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/" className="text-sm text-muted underline">← 공고 목록</Link>
      <h1 className="text-2xl font-extrabold">관심 공고</h1>
      <NotificationSettings />
      {error && <Notice tone="warn">불러오기 실패: {error}</Notice>}
      {items === null && !error && <p className="text-sm text-muted">불러오는 중…</p>}
      {items !== null && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-line bg-white p-6 text-center text-sm text-muted">저장한 관심 공고가 없습니다. 공고 목록에서 &lsquo;♡ 관심 저장&rsquo;을 눌러 추가하세요.</p>
      )}
      <div className="space-y-3">
        {rows.map((row) => <AnnouncementCard key={row.a.id} row={row} filters={filters} />)}
      </div>
    </div>
  );
}
