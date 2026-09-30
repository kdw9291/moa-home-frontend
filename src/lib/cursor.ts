// 키셋(커서) 페이지: 정렬 (모집공고일 내림차순·null 마지막, id 오름차순)에서 '마지막으로 본 행 다음'을 가리킨다.
// 오프셋 페이지와 달리 이미 받은 구간 뒤의 행을 중복하거나 건너뛰지 않는다. 다만 스냅샷은 아니어서, 로딩 도중 커서 앞쪽에
// 새로 생기거나 정렬 위치가 바뀐 행은 이번 로딩에서 빠질 수 있다(새로고침하면 보인다).
export interface Cursor {
  rcrit: string | null; // 마지막 행의 rcrit_pblanc_de (YYYY-MM-DD) 또는 null
  id: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-fA-F-]{8,40}$/;

/** PostgREST `.or()` 필터 문자열. 값은 형식을 검증해 필터 구문 주입을 막는다. null 커서 뒤에는 null 그룹만 남는다. */
export function cursorOrFilter(c: Cursor): string {
  if (!UUID.test(c.id) || (c.rcrit !== null && !DATE.test(c.rcrit))) throw new Error("잘못된 커서");
  if (c.rcrit === null) return `and(rcrit_pblanc_de.is.null,id.gt.${c.id})`;
  // 정렬은 날짜 내림차순(null 마지막): 더 이른 날짜, 같은 날짜의 더 큰 id, 그리고 날짜가 없는 행 전부
  return `rcrit_pblanc_de.lt.${c.rcrit},and(rcrit_pblanc_de.eq.${c.rcrit},id.gt.${c.id}),rcrit_pblanc_de.is.null`;
}

export function cursorOf(last: { rcrit_pblanc_de: string | null; id: string }): Cursor {
  return { rcrit: last.rcrit_pblanc_de, id: last.id };
}

/** 커서 정렬 순서에 맞는 비교(정렬 검증·테스트용): 음수면 a가 b보다 앞. */
export function compareByCursorOrder(a: Cursor, b: Cursor): number {
  if (a.rcrit !== b.rcrit) {
    if (a.rcrit === null) return 1;
    if (b.rcrit === null) return -1;
    return a.rcrit > b.rcrit ? -1 : 1; // 최신 날짜가 앞
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
