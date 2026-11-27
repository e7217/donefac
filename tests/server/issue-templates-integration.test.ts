import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, CustomFieldDefinition, Issue, IssueTemplate, IssueTemplateDefaults, ProjectIssueSchema } from '../../shared/types.js';

const projectId = 'project-neo';
const otherProjectId = 'project-team';
const actorId = 'user-min';
const otherActorId = 'user-seo';
const templatePath = `/projects/${projectId}/issue-templates`;
const schemaPath = `/projects/${projectId}/issue-schema`;
const defaults: IssueTemplateDefaults = {
  title: '배포 준비 확인', description: '## 배포 전 검토\n- 확인 사항', descriptionFormat: 'markdown',
  type: '작업', priority: 'high', labels: ['release'], customFields: {},
};
type Failure = { details: { reason: string } };
type Backup = { schemaVersion: number; issueTemplates?: IssueTemplate[] };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-issue-template-'));
  const service = createApp({ dataDir: directory, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  async function call<T = unknown>(path: string, status = 200, method = 'GET', input?: unknown, token?: string) {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...(token && { Authorization: `Bearer ${token}` }) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${body}`);
    return JSON.parse(body) as T;
  }

  async function key(access: 'read' | 'write') {
    const created = await call<ApiKeyCreated>('/api-keys', 201, 'POST', {
      name: `${access} key`, access, projectIds: [projectId], expiresAt: null,
    });
    return created.token;
  }

  return { call, key };
}

function field(id: string, kind: CustomFieldDefinition['kind'], options: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return { id, name: id, description: '', kind, options: [], issueTypes: [], archived: false, required: false, ...options };
}

test('project templates apply editable defaults through ordinary and scoped issue creation with stable retries', async t => {
  const { call, key } = await fixture(t);
  const schema = await call<ProjectIssueSchema>(schemaPath);
  await call(schemaPath, 200, 'PATCH', { ...schema, expectedVersion: schema.version, fields: [
    ...schema.fields,
    field('effort', 'number'),
    field('reviewed', 'checkbox'),
    field('internal_note', 'text', { visibleWhen: { statusIds: ['in_progress'], fieldMatch: null } }),
  ] });
  const templateDefaults = { ...defaults, customFields: { effort: 0, reviewed: false, internal_note: '검토 단계 전용' } };
  const template = await call<IssueTemplate>(templatePath, 201, 'POST', { name: '배포 확인 양식', defaults: templateDefaults });
  const templateUrl = `${templatePath}/${template.id}`;
  assert.deepEqual(template.defaults, templateDefaults);

  const reader = await key('read');
  const writer = await key('write');
  assert.deepEqual((await call<IssueTemplate[]>(`/v1${templatePath}`, 200, 'GET', undefined, reader)).map(item => item.id), [template.id]);
  await call(`/v1${templatePath}?includeArchived=1`, 400, 'GET', undefined, reader);
  await call(`/v1/projects/${otherProjectId}/issue-templates`, 403, 'GET', undefined, reader);
  await call(`/v1${templatePath}`, 403, 'POST', { name: '키로 설정 변경', defaults }, writer);

  const input = { projectId, templateId: template.id, expectedTemplateVersion: template.version };
  await call('/v1/issues', 403, 'POST', input, reader);
  await call('/v1/issues', 403, 'POST', { ...input, projectId: otherProjectId }, writer);
  assert.equal((await call<Failure>('/issues', 404, 'POST', { ...input, projectId: otherProjectId })).details.reason, 'issue-template-not-found');

  const request = { ...input, requestId: randomUUID() };
  const issue = await call<Issue>('/v1/issues', 201, 'POST', request, writer);
  assert.equal(issue.projectId, projectId);
  assert.equal(issue.title, defaults.title);
  assert.equal(issue.description, defaults.description);
  assert.equal(issue.descriptionFormat, 'markdown');
  assert.equal(issue.priority, 'high');
  assert.equal(issue.status, 'todo');
  assert.equal(issue.reporterId, actorId);
  assert.deepEqual(issue.labels, defaults.labels);
  assert.deepEqual(issue.customFields, { effort: 0, reviewed: false });
  const edited = await call<Issue>('/issues', 201, 'POST', {
    ...input, title: '표준 절차 보완', description: '', descriptionFormat: 'plain', priority: 'low', labels: [], customFields: { reviewed: true },
  });
  assert.equal(edited.title, '표준 절차 보완');
  assert.equal(edited.description, '');
  assert.equal(edited.priority, 'low');
  assert.deepEqual(edited.labels, []);
  assert.deepEqual(edited.customFields, { reviewed: true });
  assert.deepEqual((await call<Issue>('/issues', 201, 'POST', { ...input, status: 'in_progress' })).customFields, templateDefaults.customFields);

  const renamed = await call<IssueTemplate>(templateUrl, 200, 'PATCH', { expectedVersion: template.version, name: '배포 확인 개정 양식' });
  assert.equal((await call<Failure>('/issues', 409, 'POST', input)).details.reason, 'issue-template-version-conflict');
  await call(templateUrl, 409, 'PATCH', { expectedVersion: template.version, name: '오래된 수정' });
  const archived = await call<IssueTemplate>(templateUrl, 200, 'PATCH', { expectedVersion: renamed.version, archived: true });
  assert.equal((await call<Issue>('/v1/issues', 200, 'POST', request, writer)).id, issue.id);
  assert.equal((await call<Failure>('/v1/issues', 409, 'POST', { ...request, title: '다른 요청' }, writer)).details.reason, 'request_conflict');
  assert.equal((await call<Failure>('/issues', 409, 'POST', { ...input, expectedTemplateVersion: archived.version })).details.reason, 'issue-template-archived');
  assert.deepEqual(await call<IssueTemplate[]>(templatePath), []);
  assert.deepEqual(await call<IssueTemplate[]>(`/v1${templatePath}`, 200, 'GET', undefined, writer), []);
  assert.deepEqual(await call<IssueTemplate[]>(`${templatePath}?includeArchived=1`), [archived]);
  assert.equal((await call<Issue>('/issues', 201, 'POST', { projectId, title: '일반 업무' })).title, '일반 업무');
});

test('capture keeps reusable source content and leaves workflow, people and scheduling defaults to the new issue', async t => {
  const { call } = await fixture(t);
  const source = await call<Issue>('/issues', 201, 'POST', {
    ...defaults, projectId, status: 'in_progress', assigneeId: otherActorId, reporterId: otherActorId,
    collaboratorIds: [otherActorId], startDate: '2026-11-23', endDate: '2026-11-25', dueDate: '2026-11-25', estimate: 3,
  });
  const capture = { name: '기존 배포 준비 업무로 만든 양식', sourceIssueId: source.id, expectedIssueVersion: source.version };
  assert.equal((await call<Failure>(`/projects/${otherProjectId}/issue-templates`, 404, 'POST', capture)).details.reason, 'issue-template-source-not-found');
  const template = await call<IssueTemplate>(templatePath, 201, 'POST', capture);
  assert.deepEqual(template.defaults, defaults);
  await call(`/issues/${source.id}`, 200, 'PATCH', { expectedVersion: source.version, title: '원본 제목 수정' });
  assert.equal((await call<Failure>(templatePath, 409, 'POST', { ...capture, name: '다른 템플릿' })).details.reason, 'issue-template-source-version-conflict');

  const created = await call<Issue>('/issues', 201, 'POST', { projectId, templateId: template.id, expectedTemplateVersion: template.version });
  assert.equal(created.title, source.title);
  assert.equal(created.status, 'todo');
  assert.equal(created.reporterId, actorId);
  assert.deepEqual(created.collaboratorIds, []);
  for (const key of ['assigneeId', 'startDate', 'endDate', 'dueDate', 'estimate', 'parentId'] as const) assert.equal(created[key], null, key);
});

test('native backups restore templates, invalidate old drafts and accept the preceding backup version', async t => {
  const { call } = await fixture(t);
  const schema = await call<ProjectIssueSchema>(schemaPath);
  const configured = await call<ProjectIssueSchema>(schemaPath, 200, 'PATCH', {
    ...schema, expectedVersion: schema.version, fields: [...schema.fields, field('notes', 'text')],
  });
  const template = await call<IssueTemplate>(templatePath, 201, 'POST', { name: '복원 확인 양식', defaults: { ...defaults, customFields: { notes: '재현 절차' } } });
  await call(schemaPath, 200, 'PATCH', { ...configured, expectedVersion: configured.version, fields: schema.fields });

  const backup = await call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.issueTemplates, [template]);
  const oldInput = { projectId, templateId: template.id, expectedTemplateVersion: template.version };
  assert.equal((await call<Failure>('/issues', 422, 'POST', oldInput)).details.reason, 'issue-template-defaults-invalid');
  await call('/issues', 201, 'POST', { ...oldInput, customFields: {} });

  const missing = { ...backup };
  delete missing.issueTemplates;
  await call('/import', 400, 'POST', { data: missing });
  await call('/import', 400, 'POST', { data: { ...backup, issueTemplates: [{ ...template, projectId: 'missing-project' }] } });
  await call('/import', 400, 'POST', { data: { ...backup, schemaVersion: 86 } });
  assert.deepEqual(await call<IssueTemplate[]>(templatePath), [template]);

  await call('/import', 200, 'POST', { data: backup });
  const [restored] = await call<IssueTemplate[]>(templatePath);
  assert.equal(restored.id, template.id);
  assert.deepEqual(restored.defaults, template.defaults);
  assert.ok(restored.version > template.version);
  assert.equal((await call<Failure>('/issues', 409, 'POST', oldInput)).details.reason, 'issue-template-version-conflict');
  assert.equal((await call<Failure>('/issues', 422, 'POST', { ...oldInput, expectedTemplateVersion: restored.version })).details.reason, 'issue-template-defaults-invalid');

  await call('/import', 200, 'POST', { data: { ...missing, schemaVersion: 86 } });
  assert.deepEqual(await call<IssueTemplate[]>(`${templatePath}?includeArchived=1`), []);

  await call('/import', 200, 'POST', { data: backup });
  const [reintroduced] = await call<IssueTemplate[]>(templatePath);
  assert.equal(reintroduced.id, restored.id);
  assert.ok(reintroduced.version > restored.version);
  await call(`${templatePath}/${template.id}`, 409, 'PATCH', { expectedVersion: restored.version, name: '복원 전 편집본' });
});
