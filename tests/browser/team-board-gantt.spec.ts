import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

const settingsPath = '/api/integrations/gitlab';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const location = (page: Page) => {
  const [path, query] = new URL(page.url()).hash.split('?');
  return { path, ...Object.fromEntries(new URLSearchParams(query)) };
};

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function expectIssues(panel: Locator, issues: Issue[]) {
  await expect(panel.locator('[data-issue-id]')).toHaveCount(issues.length);
  for (const issue of issues) await expect(panel.locator(`[data-issue-id="${issue.id}"]`)).toBeVisible();
}

test('360px 팀 보드의 GitLab 검토 범위를 간트에서 열고 여러 프로젝트 일정표로 내려받는다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const { projects: [first, second], users: [actor, peer] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const original = await json<GitlabSettings>(await request.get(settingsPath));
  expect(original.baseUrl).toBe('');
  const gitlabUrl = 'https://gitlab-team-gantt.example.test';
  const webhookSecret = `synthetic-team-gantt-${randomUUID()}`;
  const repositoryId = 74;
  const suffix = randomUUID().slice(0, 8);
  const query = `검토 ${suffix} 전환`;
  const created: Issue[] = [];
  const timestamp = Date.now() - 60_000;

  async function create(projectId: string, title: string, assigneeId = actor.id, startDate: string | null = '2031-11-03') {
    const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
      projectId, title, assigneeId, startDate, endDate: '2031-11-04',
    } }), 201);
    created.push(issue);
    return issue;
  }

  async function pipeline(issue: Issue, id: number, state: 'failed' | 'success' | 'running' | 'manual', elapsed: number) {
    const result = await json<{ linked: number; duplicate: boolean }>(await request.post(`${settingsPath}/webhook`, {
      headers: { 'X-Gitlab-Token': webhookSecret, 'webhook-id': randomUUID() }, data: {
        object_kind: 'pipeline', project: { id: repositoryId, web_url: `${gitlabUrl}/team/repository` },
        object_attributes: { id, ref: `feature/${issue.key}`, status: state, updated_at: new Date(timestamp + elapsed * 1000).toISOString() },
      },
    }));
    expect(result).toMatchObject({ linked: 1, duplicate: false });
  }

  try {
    await json<GitlabSettings>(await request.patch(settingsPath, { headers, data: {
      expectedVersion: original.version, baseUrl: gitlabUrl, projectIds: [repositoryId], webhookSecret,
    } }));
    const west = await create(first.id, `전환 서쪽 ${suffix} 검토`);
    const east = await create(second.id, `전환 동쪽 ${suffix} 검토`, actor.id, null);
    const differentOwner = await create(second.id, `전환 다른 담당자 ${suffix} 검토`, peer.id);
    const running = await create(second.id, `전환 실행 중 ${suffix} 검토`);
    const offQuery = await create(second.id, `검색 제외 ${suffix} 검토`);
    await create(second.id, `전환 개발 활동 없음 ${suffix} 검토`);
    await pipeline(west, 701, 'failed', 1);
    await pipeline(east, 702, 'failed', 2);
    await pipeline(differentOwner, 703, 'failed', 3);
    await pipeline(running, 704, 'running', 4);
    await pipeline(offQuery, 705, 'failed', 5);

    const board = page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
    const gantt = page.getByRole('region', { name: '간트 차트', exact: true });
    const owner = page.getByRole('combobox', { name: '담당자 필터', exact: true });
    const project = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    const gitlab = page.getByRole('combobox', { name: 'GitLab 조건', exact: true });
    const boardSearch = page.getByRole('searchbox', { name: '보드 업무 검색', exact: true });
    const ganttSearch = page.getByLabel('간트 업무 검색', { exact: true });
    const member = `member:${actor.id}`;
    const failed = 'failed_pipeline';
    const ganttPath = `#/${first.id}/gantt`;
    const boardScope = { path: `#/${first.id}/teamboard`, boardProject: second.id, boardMember: actor.id, boardQuery: query, boardGitlab: failed };
    const teamScope = { path: ganttPath, scope: 'team', ganttAssignee: actor.id, ganttQ: query, ganttGitlab: failed };
    const projectScope = { ...teamScope, ganttProject: second.id };

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/${boardScope.path}`);
    await boardSearch.fill(query);
    await project.selectOption(second.id);
    await owner.selectOption(member);
    await gitlab.selectOption(failed);
    await expect.poll(() => location(page)).toEqual(boardScope);
    await expectIssues(board, [east]);

    async function checkProjectScope() {
      await expect.poll(() => location(page)).toEqual(projectScope);
      await expect(project).toHaveValue(second.id);
      await expect(owner).toHaveValue(member);
      await expect(gitlab).toHaveValue(failed);
      await expect(ganttSearch).toHaveValue(query);
    }

    await button(page, '현재 조건으로 간트 열기').click();
    await checkProjectScope();
    await expectIssues(gantt, [east]);
    await page.reload();
    await checkProjectScope();
    await expectIssues(gantt, [east]);

    await page.goBack();
    await expect.poll(() => location(page)).toEqual(boardScope);
    await expect(boardSearch).toHaveValue(query);
    await expect(project).toHaveValue(second.id);
    await expect(owner).toHaveValue(member);
    await expect(gitlab).toHaveValue(failed);
    await expectIssues(board, [east]);
    await button(page, '현재 조건으로 간트 열기').click();

    await project.selectOption('');
    await expect.poll(() => location(page)).toEqual(teamScope);
    await expectIssues(gantt, [west, east]);
    const [download] = await Promise.all([
      page.waitForEvent('download'), button(page, '일정 편집용 TSV 내려받기').click(),
    ]);
    expect(download.suggestedFilename()).toBe('teamspace-schedule-all.tsv');
    const sheet = await readFile(await download.path(), 'utf8');
    expect(sheet.trimEnd().split(/\r?\n/).slice(1).map(line => line.split('\t')[0]).sort()).toEqual([west.key, east.key].sort());

    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace'
      && response.request().method() === 'GET' && response.status() === 200);
    await pipeline(east, 706, 'success', 6);
    await button(page, '간트 새로고침').click();
    await refreshed;
    await expectIssues(gantt, [west]);
    await expect(gitlab).toHaveValue(failed);

    const narrowed = `${query} ${west.key}`;
    await ganttSearch.fill(narrowed);
    await expect.poll(() => location(page)).toEqual({ ...teamScope, ganttQ: narrowed });
    await expectIssues(gantt, [west]);
    await page.goBack();
    await checkProjectScope();
    await expectIssues(gantt, []);
    await page.goForward();
    await expect.poll(() => location(page)).toEqual({ ...teamScope, ganttQ: narrowed });
    await expect(ganttSearch).toHaveValue(narrowed);
    await ganttSearch.fill(query);
    await gitlab.selectOption('running_pipeline');
    await expect.poll(() => location(page)).toEqual({ ...teamScope, ganttGitlab: 'running_pipeline' });
    await expectIssues(gantt, [running]);

    await pipeline(east, 707, 'manual', 7);
    await pipeline(differentOwner, 708, 'manual', 8);
    const { path, ...boardFilters } = boardScope;
    await page.goto(`/${path}?${new URLSearchParams(boardFilters)}`);
    await gitlab.selectOption('manual_pipeline');
    await expect.poll(() => location(page)).toEqual({ ...boardScope, boardGitlab: 'manual_pipeline' });
    await expectIssues(board, [east]);
    await button(page, '현재 조건으로 간트 열기').click();
    const manualScope = { ...projectScope, ganttGitlab: 'manual_pipeline' };
    await expect.poll(() => location(page)).toEqual(manualScope);
    await expectIssues(gantt, [east]);
    await page.reload();
    await expect(gitlab).toHaveValue('manual_pipeline');
    await expect.poll(() => location(page)).toEqual(manualScope);
    await expectIssues(gantt, [east]);

    const manualBoardScope = { ...boardScope, boardGitlab: 'manual_pipeline' };
    await page.goBack();
    await expect.poll(() => location(page)).toEqual(manualBoardScope);
    await button(page, `${east.key} 업무 열기`).click();
    const drawer = page.getByRole('dialog', { name: east.title, exact: true });
    const title = drawer.getByLabel('제목', { exact: true });
    const openSchedule = drawer.getByRole('button', { name: '간트에서 일정 보기', exact: true });
    const boardDetailScope = { ...manualBoardScope, issue: east.id };
    await expect.poll(() => location(page)).toEqual(boardDetailScope);
    await title.fill(`${east.title} 확인 중`);
    const declined = page.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await openSchedule.click();
    expect(await declined).toContain('저장하지 않은 업무');
    await expect(title).toHaveValue(`${east.title} 확인 중`);
    await expect.poll(() => location(page)).toEqual(boardDetailScope);

    const approved = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await openSchedule.click();
    await approved;
    const focusedScope = { ...manualScope, focusIssue: east.id };
    await expect.poll(() => location(page)).toEqual(focusedScope);
    await expect(drawer).toHaveCount(0);
    await expectIssues(gantt, [east]);
    const row = gantt.locator(`[data-issue-id="${east.id}"]`);
    const start = row.getByLabel(`${east.key} 시작일`, { exact: true });
    await expect(row).toHaveAttribute('data-focused-issue', 'true');
    await expect(start).toBeFocused();
    await expect(start).toBeInViewport({ ratio: 0.9 });
    const applied = page.waitForResponse(response => response.url().endsWith('/api/schedule/manual-apply')
      && response.request().method() === 'POST' && response.ok());
    await start.fill('2031-11-03');
    await start.press('Enter');
    await applied;
    await expect.poll(async () => (await json<WorkspaceSnapshot>(await request.get('/api/workspace'))).issues
      .find(issue => issue.id === east.id)?.startDate).toBe('2031-11-03');
    await expect.poll(() => location(page)).toEqual(focusedScope);

    await page.goBack();
    await expect.poll(() => location(page)).toEqual(boardDetailScope);
    await expect(title).toHaveValue(east.title);
    await expect(drawer.getByLabel('시작일', { exact: true })).toHaveValue('2031-11-03');
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect.poll(() => location(page)).toEqual(manualBoardScope);
    await expectIssues(board, [east]);
  } finally {
    try {
      for (const issue of created.reverse()) {
        const removed = await request.delete(`/api/issues/${issue.id}`, { headers });
        if (!removed.ok()) continue;
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    } finally {
      const active = await json<GitlabSettings>(await request.get(settingsPath));
      if (active.baseUrl === gitlabUrl) await json<GitlabSettings>(await request.patch(settingsPath, { headers, data: {
        expectedVersion: active.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    }
  }
});
