import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSchedulePaste } from '../../server/schedule-paste-parser.js';
import { buildGanttScheduleSheet, SCHEDULE_PASTE_MAX_BYTES, SCHEDULE_PASTE_MAX_ROWS } from '../../shared/schedule-paste-format.js';
import type { Dependency, Issue } from '../../shared/types.js';

const stamp = '2026-11-21T00:00:00Z';
const makeIssue = (key: string, fields: Partial<Issue> = {}): Issue => ({
  id: `issue:${key}`, projectId: 'team', key, title: '=UNEXPORTED()', description: '내용',
  type: '작업', status: 'todo', priority: 'medium', assigneeId: null, collaboratorIds: [],
  parentId: null, labels: [], startDate: null, endDate: null, dueDate: null, estimate: null,
  cycle: null, module: null, release: null, version: 1, createdAt: stamp, updatedAt: stamp,
  completedAt: null, ...fields,
});

const dependency = (from: Issue, to: Issue, type: Dependency['type'], lagDays: number): Dependency => ({
  id: `${from.id}/${to.id}`, predecessorId: from.id, successorId: to.id, type, lagDays,
});

function sheetText(result: ReturnType<typeof buildGanttScheduleSheet>) {
  if (!result.ok) assert.fail(result.error);
  return result.text;
}

function sheetError(result: ReturnType<typeof buildGanttScheduleSheet>) {
  if (result.ok) assert.fail('Invalid schedule sheet was built');
  return result.error;
}

test('schedule sheet roundtrips saved dates and sorted inbound dependencies for selected successors', () => {
  const hidden = makeIssue('TEAM-2');
  const quoted = makeIssue('TEAM-10"old');
  const successor = makeIssue('TEAM-14', { startDate: '2026-11-23', dueDate: '2026-11-30' });
  const unscheduled = makeIssue('TEAM-1');
  const projects = [hidden, quoted, successor, unscheduled];
  const links = [dependency(quoted, successor, 'SF', 0), dependency(hidden, successor, 'FF', -2), dependency(unscheduled, hidden, 'SS', 3)];
  const selected = [successor, unscheduled];
  const exported = sheetText(buildGanttScheduleSheet(selected, projects, links));
  assert.equal(exported, [
    '\uFEFF업무 키\t시작일\t종료일\t목표 마감일\t선행 업무\t연결 유형\t근무일 간격',
    'TEAM-14\t2026-11-23\t\t2026-11-30\tTEAM-2\tFF\t-2',
    'TEAM-14\t\t\t\t"TEAM-10""old"\tSF\t0',
    'TEAM-1\t\t\t\t\t\t',
    '',
  ].join('\r\n'));
  assert.equal(sheetText(buildGanttScheduleSheet(selected, projects.toReversed(), links.toReversed())), exported);
  assert.deepEqual(parseSchedulePaste(exported), {
    rows: [
      { line: 2, key: 'TEAM-14', startDate: '2026-11-23', endDate: undefined, dueDate: '2026-11-30', dependency: { predecessorKey: 'TEAM-2', type: 'FF', lagDays: -2 } },
      { line: 3, key: 'TEAM-14', startDate: undefined, endDate: undefined, dependency: { predecessorKey: 'TEAM-10"OLD', type: 'SF', lagDays: 0 } },
      { line: 4, key: 'TEAM-1', startDate: undefined, endDate: undefined },
    ],
    errors: [],
  });
});

test('schedule sheet fails explicitly for ambiguous keys, invalid dates or links, and mixed projects', () => {
  const first = makeIssue('TEAM-1');
  const second = makeIssue('TEAM-2');
  const other = makeIssue('OPS-1', { projectId: 'ops' });
  const projects = [first, second, other];
  const link = dependency(second, first, 'FS', 0);
  assert.match(sheetError(buildGanttScheduleSheet([first, other], projects, [])), /한 프로젝트/);
  assert.match(sheetError(buildGanttScheduleSheet([first], [second], [])), /새로고침/);
  const unsafe = makeIssue('\u200b=UNSAFE()');
  assert.match(sheetError(buildGanttScheduleSheet([unsafe], [unsafe], [])), /업무의 키/);
  const duplicateKey = makeIssue('team-1');
  assert.match(sheetError(buildGanttScheduleSheet([first], [...projects, duplicateKey], [])), /업무의 키/);
  const invalidDeadline = makeIssue('TEAM-3', { dueDate: '2026-11-31' });
  assert.match(sheetError(buildGanttScheduleSheet([invalidDeadline], [invalidDeadline], [])), /업무의 날짜/);
  for (const links of [
    [dependency(other, first, 'FS', 0)], [dependency(first, first, 'FS', 0)],
    [{ ...link, lagDays: 3651 }], [link, { ...link, id: 'duplicate' }],
  ]) {
    assert.match(sheetError(buildGanttScheduleSheet([first], projects, links)), /선행 연결/);
  }
});

test('schedule sheet applies the paste row limit to the number of dependency rows', () => {
  const successor = makeIssue('TEAM-1');
  const predecessors = Array.from({ length: SCHEDULE_PASTE_MAX_ROWS }, (_, index) => makeIssue(`TEAM-${index + 2}`));
  const issues = [successor, ...predecessors];
  const links = predecessors.map(issue => dependency(issue, successor, 'FS', 0));
  const exported = sheetText(buildGanttScheduleSheet([successor], issues, links));
  const result = parseSchedulePaste(exported);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, SCHEDULE_PASTE_MAX_ROWS);
  assert.match(sheetError(buildGanttScheduleSheet([successor, predecessors[0]], issues, links)), /500행/);
});

test('schedule sheet counts UTF-8 exactly at the parser byte limit, including BOM', () => {
  const base = Array.from({ length: SCHEDULE_PASTE_MAX_ROWS }, (_, index) => makeIssue(`TEAM-${index + 1}`));
  let remaining = SCHEDULE_PASTE_MAX_BYTES - Buffer.byteLength(sheetText(buildGanttScheduleSheet(base, base, [])), 'utf8');
  const filled = base.map(issue => {
    const bytes = Math.min(500, remaining);
    remaining -= bytes;
    return { ...issue, key: `${issue.key}${'가'.repeat(Math.floor(bytes / 3))}${'x'.repeat(bytes % 3)}` };
  });
  assert.equal(remaining, 0);
  const exported = sheetText(buildGanttScheduleSheet(filled, filled, []));
  assert.equal(Buffer.byteLength(exported, 'utf8'), SCHEDULE_PASTE_MAX_BYTES);
  const result = parseSchedulePaste(exported);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, SCHEDULE_PASTE_MAX_ROWS);
  const oversize = filled.map((issue, index) => index === filled.length - 1 ? { ...issue, key: `${issue.key}x` } : issue);
  assert.match(sheetError(buildGanttScheduleSheet(oversize, oversize, [])), /128 KiB/);
});
