import fs from "node:fs";
import path from "node:path";
import type { Page, Route } from "@playwright/test";

// 화면 테스트용 고정 데이터와 Supabase REST(PostgREST) 흉내. 실제 서비스에는 접속하지 않는다.
// 오늘(KST)은 페이지의 Date를 고정해 결정적으로 만든다(FIXED_NOW).
export const FIXED_NOW = "2026-09-29T03:00:00Z"; // KST 2026-09-29 12:00
export const TODAY = "2026-09-29";

type Ev = [code: string, start: string | null, end: string | null];
interface Ht { model: string; ty: string; excl: number | null; supply: number | null; price: number | null }
export interface MockAnn {
  id: string; family: "apt" | "remndr" | "urbty_ofctl"; name: string; region: [string, string]; rcrit: string | null;
  events: Ev[]; types: Ht[]; url?: string | null; total?: number;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// 사례: 확정 일치, 예산 초과(미확인), 전용면적 없음(미확인), 가격 없음, 잔여세대, 종료, 오피스텔(전용면적 있음)
export const BASE_ANNS: MockAnn[] = [
  { id: uuid(1), family: "apt", name: "테스트 일치 단지", region: ["410", "경기"], rcrit: "2026-09-20", total: 300,
    events: [["rcept", "2026-09-28", "2026-09-30"]], types: [{ model: "01", ty: "084A", excl: null, supply: 110.5, price: 550_000_000 }] },
  { id: uuid(2), family: "urbty_ofctl", name: "테스트 오피스텔", region: ["100", "서울"], rcrit: "2026-09-19", total: 120,
    events: [["subscrpt_rcept", "2026-10-02", "2026-10-03"]],
    types: [{ model: "01", ty: "59A", excl: 59.0, supply: null, price: 580_000_000 }, { model: "02", ty: "84A", excl: 84.0, supply: null, price: 900_000_000 }] },
  { id: uuid(3), family: "apt", name: "테스트 고가 단지", region: ["100", "서울"], rcrit: "2026-09-18", total: 80,
    events: [["rcept", "2026-09-29", "2026-10-01"]], types: [{ model: "01", ty: "084B", excl: null, supply: 105, price: 1_200_000_000 }] },
  { id: uuid(4), family: "remndr", name: "테스트 무순위", region: ["410", "경기"], rcrit: "2026-09-17", total: 20,
    events: [["subscrpt_rcept", "2026-09-30", "2026-09-30"]], types: [{ model: "01", ty: "084C", excl: null, supply: null, price: null }] },
  { id: uuid(5), family: "apt", name: "테스트 종료 단지", region: ["400", "인천"], rcrit: "2026-08-01", total: 500,
    events: [["rcept", "2026-08-10", "2026-08-12"]], types: [{ model: "01", ty: "084D", excl: null, supply: 99, price: 700_000_000 }] },
];

const toRow = (a: MockAnn) => ({
  id: a.id, source_family: a.family, source_subtype: a.family === "remndr" ? "04" : null, house_manage_no: a.id.slice(-6), pblanc_no: a.id.slice(-6),
  house_nm: a.name, house_secd: a.family === "apt" ? "01" : null, house_dtl_secd: null, rcrit_pblanc_de: a.rcrit, hssply_adres: `${a.region[1]} 테스트로 1`,
  source_region_code: a.region[0], source_region_name: a.region[1], tot_suply_hshldco: a.total ?? 10, bsns_mby_nm: "사업주체(익명)",
  mdhs_telno: "00000000", pblanc_url: a.url === undefined ? `https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=${a.id.slice(-6)}` : a.url,
  min_price_krw: null, max_price_krw: null, last_seen_at: "2026-09-29T00:00:00Z",
  cheongyak_housing_types: a.types.map((t) => ({
    id: `${a.id}-${t.model}`, source_model_key: t.model, house_ty: t.ty, exclusive_area_sqm: t.excl, supply_area_sqm: t.supply,
    general_supply_count: 1, special_supply_count: 0, price_max_krw: t.price, price_raw: t.price === null ? null : String(t.price / 10000),
    price_source_unit: t.price === null ? "UNKNOWN" : "MANWON", housing_type_special_supply: [],
  })),
  announcement_events: a.events.map(([code, s, e]) => ({ source_event_code: code, scope_code: "all", starts_on: s, ends_on: e })),
});

export interface MockOptions {
  anns?: MockAnn[];
  lastSync?: string | null;
  delayMs?: number; // 목록 응답 지연(로딩 상태 검증용)
  failAfterPages?: number; // 이 페이지 수 뒤 오류(부분 로딩 검증용)
  failOnce?: boolean; // true면 오류는 한 번만(다시 시도 검증용)
  maxRows?: number; // 서버(PostgREST max_rows)가 요청한 limit보다 적게 돌려주는 상황을 흉내 낸다
  requests?: string[]; // 목록 요청의 or 파라미터 기록
  auth?: { userId: string; email: string }; // 지정하면 이 사용자로 로그인된 세션을 브라우저에 주입한다
  serverFilters?: Record<string, unknown>; // 사용자 ID -> user_filter_settings 행(서버에 이미 저장된 필터)
  serverBookmarks?: string[]; // 이미 북마크한 공고 ID
  failUpsert?: boolean; // 필터 저장(upsert)을 실패시킨다
  failFilterGet?: boolean; // 필터 조회를 실패시킨다(핸들의 failFilterGet을 false로 바꾸면 복구). 5xx는 supabase-js가 재시도하므로 재시도되지 않는 403으로 흉내 낸다
}

/** 정렬(rcrit desc nulls last, id asc)과 or 커서 필터를 서버처럼 처리해 페이지를 돌려준다. */
function pageOf(rows: ReturnType<typeof toRow>[], url: URL) {
  const sorted = [...rows].sort((a, b) => {
    if (a.rcrit_pblanc_de !== b.rcrit_pblanc_de) {
      if (a.rcrit_pblanc_de === null) return 1;
      if (b.rcrit_pblanc_de === null) return -1;
      return a.rcrit_pblanc_de > b.rcrit_pblanc_de ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
  const or = url.searchParams.get("or");
  let out = sorted;
  if (or) {
    const m = /rcrit_pblanc_de\.lt\.(\d{4}-\d{2}-\d{2}),and\(rcrit_pblanc_de\.eq\.\1,id\.gt\.([^)]+)\)/.exec(or);
    const n = /^\(and\(rcrit_pblanc_de\.is\.null,id\.gt\.([^)]+)\)\)$/.exec(or);
    if (m) out = sorted.filter((r) => r.rcrit_pblanc_de === null || r.rcrit_pblanc_de < m[1]! || (r.rcrit_pblanc_de === m[1] && r.id > m[2]!));
    else if (n) out = sorted.filter((r) => r.rcrit_pblanc_de === null && r.id > n[1]!);
    else throw new Error("mock: unsupported or filter " + or);
  }
  return out.slice(0, Number(url.searchParams.get("limit") ?? 1000));
}

export interface MockHandle {
  filterUpserts: Record<string, any>[]; // 앱이 보낸 필터 저장 요청 본문
  bookmarkWrites: { op: "add" | "remove"; id: string }[];
  logoutCalls: number;
  failFilterGet: boolean;
  serverFilters: Record<string, any>;
  bookmarks: Set<string>;
}

const b64url = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

/** supabase-js가 읽는 localStorage 세션 키(sb-<프로젝트 ref>-auth-token). 빌드에 박힌 Supabase URL에서 ref를 얻는다. */
export function authStorageKey(): string {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url) {
    const envFile = path.resolve(process.cwd(), ".env.local");
    if (fs.existsSync(envFile)) url = /^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m.exec(fs.readFileSync(envFile, "utf8"))?.[1]?.trim() ?? "";
  }
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL을 알 수 없어 세션 키를 만들 수 없음(.env.local 필요)");
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
}

function fakeSession(userId: string, email: string) {
  // 서명 없는 JWT 형태(검증은 서버 몫이고 이 테스트의 서버는 모의다). 만료는 아주 먼 미래로 둔다.
  const exp = 4102444800;
  const token = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: userId, email, role: "authenticated", exp })}.sig`;
  return { access_token: token, refresh_token: "refresh-fake", token_type: "bearer", expires_in: 3600, expires_at: exp,
    user: { id: userId, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } };
}

export async function installMock(page: Page, opts: MockOptions = {}): Promise<MockHandle> {
  const rows = (opts.anns ?? BASE_ANNS).map(toRow);
  let listCalls = 0;
  let failed = false;
  const handle: MockHandle = { filterUpserts: [], bookmarkWrites: [], logoutCalls: 0, failFilterGet: !!opts.failFilterGet, serverFilters: { ...(opts.serverFilters ?? {}) }, bookmarks: new Set(opts.serverBookmarks ?? []) };
  if (opts.auth) {
    const key = authStorageKey();
    const value = JSON.stringify(fakeSession(opts.auth.userId, opts.auth.email));
    // 로그아웃 뒤 새로고침에서 세션이 되살아나지 않도록, 한 번의 브라우저 세션에서 처음 한 번만 주입한다
    await page.addInitScript(({ key, value }) => { if (!sessionStorage.getItem("__seeded_auth")) { localStorage.setItem(key, value); sessionStorage.setItem("__seeded_auth", "1"); } }, { key, value });
  }
  await page.addInitScript((now) => {
    const RealDate = Date;
    const fixed = new RealDate(now).getTime();
    // @ts-expect-error 테스트용 시각 고정
    globalThis.Date = class extends RealDate { constructor(...a: unknown[]) { if (a.length === 0) super(fixed); else super(...(a as [number])); } static now() { return fixed; } };
  }, FIXED_NOW);
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
  await page.route("**/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (url.pathname.endsWith("/data_status")) return json(route, opts.lastSync === undefined ? { last_successful_sync_at: "2026-09-29T00:10:00Z" } : { last_successful_sync_at: opts.lastSync });
    if (url.pathname.endsWith("/cheongyak_announcements")) {
      const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
      if (eq("house_manage_no")) { // 상세 조회
        const hit = rows.find((r) => r.source_family === eq("source_family") && r.house_manage_no === eq("house_manage_no") && r.pblanc_no === eq("pblanc_no"));
        return json(route, hit ?? null);
      }
      listCalls += 1;
      opts.requests?.push(url.searchParams.get("or") ?? "");
      if (opts.failAfterPages !== undefined && listCalls > opts.failAfterPages && !(opts.failOnce && failed)) {
        failed = true;
        return json(route, { message: "boom" }, 500);
      }
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const page = pageOf(rows, url);
      return json(route, opts.maxRows ? page.slice(0, opts.maxRows) : page);
    }
    const method = route.request().method();
    const userTable = /\/(user_filter_settings|user_bookmarks|push_subscriptions)$/.test(url.pathname);
    if (userTable) {
      // RLS 흉내: 사용자 토큰(Authorization: Bearer <로그인 세션 토큰>) 없이는 접근할 수 없다. 공개 키만 보내면 401.
      const authz = route.request().headers()["authorization"] ?? "";
      const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
      const isUserToken = !!opts.auth && token.split(".").length === 3 && (() => { try { return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub === opts.auth!.userId; } catch { return false; } })();
      if (!isUserToken) return json(route, { code: "42501", message: "permission denied (no user token)" }, 401);
    }
    const sub = opts.auth?.userId ?? "";
    // RLS 흉내(user_id = auth.uid()): 조회 조건·쓰기 본문의 user_id가 토큰 사용자와 다르면 거부한다.
    const scopedUid = userTable && method !== "GET" ? (() => { try { return (route.request().postDataJSON() as { user_id?: string } | null)?.user_id; } catch { return undefined; } })() : undefined;
    if (userTable && scopedUid !== undefined && scopedUid !== sub) return json(route, { code: "42501", message: "new row violates row-level security policy" }, 403);
    if (userTable && method === "GET") {
      const q = url.searchParams.get("user_id")?.replace(/^eq\./, "");
      if (q !== undefined && q !== sub) return json(route, url.pathname.endsWith("/user_filter_settings") ? null : [], 200); // RLS는 다른 사용자의 행을 조용히 걸러낸다
    }
    if (url.pathname.endsWith("/user_filter_settings")) {
      if (method === "GET") {
        if (handle.failFilterGet) return json(route, { code: "42501", message: "permission denied" }, 403); // 재시도되지 않는 오류(5xx는 supabase-js가 백오프로 재시도해 화면이 지연된다)
        const uid = url.searchParams.get("user_id")?.replace(/^eq\./, "") ?? "";
        return json(route, handle.serverFilters[uid] ?? null);
      }
      if (method === "POST") {
        const body = route.request().postDataJSON() as Record<string, any>;
        // upsert 형식: on_conflict=user_id 와 Prefer: resolution=merge-duplicates 가 없으면 PostgREST는 충돌 시 오류를 낸다
        if (url.searchParams.get("on_conflict") !== "user_id" || !(route.request().headers()["prefer"] ?? "").includes("resolution=merge-duplicates")) {
          return json(route, { code: "23505", message: "duplicate key (not an upsert request)" }, 409);
        }
        handle.filterUpserts.push(body);
        if (opts.failUpsert) return json(route, { code: "23514", message: "check violation" }, 400);
        handle.serverFilters[body.user_id] = body;
        return route.fulfill({ status: 201, body: "", headers: { "access-control-allow-origin": "*" } });
      }
    }
    if (url.pathname.endsWith("/user_bookmarks")) {
      if (method === "GET") {
        const ids = [...handle.bookmarks];
        if ((url.searchParams.get("select") ?? "").includes("cheongyak_announcements")) {
          return json(route, ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean).map((r) => ({ created_at: "2026-09-29T00:00:00Z", cheongyak_announcements: r })));
        }
        return json(route, ids.map((announcement_id) => ({ announcement_id })));
      }
      if (method === "POST") {
        const body = route.request().postDataJSON() as { announcement_id: string };
        handle.bookmarks.add(body.announcement_id);
        handle.bookmarkWrites.push({ op: "add", id: body.announcement_id });
        return route.fulfill({ status: 201, body: "", headers: { "access-control-allow-origin": "*" } });
      }
      if (method === "DELETE") {
        const id = url.searchParams.get("announcement_id")?.replace(/^eq\./, "") ?? "";
        handle.bookmarks.delete(id);
        handle.bookmarkWrites.push({ op: "remove", id });
        return route.fulfill({ status: 204, body: "", headers: { "access-control-allow-origin": "*" } });
      }
    }
    if (url.pathname.endsWith("/push_subscriptions")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]", headers: { "access-control-allow-origin": "*", "content-range": "*/0" } });
    }
    return json(route, []);
  });
  await page.route("**/auth/v1/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith("/logout")) {
      handle.logoutCalls += 1;
      return route.fulfill({ status: 204, body: "", headers: { "access-control-allow-origin": "*" } });
    }
    if (u.pathname.endsWith("/user") && opts.auth) return json(route, fakeSession(opts.auth.userId, opts.auth.email).user);
    return json(route, { user: null, session: null });
  });
  return handle;
}

/** 페이지 크기(200)를 넘는 대량 데이터: 모집공고일이 겹치고 일부는 날짜 없음. */
export function bulkAnns(n: number): MockAnn[] {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(1000 + i), family: "apt" as const, name: `대량 단지 ${i}`, region: ["410", "경기"] as [string, string],
    rcrit: i % 9 === 0 ? null : `2026-09-${String(1 + (i % 6)).padStart(2, "0")}`,
    events: [["rcept", "2026-09-28", "2026-09-30"]] as Ev[], types: [{ model: "01", ty: "084", excl: null, supply: 100, price: 500_000_000 }],
  }));
}
