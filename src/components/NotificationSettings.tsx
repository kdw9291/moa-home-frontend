"use client";
import { useCallback, useEffect, useState } from "react";
import { pushAvailability, readPushEnv, type PushAvailability } from "@/lib/push";
import { countMyDevices, disablePush, enablePush, getDeviceSubscription } from "@/lib/pushClient";
import { useSession } from "@/store/session";
import { Notice } from "./ui";

/** 접수일 알림 설정. 권한 요청은 '알림 켜기' 클릭에서만 일어난다. */
export function NotificationSettings() {
  const user = useSession((s) => s.user);
  const [avail, setAvail] = useState<PushAvailability | null>(null);
  const [thisDevice, setThisDevice] = useState(false);
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const a = pushAvailability(readPushEnv());
    setAvail(a);
    if (a.state === "ready" || a.state === "denied") setThisDevice(!!(await getDeviceSubscription().catch(() => null)));
    setDevices(await countMyDevices().catch(() => 0));
  }, []);

  const pushEpoch = useSession((s) => s.pushEpoch);
  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh, pushEpoch]); // 로그아웃 시도가 구독을 해제했다면(로그아웃 실패 포함) 상태를 다시 읽는다

  if (!user || !avail) return null;

  return (
    <section className="rounded-xl border border-line bg-white p-4" aria-labelledby="notif-title">
      <h2 id="notif-title" className="text-base font-bold">접수일 알림</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        관심 공고의 접수가 시작되는 날(한국 날짜) 이 기기로 알림을 보냅니다. 배치 실행 시각에 따라 늦거나 도착하지 않을 수 있으니 공식 공고와 이 화면의 일정을 함께 확인하세요. 알림은 청약 자격을 판단하지 않습니다.
      </p>
      <div className="mt-3 space-y-2 text-sm">
        {avail.state === "not-configured" && <Notice tone="warn">알림 설정(VAPID 공개 키)이 없어 사용할 수 없습니다.</Notice>}
        {avail.state === "unsupported" && <Notice tone="warn">이 브라우저는 웹 알림을 지원하지 않습니다. 알림 없이도 관심 공고 화면에서 일정을 확인할 수 있습니다.</Notice>}
        {avail.state === "ios-install" && (
          <Notice tone="warn">
            iPhone·iPad(iOS 16.4 이상)에서는 홈 화면에 추가한 앱에서만 알림을 켤 수 있습니다. Safari의 공유 버튼 → &lsquo;홈 화면에 추가&rsquo; 후 그 아이콘으로 다시 열어 주세요.
          </Notice>
        )}
        {avail.state === "denied" && <Notice tone="warn">브라우저에서 알림이 차단되어 있습니다. 주소창의 사이트 설정에서 알림을 허용한 뒤 다시 시도하세요. 그 전까지는 관심 공고 화면에서 일정을 확인하세요.</Notice>}
        {avail.state === "ready" && (
          <div className="flex flex-wrap items-center gap-3">
            {thisDevice ? (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await disablePush().catch(() => ({ browser: false, server: false }));
                  setMessage(
                    !r.browser
                      ? "이 기기의 알림을 끄지 못했습니다. 브라우저 설정에서 이 사이트의 알림을 꺼 주세요."
                      : r.server
                        ? "이 기기의 알림을 껐습니다."
                        : "이 기기의 알림 수신은 껐습니다. 서버 기록 정리는 다음 발송 때 자동으로 처리됩니다.",
                  );
                  await refresh();
                  setBusy(false);
                }}
                className="rounded-lg border border-line px-4 py-2 font-semibold"
              >
                이 기기 알림 끄기
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setMessage(null);
                  const r = await enablePush(user.id);
                  setMessage(r.ok ? "이 기기의 알림을 켰습니다." : r.message);
                  await refresh();
                  setBusy(false);
                }}
                className="rounded-lg bg-brand px-4 py-2 font-bold text-white"
              >
                이 기기 알림 켜기
              </button>
            )}
            <span className="text-xs text-muted">{thisDevice ? "이 기기: 켜짐" : "이 기기: 꺼짐"} · 내 알림 기기 {devices}대</span>
          </div>
        )}
        {message && <p role="status" className="text-xs text-brand-dark">{message}</p>}
      </div>
    </section>
  );
}
