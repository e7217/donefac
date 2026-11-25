import { isCalendarDate } from './calendar.js';
import { isDependencyLag, isDependencyType } from './schedule-dependencies.js';
import type { Dependency, Issue } from './types.js';

export const SCHEDULE_PASTE_MAX_ROWS = 500;
export const SCHEDULE_PASTE_MAX_BYTES = 128 * 1024;
export const SCHEDULE_PASTE_COLUMNS = {
  key: '업무 키',
  start: '시작일',
  end: '종료일',
  due: '목표 마감일',
  predecessor: '선행 업무',
  dependencyType: '연결 유형',
  lag: '근무일 간격',
  baseline: '내보낸 기준',
} as const;

export type ScheduleSheetBaseline = Pick<Issue, 'startDate' | 'endDate' | 'dueDate'> & {
  issueId: string;
  dependency: (Pick<Dependency, 'id' | 'predecessorId' | 'type' | 'lagDays'> & { predecessorKey: string }) | null;
};
type ScheduleSheet = { ok: true; text: string } | { ok: false; error: string };

const keyOrder = new Intl.Collator('en', { numeric: true });
const spreadsheetFormulaPrefix = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]*[=+\-@＝＋－＠−]/u;

function isSheetKey(key: string) {
  return key.length > 0 && key.toUpperCase().length <= 200 && key === key.trim() && key.isWellFormed() &&
    !/\p{Cc}/u.test(key) && !spreadsheetFormulaPrefix.test(key);
}

function quoteKey(key: string) {
  return key.includes('"') ? `"${key.replaceAll('"', '""')}"` : key;
}

function validIdentifier(value: string) {
  return value.length <= 200 && Boolean(value.trim()) && value.isWellFormed() && !/\p{Cc}/u.test(value);
}

function baselineCell(issue: Issue, predecessor?: { key: string; link: Dependency }): string {
  const link = predecessor?.link;
  return ['1', encodeURIComponent(issue.id), issue.startDate ?? '-', issue.endDate ?? '-', issue.dueDate ?? '-',
    ...(link ? [encodeURIComponent(link.id), encodeURIComponent(link.predecessorId), encodeURIComponent(predecessor.key), link.type, String(link.lagDays)] : []),
  ].join('|');
}

export function parseScheduleSheetBaseline(cell: string): ScheduleSheetBaseline | undefined {
  const fields = cell.split('|');
  if (fields.length !== 5 && fields.length !== 10) return;
  const [version, encodedIssue, start, end, due, encodedLink, encodedPredecessor, encodedKey, type, lag] = fields;
  if (version !== '1' || ![start, end, due].every(date => date === '-' || isCalendarDate(date))) return;
  const date = (value: string) => value === '-' ? null : value;
  try {
    const issueId = decodeURIComponent(encodedIssue);
    if (!validIdentifier(issueId)) return;
    const dates = { issueId, startDate: date(start), endDate: date(end), dueDate: date(due) };
    if (fields.length === 5) return { ...dates, dependency: null };
    const id = decodeURIComponent(encodedLink), predecessorId = decodeURIComponent(encodedPredecessor), lagDays = Number(lag);
    const key = decodeURIComponent(encodedKey);
    if (!validIdentifier(id) || !validIdentifier(predecessorId) || predecessorId === issueId || !isDependencyType(type) ||
        !isSheetKey(key) || !/^-?\d+$/u.test(lag) || !isDependencyLag(lagDays)) return;
    return { ...dates, dependency: { id, predecessorId, predecessorKey: key.toUpperCase(), type, lagDays } };
  } catch { return; }
}

export function buildGanttScheduleSheet(
  issues: readonly Issue[], projectIssues: readonly Issue[], dependencies: readonly Dependency[],
): ScheduleSheet {
  return buildScheduleSheet(issues, projectIssues, dependencies, issues[0]?.projectId);
}

export function buildTeamGanttScheduleSheet(
  issues: readonly Issue[], workspaceIssues: readonly Issue[], dependencies: readonly Dependency[],
): ScheduleSheet {
  return buildScheduleSheet(issues, workspaceIssues, dependencies);
}

function buildScheduleSheet(
  issues: readonly Issue[], availableIssues: readonly Issue[], dependencies: readonly Dependency[], projectId?: string,
): ScheduleSheet {
  if (!issues.length) return { ok: false, error: '내려받을 업무가 없습니다.' };
  const byId = new Map<string, Issue | null>();
  const byKey = new Map<string, Issue | null>();
  for (const issue of availableIssues) {
    if (projectId !== undefined && issue.projectId !== projectId) continue;
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
    if (projectId !== undefined && selected.projectId !== projectId) {
      return { ok: false, error: '한 프로젝트의 업무만 내려받을 수 있습니다.' };
    }
    const issue = byId.get(selected.id);
    if (!issue || issue.key !== selected.key || issue.projectId !== selected.projectId) {
      return { ok: false, error: '업무 정보를 새로고침한 뒤 다시 내려받아 주세요.' };
    }
    if (!validIdentifier(issue.id) || !isSheetKey(issue.key) || byKey.get(issue.key.toUpperCase()) !== issue) {
      return { ok: false, error: '내려받을 업무의 키를 확인해 주세요.' };
    }
    if ((issue.startDate !== null && !isCalendarDate(issue.startDate)) ||
        (issue.endDate !== null && !isCalendarDate(issue.endDate)) ||
        (issue.dueDate != null && !isCalendarDate(issue.dueDate))) {
      return { ok: false, error: '내려받을 업무의 날짜를 확인해 주세요.' };
    }

    const links = incoming.get(issue.id) ?? [];
    const seen = new Set<string>();
    const predecessors: { key: string; link: Dependency }[] = [];
    for (const link of links) {
      const predecessor = byId.get(link.predecessorId);
      if (!predecessor || predecessor.projectId !== issue.projectId || predecessor.id === issue.id || seen.has(predecessor.id) ||
          !validIdentifier(predecessor.id) || !validIdentifier(link.id) ||
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
    const dates = [quoteKey(issue.key), issue.startDate ?? '', issue.endDate ?? '', issue.dueDate ?? ''];
    if (!predecessors.length) rows.push([...dates, '', '', '', baselineCell(issue)].join('\t'));
    predecessors.sort((a, b) => keyOrder.compare(a.key, b.key) || a.key.localeCompare(b.key, 'en'));
    for (const [index, predecessor] of predecessors.entries()) {
      rows.push([
        ...(index === 0 ? dates : [dates[0], '', '', '']),
        quoteKey(predecessor.key), predecessor.link.type, String(predecessor.link.lagDays), baselineCell(issue, predecessor),
      ].join('\t'));
    }
  }

  const text = `\uFEFF${[Object.values(SCHEDULE_PASTE_COLUMNS).join('\t'), ...rows].join('\r\n')}\r\n`;
  if (new TextEncoder().encode(text).length > SCHEDULE_PASTE_MAX_BYTES) {
    return { ok: false, error: '일정표는 UTF-8 기준 128 KiB까지 내려받을 수 있습니다. 업무를 줄여 다시 시도해 주세요.' };
  }
  return { ok: true, text };
}
