import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Filters } from "@/lib/types";

// 계정 전환 경합: A의 저장이 진행 중일 때 B가 로그인해도 A의 필터가 B에게 적용·저장되지 않는지 검증한다.
// 모의 서버는 저장 RPC(save_user_filter_settings)의 계약을 따른다: 예상 revision 비교, 요청 기록(request_id) 재생, SQLSTATE 오류.
type Row = Record<string, any>;
const db = {
  serverRows: {} as Record<string, unknown>, // user_id -> 행
  upserts: [] as { user_id: string }[], // 서버에 실제로 반영된 저장(행 형태)
  ledger: {} as Record<string, Record<string, { input: string; applied: number; current: unknown }>>, // user_id -> request_id -> 결과
  rpcCalls: [] as { id: string; exp: number }[],
  releaseUpsert: null as null | (() => void),
  holdNextUpsert: false, // 다음 저장 요청의 응답을 붙잡는다(해제할 때 반영 후 응답)
  applyThenHang: false, // 다음 저장은 서버에 반영되지만 응답이 오지 않는다(시간 초과 뒤 재시도 시나리오)
  beforeApply: null as null | ((callNo: number) => void), // 저장 RPC가 서버에서 처리되기 직전에 호출된다(그 사이 다른 기기의 저장을 흉내)
  holdGet: false,
  failUpsert: false as boolean | string, // 서버가 SQLSTATE 오류로 거절한다(true면 XX000, 문자열이면 그 코드, "network"면 코드 없는 네트워크 오류)
  releaseGet: null as null | (() => void),
  failGet: false,
  lastFetchUser: "", // 마지막으로 조회한 사용자 = 현재 세션 사용자(JWT 대신)
};

const EMPTY = { preferred_region_codes: [], budget_max_krw: null, min_area_sqm: null, max_area_sqm: null, housing_families: [], qualification_preferences: [] };
const view = (r: Row) => ({
  preferred_region_codes: r.preferred_region_codes, budget_max_krw: r.budget_max_krw === null ? null : String(r.budget_max_krw),
  min_area_sqm: r.min_area_sqm, max_area_sqm: r.max_area_sqm, housing_families: r.housing_families,
  qualification_preferences: r.qualification_preferences, revision: r.revision,
});

function applyRpc(user: string, a: Row): { data?: unknown; error?: unknown } {
  const input = JSON.stringify({ ...a, p_request_id: undefined });
  const led = (db.ledger[user] ??= {});
  const hit = led[a.p_request_id];
  if (hit) return hit.input === input ? { data: { status: "saved", applied_revision: hit.applied, replayed: true, current: hit.current } } : { error: { code: "22023" } };
  const row = db.serverRows[user] as Row | undefined;
  const exp = a.p_expected_revision as number;
  if (row ? row.revision !== exp : exp !== 0) return { data: { status: "conflict", current: row ? view(row) : { ...EMPTY, revision: 0 } } };
  const next = {
    user_id: user, preferred_region_codes: a.p_preferred_region_codes, budget_max_krw: a.p_budget_max_krw === null ? null : Number(a.p_budget_max_krw),
    min_area_sqm: a.p_min_area_sqm, max_area_sqm: a.p_max_area_sqm, housing_families: a.p_housing_families,
    qualification_preferences: a.p_qualification_preferences, revision: exp + 1,
  };
  db.serverRows[user] = next;
  db.upserts.push(next);
  const current = view(next);
  led[a.p_request_id] = { input, applied: next.revision, current };
  return { data: { status: "saved", applied_revision: next.revision, replayed: false, current } };
}

const norm = (x: { data?: unknown; error?: unknown }) => ({ data: x.data ?? null, error: x.error ?? null });

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "user_filter_settings") throw new Error("unexpected table " + table);
      return {
        select: () => ({
          eq: (_c: string, userId: string) => ({
            maybeSingle: () => {
              db.lastFetchUser = userId;
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
      };
    },
    rpc: (name: string, a: Row) => {
      if (name !== "save_user_filter_settings") throw new Error("unexpected rpc " + name);
      db.rpcCalls.push({ id: a.p_request_id, exp: a.p_expected_revision });
      db.beforeApply?.(db.rpcCalls.length);
      const user = db.lastFetchUser;
      let p: Promise<{ data: unknown; error: unknown }>;
      if (db.failUpsert) p = Promise.resolve({ data: null, error: { code: db.failUpsert === "network" ? "" : db.failUpsert === true ? "XX000" : db.failUpsert, message: "rejected" } });
      else if (db.applyThenHang) {
        db.applyThenHang = false;
        applyRpc(user, a);
        p = new Promise(() => {}); // 서버에는 반영됐지만 응답이 오지 않는다
      } else if (db.holdNextUpsert) {
        db.holdNextUpsert = false;
        p = new Promise((res) => (db.releaseUpsert = () => res(norm(applyRpc(user, a)))));
      } else p = Promise.resolve(norm(applyRpc(user, a)));
      const builder = { abortSignal: () => builder, then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => p.then(f, r) };
      return builder;
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
  db.ledger = {};
  db.rpcCalls = [];
  db.applyThenHang = false;
  db.beforeApply = null;
  db.lastFetchUser = "";
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
    expect(db.rpcCalls).toHaveLength(1);
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(900);                         // 두 번째 저장은 첫 저장이 끝날 때까지 대기해야 한다
    expect(db.rpcCalls).toHaveLength(1);
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
    expect(store["moahome.prefs.v1"]).toBeUndefined();               // 비회원 저장 키에는 계정 조건을 남기지 않는다(다른 계정에 넘어갈 수 있다)
    expect(store["moahome.pending.v2:A"]).toContain("400000000");      // 사용자 전용 복구 사본이 남아 있다(새로고침 때 같은 계정이면 복구)
    db.failUpsert = false;
    await retrySave();
    await tick();
    expect(usePrefs.getState().saveStatus).toBe("saved");
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 400_000_000 });
    expect(store["moahome.pending.v2:A"]).toBeUndefined();        // 서버에 저장됐으니 복구 사본은 정리
  });

  it("멈춘 저장 요청은 시간 제한 뒤 재조회하고 같은 request ID로 재시도해 이후 저장을 막지 않는다", async () => {
    const { usePrefs, onUserChanged, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.holdNextUpsert = true;                                   // 첫 요청은 끝내 응답하지 않는다(서버에도 반영되지 않았다)
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(1200);                                           // 디바운스 + 시간 제한 + 재시도
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.rpcCalls[1]!.id).toBe(db.rpcCalls[0]!.id);        // 같은 request ID와 같은 예상 revision으로 재시도
    expect(db.rpcCalls[1]!.exp).toBe(db.rpcCalls[0]!.exp);
    expect(usePrefs.getState().saveStatus).toBe("saved");
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(1200);                                           // 다음 저장은 정상 처리
    expect(usePrefs.getState().saveStatus).toBe("saved");
    expect((db.serverRows["A"] as { budget_max_krw: number; revision: number })).toMatchObject({ budget_max_krw: 300_000_000, revision: 3 });
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

describe("계정 동기화: 재리뷰 #3 보완", () => {
  it("충돌창에서 '내 조건'을 골랐는데 저장이 실패해도 새로고침 뒤 같은 계정이면 그 조건을 복구한다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.prefs.v1"] = JSON.stringify({ filters: { budgetMaxKrw: 300_000_000 }, tab: "open", sort: "latest" });
    const first = await fresh();
    await first.onUserChanged("A");                              // 로컬 300M vs 서버 500M -> 선택창
    db.failUpsert = true;
    await first.resolveConflict("local");                        // 저장 실패
    await tick();
    expect(first.usePrefs.getState().saveStatus).toBe("error");
    // 계정 모드에서 바뀐 조건은 비회원 저장 키가 아니라 사용자 전용 복구 사본에 남는다
    delete store["moahome.prefs.v1"];
    expect(store["moahome.pending.v2:A"]).toContain("300000000");
    db.failUpsert = false;
    const reloaded = await fresh();                              // 새로고침
    await reloaded.onUserChanged("A");
    await tick();
    expect(reloaded.usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 300_000_000 }, server: { budgetMaxKrw: 500_000_000 } });   // 잃지 않고 다시 선택하게 한다
  });

  it("복구 사본은 다른 계정에 섞이지 않고 로그아웃하면 지워진다", async () => {
    store["moahome.pending.v2:A"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 300_000_000 } });
    db.serverRows["B"] = serverRow("B", 700_000_000);
    const { usePrefs, onUserChanged } = await fresh();
    await onUserChanged("B");
    await tick();
    expect(usePrefs.getState().filters.budgetMaxKrw).toBe(700_000_000);
    expect(usePrefs.getState().conflict).toBeNull();
    await onUserChanged(null);                                   // B의 로그아웃은 A의 복구 사본을 건드리지 않는다
    expect(store["moahome.pending.v2:A"]).toContain('"userId":"A"');
  });

  it("자기 계정의 복구 사본은 로그아웃하면 지워진다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.pending.v2:A"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 300_000_000 } });
    const { onUserChanged } = await fresh();
    await onUserChanged("A");                                    // 충돌창이 열린 상태
    await onUserChanged(null);
    expect(store["moahome.pending.v2:A"]).toBeUndefined();
  });

  it("조회를 기다리는 동안 바꾼 조건은 응답이 와도 서버 값에 덮이지 않고 선택창으로 간다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 500_000_000);
    db.holdGet = true;
    const pending = onUserChanged("A");
    await tick();
    usePrefs.getState().setFilters({ budgetMaxKrw: 123_000_000 });
    db.releaseGet!();
    await pending;
    await tick();
    expect(usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 123_000_000 }, server: { budgetMaxKrw: 500_000_000 } });
    expect(usePrefs.getState().filters.budgetMaxKrw).toBe(123_000_000);
  });
});

describe("계정 동기화: 재리뷰 #4 보완", () => {
  it("서버 조건을 선택하면 오래된 복구 사본도 지워져 다음 세션에 되살아나지 않는다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.pending.v2:A"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 300_000_000 } });
    const first = await fresh();
    await first.onUserChanged("A");
    expect(first.usePrefs.getState().conflict).not.toBeNull();
    await first.resolveConflict("server");
    expect(store["moahome.pending.v2:A"]).toBeUndefined();
    const again = await fresh();
    await again.onUserChanged("A");
    await tick();
    expect(again.usePrefs.getState().conflict).toBeNull();
    expect(again.usePrefs.getState().filters.budgetMaxKrw).toBe(500_000_000);
  });

  it("복구 사본이 있는데 첫 조회가 실패하면, 기본 조건으로 '다시 불러오기'를 해도 복구 사본이 가려지지 않는다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.pending.v2:A"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 300_000_000 } });
    const { usePrefs, onUserChanged, retryAccountSync } = await fresh();
    db.failGet = true;
    await onUserChanged("A");
    expect(usePrefs.getState().saveStatus).toBe("load-error");
    expect(store["moahome.pending.v2:A"]).toContain("300000000");   // 실패 중에는 지우지 않는다
    db.failGet = false;
    await retryAccountSync();                                     // 화면은 기본 조건(바꾼 적 없음)
    await tick();
    expect(usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 300_000_000 }, server: { budgetMaxKrw: 500_000_000 } });
  });

  it("저장 실패 뒤 세션만 사라지고 다른 계정으로 로그인해도 이전 계정의 조건이 넘어가지 않는다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.prefs.v1"] = JSON.stringify({ filters: { budgetMaxKrw: 300_000_000 }, tab: "open", sort: "latest" });
    const first = await fresh();
    await first.onUserChanged("A");
    db.failUpsert = true;
    await first.resolveConflict("local");                         // 저장 실패 -> 복구 사본(사용자 전용)만 남는다
    await tick();
    expect(store["moahome.prefs.v1"]).toBeUndefined();
    db.failUpsert = false;
    db.serverRows["B"] = serverRow("B", 700_000_000);
    const next = await fresh();                                   // 명시적 로그아웃 없이 브라우저를 닫았다가 B로 로그인
    await next.onUserChanged("B");
    await tick();
    expect(next.usePrefs.getState().conflict).toBeNull();
    expect(next.usePrefs.getState().filters.budgetMaxKrw).toBe(700_000_000);
    expect(db.upserts.filter((u) => (u as { user_id: string }).user_id === "B")).toHaveLength(0);
  });
});

describe("계정 동기화: 재리뷰 #5 보완", () => {
  it("내 조건 저장이 끝나기 전에도 복구 사본이 남아 있고, 저장이 성공하면 지워진다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.prefs.v1"] = JSON.stringify({ filters: { budgetMaxKrw: 300_000_000 }, tab: "open", sort: "latest" });
    const { usePrefs, onUserChanged, resolveConflict } = await fresh();
    await onUserChanged("A");
    db.holdNextUpsert = true;                                    // 저장 응답이 늦는 동안
    const p = resolveConflict("local");
    await tick(50);
    expect(store["moahome.prefs.v1"]).toBeUndefined();
    expect(store["moahome.pending.v2:A"]).toContain("300000000");  // 탭이 닫혀도 잃지 않는다
    db.releaseUpsert!();
    await p;
    await tick();
    expect(usePrefs.getState().saveStatus).toBe("saved");
    expect(store["moahome.pending.v2:A"]).toBeUndefined();
  });

  it("서버 행이 없는 로그인에서도 저장이 끝나기 전에 복구 사본이 남는다", async () => {
    store["moahome.prefs.v1"] = JSON.stringify({ filters: { budgetMaxKrw: 400_000_000 }, tab: "open", sort: "latest" });
    const { onUserChanged } = await fresh();
    db.holdNextUpsert = true;
    const p = onUserChanged("A");
    await tick(50);
    expect(store["moahome.pending.v2:A"]).toContain("400000000");
    db.releaseUpsert!();
    await p;
    await tick();
    expect(store["moahome.pending.v2:A"]).toBeUndefined();
  });

  it("충돌창을 연 채 새로고침해도 후보가 남는다(조회 실패 중 입력한 조건 포함)", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    const first = await fresh();
    db.failGet = true;
    await first.onUserChanged("A");
    first.usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    db.failGet = false;
    await first.retryAccountSync();
    await tick();
    expect(first.usePrefs.getState().conflict).not.toBeNull();
    const reloaded = await fresh();                              // 선택하지 않고 새로고침
    await reloaded.onUserChanged("A");
    await tick();
    expect(reloaded.usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 300_000_000 } });
  });

  it("조회 실패 뒤 표시 단위만 바꾸고 다시 불러와도 복구 사본이 우선한다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.pending.v2:A"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 300_000_000 } });
    const { usePrefs, onUserChanged, retryAccountSync } = await fresh();
    db.failGet = true;
    await onUserChanged("A");
    usePrefs.getState().setFilters({ areaUnit: "pyeong" });
    db.failGet = false;
    await retryAccountSync();
    await tick();
    expect(usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 300_000_000 } });
  });
});

describe("계정 동기화: 재리뷰 #6 보완", () => {
  it("조회를 기다리는 동안 표시 단위만 바꿔도 복구 사본은 지워지지 않는다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.pending.v2:A"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 300_000_000 } });
    const { usePrefs, onUserChanged } = await fresh();
    db.holdGet = true;
    const p = onUserChanged("A");
    await tick();
    usePrefs.getState().setFilters({ areaUnit: "pyeong" });
    db.releaseGet!();
    await p;
    await tick();
    expect(usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 300_000_000 }, server: { budgetMaxKrw: 500_000_000 } });
    expect(store["moahome.pending.v2:A"]).toContain("300000000");
  });

  it("첫 저장을 기다리는 동안 다시 바꾼 조건도 저장되고, 저장된 값과 다른 동안은 복구 사본이 남는다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.prefs.v1"] = JSON.stringify({ filters: { budgetMaxKrw: 300_000_000 }, tab: "open", sort: "latest" });
    const { usePrefs, onUserChanged, resolveConflict } = await fresh();
    await onUserChanged("A");
    db.holdNextUpsert = true;
    const p = resolveConflict("local");
    await tick(50);
    usePrefs.getState().setFilters({ budgetMaxKrw: 400_000_000 }); // 첫 저장(3억)이 끝나기 전에 4억으로 변경
    db.releaseUpsert!();
    await p;
    await tick(50);
    expect(store["moahome.pending.v2:A"]).toContain("400000000"); // 4억은 아직 저장 전이라 복구 사본이 남는다
    await tick(1200); // 자동 저장이 4억을 저장
    expect((db.serverRows["A"] as { budget_max_krw: number }).budget_max_krw).toBe(400_000_000);
    expect(store["moahome.pending.v2:A"]).toBeUndefined();
  });

  it("다른 계정의 복구 사본은 B가 충돌창을 열거나 저장해도 덮이지 않는다(계정별 키)", async () => {
    store["moahome.pending.v2:A"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 300_000_000 } });
    store["moahome.prefs.v1"] = JSON.stringify({ filters: { budgetMaxKrw: 900_000_000 }, tab: "open", sort: "latest" });
    db.serverRows["B"] = serverRow("B", 700_000_000);
    const { onUserChanged, resolveConflict } = await fresh();
    await onUserChanged("B");
    expect(store["moahome.pending.v2:B"]).toContain("900000000");
    expect(store["moahome.pending.v2:A"]).toContain("300000000"); // A의 사본은 그대로
    await resolveConflict("local");
    await tick();
    expect(store["moahome.pending.v2:A"]).toContain("300000000");
  });

  it("같은 계정의 다른 탭이 남긴 더 새로운 복구 사본은 이전 저장 성공이 지우지 않는다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    const { usePrefs, onUserChanged } = await fresh();
    await onUserChanged("A");
    db.holdNextUpsert = true;
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(900); // 저장 요청(3억)이 나간 상태
    store["moahome.pending.v2:A"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 888_000_000 } }); // 다른 탭이 남긴 사본
    db.releaseUpsert!();
    await tick(100);
    expect(store["moahome.pending.v2:A"]).toContain("888000000");
  });
});

describe("계정 동기화: 미저장 초안 모델(재리뷰 #7 보완)", () => {
  it("자동 저장 대기(800ms) 중에도 바뀐 조건이 즉시 초안에 기록되고, 저장이 끝나면 지워진다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    const { usePrefs, onUserChanged } = await fresh();
    await onUserChanged("A");
    expect(store["moahome.pending.v2:A"]).toBeUndefined();
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(50);                                                  // 저장 타이머가 돌기 전에 새로고침해도
    expect(store["moahome.pending.v2:A"]).toContain("300000000");     // 초안에 남아 있다
    await tick(1200);
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 300_000_000 });
    expect(store["moahome.pending.v2:A"]).toBeUndefined();
  });

  it("다른 탭의 더 새로운 초안을 이전 저장의 성공·재변경이 덮어쓰지 않는다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    const { usePrefs, onUserChanged } = await fresh();
    await onUserChanged("A");
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(900);
    db.holdNextUpsert = true;
    usePrefs.getState().setFilters({ budgetMaxKrw: 310_000_000 });
    await tick(900);                                                 // 3.1억 저장 요청이 나간 상태
    store["moahome.pending.v2:A"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 888_000_000 } }); // 다른 탭의 초안
    db.releaseUpsert!();
    await tick(100);
    expect(store["moahome.pending.v2:A"]).toContain("888000000");
  });

  it("이전 버전의 단일 복구 키(v1)도 같은 계정이면 복구하고 정리한다", async () => {
    db.serverRows["A"] = serverRow("A", 500_000_000);
    store["moahome.pending.v1"] = JSON.stringify({ userId: "A", filters: { budgetMaxKrw: 300_000_000 } });
    const { usePrefs, onUserChanged, resolveConflict } = await fresh();
    await onUserChanged("A");
    expect(usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 300_000_000 } });
    await resolveConflict("server");
    expect(store["moahome.pending.v1"]).toBeUndefined();
    expect(store["moahome.pending.v2:A"]).toBeUndefined();
  });
});

describe("저장 RPC 계약: 충돌·멱등 재시도·오류 매핑", () => {
  it("응답이 오지 않았지만 서버에는 반영된 저장을 같은 request ID로 재시도하면 한 번만 반영된다", async () => {
    const { usePrefs, onUserChanged, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.applyThenHang = true;                                    // 서버는 반영했지만 응답이 유실된다
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(1200);
    expect(db.upserts).toHaveLength(1);                         // 이중 반영 없음
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.rpcCalls[0]!.id).toBe(db.rpcCalls[1]!.id);
    expect((db.serverRows["A"] as { revision: number }).revision).toBe(2);
    expect(usePrefs.getState().saveStatus).toBe("saved");
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(1200);
    expect((db.serverRows["A"] as { revision: number; budget_max_krw: number })).toMatchObject({ revision: 3, budget_max_krw: 300_000_000 });   // 재생 뒤 revision 기준이 맞다
  });

  it("시간 초과와 재조회 실패가 겹치면 load-error로 알리고, 복구되면 같은 request ID로 마무리한 뒤 그사이 바뀐 조건도 저장한다", async () => {
    const { usePrefs, onUserChanged, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.applyThenHang = true;
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(850);                                            // 요청이 나가 응답 없이 시간 초과되는 중
    db.failGet = true;                                          // 재조회도 실패
    await tick(500);
    expect(usePrefs.getState().saveStatus).toBe("load-error");
    expect(store["moahome.pending.v2:A"]).toContain("200000000"); // 초안은 유지
    db.failGet = false;
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 }); // 사용자가 그사이 더 바꿈 -> 다음 저장 시도
    await tick(1500);
    expect(db.rpcCalls[1]!.id).toBe(db.rpcCalls[0]!.id);        // 이전 요청을 같은 ID로 재확인
    expect(db.upserts.map((u) => (u as unknown as { budget_max_krw: number }).budget_max_krw)).toEqual([200_000_000, 300_000_000]);
    expect((db.serverRows["A"] as { revision: number })).toMatchObject({ revision: 3 });
    expect(usePrefs.getState().saveStatus).toBe("saved");
  });

  it("네트워크 오류(코드 없음)도 결과를 모르는 것으로 보고 같은 request ID로 재확인한다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.failUpsert = "network";
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(1200);
    expect(db.rpcCalls.length).toBe(2);
    expect(db.rpcCalls[0]!.id).toBe(db.rpcCalls[1]!.id);
    expect(usePrefs.getState().saveStatus).toBe("error");
    db.failUpsert = false;
    usePrefs.getState().setFilters({ budgetMaxKrw: 300_000_000 });
    await tick(1200);
    expect(usePrefs.getState().saveStatus).toBe("saved");
  });

  it("다른 기기가 먼저 저장해 서버 revision이 앞서면 충돌 선택창으로 넘기고 초안을 유지한다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");                                   // revision 1을 읽음
    db.serverRows["A"] = { ...serverRow("A", 700_000_000), revision: 4 };   // 다른 기기가 저장(revision 4)
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(1200);
    const s = usePrefs.getState();
    expect(s.conflict).toMatchObject({ local: { budgetMaxKrw: 200_000_000 }, server: { budgetMaxKrw: 700_000_000 } });
    expect(s.filters.budgetMaxKrw).toBe(200_000_000);           // 화면의 조건은 선택 전까지 유지
    expect(store["moahome.pending.v2:A"]).toContain("200000000"); // 초안 유지
    expect(db.upserts).toHaveLength(0);
    expect(s.saveStatus).toBe("idle");
  });

  it("충돌 선택창에서 내 조건을 고르면 최신 revision으로 새 요청을 보내 저장한다", async () => {
    const { usePrefs, onUserChanged, resolveConflict } = await fresh();
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.serverRows["A"] = { ...serverRow("A", 700_000_000), revision: 4 };
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(1200);
    const firstId = db.rpcCalls[0]!.id;
    await resolveConflict("local");
    await tick();
    expect(db.rpcCalls.at(-1)!.exp).toBe(4);                    // 충돌 응답의 현재 revision
    expect(db.rpcCalls.at(-1)!.id).not.toBe(firstId);           // 새 시도는 새 request ID
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 200_000_000, revision: 5 });
    expect(usePrefs.getState().saveStatus).toBe("saved");
    expect(usePrefs.getState().conflict).toBeNull();
  });

  it("충돌 선택창에서 서버 조건을 고르면 서버 값을 적용하고 초안을 지운다", async () => {
    const { usePrefs, onUserChanged, resolveConflict } = await fresh();
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.serverRows["A"] = { ...serverRow("A", 700_000_000), revision: 4 };
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(1200);
    await resolveConflict("server");
    expect(usePrefs.getState().filters.budgetMaxKrw).toBe(700_000_000);
    expect(store["moahome.pending.v2:A"]).toBeUndefined();
    expect(db.upserts).toHaveLength(0);
    usePrefs.getState().setFilters({ budgetMaxKrw: 710_000_000 });  // 이후 저장은 서버 revision(4) 기준
    await tick(1200);
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 710_000_000, revision: 5 });
  });

  it("충돌이어도 서버 값이 내 조건과 같으면 선택창 없이 저장 완료로 본다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.serverRows["A"] = { ...serverRow("A", 200_000_000), revision: 3 };   // 다른 기기가 같은 값을 먼저 저장
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(1200);
    expect(usePrefs.getState().conflict).toBeNull();
    expect(usePrefs.getState().saveStatus).toBe("saved");
    usePrefs.getState().setFilters({ budgetMaxKrw: 250_000_000 });
    await tick(1200);
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 250_000_000, revision: 4 });   // 기준 revision이 서버(3)로 갱신됐다
  });

  it.each([
    ["22023", "invalid"], ["22003", "invalid"], ["23514", "invalid"],
    ["28000", "error"], ["42501", "error"], ["XX000", "error"],
  ])("서버 오류 %s는 %s로 표시하고 초안을 유지하며 같은 request ID로 재시도하지 않는다", async (code, status) => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.failUpsert = code;
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(1200);
    expect(usePrefs.getState().saveStatus).toBe(status);
    expect(db.rpcCalls).toHaveLength(1);                        // 서버가 판단한 결과라 재시도하지 않는다
    expect(store["moahome.pending.v2:A"]).toContain("200000000");
    db.failUpsert = false;
    await (await import("@/store/account")).retrySave();       // '다시 저장'은 새 request ID
    await tick();
    expect(db.rpcCalls[1]!.id).not.toBe(db.rpcCalls[0]!.id);
    expect(usePrefs.getState().saveStatus).toBe("saved");
  });

  it("금액은 정밀도를 잃지 않도록 십진 문자열로 보낸다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    await onUserChanged("A");                                   // 서버 행 없음
    usePrefs.getState().setFilters({ budgetMaxKrw: 9_007_199_254_740_991 });
    await tick(1200);
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 9_007_199_254_740_991, revision: 1 });
  });
});

describe("저장 RPC: 재리뷰 #1 보완", () => {
  it("충돌 선택창이 열리면 대기 중이던 자동 저장은 서버 값을 덮어쓰지 않는다", async () => {
    const { usePrefs, onUserChanged } = await fresh();
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.serverRows["A"] = { ...serverRow("A", 700_000_000), revision: 4 };   // 다른 기기가 앞서 저장
    db.holdNextUpsert = true;                                    // 첫 저장(충돌이 날)을 붙잡는다
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(900);
    usePrefs.getState().setFilters({ budgetMaxKrw: 210_000_000 }); // 첫 저장이 끝나기 전에 또 바꿔 두 번째 자동 저장이 대기
    await tick(900);
    db.releaseUpsert!();                                         // 첫 저장이 충돌로 끝난다
    await tick(300);
    expect(usePrefs.getState().conflict).not.toBeNull();
    expect(db.rpcCalls).toHaveLength(1);                         // 대기 중이던 저장은 보내지 않았다
    expect(db.upserts).toHaveLength(0);
    expect((db.serverRows["A"] as { budget_max_krw: number }).budget_max_krw).toBe(700_000_000);   // 서버 값은 그대로
  });

  it("재생된 내 요청 뒤에 다른 기기가 더 새로 저장했다면 그 값을 덮어쓰지 않고 선택하게 한다", async () => {
    const { usePrefs, onUserChanged, resolveConflict, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.applyThenHang = true;                                     // 내 저장은 revision 2로 반영되지만 응답이 유실된다
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(880);                                             // 요청이 나가 반영된 상태(시간 초과 직전)
    db.serverRows["A"] = { ...serverRow("A", 700_000_000), revision: 3 };   // 다른 기기가 revision 3으로 저장
    await tick(600);                                             // 시간 초과 -> 재조회 -> 같은 ID 재시도(재생)
    expect(db.rpcCalls[1]!.id).toBe(db.rpcCalls[0]!.id);
    expect(usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 200_000_000 }, server: { budgetMaxKrw: 700_000_000 } });
    usePrefs.getState().setFilters({ budgetMaxKrw: 210_000_000 });  // 선택 전에 또 바꿔도 덮어쓰지 않는다
    await tick(1000);
    expect((db.serverRows["A"] as { budget_max_krw: number }).budget_max_krw).toBe(700_000_000);
    await resolveConflict("local");                              // 내 조건(충돌 시점의 조건)을 고르면 revision 3 기준으로 저장
    await tick();
    expect(db.upserts.at(-1)).toMatchObject({ budget_max_krw: 200_000_000, revision: 4 });
  });

  it("load-error의 '다시 불러오기'는 결과를 모르는 요청을 같은 request ID로 먼저 확인한다", async () => {
    const { usePrefs, onUserChanged, retryAccountSync, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.applyThenHang = true;                                     // 서버에는 반영(revision 2), 응답은 유실
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(850);
    db.failGet = true;                                           // 재조회도 실패
    await tick(500);
    expect(usePrefs.getState().saveStatus).toBe("load-error");
    const firstId = db.rpcCalls[0]!.id;
    db.failGet = false;
    await retryAccountSync();                                    // '다시 불러오기'
    await tick(300);
    expect(db.rpcCalls.at(-1)!.id).toBe(firstId);                // 같은 ID로 확인했다
    expect(db.upserts).toHaveLength(1);                          // 이중 반영 없음
    expect(usePrefs.getState().conflict).toBeNull();
    expect(usePrefs.getState().filters.budgetMaxKrw).toBe(200_000_000);
    expect(usePrefs.getState().saveStatus).toBe("idle");          // 재동기화가 끝나 오류 표시가 없다
  });

  it("'다시 불러오기'에서도 재조회가 계속 실패하면 요청 ID를 유지한 채 load-error로 남는다", async () => {
    const { usePrefs, onUserChanged, retryAccountSync, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.applyThenHang = true;
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(850);
    db.failGet = true;
    await tick(500);
    await retryAccountSync();                                    // 여전히 재조회 실패
    expect(usePrefs.getState().saveStatus).toBe("load-error");
    db.failGet = false;
    await retryAccountSync();                                    // 복구 뒤에는 같은 ID로 확인하고 동기화한다
    await tick(300);
    expect(db.rpcCalls.every((c) => c.id === db.rpcCalls[0]!.id)).toBe(true);
    expect(db.upserts).toHaveLength(1);
    expect(usePrefs.getState().saveStatus).toBe("idle");
  });
});

describe("저장 RPC: 재리뷰 #2 보완", () => {
  it("재조회와 재생 사이에 다른 기기가 또 저장해도 선택창은 재생 직후의 최신 서버 값을 보여준다", async () => {
    const { usePrefs, onUserChanged, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.applyThenHang = true;                                     // 내 저장: revision 2로 반영, 응답 유실
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(880);
    db.serverRows["A"] = { ...serverRow("A", 700_000_000), revision: 3 };   // 재조회가 읽을 값(revision 3)
    db.beforeApply = (n) => {                                    // 재생(2번째 호출)이 처리되기 직전에 다른 기기가 revision 4를 저장
      if (n === 2) db.serverRows["A"] = { ...serverRow("A", 800_000_000), revision: 4 };
    };
    await tick(700);
    expect(usePrefs.getState().conflict).toMatchObject({ local: { budgetMaxKrw: 200_000_000 }, server: { budgetMaxKrw: 800_000_000 } });   // 3억이 아니라 최신(4)
  });

  it("'다시 불러오기'의 확인이 계속 불확실하면 재동기화하지 않고 요청 ID를 유지하며, 이후 '다시 저장'이 같은 ID로 마무리한다", async () => {
    const { usePrefs, onUserChanged, retryAccountSync, retrySave, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 100_000_000);
    await onUserChanged("A");
    db.applyThenHang = true;
    usePrefs.getState().setFilters({ budgetMaxKrw: 200_000_000 });
    await tick(850);
    db.failGet = true;
    await tick(500);                                             // load-error
    db.failGet = false;
    db.failUpsert = "network";                                   // 확인 요청이 계속 불확실
    await retryAccountSync();
    expect(usePrefs.getState().saveStatus).toBe("error");
    expect(usePrefs.getState().filters.budgetMaxKrw).toBe(200_000_000);   // 서버 값(2억은 이미 반영됐지만 모르는 상태)으로 덮지 않는다
    expect(store["moahome.pending.v2:A"]).toContain("200000000");
    db.failUpsert = false;
    await retrySave();                                           // 서버가 복구된 뒤 같은 ID로 마무리
    await tick(100);
    expect(db.rpcCalls.every((c) => c.id === db.rpcCalls[0]!.id)).toBe(true);
    expect(db.upserts).toHaveLength(1);
    expect(usePrefs.getState().saveStatus).toBe("saved");
  });

  it("'다시 불러오기'의 확인이 서버 거절로 끝나면 서버 값으로 덮지 않고 초안을 유지한다(전부 지운 초안 포함)", async () => {
    const { usePrefs, onUserChanged, retryAccountSync, setSaveTimeoutForTests } = await fresh();
    setSaveTimeoutForTests(150);
    db.serverRows["A"] = serverRow("A", 500_000_000);
    await onUserChanged("A");
    db.applyThenHang = true;
    usePrefs.getState().setFilters({ budgetMaxKrw: null });      // 조건을 전부 지움(기본 조건)
    await tick(850);
    db.failGet = true;
    await tick(500);                                             // load-error
    db.failGet = false;
    db.serverRows["A"] = serverRow("A", 500_000_000);            // 서버는 아직 이전 값(요청이 반영되지 않은 상황)
    db.failUpsert = "XX000";                                     // 확인 요청을 서버가 거절
    await retryAccountSync();
    expect(usePrefs.getState().saveStatus).toBe("error");
    expect(usePrefs.getState().filters.budgetMaxKrw).toBeNull();   // 서버의 5억으로 되돌리지 않는다
    expect(store["moahome.pending.v2:A"]).toBeDefined();
  });
});

// 타입 확인용(사용하지 않음): Filters 형태가 바뀌면 컴파일 단계에서 알 수 있게 한다
const _shape: Pick<Filters, "budgetMaxKrw"> = { budgetMaxKrw: null };
void _shape;
