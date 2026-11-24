import assert from 'node:assert/strict';
import test from 'node:test';
import { traceGanttDependencies } from '../../shared/gantt-dependency-focus.js';
import type { Dependency, Issue, TeamScheduleBlocker } from '../../shared/types.js';

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

function blocker(sourceIssueId: string, targetIssueId: string, origin?: TeamScheduleBlocker['origin']): TeamScheduleBlocker {
  return { id: `blocks: ${sourceIssueId} -> ${targetIssueId}`, sourceIssueId, targetIssueId, version: 1, ...(origin ? { origin } : {}) };
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

test('team dependency focus traces verified handoffs and local links without importing collateral or bypass paths', () => {
  const anchor = issue('anchor');
  const upstream = issue('upstream', { projectId: 'external' });
  const earlier = issue('earlier', { projectId: 'external' });
  const receiver = issue('receiver', { projectId: 'external' });
  const verification = issue('verification', { projectId: 'external' });
  const release = issue('release', { projectId: 'release-project' });
  const local = issue('local');
  const unrelated = issue('unrelated', { projectId: 'external' });
  const collateral = issue('collateral', { projectId: 'release-project' });
  const malformed = issue('malformed');
  const issues = [release, earlier, local, unrelated, anchor, receiver, collateral, upstream, verification, malformed];
  const localLinks = [link(earlier.id, upstream.id), link(receiver.id, verification.id, 'SS'), link(anchor.id, local.id)];
  const native = blocker(anchor.id, receiver.id);
  const proven = blocker(upstream.id, anchor.id, 'jira');
  const final = blocker(verification.id, release.id, 'jira');
  const direct = blocker(anchor.id, release.id);
  const focus = traceGanttDependencies(anchor.id, issues, [
    ...localLinks, link(upstream.id, receiver.id), link(anchor.id, unrelated.id), link(verification.id, 'missing'),
  ], [native, proven, final, direct, blocker(upstream.id, release.id), blocker(upstream.id, collateral.id),
    blocker(anchor.id, malformed.id), blocker(anchor.id, 'missing')]);
  assert.ok(focus);
  assert.deepEqual(focus.issues, [release, earlier, local, anchor, receiver, upstream, verification]);
  assert.deepEqual(focus.predecessorDepths, new Map([[upstream.id, 1], [earlier.id, 2]]));
  assert.deepEqual(focus.successorDepths, new Map([[local.id, 1], [receiver.id, 1], [release.id, 1], [verification.id, 2]]));
  assert.deepEqual(focus.dependencyIds, new Set(localLinks.map(link => link.id)));
  assert.deepEqual(focus.teamBlockerIds, new Set([native.id, proven.id, final.id, direct.id]));
});

test('team dependency focus handles verified cycles without admitting raw cross-project dependencies', () => {
  const anchor = issue('anchor');
  const receiver = issue('receiver', { projectId: 'other-project' });
  const hidden = issue('hidden', { projectId: 'other-project' });
  const forward = blocker(anchor.id, receiver.id), backward = blocker(receiver.id, anchor.id, 'jira');
  const dependencies = [link(anchor.id, hidden.id), link(receiver.id, hidden.id, 'FF')];
  const focus = traceGanttDependencies(anchor.id, [anchor, receiver, hidden], dependencies, [forward, backward]);
  assert.ok(focus);
  assert.deepEqual(focus.predecessorDepths, new Map([[receiver.id, 1]]));
  assert.deepEqual(focus.successorDepths, new Map([[receiver.id, 1], [hidden.id, 2]]));
  assert.deepEqual(focus.dependencyIds, new Set([dependencies[1].id]));
  assert.deepEqual(focus.teamBlockerIds, new Set([forward.id, backward.id]));
  const empty = traceGanttDependencies(anchor.id, [anchor, receiver, hidden], dependencies, []);
  assert.deepEqual(empty?.issues, [anchor]);
  assert.equal(empty?.teamBlockerIds.size, 0);
});
