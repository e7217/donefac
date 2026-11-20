import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Issue, IssueChildCreationResult, Project, ProjectIssueSchema, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createIssue(request: APIRequestContext, projectId: string, title: string, type?: string): Promise<Issue> {
  const response = await request.post('/api/issues', { data: { projectId, title, type } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

async function cleanup(request: APIRequestContext, parentId: string) {
  const snapshot = await workspace(request);
  for (const child of snapshot.issues.filter(issue => issue.parentId === parentId)) await request.delete(`/api/issues/${child.id}`);
  await request.delete(`/api/issues/${parentId}`);
}

test('360px에서 상위 업무의 초안을 유지한 채 하위 업무를 만들고 목록·보드·간트에서 상위를 연다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const projectResponse = await request.post('/api/projects', { data: { key: `CH${suffix.toUpperCase()}`, name: `하위 업무 검증 ${suffix}` } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = await projectResponse.json() as Project;
  const schemaPath = `/api/projects/${project.id}/issue-schema`;
  const schema = await (await request.get(schemaPath)).json() as ProjectIssueSchema;
  const updatedSchema = await request.patch(schemaPath, { data: {
    expectedVersion: schema.version, issueTypes: schema.issueTypes,
    fields: [{ id: 'acceptance', name: '검증 기준', description: '', kind: 'text', required: true, issueTypes: ['작업'], options: [], archived: false }],
  } });
  expect(updatedSchema.ok(), await updatedSchema.text()).toBe(true);
  const parent = await createIssue(request, project.id, `상위 설계 ${suffix}`, '큰틀');
  const childTitle = `하위 검토 ${suffix}`;
  const path = `/api/issues/${parent.id}/children`;
  const attempts: Record<string, unknown>[] = [];
  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues?issue=${parent.id}`);
    const parentDialog = page.getByRole('dialog', { name: parent.title, exact: true });
    const children = parentDialog.getByRole('region', { name: '하위 업무', exact: true });
    const add = children.getByRole('button', { name: '하위 업무 추가', exact: true });
    const modal = page.getByRole('dialog', { name: '하위 업무 만들기', exact: true });
    const parentDescription = parentDialog.getByRole('textbox', { name: '설명', exact: true });
    const parentComment = parentDialog.getByRole('textbox', { name: '댓글 내용', exact: true });
    await parentDescription.fill('부모 업무의 작성 중 설명');
    await parentComment.fill('부모 업무의 미전송 댓글');
    await add.click();
    await expect(modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(parentDescription).toHaveValue('부모 업무의 작성 중 설명');

    await add.click();
    const bounds = await modal.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const fixedProject = modal.getByRole('combobox', { name: '프로젝트', exact: true });
    await expect(fixedProject).toHaveValue(project.id);
    await expect(fixedProject).toBeDisabled();
    await expect(modal).toContainText(`${parent.key} ${parent.title}`);
    await modal.getByRole('textbox', { name: '업무 제목', exact: true }).fill(childTitle);
    const acceptance = modal.getByRole('textbox', { name: '검증 기준', exact: true });
    await expect(acceptance).toHaveAttribute('required');
    await acceptance.fill('시험 결과 확인');
    await modal.getByLabel('시작일', { exact: true }).fill('2026-11-20');
    await modal.getByLabel('종료일', { exact: true }).fill('2026-11-24');
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) {
        expect((await route.fetch()).status()).toBe(201);
        await route.abort('failed');
      } else await route.continue();
    });
    await modal.getByRole('button', { name: '하위 업무 만들기', exact: true }).click();
    const retry = modal.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    await expect(modal.getByRole('textbox', { name: '업무 제목', exact: true })).toHaveValue(childTitle);
    const received = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST');
    await retry.click();
    const replay = await received;
    expect(replay.status(), await replay.text()).toBe(200);
    const result = await replay.json() as IssueChildCreationResult;
    expect(result.duplicate).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(result.issue).toMatchObject({ parentId: parent.id, projectId: project.id, title: childTitle, startDate: '2026-11-20', endDate: '2026-11-24', customFields: { acceptance: '시험 결과 확인' } });
    await expect(modal).toHaveCount(0);
    await expect(children.getByRole('button', { name: new RegExp(childTitle) })).toBeVisible();
    await expect(children).toContainText('완료 0개');
    await expect(parentDescription).toHaveValue('부모 업무의 작성 중 설명');
    await expect(parentComment).toHaveValue('부모 업무의 미전송 댓글');
    const snapshot = await workspace(request);
    expect(snapshot.issues.find(issue => issue.id === parent.id)).toEqual(parent);
    expect(snapshot.issues.filter(issue => issue.parentId === parent.id)).toEqual([result.issue]);

    const confirmed = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await parentDialog.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await confirmed;
    await expect(parentDialog).toHaveCount(0);
    const titleFilter = page.getByRole('textbox', { name: '업무 검색', exact: true });
    await expect(page.locator(`tr[data-issue-id="${parent.id}"]`)).toContainText('하위 업무 1개');
    await titleFilter.fill(childTitle);
    const label = `상위 업무 열기 ${parent.key} ${parent.title}`;
    await expect(page.locator(`tr[data-issue-id="${parent.id}"]`)).toHaveCount(0);
    await page.locator(`tr[data-issue-id="${result.issue.id}"]`).getByRole('button', { name: label, exact: true }).click();
    await expect(parentDialog).toBeVisible();
    await parentDialog.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    await page.getByRole('button', { name: '보드', exact: true }).click();
    await expect(page.locator(`[data-order-card="${parent.id}"]`)).toHaveCount(0);
    await page.locator(`[data-order-card="${result.issue.id}"]`).getByRole('button', { name: label, exact: true }).click();
    await expect(parentDialog).toBeVisible();
    await parentDialog.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
    await page.getByRole('button', { name: '간트 · 일정', exact: true }).click();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.locator(`[data-issue-id="${parent.id}"]`)).toContainText('하위 업무 1개');
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(childTitle);
    await expect(chart.locator(`[data-issue-id="${parent.id}"]`)).toHaveCount(0);
    await chart.locator(`[data-issue-id="${result.issue.id}"]`).getByRole('button', { name: label, exact: true }).click();
    await expect(parentDialog).toBeVisible();
    expect(new URL(page.url()).hash).toContain('/gantt?');
  } finally {
    await cleanup(request, parent.id);
  }
});

test('상위 업무의 버전이 변경되면 최신 상태를 확인하고 작성한 하위 업무를 저장한다', async ({ page, request }) => {
  const { projects: [project] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const parent = await createIssue(request, project.id, `상위 검토 ${suffix}`);
  const latestTitle = `개정한 상위 검토 ${suffix}`;
  const childTitle = `보존할 하위 업무 ${suffix}`;
  const path = `/api/issues/${parent.id}/children`;
  try {
    await page.goto(`/#/${project.id}/issues?issue=${parent.id}`);
    const parentDialog = page.getByRole('dialog', { name: parent.title, exact: true });
    await parentDialog.getByRole('button', { name: '하위 업무 추가', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '하위 업무 만들기', exact: true });
    const title = modal.getByRole('textbox', { name: '업무 제목', exact: true });
    await title.fill(childTitle);
    const changed = await request.patch(`/api/issues/${parent.id}`, { data: { expectedVersion: parent.version, title: latestTitle } });
    expect(changed.ok(), await changed.text()).toBe(true);
    const latest = await changed.json() as Issue;
    const submit = modal.getByRole('button', { name: '하위 업무 만들기', exact: true });
    const reply = () => page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST');
    const conflict = reply();
    await submit.click();
    expect((await conflict).status()).toBe(409);
    await expect(modal.getByRole('alert')).toBeVisible();
    await expect(title).toHaveValue(childTitle);
    await modal.getByRole('button', { name: '최신 상위 업무 사용', exact: true }).click();
    await expect(modal).toContainText(latestTitle);
    await expect(title).toHaveValue(childTitle);
    const saved = reply();
    await submit.click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON().expectedParentVersion).toBe(latest.version);
    await expect(modal).toHaveCount(0);
    const updatedParent = page.getByRole('dialog', { name: latestTitle, exact: true });
    await expect(updatedParent.getByRole('region', { name: '하위 업무', exact: true })).toContainText(childTitle);
  } finally {
    await cleanup(request, parent.id);
  }
});

test('상위 업무가 휴지통으로 이동한 뒤에도 하위 업무의 작성 내용은 대화상자에 남는다', async ({ page, request }) => {
  const { projects: [project] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const parent = await createIssue(request, project.id, `삭제되는 상위 업무 ${suffix}`);
  const childTitle = `보존할 입력 ${suffix}`;
  try {
    await page.goto(`/#/${project.id}/issues?issue=${parent.id}`);
    await page.getByRole('button', { name: '하위 업무 추가', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '하위 업무 만들기', exact: true });
    const title = modal.getByRole('textbox', { name: '업무 제목', exact: true });
    await title.fill(childTitle);
    const removed = await request.delete(`/api/issues/${parent.id}?expectedVersion=${parent.version}`);
    expect(removed.ok(), await removed.text()).toBe(true);
    const response = page.waitForResponse(result => result.url().endsWith(`/api/issues/${parent.id}/children`) && result.request().method() === 'POST');
    const submit = modal.getByRole('button', { name: '하위 업무 만들기', exact: true });
    await submit.click();
    expect((await response).status()).toBe(404);
    await expect(modal.getByRole('alert')).toHaveText('상위 업무를 찾을 수 없습니다.');
    await expect(title).toHaveValue(childTitle);
    await expect(title).toBeEditable();
    await expect(submit).toBeDisabled();
    expect((await workspace(request)).issues.some(issue => issue.title === childTitle)).toBe(false);
  } finally {
    await cleanup(request, parent.id);
  }
});
