import { describe, expect, it } from "vitest";
import { compareByCursorOrder, cursorOf, type Cursor } from "@/lib/cursor";
import { loadAll, newProgress } from "@/lib/loadAll";

interface Row { id: string; rcrit_pblanc_de: string | null }
const mkRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id${String(i).padStart(5, "0")}`, rcrit_pblanc_de: i % 7 === 0 ? null : `2026-09-${String(1 + (i % 5)).padStart(2, "0")}` }));

/** 서버 흉내: 정렬·커서 뒤 필터·limit, 그리고 서버 최대 행 수(cap)로 limit보다 적게 돌려줄 수 있다. */
function server(rows: Row[], cap = Infinity) {
  const sorted = [...rows].sort((a, b) => compareByCursorOrder(cursorOf(a), cursorOf(b)));
  const calls: (Cursor | null)[] = [];
  return {
    calls,
    fetchPage: async (cursor: Cursor | null, limit: number) => {
      calls.push(cursor);
      const after = cursor ? sorted.filter((r) => compareByCursorOrder(cursorOf(r), cursor) > 0) : sorted;
      return after.slice(0, Math.min(limit, cap));
    },
  };
}

async function run(rows: Row[], o: { pageSize?: number; max?: number; cap?: number } = {}) {
  const s = server(rows, o.cap);
  const got: Row[] = [];
  const progress = newProgress();
  const r = await loadAll<Row>({
    fetchPage: s.fetchPage, pageSize: o.pageSize ?? 200, max: o.max ?? 8000, progress,
    onPage: (fresh, isFirst) => { if (isFirst) got.length = 0; got.push(...fresh); },
  });
  return { got, r, s, progress };
}

describe("전량 로딩 루프", () => {
  it("빈 페이지가 나올 때까지 모두 받는다(마지막에 빈 요청 1회)", async () => {
    const { got, r, s } = await run(mkRows(450));
    expect(got).toHaveLength(450);
    expect(new Set(got.map((x) => x.id)).size).toBe(450);
    expect(r.truncated).toBe(false);
    expect(s.calls).toHaveLength(4); // 200 + 200 + 50 + 빈 페이지
    expect(s.calls[0]).toBeNull();
  });

  it("서버가 limit보다 적게 돌려줘도(행 수 제한) 목록이 끊기지 않는다", async () => {
    const { got, r } = await run(mkRows(450), { cap: 100 });
    expect(got).toHaveLength(450);
    expect(r.truncated).toBe(false);
  });

  it("데이터가 한 페이지보다 적어도, 0건이어도 정상 종료", async () => {
    expect((await run(mkRows(3))).got).toHaveLength(3);
    const empty = await run([]);
    expect(empty.got).toHaveLength(0);
    expect(empty.r.truncated).toBe(false);
  });

  it("정확히 상한 개수면 '잘림'이 아니고, 그 뒤에 더 있을 때만 잘림이다", async () => {
    expect((await run(mkRows(300), { pageSize: 100, max: 300 })).r.truncated).toBe(false);
    const more = await run(mkRows(301), { pageSize: 100, max: 300 });
    expect(more.r.truncated).toBe(true);
    expect(more.got).toHaveLength(300);
  });

  it("오류가 나면 같은 진행 상태로 마지막 커서부터 이어 받고 중복이 없다", async () => {
    const rows = mkRows(450);
    const s = server(rows);
    let n = 0;
    const flaky = async (c: Cursor | null, l: number) => { n += 1; if (n === 3) throw new Error("boom"); return s.fetchPage(c, l); };
    const progress = newProgress();
    const got: Row[] = [];
    const opts = { fetchPage: flaky, pageSize: 200, max: 8000, progress, onPage: (f: Row[], first: boolean) => { if (first) got.length = 0; got.push(...f); } };
    await expect(loadAll<Row>(opts)).rejects.toThrow("boom");
    expect(got).toHaveLength(400);                 // 오류 전까지 받은 것은 유지
    await loadAll<Row>(opts);                      // 재시도: 처음부터 다시 받지 않는다
    expect(got).toHaveLength(450);
    expect(new Set(got.map((x) => x.id)).size).toBe(450);
    expect(s.calls.filter((c) => c === null)).toHaveLength(1); // 커서 없는(첫 페이지) 요청은 한 번뿐
  });

  it("같은 id가 다시 오면 한 번만 담고, 커서가 전진하지 않으면 멈춘다(무한 루프 방지)", async () => {
    const stuck: Row[] = [{ id: "a", rcrit_pblanc_de: "2026-09-01" }, { id: "b", rcrit_pblanc_de: "2026-09-01" }];
    let calls = 0;
    const got: Row[] = [];
    await loadAll<Row>({
      fetchPage: async () => { calls += 1; return stuck; }, // 서버가 항상 같은 페이지만 돌려주는 이상 상황
      pageSize: 2, max: 100, progress: newProgress(), onPage: (f) => got.push(...f),
    });
    expect(got.map((x) => x.id)).toEqual(["a", "b"]);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("취소되면 더 이상 담지 않는다", async () => {
    const s = server(mkRows(450));
    const got: Row[] = [];
    let cancelled = false;
    await loadAll<Row>({
      fetchPage: s.fetchPage, pageSize: 200, max: 8000, progress: newProgress(), isCancelled: () => cancelled,
      onPage: (f) => { got.push(...f); cancelled = true; },
    });
    expect(got).toHaveLength(200);
  });
});
