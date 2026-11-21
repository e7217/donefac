import { expect, test, type APIResponse, type Page, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GitlabSettings, GitlabSyncStatus, Issue, WorkspaceSnapshot } from '../../shared/types';

const integration = '/api/integrations/gitlab';
const activity = `${integration}/sync`;
const deployments = `${integration}/deployments/sync`;
const diagnostics = `${integration}/sync-status`;

async function json<T>(response: APIResponse | Response, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(expected);
  return JSON.parse(body) as T;
}

function responseAt(page: Page, pathname: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
}

test('360px GitLab에서 저장소별 활동과 배포 실패를 다시 열고 이전 모드로 조회한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const token = `synthetic-local-read-${randomUUID()}`;
  const privateError = `synthetic-upstream-body-${randomUUID()}`;
  const failures = new Map([['77:pipelines', 403], ['99:repository/commits', 503]]);
  const intercepted: { id: number; stage: string; method?: string; credential: string | string[] | undefined }[] = [];
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [project] } = await workspace();
  const issue = await json<Issue>(await request.post('/api/issues', { data: { projectId: project.id, title: '지속 동기화의 합성 티켓' } }), 201);
  const at = new Date(Date.now() - 10_000).toISOString();
  const mock = createServer((incoming, response) => {
    const path = new URL(incoming.url ?? '/', origin).pathname;
    const match = /^\/gitlab\/api\/v4\/projects\/(\d+)(?:\/(.+))?$/.exec(path);
    if (!match) return response.writeHead(404).end();
    const id = Number(match[1]);
    const stage = match[2] || 'project';
    const repository = `${origin}/gitlab/team/repo-${id}`;
    intercepted.push({ id, stage, method: incoming.method, credential: incoming.headers['private-token'] });
    response.setHeader('Content-Type', 'application/json');
    const failure = failures.get(`${id}:${stage}`);
    if (failure) return response.writeHead(failure).end(JSON.stringify({ error: `${privateError} ${token}` }));
    if (stage === 'project') return response.end(JSON.stringify({ id, web_url: repository, path_with_namespace: `team/repo-${id}` }));
    if (stage === 'merge_requests') return response.end(JSON.stringify([{
      id: id * 100, iid: 1, title: `${issue.key} 합성 MR`, state: 'opened', source_branch: `feature/${issue.key}`,
      target_project_id: id, updated_at: at, web_url: `${repository}/-/merge_requests/1`,
    }]));
    response.end('[]');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const origin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  const readSettings = async () => json<GitlabSettings>(await request.get(integration));
  const readStatus = async () => {
    const before = intercepted.length;
    const response = await request.get(diagnostics);
    expect(response.headers()['cache-control']).toBe('no-store');
    const state = await json<GitlabSyncStatus>(response);
    expect(intercepted).toHaveLength(before);
    expect(JSON.stringify(state)).not.toContain(token);
    expect(JSON.stringify(state)).not.toContain(privateError);
    return state;
  };
  const remoteCalls = () => intercepted.map(({ id, stage }) => [id, stage]);

  try {
    const current = await readSettings();
    expect(current.baseUrl).toBe('');
    const saved = await json<GitlabSettings>(await request.patch(integration, { data: {
      expectedVersion: current.version, baseUrl: `${origin}/gitlab`, projectIds: [42, 77, 99], token,
    } }));
    const version = saved.version;
    await page.setViewportSize({ width: 360, height: 820 });
    const mounting = responseAt(page, diagnostics, 'GET');
    await page.goto(`/#/${project.id}/development`);
    expect((await json<GitlabSyncStatus>(await mounting)).repositories.every(row => !row.activity && !row.deployments)).toBeTruthy();
    expect(intercepted).toHaveLength(0);
    const history = page.getByRole('checkbox', { name: '기존 브랜치·커밋 포함', exact: true });
    const report = page.getByRole('region', { name: 'GitLab 동기화 결과', exact: true });
    const row = (id: number) => report.getByRole('region', { name: `저장소 ${id}`, exact: true });
    await history.check();
    const syncing = responseAt(page, activity);
    await page.getByRole('button', { name: '지금 동기화', exact: true }).click();
    const initialSync = await syncing;
    expect(initialSync.request().postDataJSON()).toEqual({ expectedVersion: version, includeHistory: true });
    expect(initialSync.status(), await initialSync.text()).toBe(200);
    await expect(row(42)).toContainText('신규 연결 1개');
    await expect(row(77)).toContainText('GitLab HTTP 403 응답');
    await expect(row(99)).toContainText('GitLab HTTP 503 응답');

    const anotherRun = await request.post(activity, { data: { expectedVersion: version, repositoryIds: [77] } });
    expect(anotherRun.status(), await anotherRun.text()).toBe(502);
    const panel = page.getByRole('region', { name: 'GitLab 배포 기록', exact: true });
    const deploymentReport = panel.getByRole('status', { name: '배포 이력 동기화 결과', exact: true });
    const deploymentButton = panel.getByRole('button', { name: '배포 이력 동기화', exact: true });
    await expect(panel.getByRole('combobox', { name: '배포 저장소', exact: true })).toHaveValue('42');
    const firstDeployment = responseAt(page, deployments);
    await deploymentButton.click();
    expect((await firstDeployment).status()).toBe(200);
    await expect(deploymentReport).toContainText('배포 0건 조회');
    failures.set('42:deployments', 403);
    const failedDeployment = responseAt(page, deployments);
    await deploymentButton.click();
    expect((await failedDeployment).status()).toBe(502);
    await expect(deploymentReport.getByText('배포 조회 실패', { exact: true })).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveCount(0);

    const beforeReload = await readStatus();
    const clicks = intercepted.length;
    const loading = responseAt(page, diagnostics, 'GET');
    await page.reload();
    expect(await json<GitlabSyncStatus>(await loading)).toEqual(beforeReload);
    await expect(history).not.toBeChecked();
    await expect(row(42)).toContainText('신규 연결 1개');
    await expect(row(77)).toContainText('MR·파이프라인');
    await expect(row(99)).toContainText('브랜치·커밋 포함');
    await expect(row(99)).toContainText('최근 시도');
    await expect(deploymentReport.getByText('배포 조회 실패', { exact: true })).toBeVisible();
    await expect(deploymentReport).toContainText('마지막 성공');
    const draftToken = page.getByLabel('읽기 API 토큰', { exact: true });
    await expect(draftToken).toHaveValue('');
    await expect(report).not.toContainText(token);
    await expect(deploymentReport).not.toContainText(privateError);
    expect(intercepted).toHaveLength(clicks);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await draftToken.fill('미저장 합성 토큰');
    const localRefresh = responseAt(page, diagnostics, 'GET');
    await report.getByRole('button', { name: '동기화 결과 새로고침', exact: true }).click();
    expect(await json<GitlabSyncStatus>(await localRefresh)).toEqual(beforeReload);
    expect(intercepted).toHaveLength(clicks);
    await expect(draftToken).toHaveValue('미저장 합성 토큰');

    failures.delete('77:pipelines');
    intercepted.length = 0;
    const retryingBrief = responseAt(page, activity);
    await row(77).getByRole('button', { name: '저장소 77 다시 시도', exact: true }).click();
    const retriedBrief = await retryingBrief;
    expect(retriedBrief.status()).toBe(200);
    expect(retriedBrief.request().postDataJSON()).toEqual({ expectedVersion: version, repositoryIds: [77] });
    expect(remoteCalls()).toEqual([[77, 'merge_requests'], [77, 'pipelines']]);
    await expect(row(99)).toContainText('GitLab HTTP 503 응답');
    await expect(row(77)).toContainText('신규 연결 1개');
    const partial = await readStatus();
    expect(partial.repositories[0]).toEqual(beforeReload.repositories[0]);
    expect(partial.repositories[2]).toEqual(beforeReload.repositories[2]);

    failures.delete('99:repository/commits');
    intercepted.length = 0;
    const retryingHistory = responseAt(page, activity);
    await report.getByRole('button', { name: '실패한 저장소 다시 시도', exact: true }).click();
    const retriedHistory = await retryingHistory;
    expect(retriedHistory.status()).toBe(200);
    expect(retriedHistory.request().postDataJSON()).toEqual({ expectedVersion: version, repositoryIds: [99], includeHistory: true });
    expect(remoteCalls()).toEqual([[99, 'project'], [99, 'repository/branches'], [99, 'repository/commits'], [99, 'merge_requests'], [99, 'pipelines']]);
    await expect(row(99)).toContainText('신규 연결 1개');
    await expect(deploymentReport.getByText('배포 조회 실패', { exact: true })).toBeVisible();
    await expect(draftToken).toHaveValue('미저장 합성 토큰');
    expect(intercepted.every(call => call.method === 'GET' && call.credential === token)).toBeTruthy();
    const after = await workspace();
    expect(after.gitlabLinks.filter(link => link.issueId === issue.id).map(link => link.projectId).sort()).toEqual([42, 77, 99]);
    expect(after.issues.find(item => item.id === issue.id)).toEqual(issue);
  } finally {
    try {
      const current = await readSettings();
      if (current.baseUrl) await json<GitlabSettings>(await request.patch(integration, { data: { expectedVersion: current.version, baseUrl: '', projectIds: [], token: '' } }));
      const archived = await request.delete(`/api/issues/${issue.id}`);
      if (archived.ok()) await request.delete(`/api/trash/${(await archived.json() as { trashEntryId: string }).trashEntryId}`);
    } finally {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
});
