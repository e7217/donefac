import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse } from '@playwright/test';
import type { DocPage, GitlabSettings, Issue, Project, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

test('360px 보드와 저장 보기에서 GitLab 병합 확인 상태를 확인하고 같은 수정 시각의 조회로 갱신한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const project = await json<Project>(await request.post('/api/projects', { data: {
    key: `MR${suffix}`, name: `합성 병합 확인 ${suffix}`,
  } }), 201);
  const integration = '/api/integrations/gitlab';
  const syncPath = `${integration}/sync`;
  const original = await json<GitlabSettings>(await request.get(integration));
  expect(original.baseUrl).toBe('');
  expect(original.projectIds).toEqual([]);
  const issues: Issue[] = [];
  let savedView: SavedView | undefined;
  let document: DocPage | undefined;
  const repositoryId = 42;
  const repositoryPath = `/lab/api/v4/projects/${repositoryId}`;
  const updatedAt = new Date(Date.now() - 60_000).toISOString();
  const remoteCalls: string[] = [];
  let approvalRequired = true;
  let baseUrl = '';
  const mrTitle = (issue: Issue) => `${issue.key} 병합 요청`;
  const mock = createServer((incoming, response) => {
    const path = new URL(incoming.url ?? '/', 'http://fixture.test').pathname;
    remoteCalls.push(`${incoming.method} ${path}`);
    response.setHeader('Content-Type', 'application/json');
    if (incoming.method === 'GET' && path === `${repositoryPath}/merge_requests`) {
      const detailed = [approvalRequired ? 'not_approved' : 'mergeable', 'conflict', 'checking'];
      response.end(JSON.stringify(issues.map((issue, index) => ({
        id: 700 + index,
        iid: index + 1,
        project_id: repositoryId,
        target_project_id: repositoryId,
        title: mrTitle(issue),
        state: 'opened',
        updated_at: updatedAt,
        source_branch: `feature/${issue.key}`,
        sha: `${index + 1}`.repeat(40),
        detailed_merge_status: detailed[index],
        web_url: `${baseUrl}/team/repo/-/merge_requests/${index + 1}`,
      }))));
    } else if (incoming.method === 'GET' && path === `${repositoryPath}/pipelines`) {
      response.end('[]');
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/lab`;

  try {
    for (const label of ['승인 대기 업무', '충돌 확인 업무', '검사 중 업무']) {
      issues.push(await json<Issue>(await request.post('/api/issues', { data: {
        projectId: project.id, title: `${suffix} ${label}`,
      } }), 201));
    }
    const [waiting, conflicting, checking] = issues;
    const configured = await json<GitlabSettings>(await request.patch(integration, { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId],
    } }));
    await expect(json(await request.post(syncPath, { data: { expectedVersion: configured.version } })))
      .resolves.toMatchObject({ scanned: 3, linked: 3 });
    const workspace = () => request.get('/api/workspace').then(response => json<WorkspaceSnapshot>(response));
    const beforeWaiting = (await workspace()).gitlabLinks.find(link => link.issueId === waiting.id);
    expect(beforeWaiting).toMatchObject({ updatedAt, state: 'opened', mergeReadiness: { state: 'approval_required', source: 'read' } });

    const issuesPath = `#/${project.id}/issues`;
    await page.goto(`/${issuesPath}`);
    const filter = page.getByRole('combobox', { name: 'GitLab 조건', exact: true });
    const list = (issue: Issue) => page.locator(`.issue-table tr[data-issue-id="${issue.id}"]`);
    const card = (issue: Issue) => page.locator(`.issue-board-card[data-issue-id="${issue.id}"]`);
    await expect(list(waiting)).toContainText('병합 확인 필요 1개');
    await expect(list(conflicting)).toContainText('병합 확인 필요 1개');
    await expect(list(checking)).toContainText('열린 MR 1개');
    await expect(list(checking)).not.toContainText('병합 확인 필요');
    await filter.selectOption({ label: '병합 확인이 필요한 MR' });
    await expect(filter).toHaveValue('merge_blocked');
    await expect(page.locator('.issue-table tr[data-issue-id]')).toHaveCount(2);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    await expect(card(waiting)).toBeVisible();
    await expect(card(conflicting)).toBeVisible();
    await expect(card(checking)).toHaveCount(0);

    await page.getByRole('button', { name: '현재 보기 저장', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '업무 보기 저장', exact: true });
    await editor.getByLabel('보기 이름', { exact: true }).fill(`${suffix} 병합 확인 보기`);
    const saved = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/views' && response.request().method() === 'POST');
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    savedView = await json<SavedView>(await saved, 201);
    expect(savedView).toMatchObject({ layout: 'board', filters: { gitlab: 'merge_blocked' } });
    const savedPath = `${issuesPath}?savedView=${savedView.id}`;
    await expect(page).toHaveURL(url => url.hash === savedPath);
    await page.reload();
    await expect(filter).toHaveValue('merge_blocked');
    await expect(card(waiting)).toBeVisible();

    await card(waiting).click();
    const panel = page.getByRole('dialog', { name: waiting.title, exact: true });
    const row = panel.getByRole('region', { name: 'GitLab', exact: true }).locator('.gitlab-activity-row').filter({ hasText: mrTitle(waiting) });
    const readiness = row.getByRole('group', { name: 'MR 병합 확인', exact: true });
    await expect(readiness.getByText('승인 대기', { exact: true })).toBeVisible();
    await expect(readiness.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT.+Z$/);
    await expect(row).not.toContainText('not_approved');
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === savedPath);

    document = await json<DocPage>(await request.post('/api/documents', { data: {
      projectId: project.id, title: `${suffix} 팀 병합 확인`, content: {
        type: 'doc', content: [{ type: 'issueList', attrs: {
          projectId: project.id, savedViewId: savedView.id, label: savedView.name,
        } }],
      },
    } }), 201);
    const reader = await page.context().newPage();
    await reader.setViewportSize({ width: 360, height: 820 });
    await reader.goto(`/#/${project.id}/documents/${document.id}`);
    const documentRows = reader.getByRole('region', { name: '업무 목록', exact: true });
    const listed = (issue: Issue) => documentRows.getByRole('button', { name: `목록 업무 열기 ${issue.key} ${issue.title}`, exact: true });
    await expect(listed(waiting)).toBeVisible();
    await expect(listed(conflicting)).toBeVisible();
    await expect(listed(checking)).toHaveCount(0);

    const development = await page.context().newPage();
    await development.setViewportSize({ width: 360, height: 820 });
    await development.goto(`/#/${project.id}/development`);
    const developmentRow = development.locator('.gitlab-activity-row').filter({ hasText: mrTitle(waiting) });
    await expect(developmentRow.getByText('승인 대기', { exact: true })).toBeVisible();
    approvalRequired = false;
    const syncing = development.waitForResponse(response =>
      new URL(response.url()).pathname === syncPath && response.request().method() === 'POST');
    await development.getByRole('button', { name: '지금 동기화', exact: true }).click();
    const syncResponse = await syncing;
    expect(syncResponse.status(), await syncResponse.text()).toBe(200);
    await expect(developmentRow.getByText('병합 가능', { exact: true })).toBeVisible();
    await expect(developmentRow.getByText('승인 대기', { exact: true })).toHaveCount(0);
    await expect(developmentRow).not.toContainText('mergeable');

    await page.getByRole('button', { name: 'GitLab 활동 새로고침', exact: true }).click();
    await expect(card(waiting)).toHaveCount(0);
    await expect(card(conflicting)).toBeVisible();
    await expect(filter).toHaveValue('merge_blocked');
    await expect(page).toHaveURL(url => url.hash === savedPath);
    await reader.reload();
    await expect(listed(waiting)).toHaveCount(0);
    await expect(listed(conflicting)).toBeVisible();

    const after = await workspace();
    expect(after.gitlabLinks.find(link => link.issueId === waiting.id)).toMatchObject({
      id: beforeWaiting?.id, state: 'opened', updatedAt, mergeReadiness: { state: 'ready', source: 'read' },
    });
    expect(after.issues.find(issue => issue.id === waiting.id)).toMatchObject({ status: waiting.status, version: waiting.version });
    expect(remoteCalls).toEqual([
      `GET ${repositoryPath}/merge_requests`, `GET ${repositoryPath}/pipelines`,
      `GET ${repositoryPath}/merge_requests`, `GET ${repositoryPath}/pipelines`,
    ]);
    await development.close();
    await reader.close();
  } finally {
    try {
      for (const path of [
        ...(document ? [`/api/documents/${document.id}`] : []),
        ...issues.map(issue => `/api/issues/${issue.id}`),
      ]) {
        const deleted = await request.delete(path);
        if (deleted.ok()) {
          const { trashEntryId } = await deleted.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`);
        }
      }
      if (savedView) await request.delete(`/api/views/${savedView.id}?expectedVersion=${savedView.version}`);
      const current = await json<GitlabSettings>(await request.get(integration));
      if (current.baseUrl === baseUrl) await request.patch(integration, { data: {
        expectedVersion: current.version, baseUrl: original.baseUrl, projectIds: original.projectIds,
      } });
    } finally {
      mock.closeAllConnections();
      await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
    }
  }
});
