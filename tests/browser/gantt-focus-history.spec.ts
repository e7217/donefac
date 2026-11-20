import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Issue, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function projects(request: APIRequestContext) {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as WorkspaceSnapshot).projects;
}

async function createIssue(request: APIRequestContext, projectId: string, title: string) {
  const response = await request.post('/api/issues', {
    data: { projectId, title, startDate: '2027-03-08', endDate: '2027-03-10' },
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as Issue;
}

async function removeIssue(request: APIRequestContext, issue: Issue) {
  const response = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
  if (response.ok()) await request.delete(`/api/trash/${(await response.json()).trashEntryId}`);
}

test('간트 업무 위치 이동을 취소하면 초안을 유지하고 뒤로 가면 원래 공유 보기와 상세를 복원한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const [project] = await projects(request);
  const prefix = `간트 위치 이력 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  let view: SavedView | undefined;
  try {
    const target = await createIssue(request, project.id, `${prefix} 기준 티켓`);
    issues.push(target);
    const sibling = await createIssue(request, project.id, `${prefix} 옆 티켓`);
    issues.push(sibling);
    const viewResponse = await request.post('/api/views', { data: {
      projectId: project.id, name: `${prefix} 공유 보기`, layout: 'list',
      filters: { query: target.title, status: 'all', assigneeId: 'all', type: 'all' },
    } });
    expect(viewResponse.status(), await viewResponse.text()).toBe(201);
    view = await viewResponse.json() as SavedView;

    const ganttPath = `#/${project.id}/gantt`;
    const sharedPath = `${ganttPath}?savedView=${view.id}`;
    const focusPath = `${ganttPath}?focusIssue=${target.id}`;
    const hash = () => new URL(page.url()).hash;
    const parameters = () => Object.fromEntries(new URLSearchParams(hash().split('?')[1]));
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const targetRow = chart.locator(`[data-issue-id="${target.id}"]`);
    const siblingRow = chart.locator(`[data-issue-id="${sibling.id}"]`);
    const picker = page.getByRole('combobox', { name: '간트 공유 보기', exact: true });

    await page.goto(`/${sharedPath}`);
    await expect(picker).toHaveValue(view.id);
    await expect(siblingRow).toHaveCount(0);
    await targetRow.getByRole('button', { name: new RegExp(target.title) }).click();
    const drawer = page.getByRole('dialog', { name: target.title, exact: true });
    await expect(drawer).toBeVisible();
    await expect.poll(parameters).toEqual({ savedView: view.id, issue: target.id });
    const previousPath = hash();
    const title = drawer.getByLabel('제목', { exact: true });
    const comment = drawer.getByLabel('댓글 내용', { exact: true });
    const openSchedule = drawer.getByRole('button', { name: '간트에서 일정 보기', exact: true });
    await title.fill('작성 중인 간트 이동 검사 제목');
    await comment.fill('아직 보내지 않은 간트 이동 검사 댓글');

    const declined = page.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await openSchedule.click();
    expect(await declined).toContain('저장하지 않은 업무');
    await expect.poll(hash).toBe(previousPath);
    await expect(title).toHaveValue('작성 중인 간트 이동 검사 제목');
    await expect(comment).toHaveValue('아직 보내지 않은 간트 이동 검사 댓글');

    const approved = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await openSchedule.click();
    await approved;
    await expect.poll(hash).toBe(focusPath);
    await expect(drawer).toHaveCount(0);
    await expect(picker).toHaveValue('');
    await expect(targetRow).toHaveAttribute('data-focused-issue', 'true');
    await expect(siblingRow).toBeVisible();

    await page.goBack();
    await expect.poll(hash).toBe(previousPath);
    await expect(drawer).toBeVisible();
    await expect(title).toHaveValue(target.title);
    await expect(comment).toHaveValue('');
    await expect(picker).toHaveValue(view.id);
    await expect(siblingRow).toHaveCount(0);

    await page.goForward();
    await expect.poll(hash).toBe(focusPath);
    await expect(drawer).toHaveCount(0);
    await siblingRow.getByRole('button', { name: new RegExp(sibling.title) }).click();
    const siblingDrawer = page.getByRole('dialog', { name: sibling.title, exact: true });
    await expect(siblingDrawer).toBeVisible();
    await expect.poll(parameters).toEqual({ focusIssue: target.id, issue: sibling.id });
    await expect(targetRow).toHaveAttribute('data-focused-issue', 'true');

    await page.reload();
    await expect(siblingDrawer).toBeVisible();
    await expect.poll(parameters).toEqual({ focusIssue: target.id, issue: sibling.id });
    await expect(targetRow).toHaveAttribute('data-focused-issue', 'true');
    const chartHasFocus = await chart.evaluate(async element => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return element.contains(document.activeElement);
    });
    expect(chartHasFocus).toBe(false);

    const siblingComment = siblingDrawer.getByLabel('댓글 내용', { exact: true });
    await siblingComment.fill('브라우저 뒤로 가기에서 보호할 댓글');
    const declineBack = page.waitForEvent('dialog').then(dialog => dialog.dismiss());
    await page.goBack();
    await declineBack;
    await expect.poll(parameters).toEqual({ focusIssue: target.id, issue: sibling.id });
    await expect(siblingComment).toHaveValue('브라우저 뒤로 가기에서 보호할 댓글');
    const approveClose = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await siblingDrawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await approveClose;
    await expect.poll(hash).toBe(focusPath);
    await expect(siblingDrawer).toHaveCount(0);
    await expect(targetRow).toHaveAttribute('data-focused-issue', 'true');

    await picker.selectOption(view.id);
    await expect.poll(hash).toBe(sharedPath);
    await expect(picker).toHaveValue(view.id);
    await expect(targetRow).toBeVisible();
    await expect(chart.locator('[data-focused-issue="true"]')).toHaveCount(0);
    await expect(siblingRow).toHaveCount(0);
  } finally {
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of issues) await removeIssue(request, issue);
  }
});

test('삭제되었거나 다른 프로젝트의 업무 위치 링크를 열어도 현재 프로젝트 간트에서 계속 작업할 수 있다', async ({ page, request }) => {
  const [project, otherProject] = await projects(request);
  const prefix = `사라진 업무 위치 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  let retiredTrashId: string | undefined;
  try {
    const active = await createIssue(request, project.id, `${prefix} 현재 티켓`);
    issues.push(active);
    const foreign = await createIssue(request, otherProject.id, `${prefix} 다른 프로젝트 티켓`);
    issues.push(foreign);
    const retired = await createIssue(request, project.id, `${prefix} 삭제할 티켓`);
    issues.push(retired);
    const deleted = await request.delete(`/api/issues/${retired.id}?expectedVersion=${retired.version}`);
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
    retiredTrashId = (await deleted.json()).trashEntryId;

    const ganttPath = `#/${project.id}/gantt`;
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const unavailable = page.getByText('이 프로젝트에서 대상 업무를 찾을 수 없습니다.', { exact: true });
    for (const missing of [retired, foreign]) {
      const path = `${ganttPath}?focusIssue=${missing.id}`;
      await page.goto(`/${path}`);
      await expect(unavailable).toBeVisible();
      await expect.poll(() => new URL(page.url()).hash).toBe(path);
      await expect(chart.locator(`[data-issue-id="${active.id}"]`)).toBeVisible();
      await expect(chart.locator(`[data-issue-id="${missing.id}"]`)).toHaveCount(0);
      await expect(chart.locator('[data-focused-issue="true"]')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: '업무 위치 해제', exact: true }).click();
      await expect.poll(() => new URL(page.url()).hash).toBe(ganttPath);
      await expect(unavailable).toHaveCount(0);
      await expect(chart.locator(`[data-issue-id="${active.id}"]`)).toBeVisible();
    }
  } finally {
    if (retiredTrashId) await request.delete(`/api/trash/${retiredTrashId}`);
    for (const issue of issues) await removeIssue(request, issue);
  }
});
