// 푸시 알림 사용 가능 여부 판단(순수 함수). 브라우저 환경 값을 인자로 받아 테스트할 수 있게 한다.
// 알림은 사용자가 버튼을 눌렀을 때만 권한을 요청한다. 도착 시각·전달 성공은 보장하지 않는다.
export interface PushEnv {
  userAgent: string;
  maxTouchPoints: number;
  platform: string;
  standalone: boolean; // 홈 화면에 설치된 웹 앱으로 실행 중인지
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: "default" | "granted" | "denied" | "unsupported";
  hasVapidKey: boolean;
}

export type PushAvailability =
  | { state: "ready" } // 켤 수 있음(권한 요청 전 또는 허용됨)
  | { state: "denied" }
  | { state: "ios-install" } // iOS/iPadOS: 홈 화면 설치 후에만 지원(16.4+)
  | { state: "unsupported" }
  | { state: "not-configured" };

export function isIos(env: Pick<PushEnv, "userAgent" | "maxTouchPoints" | "platform">): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (env.platform === "MacIntel" && env.maxTouchPoints > 1); // iPadOS는 Mac으로 보고됨
}

export function pushAvailability(env: PushEnv): PushAvailability {
  if (!env.hasVapidKey) return { state: "not-configured" };
  if (isIos(env) && !env.standalone) return { state: "ios-install" };
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return { state: "unsupported" };
  if (env.permission === "denied") return { state: "denied" };
  return { state: "ready" };
}

export function readPushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    platform: nav.platform ?? "",
    standalone: nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : "unsupported",
    hasVapidKey: !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  };
}

/** base64url 공개 키 -> applicationServerKey 바이트. 형식이 잘못되면 예외. */
export function urlBase64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
