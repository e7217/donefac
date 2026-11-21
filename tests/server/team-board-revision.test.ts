import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { Dependency, DocPage, GitlabLink, Issue, IssueOrderMoveResult, Project, ProjectIssueOrder, ProjectIssueSchema, ProjectWorkflow, ResourceLink, User, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const header = 'X-Teamspace-Board-Revision';

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-workspace-board-revision-'));
  async function start() {
    const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
      origin: `http://127.0.0.1:${address.port}/api`,
      async close() {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        runtime.close();
      },
    };
  }
  let active = await start();
  const db = new DatabaseSync(join(dataDir, 'teamspace.sqlite'));
  t.after(async () => {
    db.close();
    try { await active.close(); }
    finally { rmSync(dataDir, { force: true, recursive: true }); }
  });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(active.origin + path, {
    method, headers: { 'X-Actor-Id': 'user-seo', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function call<T>(path: string, status = 200, method = 'GET', body?: unknown) {
    const response = await request(path, method, body);
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as T;
  }
  async function workspace(since?: string, status = 200) {
    const response = await request(`/workspace${since === undefined ? '' : `?teamBoardSince=${encodeURIComponent(since)}`}`);
    assert.equal(response.status, status);
    const revision = response.headers.get(header);
    assert.ok(revision && /^[a-f0-9]{32}$/u.test(revision));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 204) {
      assert.equal(await response.text(), '');
      return { revision, data: null };
    }
    return { revision, data: await response.json() as WorkspaceSnapshot };
  }
  return { db, request, call, workspace, async restart() { await active.close(); active = await start(); } };
}

test('workspace token checks skip document snapshot work while unchanged and survive restart', async t => {
  const f = await fixture(t);
  const initial = await f.workspace();
  assert.ok(initial.data?.documents.length);
  assert.deepEqual(await f.workspace(initial.revision, 204), { revision: initial.revision, data: null });
  assert.deepEqual(await f.workspace('0'.repeat(32)), initial);
  const ordinary = await f.request('/workspace?otherQuery=unchanged');
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.headers.get(header), initial.revision);
  assert.deepEqual(await ordinary.json(), initial.data);
  for (const suffix of ['?teamBoardSince=', '?teamBoardSince=invalid', `?teamBoardSince=${initial.revision}&teamBoardSince=${initial.revision}`]) {
    const invalid = await f.request(`/workspace${suffix}`);
    assert.equal(invalid.status, 400);
    await invalid.body?.cancel();
  }

  const doc = await f.call<DocPage>('/documents', 201, 'POST', { projectId, title: '업무 보드와 무관한 문서' });
  const changed = await f.call<DocPage>(`/documents/${doc.id}`, 200, 'PATCH', { expectedVersion: doc.version, title: '문서 제목 수정' });
  assert.deepEqual(await f.workspace(initial.revision, 204), { revision: initial.revision, data: null });
  assert.deepEqual((await f.workspace()).data?.documents.find(page => page.id === doc.id), changed);
  // A deliberately unreadable document must stay outside the matching-token fast path.
  const stored = f.db.prepare('SELECT json FROM documents WHERE id=?').get(doc.id) as { json: string };
  try {
    f.db.prepare('UPDATE documents SET json=? WHERE id=?').run('not valid JSON', doc.id);
    assert.deepEqual(await f.workspace(initial.revision, 204), { revision: initial.revision, data: null });
  } finally {
    f.db.prepare('UPDATE documents SET json=? WHERE id=?').run(stored.json, doc.id);
  }
  await f.restart();
  assert.deepEqual(await f.workspace(initial.revision, 204), { revision: initial.revision, data: null });
  assert.deepEqual((await f.workspace()).data?.documents.find(page => page.id === doc.id), changed);
});

test('workspace revision includes board and issue context changes, and excludes rolled back and no-op rows', async t => {
  const f = await fixture(t);
  let current = await f.workspace();
  async function advanced() {
    const next = await f.workspace(current.revision);
    assert.notEqual(next.revision, current.revision);
    assert.ok(next.data);
    current = next;
    return next.data;
  }
  const first = await f.call<Issue>('/issues', 201, 'POST', { projectId, title: '보드 변경 확인 업무' });
  assert.deepEqual((await advanced()).issues.find(issue => issue.id === first.id), first);
  const moved = await f.call<Issue>(`/issues/${first.id}`, 200, 'PATCH', { expectedVersion: first.version, status: 'review' });
  assert.deepEqual((await advanced()).issues.find(issue => issue.id === first.id), moved);
  const second = await f.call<Issue>('/issues', 201, 'POST', { projectId, title: '정렬 검증 기준 업무' });
  await advanced();

  const project = await f.call<Project>('/projects', 201, 'POST', { key: 'SYNC', name: '보드 갱신 프로젝트', description: '' });
  assert.ok((await advanced()).projects.some(item => item.id === project.id));
  const member = await f.call<User>('/users', 201, 'POST', { name: '보드 검증 팀원', email: 'board-test@example.test' });
  assert.ok((await advanced()).users.some(item => item.id === member.id));
  const workflowPath = `/projects/${projectId}/workflow`;
  const workflow = await f.call<ProjectWorkflow>(workflowPath);
  const revisedWorkflow = await f.call<ProjectWorkflow>(workflowPath, 200, 'PATCH', { ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => status.id === 'review' ? { ...status, label: '팀 검토' } : status) });
  const afterWorkflow = await advanced();
  assert.deepEqual(afterWorkflow.workflows?.find(item => item.projectId === projectId), revisedWorkflow);
  assert.deepEqual(afterWorkflow.issues.find(issue => issue.id === first.id), moved);
  const schemaPath = `/projects/${projectId}/issue-schema`;
  const schema = await f.call<ProjectIssueSchema>(schemaPath);
  const revisedSchema = await f.call<ProjectIssueSchema>(schemaPath, 200, 'PATCH', { ...schema, expectedVersion: schema.version,
    issueTypes: schema.issueTypes.map((type, index) => index === 0 ? { ...type, name: '업무 양식 갱신' } : type) });
  assert.deepEqual((await advanced()).issueSchemas?.find(item => item.projectId === projectId), revisedSchema);

  const orderPath = `/projects/${projectId}/issue-order`;
  const order = await f.call<ProjectIssueOrder>(orderPath);
  const ranked = await f.call<IssueOrderMoveResult>(orderPath, 200, 'PATCH', { issueId: first.id, expectedVersion: order.version,
    expectedIssueVersion: moved.version, anchorId: second.id, position: 'after' });
  const afterOrder = await advanced();
  assert.deepEqual(afterOrder.issueOrders?.find(item => item.projectId === projectId), ranked.order);
  assert.deepEqual(afterOrder.issues.find(issue => issue.id === first.id), moved);

  const link: GitlabLink = { id: randomUUID(), issueId: first.id, projectId: 42, iid: 7, kind: 'merge_request',
    title: '합성 병합 요청', webUrl: 'https://gitlab.example.test/group/project/-/merge_requests/7', state: 'opened', updatedAt: new Date().toISOString() };
  const insert = f.db.prepare('INSERT INTO gitlab_links(id,issue_id,json) VALUES(?,?,?)');
  f.db.exec('BEGIN IMMEDIATE');
  try {
    insert.run(link.id, link.issueId, JSON.stringify(link));
    assert.deepEqual(await f.workspace(current.revision, 204), { revision: current.revision, data: null });
  } finally { f.db.exec('ROLLBACK'); }
  assert.deepEqual(await f.workspace(current.revision, 204), { revision: current.revision, data: null });
  insert.run(link.id, link.issueId, JSON.stringify(link));
  assert.deepEqual((await advanced()).gitlabLinks.find(item => item.id === link.id), link);
  f.db.prepare('UPDATE gitlab_links SET json=json WHERE id=?').run(link.id);
  await f.workspace(current.revision, 204);
  f.db.prepare('DELETE FROM gitlab_links WHERE id=?').run(link.id);
  assert.ok(!(await advanced()).gitlabLinks.some(item => item.id === link.id));

  const dependency = await f.call<Dependency>('/dependencies', 201, 'POST', { predecessorId: first.id, successorId: second.id });
  assert.deepEqual((await advanced()).dependencies.find(item => item.id === dependency.id), dependency);
  const doc = await f.call<DocPage>('/documents', 201, 'POST', { projectId, title: '관련 문서' });
  await f.workspace(current.revision, 204);
  const resource = await f.call<ResourceLink>('/resource-links', 201, 'POST', { issueId: first.id, documentId: doc.id });
  assert.deepEqual((await advanced()).resourceLinks.find(item => item.id === resource.id), resource);
  const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.ok(!Object.keys(backup).some(key => /boardRevision/i.test(key)));
  await f.call('/import', 200, 'POST', { data: backup });
  const restored = await advanced();
  assert.equal(restored.issues.find(issue => issue.id === first.id)?.status, moved.status);
  assert.equal(restored.resourceLinks.find(item => item.id === resource.id)?.documentId, doc.id);
  await f.workspace(current.revision, 204);
});
