import { randomUUID } from 'node:crypto';
import { expect, test, type Request } from '@playwright/test';
import type { Issue, Project, ProjectWorkflow } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 } });

test('360px 보드 한도는 필터에서 숨긴 하위 업무를 포함하고 실제 상태 전이를 허용한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const key = `WI${randomUUID().slice(0, 8).toUpperCase()}`;
  const result = await request.post('/api/projects', { data: { key, name: `${key} 보드 한도 검증` } });
  expect(result.status(), await result.text()).toBe(201);
  const project: Project = await result.json();
  const issueRoute = `/#/${project.id}/issues`;
  const settingsRoute = `/#/${project.id}/settings`;
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const created: Issue[] = [];

  async function createIssue(title: string, status: string, parentId?: string): Promise<Issue> {
    const response = await request.post('/api/issues', { data: { title, status, parentId, projectId: project.id } });
    expect(response.status(), await response.text()).toBe(201);
    const issue: Issue = await response.json();
    created.push(issue);
    return issue;
  }

  const settings = page.getByRole('region', { name: '프로젝트 워크플로 설정', exact: true });
  const limit = settings.getByLabel('업무 한도 진행 중', { exact: true });
  const saveWorkflow = settings.getByRole('button', { name: '워크플로 저장', exact: true });
  async function saveLimit(value: string): Promise<ProjectWorkflow> {
    await limit.fill(value);
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === workflowPath && response.request().method() === 'PATCH');
    await saveWorkflow.click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    await expect(saveWorkflow).toBeDisabled();
    return response.json();
  }

  const progress = page.locator('.issue-board-column[data-status-id="in_progress"]');
  const todo = page.locator('.issue-board-column[data-status-id="todo"]');
  const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
  const card = (id: string) => page.locator(`.issue-board-card[data-issue-id="${id}"]`);
  async function openBoard() {
    await page.goto(issueRoute);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    await expect(progress).toBeVisible();
  }

  async function changeStatus(issue: Issue, status: string) {
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    await panel.getByLabel('상태', { exact: true }).selectOption(status);
    const changed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${issue.id}` && response.request().method() === 'PATCH');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const response = await changed;
    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json() as Issue).status).toBe(status);
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(panel).toHaveCount(0);
  }

  try {
    const visible = await createIssue(`${key} 첫 카드`, 'in_progress');
    const parent = await createIssue(`${key} 상위 업무`, 'in_progress');
    const child = await createIssue(`${key} 하위 업무`, 'todo', parent.id);

    await page.goto(settingsRoute);
    await expect(limit).toBeEnabled();
    await expect(limit).toHaveValue('');
    await limit.fill('10001');
    await settings.getByRole('button', { name: '진행 중 위로', exact: true }).click();
    await expect(limit).toHaveValue('10001');
    await settings.getByRole('button', { name: '진행 중 아래로', exact: true }).click();
    let invalidSaves = 0;
    const trackInvalidSave = (request: Request) => {
      if (new URL(request.url()).pathname === workflowPath && request.method() === 'PATCH') invalidSaves++;
    };
    page.on('request', trackInvalidSave);
    try {
      await saveWorkflow.click();
      await expect(settings.getByRole('alert')).toContainText('업무 한도를 1~10,000 사이의 정수로 입력해 주세요.');
      await expect(limit).toHaveValue('10001');
      expect(invalidSaves).toBe(0);
    } finally {
      page.off('request', trackInvalidSave);
    }
    const saved = await saveLimit('2');
    expect(saved.statuses.find(state => state.id === 'in_progress')?.wipLimit).toBe(2);

    await openBoard();
    await expect(progress.getByText('2 / 2', { exact: true })).toBeVisible();
    await expect(progress.getByText('한도 도달', { exact: true })).toBeVisible();
    await expect(todo.locator('.issue-board-card')).toHaveCount(1);
    await card(child.id).click();
    await changeStatus(child, 'in_progress');
    await expect(progress.getByText('3 / 2', { exact: true })).toBeVisible();
    await expect(progress.getByText('1개 초과', { exact: true })).toBeVisible();
    await expect(progress.locator('.issue-board-card')).toHaveCount(3);

    await search.fill(visible.title);
    await expect(progress.locator('.issue-board-card')).toHaveCount(1);
    await expect(progress.getByText('표시 1개', { exact: true })).toBeVisible();
    await expect(progress.getByText('3 / 2', { exact: true })).toBeVisible();
    await expect(progress.getByText('1개 초과', { exact: true })).toBeVisible();
    const summary = page.getByRole('button', { name: '진행 중 한도 초과 업무 보기', exact: true });
    const columnOpener = progress.getByRole('button', { name: '진행 중 전체 업무 보기', exact: true });
    await columnOpener.click();
    const details = page.getByRole('region', { name: '진행 중 한도 업무', exact: true });
    await expect(details.getByRole('heading', { name: '진행 중 한도 업무', exact: true })).toBeFocused();
    await expect(details.getByText(/현재 보드 필터 밖 2개/)).toBeVisible();
    await details.getByRole('button', { name: '한도 업무 닫기', exact: true }).click();
    await expect(columnOpener).toBeFocused();
    await summary.click();
    const childLink = details.getByRole('button', { name: `${child.key} ${child.title}`, exact: true });
    for (const issue of [visible, parent, child]) {
      await expect(details.getByRole('button', { name: `${issue.key} ${issue.title}`, exact: true })).toBeVisible();
    }
    await childLink.focus();
    await expect(childLink).toBeFocused();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: child.title, exact: true });
    const closePanel = panel.getByRole('button', { name: '업무 상세 닫기', exact: true });
    await expect(panel).toBeVisible();
    await expect(closePanel).toBeFocused();
    await expect(page.locator('.workspace-content')).toHaveAttribute('inert', '');
    await page.keyboard.press('Enter');
    await expect(panel).toHaveCount(0);
    await expect(details).toBeVisible();
    await expect(childLink).toBeFocused();
    await expect(search).toHaveValue(visible.title);

    await childLink.click();
    await changeStatus(child, 'review');
    await expect(details.getByRole('heading', { name: '진행 중 한도 업무', exact: true })).toBeFocused();
    await expect(progress.getByText('2 / 2', { exact: true })).toBeVisible();
    await expect(progress.getByText('한도 도달', { exact: true })).toBeVisible();
    await expect(progress.getByText('1개 초과', { exact: true })).toHaveCount(0);
    await expect(progress.locator('.issue-board-card')).toHaveCount(1);
    await expect(search).toHaveValue(visible.title);
    expect(await page.locator('body').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(362);

    await page.goto(settingsRoute);
    await expect(limit).toHaveValue('2');
    const cleared = await saveLimit('');
    expect(cleared.statuses.find(state => state.id === 'in_progress')).not.toHaveProperty('wipLimit');
    await openBoard();
    await expect(progress.locator('.issue-board-card')).toHaveCount(2);
    await expect(progress.getByText('2 / 2', { exact: true })).toHaveCount(0);
    await expect(progress.getByText('한도 도달', { exact: true })).toHaveCount(0);

    await createIssue(`${key} 추가 검토 업무`, 'review');
    const longLabel = 'ReleaseValidationAwaitingAdditionalSignoff'.slice(0, 40);
    const configured = await request.patch(workflowPath, { data: {
      ...cleared, expectedVersion: cleared.version,
      statuses: cleared.statuses.map(state => ['in_progress', 'review'].includes(state.id)
        ? { ...state, label: longLabel, wipLimit: 1 } : state),
    } });
    expect(configured.status(), await configured.text()).toBe(200);
    await page.reload();
    await openBoard();
    const over = page.getByRole('region', { name: '보드 한도 초과', exact: true });
    for (const id of ['in_progress', 'review']) {
      const label = `${longLabel} (${id})`;
      await expect(over.getByRole('button', { name: `${label} 한도 초과 업무 보기`, exact: true })).toBeVisible();
      await expect(page.locator(`.issue-board-column[data-status-id="${id}"]`).getByText(label, { exact: true })).toBeVisible();
    }
    expect(await page.locator('body').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(362);
  } finally {
    for (const issue of created.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});
