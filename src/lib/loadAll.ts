// 전량 자동 로딩 루프(순수 로직). 화면과 분리해 서버의 행 수 제한·상한·재개를 테스트로 고정한다.
import { cursorOf, type Cursor } from "./cursor";

export interface LoadProgress {
  cursor: Cursor | null; // 마지막으로 받은 행(다음 페이지의 기준)
  total: number; // 지금까지 담은 행 수
  seen: Set<string>; // 이미 담은 id(어떤 이유로든 같은 id가 다시 오면 한 번만 담는다)
}

export const newProgress = (): LoadProgress => ({ cursor: null, total: 0, seen: new Set() });

export interface LoadOptions<T extends { id: string; rcrit_pblanc_de: string | null }> {
  fetchPage: (cursor: Cursor | null, limit: number) => Promise<T[]>;
  pageSize: number;
  max: number; // 이만큼 담으면 더 있는지만 확인하고 멈춘다
  progress: LoadProgress; // 오류 뒤 같은 객체로 다시 호출하면 마지막 커서부터 이어 받는다
  onPage: (fresh: T[], isFirstPage: boolean) => void;
  isCancelled?: () => boolean;
}

/**
 * 끝은 '빈 페이지'로만 판단한다. 서버가 요청한 limit보다 적게 돌려주는 경우(예: PostgREST max_rows 제한)를
 * 마지막 페이지로 오인하면 목록이 조용히 불완전해지기 때문이다. 대가는 마지막에 빈 요청 1회다.
 * 반환 truncated: 상한(max)에 도달했고 그 뒤에 실제로 더 있을 때만 true.
 */
export async function loadAll<T extends { id: string; rcrit_pblanc_de: string | null }>(o: LoadOptions<T>): Promise<{ truncated: boolean }> {
  const p = o.progress;
  for (;;) {
    const isFirst = p.cursor === null;
    const page = await o.fetchPage(p.cursor, o.pageSize);
    if (o.isCancelled?.()) return { truncated: false };
    if (page.length === 0) return { truncated: false };
    const fresh = page.filter((a) => !p.seen.has(a.id));
    fresh.forEach((a) => p.seen.add(a.id));
    p.total += fresh.length;
    o.onPage(fresh, isFirst);
    const next = cursorOf(page[page.length - 1]!);
    if (p.cursor && next.id === p.cursor.id && next.rcrit === p.cursor.rcrit) return { truncated: false }; // 커서가 전진하지 않으면 무한 루프 방지
    p.cursor = next;
    if (p.total >= o.max) {
      const probe = await o.fetchPage(p.cursor, 1); // 정확히 상한 개수였다면 '잘림'이라고 말하지 않는다
      return { truncated: !o.isCancelled?.() && probe.length > 0 };
    }
  }
}
