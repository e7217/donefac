import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { CustomFieldDefinition, CustomFieldValue, Issue, IssueFieldBreakdown, Project, ProjectIssueSchema, SavedView } from '../../shared/types';

test('저장된 보기로 숫자 필드를 집계하고 변경이 발생하면 다시 조회한다', async ({ page, request }) => {
  const key = `FB${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const projectResponse = await request.post('/api/projects', { data: { key, name: `필드 집계 ${key}` } });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json() as Project;
  const schemaPath = `/api/projects/${project.id}/issue-schema`;
  const schema = await (await request.get(schemaPath)).json() as ProjectIssueSchema;
  const fields: CustomFieldDefinition[] = [
    { id: 'metric', name: '검증 점수', description: '', kind: 'number', required: false, issueTypes: ['작업'], options: [], archived: false },
    { id: 'approved', name: '검토 완료', description: '', kind: 'checkbox', required: false, issueTypes: [], options: [], archived: false },
  ];
  const patched = await request.patch(schemaPath, { data: { ...schema, expectedVersion: schema.version, fields } });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  const created: Issue[] = [];
  async function createIssue(suffix: string, type: string, customFields: Record<string, CustomFieldValue>) {
    const response = await request.post('/api/issues', { data: { projectId: project.id, title: `집계 대상 ${key} ${suffix}`, type, customFields } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    return issue;
  }

  let view: SavedView | undefined;
  try {
    const zero = await createIssue('영점', '작업', { metric: 0, approved: false });
    await createIssue('양수', '작업', { metric: 20, approved: false });
    await createIssue('값 없음', '작업', { approved: false });
    await createIssue('미적용', '버그', { approved: false });
    await createIssue('선택 제외', '작업', { metric: 99, approved: true });
    const viewResponse = await request.post('/api/views', { data: {
      projectId: project.id, name: '검토 대기', layout: 'list', filters: {
        query: '집계 대상', status: 'all', assigneeId: 'all', type: 'all',
        fieldFilter: { match: 'all', rules: [{ fieldId: 'approved', operator: 'equals', value: false }] },
      },
    } });
    expect(viewResponse.status(), await viewResponse.text()).toBe(201);
    view = await viewResponse.json() as SavedView;

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/reports`);
    await page.getByRole('tab', { name: '필드 집계', exact: true }).click();
    const form = page.getByRole('form', { name: '필드 집계 조회 조건' });
    const bounds = await form.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await form.getByLabel('집계할 사용자 정의 필드').selectOption('metric');
    const viewSelect = form.getByLabel('필드 집계 저장된 보기');
    await viewSelect.selectOption(view.id);

    page.once('dialog', popup => void popup.dismiss());
    await page.getByRole('tab', { name: '작업 시간', exact: true }).click();
    await expect(viewSelect).toHaveValue(view.id);
    const query = form.getByRole('button', { name: '필드 집계 조회', exact: true });
    const summaryPath = `/api/projects/${project.id}/field-breakdown`;
    const summaryResponse = page.waitForResponse(response => response.url().endsWith(summaryPath));
    await query.click();
    const summary = await (await summaryResponse).json() as IssueFieldBreakdown;
    expect(summary).toMatchObject({
      savedView: { id: view.id }, totalIssues: 4, applicableIssues: 3, populatedIssues: 2,
      missingIssues: 1, notApplicableIssues: 1, numeric: { min: 0, max: 20, average: 10, sum: 20 },
    });
    const statistics = page.getByRole('region', { name: '숫자 필드 통계' });
    await expect(statistics).toContainText('평균10');
    const zeroGroup = page.getByRole('button', { name: '그룹 0 업무 보기', exact: true });
    await expect(zeroGroup.locator('xpath=ancestor::tr')).toContainText('25%');
    await zeroGroup.click();
    const groupIssues = page.getByRole('region', { name: '필드 집계 그룹 업무' });
    const issueLink = groupIssues.getByRole('button', { name: `${zero.key} ${zero.title}`, exact: true });
    await issueLink.click();
    const drawer = page.getByRole('dialog', { name: zero.title, exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '업무 상세 닫기' }).click();

    const changedTitle = `${zero.title} 수정됨`;
    const changed = await request.patch(`/api/issues/${zero.id}`, { data: { expectedVersion: zero.version, title: changedTitle } });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const drillResponse = page.waitForResponse(response => response.url().endsWith(`${summaryPath}/issues`));
    await zeroGroup.click();
    expect((await drillResponse).status()).toBe(409);
    await expect(page.getByRole('status').filter({ hasText: '집계 이후' })).toBeVisible();
    await expect(zeroGroup).toBeDisabled();
    await expect(issueLink).toBeDisabled();

    await query.click();
    await expect(zeroGroup).toBeEnabled();
    await zeroGroup.click();
    await groupIssues.getByRole('button', { name: `${zero.key} ${changedTitle}`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: changedTitle, exact: true })).toBeVisible();
  } finally {
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of created) await request.delete(`/api/issues/${issue.id}`);
  }
});
