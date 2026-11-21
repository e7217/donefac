import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, IssueTemplate, IssueTemplateDefaults, ProjectIssueSchema, RecurringIssueConfig,
  RecurringIssueRule, ReportingLedgerData, TeamNotificationPage, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const outsideProjectId = 'project-team';
const ownerId = 'user-min';
const assigneeId = 'user-seo';
const rulePath = `/projects/${projectId}/recurring-issues`;
const templatePath = `/projects/${projectId}/issue-templates`;
const firstSlot = '2026-01-04T15:00:00.000Z';
const secondSlot = '2026-01-11T15:00:00.000Z';
const thirdSlot = '2026-01-18T15:00:00.000Z';
const fourthSlot = '2026-01-25T15:00:00.000Z';
const defaultClock = '2026-01-04T14:59:59.999Z';

const defaults: IssueTemplateDefaults = {
  title: '정기 배포 확인', description: '## 배포 전 점검', descriptionFormat: 'markdown',
  type: '작업', priority: 'high', labels: ['release'], customFields: {},
};

type Backup = WorkspaceSnapshot & { schemaVersion: number; recurringIssueRules?: RecurringIssueRule[]; reportingLedger: ReportingLedgerData };
type RequestOptions = { status?: number | readonly number[]; method?: string; body?: unknown; actor?: string; token?: string };

async function fixture(t: TestContext, worker = false) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-recurring-issues-'));
  let clock = defaultClock;
  async function start() {
    const app = createApp({ dataDir: directory, outboundWorker: false, deadlineReminderWorker: false,
      recurringIssueWorker: worker, recurringIssueIntervalMs: 25, recurringIssueClock: () => new Date(clock) });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { app, server, base: `http://127.0.0.1:${address.port}/api` };
  }
  let service = await start();
  async function stop() {
    service.server.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve()));
    } finally { service.app.close(); }
  }
  t.after(async () => {
    try { await stop(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  async function call<T = unknown>(path: string, { status = 200, method = 'GET', body, actor = ownerId, token }: RequestOptions = {}) {
    const response = await fetch(service.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const content = await response.text();
    const allowed = typeof status === 'number' ? [status] : status;
    assert.ok(allowed.includes(response.status), `${method} ${path}: status ${response.status}, ${content}`);
    return JSON.parse(content) as T;
  }
  const list = () => call<RecurringIssueRule[]>(`${rulePath}?includeArchived=1`);
  const snapshot = () => call<WorkspaceSnapshot>('/workspace');
  const notifications = async () => (await call<TeamNotificationPage>('/notifications', { actor: assigneeId })).items;
  const template = (name = '정기 배포 양식', id = projectId) => call<IssueTemplate>(`/projects/${id}/issue-templates`, {
    method: 'POST', status: 201, body: { name, defaults },
  });
  function config(templateId: string, changes: Partial<RecurringIssueConfig> = {}) {
    return { name: '매주 배포 점검', templateId, weekday: 1, time: '00:00', assigneeId,
      enabled: true, requestId: randomUUID(), ...changes };
  }
  const create = (body: ReturnType<typeof config>) => call<RecurringIssueRule>(rulePath, { method: 'POST', body, status: 201 });
  const update = (rule: RecurringIssueRule, changes: Partial<RecurringIssueConfig> & { archived?: boolean }) =>
    call<RecurringIssueRule>(`${rulePath}/${rule.id}`, { method: 'PATCH', body: { expectedVersion: rule.version, ...changes } });
  async function key(access: 'read' | 'write', actor = ownerId) {
    return (await call<ApiKeyCreated>('/api-keys', {
      method: 'POST', status: 201, actor, body: { name: `${access} recurring`, access, projectIds: [projectId], expiresAt: null },
    })).token;
  }
  function withDatabase<T>(callback: (database: DatabaseSync) => T): T {
    const database = new DatabaseSync(join(directory, 'teamspace.sqlite'));
    try { return callback(database); } finally { database.close(); }
  }
  return {
    call, config, create, key, list, notifications, snapshot, template, update, withDatabase,
    sweep: () => service.app.runRecurringIssues(),
    setClock(value: string) { clock = value; },
    async restart(value = clock) { await stop(); clock = value; service = await start(); },
  };
}

test('weekly rules run at the Seoul day boundary, use the live template, and skip older downtime slots', async t => {
  const f = await fixture(t);
  const template = await f.template();
  const rule = await f.create(f.config(template.id));
  assert.equal(rule.nextRunAt, firstSlot);
  assert.deepEqual(rule.recentRuns, []);
  assert.equal(f.sweep(), 0);

  const title = '개정한 정기 배포 확인';
  await f.call(`${templatePath}/${template.id}`, { method: 'PATCH', body: {
    expectedVersion: template.version, defaults: { ...defaults, title },
  } });
  f.setClock(firstSlot);
  assert.equal(f.sweep(), 1);
  assert.equal(f.sweep(), 0);
  const [executed] = await f.list();
  assert.equal(executed.version, rule.version);
  assert.equal(executed.nextRunAt, secondSlot);
  assert.equal(executed.recentRuns.length, 1);
  const [created] = executed.recentRuns;
  assert.equal(created.outcome, 'created');
  assert.equal(created.scheduledAt, firstSlot);
  assert.equal(created.processedAt, firstSlot);
  const workspace = await f.snapshot();
  const issue = workspace.issues.find(issue => issue.id === created.issueId);
  assert.ok(issue);
  assert.deepEqual({ projectId: issue.projectId, title: issue.title, description: issue.description, format: issue.descriptionFormat,
    type: issue.type, priority: issue.priority, labels: issue.labels, status: issue.status,
    assigneeId: issue.assigneeId, reporterId: issue.reporterId, createdAt: issue.createdAt, key: issue.key,
  }, { projectId, title, description: defaults.description, format: 'markdown', type: '작업', priority: 'high',
    labels: ['release'], status: 'todo', assigneeId, reporterId: ownerId, createdAt: firstSlot, key: created.issueKey });
  const notices = (await f.notifications()).filter(item => item.targetId === issue.id);
  assert.deepEqual(notices.map(item => [item.kind, item.actorId, item.createdAt]), [['issue-assigned', ownerId, firstSlot]]);
  assert.ok(workspace.activities.some(item => item.resourceId === issue.id && item.actorId === ownerId && item.createdAt === firstSlot));
  const reporting = (await f.call<Backup>('/export')).reportingLedger.events.filter(event => event.issueId === issue.id);
  assert.deepEqual(reporting.map(event => [event.kind, event.actorId, event.origin]), [['created', ownerId, 'automation']]);

  // Deliberately skip two earlier periods, then restart in the most recent period.
  const resumedAt = '2026-01-27T08:00:00.000Z';
  await f.restart(resumedAt);
  assert.equal(f.sweep(), 1);
  assert.equal(f.sweep(), 0);
  const [resumed] = await f.list();
  assert.equal(resumed.version, rule.version);
  assert.equal(resumed.nextRunAt, '2026-02-01T15:00:00.000Z');
  assert.deepEqual(resumed.recentRuns.map(item => [item.scheduledAt, item.processedAt]), [[fourthSlot, resumedAt], [firstSlot, firstSlot]]);
  assert.equal((await f.snapshot()).issues.filter(item => item.title === title).length, 2);

  const paused = await f.update(resumed, { enabled: false });
  assert.equal(paused.nextRunAt, null);
  f.setClock('2026-02-08T15:00:00.000Z');
  assert.equal(f.sweep(), 0);
  const restarted = await f.update(paused, { enabled: true });
  assert.equal(restarted.nextRunAt, '2026-02-15T15:00:00.000Z');
  assert.equal(f.sweep(), 0);
  assert.deepEqual(restarted.recentRuns, resumed.recentRuns);
});

test('scoped creation binds the API key actor, safely replays an accepted request, and checks project references', async t => {
  const f = await fixture(t);
  const template = await f.template();
  const outside = await f.template('다른 프로젝트 양식', outsideProjectId);
  const read = await f.key('read');
  const write = await f.key('write', assigneeId);
  const input = f.config(template.id, { assigneeId: null });
  const publicPath = '/v1' + rulePath;

  assert.deepEqual(await f.call<RecurringIssueRule[]>(publicPath, { token: read }), []);
  await f.call(publicPath, { method: 'POST', status: 403, token: read, body: input });
  await f.call(`/v1/projects/${outsideProjectId}/recurring-issues`, { token: write, status: 403 });
  await f.call(rulePath, { method: 'POST', status: 404, body: { ...input, templateId: outside.id } });
  for (const extra of [{ weekday: 0 }, { weekday: 7.5 }, { time: '24:00' }, { time: '9:00' }, { requestId: 'not-a-uuid' }]) {
    await f.call(rulePath, { method: 'POST', status: 400, body: { ...input, ...extra } });
  }
  const created = await f.call<RecurringIssueRule>(publicPath, { method: 'POST', status: 201, token: write, body: input });
  assert.equal(created.id, input.requestId);
  assert.equal(created.authorId, assigneeId);
  assert.deepEqual(await f.call(publicPath, { method: 'POST', status: [200, 201], token: write, body: input }), created);
  await f.call(publicPath, { method: 'POST', status: 409, token: write, body: { ...input, time: '08:25' } });
  await f.call(rulePath, { method: 'POST', status: 409, body: input });
  assert.deepEqual(await f.call(publicPath, { token: read }), [created]);

  const item = `${publicPath}/${created.id}`;
  await f.call(item, { method: 'PATCH', status: 403, token: read, body: { expectedVersion: created.version, enabled: false } });
  await f.call(item, { method: 'PATCH', status: 409, token: write, body: { expectedVersion: created.version + 1, enabled: false } });
  await f.call(`/projects/${outsideProjectId}/recurring-issues/${created.id}`, { method: 'PATCH', status: 404, body: { expectedVersion: created.version, enabled: false } });
  const archived = await f.call<RecurringIssueRule>(item, { method: 'PATCH', token: write, body: { expectedVersion: created.version, archived: true } });
  assert.deepEqual([archived.archived, archived.enabled, archived.nextRunAt], [true, false, null]);
  assert.deepEqual(await f.call<RecurringIssueRule[]>(rulePath), []);
  assert.deepEqual(await f.list(), [archived]);
  const unarchived = await f.update(archived, { archived: false });
  assert.deepEqual([unarchived.archived, unarchived.enabled, unarchived.nextRunAt], [false, false, null]);
});

test('final receipt failure rolls back the ticket number, activity and notification, and invalid inputs record a blocked run', async t => {
  const f = await fixture(t);
  const template = await f.template();
  const created = await f.create(f.config(template.id));
  const before = await f.snapshot();
  const oldNotices = await f.notifications();
  const beforeReporting = (await f.call<Backup>('/export')).reportingLedger.events;
  const sequence = () => f.withDatabase(database => database.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(projectId));
  const originalSequence = sequence();
  f.withDatabase(database => database.exec(`CREATE TRIGGER reject_recurring_receipt BEFORE UPDATE OF next_run_at ON recurring_issue_rules
    WHEN NEW.id = '${created.id}' BEGIN SELECT RAISE(ABORT,'synthetic recurring receipt failure'); END;`));
  f.setClock(firstSlot);
  assert.equal(f.sweep(), 0);
  const undelivered = await f.snapshot();
  assert.deepEqual(undelivered.issues, before.issues);
  assert.deepEqual(undelivered.activities, before.activities);
  assert.deepEqual(await f.notifications(), oldNotices);
  assert.deepEqual((await f.call<Backup>('/export')).reportingLedger.events, beforeReporting);
  assert.deepEqual(sequence(), originalSequence);
  assert.deepEqual(await f.list(), [created]);
  f.withDatabase(database => database.exec('DROP TRIGGER reject_recurring_receipt'));
  assert.equal(f.sweep(), 1);
  assert.notDeepEqual(sequence(), originalSequence);
  const [first] = await f.list();
  const storedSequence = sequence();

  const schemaPath = `/projects/${projectId}/issue-schema`;
  const schema = await f.call<ProjectIssueSchema>(schemaPath);
  await f.call(schemaPath, { method: 'PATCH', body: { ...schema, expectedVersion: schema.version, fields: [
    ...schema.fields, { id: 'release_context', name: '필수 배포 환경', description: '', kind: 'text', options: [],
      issueTypes: ['작업'], archived: false, required: true },
  ] } });
  f.setClock(secondSlot);
  assert.equal(f.sweep(), 1);
  const [invalid] = await f.list();
  assert.equal(invalid.version, first.version);
  assert.equal(invalid.nextRunAt, thirdSlot);
  assert.equal(invalid.recentRuns[0].outcome, 'blocked');
  assert.match(invalid.recentRuns[0].reason, /필수 배포 환경/u);
  assert.deepEqual(sequence(), storedSequence);

  const archived = await f.call<IssueTemplate>(`${templatePath}/${template.id}`, {
    method: 'PATCH', body: { expectedVersion: template.version, archived: true },
  });
  assert.equal(archived.archived, true);
  f.setClock(thirdSlot);
  assert.equal(f.sweep(), 1);
  assert.equal(f.sweep(), 0);
  const [blocked] = await f.list();
  assert.equal(blocked.nextRunAt, fourthSlot);
  assert.deepEqual(blocked.recentRuns.map(item => [item.scheduledAt, item.outcome]), [
    [thirdSlot, 'blocked'], [secondSlot, 'blocked'], [firstSlot, 'created'],
  ]);
  assert.deepEqual(sequence(), storedSequence);
  assert.equal((await f.snapshot()).issues.filter(issue => issue.title === defaults.title).length, 1);
});

test('portable backups preserve recurring results and scheduled slots while rejecting stale configuration edits', async t => {
  const f = await fixture(t);
  const template = await f.template();
  const rule = await f.create(f.config(template.id));
  const older = await f.call<Backup>('/export');
  assert.equal(older.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  f.setClock(firstSlot);
  assert.equal(f.sweep(), 1);
  const [executed] = await f.list();
  const exported = await f.call<Backup>('/export');
  assert.deepEqual(exported.recurringIssueRules, [executed]);

  await f.call('/import', { status: 400, method: 'POST', body: { data: { ...exported, recurringIssueRules: [{ ...executed, nextRunAt: firstSlot }] } } });
  await f.call('/import', { status: 400, method: 'POST', body: { data: { ...exported, schemaVersion: 89 } } });
  assert.deepEqual(await f.list(), [executed]);
  await f.call('/import', { method: 'POST', body: { data: exported } });
  const [restored] = await f.list();
  assert.ok(restored.version > rule.version);
  assert.deepEqual({ ...restored, version: executed.version }, executed);
  assert.equal(f.sweep(), 0);
  await f.call(`${rulePath}/${rule.id}`, { method: 'PATCH', status: 409, body: { expectedVersion: executed.version, enabled: false } });
  await f.restart();
  assert.equal(f.sweep(), 0);
  assert.deepEqual(await f.list(), [restored]);

  const legacy = { ...older, schemaVersion: 89 };
  delete legacy.recurringIssueRules;
  await f.call('/import', { method: 'POST', body: { data: legacy } });
  assert.deepEqual(await f.list(), []);
  await f.call('/import', { method: 'POST', body: { data: exported } });
  const [reintroduced] = await f.list();
  assert.ok(reintroduced.version > restored.version);
  assert.deepEqual(reintroduced.recentRuns, executed.recentRuns);
  f.setClock(secondSlot);
  assert.equal(f.sweep(), 1);
  assert.deepEqual((await f.list())[0].recentRuns.map(run => run.scheduledAt), [secondSlot, firstSlot]);
  assert.equal((await f.snapshot()).issues.filter(issue => issue.title === defaults.title).length, 2);
});
