import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Issue, IssueBulkEditPreview, IssueBulkEditResult, Project, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

function migrationResponse(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

test('360px 워크플로에서 차단 사유를 확인하고 저장된 상태로 업무를 옮긴 뒤 설정 초안을 유지한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const key = `SM${randomUUID().slice(0, 8).toUpperCase()}`;
  const created = await request.post('/api/projects', { data: { key, name: `${key} 상태 변경` } });
  expect(created.status(), await created.text()).toBe(201);
  const project = await created.json() as Project;
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const fromStatusId = 'review_old';
  const originalLabel = '정리할 검토 상태';
  const localLabel = '아직 저장하지 않은 상태 이름';
  const issues: Issue[] = [];
  async function issue(title: string, status: string, description = '') {
    const response = await request.post('/api/issues', { data: { projectId: project.id, title, status, description } });
    expect(response.status(), await response.text()).toBe(201);
    const value = await response.json() as Issue;
    issues.push(value);
    return value;
  }

  try {
    const original = await (await request.get(workflowPath)).json() as ProjectWorkflow;
    const update = await request.patch(workflowPath, { data: {
      ...original, expectedVersion: original.version,
      statuses: [...original.statuses, { id: fromStatusId, label: originalLabel, category: 'review', color: '#556aa1' }],
      fieldRules: [{ issueType: '*', statusId: 'done', requiredFields: ['description'] }],
    } });
    expect(update.status(), await update.text()).toBe(200);
    const saved = await update.json() as ProjectWorkflow;
    const ready = await issue('설명을 기록한 이동 대상', fromStatusId, '팀 검토를 마쳤습니다.');
    const blocked = await issue('설명이 비어 있는 이동 대상', fromStatusId);
    const outside = await issue('이동 범위 밖의 업무', 'todo');

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/settings`);
    const settings = page.getByRole('region', { name: '프로젝트 워크플로 설정' });
    const draftName = settings.getByLabel(`상태 ${saved.statuses.length} 이름`, { exact: true });
    await expect(draftName).toBeEnabled({ timeout: 25_000 });
    await draftName.fill(localLabel);
    await settings.getByRole('button', { name: '상태 일괄 변경', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: '상태 일괄 변경', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const source = dialog.getByRole('combobox', { name: '출발 상태', exact: true });
    const target = dialog.getByRole('combobox', { name: '도착 상태', exact: true });
    await expect(source.locator(`option[value="${fromStatusId}"]`)).toHaveText(originalLabel);
    await source.selectOption(fromStatusId);
    await target.selectOption('done');
    const previewButton = dialog.getByRole('button', { name: '변경 미리보기', exact: true });
    const applyButton = dialog.getByRole('button', { name: '상태 이동 적용', exact: true });
    const previewRegion = dialog.getByRole('region', { name: '상태 이동 미리보기', exact: true });

    const previewRequest = migrationResponse(page, `${workflowPath}/status-migration-preview`);
    await previewButton.click();
    const rejected = await previewRequest;
    expect(rejected.status(), await rejected.text()).toBe(200);
    expect(rejected.request().postDataJSON()).toEqual({ fromStatusId, toStatusId: 'done', expectedWorkflowVersion: saved.version });
    const first = await rejected.json() as IssueBulkEditPreview;
    expect(first).toMatchObject({ changed: 1, blocked: 1, previewId: null });
    await expect(previewRegion.getByText('변경 1개 · 차단 1개', { exact: true })).toBeVisible();
    await expect(previewRegion.getByRole('listitem').filter({ hasText: blocked.title })).toContainText('설명');
    await expect(previewRegion.getByText(outside.title, { exact: true })).toHaveCount(0);
    await expect(applyButton).toBeDisabled();
    const before = await workspace(request);
    expect(before.issues.find(value => value.id === ready.id)).toEqual(ready);
    expect(before.issues.find(value => value.id === blocked.id)).toEqual(blocked);
    await previewRegion.getByRole('checkbox', { name: '차단된 업무만 보기', exact: true }).check();
    await expect(previewRegion.getByRole('listitem')).toHaveCount(1);

    const repair = await request.patch(`/api/issues/${blocked.id}`, { data: { expectedVersion: blocked.version, description: '이동 전에 검토 기록을 채웠습니다.' } });
    expect(repair.status(), await repair.text()).toBe(200);
    const repaired = await repair.json() as Issue;
    const newPreviewRequest = migrationResponse(page, `${workflowPath}/status-migration-preview`);
    await previewButton.click();
    const newPreview = await newPreviewRequest;
    expect(newPreview.status(), await newPreview.text()).toBe(200);
    const approved = await newPreview.json() as IssueBulkEditPreview;
    expect(approved).toMatchObject({ changed: 2, blocked: 0 });
    expect(approved.previewId).toBeTruthy();
    await expect(previewRegion.getByText('변경 2개 · 차단 0개', { exact: true })).toBeVisible();
    await expect(applyButton).toBeEnabled();

    const applyRequest = migrationResponse(page, `${workflowPath}/status-migration-apply`);
    await applyButton.click();
    const response = await applyRequest;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ previewId: approved.previewId });
    const result = await response.json() as IssueBulkEditResult;
    expect(new Map(result.updated.map(row => [row.id, row.version]))).toEqual(new Map([
      [ready.id, ready.version + 1], [repaired.id, repaired.version + 1],
    ]));
    await expect(dialog.getByRole('status')).toHaveText('2개 업무의 상태를 변경했습니다.');
    await dialog.getByRole('button', { name: '상태 일괄 변경 닫기', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(draftName).toHaveValue(localLabel);
    await expect(settings.getByRole('button', { name: '워크플로 저장', exact: true })).toBeEnabled();

    const after = await workspace(request);
    expect(after.issues.find(value => value.id === ready.id)?.status).toBe('done');
    expect(after.issues.find(value => value.id === blocked.id)?.status).toBe('done');
    expect(after.issues.find(value => value.id === outside.id)).toEqual(outside);
    expect(after.workflows?.find(value => value.projectId === project.id)).toEqual(saved);
  } finally {
    for (const value of issues) {
      const response = await request.delete(`/api/issues/${value.id}`);
      if (response.ok()) {
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});
