import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import { defaultWorkCalendar } from '../../shared/calendar.js';
import { analyzeProjectSchedule } from '../../shared/schedule-analysis.js';
import type { ApiKeyCreated, Dependency, Issue, Project, ProjectScheduleAnalysis, WorkspaceSnapshot } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';

const projectId = 'analysis-fixture';
const mon = '2026-11-23', tue = '2026-11-24', wed = '2026-11-25';
const thu = '2026-11-26', fri = '2026-11-27', sat = '2026-11-28', sun = '2026-11-29';
const nextMon = '2026-11-30', nextTue = '2026-12-01', nextWed = '2026-12-02';
const calendar = {
  ...defaultWorkCalendar(projectId),
  exceptions: [{ date: wed, isWorking: false, label: '휴무일' }, { date: sat, isWorking: true, label: '대체 근무' }],
};

function issue(id: string, startDate: string | null, endDate: string | null, status = 'todo'): Issue {
  return {
    id, key: `ANALYSIS-${id}`, projectId, title: `${id} 업무`, description: '', type: '작업', status,
    priority: 'medium', assigneeId: null, collaboratorIds: [], parentId: null, labels: [],
    startDate, endDate, dueDate: null, estimate: null, cycle: null, module: null, release: null,
    version: 1, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z', completedAt: null,
  };
}

function dependency(predecessor: Issue, successor: Issue, type: Dependency['type'] = 'FS', lagDays = 0): Dependency {
  return { id: `${predecessor.id}-${successor.id}`, predecessorId: predecessor.id, successorId: successor.id, type, lagDays };
}

function analyze(issues: Issue[], dependencies: Dependency[], workflow = defaultWorkflow(projectId)) {
  return analyzeProjectSchedule({ projectId, issues, dependencies, calendar, workflow });
}

function dates(result: ProjectScheduleAnalysis, value: Issue) {
  const row = result.tasks.find(task => task.issueId === value.id);
  assert.ok(row, `${value.key} 분석 결과가 없습니다.`);
  assert.equal(row.key, value.key);
  assert.equal(row.title, value.title);
  return [row.earlyStart, row.earlyFinish, row.latestStart, row.latestFinish, row.slackDays, row.critical];
}

test('project slack distinguishes a long FS chain from short parallel work around calendar exceptions', () => {
  const start = issue('start', mon, tue);
  const long = issue('long', mon, thu);
  const short = issue('short', mon, mon);
  const finish = issue('finish', mon, mon);
  const separate = issue('separate', fri, sat);
  const issues = [start, long, short, finish, separate];
  const dependencies = [dependency(start, long), dependency(start, short), dependency(long, finish), dependency(short, finish)];

  const before = structuredClone({ issues, dependencies });
  const result = analyze(issues, dependencies);
  assert.equal(result.projectId, projectId);
  assert.equal(result.projectedFinish, nextMon);
  assert.equal(result.partial, false);
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.criticalDependencyIds, ['start-long', 'long-finish']);
  assert.deepEqual(dates(result, start), [mon, tue, mon, tue, 0, true]);
  assert.deepEqual(dates(result, long), [thu, sat, thu, sat, 0, true]);
  assert.deepEqual(dates(result, short), [thu, thu, sat, sat, 2, false]);
  assert.deepEqual(dates(result, finish), [nextMon, nextMon, nextMon, nextMon, 0, true]);
  assert.deepEqual(dates(result, separate), [fri, sat, sat, nextMon, 1, false]);
  assert.deepEqual({ issues, dependencies }, before);
});

test('signed FS, SS, FF and SF constraints preserve inclusive duration with a fixed completed predecessor', () => {
  const done = issue('verified', null, tue, 'verified');
  const start = issue('start', mon, thu);
  const startTogether = issue('ss', mon, tue);
  const finishTogether = issue('ff', mon, tue);
  const afterStart = issue('sf', mon, mon);
  const overlap = issue('fs', mon, mon);
  const ignored = issue('cancelled', '2030-01-01', '2030-01-03', 'cancelled');
  const workflow = defaultWorkflow(projectId);
  workflow.statuses.push({ id: 'verified', label: '검증 완료', color: '#00ff00', category: 'done' });

  const result = analyze([done, start, startTogether, finishTogether, afterStart, overlap, ignored], [
    dependency(done, start), dependency(start, startTogether, 'SS', -1), dependency(start, finishTogether, 'FF', -1),
    dependency(start, afterStart, 'SF', 5), dependency(start, overlap, 'FS', -1), dependency(ignored, start),
  ], workflow);
  assert.equal(result.projectedFinish, nextWed);
  assert.equal(result.partial, false);
  assert.equal(result.completedCount, 1);
  assert.equal(result.cancelledCount, 1);
  assert.deepEqual(result.tasks.map(task => task.issueId), [start.id, startTogether.id, finishTogether.id, afterStart.id, overlap.id]);
  assert.deepEqual(result.criticalDependencyIds, ['start-sf']);
  assert.deepEqual(dates(result, start), [thu, sat, thu, sat, 0, true]);
  assert.deepEqual(dates(result, startTogether), [tue, thu, nextTue, nextWed, 5, false]);
  assert.deepEqual(dates(result, finishTogether), [thu, fri, nextTue, nextWed, 4, false]);
  assert.deepEqual(dates(result, afterStart), [nextWed, nextWed, nextWed, nextWed, 0, true]);
  assert.deepEqual(dates(result, overlap), [sat, sat, nextWed, nextWed, 3, false]);
});

test('usable components survive incomplete dates, missing fixed anchors and cycles in other components', () => {
  const beforeMissing = issue('before-missing', mon, fri);
  const missing = issue('missing', tue, null);
  const afterMissing = issue('after-missing', mon, fri);
  const doneMissingStart = issue('done-missing-start', null, fri, 'done');
  const anchored = issue('anchored', mon, nextMon);
  const onlyWeekend = issue('weekend', sun, sun);
  const cycleA = issue('cycle-a', mon, fri), cycleB = issue('cycle-b', mon, fri);
  const independent = issue('independent', sun, nextTue);
  const other = { ...issue('different-project', '2030-01-01', '2030-01-07'), projectId: 'other' };
  const result = analyze([beforeMissing, missing, afterMissing, doneMissingStart, anchored, cycleA, cycleB, onlyWeekend, independent, other], [
    dependency(beforeMissing, missing), dependency(missing, afterMissing), dependency(doneMissingStart, anchored, 'SS'),
    dependency(cycleA, cycleB), dependency(cycleB, cycleA),
  ]);

  assert.equal(result.projectedFinish, nextTue);
  assert.equal(result.partial, true);
  assert.equal(result.completedCount, 1);
  assert.deepEqual(result.tasks.map(task => task.issueId), [independent.id]);
  assert.deepEqual(dates(result, independent), [nextMon, nextTue, nextMon, nextTue, 0, true]);
  assert.deepEqual(new Set(result.excluded.map(row => row.issueId)), new Set([
    beforeMissing.id, missing.id, afterMissing.id, anchored.id, cycleA.id, cycleB.id, onlyWeekend.id,
  ]));
  for (const row of result.excluded) assert.ok(row.reason.trim(), row.key);
  assert.deepEqual(result.criticalDependencyIds, []);
  assert.deepEqual(analyze([doneMissingStart], []).tasks, []);
  assert.equal(analyze([], []).projectedFinish, null);
});

test('impossible projections at the calendar boundary are isolated from feasible signed constraints', () => {
  const first = '0000-01-01', last = '9999-12-31';
  const historical = issue('history', null, first, 'done');
  const feasible = issue('first-day', first, first);
  const atLimit = issue('last-day', last, last);
  const overflow = issue('overflow', first, first);
  const result = analyzeProjectSchedule({
    projectId,
    calendar: { ...calendar, workingWeekdays: [0, 1, 2, 3, 4, 5, 6], exceptions: [] },
    workflow: defaultWorkflow(projectId),
    issues: [historical, feasible, atLimit, overflow],
    dependencies: [dependency(historical, feasible, 'FS', -2), dependency(atLimit, overflow)],
  });

  assert.equal(result.projectedFinish, first);
  assert.equal(result.partial, true);
  assert.deepEqual(dates(result, feasible), [first, first, first, first, 0, true]);
  assert.deepEqual(new Set(result.excluded.map(row => row.issueId)), new Set([atLimit.id, overflow.id]));
  for (const row of result.excluded) assert.match(row.reason, /범위/);
});

test('HTTP schedule analysis is project-scoped, read-only and uses current saved schedules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-schedule-analysis-'));
  const app = createApp({ dataDir: dir, outboundWorker: false });
  const listener = app.app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  try {
    const address = listener.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api`;
    async function request<T = unknown>(path: string, method = 'GET', body?: unknown, token?: string) {
      const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() as T };
    }

    const project = await request<Project>('/projects', 'POST', { key: 'SLACK', name: '업무 일정 여유 분석' });
    assert.equal(project.status, 201);
    const path = `/projects/${project.data.id}/schedule-analysis`;
    const predecessor = await request<Issue>('/issues', 'POST', { projectId: project.data.id, title: '선행 영향', startDate: mon, endDate: tue });
    const successor = await request<Issue>('/issues', 'POST', { projectId: project.data.id, title: '후행 영향', startDate: mon, endDate: mon });
    assert.equal(predecessor.status, 201);
    assert.equal(successor.status, 201);
    const edge = await request<Dependency>('/dependencies', 'POST', { predecessorId: predecessor.data.id, successorId: successor.data.id, type: 'FS', lagDays: 0 });
    assert.equal(edge.status, 201);
    const key = await request<ApiKeyCreated>('/api-keys', 'POST', { name: '여유 조회', access: 'read', projectIds: [project.data.id], expiresAt: null });
    assert.equal(key.status, 201);
    const before = (await request<WorkspaceSnapshot>('/workspace')).data;

    const analysis = await request<ProjectScheduleAnalysis>(path);
    assert.equal(analysis.status, 200);
    assert.equal(analysis.data.projectedFinish, wed);
    assert.equal(analysis.data.partial, false);
    assert.deepEqual(analysis.data.criticalDependencyIds, [edge.data.id]);
    assert.deepEqual(new Set(analysis.data.tasks.map(task => task.issueId)), new Set([predecessor.data.id, successor.data.id]));
    const scoped = await request<ProjectScheduleAnalysis>(`/v1${path}`, 'GET', undefined, key.data.token);
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.data, analysis.data);
    assert.equal((await request('/v1/projects/project-neo/schedule-analysis', 'GET', undefined, key.data.token)).status, 403);
    assert.equal((await request('/projects/unknown-project/schedule-analysis')).status, 404);
    assert.ok((await request(path, 'PATCH', {})).status >= 400);
    assert.deepEqual((await request<WorkspaceSnapshot>('/workspace')).data, before);

    assert.equal((await request(`/projects/${project.data.id}/calendar`, 'PATCH', {
      expectedVersion: 1, exceptions: [{ date: wed, isWorking: false, label: '일정 변경 검증 휴무' }],
    })).status, 200);
    const updated = await request<ProjectScheduleAnalysis>(path);
    assert.equal(updated.status, 200);
    assert.equal(updated.data.projectedFinish, thu);
    assert.equal(dates(updated.data, successor.data)[0], thu);
    assert.deepEqual((await request<WorkspaceSnapshot>('/workspace')).data.issues, before.issues);
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
