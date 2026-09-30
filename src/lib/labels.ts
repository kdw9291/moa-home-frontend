// 원천 코드의 표시 이름. 코드 정의는 청약홈 API Swagger의 필드 설명에서 확인된 것만 쓴다.
import type { Announcement, AnnouncementEvent, Family } from "./types";
import { receiptPhase, type ReceiptPhase } from "./dates";

export const FAMILY_LABEL: Record<Family, string> = {
  apt: "APT",
  remndr: "잔여세대",
  urbty_ofctl: "오피스텔·도시형",
};

const APT_HOUSE_SECD: Record<string, string> = { "01": "APT", "09": "민간사전청약", "10": "신혼희망타운" };
const REMNDR_SECD: Record<string, string> = { "04": "무순위", "06": "불법행위 재공급" };
const URBTY_SEARCH_SECD: Record<string, string> = {
  "0201": "도시형생활주택",
  "0202": "오피스텔",
  "0203": "민간임대",
  "0204": "생활형숙박시설",
  "0303": "공공지원민간임대",
};

/** 원천 세부 유형 라벨. 알려진 코드만 이름으로, 그 외는 코드를 그대로 보여 준다(공고명 추정 없음). */
export function subtypeLabel(a: Announcement): string | null {
  if (a.source_family === "remndr") {
    return a.source_subtype ? (REMNDR_SECD[a.source_subtype] ?? `원천 코드 ${a.source_subtype}`) : null;
  }
  if (a.source_family === "urbty_ofctl") {
    return a.source_subtype ? (URBTY_SEARCH_SECD[a.source_subtype] ?? `원천 코드 ${a.source_subtype}`) : null;
  }
  return a.house_secd ? (APT_HOUSE_SECD[a.house_secd] ?? `원천 코드 ${a.house_secd}`) : null;
}

// 백엔드가 원천 필드 접두어에서 딴 임시 이벤트 코드(의미 검증 대기). 화면에는 '원천 필드 기준'임을 밝힌다.
const RANK_SCOPE: Record<string, string> = { crsparea: "해당지역", etc_gg: "경기지역", etc_area: "기타지역" };
export function eventLabel(e: AnnouncementEvent): string {
  switch (e.source_event_code) {
    case "rcept": return "청약 접수";
    case "spsply_rcept": return "특별공급 접수";
    case "gnrl_rcept": return "일반공급 접수";
    case "subscrpt_rcept": return "청약 접수";
    case "gnrl_rnk1": return `1순위 접수 · ${RANK_SCOPE[e.scope_code] ?? e.scope_code}`;
    case "gnrl_rnk2": return `2순위 접수 · ${RANK_SCOPE[e.scope_code] ?? e.scope_code}`;
    case "przwner_presnatn": return "당첨자 발표";
    case "cntrct_cncls": return "계약";
    default: return `${e.source_event_code}${e.scope_code !== "all" ? ` · ${e.scope_code}` : ""}`;
  }
}

const RECEIPT_CODES = new Set(["rcept", "spsply_rcept", "gnrl_rcept", "subscrpt_rcept", "gnrl_rnk1", "gnrl_rnk2"]);

export function receiptEvents(a: Announcement): AnnouncementEvent[] {
  return a.announcement_events.filter((e) => RECEIPT_CODES.has(e.source_event_code));
}

export interface AnnouncementStatus {
  phase: ReceiptPhase; // 가장 관련 있는 접수 기간의 상태
  nextEndsOn: string | null; // 아직 끝나지 않은 접수 중 가장 이른 종료일(마감 임박 정렬용)
  active: boolean; // 접수 예정 또는 진행 중
}

/** 접수 이벤트 전체를 보고 오늘 기준 대표 상태를 고른다: 접수 중 > 접수일 > 접수 예정(가장 가까운 시작) > 종료. */
export function announcementStatus(a: Announcement, today: string): AnnouncementStatus {
  const phases = receiptEvents(a).map((e) => ({ e, p: receiptPhase(today, e.starts_on, e.ends_on) }));
  // 날짜가 부분적으로만 있어 종료 여부를 알 수 없는 접수(unknown)는 종료로 단정하지 않고 진행 대상에 둔다
  const live = phases.filter((x) => x.p.kind !== "ended" && (x.p.kind !== "unknown" || x.e.starts_on || x.e.ends_on));
  if (live.length === 0) {
    return { phase: phases.some((x) => x.p.kind === "ended") ? { kind: "ended" } : { kind: "unknown" }, nextEndsOn: null, active: false };
  }
  const rank = (p: ReceiptPhase) => (p.kind === "ongoing" ? 0 : p.kind === "today" ? 1 : p.kind === "upcoming" ? 2 + p.days : 500);
  live.sort((x, y) => rank(x.p) - rank(y.p));
  // 종료일이 실제로 알려진 접수만 마감 임박 정렬에 쓴다(시작일을 종료일로 대신하지 않음)
  const ends = live.map((x) => x.e.ends_on).filter((d): d is string => !!d && d >= today).sort();
  return { phase: live[0]!.p, nextEndsOn: ends[0] ?? null, active: true };
}

export function phaseLabel(p: ReceiptPhase): string {
  switch (p.kind) {
    case "upcoming": return `접수 예정 D-${p.days}`;
    case "today": return "접수일";
    case "ongoing": return p.endsInDays === 0 ? "접수 중 · 오늘 마감" : `접수 중 · D-${p.endsInDays}`;
    case "ended": return "접수 종료";
    default: return "일정 확인 필요";
  }
}
