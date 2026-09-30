import { expect, test } from "@playwright/test";
import { installMock } from "./mock";

// 실제 Chrome에서 서비스 워커를 등록하고 오프라인 동작과 개인정보 규칙(저장 범위)을 검증한다.
test.describe("PWA: 서비스 워커·오프라인·매니페스트", () => {
  test.skip(({ isMobile }) => isMobile, "데스크톱 프로젝트에서만(동일 코드 경로)");

  async function controlled(page: import("@playwright/test").Page) {
    await page.goto("/");
    await expect(page.locator("article").first()).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    // clients.claim 이후 이 페이지가 서비스 워커의 제어를 받을 때까지 기다린다
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 10_000 });
  }

  test("프로덕션 빌드에서 서비스 워커가 등록되고 캐시에는 오프라인 안내 페이지만 있다", async ({ page }) => {
    await installMock(page);
    await controlled(page);
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const names = await caches.keys();
      const entries: Record<string, string[]> = {};
      for (const n of names) entries[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
      return { scope: reg?.scope, active: !!reg?.active, entries };
    });
    expect(info.active).toBe(true);
    expect(info.scope).toMatch(/\/$/);
    expect(info.entries).toEqual({ "moahome-shell-v2": ["/offline.html"] }); // 공고·API·인증 응답은 저장하지 않는다
  });

  test("목록·상세·관심 공고를 둘러본 뒤에도 캐시는 그대로다(개인·공고 응답 미저장)", async ({ page }) => {
    await installMock(page);
    await controlled(page);
    await page.goto("/detail/?f=apt&h=000001&p=000001");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/bookmarks/");
    await expect(page.getByText("관심 공고 저장과 접수일 알림은 로그인 후 사용할 수 있습니다.")).toBeVisible();
    const entries = await page.evaluate(async () => {
      const out: string[] = [];
      for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname);
      return out;
    });
    expect(entries).toEqual(["/offline.html"]);
  });

  test("오프라인에서 페이지를 열면 안내 화면이 보이고 다시 연결되면 정상으로 돌아온다", async ({ page, context }) => {
    await installMock(page);
    await controlled(page);
    await context.setOffline(true);
    await page.goto("/bookmarks/");
    await expect(page.getByRole("heading", { name: "인터넷에 연결되어 있지 않습니다" })).toBeVisible();
    await expect(page.getByText("오프라인 화면은 이 안내 페이지만 저장합니다")).toBeVisible();
    await expect(page.getByText("로그인 상태와 알림 구독은 이 기기의 브라우저에 남아 있을 수 있으며")).toBeVisible(); // 과장 없는 안내
    await context.setOffline(false);
    await page.getByRole("button", { name: "다시 시도" }).click();
    await expect(page.getByText("관심 공고 저장과 접수일 알림은 로그인 후 사용할 수 있습니다.")).toBeVisible();
  });

  test("매니페스트와 아이콘이 유효하다(설치 가능 조건)", async ({ page, request }) => {
    await installMock(page);
    await page.goto("/");
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBe("/manifest.webmanifest");
    const res = await request.get("/manifest.webmanifest");
    const m = await res.json();
    expect(m).toMatchObject({ display: "standalone", start_url: "/", scope: "/", lang: "ko" });
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes).sort();
    expect(sizes).toEqual(["192x192", "512x512"]);
    for (const icon of m.icons) {
      const r = await request.get(icon.src);
      expect(r.status()).toBe(200);
      expect(r.headers()["content-type"]).toBe("image/png");
    }
  });
});
