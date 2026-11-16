import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../../server/app.js';
import type { Issue, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types.js';

async function fixture(dataDir?: string, seed = true) {
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'teamspace-workflows-'));
  const service = createApp({ dataDir: dir, seed });
  const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('테스트 서버 주소 없음');
  const base = `http://127.0.0.1:${address.port}/api`;
  let closed = false;
  const request = async <T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown) => { const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as T }; };
  return { dir, request, close: async () => { if (closed) return; closed = true; await new Promise<void>(resolve => server.close(() => resolve())); service.close(); }, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

test('default workflows retain old transitions; configured edges, issue types and required fields are enforced by REST', async () => {
  const f = await fixture();
  try {
    const original = (await f.request<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    assert.equal(original.version, 1); assert.equal(original.initialStatusId, 'todo'); assert.equal(original.statuses.length, 6); assert.equal(original.transitions.length, 30);
    let issue = (await f.request<Issue>('/issues', 'POST', { projectId: 'project-neo', title: '워크플로 버그', type: '버그' })).data;
    const configuration: ProjectWorkflow = { ...original, statuses: [...original.statuses, { id: 'qa_custom', label: '품질 확인', category: 'review', color: '#8d68bf' }, { id: 'shipped_custom', label: '배포 완료', category: 'done', color: '#248964' }], transitions: [{ from: 'todo', to: 'qa_custom', issueTypes: ['버그'], requiredFields: ['description', 'assigneeId'] }, { from: 'qa_custom', to: 'shipped_custom', issueTypes: [], requiredFields: [] }], fieldRules: [{ issueType: '버그', statusId: 'qa_custom', requiredFields: ['estimate'] }] };
    assert.equal((await f.request('/projects/project-neo/workflow', 'PATCH', { ...configuration, expectedVersion: original.version })).status, 200);
    assert.equal((await f.request(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, status: 'done' })).status, 422);
    const missing = await f.request<{ details: { requiredFields: string[] } }>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, status: 'qa_custom' });
    assert.equal(missing.status, 422); assert.deepEqual(new Set(missing.data.details.requiredFields), new Set(['estimate', 'description', 'assigneeId']));
    const changed = await f.request<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, status: 'qa_custom', description: '재현과 검증 완료', assigneeId: 'user-min', estimate: 0 });
    assert.equal(changed.status, 200); issue = changed.data; assert.equal(issue.status, 'qa_custom');
    assert.equal((await f.request(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, estimate: null })).status, 422);
    const normal = (await f.request<Issue>('/issues', 'POST', { projectId: 'project-neo', title: '작업 유형 전이 제한', type: '작업', description: '설명', assigneeId: 'user-min', estimate: 1 })).data;
    assert.equal((await f.request(`/issues/${normal.id}`, 'PATCH', { expectedVersion: normal.version, status: 'qa_custom' })).status, 422);

    const current = (await f.request<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    assert.equal((await f.request('/projects/project-neo/workflow', 'PATCH', { ...current, expectedVersion: current.version, fieldRules: [{ issueType: '버그', statusId: 'qa_custom', requiredFields: ['estimate', 'labels'] }] })).status, 200);
    assert.equal((await f.request('/schedule/apply', 'POST', { changes: [{ id: issue.id, expectedVersion: issue.version, startDate: '2026-11-16', endDate: '2026-11-18' }] })).status, 422);
    const filled = await f.request<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, labels: ['검증'] }); assert.equal(filled.status, 200); issue = filled.data;
    assert.equal((await f.request('/schedule/apply', 'POST', { changes: [{ id: issue.id, expectedVersion: issue.version, startDate: '2026-11-16', endDate: '2026-11-18' }] })).status, 200);
    issue = (await f.request<WorkspaceSnapshot>('/workspace')).data.issues.find(value => value.id === issue.id)!;
    const done = await f.request<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, status: 'shipped_custom' }); assert.equal(done.status, 200); assert.ok(done.data.completedAt);
  } finally { await f.close(); f.remove(); }
});

test('workflow CAS, stable state names, in-use deletion guard and initial custom status survive restart', async () => {
  const f = await fixture();
  try {
    const original = (await f.request<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    const added = await f.request<ProjectWorkflow>('/projects/project-neo/workflow', 'PATCH', { ...original, expectedVersion: 1, initialStatusId: 'intake', transitions: original.transitions.filter(edge => edge.from !== 'cancelled' && edge.to !== 'cancelled'), statuses: [...original.statuses.filter(status => status.id !== 'cancelled'), { id: 'intake', label: '접수', category: 'todo', color: '#4c8b96' }] });
    assert.equal(added.status, 200); assert.equal(added.data.version, 2);
    const issue = (await f.request<Issue>('/issues', 'POST', { projectId: 'project-neo', title: '사용자 정의 기본 상태' })).data; assert.equal(issue.status, 'intake');
    assert.equal((await f.request('/projects/project-neo/workflow', 'PATCH', { ...added.data, expectedVersion: 1 })).status, 409);
    const removed = { ...added.data, expectedVersion: 2, initialStatusId: 'todo', statuses: added.data.statuses.filter(status => status.id !== 'intake'), transitions: added.data.transitions.filter(edge => edge.from !== 'intake' && edge.to !== 'intake') };
    assert.equal((await f.request('/projects/project-neo/workflow', 'PATCH', removed)).status, 409);
    const renamed = await f.request<ProjectWorkflow>('/projects/project-neo/workflow', 'PATCH', { ...added.data, expectedVersion: 2, statuses: added.data.statuses.map(status => status.id === 'intake' ? { ...status, label: '요청 접수', color: '#318278' } : status) });
    assert.equal(renamed.status, 200); assert.equal(renamed.data.statuses.find(status => status.id === 'intake')?.label, '요청 접수');
    const invalid = await f.request('/projects/project-neo/workflow', 'PATCH', { ...renamed.data, expectedVersion: 3, statuses: [{ id: 'intake', label: '접수', color: 'red', category: 'todo' }] }); assert.equal(invalid.status, 400);
    await f.close(); const next = await fixture(f.dir); try { const persisted = await next.request<ProjectWorkflow>('/projects/project-neo/workflow'); assert.equal(persisted.data.version, 3); assert.equal(persisted.data.initialStatusId, 'intake'); assert.equal(persisted.data.statuses.find(status => status.id === 'intake')?.label, '요청 접수'); } finally { await next.close(); }
  } finally { await f.close(); f.remove(); }
});

test('schema3 backup roundtrips custom workflows; legacy1/2 receive defaults; invalid imported state references rollback', async () => {
  const source = await fixture(), target = await fixture(undefined, false), legacy = await fixture();
  try {
    const original = (await source.request<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    const custom = { ...original, expectedVersion: original.version, statuses: [...original.statuses, { id: 'verified_custom', label: '검증 완료', category: 'done', color: '#40805e' }] };
    assert.equal((await source.request('/projects/project-neo/workflow', 'PATCH', custom)).status, 200);
    assert.equal((await source.request('/issues', 'POST', { projectId: 'project-neo', title: '이관할 사용자 정의 상태', status: 'verified_custom' })).status, 201);
    const configured = (await source.request<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    assert.equal((await source.request('/projects/project-neo/workflow', 'PATCH', { ...configured, expectedVersion: configured.version, fieldRules: [{ issueType: '*', statusId: 'verified_custom', requiredFields: ['description', 'estimate'] }] })).status, 200);
    const exported = (await source.request<WorkspaceSnapshot & { schemaVersion: number; [key: string]: unknown }>('/export')).data;
    assert.equal(exported.schemaVersion, 3); assert.equal(exported.workflows?.length, 2);
    assert.equal((await target.request('/import', 'POST', { data: exported })).status, 200);
    const imported = (await target.request<WorkspaceSnapshot>('/workspace')).data;
    assert.equal(imported.workflows?.[0].statuses.some(status => status.id === 'verified_custom'), true);
    assert.equal(imported.issues.some(issue => issue.status === 'verified_custom'), true);
    const historical = imported.issues.find(issue => issue.status === 'verified_custom')!;
    assert.equal(historical.description, ''); assert.equal(historical.estimate, null);
    assert.equal((await target.request(`/issues/${historical.id}`, 'PATCH', { expectedVersion: historical.version, title: '다음 수정부터 필수 속성 검사' })).status, 422);
    const broken = structuredClone(exported); broken.workflows![0].statuses = broken.workflows![0].statuses.filter(status => status.id !== 'verified_custom');
    assert.equal((await target.request('/import', 'POST', { data: broken })).status, 400);
    assert.equal((await target.request<WorkspaceSnapshot>('/workspace')).data.issues.some(issue => issue.status === 'verified_custom'), true);
    const old = (await legacy.request<WorkspaceSnapshot & { schemaVersion: number; [key: string]: unknown }>('/export')).data;
    for (const schemaVersion of [1, 2]) { const data = { ...old, schemaVersion }; delete data.workflows; assert.equal((await target.request('/import', 'POST', { data })).status, 200); const defaults = (await target.request<WorkspaceSnapshot>('/workspace')).data.workflows!; assert.equal(defaults.length, 2); assert.equal(defaults[0].initialStatusId, 'todo'); }
  } finally { for (const f of [source, target, legacy]) { await f.close(); f.remove(); } }
});

test('recategorizing an in-use state atomically reconciles completion timestamps and issue versions', async () => {
  const f = await fixture();
  try {
    const original = (await f.request<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    let workflow = (await f.request<ProjectWorkflow>('/projects/project-neo/workflow', 'PATCH', { ...original, expectedVersion: original.version, statuses: [...original.statuses, { id: 'accepted', label: '승인 확인', color: '#4f9467', category: 'review' }] })).data;
    let issue = (await f.request<Issue>('/issues', 'POST', { projectId: 'project-neo', title: '상태 분류 변경 확인', status: 'accepted' })).data;
    assert.equal(issue.version, 1); assert.equal(issue.completedAt, null);
    workflow = (await f.request<ProjectWorkflow>('/projects/project-neo/workflow', 'PATCH', { ...workflow, expectedVersion: workflow.version, statuses: workflow.statuses.map(status => status.id === 'accepted' ? { ...status, category: 'done' } : status) })).data;
    issue = (await f.request<WorkspaceSnapshot>('/workspace')).data.issues.find(value => value.id === issue.id)!;
    assert.equal(issue.version, 2); assert.ok(issue.completedAt); const completedAt = issue.completedAt;
    workflow = (await f.request<ProjectWorkflow>('/projects/project-neo/workflow', 'PATCH', { ...workflow, expectedVersion: workflow.version, statuses: workflow.statuses.map(status => status.id === 'accepted' ? { ...status, label: '최종 승인' } : status) })).data;
    let latest = (await f.request<WorkspaceSnapshot>('/workspace')).data.issues.find(value => value.id === issue.id)!;
    assert.equal(latest.version, 2); assert.equal(latest.completedAt, completedAt);
    assert.equal((await f.request(`/issues/${issue.id}`, 'PATCH', { expectedVersion: 1, title: '오래된 편집' })).status, 409);
    workflow = (await f.request<ProjectWorkflow>('/projects/project-neo/workflow', 'PATCH', { ...workflow, expectedVersion: workflow.version, statuses: workflow.statuses.map(status => status.id === 'accepted' ? { ...status, category: 'review' } : status) })).data;
    latest = (await f.request<WorkspaceSnapshot>('/workspace')).data.issues.find(value => value.id === issue.id)!;
    assert.equal(latest.completedAt, null); assert.equal(latest.version, 3);
    assert.equal((await f.request('/projects/project-neo/workflow', 'PATCH', { ...workflow, expectedVersion: workflow.version, statuses: workflow.statuses.filter(status => status.id !== 'accepted') })).status, 409);
    assert.equal((await f.request<ProjectWorkflow>('/projects/project-neo/workflow')).data.version, workflow.version);
    assert.equal((await f.request<WorkspaceSnapshot>('/workspace')).data.issues.find(value => value.id === issue.id)?.version, 3);
  } finally { await f.close(); f.remove(); }
});
