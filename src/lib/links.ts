// 공식 공고 링크는 청약홈(applyhome.co.kr)의 https 주소일 때만 '공식'으로 연결한다.
const OFFICIAL_HOSTS = ["applyhome.co.kr"];

export function safeOfficialUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    return OFFICIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? u.toString() : null;
  } catch {
    return null;
  }
}
