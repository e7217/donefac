import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, Issue, IssueOrderMoveResult, IssueRelation, ProjectIssueOrder, ProjectWorkflow, ReportingLedgerData, WorkspaceSnapshot } from '../../shared/types.js';

async function fixture(dataDir?: string, seed = true) {
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'donefac-workflows-'));
  const service = createApp({ dataDir: dir, seed });
  const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('테스트 서버 주소 없음');
  const base = `http://127.0.0.1:${address.port}/api`;
  let closed = false;
  const request = async <T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => { const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as T }; };
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

test('status PATCH can compare the actual project workflow version without rearranging project ranks', async () => {
  const f = await fixture();
  const projectId = 'project-team';
  const workflowPath = `/projects/${projectId}/workflow`, orderPath = `/projects/${projectId}/issue-order`;
  try {
    const created = await f.request<Issue>('/issues', 'POST', { projectId, title: '팀 보드에서 상태를 바꿀 업무' });
    const sibling = await f.request<Issue>('/issues', 'POST', { projectId, title: '수동 순서에 남는 업무' });
    assert.equal(created.status, 201);
    assert.equal(sibling.status, 201);
    const issue = created.data;
    const issuePath = `/issues/${issue.id}`;
    const initialOrder = (await f.request<ProjectIssueOrder>(orderPath)).data;
    const ranked = await f.request<IssueOrderMoveResult>(orderPath, 'PATCH', {
      issueId: issue.id, expectedIssueVersion: issue.version, expectedVersion: initialOrder.version,
      anchorId: sibling.data.id, position: 'after',
    });
    assert.equal(ranked.status, 200);
    assert.deepEqual(ranked.data.issue, issue);
    assert.notDeepEqual(ranked.data.order.issueIds, initialOrder.issueIds);

    const original = (await f.request<ProjectWorkflow>(workflowPath)).data;
    const changed = await f.request<ProjectWorkflow>(workflowPath, 'PATCH', {
      ...original, expectedVersion: original.version,
      statuses: original.statuses.map(state => state.id === 'review' ? { ...state, label: '내부 검토', category: 'in_progress' } : state),
      transitions: original.transitions.map(edge => edge.from === 'todo' && edge.to === 'review' ? { ...edge, requiredFields: ['description'] } : edge),
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.version, original.version + 1);
    const current = async () => (await f.request<WorkspaceSnapshot>('/workspace')).data.issues.find(value => value.id === issue.id);
    assert.deepEqual(await current(), issue);

    const stale = { details: { reason: 'workflow_changed', currentWorkflowVersion: changed.data.version } };
    for (const status of ['review', 'todo']) {
      const rejected = await f.request<typeof stale>(issuePath, 'PATCH', {
        expectedVersion: issue.version, expectedWorkflowVersion: original.version, status,
      });
      assert.equal(rejected.status, 409);
      assert.deepEqual(rejected.data.details, stale.details);
    }
    for (const expectedWorkflowVersion of [0, null, String(changed.data.version), Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await f.request(issuePath, 'PATCH', { expectedVersion: issue.version, expectedWorkflowVersion, status: 'review' })).status, 400);
    }
    assert.equal((await f.request(issuePath, 'PATCH', {
      expectedVersion: issue.version, expectedWorkflowVersion: changed.data.version, title: '상태 없는 조건',
    })).status, 400);
    const validMove = { expectedVersion: issue.version, expectedWorkflowVersion: changed.data.version, status: 'review' };
    assert.equal((await f.request(issuePath, 'PATCH', validMove)).status, 422);
    assert.deepEqual(await current(), issue);
    assert.deepEqual((await f.request<ProjectIssueOrder>(orderPath)).data, ranked.data.order);

    const moved = await f.request<Issue>(issuePath, 'PATCH', { ...validMove, description: '실제 프로젝트의 상태 전이' });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.status, 'review');
    assert.equal(moved.data.projectId, projectId);
    assert.equal(moved.data.version, issue.version + 1);
    const afterMove = (await f.request<ProjectIssueOrder>(orderPath)).data;
    assert.deepEqual(afterMove.issueIds, ranked.data.order.issueIds);
    assert.notEqual(afterMove.version, ranked.data.order.version);
    const sameStatus = await f.request<Issue>(issuePath, 'PATCH', {
      expectedVersion: moved.data.version, expectedWorkflowVersion: changed.data.version, status: 'review', title: '상태를 유지한 업무 편집',
    });
    assert.equal(sameStatus.status, 200);
    assert.equal(sameStatus.data.title, '상태를 유지한 업무 편집');
    const ordinary = await f.request<Issue>(issuePath, 'PATCH', { expectedVersion: sameStatus.data.version, status: 'todo' });
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.data.status, 'todo');
  } finally { await f.close(); f.remove(); }
});

test('opt-in transitions require live incoming native blockers to be resolved, with scoped generic errors and compatible workflow PATCH', async () => {
  const f = await fixture();
  const primary = 'project-neo', secondary = 'project-team';
  const path = `/projects/${primary}/workflow`;
  const isGuardedEdge = ({ from, to }: { from: string; to: string }) => from === 'todo' && to === 'done';
  const readWorkflow = async (projectId: string) => (await f.request<ProjectWorkflow>(`/projects/${projectId}/workflow`)).data;
  const saveGuard = (workflow: ProjectWorkflow, requireResolvedBlockers: unknown) => f.request<ProjectWorkflow>(path, 'PATCH', {
    ...workflow, expectedVersion: workflow.version, transitions: workflow.transitions.map(edge => isGuardedEdge(edge) ? { ...edge, requireResolvedBlockers } : edge),
  });
  async function createIssue(projectId: string, title: string) {
    const result = await f.request<Issue>('/issues', 'POST', { projectId, title });
    assert.equal(result.status, 201);
    return result.data;
  }
  const changeStatus = (issue: Issue, status: string) => f.request<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, status });
  const link = (source: Issue, target: Issue, type: 'blocks' | 'related') =>
    f.request<IssueRelation>(`/issues/${source.id}/relations`, 'POST', { otherIssueId: target.id, type, direction: 'outgoing' });
  const blocked = { error: '열린 차단 업무를 해결한 뒤 상태를 변경해 주세요.', details: { reason: 'open_issue_blockers' } };
  try {
    const target = await createIssue(primary, '종료할 업무');
    const local = await createIssue(primary, '같은 프로젝트의 차단 업무');
    const foreign = await createIssue(secondary, '다른 프로젝트의 차단 업무');
    const reference = await createIssue(secondary, '차단과 무관한 참조 업무');
    type Backup = { issueRelations: IssueRelation[]; schemaVersion: number };
    const backup = (await f.request<Backup>('/export')).data;
    const imported: IssueRelation = { id: randomUUID(), sourceIssueId: reference.id, targetIssueId: target.id,
      type: 'blocks', version: 1, createdAt: new Date().toISOString() };
    assert.equal((await f.request('/import', 'POST', { data: { ...backup, issueRelations: [...backup.issueRelations, imported] } })).status, 200);
    const issues = (await f.request<WorkspaceSnapshot>('/workspace')).data.issues;
    let current = issues.find(issue => issue.id === target.id)!;
    const localCurrent = issues.find(issue => issue.id === local.id)!;
    const foreignCurrent = issues.find(issue => issue.id === foreign.id)!;
    assert.equal((await link(local, target, 'blocks')).status, 201);
    assert.equal((await link(target, reference, 'blocks')).status, 201);
    assert.equal((await link(reference, target, 'related')).status, 201);

    const customStatus = { id: 'withdrawn', label: '철회됨', color: '#7f838f', category: 'cancelled' } as const;
    const defaultPrimary = await readWorkflow(primary);
    const primaryWorkflow = await f.request<ProjectWorkflow>(path, 'PATCH', { ...defaultPrimary, expectedVersion: defaultPrimary.version,
      statuses: [...defaultPrimary.statuses, { ...customStatus, label: '검토 중', category: 'review' }] });
    assert.equal(primaryWorkflow.status, 200);
    const secondaryWorkflow = await readWorkflow(secondary);
    const secondaryPath = `/projects/${secondary}/workflow`;
    assert.equal((await f.request(secondaryPath, 'PATCH', { ...secondaryWorkflow, expectedVersion: secondaryWorkflow.version,
      statuses: [...secondaryWorkflow.statuses, customStatus], transitions: [...secondaryWorkflow.transitions,
        { from: 'todo', to: customStatus.id, issueTypes: [], requiredFields: [] },
        { from: customStatus.id, to: 'todo', issueTypes: [], requiredFields: [] }] })).status, 200);

    for (const invalid of [null, 'true', 1, {}]) assert.equal((await saveGuard(primaryWorkflow.data, invalid)).status, 400);
    const enabled = await saveGuard(primaryWorkflow.data, true);
    assert.equal(enabled.status, 200);
    const legacyClient = await f.request<ProjectWorkflow>(path, 'PATCH', { ...enabled.data, expectedVersion: enabled.data.version,
      transitions: enabled.data.transitions.map(({ from, to, issueTypes, requiredFields }) => ({ from, to, issueTypes, requiredFields })).reverse() });
    assert.equal(legacyClient.status, 200);
    assert.equal(legacyClient.data.transitions.find(isGuardedEdge)?.requireResolvedBlockers, true);
    assert.equal(legacyClient.data.transitions.filter(edge => edge.requireResolvedBlockers).length, 1);

    const ordinaryEdit = await f.request<Issue>(`/issues/${current.id}`, 'PATCH', { expectedVersion: current.version, title: '차단 중 세부 내용 편집' });
    assert.equal(ordinaryEdit.status, 200);
    current = ordinaryEdit.data;
    assert.deepEqual(await changeStatus(current, 'done'), { status: 422, data: blocked });
    assert.equal((await changeStatus(localCurrent, 'done')).status, 200);
    assert.equal((await link(foreign, target, 'blocks')).status, 201);
    const key = await f.request<ApiKeyCreated>('/api-keys', 'POST', { name: '대상 프로젝트 전용', access: 'write', projectIds: [primary] });
    assert.equal(key.status, 201);
    const headers = { Authorization: `Bearer ${key.data.token}` };
    const guarded = await f.request(`/v1/issues/${current.id}`, 'PATCH', { expectedVersion: current.version, status: 'done' }, headers);
    assert.deepEqual(guarded, { status: 422, data: blocked });

    const closedBlocker = await changeStatus(foreignCurrent, customStatus.id);
    assert.equal(closedBlocker.status, 200);
    const closed = await changeStatus(current, 'done');
    assert.equal(closed.status, 200);
    assert.equal(closed.data.status, 'done');
    const reopened = await changeStatus(closed.data, 'todo');
    assert.equal(reopened.status, 200);
    assert.equal((await changeStatus(closedBlocker.data, 'todo')).status, 200);
    assert.equal((await changeStatus(reopened.data, 'done')).status, 422);
    const disabled = await saveGuard(legacyClient.data, false);
    assert.equal(disabled.status, 200);
    assert.equal(Object.hasOwn(disabled.data.transitions.find(isGuardedEdge)!, 'requireResolvedBlockers'), false);
    assert.equal((await changeStatus(reopened.data, 'done')).status, 200);
  } finally { await f.close(); f.remove(); }
});

test('a selected transition requires direct subtasks to be terminal and preserves the guard for older workflow clients', async () => {
  const f = await fixture();
  const projectId = 'project-neo';
  const workflowPath = `/projects/${projectId}/workflow`;
  const guarded = (edge: ProjectWorkflow['transitions'][number]) => edge.from === 'todo' && edge.to === 'done';
  const saveGuard = (workflow: ProjectWorkflow, requireClosedSubtasks: unknown) => f.request<ProjectWorkflow>(workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    transitions: workflow.transitions.map(edge => guarded(edge) ? { ...edge, requireClosedSubtasks } : edge),
  });
  const create = async (title: string, parent?: Issue) => {
    const result = await f.request<Issue>('/issues', 'POST', { projectId, title, ...(parent ? { parentId: parent.id } : {}) });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  };
  const patch = <T = Issue>(issue: Issue, values: Partial<Issue>) => f.request<T>(`/issues/${issue.id}`, 'PATCH', {
    ...values, expectedVersion: issue.version,
  });
  const change = async (issue: Issue, status: string) => {
    const result = await patch(issue, { status });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const expectBlocked = async (issue: Issue, activeChildren: Issue[]) => {
    const { status, data } = await patch<{ error: string; details: { reason: string; issueId: string; issueKey: string } }>(issue, { status: 'done' });
    assert.equal(status, 422, JSON.stringify(data));
    assert.equal(data.error, '열린 하위 업무를 먼저 완료하거나 취소해 주세요.');
    assert.equal(data.details.reason, 'open_subtasks');
    assert.ok(activeChildren.some(child => child.id === data.details.issueId && child.key === data.details.issueKey));
  };
  try {
    const original = (await f.request<ProjectWorkflow>(workflowPath)).data;
    const customStates = [
      { id: 'verified_done', label: '검증 완료', category: 'done', color: '#248964' },
      { id: 'withdrawn_custom', label: '철회', category: 'cancelled', color: '#7f838f' },
    ] as const;
    const configured = await f.request<ProjectWorkflow>(workflowPath, 'PATCH', {
      ...original, expectedVersion: original.version, statuses: [...original.statuses, ...customStates],
      transitions: [...original.transitions, ...customStates.flatMap(({ id }) => [
        { from: 'todo', to: id, issueTypes: [], requiredFields: [] },
        { from: id, to: 'todo', issueTypes: [], requiredFields: [] },
      ])],
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.data));
    for (const invalid of [null, 'true', 1, {}]) assert.equal((await saveGuard(configured.data, invalid)).status, 400);
    const enabled = await saveGuard(configured.data, true);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    const legacy = await f.request<ProjectWorkflow>(workflowPath, 'PATCH', {
      ...enabled.data, expectedVersion: enabled.data.version,
      transitions: enabled.data.transitions.map(({ from, to, issueTypes, requiredFields }) => ({ from, to, issueTypes, requiredFields })).reverse(),
    });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.data));
    assert.equal(legacy.data.transitions.find(guarded)?.requireClosedSubtasks, true);
    assert.equal(legacy.data.transitions.filter(edge => edge.requireClosedSubtasks).length, 1);

    let parent = await create('완료 전에 하위 업무를 검토할 티켓');
    const first = await create('직접 하위 업무', parent);
    const second = await create('취소될 직접 하위 업무', parent);
    const trashed = await create('휴지통으로 보낼 직접 하위 업무', parent);
    const grandchild = await create('간접 하위 업무', first);
    const unrelated = await create('별도 흐름에 남는 열린 업무');
    const ordinaryEdit = await patch(parent, { title: '하위 진행 중에도 업무 제목 편집' });
    assert.equal(ordinaryEdit.status, 200, JSON.stringify(ordinaryEdit.data));
    parent = ordinaryEdit.data;
    await expectBlocked(parent, [first, second, trashed]);
    parent = await change(await change(parent, 'review'), 'todo');
    await expectBlocked(parent, [first, second, trashed]);

    const completeChild = await change(first, 'verified_done');
    await change(second, 'withdrawn_custom');
    await expectBlocked(parent, [trashed]);
    const scopedKey = await f.request<ApiKeyCreated>('/api-keys', 'POST', { name: '하위 업무 전이 검사', access: 'write', projectIds: [projectId] });
    assert.equal(scopedKey.status, 201);
    assert.deepEqual(await f.request(`/v1/issues/${parent.id}`, 'PATCH', { expectedVersion: parent.version, status: 'done' }, {
      Authorization: `Bearer ${scopedKey.data.token}`,
    }), { status: 422, data: { error: '열린 하위 업무를 먼저 완료하거나 취소해 주세요.',
      details: { reason: 'open_subtasks', issueId: trashed.id, issueKey: trashed.key } } });
    const deleted = await f.request(`/issues/${trashed.id}?expectedVersion=${trashed.version}`, 'DELETE');
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    const done = await change(parent, 'done');
    const latest = (await f.request<WorkspaceSnapshot>('/workspace')).data.issues;
    assert.deepEqual(latest.find(issue => issue.id === grandchild.id), grandchild);
    assert.deepEqual(latest.find(issue => issue.id === unrelated.id), unrelated);
    assert.equal(latest.some(issue => issue.id === trashed.id), false);

    parent = await change(done, 'todo');
    const reopenedChild = await change(completeChild, 'todo');
    await expectBlocked(parent, [reopenedChild]);
    const disabled = await saveGuard(legacy.data, false);
    assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
    assert.equal(Object.hasOwn(disabled.data.transitions.find(guarded)!, 'requireClosedSubtasks'), false);
    await change(parent, 'done');
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

test('board limits preserve old workflow clients, allow transitions above the limit, and roundtrip format 56', async () => {
  type Backup = WorkspaceSnapshot & { schemaVersion: number; reportingLedger: ReportingLedgerData };
  const f = await fixture(), target = await fixture(undefined, false);
  const projectId = 'project-neo';
  const path = `/projects/${projectId}/workflow`;
  const save = (workflow: ProjectWorkflow, limit: unknown) => f.request<ProjectWorkflow>(path, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => status.id === 'review' ? { ...status, wipLimit: limit } : status),
  });
  const statusIn = (workflow: ProjectWorkflow, id = 'review') => workflow.statuses.find(status => status.id === id)!;
  try {
    const original = (await f.request<ProjectWorkflow>(path)).data;
    assert.equal(Object.hasOwn(statusIn(original), 'wipLimit'), false);
    const before = (await f.request<Backup>('/export')).data;
    const ready = await save(original, 1);
    assert.equal(ready.status, 200);
    assert.equal(statusIn(ready.data).wipLimit, 1);
    const afterLimit = (await f.request<Backup>('/export')).data;
    assert.deepEqual(afterLimit.issues, before.issues);
    assert.deepEqual(afterLimit.reportingLedger.events, before.reportingLedger.events);
    assert.equal((await save(original, null)).status, 409);
    for (const invalid of [0, -1, 0.5, 10_001, '3', true, {}, []]) {
      assert.equal((await save(ready.data, invalid)).status, 400, JSON.stringify(invalid));
    }
    assert.deepEqual((await f.request<ProjectWorkflow>(path)).data, ready.data);

    const oldStatuses = ready.data.statuses.map(({ id, label, color, category }) => ({ id, label, color, category }));
    const oldClient = await f.request<ProjectWorkflow>(path, 'PATCH', {
      ...ready.data, expectedVersion: ready.data.version,
      statuses: oldStatuses.reverse().map(status => status.id === 'done' ? { ...status, wipLimit: 10_000 } : status),
    });
    assert.equal(oldClient.status, 200);
    assert.equal(statusIn(oldClient.data).wipLimit, 1);
    assert.equal(statusIn(oldClient.data, 'done').wipLimit, 10_000);
    for (const title of ['한도에 도달하는 업무', '한도를 넘겨 이동하는 업무']) {
      const created = await f.request<Issue>('/issues', 'POST', { projectId, title });
      assert.equal(created.status, 201);
      const moved = await f.request<Issue>(`/issues/${created.data.id}`, 'PATCH', { expectedVersion: created.data.version, status: 'review' });
      assert.equal(moved.status, 200);
      assert.equal(moved.data.status, 'review');
    }

    const exported = (await f.request<Backup>('/export')).data;
    assert.equal(exported.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.equal((await target.request('/import', 'POST', { data: exported })).status, 200);
    const previousFormat = { ...exported, issueChangeHistory: undefined };
    assert.equal((await target.request('/import', 'POST', { data: { ...previousFormat, schemaVersion: 56 } })).status, 200);
    const restored = (await target.request<ProjectWorkflow>(path)).data;
    assert.equal(statusIn(restored).wipLimit, 1);
    assert.equal(statusIn(restored, 'done').wipLimit, 10_000);
    const mislabeled = await target.request<{ error: string }>('/import', 'POST', { data: { ...previousFormat, schemaVersion: 55 } });
    assert.equal(mislabeled.status, 400);
    assert.match(mislabeled.data.error, /schemaVersion 56/);
    assert.equal(statusIn((await target.request<ProjectWorkflow>(path)).data).wipLimit, 1);
    const broken = structuredClone(exported);
    statusIn(broken.workflows!.find(workflow => workflow.projectId === projectId)!).wipLimit = -1;
    assert.equal((await target.request('/import', 'POST', { data: broken })).status, 400);

    const cleared = await save(oldClient.data, null);
    assert.equal(cleared.status, 200);
    assert.equal(Object.hasOwn(statusIn(cleared.data), 'wipLimit'), false);
    assert.equal(statusIn(cleared.data, 'done').wipLimit, 10_000);
    assert.equal((await target.request('/import', 'POST', { data: { ...before, schemaVersion: 55 } })).status, 200);
    assert.equal(Object.hasOwn(statusIn((await target.request<ProjectWorkflow>(path)).data), 'wipLimit'), false);
  } finally { for (const fixture of [f, target]) { await fixture.close(); fixture.remove(); } }
});

test('current backup roundtrips custom workflows; legacy1/2 receive defaults; invalid imported state references rollback', async () => {
  const source = await fixture(), target = await fixture(undefined, false), legacy = await fixture();
  try {
    const original = (await source.request<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    const custom = { ...original, expectedVersion: original.version, statuses: [...original.statuses, { id: 'verified_custom', label: '검증 완료', category: 'done', color: '#40805e' }] };
    assert.equal((await source.request('/projects/project-neo/workflow', 'PATCH', custom)).status, 200);
    assert.equal((await source.request('/issues', 'POST', { projectId: 'project-neo', title: '이관할 사용자 정의 상태', status: 'verified_custom' })).status, 201);
    const configured = (await source.request<ProjectWorkflow>('/projects/project-neo/workflow')).data;
    assert.equal((await source.request('/projects/project-neo/workflow', 'PATCH', { ...configured, expectedVersion: configured.version, fieldRules: [{ issueType: '*', statusId: 'verified_custom', requiredFields: ['description', 'estimate'] }] })).status, 200);
    const exported = (await source.request<WorkspaceSnapshot & { schemaVersion: number; [key: string]: unknown }>('/export')).data;
    assert.equal(exported.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION); assert.equal(exported.workflows?.length, 2);
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
