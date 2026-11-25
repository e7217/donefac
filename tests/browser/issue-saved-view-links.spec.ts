import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Issue, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext) {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as WorkspaceSnapshot;
}

async function createIssue(request: APIRequestContext, projectId: string, title: string, status = 'in_progress') {
  const response = await request.post('/api/issues', { data: { projectId, title, status, type: '작업' } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as Issue;
}

async function createView(request: APIRequestContext, projectId: string, name: string, query: string, layout: SavedView['layout']) {
  const response = await request.post('/api/views', { data: {
    projectId, name, layout, filters: { query, status: 'in_progress', assigneeId: 'all', type: '작업' },
  } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as SavedView;
}

function deleteView(request: APIRequestContext, view: SavedView) {
  return request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
}

async function removeIssue(request: APIRequestContext, issue: Issue) {
  const response = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
  if (response.ok()) await request.delete(`/api/trash/${(await response.json()).trashEntryId}`);
}

test('360px에서 문서로 이동한 뒤 개인 담당자별 보드를 복원하고 공유 보기와 분리한다', async ({ page, request }) => {
  const { projects: [project, otherProject], users: [actor, teammate] } = await workspace(request);
  const saved = await createView(request, project.id, `개인 보기 대조 ${randomUUID().slice(0, 8)}`, '', 'list');
  try {
    const base = `/#/${project.id}/issues`;
    const groupedBoard = page.getByRole('region', { name: '담당자별 보드', exact: true });
    const list = page.getByRole('region', { name: '업무 목록', exact: true });
    const emptyGroup = page.getByRole('checkbox', { name: '빈 담당자 그룹 표시', exact: true });
    const pickBoard = page.getByRole('button', { name: '보드', exact: true });
    const grouping = page.getByLabel('보드 그룹', { exact: true });
    const actorPicker = page.getByLabel('작업자 선택', { exact: true });
    const savedPicker = page.getByLabel('저장된 업무 보기', { exact: true });

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(base);
    await expect(list).toBeVisible();
    await pickBoard.click();
    await grouping.selectOption('assignee');
    await emptyGroup.check();
    await expect(groupedBoard).toBeVisible();
    await page.goto(`/#/${project.id}/documents`);
    await expect(groupedBoard).toHaveCount(0);
    await page.goBack();
    await expect(groupedBoard).toBeVisible();
    await expect(emptyGroup).toBeChecked();
    await page.reload();
    await expect(groupedBoard).toBeVisible();
    await expect(emptyGroup).toBeChecked();

    await actorPicker.selectOption(teammate.id);
    await expect(list).toBeVisible();
    await actorPicker.selectOption(actor.id);
    await expect(groupedBoard).toBeVisible();
    await page.goto(`/#/${otherProject.id}/issues`);
    await expect(list).toBeVisible();
    await page.goto(base);
    await expect(groupedBoard).toBeVisible();

    await savedPicker.selectOption(saved.id);
    await expect(list).toBeVisible();
    await expect(savedPicker).toHaveValue(saved.id);
    await pickBoard.click();
    await expect(grouping).toHaveValue('');
    await savedPicker.selectOption('');
    await expect(savedPicker).toHaveValue('');
    await expect(groupedBoard).toBeVisible();
    await expect(emptyGroup).toBeChecked();
  } finally { await deleteView(request, saved); }
});

test('360px에서 공유 보드 링크로 저장한 업무를 다시 열고 상세와 간트를 오간다', async ({ page, context, request }) => {
  test.setTimeout(80_000);
  const { projects: [project] } = await workspace(request);
  const prefix = `공유 보드 주소 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  let view: SavedView | undefined;
  try {
    const target = await createIssue(request, project.id, `${prefix} 대상 업무`);
    issues.push(target);
    const excluded = await createIssue(request, project.id, `${prefix} 다른 상태`, 'todo');
    issues.push(excluded);
    const saved = await createView(request, project.id, `${prefix} 저장 보기`, prefix, 'board');
    view = saved;

    const basePath = `#/${project.id}/issues`;
    const boardPath = `${basePath}?savedView=${saved.id}`;
    const ganttPath = `#/${project.id}/gantt?savedView=${saved.id}`;
    const hash = () => new URL(page.url()).hash;
    const routeParams = () => Object.fromEntries(new URLSearchParams(hash().split('?')[1]));
    const picker = page.getByLabel('저장된 업무 보기', { exact: true });
    const search = page.getByLabel('업무 검색', { exact: true });
    const status = page.getByLabel('상태 필터', { exact: true });
    const type = page.getByLabel('유형 필터', { exact: true });
    const card = page.locator('.issue-board-card').filter({ hasText: target.title });
    const drawer = page.getByRole('dialog', { name: target.title, exact: true });
    const list = page.locator('.issue-table');
    const expectSavedBoard = async () => {
      await expect.poll(hash).toBe(boardPath);
      await expect(picker).toHaveValue(saved.id);
      await expect(search).toHaveValue(prefix);
      await expect(status).toHaveValue('in_progress');
      await expect(type).toHaveValue('작업');
      await expect(card).toBeVisible();
      await expect(page.locator('.issue-board-card').filter({ hasText: excluded.title })).toHaveCount(0);
      await expect(list).toHaveCount(0);
    };

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${boardPath}`);
    await expectSavedBoard();

    await search.fill(`${prefix} 임시 검색`);
    await page.getByRole('button', { name: '목록', exact: true }).click();
    await expect(list).toBeVisible();
    await expect(list.getByText(target.title, { exact: true })).toHaveCount(0);
    const copyButton = page.getByRole('button', { name: '보기 링크 복사', exact: true });
    await copyButton.click();
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    const expectedLink = new URL(boardPath, page.url()).href;
    await expect.poll(clipboard).toBe(expectedLink);
    await page.getByRole('button', { name: '저장된 조건 다시 적용', exact: true }).click();
    await expectSavedBoard();

    await search.fill(`${prefix} 새로고침 전 검색`);
    await page.reload();
    await expectSavedBoard();
    await card.getByText(target.title, { exact: true }).click();
    await expect(drawer).toBeVisible();
    await expect.poll(routeParams).toEqual({ savedView: saved.id, issue: target.id });
    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await expectSavedBoard();
    await page.goForward();
    await expect(drawer).toBeVisible();
    await expect.poll(routeParams).toEqual({ savedView: saved.id, issue: target.id });
    await page.reload();
    await expect(drawer).toBeVisible();
    await expect(picker).toHaveValue(saved.id);
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expectSavedBoard();

    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    await expect.poll(hash).toBe(ganttPath);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.locator('.gantt-row[data-issue-id]')).toHaveCount(1);
    await expect(chart.locator(`[data-issue-id="${target.id}"]`)).toBeVisible();
    await page.getByRole('button', { name: '업무 보기에서 열기', exact: true }).click();
    await expectSavedBoard();

    await page.getByRole('button', { name: '계획·일정 필터', exact: true }).click();
    const planning = page.getByRole('region', { name: '계획·일정 필터', exact: true });
    const date = planning.getByLabel('조회 시작일', { exact: true });
    await planning.getByLabel('일정 조건', { exact: true }).selectOption('due');
    await date.fill('2027-03-08');
    const declined = page.waitForEvent('dialog', { timeout: 10_000 }).then(async dialog => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await picker.selectOption('');
    expect(await declined).toContain('적용하지 않은 계획·일정 조건');
    await expectSavedBoard();
    await expect(planning).toBeVisible();
    await expect(date).toHaveValue('2027-03-08');
    const approved = page.waitForEvent('dialog', { timeout: 10_000 }).then(dialog => dialog.accept());
    await picker.selectOption('');
    await approved;
    await expect.poll(hash).toBe(basePath);
    await expect(picker).toHaveValue('');
    await expect(planning).toBeHidden();
  } finally {
    if (view) await deleteView(request, view);
    for (const issue of issues) await removeIssue(request, issue);
  }
});

test('삭제되었거나 다른 프로젝트의 공유 보기 링크는 전체 업무를 표시하지 않고 해제할 수 있다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const { projects: [project, otherProject] } = await workspace(request);
  const prefix = `열 수 없는 공유 주소 ${randomUUID().slice(0, 8)}`;
  let active: Issue | undefined;
  const views: SavedView[] = [];
  try {
    active = await createIssue(request, project.id, `${prefix} 업무`);
    const stale = await createView(request, project.id, `${prefix} 삭제 대상`, prefix, 'list');
    views.push(stale);
    const foreign = await createView(request, otherProject.id, `${prefix} 외부 보기`, prefix, 'list');
    views.push(foreign);
    const path = `#/${project.id}/issues`;
    const stalePath = `${path}?savedView=${stale.id}`;
    const hash = () => new URL(page.url()).hash;
    const panel = page.locator('.issues-feature');
    const list = panel.locator('.issue-table');
    const row = panel.getByText(active.title, { exact: true });
    const unavailable = panel.getByText('이 프로젝트에서 공유 보기를 열 수 없습니다.', { exact: true });

    await page.goto(`/${stalePath}`);
    await expect(list.getByText(active.title, { exact: true })).toBeVisible();
    await expect(page.getByLabel('저장된 업무 보기', { exact: true })).toHaveValue(stale.id);
    const removal = await deleteView(request, stale);
    expect(removal.ok(), await removal.text()).toBeTruthy();
    views.shift();

    for (const id of [stale.id, foreign.id]) {
      const filteredPath = `${path}?savedView=${id}`;
      await page.goto(`/${filteredPath}`);
      await page.reload();
      await expect.poll(hash).toBe(filteredPath);
      await expect(unavailable).toBeVisible();
      await expect(row).toHaveCount(0);
      await expect(panel.locator('.issue-table tbody tr[data-issue-id], .issue-board-card')).toHaveCount(0);
      await panel.getByRole('button', { name: '공유 보기 해제', exact: true }).click();
      await expect.poll(hash).toBe(path);
      await expect(unavailable).toHaveCount(0);
      await expect(list.getByText(active.title, { exact: true })).toBeVisible();
    }
  } finally {
    for (const view of views) await deleteView(request, view);
    if (active) await removeIssue(request, active);
  }
});

test('보기 이름을 편집 중 뒤로 가기를 거절하면 원래 보기와 입력을 유지한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const { projects: [project] } = await workspace(request);
  const prefix = `공유 보기 이름 초안 ${randomUUID().slice(0, 8)}`;
  const views: SavedView[] = [];
  try {
    const first = await createView(request, project.id, `${prefix} 첫 보기`, prefix, 'list');
    views.push(first);
    const second = await createView(request, project.id, `${prefix} 둘째 보기`, prefix, 'board');
    views.push(second);
    const path = (view: SavedView) => `#/${project.id}/issues?savedView=${view.id}`;
    await page.goto(`/${path(first)}`);
    const picker = page.getByRole('combobox', { name: '저장된 업무 보기', exact: true });
    await expect(picker).toHaveValue(first.id);
    await picker.selectOption(second.id);
    const hash = () => new URL(page.url()).hash;
    await expect.poll(hash).toBe(path(second));
    await page.getByRole('button', { name: '보기 수정', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '저장된 보기 수정', exact: true });
    const name = editor.getByRole('textbox', { name: '보기 이름', exact: true });
    await name.fill(`${prefix} 저장하지 않은 이름`);

    const rejected = page.waitForEvent('dialog').then(async dialog => {
      const type = dialog.type();
      await dialog.dismiss();
      return type;
    });
    await page.goBack();
    expect(await rejected).toBe('confirm');
    await expect.poll(hash).toBe(path(second));
    await expect(name).toHaveValue(`${prefix} 저장하지 않은 이름`);

    const approved = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await page.goBack();
    await approved;
    await expect.poll(hash).toBe(path(first));
    await expect(picker).toHaveValue(first.id);
    await expect(editor).toHaveCount(0);
    const response = await request.get(`/api/views?projectId=${encodeURIComponent(project.id)}`);
    expect(response.ok(), await response.text()).toBeTruthy();
    const stored = await response.json() as SavedView[];
    expect(stored.find(view => view.id === first.id)?.name).toBe(first.name);
    expect(stored.find(view => view.id === second.id)?.name).toBe(second.name);
  } finally {
    for (const view of views) await deleteView(request, view);
  }
});
