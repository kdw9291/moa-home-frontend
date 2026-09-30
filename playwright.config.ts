import { defineConfig } from "@playwright/test";

// 시스템에 설치된 Chrome을 사용한다(브라우저 바이너리를 내려받지 않는다). 사전 조건: `npm run build`로 out/ 생성.
// 서버 응답(Supabase REST)은 테스트에서 가로채 고정 데이터로 대체하므로 실제 DB·계정에 접근하지 않는다.
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: "chrome", trace: "off" },
  webServer: {
    command: `node e2e/static-server.mjs ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "ignore",
    timeout: 20_000,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
