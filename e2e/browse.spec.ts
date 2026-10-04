import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { BASE_ANNS, bulkAnns, installMock } from "./mock";

const names = (page: Page) => page.locator("article h3").allInnerTexts();
const summaryLine = (page: Page) => page.locator("p[aria-live=polite]");
const budget = (page: Page) => page.locator('select[aria-label="예산 상한(억원)"]:visible');
const unitGroup = (page: Page) => page.locator('[aria-label="면적 표시 단위"]:visible').first();
const areaInputs = (page: Page) => page.locator("input[inputmode=decimal]:visible");
const tab = (page: Page, label: string) => page.getByRole("button", { name: new RegExp(label) });

async function open(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator("article").first()).toBeVisible();
}

test.describe("탐색 화면", () => {
  test("기본 로딩: 탭 개수와 카드, 콘솔 오류·hydration 경고 없음", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (m) => { if (["error", "warning"].includes(m.type())) problems.push(m.text()); });
    page.on("pageerror", (e) => problems.push(String(e)));
    await installMock(page);
    await open(page);
    await expect(tab(page, "접수 예정·진행 중")).toContainText("3");
    await expect(tab(page, "잔여세대")).toContainText("1");
    await expect(tab(page, "종료·일정 확인 필요")).toContainText("1");
    expect(await names(page)).toHaveLength(3);
    await expect(page.getByText("전체 5건을 모두 불러왔습니다.")).toBeVisible();
    expect(problems.filter((p) => !/favicon|Failed to load resource/.test(p))).toEqual([]);
  });

  test("정적 HTML과 첫 클라이언트 렌더가 같다(hydration 불일치 없음)", async ({ page }) => {
    const warnings: string[] = [];
    page.on("console", (m) => { if (/hydrat|did not match|server rendered/i.test(m.text())) warnings.push(m.text()); });
    await installMock(page, { delayMs: 300 });
    for (const path of ["/", "/bookmarks/", "/detail/?f=apt&h=000001&p=000001"]) {
      await page.goto(path);
      await page.waitForTimeout(800);
    }
    expect(warnings).toEqual([]);
  });

  test.describe("필터(데스크톱 패널)", () => {
    test.skip(({ isMobile }) => isMobile, "필터 패널은 데스크톱에서 검증(모바일은 별도 테스트)");

    test("예산 6억: 최고가 ≤ 6억은 일치, 초과는 판정 미확인으로 분리", async ({ page }) => {
      await installMock(page);
      await open(page);
      await budget(page).selectOption("6");
      await expect(summaryLine(page)).toContainText("2");
      await expect(summaryLine(page)).toContainText("판정 미확인 1건");
      const shown = await names(page);
      expect(shown).toEqual(expect.arrayContaining(["테스트 일치 단지", "테스트 오피스텔"]));
      await expect(page.getByText("판정 미확인 1건 (일치 결과에 포함되지 않음)")).toBeVisible();
    });

    test("㎡↔평 전환: 결과 목록은 그대로, 칩 문구만 바뀌고 저장값은 ㎡", async ({ page }) => {
      await installMock(page);
      await open(page);
      await budget(page).selectOption("6");
      await page.getByRole("button", { name: /중형/ }).click();
      const chips = page.getByLabel("적용 중인 조건");
      await expect(chips).toContainText("전용 59㎡ ~ 84㎡");
      await expect(summaryLine(page)).toContainText("판정 미확인 2건"); // 전용면적 없는 APT 둘은 미확인
      const before = { summary: await summaryLine(page).innerText(), names: await page.locator("article h3").allInnerTexts() };
      await unitGroup(page).getByRole("button", { name: "평" }).click();
      await expect(chips).toContainText("전용 약 17.8평 ~ 약 25.4평");
      const after = { summary: await summaryLine(page).innerText(), names: await page.locator("article h3").allInnerTexts() };
      expect(after).toEqual(before);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("moahome.prefs.v1")!).filters);
      expect(stored).toMatchObject({ minAreaSqm: 59, maxAreaSqm: 84, areaUnit: "pyeong", budgetMaxKrw: 600_000_000 });
    });

    test("㎡↔평 전환은 공고 카드의 공급면적도 함께 바꾸고, 다시 ㎡로 돌리면 원래대로 돌아온다", async ({ page }) => {
      await installMock(page);
      await open(page);
      const card = page.locator("article").filter({ hasText: "테스트 일치 단지" });
      await expect(card).toContainText("공급면적 110.5㎡");              // 원천 공급면적 110.5㎡
      await unitGroup(page).getByRole("button", { name: "평" }).click();
      await expect(card).toContainText("공급면적 약 33.4평");             // 110.5 / 3.305785 = 33.42
      await expect(card).not.toContainText("110.5㎡");                   // ㎡ 값이 남아 있지 않다
      await unitGroup(page).getByRole("button", { name: "㎡" }).click();
      await expect(card).toContainText("공급면적 110.5㎡");
      await expect(card).not.toContainText("평");
    });

    test("평 표시값을 건드리지 않고 입력칸을 벗어나도 ㎡ 조건이 바뀌지 않는다", async ({ page }) => {
      await installMock(page);
      await open(page);
      await page.getByRole("button", { name: /중형/ }).click();
      await unitGroup(page).getByRole("button", { name: "평" }).click();
      const min = areaInputs(page).first();
      await expect(min).toHaveValue("17.8");
      await min.focus();
      await areaInputs(page).nth(1).focus(); // blur
      await page.locator("h1").click();
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("moahome.prefs.v1")!).filters);
      expect(stored).toMatchObject({ minAreaSqm: 59, maxAreaSqm: 84 });
      await min.fill("17.80"); // 서식만 바꾼 입력도 같은 값
      await page.locator("h1").click();
      expect((await page.evaluate(() => JSON.parse(localStorage.getItem("moahome.prefs.v1")!).filters)).minAreaSqm).toBe(59);
      await min.fill("20"); // 실제로 바꾼 값만 ㎡로 한 번 환산
      await page.locator("h1").click();
      expect((await page.evaluate(() => JSON.parse(localStorage.getItem("moahome.prefs.v1")!).filters)).minAreaSqm).toBe(66.12);
    });

    test("필터·탭 선택은 새로고침 뒤에도 복원된다(마운트 후 복원)", async ({ page }) => {
      await installMock(page);
      await open(page);
      await budget(page).selectOption("6");
      await tab(page, "잔여세대").click();
      await page.reload();
      await expect(budget(page)).toHaveValue("6");
      await expect(tab(page, "잔여세대")).toHaveAttribute("aria-pressed", "true");
    });
  });

  test("전량 자동 로딩: 200건 페이지 3번, 중복·누락 없이 450건", async ({ page }) => {
    const reqs: string[] = [];
    await installMock(page, { anns: bulkAnns(450), requests: reqs });
    await page.goto("/");
    await expect(page.getByText(/전체 450건을 모두 불러왔습니다/)).toBeVisible({ timeout: 20_000 });
    expect(reqs).toHaveLength(4);                   // 200 + 200 + 50 + 끝을 확인하는 빈 페이지
    expect(reqs[0]).toBe("");                       // 첫 페이지는 커서 없음
    expect(reqs[1]).toMatch(/rcrit_pblanc_de\.lt\./); // 다음 페이지는 키셋 커서
    await expect(tab(page, "접수 예정·진행 중")).toContainText("450");
    const shown = await names(page);
    expect(new Set(shown).size).toBe(shown.length);  // 중복 카드 없음
    expect(shown).toHaveLength(450);
  });

  test("로딩 중에는 0건으로 오해되지 않게 개수를 숨긴다", async ({ page }) => {
    await installMock(page, { delayMs: 600 });
    await page.goto("/");
    await expect(page.getByText(/공고를 불러오는 중…/).first()).toBeVisible();
    await expect(tab(page, "접수 예정·진행 중")).not.toContainText(/\d/);
    await expect(page.locator("article").first()).toBeVisible();
    await expect(tab(page, "접수 예정·진행 중")).toContainText("3");
  });

  test("중간 오류: 일부만 불러왔다고 알리고 '다시 시도'를 누르면 마지막 커서부터 이어 받는다", async ({ page }) => {
    const reqs: string[] = [];
    await installMock(page, { anns: bulkAnns(450), failAfterPages: 1, failOnce: true, requests: reqs });
    await page.goto("/");
    await expect(page.getByText(/일부만 불러왔습니다\(200건\)/)).toBeVisible();
    await expect(summaryLine(page)).toContainText("지금까지 불러온 공고 중");
    await page.getByRole("button", { name: "다시 시도" }).click();
    await expect(page.getByText(/전체 450건을 모두 불러왔습니다/)).toBeVisible({ timeout: 20_000 });
    expect(reqs.filter((r) => r === "")).toHaveLength(1);       // 커서 없는 첫 페이지 요청은 한 번뿐(처음부터 다시 받지 않는다)
    const shown = await names(page);
    expect(new Set(shown).size).toBe(shown.length);              // 이어 받은 뒤에도 중복 카드 없음
    expect(shown).toHaveLength(450);
  });

  test("서버가 한 번에 100건만 주는 제한이 있어도 목록이 끊기지 않는다", async ({ page }) => {
    const reqs: string[] = [];
    await installMock(page, { anns: bulkAnns(450), maxRows: 100, requests: reqs });
    await page.goto("/");
    await expect(page.getByText(/전체 450건을 모두 불러왔습니다/)).toBeVisible({ timeout: 20_000 });
    await expect(tab(page, "접수 예정·진행 중")).toContainText("450");
    expect(reqs.length).toBeGreaterThanOrEqual(5);               // 100건씩 끊어 받고 빈 페이지로 끝을 확인
  });

  test("정적 서버는 out/ 밖의 파일을 내주지 않는다(경로 이탈 차단)", async ({ request }) => {
    // out/과 이름이 'out'으로 시작하는 실제 형제 파일을 임시로 만들어, 접두사 비교로는 뚫리는 경로도 막는지 확인한다
    const sibling = path.resolve(process.cwd(), "out-secret.txt");
    fs.writeFileSync(sibling, "SIBLING-SECRET-CONTENT");
    try {
      for (const p of ["/..%2f..%2fpackage.json", "/%2e%2e/package.json", "/..%2fout-secret.txt", "/../out-secret.txt"]) {
        const res = await request.get(p);
        expect(res.status(), p).toBe(404);
        const body = await res.text();
        expect(body).not.toContain("moahome-frontend");
        expect(body).not.toContain("SIBLING-SECRET-CONTENT");
      }
    } finally {
      fs.rmSync(sibling, { force: true });
    }
  });

  test("갱신 지연·수집 기록 없음 배너", async ({ page }) => {
    await installMock(page, { lastSync: "2026-09-25T00:00:00Z" });
    await open(page);
    await expect(page.getByText("정보 갱신 지연")).toBeVisible();
    const p2 = await page.context().newPage();
    await installMock(p2, { lastSync: null });
    await p2.goto("/");
    await expect(p2.getByText("수집 성공 기록이 없습니다")).toBeVisible();
  });

  test("가로 스크롤이 없다(390px 포함)", async ({ page }) => {
    await installMock(page);
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test("모바일: 필터는 접혀 있고 열면 사용할 수 있다", async ({ page, isMobile }) => {
    test.skip(!isMobile, "모바일 프로젝트에서만");
    await installMock(page);
    await open(page);
    await page.getByText(/필터 열기/).click();
    await budget(page).selectOption("6");
    await expect(page.getByLabel("적용 중인 조건")).toContainText("최고 분양가 6억원 이하");
  });
});

test.describe("비회원 북마크와 로그인 대화상자", () => {
  test("북마크를 누르면 로그인 안내가 뜨고 포커스가 갇혔다가 ESC로 돌아온다", async ({ page }) => {
    await installMock(page);
    await open(page);
    const btn = page.locator("article").first().getByRole("button", { name: /관심 공고에 저장/ });
    await btn.focus();
    await btn.click();
    const dlg = page.getByRole("dialog", { name: "로그인" });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("관심 공고를 저장하고 접수일 알림을 받으려면 로그인해 주세요.");
    for (let i = 0; i < 6; i++) { // Tab을 여러 번 눌러도 대화상자 밖으로 나가지 않는다
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(btn).toBeFocused();
    await expect(btn).toHaveAttribute("aria-pressed", "false"); // 비회원은 저장되지 않는다
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /bookmark/i.test(k)))).toEqual([]);
  });

  test("잘못된 이메일 형식은 링크를 보내지 않는다", async ({ page }) => {
    let otp = 0;
    await installMock(page);
    await page.route("**/auth/v1/otp**", (r) => { otp += 1; return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
    await open(page);
    await page.getByRole("button", { name: "로그인", exact: true }).first().click();
    const dlg = page.getByRole("dialog", { name: "로그인" });
    await dlg.locator("input[type=email]").fill("not-an-email");
    await dlg.getByRole("button", { name: "로그인 링크 보내기" }).click();
    expect(otp).toBe(0);
  });

  test("관심 공고 화면은 비회원에게 로그인을 안내한다", async ({ page }) => {
    await installMock(page);
    await page.goto("/bookmarks/");
    await expect(page.getByText("관심 공고 저장과 접수일 알림은 로그인 후 사용할 수 있습니다.")).toBeVisible();
  });
});

test.describe("상세 화면", () => {
  const first = BASE_ANNS[0]!;
  const key = first.id.slice(-6);

  test("㎡↔평 전환은 상세의 공급면적(요약·주택형 표)도 함께 바꾼다", async ({ page }) => {
    await installMock(page);
    await page.goto(`/detail/?f=apt&h=${key}&p=${key}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(first.name);
    await expect(page.locator("dl").first()).toContainText("110.5㎡");
    await expect(page.locator("table")).toContainText("110.5㎡");
    await unitGroup(page).getByRole("button", { name: "평" }).click();
    await expect(page.locator("dl").first()).toContainText("약 33.4평");
    await expect(page.locator("table")).toContainText("약 33.4평");
    await expect(page.locator("dl").first()).not.toContainText("110.5㎡");
    await expect(page.locator("table")).not.toContainText("110.5㎡");
    await page.reload();                                              // 선택한 단위는 새로고침 뒤에도 유지된다
    await expect(page.locator("table")).toContainText("약 33.4평");
  });

  test("직접 URL로 열리고 주택형·일정·공식 링크가 보인다", async ({ page }) => {
    await installMock(page);
    await page.goto(`/detail/?f=apt&h=${key}&p=${key}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(first.name);
    await expect(page.getByText("공급면적", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("전용면적").first()).toBeVisible();
    await expect(page.locator("table")).toContainText("084A");
    await expect(page.getByText("원천 필드 기준으로 표시한 날짜입니다")).toBeVisible();
    const href = await page.getByRole("link", { name: /공식 공고 확인/ }).getAttribute("href");
    expect(new URL(href!).hostname).toBe("www.applyhome.co.kr");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test("공식 도메인이 아닌 링크는 공식 링크로 연결하지 않는다", async ({ page }) => {
    const bad = { ...first, id: "00000000-0000-4000-8000-000000000777", url: "https://evil.example/applyhome.co.kr" };
    await installMock(page, { anns: [bad] });
    await page.goto(`/detail/?f=apt&h=000777&p=000777`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(first.name);
    await expect(page.getByRole("link", { name: /공식 공고 확인/ })).toHaveCount(0);
    await expect(page.getByText("공식 공고 링크 확인 필요")).toBeVisible();
  });

  test("없는 공고·잘못된 주소는 안내를 보여 준다", async ({ page }) => {
    await installMock(page);
    await page.goto("/detail/?f=apt&h=999999&p=999999");
    await expect(page.getByText("해당 공고를 찾을 수 없습니다")).toBeVisible();
    await page.goto("/detail/?f=evil&h=1&p=1");
    await expect(page.getByText("해당 공고를 찾을 수 없습니다")).toBeVisible();
  });
});
