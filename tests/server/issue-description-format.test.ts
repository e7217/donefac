import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { TrashArchive } from '../../server/trash.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, Issue, IssueChildCreationResult, IssueCloneResult, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const markdown = '# 재현 절차\n\n- [x] 작업 시작\n\n| 값 | 결과 |\n| --- | --- |\n| A | 확인 |\n\n```bash\nprintf test\n```';
type Backup = WorkspaceSnapshot & { schemaVersion: number; trashEntries: TrashArchive[] };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-issue-description-'));
  const service = createApp({ dataDir: directory, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    try { await new Promise<void>(resolve => server.close(() => resolve())); }
    finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = async <T = unknown>(path: string, status = 200, method = 'GET', data?: unknown, token?: string) => {
    const response = await fetch(endpoint + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { 'X-Actor-Id': 'user-min' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const raw = await response.text();
    assert.equal(response.status, status, raw);
    return JSON.parse(raw) as T;
  };
  return {
    request,
    backup: () => request<Backup>('/export'),
    issue: async (id: string) => (await request<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === id),
    make(title: string, descriptionFormat?: Issue['descriptionFormat']) {
      return request<Issue>('/issues', 201, 'POST', { projectId, title, description: markdown, descriptionFormat });
    },
  };
}

test('ticket description format is opt-in, scoped API updates preserve it, and explicit plain clears it losslessly', async t => {
  const f = await fixture(t);
  const legacy = await f.make('서식처럼 보이는 일반 설명');
  assert.equal(legacy.description, markdown);
  assert.ok(!Object.hasOwn(legacy, 'descriptionFormat'));
  const { token } = await f.request<ApiKeyCreated>('/api-keys', 201, 'POST', {
    name: '설명 서식 합성 검사', access: 'write', projectIds: [projectId], expiresAt: null,
  });
  const issue = await f.request<Issue>('/v1/issues', 201, 'POST', {
    projectId, title: 'Markdown 서식 업무', description: markdown, descriptionFormat: 'markdown',
  }, token);
  const resource = `/v1/issues/${issue.id}`;
  assert.equal(issue.descriptionFormat, 'markdown');
  assert.equal(issue.description, markdown);
  const afterStatus = await f.request<Issue>(resource, 200, 'PATCH', { expectedVersion: issue.version, title: '제목만 수정한 업무' }, token);
  assert.equal(afterStatus.descriptionFormat, 'markdown');
  assert.equal(afterStatus.description, markdown);
  const raw = await f.request<Issue>(resource, 200, 'PATCH', { expectedVersion: afterStatus.version, description: `${markdown}\n\n추가 내용` }, token);
  assert.equal(raw.descriptionFormat, 'markdown');
  for (const descriptionFormat of ['html', null, 7]) {
    await f.request(resource, 400, 'PATCH', { expectedVersion: raw.version, descriptionFormat }, token);
    assert.deepEqual(await f.issue(issue.id), raw);
  }
  await f.request(resource, 409, 'PATCH', { expectedVersion: issue.version, descriptionFormat: 'plain' }, token);
  const plain = await f.request<Issue>(resource, 200, 'PATCH', { expectedVersion: raw.version, descriptionFormat: 'plain' }, token);
  assert.equal(plain.description, raw.description);
  assert.ok(!Object.hasOwn(plain, 'descriptionFormat'));
  assert.deepEqual(await f.request<Issue>(resource, 200, 'GET', undefined, token), plain);
});

test('ticket clone and child receipts preserve explicit Markdown descriptions without changing the source', async t => {
  const f = await fixture(t);
  const source = await f.make('서식 설명 원본', 'markdown');
  const clonePath = `/issues/${source.id}/clone`;
  const cloneInput = { requestId: randomUUID(), expectedSourceVersion: source.version,
    issue: { title: '설명 서식 복제', description: markdown, descriptionFormat: 'markdown' } };
  const clone = await f.request<IssueCloneResult>(clonePath, 201, 'POST', cloneInput);
  assert.equal(clone.issue.descriptionFormat, 'markdown');
  assert.equal(clone.issue.description, markdown);
  assert.deepEqual(await f.request<IssueCloneResult>(clonePath, 200, 'POST', cloneInput), { ...clone, duplicate: true });
  const childInput = { requestId: randomUUID(), expectedParentVersion: source.version,
    issue: { title: '비어 있는 Markdown 하위 업무', description: '', descriptionFormat: 'markdown' } };
  const children = `/issues/${source.id}/children`;
  const child = await f.request<IssueChildCreationResult>(children, 201, 'POST', childInput);
  assert.equal(child.issue.parentId, source.id);
  assert.equal(child.issue.descriptionFormat, 'markdown');
  assert.equal(child.issue.description, '');
  assert.deepEqual(await f.request<IssueChildCreationResult>(children, 200, 'POST', childInput), { ...child, duplicate: true });
  assert.deepEqual(await f.issue(source.id), source);
});

test('native format 78 includes active and archived Markdown modes, keeping native 77 plain and rejecting masked or invalid formats', async t => {
  const f = await fixture(t);
  const old = await f.make('형식 77 일반 텍스트');
  const legacy = await f.backup();
  await f.request('/import', 200, 'POST', { data: { ...legacy, schemaVersion: 77 } });
  assert.ok(!Object.hasOwn((await f.issue(old.id))!, 'descriptionFormat'));
  const active = await f.make('형식 78 활성 업무', 'markdown');
  const archived = await f.make('형식 78 휴지통 업무', 'markdown');
  const { trashEntryId } = await f.request<{ trashEntryId: string }>(`/issues/${archived.id}`, 200, 'DELETE', { expectedVersion: archived.version });
  const backup = await f.backup();
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.issues.find(issue => issue.id === active.id)?.descriptionFormat, 'markdown');
  const trash = backup.trashEntries.find(entry => entry.id === trashEntryId);
  assert.equal(trash?.resourceType, 'issue');
  assert.equal(trash?.resourceType === 'issue' && trash.resource.descriptionFormat, 'markdown');
  const masked = { ...structuredClone(backup), schemaVersion: 77 };
  delete masked.issues.find(issue => issue.id === active.id)!.descriptionFormat;
  await f.request('/import', 400, 'POST', { data: masked });
  const invalid = structuredClone(backup);
  const invalidTrash = invalid.trashEntries.find(entry => entry.id === trashEntryId);
  assert.equal(invalidTrash?.resourceType, 'issue');
  Object.assign(invalidTrash.resource, { descriptionFormat: 'script' });
  await f.request('/import', 400, 'POST', { data: invalid });
  assert.deepEqual(await f.issue(active.id), active);
  assert.equal(await f.issue(archived.id), undefined);
  await f.request('/import', 200, 'POST', { data: backup });
  await f.request(`/trash/${trashEntryId}/restore`, 200, 'POST');
  assert.equal((await f.issue(active.id))?.descriptionFormat, 'markdown');
  assert.equal((await f.issue(archived.id))?.descriptionFormat, 'markdown');
  assert.equal((await f.issue(archived.id))?.description, markdown);
});
