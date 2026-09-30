// 브라우저 푸시 구독 관리. 권한 요청은 반드시 사용자 클릭에서 호출한 함수(enablePush)에서만 일어난다.
// 서비스 워커(/sw.js)는 fetch를 가로채지 않고 인증 응답·북마크·구독을 캐시하지 않는다.
import { supabase } from "./supabase";
import { urlBase64ToBytes } from "./push";

const VAPID = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export async function getDeviceSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export type EnableResult = { ok: true } | { ok: false; reason: "denied" | "dismissed" | "error"; message: string };

/** 사용자 클릭 뒤 호출. 기존 이 기기 구독은 지우고 새로 만들어 다른 계정에 묶인 endpoint 충돌을 피한다. */
let enableCount = 0; // enablePush 시작 횟수
let enableInFlight = 0; // 진행 중인 enablePush 수: 이전 계정 정리 작업이 새 계정의 켜기와 겹치지 않게 하는 표지

const enablePending = new Set<Promise<unknown>>();
let subOwner: string | null = null; // 이 기기의 현재 브라우저 구독이 묶인 계정(켜기 성공 때 기록, 해제 때 비움)

export async function enablePush(userId: string): Promise<EnableResult> {
  enableCount += 1;
  enableInFlight += 1;
  const run = enablePushInner(userId);
  const tracked: Promise<unknown> = run.then(
    (r) => { if (r.ok) subOwner = userId; },
    () => undefined,
  ).finally(() => enablePending.delete(tracked));
  enablePending.add(tracked);
  try {
    return await run;
  } finally {
    enableInFlight -= 1;
  }
}

/**
 * 계정 전환 뒤 이전 계정의 알림 정리. 새 계정이 알림을 켜는 중이면 그 구독을 지우지 않도록 기다렸다가,
 * 켜기가 성공했으면 새 계정의 구독이므로 그대로 두고, 실패했으면 남아 있는 이전 구독을 지운다.
 */
export async function disablePreviousAccountPush(currentUserId: () => string | null = () => null): Promise<DisableResult> {
  const first = await disablePush({ skipIfReenabled: true });
  if (!first.skipped) return first;
  while (enablePending.size > 0) await Promise.allSettled([...enablePending]); // 기다리는 동안 새로 시작된 켜기도 끝까지 기다린다
  // 구독이 지금 세션의 계정에 묶여 있으면 그대로 둔다. 다른 계정(이전 계정 포함)의 구독이면 해제한다.
  if (subOwner !== null && subOwner === currentUserId()) return { browser: true, server: true };
  return disablePush();
}

async function enablePushInner(userId: string): Promise<EnableResult> {
  if (!supabase) return { ok: false, reason: "error", message: "설정이 없어 알림을 켤 수 없습니다." };
  try {
    const permission = await Notification.requestPermission();
    if (permission === "denied") return { ok: false, reason: "denied", message: "브라우저에서 알림이 차단되어 있습니다. 브라우저 설정에서 허용한 뒤 다시 시도하세요." };
    if (permission !== "granted") return { ok: false, reason: "dismissed", message: "알림 허용을 선택하지 않아 켜지 않았습니다." };
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(VAPID) });
    const j = sub.toJSON();
    if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) throw new Error("구독 정보가 불완전합니다.");
    const { error } = await supabase
      .from("push_subscriptions")
      .upsert({ user_id: userId, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth_secret: j.keys.auth, enabled: true, updated_at: new Date().toISOString() }, { onConflict: "endpoint" });
    if (error) {
      await sub.unsubscribe();
      const taken = error.code === "42501" || error.code === "23505";
      throw new Error(taken ? "이 기기의 알림이 다른 계정에 연결되어 있습니다. 이전 계정에서 알림을 끄거나 로그아웃한 뒤 다시 시도하세요." : error.message);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : "알림을 켜지 못했습니다." };
  }
}

/** 이 기기의 구독을 서버와 브라우저에서 모두 제거한다. 로그아웃 전에 호출해 다른 계정으로 알림이 새지 않게 한다. */
export interface DisableResult {
  skipped?: boolean; // 새 계정이 알림을 켜는 중이라 해제를 보류했다
  browser: boolean; // 이 기기의 브라우저 구독이 해제됐는가(알림 수신을 실제로 멈추는 쪽)
  server: boolean; // 서버의 구독 행이 삭제됐는가(실패해도 만료 처리로 결국 정리된다)
}

/** skipIfReenabled: 계정 전환 뒤의 정리용. 기다리는 동안 새 계정이 알림을 켰다면 그 구독은 지우지 않는다. */
export async function disablePush(opts: { skipIfReenabled?: boolean } = {}): Promise<DisableResult> {
  const snap = enableCount;
  let sub: PushSubscription | null;
  try {
    sub = await getDeviceSubscription();
  } catch {
    return { browser: false, server: false }; // 구독 상태를 확인하지 못함: 해제됐다고 말하지 않는다
  }
  if (!sub) return { browser: true, server: true };
  if (opts.skipIfReenabled && (enableCount !== snap || enableInFlight > 0)) return { browser: true, server: true, skipped: true }; // 새 계정이 켜는 중이거나 켰다면 그 구독을 지우지 않는다
  // 브라우저 구독을 먼저 해제한다: 이것이 이 기기의 알림 수신을 멈춘다
  const browser = await sub.unsubscribe().catch(() => false);
  if (browser) subOwner = null;
  let server = false;
  try {
    const { error } = (await supabase?.from("push_subscriptions").delete().eq("endpoint", sub.endpoint)) ?? { error: null };
    server = !error;
  } catch {
    server = false;
  }
  return { browser, server };
}

export async function countMyDevices(): Promise<number> {
  if (!supabase) return 0;
  const { count } = await supabase.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("enabled", true);
  return count ?? 0;
}
