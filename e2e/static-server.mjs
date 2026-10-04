// out/ 정적 내보내기 결과를 제공하는 의존성 없는 서버(E2E와 로컬 실행 공용: npm start / npm run local). 배포 환경(Firebase Hosting)의 정적 동작을 흉내 낸다:
// 경로가 /로 끝나면 index.html, 파일이 없으면 404.html. 캐시 헤더 없음(테스트 결정성).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
const port = Number(process.argv[2] ?? 3100);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon",
};

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  let rel = clean.endsWith("/") ? clean + "index.html" : clean;
  const full = path.resolve(root, "." + rel);
  const rel2 = path.relative(root, full);
  if (rel2.startsWith("..") || path.isAbsolute(rel2)) return null; // 경로 이탈 방지(접두사 비교가 아닌 상대 경로로 판정)
  try {
    const s = await stat(full);
    if (s.isFile()) return full;
    if (s.isDirectory()) return path.join(full, "index.html");
  } catch {
    /* 없음 */
  }
  return null;
}

createServer(async (req, res) => {
  try {
    let file = await resolveFile(req.url ?? "/");
    let status = 200;
    if (!file) {
      file = path.join(root, "404.html");
      status = 404;
    }
    const body = await readFile(file);
    res.writeHead(status, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(500);
    res.end();
  }
}).listen(port, "127.0.0.1");
