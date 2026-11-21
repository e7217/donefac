import assert from 'node:assert/strict';
import test from 'node:test';
import { traceGanttHierarchy } from '../../shared/gantt-hierarchy-focus.js';
import type { Issue, StatusCategory } from '../../shared/types.js';

const timestamp = '2026-11-21T00:00:00.000Z';

function issue(id: string, fields: Partial<Issue> = {}): Issue {
  return {
    id, key: id, projectId: 'project', title: id, description: '', type: '작업', status: 'todo', priority: 'medium',
    assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null,
    estimate: null, cycle: null, module: null, release: null, version: 1, createdAt: timestamp, updatedAt: timestamp,
    completedAt: null, ...fields,
  };
}

const categories = new Map<string, StatusCategory>([['accepted', 'done'], ['abandoned', 'cancelled']]);
const categoryOf = (issue: Issue): StatusCategory => categories.get(issue.status) ?? 'todo';

test('Gantt hierarchy focus visits descendants in depth-first sibling order and summarizes valid child schedules', () => {
  const anchor = issue('anchor', { status: 'accepted', startDate: '2026-10-01', endDate: '2026-12-30' });
  const first = issue('first', { parentId: anchor.id, startDate: '2026-11-08', endDate: '2026-11-10' });
  const second = issue('second', { parentId: anchor.id, status: 'accepted', endDate: '2026-12-28' });
  const grandchild = issue('grandchild', { parentId: first.id, status: 'abandoned', startDate: '2026-11-05', endDate: '2026-11-05' });
  const grandchildSecond = issue('grandchild-second', { parentId: first.id, startDate: '2026-11-14', endDate: '2026-11-24' });
  const last = issue('last', { parentId: anchor.id, startDate: '2026-10-25' });

  const focus = traceGanttHierarchy(anchor.id, [grandchild, first, second, anchor, grandchildSecond, last, issue('unrelated')], categoryOf);
  assert.deepEqual(focus, {
    anchor,
    issues: [anchor, first, grandchild, grandchildSecond, second, last],
    depths: new Map([[first.id, 1], [grandchild.id, 2], [grandchildSecond.id, 2], [second.id, 1], [last.id, 1]]),
    span: { startDate: '2026-11-05', endDate: '2026-11-24' },
    unscheduledCount: 2,
    doneCount: 1,
    canceledCount: 1,
  });
});

test('Gantt hierarchy focus excludes missing, invalid and reversed dates from the range but still counts their workflow status', () => {
  const anchor = issue('anchor');
  const undated = issue('undated', { parentId: anchor.id });
  const invalid = issue('invalid', { parentId: anchor.id, status: 'abandoned', startDate: '2026-02-29', endDate: '2026-03-01' });
  const reversed = issue('reversed', { parentId: anchor.id, status: 'accepted', startDate: '2026-11-27', endDate: '2026-11-11' });

  const focus = traceGanttHierarchy(anchor.id, [anchor, undated, invalid, reversed], categoryOf);
  assert.ok(focus);
  assert.equal(focus.span, null);
  assert.equal(focus.unscheduledCount, 3);
  assert.equal(focus.doneCount, 1);
  assert.equal(focus.canceledCount, 1);
});

test('Gantt hierarchy focus stays in the project and handles cycles, orphans and leaf anchors', () => {
  const anchor = issue('anchor', { parentId: 'child' });
  const child = issue('child', { parentId: anchor.id });
  const foreign = issue('foreign', { projectId: 'another-project', parentId: anchor.id });
  const foreignChild = issue('foreign-child', { parentId: foreign.id });
  const orphan = issue('orphan', { parentId: 'missing' });
  const self = issue('self', { parentId: 'self' });
  const issues = [foreign, foreignChild, child, orphan, self, anchor];

  const focus = traceGanttHierarchy(anchor.id, issues, categoryOf);
  assert.ok(focus);
  assert.deepEqual(focus.issues, [anchor, child]);
  assert.deepEqual(focus.depths, new Map([[child.id, 1]]));
  assert.equal(focus.unscheduledCount, 1);
  assert.equal(traceGanttHierarchy('missing', issues, categoryOf), null);
  assert.deepEqual(traceGanttHierarchy(self.id, issues, categoryOf), {
    anchor: self, issues: [self], depths: new Map(), span: null, unscheduledCount: 0, doneCount: 0, canceledCount: 0,
  });
});

test('Gantt hierarchy focus walks a deep tree without recursive calls', () => {
  const issues = Array.from({ length: 15_000 }, (_, index) => issue(`issue-${index}`, {
    parentId: index > 0 ? `issue-${index - 1}` : null,
  }));
  const focus = traceGanttHierarchy(issues[0].id, issues, categoryOf);
  assert.ok(focus);
  assert.equal(focus.issues.length, issues.length);
  assert.equal(focus.issues.at(-1), issues.at(-1));
  assert.equal(focus.depths.get(issues.at(-1)!.id), issues.length - 1);
  assert.equal(focus.unscheduledCount, issues.length - 1);
});
