import { isCalendarDate } from './calendar.js';
import { isDependencyLag, isDependencyType } from './schedule-dependencies.js';
import type { Dependency, Issue } from './types.js';

export const SCHEDULE_PASTE_MAX_ROWS = 500;
export const SCHEDULE_PASTE_MAX_BYTES = 128 * 1024;
export const SCHEDULE_PASTE_COLUMNS = {
  key: '업무 키',
  start: '시작일',
  end: '종료일',
  predecessor: '선행 업무',
  dependencyType: '연결 유형',
  lag: '근무일 간격',
} as const;

type ScheduleSheet = { ok: true; text: string } | { ok: false; error: string };

const keyOrder = new Intl.Collator('en', { numeric: true });
const spreadsheetFormulaPrefix = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]*[=+\-@＝＋－＠−]/u;

function isSheetKey(key: string) {
  return key.length > 0 && key.toUpperCase().length <= 200 && key === key.trim() &&
    !/\p{Cc}/u.test(key) && !spreadsheetFormulaPrefix.test(key);
}

function quoteKey(key: string) {
  return key.includes('"') ? `"${key.replaceAll('"', '""')}"` : key;
}

export function buildGanttScheduleSheet(
  issues: readonly Issue[], projectIssues: readonly Issue[], dependencies: readonly Dependency[],
): ScheduleSheet {
  if (!issues.length) return { ok: false, error: '내려받을 업무가 없습니다.' };
  const projectId = issues[0].projectId;
  const byId = new Map<string, Issue | null>();
  const byKey = new Map<string, Issue | null>();
  for (const issue of projectIssues) {
    if (issue.projectId !== projectId) continue;
    const key = issue.key.toUpperCase();
    byId.set(issue.id, byId.has(issue.id) ? null : issue);
    byKey.set(key, byKey.has(key) ? null : issue);
  }

  const selectedIds = new Set(issues.map(issue => issue.id));
  if (selectedIds.size !== issues.length) return { ok: false, error: '내려받을 업무가 중복되어 있습니다.' };
  const incoming = new Map<string, Dependency[]>();
  for (const link of dependencies) {
    if (!selectedIds.has(link.successorId)) continue;
    const links = incoming.get(link.successorId);
    if (links) links.push(link);
    else incoming.set(link.successorId, [link]);
  }

  const rows: string[] = [];
  for (const selected of issues) {
    if (selected.projectId !== projectId) return { ok: false, error: '한 프로젝트의 업무만 내려받을 수 있습니다.' };
    const issue = byId.get(selected.id);
    if (!issue || issue.key !== selected.key) {
      return { ok: false, error: '업무 정보를 새로고침한 뒤 다시 내려받아 주세요.' };
    }
    if (!isSheetKey(issue.key) || byKey.get(issue.key.toUpperCase()) !== issue) {
      return { ok: false, error: '내려받을 업무의 키를 확인해 주세요.' };
    }
    if ((issue.startDate !== null && !isCalendarDate(issue.startDate)) ||
        (issue.endDate !== null && !isCalendarDate(issue.endDate))) {
      return { ok: false, error: '내려받을 업무의 날짜를 확인해 주세요.' };
    }

    const links = incoming.get(issue.id) ?? [];
    const seen = new Set<string>();
    const predecessors: { key: string; link: Dependency }[] = [];
    for (const link of links) {
      const predecessor = byId.get(link.predecessorId);
      if (!predecessor || predecessor.id === issue.id || seen.has(predecessor.id) ||
          !isSheetKey(predecessor.key) || byKey.get(predecessor.key.toUpperCase()) !== predecessor ||
          !isDependencyType(link.type) || !isDependencyLag(link.lagDays)) {
        return { ok: false, error: '내려받을 업무의 선행 연결을 확인해 주세요.' };
      }
      seen.add(predecessor.id);
      predecessors.push({ key: predecessor.key, link });
    }

    if (rows.length + Math.max(predecessors.length, 1) > SCHEDULE_PASTE_MAX_ROWS) {
      return { ok: false, error: `일정표는 ${SCHEDULE_PASTE_MAX_ROWS}행까지 내려받을 수 있습니다. 업무를 줄여 다시 시도해 주세요.` };
    }
    const dates = [quoteKey(issue.key), issue.startDate ?? '', issue.endDate ?? ''];
    if (!predecessors.length) rows.push([...dates, '', '', ''].join('\t'));
    predecessors.sort((a, b) => keyOrder.compare(a.key, b.key) || a.key.localeCompare(b.key, 'en'));
    for (const [index, predecessor] of predecessors.entries()) {
      rows.push([
        ...(index === 0 ? dates : [dates[0], '', '']),
        quoteKey(predecessor.key), predecessor.link.type, String(predecessor.link.lagDays),
      ].join('\t'));
    }
  }

  const text = `\uFEFF${[Object.values(SCHEDULE_PASTE_COLUMNS).join('\t'), ...rows].join('\r\n')}\r\n`;
  if (new TextEncoder().encode(text).length > SCHEDULE_PASTE_MAX_BYTES) {
    return { ok: false, error: '일정표는 UTF-8 기준 128 KiB까지 내려받을 수 있습니다. 업무를 줄여 다시 시도해 주세요.' };
  }
  return { ok: true, text };
}
