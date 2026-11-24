import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type {
  Dependency, Issue, Project, SchedulePasteApplyResult, SchedulePasteDependencyChange, SchedulePastePreview,
  WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types.js';

type LinkShape = Pick<Dependency, 'type' | 'lagDays'>;

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-paste-dependencies-'));
  const service = createApp({ dataDir: dir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown) {
    const result = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-yun' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, data: await result.json() as T };
  }
  async function createProject(key: string) {
    const result = await call<Project>('/projects', 'POST', { key, name: key });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const project = await createProject('PASTELINK');
  return {
    call, createProject, project,
    setLegacyKey(issue: Issue, key: string) {
      const db = new DatabaseSync(join(dir, 'teamspace.sqlite'));
      try {
        db.prepare("UPDATE issues SET json = json_set(json, '$.key', ?) WHERE id=?").run(key, issue.id);
      } finally { db.close(); }
    },
    usePreviousTeamBindings(previewId: string) {
      const db = new DatabaseSync(join(dir, 'teamspace.sqlite'));
      try {
        const stored = db.prepare('SELECT json FROM schedule_paste_previews WHERE id=?').get(previewId) as { json: string };
        const { resolvedKeyBindings, ...proposal } = JSON.parse(stored.json) as Record<string, unknown> & {
          resolvedKeyBindings: { id: string; projectId: string; inputKey: string; source: string }[];
        };
        assert.ok(resolvedKeyBindings.length && resolvedKeyBindings.every(binding => binding.source === 'current'));
        const keyBindings = resolvedKeyBindings.map(({ id, projectId, inputKey }) => ({ id, projectId, key: inputKey }));
        db.prepare('UPDATE schedule_paste_previews SET json=? WHERE id=?').run(JSON.stringify({ ...proposal, keyBindings }), previewId);
      } finally { db.close(); }
    },
    async issue(title: string, { projectId = project.id, startDate = '2026-11-19', endDate = '2026-11-20', dueDate = null }:
      { projectId?: string; startDate?: string | null; endDate?: string | null; dueDate?: string | null } = {}) {
      const result = await call<Issue>('/issues', 'POST', {
        projectId, title, startDate, endDate, dueDate,
      });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data;
    },
    async link(predecessor: Issue, successor: Issue, type: Dependency['type'] = 'FS', lagDays = 0) {
      const result = await call<Dependency>('/dependencies', 'POST', {
        predecessorId: predecessor.id, successorId: successor.id, type, lagDays,
      });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data;
    },
    async workspace() {
      const result = await call<WorkspaceSnapshot>('/workspace');
      assert.equal(result.status, 200);
      return result.data;
    },
    async preview(rows: string[][], { korean = false, includeDueDate = false, projectId = project.id, rescheduleSuccessors }:
      { korean?: boolean; includeDueDate?: boolean; projectId?: string | null; rescheduleSuccessors?: boolean } = {}) {
      const header = korean
        ? ['업무 키', '시작일', '종료일', '선행 업무', '연결 유형', '근무일 간격']
        : ['key', 'startDate', 'endDate', 'predecessor', 'dependency type', 'lag days'];
      if (includeDueDate) header.push(korean ? '목표 마감일' : 'dueDate');
      const text = [header, ...rows].map(row => row.join('\t')).join('\n');
      const result = await call<SchedulePastePreview>('/schedule/paste-preview', 'POST', { projectId, text, rescheduleSuccessors });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data;
    },
    apply(preview: SchedulePastePreview) {
      assert.ok(preview.previewId);
      return call<SchedulePasteApplyResult>('/schedule/paste-apply', 'POST', { previewId: preview.previewId });
    },
    undo(undoId: string) {
      return call<{ updated: Issue[] }>('/schedule/undo', 'POST', { undoId });
    },
  };
}

function byPair(snapshot: WorkspaceSnapshot, predecessor: Issue, successor: Issue) {
  return snapshot.dependencies.find(link => link.predecessorId === predecessor.id && link.successorId === successor.id);
}

function expectedChange(
  line: number, predecessor: Issue, successor: Issue, before: LinkShape | null, after: LinkShape | null,
): SchedulePasteDependencyChange {
  return { line, predecessorKey: predecessor.key, predecessorTitle: predecessor.title,
    successorKey: successor.key, successorTitle: successor.title, before, after };
}

test('schedule paste previews and commits dates and a new link together, replays once, and undoes both', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('선행 테스트 업무');
  const successor = await f.issue('일정과 선행 연결을 함께 적용');
  const before = await f.workspace();
  const preview = await f.preview([
    [successor.key, '2026-11-23', '2026-11-24', predecessor.key.toLowerCase(), '', ''],
  ], { korean: true });
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.warnings, []);
  assert.equal(preview.unchanged, 0);
  assert.deepEqual(preview.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd]), [
    [successor.id, '2026-11-23', '2026-11-24'],
  ]);
  assert.deepEqual(preview.dependencyChanges, [
    expectedChange(2, predecessor, successor, null, { type: 'FS', lagDays: 0 }),
  ]);
  assert.deepEqual(await f.workspace(), before);

  const applied = await f.apply(preview);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.ok(applied.data.undoId);
  assert.equal(applied.data.dependencyChanges, 1);
  assert.deepEqual(applied.data.updated.map(issue => issue.id), [successor.id]);
  const after = await f.workspace();
  const stored = byPair(after, predecessor, successor);
  assert.ok(stored);
  assert.deepEqual([stored.type, stored.lagDays], ['FS', 0]);
  assert.equal(after.issues.find(issue => issue.id === successor.id)?.startDate, '2026-11-23');
  const replay = await f.apply(preview);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, applied.data);
  assert.deepEqual(await f.workspace(), after);

  const undone = await f.undo(applied.data.undoId);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  const reverted = await f.workspace();
  assert.equal(byPair(reverted, predecessor, successor), undefined);
  const issue = reverted.issues.find(issue => issue.id === successor.id);
  assert.deepEqual([issue?.startDate, issue?.endDate, issue?.version], [successor.startDate, successor.endDate, successor.version + 2]);
  assert.equal((await f.undo(applied.data.undoId)).status, 409);
});

test('repeated successor rows merge split dates once and add, edit and remove distinct links in source order', async t => {
  const f = await fixture(t);
  const added = await f.issue('추가할 선행 업무');
  const edited = await f.issue('간격을 바꿀 선행 업무');
  const removed = await f.issue('해제할 선행 업무');
  const kept = await f.issue('유지할 선행 업무');
  const successor = await f.issue('여러 선행 업무에 연결');
  const editLink = await f.link(edited, successor, 'SS', -2);
  const removeLink = await f.link(removed, successor, 'FF', 1);
  const keepLink = await f.link(kept, successor, 'SS');
  const before = await f.workspace();
  const preview = await f.preview([
    [successor.key, '2026-11-23', '', added.key, '', ''],
    [successor.key.toLowerCase(), '', '2026-11-24', edited.key, '', '2'],
    [successor.key, '', '', removed.key, '-', ''],
    [successor.key, '', '', kept.key, '', ''],
    [successor.key, '2026-11-23', '', '', '', ''],
  ], { korean: true });
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd]), [
    [successor.id, '2026-11-23', '2026-11-24'],
  ]);
  assert.deepEqual(preview.dependencyChanges, [
    expectedChange(2, added, successor, null, { type: 'FS', lagDays: 0 }),
    expectedChange(3, edited, successor, { type: 'SS', lagDays: -2 }, { type: 'SS', lagDays: 2 }),
    expectedChange(4, removed, successor, { type: 'FF', lagDays: 1 }, null),
  ]);
  assert.equal(preview.unchanged, 1);
  assert.deepEqual(await f.workspace(), before);

  const applied = await f.apply(preview);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.dependencyChanges, 3);
  assert.deepEqual(applied.data.updated.map(({ id, version, startDate, endDate }) => [id, version, startDate, endDate]), [
    [successor.id, successor.version + 1, '2026-11-23', '2026-11-24'],
  ]);
  const after = await f.workspace();
  assert.equal(byPair(after, added, successor)?.type, 'FS');
  assert.equal(byPair(after, edited, successor)?.lagDays, 2);
  assert.equal(byPair(after, removed, successor), undefined);
  assert.deepEqual(byPair(after, kept, successor), keepLink);
  assert.deepEqual(await f.apply(preview), applied);
  assert.deepEqual(await f.workspace(), after);

  const undone = await f.undo(applied.data.undoId);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  assert.deepEqual(undone.data.updated.map(({ id, version, startDate, endDate }) => [id, version, startDate, endDate]), [
    [successor.id, successor.version + 2, successor.startDate, successor.endDate],
  ]);
  const reverted = await f.workspace();
  assert.equal(byPair(reverted, added, successor), undefined);
  const restoredEdit = byPair(reverted, edited, successor);
  const restoredRemoval = byPair(reverted, removed, successor);
  assert.deepEqual([restoredEdit?.id, restoredEdit?.lagDays], [editLink.id, editLink.lagDays]);
  assert.deepEqual([restoredRemoval?.id, restoredRemoval?.type, restoredRemoval?.lagDays], [removeLink.id, removeLink.type, removeLink.lagDays]);
  assert.deepEqual(byPair(reverted, kept, successor), keepLink);
});

test('spreadsheet goal dates merge across predecessor rows and replay and undo with planned dates and links', async t => {
  const f = await fixture(t);
  const newPredecessor = await f.issue('추가할 선행 업무');
  const oldPredecessor = await f.issue('해제할 선행 업무');
  const first = await f.issue('계획과 목표를 바꿀 업무', { dueDate: '2026-11-25' });
  const second = await f.issue('목표를 새로 지정할 업무');
  const cleared = await f.issue('목표를 해제할 업무', { dueDate: '2026-11-28' });
  const kept = await f.issue('목표가 비어 있는 붙여넣기 셀', { dueDate: '2026-11-29' });
  const removedLink = await f.link(oldPredecessor, first, 'SS', 1);
  const before = await f.workspace();
  const rows = [
    [first.key, '2026-11-18', '', newPredecessor.key, 'SS', '0', ''],
    [first.key.toLowerCase(), '', '2026-11-24', oldPredecessor.key, '-', '', '2026-11-27'],
    [second.key, '', '', '', '', '', '2026-11-26'],
    [cleared.key, '', '', '', '', '', '-'],
    [kept.key, '2026-11-18', '', '', '', '', ''],
  ];
  const review = await f.preview(rows, { korean: true, includeDueDate: true });
  assert.deepEqual(review.errors, []);
  assert.equal(review.unchanged, 0);
  assert.deepEqual(review.changes.map(({ id }) => id), [first.id, second.id, cleared.id, kept.id]);
  assert.deepEqual(review.changes.slice(0, 3).map(({ fromDue, toDue }) => [fromDue, toDue]), [
    ['2026-11-25', '2026-11-27'], [null, '2026-11-26'], ['2026-11-28', null],
  ]);
  assert.equal(Object.hasOwn(review.changes[3], 'fromDue'), false);
  assert.equal(Object.hasOwn(review.changes[3], 'toDue'), false);
  assert.deepEqual(review.dependencyChanges, [
    expectedChange(2, newPredecessor, first, null, { type: 'SS', lagDays: 0 }),
    expectedChange(3, oldPredecessor, first, { type: 'SS', lagDays: 1 }, null),
  ]);
  assert.deepEqual(await f.workspace(), before);

  const applied = await f.apply(review);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.dependencyChanges, 2);
  const dates = ({ id, version, startDate, endDate, dueDate }: Issue) => [id, version, startDate, endDate, dueDate];
  assert.deepEqual(applied.data.updated.map(dates), [
    dates({ ...first, version: first.version + 1, startDate: '2026-11-18', endDate: '2026-11-24', dueDate: '2026-11-27' }),
    dates({ ...second, version: second.version + 1, dueDate: '2026-11-26' }),
    dates({ ...cleared, version: cleared.version + 1, dueDate: null }),
    dates({ ...kept, version: kept.version + 1, startDate: '2026-11-18' }),
  ]);
  const after = await f.workspace();
  assert.ok(byPair(after, newPredecessor, first));
  assert.equal(byPair(after, oldPredecessor, first), undefined);
  assert.deepEqual(await f.apply(review), applied);
  assert.deepEqual(await f.workspace(), after);

  const undone = await f.undo(applied.data.undoId);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  const restored = [first, second, cleared, kept].map(issue => dates({ ...issue, version: issue.version + 2 }));
  assert.deepEqual(undone.data.updated.map(dates), restored);
  const reverted = await f.workspace();
  assert.deepEqual(restored.map(([id]) => dates(reverted.issues.find(issue => issue.id === id)!)), restored);
  assert.equal(byPair(reverted, newPredecessor, first), undefined);
  const original = byPair(reverted, oldPredecessor, first);
  assert.deepEqual([original?.id, original?.type, original?.lagDays], [removedLink.id, removedLink.type, removedLink.lagDays]);
});

test('merged dates still reject an invalid final range, conflicting explicit dates and repeated links', async t => {
  const f = await fixture(t);
  const a = await f.issue('첫 선행 업무');
  const b = await f.issue('두 번째 선행 업무');
  const successor = await f.issue('잘못된 일정이 들어간 후행 업무');
  const before = await f.workspace();

  const invalidRange = await f.preview([
    [successor.key, '2026-11-25', '', a.key, '', ''],
    [successor.key, '', '2026-11-24', b.key, '', ''],
  ]);
  assert.equal(invalidRange.previewId, null);
  assert.deepEqual(invalidRange.errors.map(error => [error.line, error.key]), [[2, successor.key]]);
  assert.match(invalidRange.errors[0].message, /종료일/u);

  const conflicting = await f.preview([
    [successor.key, '2026-11-23', '2026-11-24', a.key, '', ''],
    [successor.key, '-', '', b.key, '', ''],
    [successor.key.toLowerCase(), '', '', a.key.toLowerCase(), '-', ''],
  ]);
  assert.equal(conflicting.previewId, null);
  assert.deepEqual(conflicting.errors.map(error => [error.line, error.key]), [[3, successor.key], [4, successor.key]]);
  assert.match(conflicting.errors[0].message, /시작일/u);
  assert.match(conflicting.errors[1].message, /중복/u);

  const conflictingDueDate = await f.preview([
    [successor.key, '', '', a.key, '', '', '2026-11-25'],
    [successor.key, '', '', b.key, '', '', '-'],
  ], { includeDueDate: true });
  assert.equal(conflictingDueDate.previewId, null);
  assert.deepEqual(conflictingDueDate.errors.map(error => [error.line, error.key]), [[3, successor.key]]);
  assert.match(conflictingDueDate.errors[0].message, /목표 마감일/u);
  assert.deepEqual(await f.workspace(), before);
});

test('a multi-link preview checks every new endpoint and evaluates cycles after all removals', async t => {
  const f = await fixture(t);
  const a = await f.issue('A');
  const b = await f.issue('B');
  const c = await f.issue('C');
  const original = await f.link(a, b);
  const additions = [
    [a.key, '', '', b.key, 'SS', '0'],
    [a.key, '', '', c.key, 'FF', '0'],
  ];
  const cyclic = await f.preview(additions);
  assert.equal(cyclic.previewId, null);
  assert.ok(cyclic.errors.some(error => error.message.includes('순환')));

  const replacement = [...additions, [b.key, '', '', a.key, '-', '']];
  const stale = await f.preview(replacement);
  assert.deepEqual(stale.errors, []);
  const edit = await f.call(`/issues/${c.id}`, 'PATCH', { expectedVersion: c.version, title: '다른 작업자가 변경한 C' });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  const beforeApply = await f.workspace();
  const rejected = await f.apply(stale);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
  assert.deepEqual(await f.workspace(), beforeApply);
  assert.deepEqual(byPair(beforeApply, a, b), original);

  const fresh = await f.preview(replacement);
  assert.deepEqual(fresh.errors, []);
  const applied = await f.apply(fresh);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.dependencyChanges, 3);
  const after = await f.workspace();
  assert.equal(byPair(after, b, a)?.type, 'SS');
  assert.equal(byPair(after, c, a)?.type, 'FF');
  assert.equal(byPair(after, a, b), undefined);
});

test('link-only paste preserves blank settings, edits and removes chosen links, and restores both with one undo', async t => {
  const f = await fixture(t);
  const predecessor = await f.issue('공통 선행');
  const changed = await f.issue('간격 변경');
  const removed = await f.issue('연결 해제');
  const kept = await f.issue('빈 선행 셀 유지');
  const editLink = await f.link(predecessor, changed, 'SS', -2);
  const removeLink = await f.link(predecessor, removed, 'FF', 1);
  const keepLink = await f.link(predecessor, kept, 'FS');
  const extraLink = await f.link(kept, removed, 'SF', -1);
  const before = await f.workspace();
  const preview = await f.preview([
    [changed.key, '', '', predecessor.key, '', '-1'],
    [removed.key, '', '', predecessor.key, '-', ''],
    [kept.key, '', '', '', '', ''],
  ]);
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.changes, []);
  assert.equal(preview.unchanged, 1);
  assert.deepEqual(preview.dependencyChanges, [
    expectedChange(2, predecessor, changed, { type: 'SS', lagDays: -2 }, { type: 'SS', lagDays: -1 }),
    expectedChange(3, predecessor, removed, { type: 'FF', lagDays: 1 }, null),
  ]);
  assert.deepEqual(await f.workspace(), before);

  const applied = await f.apply(preview);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.dependencyChanges, 2);
  assert.deepEqual(applied.data.updated, []);
  const after = await f.workspace();
  const edited = byPair(after, predecessor, changed);
  assert.deepEqual([edited?.id, edited?.type, edited?.lagDays], [editLink.id, 'SS', -1]);
  assert.equal(byPair(after, predecessor, removed), undefined);
  assert.deepEqual(byPair(after, predecessor, kept), keepLink);
  assert.deepEqual(byPair(after, kept, removed), extraLink);

  const undone = await f.undo(applied.data.undoId);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  const reverted = await f.workspace();
  const restoredEdit = byPair(reverted, predecessor, changed);
  const restoredRemoval = byPair(reverted, predecessor, removed);
  assert.deepEqual([restoredEdit?.id, restoredEdit?.type, restoredEdit?.lagDays], [editLink.id, 'SS', -2]);
  assert.deepEqual([restoredRemoval?.id, restoredRemoval?.type, restoredRemoval?.lagDays], [removeLink.id, 'FF', 1]);
  assert.deepEqual(reverted.issues, before.issues);

  const typeOnly = await f.preview([[changed.key, '', '', predecessor.key, 'ff', '']]);
  assert.deepEqual(typeOnly.errors, []);
  assert.deepEqual(typeOnly.dependencyChanges, [
    expectedChange(2, predecessor, changed, { type: 'SS', lagDays: -2 }, { type: 'FF', lagDays: -2 }),
  ]);

  const reverse = await f.preview([
    [predecessor.key, '', '', changed.key, 'SF', '-1'],
    [changed.key, '', '', predecessor.key, '-', ''],
  ]);
  assert.deepEqual(reverse.errors, []);
  const reversed = await f.apply(reverse);
  assert.equal(reversed.status, 200, JSON.stringify(reversed.data));
  const afterReverse = await f.workspace();
  assert.equal(byPair(afterReverse, predecessor, changed), undefined);
  assert.equal(byPair(afterReverse, changed, predecessor)?.type, 'SF');
  const undoneReverse = await f.undo(reversed.data.undoId);
  assert.equal(undoneReverse.status, 200, JSON.stringify(undoneReverse.data));
  const afterUndo = await f.workspace();
  assert.equal(byPair(afterUndo, changed, predecessor), undefined);
  assert.equal(byPair(afterUndo, predecessor, changed)?.id, editLink.id);
});

test('paste rejects a combined cycle, a late indirect cycle, and a cross-project predecessor without date writes', async t => {
  const f = await fixture(t);
  const a = await f.issue('A');
  const b = await f.issue('B');
  const c = await f.issue('C');
  const d = await f.issue('D');
  const outsideProject = await f.createProject('OTHERLINK');
  const foreign = await f.issue('타 프로젝트 업무', { projectId: outsideProject.id });
  const before = await f.workspace();

  const twoDirections = await f.preview([
    [b.key, '2026-11-23', '2026-11-24', a.key, 'FS', ''],
    [a.key, '', '', b.key, 'FS', ''],
  ]);
  assert.equal(twoDirections.previewId, null);
  assert.ok(twoDirections.errors.some(error => error.message.includes('순환')), JSON.stringify(twoDirections));
  const wrongProject = await f.preview([
    [b.key, '2026-11-23', '2026-11-24', foreign.key, 'FS', ''],
  ]);
  assert.equal(wrongProject.previewId, null);
  assert.ok(wrongProject.errors.some(error => error.line === 2), JSON.stringify(wrongProject));
  assert.deepEqual(await f.workspace(), before);

  await f.link(b, c);
  await f.link(d, a);
  const proposal = await f.preview([[b.key, '2026-11-23', '2026-11-24', a.key, 'FS', '']]);
  assert.deepEqual(proposal.errors, []);
  await f.link(c, d);
  const beforeApply = await f.workspace();
  const rejected = await f.apply(proposal);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
  assert.match(JSON.stringify(rejected.data), /순환/u);
  assert.deepEqual(await f.workspace(), beforeApply);
});

test('team CSV uses each project calendar and replays and undoes one batch of dates and links', async t => {
  const f = await fixture(t);
  const second = await f.createProject('TEAMPASTE');
  const firstPredecessor = await f.issue('첫 프로젝트 선행');
  const firstSuccessor = await f.issue('첫 프로젝트 후행');
  const secondPredecessor = await f.issue('둘째 프로젝트 선행', { projectId: second.id });
  const secondSuccessor = await f.issue('둘째 프로젝트 후행', { projectId: second.id, dueDate: '2026-11-26' });
  const existing = await f.link(secondPredecessor, secondSuccessor, 'SS', 0);
  const calendarPath = `/projects/${second.id}/calendar`;
  const calendar = (await f.call<WorkCalendar>(calendarPath)).data;
  const closed = await f.call<WorkCalendar>(calendarPath, 'PATCH', {
    ...calendar, expectedVersion: calendar.version,
    exceptions: [...calendar.exceptions, { date: '2026-11-23', isWorking: false, label: '둘째 프로젝트 휴무' }],
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  const before = await f.workspace();
  const text = [
    'key,startDate,endDate,predecessor,dependency type,lag days,dueDate',
    `${firstSuccessor.key.toLowerCase()},2026-11-23,2026-11-24,${firstPredecessor.key},FS,0,2026-11-25`,
    `${secondSuccessor.key},2026-11-23,2026-11-24,${secondPredecessor.key},FS,0,-`,
  ].join('\n');
  const response = await f.call<SchedulePastePreview>('/schedule/paste-preview', 'POST', { projectId: null, text });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const preview = response.data;
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.projectId, null);
  assert.deepEqual(preview.projectIds, [f.project.id, second.id].sort());
  assert.deepEqual(preview.changes.map(({ id, projectId, toDue }) => [id, projectId, toDue]), [
    [firstSuccessor.id, f.project.id, '2026-11-25'], [secondSuccessor.id, second.id, null],
  ]);
  assert.deepEqual(preview.dependencyChanges, [
    { ...expectedChange(2, firstPredecessor, firstSuccessor, null, { type: 'FS', lagDays: 0 }), projectId: f.project.id },
    { ...expectedChange(3, secondPredecessor, secondSuccessor, { type: 'SS', lagDays: 0 }, { type: 'FS', lagDays: 0 }), projectId: second.id },
  ]);
  assert.equal(preview.warnings.length, 1, JSON.stringify(preview.warnings));
  assert.ok(preview.warnings[0].includes(`${secondPredecessor.key} → ${secondSuccessor.key}`));
  assert.deepEqual(await f.workspace(), before);

  const applied = await f.apply(preview);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.dependencyChanges, 2);
  assert.deepEqual(applied.data.warnings, preview.warnings);
  assert.deepEqual(applied.data.updated.map(({ projectId, startDate, endDate, dueDate }) => [projectId, startDate, endDate, dueDate]), [
    [f.project.id, '2026-11-23', '2026-11-24', '2026-11-25'], [second.id, '2026-11-23', '2026-11-24', null],
  ]);
  const after = await f.workspace();
  assert.ok(byPair(after, firstPredecessor, firstSuccessor));
  assert.equal(byPair(after, secondPredecessor, secondSuccessor)?.id, existing.id);
  assert.deepEqual(await f.apply(preview), applied);
  assert.deepEqual(await f.workspace(), after);

  const undone = await f.undo(applied.data.undoId);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  const restored = await f.workspace();
  assert.equal(byPair(restored, firstPredecessor, firstSuccessor), undefined);
  const restoredLink = byPair(restored, secondPredecessor, secondSuccessor);
  assert.deepEqual([restoredLink?.id, restoredLink?.type, restoredLink?.lagDays], [existing.id, 'SS', 0]);
  for (const original of [firstSuccessor, secondSuccessor]) {
    const current = restored.issues.find(issue => issue.id === original.id);
    assert.deepEqual([current?.startDate, current?.endDate, current?.dueDate], [original.startDate, original.endDate, original.dueDate]);
  }
});

test('opt-in team CSV reflows a newly linked chain with each work calendar and undoes the dates and links together', async t => {
  const f = await fixture(t);
  const otherProject = await f.createProject('PASTEOTHER');
  const first = await f.issue('먼저 할 업무');
  const middle = await f.issue('두 새 연결의 중간 업무', { dueDate: '2026-11-27' });
  const last = await f.issue('두 새 연결의 마지막 업무', { startDate: '2026-11-23', endDate: '2026-11-24' });
  const alreadyFits = await f.issue('이미 조건을 충족하는 후행 업무', { startDate: '2026-11-30', endDate: '2026-12-01' });
  const otherBranch = await f.issue('새 연결과 무관한 분기');
  await f.link(last, alreadyFits);
  await f.link(first, otherBranch);

  const otherFirst = await f.issue('다른 달력의 선행 업무', { projectId: otherProject.id });
  const otherMiddle = await f.issue('연결 유형을 바꿀 업무', { projectId: otherProject.id });
  const otherLast = await f.issue('다른 달력의 후행 업무', { projectId: otherProject.id });
  const originalLink = await f.link(otherFirst, otherMiddle, 'SS');
  await f.link(otherMiddle, otherLast);
  const calendarPath = `/projects/${otherProject.id}/calendar`;
  const calendar = (await f.call<WorkCalendar>(calendarPath)).data;
  const holiday = await f.call<WorkCalendar>(calendarPath, 'PATCH', { expectedVersion: calendar.version,
    exceptions: [{ date: '2026-11-23', isWorking: false, label: '등록한 휴무' }],
  });
  assert.equal(holiday.status, 200, JSON.stringify(holiday.data));
  const before = await f.workspace();
  const text = [
    'key,startDate,endDate,predecessor,dependency type,lag days,dueDate',
    `${middle.key},${middle.startDate},${middle.endDate},${first.key},FS,0,`,
    `${middle.key},,,,,,2026-11-23`,
    `${last.key},${last.startDate},${last.endDate},${middle.key},FS,0,`,
    `${otherMiddle.key},,,${otherFirst.key},FS,0,`,
    `${otherLast.key},${otherLast.startDate},${otherLast.endDate},${otherMiddle.key},FS,0,`,
    `${alreadyFits.key},${alreadyFits.startDate},${alreadyFits.endDate},${last.key},FS,0,`,
  ].join('\n');
  const ordinary = await f.call<SchedulePastePreview>('/schedule/paste-preview', 'POST', { projectId: null, text });
  assert.equal(ordinary.data.unchanged, 2);
  const response = await f.call<SchedulePastePreview>('/schedule/paste-preview', 'POST', {
    projectId: null, text, rescheduleSuccessors: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const preview = response.data;
  const expectedDates = new Map([
    [middle.id, ['2026-11-23', '2026-11-24', '2026-11-23']],
    [last.id, ['2026-11-25', '2026-11-26', null]],
    [otherMiddle.id, ['2026-11-24', '2026-11-25', null]],
    [otherLast.id, ['2026-11-26', '2026-11-27', null]],
  ]);
  assert.ok(preview.previewId, JSON.stringify(preview));
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(new Set(preview.followUpIssueIds), new Set(expectedDates.keys()));
  assert.deepEqual(new Map(preview.changes.map(({ id, toStart, toEnd, toDue }) => [id, [toStart, toEnd, toDue ?? null]])), expectedDates);
  assert.deepEqual(new Map(preview.changes.map(({ id, projectId }) => [id, projectId])), new Map([
    [middle.id, f.project.id], [last.id, f.project.id], [otherMiddle.id, otherProject.id], [otherLast.id, otherProject.id],
  ]));
  assert.equal(preview.dependencyChanges?.length, 3);
  assert.deepEqual(preview.retainedDependencies?.map(({ successorKey }) => successorKey), [otherLast.key, alreadyFits.key]);
  assert.equal(preview.unchanged, 1);
  assert.ok(preview.warnings.some(warning => warning.includes(middle.key) && warning.includes('목표 마감일')));
  assert.deepEqual(await f.workspace(), before);

  const applied = await f.apply(preview);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.dependencyChanges, 3);
  const dates = ({ id, startDate, endDate, dueDate }: Issue) => [id, [startDate, endDate, dueDate ?? null]] as const;
  assert.deepEqual(new Map(applied.data.updated.map(dates)), expectedDates);
  const after = await f.workspace();
  assert.equal(byPair(after, first, middle)?.type, 'FS');
  assert.equal(byPair(after, middle, last)?.type, 'FS');
  assert.equal(byPair(after, otherFirst, otherMiddle)?.id, originalLink.id);
  assert.equal(byPair(after, otherFirst, otherMiddle)?.type, 'FS');
  for (const unchanged of [first, otherBranch, alreadyFits, otherFirst]) {
    assert.deepEqual(after.issues.find(issue => issue.id === unchanged.id), unchanged);
  }
  assert.deepEqual(await f.apply(preview), applied);
  assert.deepEqual(await f.workspace(), after);

  const undone = await f.undo(applied.data.undoId);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  assert.deepEqual(new Map(undone.data.updated.map(dates)), new Map([middle, last, otherMiddle, otherLast].map(dates)));
  const restored = await f.workspace();
  assert.equal(byPair(restored, first, middle), undefined);
  assert.equal(byPair(restored, middle, last), undefined);
  const restoredLink = byPair(restored, otherFirst, otherMiddle);
  assert.deepEqual([restoredLink?.id, restoredLink?.type, restoredLink?.lagDays], [originalLink.id, 'SS', 0]);
});

test('paste reflow revalidates incoming links and endpoints that were outside the pasted rows', async t => {
  const f = await fixture(t);
  const source = await f.issue('붙여넣기에 나오는 선행 업무');
  const target = await f.issue('새 연결이 들어오는 업무');
  const downstream = await f.issue('표에 없는 후행 업무');
  const incoming = await f.issue('표에 없는 또 다른 선행 업무');
  await f.link(target, downstream);
  const incomingLink = await f.link(incoming, downstream, 'SS');
  const rows = [[target.key, '', '', source.key, 'FS', '0']];
  const options = { rescheduleSuccessors: true };

  const reviewedBeforeEndpointEdit = await f.preview(rows, options);
  assert.ok(reviewedBeforeEndpointEdit.previewId, JSON.stringify(reviewedBeforeEndpointEdit));
  assert.deepEqual(new Set(reviewedBeforeEndpointEdit.followUpIssueIds), new Set([target.id, downstream.id]));
  assert.equal((await f.call(`/issues/${incoming.id}`, 'PATCH', { expectedVersion: incoming.version, title: '같은 날짜의 최신 업무' })).status, 200);
  const afterEndpointEdit = await f.workspace();
  assert.equal((await f.apply(reviewedBeforeEndpointEdit)).status, 409);
  assert.deepEqual(await f.workspace(), afterEndpointEdit);

  const reviewedBeforeLinkEdit = await f.preview(rows, options);
  assert.ok(reviewedBeforeLinkEdit.previewId, JSON.stringify(reviewedBeforeLinkEdit));
  assert.equal((await f.call(`/dependencies/${incomingLink.id}`, 'PATCH', { expectedVersion: incomingLink.version ?? 1, lagDays: 1 })).status, 200);
  const afterLinkEdit = await f.workspace();
  assert.equal((await f.apply(reviewedBeforeLinkEdit)).status, 409);
  assert.deepEqual(await f.workspace(), afterLinkEdit);

  const fresh = await f.preview(rows, options);
  const applied = await f.apply(fresh);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual(new Map(applied.data.updated.map(({ id, startDate }) => [id, startDate])),
    new Map([[target.id, '2026-11-23'], [downstream.id, '2026-11-25']]));
});

test('spreadsheet reflow holds genuinely edited dates fixed and leaves no-op and due-only rows out of the solver', async t => {
  const f = await fixture(t);
  const source = await f.issue('선행 업무');
  const target = await f.issue('후행 업무');
  await f.link(source, target);
  const rows = [
    [source.key, '2026-11-23', '2026-11-24', '', '', ''],
    [target.key, '2026-11-23', '2026-11-24', source.key, 'FS', '0'],
  ];
  const before = await f.workspace();
  const ordinary = await f.preview(rows);
  const disabled = await f.preview(rows, { rescheduleSuccessors: false });
  assert.ok(ordinary.previewId);
  assert.equal(ordinary.followUpIssueIds, undefined);
  assert.deepEqual(disabled.changes, ordinary.changes);
  assert.deepEqual(disabled.warnings, ordinary.warnings);
  const blocked = await f.preview(rows, { rescheduleSuccessors: true });
  assert.equal(blocked.previewId, null);
  assert.ok(blocked.errors.some(({ key, message }) => key === target.key || message.includes(target.key)), JSON.stringify(blocked));
  assert.deepEqual(await f.workspace(), before);

  const noop = await f.preview([[target.key, target.startDate!, target.endDate!, source.key, 'FS', '0']], { rescheduleSuccessors: true });
  assert.equal(noop.previewId, null);
  assert.deepEqual(noop.errors, []);
  assert.deepEqual(noop.changes, []);
  assert.deepEqual(noop.followUpIssueIds ?? [], []);
  assert.equal(noop.unchanged, 1);

  const dueOnly = await f.preview([[source.key, '', '', '', '', '', '2026-11-30']], { includeDueDate: true, rescheduleSuccessors: true });
  assert.ok(dueOnly.previewId, JSON.stringify(dueOnly));
  assert.deepEqual(dueOnly.followUpIssueIds ?? [], []);
  assert.deepEqual(dueOnly.changes.map(({ id, toStart, toEnd, toDue }) => [id, toStart, toEnd, toDue]), [
    [source.id, source.startDate, source.endDate, '2026-11-30'],
  ]);
  const invalid = await f.call('/schedule/paste-preview', 'POST', {
    projectId: f.project.id, text: `key,startDate\n${source.key},2026-11-23`, rescheduleSuccessors: 'true',
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await f.workspace(), before);
});

test('team TSV requires exact unique current keys and refuses cross-project links without any writes', async t => {
  const f = await fixture(t);
  const second = await f.createProject('TEAMPASTE');
  const predecessor = await f.issue('선행');
  const first = await f.issue('첫 프로젝트 일정');
  const other = await f.issue('둘째 프로젝트 일정', { projectId: second.id });
  const rows = [
    [first.key, '2026-11-23', '2026-11-24', predecessor.key, 'FS', ''],
    [other.key, '2026-11-23', '2026-11-24', '', '', ''],
  ];
  const scope = { projectId: null };
  const before = await f.workspace();
  const invalid = await f.preview([
    rows[0], [other.key, '2026-11-23', '2026-11-24', predecessor.key, 'FS', ''],
    ['MISSING-1', '2026-11-23', '2026-11-24', '', '', ''],
  ], scope);
  assert.equal(invalid.previewId, null);
  assert.deepEqual(invalid.errors.map(({ line, message }) => [line, message]), [
    [3, `선행 업무 ${predecessor.key}는 같은 프로젝트에 있어야 합니다.`],
    [4, '전체 프로젝트에 해당 업무 키가 없습니다.'],
  ]);
  assert.deepEqual(await f.workspace(), before);
  assert.equal((await f.call('/schedule/paste-preview', 'POST', { text: 'key,startDate\nMISSING-1,2026-11-23' })).status, 400);
  assert.equal((await f.call('/schedule/paste-preview', 'POST', { projectId: '', text: 'key,startDate\nMISSING-1,2026-11-23' })).status, 400);

  const calendarReview = await f.preview(rows, scope);
  assert.ok(calendarReview.previewId);
  const calendarPath = `/projects/${second.id}/calendar`;
  const calendar = (await f.call<WorkCalendar>(calendarPath)).data;
  assert.equal((await f.call(calendarPath, 'PATCH', {
    ...calendar, expectedVersion: calendar.version,
    exceptions: [...calendar.exceptions, { date: '2026-11-23', isWorking: false, label: '둘째 프로젝트만 휴무' }],
  })).status, 200);
  const afterCalendar = await f.workspace();
  assert.equal((await f.apply(calendarReview)).status, 409);
  assert.deepEqual(await f.workspace(), afterCalendar);

  const keyReview = await f.preview(rows, scope);
  assert.ok(keyReview.previewId);
  const third = await f.createProject('LEGACYKEY');
  const legacy = await f.issue('구형 키가 저장된 업무', { projectId: third.id });
  f.setLegacyKey(legacy, predecessor.key.toLowerCase().replace('s', 'ſ'));
  const afterDuplicate = await f.workspace();
  const rejected = await f.apply(keyReview);
  assert.equal(rejected.status, 409);
  assert.match(JSON.stringify(rejected.data), /업무 키/u);
  assert.deepEqual(await f.workspace(), afterDuplicate);

  const duplicate = await f.preview(rows, scope);
  assert.equal(duplicate.previewId, null);
  assert.deepEqual(duplicate.errors.map(({ line, message }) => [line, message]), [
    [2, `선행 업무 키 ${predecessor.key}가 전체 프로젝트에 중복되어 있습니다.`],
  ]);
  const projectReview = await f.preview([rows[0]]);
  assert.ok(projectReview.previewId);
  assert.equal(projectReview.projectIds, undefined);
  assert.equal(projectReview.changes[0].projectId, undefined);
  assert.equal(projectReview.dependencyChanges?.[0].projectId, undefined);
});

test('a team paste is stale after an issue moves and fresh reviews resolve former keys in the current scope', async t => {
  const f = await fixture(t);
  const second = await f.createProject('TEAMPASTE');
  const third = await f.createProject('THIRDP');
  const first = await f.issue('첫 프로젝트 일정');
  const other = await f.issue('다른 프로젝트로 옮길 업무', { projectId: second.id });
  const rows = [
    [first.key, '2026-11-23', '2026-11-24', '', '', ''],
    [other.key, '2026-11-23', '2026-11-24', '', '', ''],
  ];
  const scope = { projectId: null };
  const review = await f.preview(rows, scope);
  assert.ok(review.previewId, JSON.stringify(review.errors));

  const path = `/issues/${other.id}/project-move`;
  const move = { expectedVersion: other.version, projectId: third.id, includeConnected: false, mappings: [] };
  const plan = await f.call<IssueProjectMovePreview>(`${path}/preview`, 'POST', move);
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  assert.ok(plan.data.token, JSON.stringify(plan.data.blockers));
  const moved = await f.call<IssueProjectMoveResult>(`${path}/apply`, 'POST', { ...move, token: plan.data.token });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const [current] = moved.data.issues;
  assert.equal(current.id, other.id);
  assert.equal(current.projectId, third.id);
  assert.notEqual(current.key, other.key);
  const afterMove = await f.workspace();

  assert.equal((await f.apply(review)).status, 409);
  const oldKey = await f.preview(rows, scope);
  assert.ok(oldKey.previewId, JSON.stringify(oldKey.errors));
  assert.deepEqual(oldKey.projectIds, [f.project.id, third.id].sort());
  assert.deepEqual(oldKey.changes.map(change => [change.id, change.key]), [[first.id, first.key], [current.id, current.key]]);
  assert.deepEqual(oldKey.keyMappings, [{
    inputKey: other.key, issueId: current.id, key: current.key, title: current.title, projectId: current.projectId, source: 'move',
  }]);
  const formerScope = await f.preview([rows[1]], { projectId: second.id });
  assert.equal(formerScope.previewId, null);
  assert.deepEqual(formerScope.errors.map(({ line, key }) => [line, key]), [[2, other.key]]);
  const newKey = await f.preview([rows[0], [current.key, ...rows[1].slice(1)]], scope);
  assert.ok(newKey.previewId, JSON.stringify(newKey.errors));
  assert.deepEqual(newKey.projectIds, [f.project.id, third.id].sort());
  assert.deepEqual(await f.workspace(), afterMove);
  f.usePreviousTeamBindings(newKey.previewId);
  const applied = await f.apply(newKey);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual(applied.data.updated.map(issue => [issue.id, issue.projectId, issue.startDate, issue.endDate]), [
    [first.id, first.projectId, ...rows[0].slice(1, 3)], [current.id, current.projectId, ...rows[1].slice(1, 3)],
  ]);
});

test('undo preserves dates after intervening link edits, a replacement deletion, or a new cycle', async t => {
  const f = await fixture(t);
  const a = await f.issue('A');
  const b = await f.issue('B');
  const c = await f.issue('C');
  const d = await f.issue('D');
  const proposal = await f.preview([[b.key, '2026-11-23', '2026-11-24', a.key, 'FS', '']]);
  assert.deepEqual(proposal.errors, []);
  const applied = await f.apply(proposal);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const link = byPair(await f.workspace(), a, b);
  assert.ok(link);
  const changed = await f.call(`/dependencies/${link.id}`, 'PATCH', { expectedVersion: link.version, lagDays: -1 });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const beforeUndo = await f.workspace();
  const rejectedUndo = await f.undo(applied.data.undoId);
  assert.equal(rejectedUndo.status, 409, JSON.stringify(rejectedUndo.data));
  assert.deepEqual(await f.workspace(), beforeUndo);

  const deletion = await f.preview([[b.key, '2026-11-23', '2026-11-25', a.key, '-', '']]);
  assert.deepEqual(deletion.errors, []);
  const deleted = await f.apply(deletion);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  await f.link(b, c);
  await f.link(c, d);
  await f.link(d, a);
  const beforeRestore = await f.workspace();
  const rejectedRestore = await f.undo(deleted.data.undoId);
  assert.equal(rejectedRestore.status, 409, JSON.stringify(rejectedRestore.data));
  assert.deepEqual(await f.workspace(), beforeRestore);

  const e = await f.issue('교체 전 선행 업무');
  const successor = await f.issue('교체 전 후행 업무');
  const original = await f.link(e, successor);
  const unlink = await f.preview([[successor.key, '2026-11-23', '2026-11-24', e.key, '-', '']]);
  assert.deepEqual(unlink.errors, []);
  const unlinked = await f.apply(unlink);
  assert.equal(unlinked.status, 200, JSON.stringify(unlinked.data));
  const replacement = await f.link(e, successor);
  assert.notEqual(replacement.id, original.id);
  const deletedReplacement = await f.call(`/dependencies/${replacement.id}`, 'DELETE');
  assert.equal(deletedReplacement.status, 200, JSON.stringify(deletedReplacement.data));
  const afterReplacement = await f.workspace();
  assert.equal(byPair(afterReplacement, e, successor), undefined);
  const staleUndo = await f.undo(unlinked.data.undoId);
  assert.equal(staleUndo.status, 409, JSON.stringify(staleUndo.data));
  const afterStaleUndo = await f.workspace();
  assert.deepEqual(afterStaleUndo, afterReplacement);
  const dates = afterStaleUndo.issues.find(issue => issue.id === successor.id);
  assert.deepEqual([dates?.startDate, dates?.endDate], ['2026-11-23', '2026-11-24']);

  await f.link(e, successor);
  const removeAgain = await f.preview([[successor.key, '', '2026-11-25', e.key, '-', '']]);
  const firstRemoval = await f.apply(removeAgain);
  assert.equal(firstRemoval.status, 200, JSON.stringify(firstRemoval.data));
  const recreate = await f.preview([[successor.key, '', '', e.key, 'FF', '-1']]);
  const recreated = await f.apply(recreate);
  assert.equal(recreated.status, 200, JSON.stringify(recreated.data));
  const recreatedLink = byPair(await f.workspace(), e, successor);
  assert.ok(recreatedLink);
  const dropRecreated = await f.preview([[successor.key, '', '', e.key, '-', '']]);
  const latestRemoval = await f.apply(dropRecreated);
  assert.equal(latestRemoval.status, 200, JSON.stringify(latestRemoval.data));
  const beforePastUndo = await f.workspace();
  const pastUndo = await f.undo(firstRemoval.data.undoId);
  assert.equal(pastUndo.status, 409, JSON.stringify(pastUndo.data));
  assert.deepEqual(await f.workspace(), beforePastUndo);
  const latestUndo = await f.undo(latestRemoval.data.undoId);
  assert.equal(latestUndo.status, 200, JSON.stringify(latestUndo.data));
  assert.equal(byPair(await f.workspace(), e, successor)?.id, recreatedLink.id);
});
