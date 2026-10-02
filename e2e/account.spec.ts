import { expect, test, type Page } from "@playwright/test";
import { authStorageKey, BASE_ANNS, installMock, type MockHandle } from "./mock";

// 로그인 상태 검증: 실제 Chrome에 세션을 주입하고 서버(Supabase REST/Auth)만 모의한다.
// 이메일 링크 클릭은 자동화하지 않지만, 로그인된 뒤의 앱 동작(동기화·저장·북마크·로그아웃)은 실제 앱 코드로 검증한다.
test.describe("로그인 상태", () => {
  test.skip(({ isMobile }) => isMobile, "데스크톱 프로젝트에서만(동일 코드 경로)");

  const USER = { userId: "11111111-1111-4111-8111-111111111111", email: "tester@example.com" };
  const PREFS = "moahome.prefs.v1";
  const serverRow = (over: Record<string, unknown> = {}) => ({
    user_id: USER.userId, preferred_region_codes: [], budget_max_krw: 500_000_000, min_area_sqm: null, max_area_sqm: null,
    housing_families: [], qualification_preferences: [], revision: 3, ...over,
  });
  const budget = (page: Page) => page.locator('select[aria-label="예산 상한(억원)"]:visible');
  const names = (page: Page) => page.locator("article h3").allInnerTexts();
  const prefsKey = (page: Page) => page.evaluate((k) => localStorage.getItem(k), PREFS);
  const seedGuestPrefs = (page: Page, filters: Record<string, unknown>) =>
    page.addInitScript(({ k, v }) => { if (!sessionStorage.getItem("__seeded_prefs")) { localStorage.setItem(k, v); sessionStorage.setItem("__seeded_prefs", "1"); } },
      { k: PREFS, v: JSON.stringify({ filters, tab: "open", sort: "latest" }) });

  async function openHome(page: Page) {
    await page.goto("/");
    await expect(page.locator("article").first()).toBeVisible();
  }

  test("모의 서버 자체 점검: 인증된 사용자도 다른 user_id로는 쓰거나 읽을 수 없고 Bearer 없이는 401이다", async ({ page }) => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const h = await installMock(page, { auth: USER, serverFilters: { [OTHER]: serverRow({ user_id: OTHER }) } });
    await openHome(page);
    const r = await page.evaluate(async ({ key, other }) => {
      const token = (JSON.parse(localStorage.getItem(key)!) as { access_token: string }).access_token;
      const u = "https://selfcheck.example/rest/v1/user_filter_settings";
      const call = (init: RequestInit, q = "") => fetch(u + q, init).then(async (x) => ({ status: x.status, body: await x.text() }));
      const auth = { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "resolution=merge-duplicates" };
      return {
        writeOther: (await call({ method: "POST", headers: auth, body: JSON.stringify({ user_id: other }) }, "?on_conflict=user_id")).status,
        writeNoUser: (await call({ method: "POST", headers: auth, body: JSON.stringify({ budget_max_krw: 1 }) }, "?on_conflict=user_id")).status,
        readOther: (await call({ headers: auth }, `?user_id=eq.${other}`)).body,
        noBearer: (await call({ headers: { authorization: token } }, `?user_id=eq.${other}`)).status,
      };
    }, { key: authStorageKey(), other: OTHER });
    expect(r.writeOther).toBe(403);
    expect(r.writeNoUser).toBe(403);                                              // user_id 누락 쓰기도 RLS(user_id = auth.uid())에 걸린다
    expect(r.readOther).toBe("null");
    expect(r.noBearer).toBe(401);
    expect(h.serverFilters[OTHER]).toMatchObject({ budget_max_krw: 500_000_000 });   // 타인 행이 바뀌지 않았다
  });

  test("로그인하면 헤더에 계정이 보이고 서버에 저장된 필터가 적용되며 브라우저에는 필터를 남기지 않는다", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await openHome(page);
    await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
    await expect(page.getByRole("link", { name: "관심 공고" })).toBeVisible();
    await expect(budget(page)).toHaveValue("5");
    await expect(page.getByLabel("적용 중인 조건")).toContainText("최고 분양가 5억원 이하");
    expect(h.filterUpserts).toEqual([]);                  // 불러오기만으로는 서버에 쓰지 않는다
    expect(await prefsKey(page)).toBeNull();               // 계정 모드: 브라우저에 필터 저장본이 없다
  });

  test("필터를 바꾸면 잠시 뒤 서버에 저장되고(개정 번호 증가) 새로고침 뒤에도 복원된다", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await openHome(page);
    await budget(page).selectOption("6");
    await expect.poll(() => h.filterUpserts.at(-1)?.budget_max_krw, { timeout: 5000 }).toBe(600_000_000);
    const body = h.filterUpserts.at(-1)!;
    expect(body).toMatchObject({ user_id: USER.userId, revision: 4, min_area_sqm: null, preferred_region_codes: [] });
    expect(JSON.stringify(body)).not.toContain("keyword");      // 기기 UI 값은 저장하지 않는다
    expect(await prefsKey(page)).toBeNull();
    await page.reload();
    await expect(page.locator("article").first()).toBeVisible();
    await expect(budget(page)).toHaveValue("6");                // 서버 행에서 복원
  });

  test("짧은 시간에 여러 번 바꿔도 마지막 값만 저장한다(디바운스)", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await openHome(page);
    for (const v of ["3", "4", "8", "10"]) await budget(page).selectOption(v);
    await expect.poll(() => h.filterUpserts.length, { timeout: 5000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1200);
    expect(h.filterUpserts).toHaveLength(1);
    expect(h.filterUpserts[0]!.budget_max_krw).toBe(1_000_000_000);
  });

  test("면적 경계 포함 여부와 표시 단위가 저장·복원된다('59㎡ 미만'이 '이하'로 바뀌지 않는다)", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow({ budget_max_krw: null }) } });
    await openHome(page);
    await page.getByRole("button", { name: /소형/ }).click();
    await page.locator('[aria-label="전용면적 표시 단위"]:visible').first().getByRole("button", { name: "평" }).click();
    await expect.poll(() => h.filterUpserts.at(-1)?.qualification_preferences, { timeout: 5000 }).toEqual(expect.arrayContaining(["_ui:max_excl", "_ui:unit:pyeong"]));
    expect(h.filterUpserts.at(-1)).toMatchObject({ max_area_sqm: 59, min_area_sqm: null });
    await page.reload();
    await expect(page.locator("article").first()).toBeVisible();
    await expect(page.getByLabel("적용 중인 조건")).toContainText("전용 약 17.8평 미만"); // 경계 '미만'과 평 단위 복원
  });

  test("비회원 조건과 계정 조건이 다르면 선택창이 뜨고, 브라우저 조건을 고르면 계정에 저장하고 로컬 저장본을 지운다", async ({ page }) => {
    await seedGuestPrefs(page, { budgetMaxKrw: 300_000_000 });
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await page.goto("/");
    const dlg = page.getByRole("dialog", { name: "어느 검색 조건을 사용할까요?" });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("최고 분양가 5억원 이하");     // 계정 조건
    await expect(dlg).toContainText("최고 분양가 3억원 이하");     // 이 브라우저의 조건
    await dlg.getByRole("button", { name: /이 브라우저의 조건/ }).click();
    await expect(dlg).toBeHidden();
    await expect.poll(() => h.filterUpserts.at(-1)?.budget_max_krw, { timeout: 5000 }).toBe(300_000_000);
    await expect(budget(page)).toHaveValue("3");
    expect(await prefsKey(page)).toBeNull();
  });

  test("계정 조건을 고르면 서버에 쓰지 않고 그 조건을 쓰며 로컬 저장본을 지운다", async ({ page }) => {
    await seedGuestPrefs(page, { budgetMaxKrw: 300_000_000 });
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await page.goto("/");
    await page.getByRole("dialog", { name: "어느 검색 조건을 사용할까요?" }).getByRole("button", { name: /계정에 저장된 조건/ }).click();
    await expect(budget(page)).toHaveValue("5");
    expect(h.filterUpserts).toEqual([]);
    expect(await prefsKey(page)).toBeNull();
  });

  test("서버에 저장된 조건이 없고 비회원 조건만 있으면 선택창 없이 계정에 저장한다", async ({ page }) => {
    await seedGuestPrefs(page, { budgetMaxKrw: 400_000_000 });
    const h = await installMock(page, { auth: USER });
    await page.goto("/");
    await expect(page.locator("article").first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => h.filterUpserts.at(-1)?.budget_max_krw, { timeout: 5000 }).toBe(400_000_000);
    await expect(budget(page)).toHaveValue("4");
    expect(await prefsKey(page)).toBeNull();
  });

  test("조건이 같으면 선택창 없이 서버 값을 쓴다", async ({ page }) => {
    await seedGuestPrefs(page, { budgetMaxKrw: 500_000_000 });
    await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await page.goto("/");
    await expect(page.locator("article").first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(budget(page)).toHaveValue("5");
  });

  test("로그아웃하면 서버에 로그아웃을 알리고 필터가 기본값으로 돌아가며 이후 변경은 저장되지 않는다", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await openHome(page);
    await expect(budget(page)).toHaveValue("5");
    await page.getByRole("button", { name: "로그아웃" }).click();
    await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
    expect(h.logoutCalls).toBe(1);
    await expect(budget(page)).toHaveValue("");                  // 이전 사용자의 조건이 남지 않는다
    const stored = await prefsKey(page);
    expect(stored === null || JSON.parse(stored).filters.budgetMaxKrw === null).toBe(true); // 저장본이 있어도 기본값뿐
    const before = h.filterUpserts.length;
    await budget(page).selectOption("8");
    await page.waitForTimeout(1300);
    expect(h.filterUpserts.length).toBe(before);                  // 로그아웃 뒤에는 서버에 쓰지 않는다
    expect(JSON.stringify(h.serverFilters)).not.toContain("800000000");
  });

  test("서버 저장이 실패하면 화면에 알리고 조건은 계속 적용된다(조용히 삼키지 않는다)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() }, failUpsert: true });
    await openHome(page);
    await budget(page).selectOption("6");
    await expect(page.getByText("검색 조건을 계정에 저장하지 못했습니다")).toBeVisible({ timeout: 5000 });
    await expect(page.getByLabel("적용 중인 조건")).toContainText("최고 분양가 6억원 이하"); // 이 화면에는 적용
    expect(h.rpcCalls.length).toBeGreaterThan(0);            // 저장 RPC를 호출했지만 서버가 거절했다
    expect(h.filterUpserts).toEqual([]);                      // 서버에는 반영되지 않았다
    expect(errors).toEqual([]);
  });

  test("다른 기기가 먼저 저장해 서버 revision이 앞서면 선택창이 뜨고, 내 조건을 고르면 최신 revision으로 저장한다", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await openHome(page);                                      // revision 3을 읽은 상태
    h.serverFilters[USER.userId] = serverRow({ budget_max_krw: 900_000_000, revision: 7 });   // 다른 기기가 저장
    await budget(page).selectOption("6");
    const dialog = page.getByRole("dialog", { name: "어느 검색 조건을 사용할까요?" });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    expect(h.filterUpserts).toEqual([]);                       // 선택 전에는 덮어쓰지 않는다
    await expect(dialog).toContainText("9억");
    await dialog.getByRole("button", { name: /이 브라우저의 조건/ }).click();
    await expect.poll(() => h.filterUpserts.at(-1)?.revision, { timeout: 5000 }).toBe(8);
    expect(h.filterUpserts.at(-1)).toMatchObject({ budget_max_krw: 600_000_000 });
    expect(h.directFilterWrites).toBe(0);                      // 저장은 RPC로만
  });

  test("모의 서버 자체 점검: 필터 테이블 직접 쓰기는 본인 것이어도 거부된다(권한 회수)", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await openHome(page);
    const status = await page.evaluate(async ({ key, me }) => {
      const token = (JSON.parse(localStorage.getItem(key)!) as { access_token: string }).access_token;
      const r = await fetch("https://selfcheck.example/rest/v1/user_filter_settings?on_conflict=user_id", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ user_id: me, budget_max_krw: 1, revision: 99 }),
      });
      return r.status;
    }, { key: authStorageKey(), me: USER.userId });
    expect(status).toBe(403);
    expect(h.directFilterWrites).toBe(1);
    expect(h.serverFilters[USER.userId]).toMatchObject({ revision: 3 });   // 서버 행은 그대로
  });

  test("계정 조건을 불러오지 못하면 알리고, 그동안 바꾼 조건은 저장·브라우저 보관 없이 두었다가 '다시 불러오기' 뒤 선택창으로 넘긴다", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() }, failFilterGet: true });
    await openHome(page);
    await expect(page.getByText("계정에 저장된 검색 조건을 불러오지 못했습니다")).toBeVisible();
    await budget(page).selectOption("8");                       // 불러오기 실패 상태에서 바꾼 조건
    await page.waitForTimeout(1300);
    expect(h.filterUpserts).toEqual([]);                         // 서버에 쓰지 않는다(개정 번호를 모른다)
    const stored = await prefsKey(page);                         // 로그인 전 비회원 저장본은 남을 수 있지만, 실패 상태에서 바꾼 조건은 쓰이지 않는다
    expect(stored === null || JSON.parse(stored).filters.budgetMaxKrw === null).toBe(true);
    expect(stored ?? "").not.toContain("800000000");
    h.failFilterGet = false;                                     // 서버 복구
    await page.getByRole("button", { name: "다시 불러오기" }).click();
    await expect(page.getByText("계정에 저장된 검색 조건을 불러오지 못했습니다")).toBeHidden();
    await expect(page.getByRole("dialog", { name: "어느 검색 조건을 사용할까요?" })).toBeVisible();   // 바꾼 조건을 조용히 버리지 않고 선택하게 한다
    expect(h.filterUpserts).toEqual([]);
    await page.getByRole("button", { name: /계정에 저장된 조건/ }).click();
    await expect(budget(page)).toHaveValue("5");                 // 서버에 저장돼 있던 조건이 적용된다
    await budget(page).selectOption("6");
    await expect.poll(() => h.filterUpserts.at(-1)?.revision, { timeout: 5000 }).toBe(4);   // 서버 revision 3 다음
  });

  test("모의 서버 자체 점검: 사용자 토큰 없이 공개 키만 보낸 요청은 사용자 테이블에서 401이다", async ({ page }) => {
    await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow() } });
    await openHome(page);
    const ref = authStorageKey().replace(/^sb-/, "").replace(/-auth-token$/, "");
    const status = await page.evaluate(async (ref) => {
      const url = `https://${ref}.supabase.co/rest/v1/user_filter_settings?select=*&user_id=eq.x`;
      const anon = await fetch(url, { headers: { apikey: "anon-only", Authorization: "Bearer anon-only" } });
      return anon.status;
    }, ref);
    expect(status).toBe(401);                                    // 모의 RLS가 동작하므로, 앱의 정상 동작은 사용자 토큰을 실제로 붙인다는 뜻이다
    await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  });

  test("최소 면적이 최대보다 크면 저장하지 않고 알리며, 고치면 다시 저장한다", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverFilters: { [USER.userId]: serverRow({ budget_max_krw: null }) } });
    await openHome(page);
    await page.getByRole("button", { name: /중형/ }).click();          // 59~84
    await expect.poll(() => h.filterUpserts.at(-1)?.min_area_sqm, { timeout: 5000 }).toBe(59);
    const saved = h.filterUpserts.length;
    const min = page.locator("input[inputmode=decimal]:visible").first();
    await min.fill("100");
    await page.locator("h1").click();
    await expect(page.getByText(/최소 면적이 최대 면적보다 커서/)).toBeVisible({ timeout: 5000 });
    expect(h.filterUpserts.length).toBe(saved);                      // DB 제약에 걸릴 값은 서버로 보내지 않는다
    await min.fill("60");
    await page.locator("h1").click();
    await expect.poll(() => h.filterUpserts.at(-1)?.min_area_sqm, { timeout: 5000 }).toBe(60);
    await expect(page.getByText(/최소 면적이 최대 면적보다 커서/)).toBeHidden();
  });
});

test.describe("로그인 상태: 북마크와 알림 설정 화면", () => {
  test.skip(({ isMobile }) => isMobile, "데스크톱 프로젝트에서만(동일 코드 경로)");
  const USER = { userId: "22222222-2222-4222-8222-222222222222", email: "marker@example.com" };
  const first = BASE_ANNS[0]!;
  const pressed = (page: Page) => page.locator("article").first().getByRole("button", { name: /관심 공고/ });

  async function go(page: Page, h?: Partial<Parameters<typeof installMock>[1]>) {
    const handle: MockHandle = await installMock(page, { auth: USER, ...h });
    await page.goto("/");
    await expect(page.locator("article").first()).toBeVisible();
    return handle;
  }

  test("북마크를 누르면 서버에 저장되고 새로고침 뒤에도 유지되며 다시 누르면 삭제된다", async ({ page }) => {
    const h = await go(page);
    const btn = pressed(page);
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(h.bookmarkWrites).toEqual([{ op: "add", id: expect.any(String) }]);
    await page.reload();
    await expect(page.locator("article").first()).toBeVisible();
    await expect(pressed(page)).toHaveAttribute("aria-pressed", "true");
    await pressed(page).click();
    await expect(pressed(page)).toHaveAttribute("aria-pressed", "false");
    expect(h.bookmarkWrites.map((w) => w.op)).toEqual(["add", "remove"]);
    expect(h.bookmarks.size).toBe(0);
  });

  test("관심 공고 화면에는 북마크한 공고만 보이고, 여기서 해제하면 바로 사라진다", async ({ page }) => {
    const h = await installMock(page, { auth: USER, serverBookmarks: [first.id] });
    await page.goto("/bookmarks/");
    await expect(page.locator("article h3")).toHaveText([first.name]);
    await expect(page.getByRole("heading", { name: "접수일 알림" })).toBeVisible();
    await page.locator("article").first().getByRole("button", { name: /관심 공고/ }).click();
    await expect(page.getByText("저장한 관심 공고가 없습니다")).toBeVisible();
    expect(h.bookmarks.size).toBe(0);
  });

  test("알림 설정은 사용자가 누르기 전에는 권한을 요청하지 않는다", async ({ page, context }) => {
    // 알림 '허용'된 상태에서도 버튼을 누르기 전에는 requestPermission·구독을 시도하지 않는지 본다
    await context.grantPermissions(["notifications"]);
    await installMock(page, { auth: USER });
    await page.addInitScript(() => {
      // 권한 요청이 호출되면 기록한다(사용자 클릭 전에는 호출되면 안 된다)
      (window as any).__permAsked = 0;
      const real = Notification.requestPermission.bind(Notification);
      Notification.requestPermission = (...a: any[]) => { (window as any).__permAsked += 1; return real(...(a as [])); };
    });
    await page.goto("/bookmarks/");
    await expect(page.getByRole("heading", { name: "접수일 알림" })).toBeVisible();
    await expect(page.getByRole("button", { name: "이 기기 알림 켜기" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).__permAsked)).toBe(0);
    await expect(page.getByText(/접수 시간과 조건은|배치 실행 시각에 따라 늦거나 도착하지 않을 수 있으니/).first()).toBeVisible(); // 전달 보장 안 함
  });
});
