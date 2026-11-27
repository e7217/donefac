import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { Comment, Issue, IssueCloneResult, IssueRelation, Project, ProjectIssueSchema, WorkspaceSnapshot } from '../../shared/types';
import { projectWorkflow } from '../../shared/workflow-helpers';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('360px에서 저장된 업무를 복제하고 원본 초안, 편집한 날짜와 응답 유실 재시도를 보존한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { users: [author, assignee, collaborator] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': author.id };
  const suffix = randomUUID().slice(0, 8);
  const project = await json<Project>(await request.post('/api/projects', {
    headers, data: { key: `CL${suffix.toUpperCase()}`, name: `복제 검증 ${suffix}` },
  }), 201);
  const schemaPath = `/api/projects/${project.id}/issue-schema`;
  const schema = await json<ProjectIssueSchema>(await request.get(schemaPath));
  const workflow = projectWorkflow(await json<WorkspaceSnapshot>(await request.get('/api/workspace')), project.id);
  const completed = workflow.statuses.find(value => value.category === 'done')!;
  await json<ProjectIssueSchema>(await request.patch(schemaPath, { headers, data: {
    expectedVersion: schema.version, issueTypes: schema.issueTypes,
    fields: [
      { id: 'reviewed', name: '사전 검토', kind: 'checkbox', description: '', required: false, issueTypes: [], options: [], archived: false },
      { id: 'samples', name: '샘플 수', kind: 'number', description: '', required: false, issueTypes: [], options: [], archived: false },
      { id: 'archived-note', name: '이전 메모', kind: 'text', description: '', required: false, issueTypes: [], options: [], archived: false },
    ],
  } }));
  const original = await json<Issue>(await request.post('/api/issues', { headers, data: {
    projectId: project.id, title: `저장된 원본 ${suffix}`, description: '서버에 저장된 검사 절차', type: '작업', priority: 'high',
    status: completed.id, assigneeId: assignee.id, collaboratorIds: [collaborator.id], labels: ['BOM, 검사', '검증'],
    startDate: '2026-12-01', endDate: '2026-12-04', dueDate: '2026-12-07', estimate: 2.5, plannedEffortMinutes: 120,
    customFields: { reviewed: false, samples: 0, 'archived-note': '이전 텍스트' },
  } }), 201);
  const changedSchema = await json<ProjectIssueSchema>(await request.get(schemaPath));
  await json<ProjectIssueSchema>(await request.patch(schemaPath, { headers, data: {
    expectedVersion: changedSchema.version, issueTypes: changedSchema.issueTypes,
    fields: changedSchema.fields.map(field => field.id === 'archived-note' ? { ...field, archived: true } : field),
  } }));
  await json<Comment>(await request.post('/api/comments', { headers, data: { resourceType: 'issue', resourceId: original.id, body: '원본에 달린 댓글' } }), 201);
  const path = `/api/issues/${original.id}/clone`;

  try {
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), author.id);
    await page.goto(`/#/${project.id}/issues?issue=${original.id}`);
    const originalPanel = page.getByRole('dialog', { name: original.title, exact: true });
    const sourceDescription = originalPanel.getByRole('textbox', { name: '설명', exact: true });
    const sourceComment = originalPanel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const open = originalPanel.getByRole('button', { name: '업무 복제', exact: true });
    await expect(open).toBeVisible({ timeout: 30_000 });
    await sourceDescription.fill('원본의 미저장 설명');
    await sourceComment.fill('원본의 미발송 댓글');
    await open.click();
    const modal = page.getByRole('dialog', { name: '업무 복제', exact: true });
    const title = modal.getByRole('textbox', { name: '업무 제목', exact: true });
    const description = modal.getByRole('textbox', { name: '설명', exact: true });
    const start = modal.getByLabel('시작일', { exact: true });
    const end = modal.getByLabel('종료일', { exact: true });
    const due = modal.getByLabel('목표 마감일', { exact: true });
    await expect(description).toHaveValue(original.description);
    await expect(modal.getByRole('combobox', { name: '프로젝트', exact: true })).toBeDisabled();
    await expect(modal.getByRole('combobox', { name: '새 업무 상태', exact: true })).toHaveValue(workflow.initialStatusId);
    await expect(modal.getByRole('combobox', { name: '담당자', exact: true })).toHaveValue(assignee.id);
    await expect(modal.getByRole('combobox', { name: '사전 검토', exact: true })).toHaveValue('false');
    await expect(modal.getByLabel('샘플 수', { exact: true })).toHaveValue('0');
    await expect(modal.getByLabel('이전 메모', { exact: true })).toHaveCount(0);
    await expect(start).toHaveValue('');
    await expect(end).toHaveValue('');
    await expect(due).toHaveValue('');
    await modal.getByRole('button', { name: '원본 일정 복사', exact: true }).click();
    await expect(start).toHaveValue(original.startDate!);
    await expect(end).toHaveValue(original.endDate!);
    await expect(due).toHaveValue(original.dueDate!);
    if (!(await due.isVisible())) await modal.getByText('추가 속성', { exact: true }).click();
    await due.fill('2026-12-09');
    await title.fill(`복제한 업무 ${suffix}`);
    await description.fill('복제본에서 편집한 검사 절차');

    const nextOriginal = await json<Issue>(await request.patch(`/api/issues/${original.id}`, { headers,
      data: { expectedVersion: original.version, title: `다른 창에서 저장한 원본 ${suffix}` },
    }));
    const submit = modal.getByRole('button', { name: '복제 업무 만들기', exact: true });
    await submit.click();
    const confirm = modal.getByRole('button', { name: '최신 원본 버전 확인', exact: true });
    await expect(confirm).toBeVisible();
    await expect(title).toHaveValue(`복제한 업무 ${suffix}`);
    await expect(due).toHaveValue('2026-12-09');
    await confirm.click();

    const attempts: Record<string, unknown>[] = [];
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      await route.abort('failed');
    });
    await submit.click();
    const retry = modal.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    const result = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await retry.click();
    const response = await result;
    expect(response.status(), await response.text()).toBe(200);
    const created = await response.json() as IssueCloneResult;
    expect(created.duplicate).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0].expectedSourceVersion).toBe(nextOriginal.version);
    expect(created.issue).toMatchObject({ projectId: project.id, title: `복제한 업무 ${suffix}`, description: '복제본에서 편집한 검사 절차',
      status: workflow.initialStatusId, completedAt: null, priority: 'high', assigneeId: assignee.id, collaboratorIds: [collaborator.id],
      parentId: null, cycleId: null, moduleId: null, releaseId: null, labels: original.labels,
      startDate: original.startDate, endDate: original.endDate, dueDate: '2026-12-09', estimate: 2.5, plannedEffortMinutes: 120,
      customFields: { reviewed: false, samples: 0 } });
    expect(created.issue.customFields?.['archived-note']).toBeUndefined();
    expect(created.relation?.type).toBe('related');
    expect([created.relation?.sourceIssueId, created.relation?.targetIssueId].sort()).toEqual([original.id, created.issue.id].sort());
    expect(await json<Comment[]>(await request.get(`/api/comments?resourceType=issue&resourceId=${created.issue.id}`))).toEqual([]);
    const relations = await json<IssueRelation[]>(await request.get(`/api/issues/${original.id}/relations`));
    expect(relations.filter(relation => relation.id === created.relation?.id)).toHaveLength(1);
    await expect(modal).toHaveCount(0);
    const panel = page.getByRole('dialog', { name: nextOriginal.title, exact: true });
    await expect(panel.getByRole('textbox', { name: '설명', exact: true })).toHaveValue('원본의 미저장 설명');
    await expect(panel.getByRole('textbox', { name: '댓글 내용', exact: true })).toHaveValue('원본의 미발송 댓글');
    const resultAction = panel.getByRole('button', { name: `${created.issue.key} 복제 업무 열기`, exact: true });
    await expect(resultAction).toBeFocused();
    await expect(panel.getByRole('region', { name: '업무 관계', exact: true })).toContainText(created.issue.key);
  } finally {
    const snapshot = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    for (const issue of snapshot.issues.filter(issue => issue.projectId === project.id)) {
      const removed = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`, { headers });
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});
