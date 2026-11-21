import assert from 'node:assert/strict';
import test from 'node:test';
import { traceGanttDependencies } from '../../shared/gantt-dependency-focus.js';
import type { Dependency, Issue } from '../../shared/types.js';

const timestamp = '2026-11-21T00:00:00.000Z';

function issue(id: string, fields: Partial<Issue> = {}): Issue {
  return {
    id, key: id, projectId: 'project', title: id, description: '', type: '작업', status: 'todo', priority: 'medium',
    assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null,
    estimate: null, cycle: null, module: null, release: null, version: 1, createdAt: timestamp, updatedAt: timestamp,
    completedAt: null, ...fields,
  };
}

function link(predecessorId: string, successorId: string, type: Dependency['type'] = 'FS'): Dependency {
  return { id: `${predecessorId} -> ${successorId}`, predecessorId, successorId, type, lagDays: 0 };
}

test('Gantt dependency focus returns both directed paths at shortest depth in the original issue order', () => {
  const anchor = issue('anchor', { startDate: '2026-11-21', endDate: '2026-11-26' });
  const oldCompleted = issue('old-completed', { status: 'done' });
  const unscheduled = issue('unscheduled');
  const issues = [
    issue('end-of-path'), issue('first-predecessor'), anchor, issue('collateral-successor'), unscheduled,
    issue('oldest'), issue('second-successor'), issue('collateral-predecessor'), oldCompleted,
    issue('second-predecessor'), issue('first-successor'),
  ];
  const focus = traceGanttDependencies(anchor.id, issues, [
    link('oldest', oldCompleted.id), link(oldCompleted.id, 'first-predecessor'), link(oldCompleted.id, 'second-predecessor'),
    link('first-predecessor', anchor.id), link('second-predecessor', anchor.id, 'SS'), link(oldCompleted.id, anchor.id),
    link(oldCompleted.id, 'collateral-successor'), link(anchor.id, 'first-successor'), link(anchor.id, 'second-successor', 'SF'),
    link('first-successor', unscheduled.id), link('second-successor', unscheduled.id),
    link('collateral-predecessor', 'second-successor'), link(unscheduled.id, 'end-of-path', 'FF'),
  ]);
  assert.ok(focus);
  assert.equal(focus.anchor, anchor);
  assert.deepEqual(focus.issues, issues.filter(value => !value.id.startsWith('collateral-')));
  assert.deepEqual(focus.predecessorDepths, new Map([
    ['first-predecessor', 1], ['second-predecessor', 1], [oldCompleted.id, 1], ['oldest', 2],
  ]));
  assert.deepEqual(focus.successorDepths, new Map([
    ['first-successor', 1], ['second-successor', 1], [unscheduled.id, 2], ['end-of-path', 3],
  ]));
});

test('Gantt dependency focus ignores orphan and out-of-project paths and terminates on a legacy cycle', () => {
  const anchor = issue('anchor');
  const companion = issue('companion');
  const otherProject = issue('external', { projectId: 'another-project' });
  const unrelated = issue('unrelated');
  const issues = [otherProject, companion, unrelated, anchor];
  const dependencies = [
    link(anchor.id, anchor.id), link(anchor.id, companion.id), link(companion.id, anchor.id),
    link(anchor.id, otherProject.id), link(otherProject.id, unrelated.id),
    link(companion.id, 'missing'), link('missing', unrelated.id),
  ];
  const focus = traceGanttDependencies(anchor.id, issues, dependencies);
  assert.ok(focus);
  assert.deepEqual(focus.issues, [companion, anchor]);
  assert.deepEqual(focus.predecessorDepths, new Map([[companion.id, 1]]));
  assert.deepEqual(focus.successorDepths, new Map([[companion.id, 1]]));

  assert.equal(traceGanttDependencies('missing', issues, dependencies), null);
  assert.deepEqual(traceGanttDependencies(unrelated.id, issues, dependencies), {
    anchor: unrelated, issues: [unrelated], predecessorDepths: new Map(), successorDepths: new Map(),
  });
});
