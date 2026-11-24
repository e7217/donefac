import assert from 'node:assert/strict';
import test from 'node:test';
import { MILESTONE_READINESS_KINDS, milestoneReadiness } from '../../shared/milestone-readiness.js';
import type { Issue, Milestone } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';

const projectId = 'milestone-project';
const now = '2026-11-24T00:00:00.000Z';

function issue(number: number, changed: Partial<Issue> = {}): Issue {
  return {
    id: String(number), key: `MILE-${number}`, projectId, title: `업무 ${number}`, description: '', type: 'task', status: 'todo',
    priority: 'medium', assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null,
    dueDate: null, estimate: null, cycle: null, module: null, release: null, version: 1, createdAt: now, updatedAt: now,
    completedAt: null, ...changed,
  };
}

function milestone(issueIds: string[], changed: Partial<Milestone> = {}): Milestone {
  return {
    id: 'milestone', projectId, title: '출시 검토', description: '', date: '2026-12-01', status: 'open', ownerId: null,
    issueIds, version: 1, createdAt: now, updatedAt: now, ...changed,
  };
}

const indexIssues = (issues: Issue[]) => new Map(issues.map(value => [value.id, value]));

test('milestone readiness uses saved plan end dates and the issue workflow categories independently of target due dates', () => {
  const verified = { id: 'verified', label: '검증 완료', color: '#00aa00', category: 'done' } as const;
  const withdrawn = { id: 'withdrawn', label: '중단', color: '#aaaaaa', category: 'cancelled' } as const;
  const workflow = defaultWorkflow(projectId);
  workflow.statuses.push(verified, withdrawn);
  const issues = [
    issue(10, { endDate: '2026-12-07', dueDate: '2026-11-30' }),
    issue(2, { endDate: '2026-12-07' }),
    issue(3, { endDate: '2026-12-02' }),
    issue(4, { startDate: '2026-11-20', dueDate: '2026-12-06' }),
    issue(5, { endDate: '2026-12-01', dueDate: '2026-12-16' }),
    issue(6, { endDate: '2026-11-28' }),
    issue(7, { status: verified.id, endDate: '2026-12-16' }),
    issue(8, { status: withdrawn.id }),
    issue(9, { projectId: 'another-project', title: '보여 주지 않는 업무', endDate: '2026-12-16' }),
    issue(11, { endDate: '2026-12-25' }),
  ];
  const release = milestone(['8', '7', '5', '3', '4', '10', '2', '5', '6', '9', 'absent', 'absent'], { status: 'reached' });
  const before = structuredClone({ issues, release, workflow });

  const result = milestoneReadiness(release, indexIssues(issues), { workflows: [workflow] });

  assert.deepEqual(Object.keys(result.counts), [...MILESTONE_READINESS_KINDS]);
  assert.deepEqual(result.counts, { late: 3, unscheduled: 1, within: 2, done: 1, cancelled: 1, unavailable: 2 });
  assert.deepEqual(result.rows.map(({ issue: row, kind }) => [row.id, kind]), [
    ['2', 'late'], ['10', 'late'], ['3', 'late'], ['4', 'unscheduled'], ['6', 'within'], ['5', 'within'],
    ['7', 'done'], ['8', 'cancelled'],
  ]);
  assert.deepEqual(result.rows.at(-2)?.status, verified);
  assert.deepEqual(result.rows.at(-1)?.status, withdrawn);
  assert.deepEqual({ issues, release, workflow }, before);
});

test('milestone readiness follows current saved issue data and supplies default workflow categories', () => {
  const source = milestone(['1']);
  const active = issue(1, { endDate: '2026-12-02' });
  assert.equal(milestoneReadiness(source, indexIssues([active]), {}).counts.late, 1);
  assert.equal(milestoneReadiness(source, indexIssues([{ ...active, status: 'done' }]), {}).counts.done, 1);
  assert.equal(milestoneReadiness(source, indexIssues([{ ...active, endDate: '2026-12-01' }]), {}).counts.within, 1);
  assert.deepEqual(milestoneReadiness(milestone([]), indexIssues([active]), {}), {
    counts: { late: 0, unscheduled: 0, within: 0, done: 0, cancelled: 0, unavailable: 0 }, rows: [],
  });
});
