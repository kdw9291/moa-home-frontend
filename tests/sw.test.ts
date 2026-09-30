import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// public/sw.js를 가짜 ServiceWorker 전역에서 실행해 푸시 표시·클릭 이동·오프라인 안내 규칙을 검증한다.
const source = readFileSync(path.resolve(__dirname, "..", "public", "sw.js"), "utf8");
const ORIGIN = "https://moahome.example";

interface Harness {
  handlers: Record<string, (e: any) => void>;
  shown: { title: string; options: any }[];
  cacheStore: Map<string, Map<string, unknown>>; // 캐시 이름 -> (URL -> 응답)
  puts: string[]; // cache.put/addAll 호출 기록
  adds: string[]; // cache.add로 저장한 URL
  skipped: () => boolean;
}

function load(opts: { clientsOpen?: string[]; existing?: any[]; fetchImpl?: (req: any) => Promise<any>; seedCaches?: Record<string, string[]> } = {}): Harness {
  const handlers: Record<string, (e: any) => void> = {};
  const shown: { title: string; options: any }[] = [];
  const cacheStore = new Map<string, Map<string, unknown>>();
  for (const [name, urls] of Object.entries(opts.seedCaches ?? {})) cacheStore.set(name, new Map(urls.map((u) => [u, "seed"])));
  const puts: string[] = [];
  const adds: string[] = [];
  let skipped = false;
  const caches = {
    open: async (name: string) => {
      if (!cacheStore.has(name)) cacheStore.set(name, new Map());
      const m = cacheStore.get(name)!;
      return {
        add: async (req: any) => { const u = new URL(typeof req === "string" ? req : req.url, ORIGIN).pathname; adds.push(u); m.set(u, `cached:${u}`); },
        addAll: async () => { puts.push("addAll"); },
        put: async (req: any) => { puts.push(String(req?.url ?? req)); },
        match: async (u: string) => m.get(new URL(u, ORIGIN).pathname),
      };
    },
    keys: async () => [...cacheStore.keys()],
    delete: async (k: string) => cacheStore.delete(k),
  };
  const self: any = {
    location: { origin: ORIGIN },
    registration: { showNotification: (title: string, options: any) => { shown.push({ title, options }); return Promise.resolve(); } },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(opts.existing ?? []),
      openWindow: (u: string) => { (opts.clientsOpen ?? []).push(u); return Promise.resolve(); },
    },
    skipWaiting: () => { skipped = true; },
    addEventListener: (name: string, fn: (e: any) => void) => { handlers[name] = fn; },
  };
  class FakeRequest { url: string; constructor(u: string) { this.url = u; } }
  vm.runInNewContext(source, { self, URL, caches, Request: FakeRequest, Response: { error: () => "network-error-response" }, fetch: opts.fetchImpl ?? (() => Promise.reject(new Error("offline"))) });
  return { handlers, shown, cacheStore, puts, adds, skipped: () => skipped };
}

const waitUntilOf = () => { let p: Promise<unknown> = Promise.resolve(); return { waitUntil: (x: Promise<unknown>) => { p = x; }, done: () => p }; };

function navigate(h: Harness, url: string, over: Record<string, unknown> = {}) {
  let responded: Promise<unknown> | null = null;
  h.handlers.fetch!({ request: { method: "GET", mode: "navigate", url, ...over }, respondWith: (p: Promise<unknown>) => { responded = p; } });
  return responded as Promise<unknown> | null;
}

describe("서비스 워커: 푸시와 클릭", () => {
  it("푸시 페이로드를 알림으로 표시하고 손상된 데이터는 기본값으로 처리한다", async () => {
    const { handlers, shown } = load();
    const w = waitUntilOf();
    handlers.push!({ data: { json: () => ({ title: "제목", body: "본문", tag: "t1", url: "/detail/?f=apt&h=1&p=1" }) }, ...w });
    await w.done();
    expect(shown[0]).toMatchObject({ title: "제목", options: { body: "본문", tag: "t1", data: { url: "/detail/?f=apt&h=1&p=1" } } });
    const w2 = waitUntilOf();
    handlers.push!({ data: { json: () => { throw new Error("bad json"); } }, ...w2 });
    await w2.done();
    expect(shown[1]).toMatchObject({ title: "모아홈", options: { body: "" } });
    const w3 = waitUntilOf();
    handlers.push!({ data: null, ...w3 });
    await w3.done();
    expect(shown[2]!.title).toBe("모아홈");
  });

  it("클릭하면 같은 출처 경로만 열고 외부 주소·잘못된 값은 홈으로 보낸다", async () => {
    for (const [given, expected] of [
      ["/detail/?f=apt&h=1&p=1", `${ORIGIN}/detail/?f=apt&h=1&p=1`],
      ["https://evil.example/phish", `${ORIGIN}/`],
      ["//evil.example/x", `${ORIGIN}/`],
      ["javascript:alert(1)", `${ORIGIN}/`],
      [undefined, `${ORIGIN}/`],
    ] as const) {
      const opened: string[] = [];
      const { handlers } = load({ clientsOpen: opened });
      const w = waitUntilOf();
      let closed = false;
      handlers.notificationclick!({ notification: { close: () => { closed = true; }, data: given === undefined ? {} : { url: given } }, ...w });
      await w.done();
      expect(closed).toBe(true);
      expect(opened).toEqual([expected]);
    }
  });

  it("이미 열린 창이 있으면 그 창을 이동·포커스한다", async () => {
    const nav: string[] = [];
    let focused = false;
    const { handlers } = load({ existing: [{ focus: () => { focused = true; }, navigate: (u: string) => nav.push(u) }] });
    const w = waitUntilOf();
    handlers.notificationclick!({ notification: { close() {}, data: { url: "/bookmarks/" } }, ...w });
    await w.done();
    expect(nav).toEqual([`${ORIGIN}/bookmarks/`]);
    expect(focused).toBe(true);
  });
});

describe("서비스 워커: 오프라인 안내와 개인정보 규칙", () => {
  it("설치 때 저장하는 것은 정적 오프라인 안내 페이지 하나뿐이다", async () => {
    const h = load();
    const w = waitUntilOf();
    h.handlers.install!(w);
    await w.done();
    expect(h.adds).toEqual(["/offline.html"]);
    expect(h.puts).toEqual([]);
    expect(h.skipped()).toBe(true);
    expect([...h.cacheStore.keys()]).toEqual(["moahome-shell-v2"]);
  });

  it("페이지 이동이 성공하면 응답을 저장하지 않고 그대로 전달한다", async () => {
    const h = load({ fetchImpl: async () => "network-page" });
    const res = await navigate(h, `${ORIGIN}/bookmarks/`);
    expect(res).toBe("network-page");
    expect(h.puts).toEqual([]);
    expect(h.adds).toEqual([]);
  });

  it("네트워크 오류일 때만 오프라인 안내 페이지를 보여준다", async () => {
    const h = load();
    const w = waitUntilOf();
    h.handlers.install!(w);
    await w.done();
    expect(await navigate(h, `${ORIGIN}/bookmarks/`)).toBe("cached:/offline.html");
  });

  it("안내 페이지가 없으면 오류 응답으로 처리한다(빈 화면 대신 브라우저 기본 오류)", async () => {
    const h = load();
    expect(await navigate(h, `${ORIGIN}/`)).toBe("network-error-response");
  });

  it("API·정적 자원·비GET·교차 출처 요청은 가로채지 않는다", () => {
    const h = load();
    expect(navigate(h, "https://abc.supabase.co/rest/v1/user_bookmarks", { mode: "cors" })).toBeNull();      // 회원 데이터 API
    expect(navigate(h, `${ORIGIN}/_next/static/chunks/app.js`, { mode: "no-cors" })).toBeNull();               // 정적 자원(navigate 아님)
    expect(navigate(h, `${ORIGIN}/bookmarks/`, { method: "POST" })).toBeNull();                                // 비GET
    expect(navigate(h, "https://evil.example/", {})).toBeNull();                                               // 다른 출처로의 이동
  });

  it("활성화 때 이전 버전의 모아홈 캐시만 지우고 다른 캐시는 건드리지 않는다", async () => {
    const h = load({ seedCaches: { "moahome-shell-v1": ["/offline.html"], "moahome-shell-v2": ["/offline.html"], "other-app": ["/x"] } });
    const w = waitUntilOf();
    h.handlers.activate!(w);
    await w.done();
    expect([...h.cacheStore.keys()].sort()).toEqual(["moahome-shell-v2", "other-app"]);
  });

  it("코드에 응답 저장(put/addAll)이나 API 경로 처리가 없다", () => {
    const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/cache\.put|\.addAll\(|supabase|rest\/v1|auth\/v1/);
  });
});
