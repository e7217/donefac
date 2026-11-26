import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { CustomFieldDefinition, Issue, Project, ProjectIssueSchema, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

const controllerName = '증빙 사용 여부';
const evidenceName = '조건부 증빙';

function requestAt(page: Page, method: string, path: string) {
  return page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path);
}

test('360px에서 속성 조건을 저장하고, 새 업무·상세·간트에서 표시와 필수 입력을 확인한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const projectReply = await request.post('/api/projects', { data: {
    key: `V${randomUUID().slice(0, 8).toUpperCase()}`, name: '조건부 속성 모바일 검증', color: '#578ca9',
  } });
  expect(projectReply.status(), await projectReply.text()).toBe(201);
  const project = await projectReply.json() as Project;
  const schemaPath = `/api/projects/${project.id}/issue-schema`;
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const issuePath = `/#/${project.id}/issues`;
  const fields: CustomFieldDefinition[] = [
    { id: 'evidence_enabled', name: controllerName, kind: 'checkbox', description: '', required: false, issueTypes: [], options: [], archived: false },
    { id: 'evidence', name: evidenceName, kind: 'text', description: '', required: false, issueTypes: [], options: [], archived: false },
  ];

  try {
    const initialSchema = await (await request.get(schemaPath)).json() as ProjectIssueSchema;
    const schemaSetup = await request.patch(schemaPath, { data: { ...initialSchema, fields, expectedVersion: initialSchema.version } });
    expect(schemaSetup.status(), await schemaSetup.text()).toBe(200);
    const workflow = await (await request.get(workflowPath)).json() as ProjectWorkflow;
    const workflowSetup = await request.patch(workflowPath, { data: {
      ...workflow, expectedVersion: workflow.version, initialStatusId: 'review',
      fieldRules: [{ issueType: '*', statusId: 'done', requiredFields: ['custom:evidence'] }],
    } });
    expect(workflowSetup.status(), await workflowSetup.text()).toBe(200);

    await page.goto(`/#/${project.id}/settings?section=work`);
    const settings = page.getByRole('region', { name: '업무 유형·사용자 정의 속성 설정', exact: true });
    await settings.getByRole('button', { name: /^사용자 정의 속성/ }).click();
    await settings.getByRole('button', { name: '속성 2 세부 설정', exact: true }).click();
    const visibility = settings.getByRole('region', { name: '속성 2 표시 조건', exact: true });
    await expect(visibility).toBeVisible();
    const boundary = await visibility.boundingBox();
    expect(boundary).not.toBeNull();
    expect(boundary!.x).toBeGreaterThanOrEqual(0);
    expect(boundary!.x + boundary!.width).toBeLessThanOrEqual(361);
    const statuses = visibility.locator('summary[aria-label="속성 2 표시 상태"]');
    await statuses.click();
    await visibility.getByRole('checkbox', { name: '속성 2 표시 상태 · 검토', exact: true }).check();
    await statuses.click();
    await visibility.getByLabel('속성 2 표시 기준 속성', { exact: true }).selectOption('evidence_enabled');
    await visibility.getByLabel('속성 2 표시 기준 값', { exact: true }).selectOption('true');
    await settings.getByLabel('속성 2 필수', { exact: true }).check();
    const saveSettings = settings.getByRole('button', { name: '유형·속성 저장', exact: true });
    const settingsSaved = requestAt(page, 'PATCH', schemaPath);
    await saveSettings.click();
    const saved = await settingsSaved;
    expect(saved.status(), await saved.text()).toBe(200);
    const schema = await saved.json() as ProjectIssueSchema;
    expect(schema.fields[1]).toMatchObject({ required: true, visibleWhen: {
      statusIds: ['review'], fieldMatch: { fieldId: 'evidence_enabled', value: true },
    } });
    await expect(visibility.getByLabel('속성 2 표시 기준 값', { exact: true })).toBeEnabled();
    await expect(saveSettings).toBeDisabled();

    await page.goto(issuePath);
    await page.getByRole('button', { name: '업무 만들기', exact: true }).first().click();
    const modal = page.getByRole('dialog', { name: '새 업무 만들기', exact: true });
    const status = modal.getByLabel('새 업무 상태', { exact: true });
    const controller = modal.getByLabel(controllerName, { exact: true });
    const evidence = modal.getByLabel(evidenceName, { exact: true });
    await modal.getByLabel('업무 제목', { exact: true }).fill('가시성 전환에 보존할 티켓');
    await expect(status).toHaveValue('review');
    await expect(evidence).toHaveCount(0);
    await status.selectOption('todo');
    await controller.selectOption('true');
    await expect(evidence).toHaveCount(0);
    await status.selectOption('review');
    await expect(evidence).toHaveAttribute('required', '');
    await evidence.fill('입력한 증빙을 보존합니다');
    await controller.selectOption('false');
    await expect(evidence).toHaveCount(0);
    await controller.selectOption('true');
    await expect(evidence).toHaveValue('입력한 증빙을 보존합니다');
    await controller.selectOption('false');

    const issueCreated = requestAt(page, 'POST', '/api/issues');
    await modal.getByRole('button', { name: '업무 만들기', exact: true }).click();
    const created = await issueCreated;
    expect(created.status(), await created.text()).toBe(201);
    const issue = await created.json() as Issue;
    expect(issue.customFields).toEqual({ evidence_enabled: false, evidence: '입력한 증빙을 보존합니다' });
    await expect(modal).toBeHidden();

    const panel = page.getByRole('dialog');
    const editEvidence = panel.getByLabel(evidenceName, { exact: true });
    await expect(panel.getByLabel(controllerName, { exact: true })).toHaveValue('false');
    await expect(editEvidence).toHaveCount(0);
    await panel.getByLabel('상태', { exact: true }).selectOption('done');
    await expect(editEvidence).toHaveAttribute('required', '');
    await expect(editEvidence).toHaveValue('입력한 증빙을 보존합니다');
    await editEvidence.fill('워크플로에서 명시해 수정한 증빙');
    const issueUpdated = requestAt(page, 'PATCH', `/api/issues/${issue.id}`);
    const saveIssue = panel.getByRole('button', { name: '변경사항 저장', exact: true });
    await saveIssue.click();
    const updated = await issueUpdated;
    expect(updated.status(), await updated.text()).toBe(200);
    expect(await updated.json()).toMatchObject({ version: issue.version + 1, status: 'done', customFields: {
      evidence_enabled: false, evidence: '워크플로에서 명시해 수정한 증빙',
    } });
    await expect(editEvidence).toBeEnabled();
    await expect(saveIssue).toBeDisabled();

    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    const gantt = page.getByRole('form', { name: '간트에서 업무 만들기', exact: true });
    const ganttEvidence = gantt.getByLabel(`추가할 업무 ${evidenceName}`, { exact: true });
    await expect(ganttEvidence).toHaveCount(0);
    await gantt.getByLabel(`추가할 업무 ${controllerName}`, { exact: true }).selectOption('true');
    await expect(ganttEvidence).toHaveAttribute('required', '');
    await gantt.getByLabel('추가할 업무 제목', { exact: true }).fill('간트에서 조건부 증빙 저장');
    await ganttEvidence.fill('검토 기본 상태에서 나타난 증빙');
    const ganttCreated = requestAt(page, 'POST', '/api/issues');
    await gantt.getByRole('button', { name: '간트에 추가', exact: true }).click();
    const ganttResult = await ganttCreated;
    expect(ganttResult.status(), await ganttResult.text()).toBe(201);
    expect(await ganttResult.json()).toMatchObject({ status: 'review', customFields: {
      evidence_enabled: true, evidence: '검토 기본 상태에서 나타난 증빙',
    } });
  } finally {
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    for (const issue of snapshot.issues.filter(value => value.projectId === project.id)) {
      const archived = await request.delete(`/api/issues/${issue.id}`);
      if (!archived.ok()) continue;
      const { trashEntryId } = await archived.json();
      await request.delete(`/api/trash/${trashEntryId}`);
    }
  }
});
