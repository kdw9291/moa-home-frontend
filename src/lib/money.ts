const EOK = 100_000_000;
const MAN = 10_000;

/** 원 → '5억 8,000만원'. 값이 없으면 null(호출부가 '확인 필요'를 표시). */
export function formatKrw(krw: number | null): string | null {
  if (krw === null || !Number.isFinite(krw) || krw < 0) return null;
  const totalMan = Math.round(krw / MAN); // 만원 단위 반올림 후 올림 자리 처리
  const eok = Math.floor(totalMan / (EOK / MAN));
  const man = totalMan % (EOK / MAN);
  const parts: string[] = [];
  if (eok > 0) parts.push(`${eok.toLocaleString("ko-KR")}억`);
  if (man > 0) parts.push(`${man.toLocaleString("ko-KR")}만`);
  if (parts.length === 0) return "0원";
  return parts.join(" ") + "원";
}

export function eokToKrw(eok: number): number {
  return Math.round(eok * EOK);
}
