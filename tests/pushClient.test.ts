import { beforeEach, describe, expect, it, vi } from "vitest";

// 새 계정의 알림 켜기와 이전 계정 정리가 겹칠 때: 켜기가 성공하면 새 구독을 지우지 않고, 실패하면 남은 이전 구독을 지운다.
type Sub = { endpoint: string; unsubscribe: () => Promise<boolean>; toJSON: () => unknown };
const st = {
  subscription: null as Sub | null,
  upsertError: null as null | { message: string },
  hold: false,
  release: (() => {}) as () => void,
};

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      upsert: () =>
        new Promise((res) => {
          const done = () => res({ error: st.upsertError });
          if (st.hold) st.release = done;
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
  st.release = () => {};
  st.subscription = mkSub("old-A");
  const reg = {
    pushManager: {
      getSubscription: () => Promise.resolve(st.subscription),
      subscribe: () => {
        st.subscription = mkSub("new-B");
        return Promise.resolve(st.subscription);
      },
    },
  };
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration: () => Promise.resolve(reg), register: () => Promise.resolve(reg), ready: Promise.resolve(reg) } });
  vi.stubGlobal("Notification", { requestPermission: () => Promise.resolve("granted") });
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
    const cleanup = push.disablePreviousAccountPush();
    await wait();
    st.release(); // 등록 성공
    expect((await enabling).ok).toBe(true);
    expect((await cleanup).browser).toBe(true);
    expect(st.subscription?.endpoint).toBe("new-B"); // 새 구독 유지
  });

  it("새 계정 켜기가 실패하면 남아 있는 이전 구독을 지운다", async () => {
    const push = await fresh();
    st.hold = true;
    st.upsertError = { message: "boom" };
    const enabling = push.enablePush("B");
    await wait();
    const cleanup = push.disablePreviousAccountPush();
    await wait();
    st.release(); // 등록 실패 -> 새 구독도 해제됨
    expect((await enabling).ok).toBe(false);
    st.subscription = mkSub("old-A"); // 실패 뒤에도 이전 구독이 남아 있는 상황
    expect((await cleanup).browser).toBe(true);
    expect(st.subscription).toBeNull(); // 이전 구독 정리됨
  });

  it("켜기가 진행 중이 아니면 바로 해제한다", async () => {
    const push = await fresh();
    expect((await push.disablePreviousAccountPush()).browser).toBe(true);
    expect(st.subscription).toBeNull();
  });
});
