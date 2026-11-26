import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMyWorkQueue, countActiveMyWork, myWorkMembership } from '../../shared/my-work.js';
import type { Issue, Project, WorkflowStatus } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';

const today = '2026-01-28';
const actor = 'operator';
const createdAt = '2026-01-01T00:00:00Z';
const projects: Project[] = [
  { id: 'application', key: 'APP', name: '애플리케이션', description: '', color: '#456789', createdAt },
  { id: 'platform', key: 'PLAT', name: '플랫폼', description: '', color: '#456789', createdAt },
];
const customStatuses: WorkflowStatus[] = [
  { id: 'verifying', label: '검증 중', category: 'review', color: '#456789' },
  { id: 'shipped', label: '출시됨', category: 'done', color: '#456789' },
  { id: 'withdrawn', label: '철회됨', category: 'cancelled', color: '#456789' },
];
const defaults = { projectId: null, role: 'all', includeClosed: false, grouping: 'deadline' } as const;

function issue(key: string, extra: Partial<Issue> = {}): Issue {
  return {
    id: `issue-${key}`, key, projectId: key.startsWith('PLAT') ? 'platform' : 'application', title: key,
    description: '', type: '작업', status: 'todo', priority: 'medium', assigneeId: actor, collaboratorIds: [],
    parentId: null, labels: [], startDate: null, endDate: null, dueDate: null, estimate: null,
    cycle: null, module: null, release: null, version: 1, createdAt, updatedAt: createdAt,
    completedAt: null, ...extra,
  };
}

function snapshot(issues: Issue[]) {
  return {
    projects, issues, users: [],
    workflows: [{ ...defaultWorkflow('platform'), statuses: customStatuses }],
  };
}

function queue(issues: Issue[], options: Partial<Parameters<typeof buildMyWorkQueue>[3]> = {}) {
  return buildMyWorkQueue(snapshot(issues), actor, today, { ...defaults, ...options });
}

const keysByGroup = (result: ReturnType<typeof buildMyWorkQueue>) => Object.fromEntries(
  result.groups.map(group => [group.id, group.items.map(item => item.issue.key)]),
);

test('finds assigned and collaborating work across projects without duplicate membership', () => {
  const assignedAndCollaborating = issue('APP-2', { collaboratorIds: [actor] });
  const collaborating = issue('PLAT-2', { assigneeId: 'someone', collaboratorIds: [actor], status: 'verifying' });
  const unrelated = issue('APP-9', { assigneeId: 'someone', collaboratorIds: ['other-operator'] });
  const closed = issue('PLAT-4', { status: 'shipped' });
  const missingProject = issue('APP-3', { projectId: 'removed-project' });
  const input = [assignedAndCollaborating, collaborating, unrelated, closed, missingProject];

  assert.equal(myWorkMembership(assignedAndCollaborating, actor), 'assigned');
  assert.equal(myWorkMembership(collaborating, actor), 'collaborating');
  assert.equal(myWorkMembership(unrelated, actor), null);
  assert.equal(myWorkMembership(issue('APP-12', { collaboratorIds: [''] }), ''), null);
  assert.equal(myWorkMembership(issue('APP-13', { assigneeId: ' ' }), ' '), null);
  assert.equal(buildMyWorkQueue(snapshot(input), '', today, defaults).total, 0);
  assert.equal(countActiveMyWork(snapshot(input), ''), 0);

  const result = queue(input);
  assert.equal(result.total, 2);
  assert.equal(countActiveMyWork(snapshot(input), actor), result.total);
  assert.deepEqual(result.groups.find(group => group.id === 'undated')?.items.map(item => [item.issue.key, item.project.id, item.status.label, item.role]), [
    ['APP-2', 'application', '할 일', 'assigned'],
    ['PLAT-2', 'platform', '검증 중', 'collaborating'],
  ]);
  assert.deepEqual(keysByGroup(queue(input, { role: 'assigned' })).undated, ['APP-2']);
  assert.deepEqual(keysByGroup(queue(input, { role: 'collaborating' })).undated, ['PLAT-2']);
  assert.deepEqual(keysByGroup(queue(input, { projectId: 'platform', includeClosed: true })).closed, ['PLAT-4']);
  assert.equal(queue(input, { projectId: 'unknown-project' }).total, 0);
  assert.equal(queue(input, { projectId: 'application', role: 'collaborating' }).total, 0);
});

test('finds reported work independently of assignment and counts each active issue once', () => {
  const assignedAndReported = issue('APP-1', { reporterId: actor, collaboratorIds: [actor] });
  const collaboratingAndReported = issue('APP-2', { assigneeId: 'someone', collaboratorIds: [actor], reporterId: actor });
  const reportedOnly = issue('PLAT-1', { assigneeId: null, reporterId: actor, status: 'verifying' });
  const closed = issue('PLAT-2', { assigneeId: null, reporterId: actor, status: 'shipped' });
  const assignedOnly = issue('APP-3', { reporterId: 'someone' });
  const unknown = issue('APP-4', { assigneeId: null });
  const cleared = issue('APP-5', { assigneeId: null, reporterId: null });
  const input = [assignedAndReported, collaboratingAndReported, reportedOnly, closed, assignedOnly, unknown, cleared];

  assert.equal(myWorkMembership(reportedOnly, actor), 'reported');
  assert.equal(myWorkMembership(unknown, actor), null);
  assert.equal(myWorkMembership(cleared, actor), null);
  assert.equal(countActiveMyWork(snapshot(input), actor), 4);
  assert.equal(queue(input).total, 4);
  assert.deepEqual(keysByGroup(queue(input, { role: 'reported' })).undated, ['APP-1', 'APP-2', 'PLAT-1']);
  assert.deepEqual(keysByGroup(queue(input, { role: 'reported', includeClosed: true })).closed, ['PLAT-2']);
  assert.deepEqual(keysByGroup(queue(input, { role: 'assigned' })).undated, ['APP-1', 'APP-3']);
  assert.deepEqual(keysByGroup(queue(input, { role: 'collaborating' })).undated, ['APP-2']);
  assert.deepEqual(queue(input, { role: 'reported' }).groups.find(group => group.id === 'undated')?.items
    .map(item => [item.role, item.reported]), [['assigned', true], ['collaborating', true], ['reported', true]]);
});

test('searches matching queue members by normalized title, previous key and shared status terms', () => {
  const assigned = issue('APP-1', { title: '장비 Field 일정' });
  const moved = issue('PLAT-2', { title: '장비 Field 회의', assigneeId: 'someone', status: 'verifying' });
  const unrelated = issue('PLAT-3', { title: '장비 Field 검색으로 보이면 안 되는 업무', assigneeId: 'someone', status: 'verifying' });
  const closed = issue('PLAT-4', { title: '장비 Field 완료', status: 'shipped' });
  const data = { ...snapshot([assigned, moved, unrelated, closed]), issueAliases: {
    [moved.id]: [{ key: 'OLD-7', source: 'move' as const }],
    [unrelated.id]: [{ key: 'OLD-77', source: 'jira' as const }],
  } };
  const subscriptions = new Set([moved.id]);
  const matches = (query: string, filters: Partial<Parameters<typeof buildMyWorkQueue>[3]> = {}) =>
    buildMyWorkQueue(data, actor, today, { ...defaults, ...filters, query }, subscriptions);

  assert.deepEqual(keysByGroup(matches('장비　ＦＩＥＬＤ')).undated, ['APP-1', 'PLAT-2']);
  assert.deepEqual(keysByGroup(matches('old-７ 검증', { role: 'subscribed', grouping: 'status' })).review, ['PLAT-2']);
  assert.equal(matches('old-7', { projectId: 'application' }).total, 0);
  assert.deepEqual(keysByGroup(matches('field', { includeClosed: true })).closed, ['PLAT-4']);
  assert.equal(matches('old-77').total, 0);
  assert.equal(matches(' 　 ').total, 2);
});

test('prefers the deadline, falls back to the schedule end, and uses a seven-day calendar boundary', () => {
  const result = queue([
    issue('APP-1', { dueDate: '2026-01-27', endDate: '2026-02-12' }),
    issue('APP-2', { endDate: today }),
    issue('APP-3', { dueDate: '2026-01-29', endDate: '2026-01-20' }),
    issue('APP-4', { dueDate: '2026-02-04' }),
    issue('APP-5', { dueDate: '2026-02-05' }),
    issue('APP-6', { startDate: '2026-01-10' }),
    issue('PLAT-1', { status: 'shipped', dueDate: '2026-01-15' }),
    issue('PLAT-2', { status: 'withdrawn', updatedAt: '2026-01-26T10:00:00Z', endDate: today }),
  ], { includeClosed: true });

  assert.equal(result.total, 8);
  assert.deepEqual(result.groups.map(group => group.id), ['overdue', 'today', 'next-seven-days', 'later', 'undated', 'closed']);
  assert.deepEqual(keysByGroup(result), {
    overdue: ['APP-1'], today: ['APP-2'], 'next-seven-days': ['APP-3', 'APP-4'],
    later: ['APP-5'], undated: ['APP-6'], closed: ['PLAT-2', 'PLAT-1'],
  });
  assert.deepEqual(result.groups.find(group => group.id === 'overdue')?.items[0].date, { value: '2026-01-27', source: 'dueDate' });
  assert.deepEqual(result.groups.find(group => group.id === 'today')?.items[0].date, { value: today, source: 'endDate' });
  assert.equal(result.groups.find(group => group.id === 'undated')?.items[0].date, null);
});

test('sorts dates, priorities and numeric issue keys stably in deadline and status groups', () => {
  const input = [
    issue('APP-11', { dueDate: '2026-01-27', priority: 'urgent' }),
    issue('APP-4', { dueDate: '2026-01-25', priority: 'low' }),
    issue('APP-2', { dueDate: '2026-01-27', priority: 'urgent' }),
    issue('APP-1', { dueDate: '2026-01-27', priority: 'low' }),
    issue('APP-6', { priority: 'low', updatedAt: '2026-01-27T00:00:00Z' }),
    issue('APP-8', { priority: 'high', updatedAt: '2026-01-17T10:00:00Z' }),
    issue('APP-9', { priority: 'high', updatedAt: '2026-01-17T05:00:00-07:00' }),
    issue('APP-3', { status: 'in_progress' }),
    issue('APP-10', { status: 'backlog' }),
    issue('PLAT-11', { status: 'verifying' }),
    issue('PLAT-13', { status: 'shipped' }),
    issue('PLAT-12', { status: 'shipped', updatedAt: '2026-01-10T00:00:00Z' }),
    issue('PLAT-14', { status: 'withdrawn' }),
  ];
  const originalOrder = input.map(item => item.key);
  const expectedOverdue = ['APP-4', 'APP-2', 'APP-11', 'APP-1'];
  const sorted = keysByGroup(queue(input));
  assert.deepEqual(sorted.overdue, expectedOverdue);
  assert.deepEqual(sorted.undated.filter(key => ['APP-6', 'APP-8', 'APP-9'].includes(key)), ['APP-9', 'APP-8', 'APP-6']);
  assert.deepEqual(keysByGroup(queue([...input].reverse())), sorted);
  assert.deepEqual(input.map(item => item.key), originalOrder);

  const byStatus = queue(input, { grouping: 'status', includeClosed: true });
  assert.deepEqual(byStatus.groups.map(group => group.id), ['in_progress', 'review', 'todo', 'backlog', 'done', 'cancelled']);
  assert.deepEqual(keysByGroup(byStatus), {
    in_progress: ['APP-3'], review: ['PLAT-11'], todo: [...expectedOverdue, 'APP-9', 'APP-8', 'APP-6'],
    backlog: ['APP-10'], done: ['PLAT-12', 'PLAT-13'], cancelled: ['PLAT-14'],
  });
});
