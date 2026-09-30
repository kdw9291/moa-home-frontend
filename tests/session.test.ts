import { beforeEach, describe, expect, it, vi } from "vitest";

// 가짜 Supabase: 실제 로그인(이메일 링크)은 자동화할 수 없으므로 인증 상태 전환 로직을 시뮬레이션한다.
type Res = { data: unknown; error: { message: string } | null };
const state = {
  authListener: null as null | ((event: string, session: unknown) => void),
  session: null as unknown,
  bookmarkResponses: [] as (() => Promise<Res>)[],
  writeError: null as string | null,
  signOutError: null as string | null,
  calls: [] as string[],
};

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: state.session } }),
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        state.authListener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signOut: () => {
        state.calls.push("signOut");
        return Promise.resolve({ error: state.signOutError ? { message: state.signOutError } : null });
      },
      signInWithOtp: () => Promise.resolve({ error: null }),
    },
    from: (table: string) => ({
      select: () => (state.bookmarkResponses.shift() ?? (() => Promise.resolve({ data: [], error: null })))(),
      delete: () => ({ eq: () => ({ eq: () => { state.calls.push(`delete:${table}`); return Promise.resolve({ error: state.writeError ? { message: state.writeError } : null }); } }) }),
      upsert: () => { state.calls.push(`upsert:${table}`); return Promise.resolve({ error: state.writeError ? { message: state.writeError } : null }); },
    }),
  },
}));
const pushResult = { browser: true, server: true };
const pushDelay = { ms: 0 };
vi.mock("@/lib/pushClient", () => ({ disablePush: () => { state.calls.push("disablePush"); return new Promise((r) => setTimeout(() => r({ ...pushResult }), pushDelay.ms)); } }));
const onUserChanged = vi.fn((_id: string | null) => Promise.resolve());
vi.mock("@/store/account", () => ({ onUserChanged: (id: string | null) => onUserChanged(id) }));

const sess = (id: string, email = `${id}@example.com`) => ({ user: { id, email } });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function fresh() {
  vi.resetModules();
  const mod = await import("@/store/session");
  return mod.useSession;
}

beforeEach(() => {
  pushResult.browser = true;
  pushDelay.ms = 0;
  pushResult.server = true;
  state.authListener = null;
  state.session = null;
  state.bookmarkResponses = [];
  state.writeError = null;
  state.signOutError = null;
  state.calls = [];
  onUserChanged.mockClear();
});

describe("세션과 북마크", () => {
  it("비로그인으로 시작하면 ready가 되고 북마크 시도는 로그인 안내를 돌려준다", async () => {
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    expect(useSession.getState()).toMatchObject({ ready: true, user: null });
    expect(await useSession.getState().toggleBookmark("a1")).toContain("로그인");
    expect(state.calls).toEqual([]); // 서버 호출 없음
  });

  it("기존 세션이 있으면 사용자와 북마크를 불러온다", async () => {
    state.session = sess("A");
    state.bookmarkResponses = [() => Promise.resolve({ data: [{ announcement_id: "x1" }, { announcement_id: "x2" }], error: null })];
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    const s = useSession.getState();
    expect(s.user?.id).toBe("A");
    expect([...s.bookmarkIds].sort()).toEqual(["x1", "x2"]);
    expect(onUserChanged).toHaveBeenCalledWith("A");
  });

  it("계정 전환 시 이전 사용자의 북마크를 즉시 비우고 늦게 도착한 이전 응답은 버린다", async () => {
    state.session = sess("A");
    let releaseA!: (r: Res) => void;
    state.bookmarkResponses = [
      () => new Promise<Res>((res) => (releaseA = res)), // A의 응답은 늦게 도착
      () => Promise.resolve({ data: [{ announcement_id: "b-only" }], error: null }),
    ];
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    state.authListener!("SIGNED_IN", sess("B")); // 계정 B로 전환
    await tick();
    expect(useSession.getState().user?.id).toBe("B");
    expect([...useSession.getState().bookmarkIds]).toEqual(["b-only"]);
    releaseA({ data: [{ announcement_id: "a-secret" }], error: null }); // 이제야 A의 응답 도착
    await tick();
    expect([...useSession.getState().bookmarkIds]).toEqual(["b-only"]); // A의 북마크가 B에게 섞이지 않는다
  });

  it("로그아웃하면 푸시 구독을 먼저 해제하고 북마크·사용자를 비운다", async () => {
    state.session = sess("A");
    state.bookmarkResponses = [() => Promise.resolve({ data: [{ announcement_id: "x1" }], error: null })];
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    await useSession.getState().signOut();
    expect(state.calls.slice(0, 2)).toEqual(["disablePush", "signOut"]); // 해제 -> 로그아웃 순서
    expect(useSession.getState()).toMatchObject({ user: null });
    expect(useSession.getState().bookmarkIds.size).toBe(0);
    expect(onUserChanged).toHaveBeenLastCalledWith(null);
  });

  it("signOut 절차 없이 세션이 다른 계정으로 바뀌어도 이 기기의 이전 계정 푸시 구독을 해제한다", async () => {
    state.session = sess("A");
    state.bookmarkResponses = [() => Promise.resolve({ data: [{ announcement_id: "x1" }], error: null }), () => Promise.resolve({ data: [], error: null })];
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    expect(state.calls).not.toContain("disablePush");
    state.authListener!("SIGNED_IN", sess("B"));        // 다른 탭의 계정 교체 등
    await tick();
    expect(state.calls).toContain("disablePush");
    expect(useSession.getState().pushEpoch).toBeGreaterThan(0);
    expect(useSession.getState().user?.id).toBe("B");
  });

  it("브라우저 구독을 해제하지 못하면 로그아웃하지 않고 알린다(강제 시에만 로그아웃)", async () => {
    state.session = sess("A");
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    pushResult.browser = false;
    const msg = await useSession.getState().signOut();
    expect(msg).toContain("로그아웃하지 않았습니다");
    expect(state.calls).not.toContain("signOut");
    expect(useSession.getState().user?.id).toBe("A"); // 그대로 로그인 상태
    expect(await useSession.getState().signOut(true)).toBeNull();
    expect(state.calls).toContain("signOut");
    expect(useSession.getState().user).toBeNull();
  });

  it("인증 서버가 로그아웃을 거부하면 화면만 비회원으로 바꾸지 않는다", async () => {
    state.session = sess("A");
    state.bookmarkResponses = [() => Promise.resolve({ data: [{ announcement_id: "x1" }], error: null })];
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    state.signOutError = "network";
    const msg = await useSession.getState().signOut();
    expect(msg).toContain("로그아웃하지 못했습니다");
    expect(msg).toContain("알림은 이미 꺼졌"); // 푸시가 이미 해제됐음을 숨기지 않는다
    expect(useSession.getState().pushEpoch).toBe(1); // 알림 설정 화면이 상태를 다시 읽는다
    expect(useSession.getState().user?.id).toBe("A"); // 그대로 로그인 상태
    expect(useSession.getState().bookmarkIds.has("x1")).toBe(true);
    expect(onUserChanged).not.toHaveBeenCalledWith(null);
  });

  it("브라우저·서버 해제가 모두 실패한 경우 안내가 이전 계정 알림이 남을 수 있음을 밝힌다", async () => {
    state.session = sess("A");
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    pushResult.browser = false;
    pushResult.server = false;
    const msg = await useSession.getState().signOut();
    expect(msg).toContain("이전 계정의 관심 공고 알림을 계속 받을 수 있습니다");
    expect(state.calls).not.toContain("signOut");
  });

  it("서버 구독 행 삭제만 실패해도 브라우저 구독이 해제됐으면 로그아웃한다", async () => {
    state.session = sess("A");
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    pushResult.server = false;
    expect(await useSession.getState().signOut()).toBeNull();
    expect(state.calls).toContain("signOut");
  });

  it("북마크 추가·삭제는 즉시 반영되고 실패하면 되돌린다", async () => {
    state.session = sess("A");
    const useSession = await fresh();
    useSession.getState().init();
    await tick();
    expect(await useSession.getState().toggleBookmark("n1")).toBeNull();
    expect(useSession.getState().bookmarkIds.has("n1")).toBe(true);
    expect(await useSession.getState().toggleBookmark("n1")).toBeNull();
    expect(useSession.getState().bookmarkIds.has("n1")).toBe(false);
    state.writeError = "boom";
    const err = await useSession.getState().toggleBookmark("n2");
    expect(err).toContain("저장하지 못했습니다");
    expect(useSession.getState().bookmarkIds.has("n2")).toBe(false); // 롤백
  });

  it("이메일 형식이 잘못되면 링크를 보내지 않는다", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
    const useSession = await fresh();
    expect((await useSession.getState().sendMagicLink("not-an-email")).ok).toBe(false);
    expect((await useSession.getState().sendMagicLink("me@example.com")).ok).toBe(true);
  });

  it("푸시 해제 응답이 늦어도 이전 계정의 화면 데이터는 즉시 비워진다", async () => {
    const useSession = await fresh();
    state.session = sess("A");
    useSession.getState().init();
    await tick();
    expect(useSession.getState().user?.id).toBe("A");
    pushDelay.ms = 200;
    state.authListener!("SIGNED_IN", sess("B"));
    await tick(30);                                              // 해제는 아직 끝나지 않음
    expect(useSession.getState().user?.id).toBe("B");
    expect(useSession.getState().bookmarkIds.size).toBe(0);
    await tick(250);
    expect(useSession.getState().pushWarning).toBe(false);
  });

  it("다른 탭 로그아웃으로 비로그인이 돼도 푸시 해제에 실패하면 경고 상태가 켜진다", async () => {
    const useSession = await fresh();
    state.session = sess("A");
    useSession.getState().init();
    await tick();
    pushResult.browser = false;
    state.authListener!("SIGNED_OUT", null);
    await tick(60);
    expect(useSession.getState()).toMatchObject({ user: null, pushWarning: true });
  });
});
