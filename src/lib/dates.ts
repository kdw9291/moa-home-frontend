// 날짜는 한국 달력 날짜(YYYY-MM-DD)다. D-Day는 Asia/Seoul의 오늘과 비교하며 임의 마감 시각을 붙이지 않는다.
const kstFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function kstToday(now: Date = new Date()): string {
  return kstFormatter.format(now); // en-CA는 YYYY-MM-DD
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) / 86_400_000;
}

/** 양수=남은 일수, 0=당일, 음수=지남 */
export function dDay(today: string, target: string): number {
  return dayNumber(target) - dayNumber(today);
}

export type ReceiptPhase =
  | { kind: "upcoming"; days: number }
  | { kind: "today" }
  | { kind: "ongoing"; endsInDays: number }
  | { kind: "ended" }
  | { kind: "unknown" };

/** 접수 기간(start~end, 날짜만)의 오늘 기준 상태. 당일 시작은 '접수일', 기간 중은 '접수 중'. */
export function receiptPhase(today: string, start: string | null, end: string | null): ReceiptPhase {
  if (!start && !end) return { kind: "unknown" };
  if (!start || !end) {
    // 한쪽 날짜만 알면 알 수 있는 사실만 말하고 나머지는 추측하지 않는다(하루짜리 기간으로 만들지 않음)
    if (start) {
      const until = dDay(today, start);
      return until > 0 ? { kind: "upcoming", days: until } : until === 0 ? { kind: "today" } : { kind: "unknown" };
    }
    return dDay(today, end!) < 0 ? { kind: "ended" } : { kind: "unknown" };
  }
  const s = start;
  const e = end;
  if (dDay(today, e) < 0) return { kind: "ended" };
  const untilStart = dDay(today, s);
  if (untilStart > 0) return { kind: "upcoming", days: untilStart };
  if (untilStart === 0) return { kind: "today" };
  return { kind: "ongoing", endsInDays: dDay(today, e) };
}

export const STALE_HOURS = 26;

/** 마지막 수집 성공이 26시간을 넘었거나 기록이 없으면 갱신 지연. */
export function isStale(lastSuccessAt: string | null, now: Date = new Date()): boolean {
  if (!lastSuccessAt) return true;
  const t = Date.parse(lastSuccessAt);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > STALE_HOURS * 3_600_000;
}

export function formatDateDots(iso: string): string {
  return iso.replaceAll("-", ".");
}
