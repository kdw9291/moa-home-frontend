// 모아홈 서비스 워커: 푸시 표시, 클릭 이동, 오프라인 안내 페이지 대체만 담당한다.
// 개인정보 규칙: 캐시에는 정적 오프라인 안내 페이지 하나만 넣는다. 페이지 이동(navigate) 요청이 네트워크 오류로 실패할 때만
// 그 안내 페이지를 돌려주고, 그 밖의 요청(API·인증·북마크·구독·교차 출처·비GET)은 가로채지 않는다.
const VERSION = "v2";
const CACHE = "moahome-shell-" + VERSION;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" }))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("moahome-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 네트워크 우선: 성공한 응답은 저장하지 않고 그대로 전달, 네트워크 오류일 때만 오프라인 안내를 보여준다
  event.respondWith(fetch(req).catch(() => caches.open(CACHE).then((cache) => cache.match(OFFLINE_URL)).then((res) => res || Response.error())));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }
  const title = typeof data.title === "string" ? data.title : "모아홈";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    data: { url: typeof data.url === "string" ? data.url : "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // 같은 출처 경로만 연다(알림 페이로드의 외부 주소로 이동하지 않는다)
  let target = new URL("/", self.location.origin);
  try {
    const u = new URL(event.notification.data && event.notification.data.url ? event.notification.data.url : "/", self.location.origin);
    if (u.origin === self.location.origin) target = u;
  } catch (_) {
    /* 잘못된 주소는 홈으로 */
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          if ("navigate" in c) c.navigate(target.href);
          return c.focus();
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
