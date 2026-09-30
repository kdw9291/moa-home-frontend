import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Filters } from "@/lib/types";

// 계정 전환 경합: A의 저장이 진행 중일 때 B가 로그인해도 A의 필터가 B에게 적용·저장되지 않는지 검증한다.
const db = {
  serverRows: {} as Record<string, unknown>, // user_id -> 행
  upserts: [] as { user_id: string }[],
  releaseUpsert: null as null | (() => void),
  holdNextUpsert: false,
  holdGet: false,
  failUpsert: false,
  releaseGet: null as null | (() => void),
  failGet: false,
};

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "user_filter_settings") throw new Error("unexpected table " + table);
      return {
        select: () => ({
          eq: (_c: string, userId: string) => ({
            maybeSingle: () => {
              if (db.failGet) return Promise.resolve({ data: null, error: { message: "service down" } });
              const snapshot = db.serverRows[userId] ?? null; // 요청 시점의 서버 상태
              if (db.holdGet) {
                db.holdGet = false;
                return new Promise((res) => (db.releaseGet = () => res({ data: snapshot, error: null }))); // 늦게 도착하는 응답
              }
              return Promise.resolve({ data: snapshot, error: null });
            },
          }),
        }),
        upsert: (row: { user_id: string }) => {
          db.upserts.push(row);
          if (db.failUpsert) return Promise.resolve({ error: { message: "rejected" } });
          if (db.holdNextUpsert) {
            db.holdNextUpsert = false;
            return new Promise((res) => (db.releaseUpsert = () => { db.serverRows[row.user_id] = row; res({ error: null }); }));
          }
          db.serverRows[row.user_id] = row;
          return Promise.resolve({ error: null });
        },
      };
    },
  },
}));

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const store: Record<string, string> = {};

let current: { onUserChanged: (id: string | null) => Promise<void> } | null = null;

async function fresh() {
  vi.resetModules();
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } } });
  const prefs = await import("@/store/prefs");
  const account = await import("@/store/account");
  prefs.usePrefs.getState().hydrate();
  current = account;
  return { usePrefs: prefs.usePrefs, ...account, PREFS_KEY: prefs.PREFS_KEY };
}

const serverRow = (userId: string, budget: number) => ({
  user_id: userId, preferred_region_codes: [], budget_max_krw: budget, min_area_sqm: null, max_area_sqm: null,
  housing_families: [], qualification_preferences: [], revision: 1,
});

afterEach(async () => {
  // 테스트가 남긴 자동 저장 타이머·구독이 다음 테스트의 공유 모의 DB에 쓰지 않게 계정 상태를 정리한다
  await current?.onUserChanged(null);
  current = null;
});

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  db.serverRows = {};
  db.upserts = [];
  db.releaseUpsert = null;
  db.holdNextUpsert = false;
  db.holdGet = false;
  db.failUpsert = false;
  db.releaseGet = null;
  db.failGet = false;
});

describe("계정 필터 동기화 경합", () => {
  it("충돌 해결(로컬 선택)의 저장이 진행 중일 때 계정이 바뀌면 이전 계정 필터가 적용되지 않는다", async () => {
    // 비회원이 조건을 저장해 둔 상태(앱 시작 시 hydrate가 복원)에서 계정 A로 로그인, 서버(A)에는 다른 조건이 있음 -> 충돌
    store["moahome.prefs.v1"] = JSON.stringify({ filters: { budgetMaxKrw: 600_000_000 }, tab: "open", sort: "latest" });
    const { usePrefs, onUserChanged, resolveConflict } = await fresh();
    db.serverRows["A"] = serverRow("A", 500_000_000);
    await onUserChanged("A");
    expect(usePrefs.getState().conflict).not.toBeNull();

    db.holdNextUpsert = true; // A의 '로컬 선택' 저장을 붙잡아 둔다
    const pending = resolveConflict("local");
    await tick();
    await onUserChanged("B"); // 그 사이 B가 로그인(서버에 B의 행은 없음)
    db.releaseUpsert!(); // A의 저장이 이제야 끝남
    await pending;
    await tick();

    const s = usePrefs.getState();
    expect(s.filters.budgetMaxKrw).toBeNull(); // A의 6억 조건이 B에게 남지 않는다
    expect(s.conflict).toBeNull();
    expect(s.mode).toBe("account"); // B가 계정 모드로 정상 동작
    // B의 이후 변경은 B의 행으로만 저장된다
    s.setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(900);
    expect(db.upserts.at(-1)!.user_id).toBe("B");
    expect((db.serverRows["A"] as { budget_max_krw: number }).budget_max_krw).toBe(600_000_000); // A의 행은 A가 고른 값 그대로
  });

  it("로그아웃하면 필터와 브라우저 저장본이 지워지고 이후 변경은 저장되지 않는다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 500_000_000);
    await onUserChanged("A");
    expect(usePrefs.getState()).toMatchObject({ mode: "account", filters: { budgetMaxKrw: 500_000_000 } });
    await onUserChanged(null);
    expect(usePrefs.getState().filters.budgetMaxKrw).toBeNull();
    const before = db.upserts.length;
    usePrefs.getState().setFilters({ budgetMaxKrw: 100 });
    await tick(900);
    expect(db.upserts.length).toBe(before); // 로그아웃 후에는 서버에 저장하지 않는다
  });

  it("계정 모드의 변경은 브라우저 저장소에 남지 않는다", async () => {
    const { usePrefs, onUserChanged, PREFS_KEY } = await fresh();
    db.serverRows["A"] = serverRow("A", 500_000_000);
    await onUserChanged("A");
    usePrefs.getState().setFilters({ keyword: "개인 검색어" });
    const saved = store[PREFS_KEY] ?? "";
    expect(saved).not.toContain("개인 검색어");
  });
});

describe("계정 동기화: 경합·실패 경로", () => {
  it("A→B→A로 돌아와도 예전 A의 늦은 조회 결과가 새 A 세션에 적용되지 않는다(세대 번호)", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 111_000_000);
    db.holdGet = true;                       // 첫 A 조회 응답을 붙잡는다(이 응답은 111M 스냅샷)
    const first = onUserChanged("A");
    await tick();
    await onUserChanged("B");                // B로 전환(서버에 B 행 없음)
    db.serverRows["A"] = serverRow("A", 222_000_000); // 그 사이 A의 서버 값이 바뀜
    await onUserChanged("A");                // 다시 A: 새 세대의 조회는 222M
    await tick();
    expect(usePrefs.getState().filters.budgetMaxKrw).toBe(222_000_000);
    db.releaseGet!();                        // 이제야 예전 A의 조회(111M)가 도착
    await first;
    await tick();
    expect(usePrefs.getState().filters.budgetMaxKrw).toBe(222_000_000); // 오래된 값이 덮지 않는다
    expect(usePrefs.getState().mode).toBe("account");
  });

  it("저장이 겹쳐도 한 번에 하나씩 순서대로 저장하고 마지막 값이 남는다(오래된 저장이 덮지 않음)", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 100_000_000); // revision 1
    await onUserChanged("A");
    db.holdNextUpsert = true;                // 첫 저장을 붙잡는다
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(900);                         // 디바운스 뒤 첫 저장 요청이 나간 상태(진행 중)
    expect(db.upserts).toHaveLength(1);
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(900);                         // 두 번째 저장은 첫 저장이 끝날 때까지 대기해야 한다
    expect(db.upserts).toHaveLength(1);
    db.releaseUpsert!();                     // 첫 저장 완료
    await tick(100);
    expect(db.upserts).toHaveLength(2);
    expect(db.upserts.map((u) => (u as unknown as { budget_max_krw: number }).budget_max_krw)).toEqual([200_000_000, 300_000_000]);
    expect(db.upserts.map((u) => (u as unknown as { revision: number }).revision)).toEqual([2, 3]); // 개정 번호가 순서대로
    expect((db.serverRows["A"] as { budget_max_krw: number }).budget_max_krw).toBe(300_000_000);
    expect(usePrefs.getState().saveStatus).toBe("saved");
  });

  it("계정 조건 조회에 실패하면 계정 모드로 전환해 브라우저에 쓰지 않고 알린다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 500_000_000);
    db.failGet = true;
    await onUserChanged("A");
    const s = usePrefs.getState();
    expect(s.mode).toBe("account");                  // 비회원 저장 모드에 남지 않는다
    expect(s.saveStatus).toBe("load-error");
    s.setFilters({ keyword: "공용 PC에 남으면 안 되는 검색어", budgetMaxKrw: 300_000_000 });
    await tick(900);
    expect(store["moahome.prefs.v1"] ?? "").not.toContain("공용 PC");   // 브라우저 저장소에 쓰지 않음
    expect(store["moahome.prefs.v1"] ?? "").not.toContain("300000000");
    expect(db.upserts).toHaveLength(0);              // 서버에도 쓰지 않음(개정 번호를 알 수 없다)
  });

  it("조회 실패 중 바꾼 조건이 있고 서버 값과 다르면, 다시 불러올 때 버리지 않고 선택창으로 넘긴다", async () => {
    const { usePrefs, onUserChanged, retryAccountSync, resolveConflict } = await fresh();
    db.serverRows["A"] = serverRow("A", 500_000_000);
    db.failGet = true;
    await onUserChanged("A");
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    db.failGet = false;
    await retryAccountSync();
    await tick();
    expect(usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 300_000_000 }, server: { budgetMaxKrw: 500_000_000 } });
    expect(usePrefs.getState().filters.budgetMaxKrw).toBe(300_000_000);   // 선택 전까지 화면의 조건을 유지
    expect(db.upserts).toHaveLength(0);
    await resolveConflict("local");                                        // 내 조건을 고르면 그때 저장
    await tick();
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 300_000_000, revision: 2 });
    expect(usePrefs.getState().saveStatus).toBe("saved");
  });

  it("조회 실패 중 바꾼 조건이 있고 서버에 행이 없으면, 다시 불러올 때 그 조건을 계정에 저장한다(저장된 것처럼 보이기만 하지 않는다)", async () => {
    const { usePrefs, onUserChanged, retryAccountSync } = await fresh();
    db.failGet = true;
    await onUserChanged("A");
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    db.failGet = false;
    await retryAccountSync();
    await tick();
    expect(db.upserts.at(-1)).toMatchObject({ user_id: "A", budget_max_krw: 300_000_000, revision: 1 });
    expect(usePrefs.getState().saveStatus).toBe("saved");
    expect((db.serverRows["A"] as { budget_max_krw: number }).budget_max_krw).toBe(300_000_000);
  });

  it("조회 실패 뒤 아무것도 바꾸지 않고 다시 불러오면 서버 값을 적용한다", async () => {
    const { usePrefs, onUserChanged, retryAccountSync } = await fresh();
    db.serverRows["A"] = serverRow("A", 500_000_000);
    db.failGet = true;
    await onUserChanged("A");
    db.failGet = false;
    await retryAccountSync();
    await tick();
    const s = usePrefs.getState();
    expect(s.saveStatus).toBe("idle");
    expect(s.filters.budgetMaxKrw).toBe(500_000_000);
    expect(s.conflict).toBeNull();
    s.setFilters({ budgetMaxKrw: 600_000_000 });
    await tick(900);
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 600_000_000, revision: 2 }); // 서버 행 revision 1 다음
  });

  it("첫 저장이 실패하면 복구 가능한 로컬 사본을 지우지 않고, '다시 저장'이 성공하면 그때 지운다", async () => {
    store["moahome.prefs.v1"] = JSON.stringify({ filters: { budgetMaxKrw: 400_000_000 }, tab: "open", sort: "latest" });
    const { usePrefs, onUserChanged, retrySave } = await fresh();
    db.failUpsert = true;
    await onUserChanged("A");                                   // 서버 행 없음 + 로컬 조건 -> 첫 저장 시도(실패)
    await tick();
    expect(usePrefs.getState().saveStatus).toBe("error");
    expect(usePrefs.getState().filters.budgetMaxKrw).toBe(400_000_000);
    expect(store["moahome.prefs.v1"] ?? "").toContain("400000000");  // 로컬 사본이 남아 있다(새로고침 때 같은 경로로 재시도 가능)
    db.failUpsert = false;
    await retrySave();
    await tick();
    expect(usePrefs.getState().saveStatus).toBe("saved");
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 400_000_000 });
    expect(store["moahome.prefs.v1"]).toBeUndefined();          // 서버에 저장됐으니 로컬 사본은 정리
  });

  it("멈춘 저장 요청은 시간 제한 뒤 실패로 처리되고 이후 저장을 막지 않는다", async () => {
    const { usePrefs, onUserChanged, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.holdNextUpsert = true;                                   // 첫 저장 요청은 끝내 응답하지 않는다
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(1200);                                           // 디바운스 + 시간 제한
    expect(usePrefs.getState().saveStatus).toBe("error");
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(1200);                                           // 다음 저장은 정상 처리
    expect(usePrefs.getState().saveStatus).toBe("saved");
    expect((db.serverRows["A"] as { budget_max_krw: number }).budget_max_krw).toBe(300_000_000);
  });

  it("로그인 직후 계정 조건을 기다리는 동안의 변경은 브라우저 저장소에 쓰이지 않는다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 500_000_000);
    db.holdGet = true;                                          // 조회 응답을 붙잡는다
    const pending = onUserChanged("A");
    await tick();
    expect(usePrefs.getState().syncing).toBe(true);
    usePrefs.getState().setFilters({ keyword: "대기 중에 친 검색어", budgetMaxKrw: 123_000_000 });
    await tick(100);
    expect(store["moahome.prefs.v1"] ?? "").not.toContain("대기 중");
    expect(store["moahome.prefs.v1"] ?? "").not.toContain("123000000");
    db.releaseGet!();
    await pending;
  });

  it("DB가 거부할 값(면적 0·비유한·범위 초과)은 서버로 보내지 않고 invalid로 알린다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    for (const bad of [{ minAreaSqm: 0 }, { maxAreaSqm: Number.NaN }, { minAreaSqm: 1e12 }, { budgetMaxKrw: 1.5 }]) {
      usePrefs.getState().resetFilters();
      usePrefs.getState().setFilters(bad);
      await tick(900);
      expect(usePrefs.getState().saveStatus).toBe("invalid");
    }
    expect(db.upserts).toHaveLength(0);
  });
});

// 타입 확인용(사용하지 않음): Filters 형태가 바뀌면 컴파일 단계에서 알 수 있게 한다
const _shape: Pick<Filters, "budgetMaxKrw"> = { budgetMaxKrw: null };
void _shape;
