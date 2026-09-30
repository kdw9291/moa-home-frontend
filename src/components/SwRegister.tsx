"use client";
import { useEffect } from "react";

/** 프로덕션 빌드에서만 서비스 워커를 등록한다(개발 서버의 핫 리로드와 충돌하지 않게). 권한 요청은 하지 않는다. */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const secure = window.isSecureContext; // https 또는 localhost
    if (!secure) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => reg.update()) // 새 배포가 있으면 새 서비스 워커를 받아 온다(skipWaiting으로 바로 교체)
      .catch(() => undefined); // 등록 실패는 앱 동작에 영향이 없다(오프라인 안내만 빠짐)
  }, []);
  return null;
}
