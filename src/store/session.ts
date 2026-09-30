"use client";
import { create } from "zustand";
import { disablePreviousAccountPush, disablePush, waitForPendingEnables } from "@/lib/pushClient";
import { supabase } from "@/lib/supabase";
import { onUserChanged } from "./account";

// 인증 세션과 회원 북마크. 사용자가 바뀌거나 로그아웃하면 이전 사용자의 북마크·필터 캐시를 즉시 비운다.
interface SessionState {
  ready: boolean; // 인증 상태 확인 완료(로그인/비로그인 판정됨)
  user: { id: string; email: string | null } | null;
  bookmarkIds: Set<string>;
  bookmarksLoaded: boolean;
  pushWarning: boolean; // 계정이 바뀌는 중 이 기기의 이전 계정 푸시 구독을 해제하지 못했다(사용자에게 알림)
  dismissPushWarning: () => void;
  pushEpoch: number; // 이 기기의 푸시 구독을 로그아웃 절차가 바꿨을 때 증가: 알림 설정 화면이 상태를 다시 읽는다
  loginOpen: boolean;
  loginReason: string | null;
  init: () => void;
  openLogin: (reason?: string) => void;
  closeLogin: () => void;
  sendMagicLink: (email: string) => Promise<{ ok: boolean; message: string }>;
  signOut: (force?: boolean) => Promise<string | null>; // 오류 메시지(로그아웃 안 함) 또는 null
  toggleBookmark: (announcementId: string) => Promise<string | null>; // 오류 메시지 또는 null
}

let started = false;
let generation = 0; // 사용자 전환 중 늦게 도착한 응답을 버리기 위한 세대 번호

export const useSession = create<SessionState>((set, get) => {
  async function loadBookmarks(userId: string) {
    const gen = generation;
    const { data, error } = await supabase!.from("user_bookmarks").select("announcement_id");
    if (gen !== generation || get().user?.id !== userId) return; // 그 사이 계정이 바뀜: 결과 폐기
    if (error) return set({ bookmarksLoaded: true });
    set({ bookmarkIds: new Set((data ?? []).map((r: { announcement_id: string }) => r.announcement_id)), bookmarksLoaded: true });
  }

  type AuthSession = { user: { id: string; email?: string | null } } | null;
  let cleanupChain: Promise<void> = Promise.resolve();
  let applyChain: Promise<void> = Promise.resolve(); // 인증 상태 변경 처리를 순서대로 실행한다(푸시 해제를 기다리는 동안 다음 변경이 끼어들지 않게)

  async function applyNow(session: AuthSession) {
    const id = session?.user.id ?? null;
    if (id === (get().user?.id ?? null)) {
      if (!get().ready) set({ ready: true });
      return;
    }
    const prev = get().user?.id ?? null;
    const switched = !!prev && prev !== id;
    generation += 1;
    // 이전 사용자의 데이터 제거 후 새 사용자로 전환
    set({ user: session ? { id: session.user.id, email: session.user.email ?? null } : null, bookmarkIds: new Set(), bookmarksLoaded: false, ready: true, loginOpen: false });
    void onUserChanged(id);
    if (id) void loadBookmarks(id);
    if (switched) cleanupChain = cleanupChain.then(() => cleanupPreviousPush()).catch(() => undefined); // 전환 순서대로 정리한다(applyChain과는 별개)
  }

  async function cleanupPreviousPush() {
    {
      // 세션이 signOut 절차를 거치지 않고 바뀌어도(다른 탭의 로그아웃·계정 교체) 이 기기가 이전 계정의 알림을 계속 받지 않게
      // 한다. 화면의 이전 계정 데이터는 위에서 이미 비웠고, 해제는 시간 제한을 두고 이어서 처리한다. 실패하면 사용자에게 알린다
      // (새 계정 세션 아래에서는 서버의 이전 행을 지울 수 없어 브라우저 구독 해제가 실제로 알림 수신을 멈추는 쪽이다).
      // applyChain 밖에서 실행해 연속 전환이 지연되지 않게 한다. 경고는 켜기만 하고(사용자가 닫을 때까지) 뒤 결과가 덮어 끄지 못한다.
      const limit = new Promise<{ browser: boolean }>((resolve) => setTimeout(() => resolve({ browser: false }), 10_000));
      const r = await Promise.race([disablePreviousAccountPush(() => get().user?.id ?? null).catch(() => ({ browser: false })), limit]);
      set({ pushEpoch: get().pushEpoch + 1, pushWarning: get().pushWarning || !r.browser });
    }
  }

  function apply(session: AuthSession): Promise<void> {
    applyChain = applyChain.then(() => applyNow(session)).catch(() => undefined);
    return applyChain;
  }

  return {
    ready: false,
    user: null,
    bookmarkIds: new Set(),
    bookmarksLoaded: false,
    pushEpoch: 0,
    pushWarning: false,
    dismissPushWarning: () => set({ pushWarning: false }),
    loginOpen: false,
    loginReason: null,
    init: () => {
      if (started) return;
      started = true;
      if (!supabase) return set({ ready: true });
      void supabase.auth.getSession().then(({ data }) => apply(data.session));
      // 콜백 안에서 supabase 호출을 기다리면 교착될 수 있어 다음 틱에서 처리한다
      supabase.auth.onAuthStateChange((_event, session) => setTimeout(() => apply(session), 0));
    },
    openLogin: (reason) => set({ loginOpen: true, loginReason: reason ?? null }),
    closeLogin: () => set({ loginOpen: false, loginReason: null }),
    sendMagicLink: async (email) => {
      if (!supabase) return { ok: false, message: "로그인 설정이 없습니다." };
      const e = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, message: "이메일 형식을 확인해 주세요." };
      const { error } = await supabase.auth.signInWithOtp({ email: e, options: { emailRedirectTo: `${window.location.origin}/` } });
      if (error) return { ok: false, message: error.message.includes("rate") ? "잠시 후 다시 시도해 주세요(메일 발송 횟수 제한)." : "링크를 보내지 못했습니다. 잠시 후 다시 시도해 주세요." };
      return { ok: true, message: "메일로 로그인 링크를 보냈습니다. 이 브라우저에서 링크를 열어 주세요(스팸함도 확인)." };
    },
    signOut: async (force = false) => {
      if (!supabase) return null;
      // 이 기기가 이전 계정의 알림을 계속 받지 않게 먼저 해제한다. 브라우저 구독을 해제하지 못하면
      // (force가 아닌 한) 로그아웃하지 않고 알려서, 다음 사용자가 이전 계정의 알림을 받는 일을 막는다.
      await waitForPendingEnables(8000).catch(() => false); // 켜는 중이던 알림이 로그아웃 뒤에 구독을 남기지 않게 끝나길 기다린다(멈췄으면 시간 제한)
      const r = await disablePush().catch(() => ({ browser: false, server: false }));
      if (!r.browser && !force) {
        return "이 기기의 알림 구독을 해제하지 못해 로그아웃하지 않았습니다. 브라우저 설정에서 이 사이트의 알림을 끄고 다시 시도하세요. 그래도 로그아웃하면 이 기기가 이전 계정의 관심 공고 알림을 계속 받을 수 있습니다(같은 기기를 다른 사람이 쓸 경우 주의).";
      }
      // 인증 서버가 로그아웃을 거부하면 화면만 비회원으로 바꾸지 않는다(새로고침하면 계정이 되살아나므로)
      set({ pushEpoch: get().pushEpoch + 1 }); // 알림 설정 화면이 이 기기의 구독 상태(이미 해제됨)를 다시 읽게 한다
      const { error } = await supabase.auth.signOut();
      if (error) return "로그아웃하지 못했습니다. 이 기기의 알림은 이미 꺼졌으니 필요하면 관심 공고 화면에서 다시 켜 주세요. 네트워크를 확인하고 로그아웃을 다시 시도해 주세요.";
      await apply(null);
      return null;
    },
    toggleBookmark: async (announcementId) => {
      const user = get().user;
      if (!user || !supabase) return "로그인이 필요합니다.";
      const had = get().bookmarkIds.has(announcementId);
      const next = new Set(get().bookmarkIds);
      if (had) next.delete(announcementId);
      else next.add(announcementId);
      set({ bookmarkIds: next }); // 낙관적 반영
      const gen = generation;
      const q = had
        ? supabase.from("user_bookmarks").delete().eq("user_id", user.id).eq("announcement_id", announcementId)
        : supabase.from("user_bookmarks").upsert({ user_id: user.id, announcement_id: announcementId }, { onConflict: "user_id,announcement_id" });
      const { error } = await q;
      if (error && gen === generation) {
        const back = new Set(get().bookmarkIds); // 실패: 되돌린다
        if (had) back.add(announcementId);
        else back.delete(announcementId);
        set({ bookmarkIds: back });
        return "북마크를 저장하지 못했습니다. 다시 시도해 주세요.";
      }
      return null;
    },
  };
});
