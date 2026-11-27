import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  AutomaticSchedulePreview, Dependency, Issue, IssueRelation, Project, SchedulePasteApplyResult, SchedulePastePreview,
  ScheduleUndoInfo, ScheduleUndoResult, WorkspaceSnapshot,
} from '../../shared/types.js';

const actor = 'user-min';
const otherActor = 'user-seo';
const scopeHeader = 'X-Donefac-Schedule-Undo-Scope';
const undoPath = '/schedule/undo';
const expected = ({ id, version }: Issue) => ({ id, expectedVersion: version });

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-undo-'));
  async function start() {
    const service = createApp({ dataDir: dir, outboundWorker: false, deadlineReminderWorker: false });
    const server = service.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
      async close() {
        server.closeAllConnections();
        try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { service.close(); }
      },
    };
  }
  let server = await start();
  t.after(async () => {
    try { await server.close(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, status: number, method = 'GET', body?: unknown, actorId = actor, scope?: string) {
    const response = await fetch(server.base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...(scope ? { [scopeHeader]: scope } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    if (path.startsWith(undoPath) && status === 200) assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return data;
  }
  const project = await call<Project>('/projects', 201, 'POST', { key: 'UNDOW', name: '일정 되돌리기' });
  return {
    call, dir, project,
    async restart() { await server.close(); server = await start(); },
    async latest(kind: 'issue' | 'project' | 'team', id?: string, actorId = actor) {
      const query = new URLSearchParams({ scope: kind });
      if (id) query.set('id', id);
      return (await call<{ undo: ScheduleUndoInfo | null }>(`${undoPath}/latest?${query}`, 200, 'GET', undefined, actorId)).undo;
    },
    issue: (title: string, projectId = project.id) => call<Issue>('/issues', 201, 'POST', {
      title, projectId, startDate: '2026-11-20', endDate: '2026-11-20', dueDate: '2026-11-27',
    }),
    shift: (issue: Issue, day: string, scope?: string, status = 200) => call<SchedulePasteApplyResult>('/schedule/apply', status, 'POST', {
      changes: [{ ...expected(issue), startDate: day, endDate: day }],
    }, actor, scope),
    undo: (undoId: string, status = 200, scope?: string, actorId = actor, retry = false) =>
      call<ScheduleUndoResult>(retry ? `${undoPath}?retry=true` : undoPath, status, 'POST', { undoId }, actorId, scope),
    workspace: () => call<WorkspaceSnapshot>('/workspace', 200),
  };
}

test('ticket undo is scoped to its guarded anchor, survives restart and replays exact date/link confirmation', async t => {
  const f = await fixture(t);
  const anchor = await f.issue('기준 업무');
  const successor = await f.issue('후행 업무');
  const scope = `issue:${anchor.id}`;
  const initial = await f.workspace();
  const preview = await f.call<SchedulePastePreview>('/schedule/row-edit/preview', 200, 'POST', {
    projectId: f.project.id, issue: expected(anchor), changes: { endDate: '2026-11-24', dueDate: null },
    dependencies: [{ action: 'add', relatedIssue: expected(successor), direction: 'successor', type: 'SS', lagDays: 2 }],
    rescheduleSuccessors: true,
  });
  assert.ok(preview.previewId, JSON.stringify(preview));
  assert.deepEqual(preview.changes.map(({ id }) => id), [anchor.id, successor.id]);
  const input = { previewId: preview.previewId };
  await f.call('/schedule/row-edit/apply', 400, 'POST', input, actor, `issue:${successor.id}`);
  assert.deepEqual(await f.workspace(), initial, 'an unrelated claimed screen rolls the operation back');

  const applied = await f.call<SchedulePasteApplyResult>('/schedule/row-edit/apply', 200, 'POST', input, actor, scope);
  assert.equal(applied.dependencyChanges, 1);
  assert.equal(await f.latest('issue', anchor.id, otherActor), null);
  assert.equal(await f.latest('issue', successor.id), null);
  assert.equal(await f.latest('project', f.project.id), null);
  assert.equal(await f.latest('team'), null);

  await f.restart();
  const candidate = await f.latest('issue', anchor.id);
  assert.ok(candidate && Number.isFinite(Date.parse(candidate.appliedAt)));
  assert.deepEqual(candidate, { undoId: applied.undoId, appliedAt: candidate.appliedAt, issueCount: 2, dependencyChanges: 1, planCount: 0 });
  await f.undo(applied.undoId, 409, scope, otherActor);
  await f.undo(applied.undoId, 409, `project:${f.project.id}`);
  const confirmed = await f.undo(applied.undoId, 200, scope);
  assert.equal(confirmed.dependencyChanges, 1);
  assert.deepEqual(confirmed.updated.map(({ id, startDate, endDate, dueDate }) => [id, startDate, endDate, dueDate]),
    [anchor, successor].map(issue => [issue.id, issue.startDate, issue.endDate, issue.dueDate]));
  assert.equal(await f.latest('issue', anchor.id), null);
  const restored = await f.workspace();
  assert.ok(!restored.dependencies.some(link => link.successorId === successor.id));

  await f.restart();
  const current = confirmed.updated[0];
  await f.call<Issue>(`/issues/${current.id}`, 200, 'PATCH', { expectedVersion: current.version, title: '되돌린 뒤 이름 변경' }, otherActor);
  const beforeReplay = await f.workspace();
  await f.undo(applied.undoId, 409, undefined);
  await f.undo(applied.undoId, 409, scope, otherActor, true);
  await f.undo(applied.undoId, 409, 'team', actor, true);
  assert.deepEqual(await f.undo(applied.undoId, 200, scope, actor, true), { ...confirmed, duplicate: true });
  assert.deepEqual(await f.workspace(), beforeReplay, 'a recovered confirmation performs no more changes or history writes');
});

test('project and team last undo do not fall back, reject newer edits or stale dependencies, and clear with native replacement', async t => {
  const f = await fixture(t);
  const scope = `project:${f.project.id}`;
  const first = await f.issue('먼저 변경한 업무');
  const second = await f.issue('나중에 변경한 업무');
  const fromTeam = await f.issue('전체 계획에서 변경한 업무');
  const old = await f.shift(first, '2026-11-23', scope);
  const team = await f.shift(fromTeam, '2026-11-23', 'team');
  const last = await f.shift(second, '2026-11-24', scope);
  assert.equal((await f.latest('project', f.project.id))?.undoId, last.undoId);
  assert.equal((await f.latest('team'))?.undoId, team.undoId);
  await f.undo(old.undoId, 409, scope);
  const firstStillShifted = (await f.workspace()).issues.find(issue => issue.id === first.id);
  assert.equal(firstStillShifted?.startDate, '2026-11-23');
  await f.undo(last.undoId, 200, scope);
  assert.equal(await f.latest('project', f.project.id), null);
  await f.undo(old.undoId, 409, scope);

  const previous = await f.workspace();
  await f.shift(firstStillShifted!, '2026-11-25', 'project:project-neo', 400);
  assert.deepEqual(await f.workspace(), previous);

  const preview = await f.call<SchedulePastePreview>('/schedule/row-edit/preview', 200, 'POST', {
    projectId: f.project.id, issue: expected(firstStillShifted!), changes: { endDate: '2026-11-25' },
    dependencies: [{ action: 'add', relatedIssue: expected((await f.workspace()).issues.find(({ id }) => id === second.id)!),
      direction: 'successor', type: 'FS', lagDays: 0 }],
  });
  const compound = await f.call<SchedulePasteApplyResult>('/schedule/row-edit/apply', 200, 'POST', { previewId: preview.previewId }, actor, scope);
  const createdLink = (await f.workspace()).dependencies.find(link => link.predecessorId === first.id && link.successorId === second.id)!;
  await f.call<Dependency>(`/dependencies/${createdLink.id}`, 200, 'PATCH', { expectedVersion: createdLink.version, lagDays: 1 }, otherActor);
  const concurrent = await f.workspace();
  assert.equal(await f.latest('project', f.project.id), null);
  await f.undo(compound.undoId, 409, scope);
  assert.deepEqual(await f.workspace(), concurrent);

  assert.equal((await f.latest('team'))?.undoId, team.undoId);
  const backup = await f.call('/export', 200);
  await f.call('/import', 200, 'POST', { confirm: 'REPLACE', data: backup });
  assert.equal(await f.latest('team'), null);
  await f.undo(last.undoId, 404, scope, actor, true);
});

test('age limits scoped discovery and mutation while unscoped exact IDs keep compatibility', async t => {
  const f = await fixture(t);
  const issue = await f.issue('유효 기간을 검사할 업무');
  const scoped = await f.shift(issue, '2026-11-23', 'team');
  const database = new DatabaseSync(join(f.dir, 'donefac.sqlite'));
  try {
    database.prepare(`UPDATE schedule_undos SET json=json_set(json,'$.appliedAt','2020-01-01T00:00:00.000Z') WHERE id=?`).run(scoped.undoId);
    assert.equal(await f.latest('team'), null);
    await f.undo(scoped.undoId, 409, 'team');
    const exact = await f.undo(scoped.undoId);
    assert.equal(exact.updated[0].startDate, issue.startDate);

    database.prepare('UPDATE schedule_undo_results SET completed_at=? WHERE undo_id=?').run('2020-01-01T00:00:00.000Z', scoped.undoId);
    await f.undo(scoped.undoId, 409, undefined, actor, true);

    const legacy = await f.shift(exact.updated[0], '2026-11-24');
    database.prepare(`UPDATE schedule_undos SET json=json_remove(json,'$.actorId','$.appliedAt') WHERE id=?`).run(legacy.undoId);
    await f.undo(legacy.undoId, 200, undefined, otherActor);
    await f.undo(legacy.undoId, 409, undefined, otherActor, true);
  } finally { database.close(); }
});

test('a fixed source project can recover undo when only its cross-project successor dates changed', async t => {
  const f = await fixture(t);
  const otherProject = await f.call<Project>('/projects', 201, 'POST', { key: 'UNDOL', name: '후행 일정' });
  const source = await f.issue('원래 유지할 선행 일정');
  const target = await f.issue('다른 프로젝트의 후행 일정', otherProject.id);
  const relation = await f.call<IssueRelation>(`/issues/${source.id}/relations`, 201, 'POST', {
    otherIssueId: target.id, type: 'blocks', direction: 'outgoing',
  });
  const preview = await f.call<AutomaticSchedulePreview>('/schedule/team-follow-up-preview', 200, 'POST', {
    relationId: relation.id, expectedVersion: relation.version,
  });
  assert.deepEqual(preview.blocking, []);
  assert.deepEqual(preview.changes.map(({ id }) => id), [target.id]);
  const input = { previewId: preview.previewId };
  await f.call('/schedule/team-follow-up-apply', 400, 'POST', input, actor, 'project:project-neo');
  const scope = `project:${f.project.id}`;
  const result = await f.call<SchedulePasteApplyResult>('/schedule/team-follow-up-apply', 200, 'POST', input, actor, scope);
  assert.equal((await f.latest('project', f.project.id))?.undoId, result.undoId);
  assert.equal(await f.latest('project', otherProject.id), null);
  assert.equal((await f.undo(result.undoId, 200, scope)).updated[0].startDate, target.startDate);
});

test('cross-project follow-up undo belongs to the source ticket and actor, with or without a source date change', async t => {
  const f = await fixture(t);
  const otherProject = await f.call<Project>('/projects', 201, 'POST', { key: 'UNDOT', name: '티켓 후행 일정' });
  for (const changeSource of [false, true]) {
    const source = await f.issue(changeSource ? '함께 변경할 선행 일정' : '변경하지 않을 선행 일정');
    const target = await f.issue('다른 프로젝트의 후행 일정', otherProject.id);
    const relation = await f.call<IssueRelation>(`/issues/${source.id}/relations`, 201, 'POST', {
      otherIssueId: target.id, type: 'blocks', direction: 'outgoing',
    });
    const preview = await f.call<AutomaticSchedulePreview>('/schedule/team-follow-up-preview', 200, 'POST', {
      relationId: relation.id, expectedVersion: relation.version,
      ...(changeSource ? { anchorChange: { ...expected(source), startDate: source.startDate, endDate: '2026-11-23' } } : {}),
    });
    const toRestore = changeSource ? [source, target] : [target];
    assert.deepEqual(preview.blocking, []);
    assert.deepEqual(preview.changes.map(({ id }) => id).sort(), toRestore.map(({ id }) => id).sort());
    const input = { previewId: preview.previewId };
    const resultPath = `/schedule/team-follow-up-result/${preview.previewId}`;
    const scope = `issue:${source.id}`;
    const wrongScope = `issue:${target.id}`;
    const applyPath = '/schedule/team-follow-up-apply';
    const before = await f.workspace();
    await f.call(applyPath, 400, 'POST', input, actor, wrongScope);
    await f.call(applyPath, 409, 'POST', input, otherActor, scope);
    assert.deepEqual(await f.workspace(), before);
    assert.deepEqual(await f.call(resultPath, 200), { applied: false });

    const applied = await f.call<SchedulePasteApplyResult>(applyPath, 200, 'POST', input, actor, scope);
    assert.equal(applied.updated.find(({ id }) => id === target.id)?.startDate, changeSource ? '2026-11-24' : '2026-11-23');
    assert.equal(applied.updated.find(({ id }) => id === source.id)?.endDate, changeSource ? '2026-11-23' : undefined);
    assert.equal(await f.latest('issue', target.id), null);
    assert.equal(await f.latest('issue', source.id, otherActor), null);
    assert.equal(await f.latest('project', f.project.id), null);
    assert.equal(await f.latest('team'), null);

    if (!changeSource) await f.restart();
    const latest = await f.latest('issue', source.id);
    assert.equal(latest?.undoId, applied.undoId);
    assert.equal(latest?.issueCount, toRestore.length);
    await f.call(resultPath, 409, 'GET', undefined, otherActor);
    assert.deepEqual(await f.call(resultPath, 200), applied);
    await f.undo(applied.undoId, 409, wrongScope);
    await f.undo(applied.undoId, 409, scope, otherActor);

    const undone = await f.undo(applied.undoId, 200, scope);
    const dates = ({ id, startDate, endDate, dueDate }: Issue) => [id, startDate, endDate, dueDate];
    assert.deepEqual(undone.updated.map(dates).sort(), toRestore.map(dates).sort());
    assert.equal(await f.latest('issue', source.id), null);
    const restored = await f.workspace();
    await f.undo(applied.undoId, 409, wrongScope, actor, true);
    await f.undo(applied.undoId, 409, scope, otherActor, true);
    assert.deepEqual(await f.undo(applied.undoId, 200, scope, actor, true), { ...undone, duplicate: true });
    assert.deepEqual(await f.workspace(), restored);
  }
});
