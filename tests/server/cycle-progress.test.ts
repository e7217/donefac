import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { CYCLE_PROGRESS_EVIDENCE_LIMIT, CYCLE_PROGRESS_MAX_DAYS } from '../../shared/types.js';
import type { ApiKeyCreated, CycleCompletionPreview, CycleCompletionResult, CycleProgressReport, Issue, PlanningItem } from '../../shared/types.js';

const projectId = 'project-neo';
const today = '2026-11-23';
const yesterday = '2026-11-22';
const tomorrow = '2026-11-24';

async function open(dataDir: string) {
  const service = createApp({ dataDir });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server');
  let closed = false;

  const call = (path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    call,
    async plan(name: string, fields: Partial<PlanningItem> = {}) {
      return read<PlanningItem>(await call('/planning-items', 'POST', {
        name, projectId, kind: 'cycle', status: 'active', startDate: yesterday, endDate: tomorrow, ...fields,
      }), 201);
    },
    async issue(title: string, fields: Partial<Issue> = {}) {
      return read<Issue>(await call('/issues', 'POST', { title, projectId, ...fields }), 201);
    },
    async update(issue: Issue, fields: Partial<Issue>) {
      return read<Issue>(await call(`/issues/${issue.id}`, 'PATCH', { ...fields, expectedVersion: issue.version }));
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>(resolve => server.close(() => resolve()));
      service.close();
    },
  };
}

async function read<T>(response: Response, status = 200): Promise<T> {
  const data = await response.json() as T;
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}

function path(cycle: PlanningItem, project = cycle.projectId) {
  return `/projects/${project}/cycles/${cycle.id}/progress`;
}

test('cycle progress observes scope, estimates and workflow transitions, then freezes at completion with carryover', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-22T16:00:00.000Z') });
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-cycle-progress-'));
  let app = await open(dataDir);
  try {
    const cycle = await app.plan('관측할 사이클');
    const destination = await app.plan('이월 받을 사이클', { status: 'planned' });
    let delivery = await app.issue('할 일에서 완료할 업무', { estimate: 2 });
    await app.issue('사이클에 넣지 않은 업무', { estimate: 99 });

    delivery = await app.update(delivery, { cycleId: cycle.id });
    delivery = await app.update(delivery, { estimate: 5 });
    delivery = await app.update(delivery, { status: 'done' });
    delivery = await app.update(delivery, { status: 'in_progress' });
    delivery = await app.update(delivery, { status: 'done' });
    const carryover = await app.issue('점수 없이 이월할 업무', { cycleId: cycle.id, status: 'in_progress' });
    const priorDone = await app.issue('완료 상태로 들어온 업무', { cycleId: cycle.id, status: 'done', estimate: 0 });
    const dropped = await app.issue('취소할 업무', { cycleId: cycle.id, estimate: 3 });
    await app.update(dropped, { status: 'cancelled' });

    const response = await app.call(`${path(cycle)}?date=${today}`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const active = await read<CycleProgressReport>(response);
    assert.equal(active.timeZone, 'Asia/Seoul');
    assert.equal(active.firstDate, yesterday);
    assert.equal(active.windowEnd, today);
    assert.equal(active.completedAt, null);
    assert.deepEqual(active.days[0], { date: yesterday, coverage: 'unobserved', state: null, changes: null });
    assert.deepEqual(active.days[1], { date: today, coverage: 'partial', state: {
      scopeIssues: 4, remainingIssues: 1, completedIssues: 2, cancelledIssues: 1,
      scopeEstimate: 8, remainingEstimate: 0, missingScopeEstimate: 1, missingRemainingEstimate: 1,
    }, changes: { added: 4, removed: 0, completed: 2, cancelled: 1, reopened: 1, estimateChanged: 1, reclassified: 0 } });
    assert.ok(active.evidence);
    assert.deepEqual(active.evidence.items.map(item => [item.issueId, ...item.kinds]), [
      [delivery.id, 'added'], [delivery.id, 'estimateChanged'], [delivery.id, 'completed'], [delivery.id, 'reopened'],
      [delivery.id, 'completed'], [carryover.id, 'added'], [priorDone.id, 'added'], [dropped.id, 'added'], [dropped.id, 'cancelled'],
    ]);
    const estimate = active.evidence.items[1];
    assert.deepEqual([estimate.key, estimate.title, estimate.beforeEstimate, estimate.afterEstimate], [delivery.key, delivery.title, 2, 5]);

    const completion = `/planning-items/${cycle.id}/complete`;
    t.mock.timers.tick(1000);
    const preview = await read<CycleCompletionPreview>(await app.call(`${completion}/preview`, 'POST', {
      expectedVersion: cycle.version, destinationId: destination.id,
    }));
    assert.ok(preview.previewId);
    const applied = await read<CycleCompletionResult>(await app.call(completion, 'POST', { previewId: preview.previewId }));
    assert.deepEqual(applied.counts, { carry: 1, done: 2, cancelled: 1, blocked: 0 });
    const closed = await read<CycleProgressReport>(await app.call(`${path(cycle)}?date=${today}`));
    assert.equal(closed.completedAt, applied.cycle.updatedAt);
    assert.equal(closed.cycle.status, 'completed');
    assert.deepEqual(closed.days.at(-1)?.state, {
      scopeIssues: 3, remainingIssues: 0, completedIssues: 2, cancelledIssues: 1,
      scopeEstimate: 8, remainingEstimate: 0, missingScopeEstimate: 0, missingRemainingEstimate: 0,
    });
    assert.equal(closed.days.at(-1)?.changes?.removed, 1);
    assert.deepEqual(closed.evidence?.items.at(-1)?.kinds, ['removed']);
    assert.equal(closed.evidence?.items.at(-1)?.issueId, carryover.id);

    const next = await read<CycleProgressReport>(await app.call(`${path(destination)}?date=${today}`));
    assert.equal(next.days.at(-1)?.state?.remainingIssues, 1);
    assert.equal(next.days.at(-1)?.state?.missingRemainingEstimate, 1);
    assert.deepEqual(next.evidence?.items.map(item => [item.issueId, item.kinds]), [[carryover.id, ['added']]]);

    t.mock.timers.tick(24 * 60 * 60 * 1000);
    await app.update(delivery, { estimate: 50 });
    await app.close();
    app = await open(dataDir);
    const afterRestart = await read<CycleProgressReport>(await app.call(`${path(cycle)}?date=${today}&throughDate=${tomorrow}`));
    assert.equal(afterRestart.lastDate, today);
    assert.equal(afterRestart.revision, closed.revision);
    assert.deepEqual(afterRestart.days, closed.days);
    assert.deepEqual(afterRestart.evidence, closed.evidence);

    const backup = await read<{ schemaVersion: number }>(await app.call('/export'));
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    t.mock.timers.tick(1000);
    await read(await app.call('/import', 'POST', { data: backup }));
    const restoredCycle = await read<PlanningItem>(await app.call(`/planning-items/${cycle.id}`));
    assert.ok(restoredCycle.version > applied.cycle.version);
    assert.equal(restoredCycle.updatedAt, closed.completedAt);
    const restored = await read<CycleProgressReport>(await app.call(`${path(cycle)}?date=${today}`));
    assert.equal(restored.completedAt, closed.completedAt);
    assert.deepEqual(restored.days, closed.days);
    assert.deepEqual(restored.evidence, closed.evidence);

    await read<PlanningItem>(await app.call(`/planning-items/${cycle.id}`, 'PATCH', {
      expectedVersion: restoredCycle.version, description: '완료 후 수정한 사이클',
    }));
    const edited = await read<CycleProgressReport>(await app.call(path(cycle)));
    assert.equal(edited.completedAt, null);
    assert.equal(edited.lastDate, tomorrow);
    assert.equal(edited.days.at(-1)?.state?.scopeEstimate, 53);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('cycle progress bounds date windows and pages evidence against a revision under project-scoped API keys', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-22T16:00:00.000Z') });
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-cycle-progress-'));
  const app = await open(dataDir);
  try {
    const cycle = await app.plan('긴 관측 기간', { startDate: '2026-04-15' });
    const modulePlan = await app.plan('같은 프로젝트 모듈', { kind: 'module' });
    const foreign = await app.plan('다른 프로젝트 사이클', { projectId: 'project-team' });
    let issue = await app.issue('근거가 여러 페이지인 업무', { cycleId: cycle.id, estimate: 0 });
    for (let estimate = 1; estimate <= CYCLE_PROGRESS_EVIDENCE_LIMIT; estimate++) issue = await app.update(issue, { estimate });

    const first = await read<CycleProgressReport>(await app.call(`${path(cycle)}?date=${today}`));
    assert.equal(first.firstDate, cycle.startDate);
    assert.equal(first.days.length, CYCLE_PROGRESS_MAX_DAYS);
    assert.equal(first.days[0].date, first.windowStart);
    assert.equal(first.windowEnd, today);
    assert.ok(first.evidence);
    assert.equal(first.evidence.total, CYCLE_PROGRESS_EVIDENCE_LIMIT + 1);
    assert.equal(first.evidence.items.length, CYCLE_PROGRESS_EVIDENCE_LIMIT);
    assert.equal(first.evidence.items[0].afterEstimate, 0);

    const offset = first.evidence.limit;
    const page = `${path(cycle)}?date=${today}&offset=${offset}&expectedRevision=${first.revision}`;
    const second = await read<CycleProgressReport>(await app.call(page));
    assert.equal(second.revision, first.revision);
    assert.equal(second.evidence?.offset, offset);
    assert.equal(second.evidence?.items.length, 1);
    assert.equal(second.evidence?.items[0].afterEstimate, offset);
    assert.ok(first.evidence.items.every(item => item.id !== second.evidence?.items[0].id));

    await app.update(issue, { estimate: offset + 1 });
    const stale = await read<{ details: { reason: string; revision: string } }>(await app.call(page), 409);
    assert.equal(stale.details.reason, 'stale_cycle_progress');
    assert.notEqual(stale.details.revision, first.revision);
    const latest = await read<CycleProgressReport>(await app.call(page.replace(first.revision, stale.details.revision)));
    assert.deepEqual(latest.evidence?.items.map(item => item.afterEstimate), [offset, offset + 1]);

    const earlier = await read<CycleProgressReport>(await app.call(`${path(cycle)}?throughDate=${yesterday}&date=${yesterday}`));
    assert.equal(earlier.days.length, CYCLE_PROGRESS_MAX_DAYS);
    assert.equal(earlier.windowEnd, yesterday);
    assert.equal(earlier.lastDate, today);
    assert.ok(earlier.days.every(day => day.coverage === 'unobserved'));
    assert.equal(earlier.evidence?.total, 0);

    for (const query of [`date=${tomorrow}`, `date=${today}&date=${today}`, 'throughDate=2026-02-30', 'extra=1', `date=${today}&offset=1`, 'offset=0']) {
      assert.equal((await app.call(`${path(cycle)}?${query}`)).status, 400, query);
    }
    assert.equal((await app.call(path(modulePlan))).status, 404);
    assert.equal((await app.call(path(foreign, projectId))).status, 404);
    const key = await read<ApiKeyCreated>(await app.call('/api-keys', 'POST', {
      name: '사이클 진행 읽기', access: 'read', projectIds: [projectId], expiresAt: null,
    }, { 'X-Actor-Id': 'user-min' }), 201);
    const headers = { Authorization: `Bearer ${key.token}` };
    assert.equal((await app.call(`/v1${path(cycle)}`)).status, 401);
    const scoped = await read<CycleProgressReport>(await app.call(`/v1${path(cycle)}`, 'GET', undefined, headers));
    assert.equal(scoped.revision, latest.revision);
    assert.equal((await app.call(`/v1${path(foreign)}`, 'GET', undefined, headers)).status, 403);
    assert.equal((await app.call(`/v1${path(foreign, projectId)}`, 'GET', undefined, headers)).status, 404);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
