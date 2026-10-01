import { beforeEach, describe, expect, it, vi } from "vitest";

// 새 계정의 알림 켜기와 이전 계정 정리가 겹칠 때: 현재 세션 계정의 구독은 지우지 않고, 다른 계정의 구독은 지운다.
type Sub = { endpoint: string; unsubscribe: () => Promise<boolean>; toJSON: () => unknown };
const st = {
  subscription: null as Sub | null,
  upsertError: null as null | { message: string },
  hold: false,
  releases: [] as (() => void)[],
  n: 0,
  calls: 0, // upsert 호출 번호(1부터)
  failCalls: new Set<number>(), // 이 번호의 upsert는 실패시킨다
  permGate: null as null | Promise<void>, // 권한 요청을 붙잡는다(브라우저 작업이 멈춘 상황)
};
// 붙잡아 둔 서버 등록 응답을 나중에 도착한 요청부터 풀어, 응답 순서와 구독 생성 순서가 어긋나는 상황을 만든다.
const releaseAll = () => {
  const r = [...st.releases].reverse();
  st.releases = [];
  r.forEach((f) => f());
};

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      upsert: () =>
        new Promise((res) => {
          st.calls += 1;
          const no = st.calls;
          const done = () => res({ error: st.upsertError ?? (st.failCalls.has(no) ? { message: "fail" } : null) });
          if (st.hold) st.releases.push(done);
          else done();
        }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  },
}));

function mkSub(endpoint: string): Sub {
  return {
    endpoint,
    unsubscribe: () => {
      if (st.subscription?.endpoint === endpoint) st.subscription = null;
      return Promise.resolve(true);
    },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  st.upsertError = null;
  st.hold = false;
  st.releases = [];
  st.n = 0;
  st.calls = 0;
  st.failCalls = new Set();
  st.permGate = null;
  st.subscription = mkSub("old-A");
  const reg = {
    pushManager: {
      getSubscription: () => Promise.resolve(st.subscription),
      subscribe: () => {
        st.n += 1;
        st.subscription = mkSub(`new-${st.n}`);
        return Promise.resolve(st.subscription);
      },
    },
  };
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration: () => Promise.resolve(reg), register: () => Promise.resolve(reg), ready: Promise.resolve(reg) } });
  vi.stubGlobal("Notification", { requestPermission: () => (st.permGate ?? Promise.resolve()).then(() => "granted") });
});

async function fresh() {
  vi.resetModules();
  return import("@/lib/pushClient");
}

describe("이전 계정 푸시 정리와 새 계정 켜기의 경합", () => {
  it("새 계정 켜기가 성공하면 이전 계정 정리는 새 구독을 지우지 않는다", async () => {
    const push = await fresh();
    st.hold = true; // 새 계정의 서버 등록 응답을 붙잡는다
    const enabling = push.enablePush("B");
    await wait();
    const cleanup = push.disablePreviousAccountPush(() => "B"); // 세션의 현재 계정은 B
    await wait();
    releaseAll(); // 등록 성공
    expect((await enabling).ok).toBe(true);
    expect((await cleanup).browser).toBe(true);
    expect(st.subscription?.endpoint).toBe("new-1"); // 새 구독 유지
  });

  it("새 계정 켜기가 실패하면 남아 있는 이전 구독을 지운다", async () => {
    const push = await fresh();
    st.hold = true;
    st.upsertError = { message: "boom" };
    const enabling = push.enablePush("B");
    await wait();
    const cleanup = push.disablePreviousAccountPush(() => "B");
    await wait();
    releaseAll(); // 등록 실패 -> 새 구독도 해제됨
    expect((await enabling).ok).toBe(false);
    expect((await cleanup).browser).toBe(true); // 켜기 실패 뒤 정리가 끝까지 수행된다
    expect(st.subscription).toBeNull(); // 이전 구독도 새 구독도 남지 않는다
  });

  it("A→B→C 전환에서 B의 켜기가 성공해도 세션이 C이면 B의 구독을 해제한다", async () => {
    const push = await fresh();
    st.hold = true;
    const enabling = push.enablePush("B");
    await wait();
    const cleanupAB = push.disablePreviousAccountPush(() => "C"); // A→B 정리이지만 세션은 이미 C
    const cleanupBC = push.disablePreviousAccountPush(() => "C");
    await wait();
    releaseAll();
    expect((await enabling).ok).toBe(true);
    await Promise.all([cleanupAB, cleanupBC]);
    expect(st.subscription).toBeNull(); // C가 B의 알림을 받지 않는다
  });

  it("C가 알림을 켠 뒤에 도는 뒤늦은 정리는 C의 구독을 지우지 않는다", async () => {
    const push = await fresh();
    expect((await push.enablePush("C")).ok).toBe(true); // 진행 중인 켜기 없음, 구독 소유는 C
    const cleanup1 = push.disablePreviousAccountPush(() => "C");
    const cleanup2 = push.disablePreviousAccountPush(() => "C");
    await Promise.all([cleanup1, cleanup2]);
    expect(st.subscription?.endpoint).toBe("new-1");
  });

  it("동시에 진행된 켜기의 서버 응답 순서가 달라도 마지막으로 만든 구독의 소유 계정을 기준으로 한다", async () => {
    const push = await fresh();
    st.hold = true;
    const enableB = push.enablePush("B"); // B의 구독(new-1)이 먼저 만들어지고 응답은 지연
    await wait();
    const enableA = push.enablePush("A"); // 이어서 A의 구독(new-2)이 만들어진다(현재 브라우저 구독은 A)
    await wait();
    releaseAll(); // 나중 요청(A)의 응답이 먼저, B의 응답이 늦게 도착
    await Promise.all([enableB, enableA]);
    const r = await push.disablePreviousAccountPush(() => "B"); // 세션은 B로 돌아왔다: A의 구독은 해제해야 한다
    expect(r.browser).toBe(true);
    expect(st.subscription).toBeNull();
  });

  it("같은 계정의 이전 켜기가 늦게 실패해도 최신 구독의 소유 기록을 지우지 않는다", async () => {
    const push = await fresh();
    st.hold = true;
    st.failCalls.add(1); // 첫 번째 켜기의 서버 등록만 실패한다
    const first = push.enablePush("B");
    await wait();
    const second = push.enablePush("B"); // 두 번째가 만든 구독(new-2)이 현재 구독
    await wait();
    releaseAll(); // 두 번째 응답(성공)이 먼저, 첫 번째(실패)가 늦게 도착
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
    await push.disablePreviousAccountPush(() => "B"); // 늦은 이전 계정 정리: B의 구독은 유지해야 한다
    expect(st.subscription?.endpoint).toBe("new-2");
  });

  it("멈춘 켜기에 이전 계정 정리가 묶이지 않고 시간 제한 뒤 이전 구독을 해제한다", async () => {
    const push = await fresh();
    st.permGate = new Promise<void>(() => {}); // B의 권한 요청이 끝나지 않는다
    void push.enablePush("B");
    await wait();
    const r = await push.disablePreviousAccountPush(() => "B", 60); // 대기 60ms 뒤 진행
    expect(r.browser).toBe(true);
    expect(st.subscription).toBeNull(); // 이전 계정(A)의 구독이 해제됐다
  });

  it("로그아웃 전 진행 중인 켜기를 기다렸다가 해제하면 구독이 남지 않는다", async () => {
    const push = await fresh();
    st.hold = true;
    const enabling = push.enablePush("A"); // 켜는 중에 로그아웃
    await wait();
    const waited = push.waitForPendingEnables(1000);
    await wait();
    releaseAll();
    expect(await waited).toBe(true); // 켜기 완료를 기다린다
    await enabling;
    expect((await push.disablePush()).browser).toBe(true);
    expect(st.subscription).toBeNull();
  });

  it("권한 요청에 멈춰 있던 켜기가 로그아웃(해제) 뒤에 재개돼도 구독을 만들지 않는다", async () => {
    const push = await fresh();
    let open!: () => void;
    st.permGate = new Promise<void>((r) => { open = r; });
    const enabling = push.enablePush("A");
    await wait();
    expect((await push.disablePush()).browser).toBe(true); // 로그아웃 절차의 해제(대기 시간이 지나 그대로 진행한 경우 포함)
    open(); // 해제 뒤에 권한 응답이 도착
    const r = await enabling;
    expect(r.ok).toBe(false);
    expect(st.subscription).toBeNull(); // 로그아웃한 기기에 구독이 남지 않는다
  });

  it("기기에 구독이 없는 상태에서 한 로그아웃도 멈춰 있던 켜기가 뒤늦게 구독을 만들지 못하게 한다", async () => {
    const push = await fresh();
    st.subscription = null; // 알림이 꺼진 상태에서 켜기를 눌렀다
    let open!: () => void;
    st.permGate = new Promise<void>((r) => { open = r; });
    const enabling = push.enablePush("A");
    await wait();
    expect((await push.disablePush()).browser).toBe(true); // 구독이 없으니 해제할 것은 없지만 진행 중인 켜기는 취소되어야 한다
    open();
    expect((await enabling).ok).toBe(false);
    expect(st.subscription).toBeNull();
  });

  it("서버 등록까지 끝난 켜기도 그 사이 해제가 있었다면 구독과 서버 행을 되돌린다", async () => {
    const push = await fresh();
    st.hold = true;
    const enabling = push.enablePush("A");
    await wait(); // 구독은 만들어졌고 서버 등록 응답만 대기 중
    expect(st.subscription).not.toBeNull();
    await push.disablePush(); // 로그아웃
    releaseAll(); // 등록 성공 응답이 해제 뒤에 도착
    expect((await enabling).ok).toBe(false);
    expect(st.subscription).toBeNull();
  });

  it("켜기가 진행 중이 아니면 바로 해제한다", async () => {
    const push = await fresh();
    expect((await push.disablePreviousAccountPush()).browser).toBe(true);
    expect(st.subscription).toBeNull();
  });
});
