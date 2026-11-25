import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import type { GitlabSettings, GitlabSyncPreview, GitlabSyncResult, Issue, WorkspaceSnapshot } from '../../shared/types';

const integration = '/api/integrations/gitlab';
const searchEndpoint = `${integration}/repository-search`;
const context = '/forge/tools';
const projectEndpoint = `${context}/api/v4/projects`;
const repository = { id: 42, name: 'Engine', path: 'platform/nested/engine' };

function responseAt(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

function searchForm(page: Page) {
  const region = page.getByRole('region', { name: 'GitLab 저장소 찾기', exact: true });
  return {
    region,
    query: region.getByLabel('저장소 이름·전체 경로·주소', { exact: true }),
    search: region.getByRole('button', { name: '저장소 검색', exact: true }),
    next: region.getByRole('button', { name: '저장소 다음 페이지', exact: true }),
    result: (path: string) => region.getByRole('button', { name: `${path} 저장소 추가`, exact: true }),
    added: (path: string) => region.getByRole('button', { name: `${path} 저장소 추가됨`, exact: true }),
  };
}

function reply(response: ServerResponse, payload: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
}

async function fakeGitlab(handler: (request: IncomingMessage, response: ServerResponse, path: URL, baseUrl: string) => void) {
  let baseUrl = '';
  const calls: { url: URL; method?: string; token?: string | string[] }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);
    calls.push({ url, method: request.method, token: request.headers['private-token'] });
    handler(request, response, url, baseUrl);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${context}`;
  return { baseUrl, calls, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

function repositoryJson(baseUrl: string, item = repository) {
  return { id: item.id, name: item.name, path_with_namespace: item.path, web_url: `${baseUrl}/${item.path}` };
}

test('360px에서 하위 그룹 주소로 저장소를 추가하고 수동 ID를 유지한 채 미리보기와 동기화를 진행한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  const settings = async () => (await (await request.get(integration)).json()) as GitlabSettings;
  const workspace = async () => (await (await request.get('/api/workspace')).json()) as WorkspaceSnapshot;
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const project = (await workspace()).projects[0];
  const created = await request.post('/api/issues', { data: { projectId: project.id, title: `저장소 검색 검증 ${randomUUID()}` } });
  expect(created.status()).toBe(201);
  const issue = await created.json() as Issue;
  const token = `synthetic-search-token-${randomUUID()}`;
  const secret = `synthetic-webhook-token-${randomUUID()}`;
  const other = { id: 73, name: 'Engine Support', path: 'platform/engine-support' };
  const writeTime = new Date(Date.now() - 5_000).toISOString();
  const mrTitle = `${issue.key} 팀 엔진 연결`;
  const mr = (baseUrl: string) => ({ id: 743, iid: 3, title: mrTitle, state: 'opened', source_branch: `feature/${issue.key}`,
    sha: 'a'.repeat(40), updated_at: writeTime, web_url: `${baseUrl}/${repository.path}/-/merge_requests/3` });
  const mock = await fakeGitlab((incoming, response, url, baseUrl) => {
    if (incoming.method !== 'GET' || incoming.headers['private-token'] !== token) return reply(response, {}, 403);
    if (url.pathname === projectEndpoint && url.searchParams.get('search') === 'engine') {
      if (url.searchParams.get('page') === '1') {
        response.setHeader('X-Next-Page', '2');
        return reply(response, [repositoryJson(baseUrl, other)]);
      }
      if (url.searchParams.get('page') === '2') {
        response.setHeader('X-Next-Page', '');
        return reply(response, [repositoryJson(baseUrl)]);
      }
    }
    if (url.pathname === `${projectEndpoint}/${encodeURIComponent(repository.path)}`) return reply(response, repositoryJson(baseUrl));
    const activity = new RegExp(`^${projectEndpoint}/(21|34|42)/(merge_requests|pipelines)$`).exec(url.pathname);
    if (activity) return reply(response, activity[1] === '42' && activity[2] === 'merge_requests' ? [mr(baseUrl)] : []);
    return reply(response, {}, 404);
  });

  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/development`);
    const form = searchForm(page);
    const address = page.getByLabel('GitLab 주소', { exact: true });
    const ids = page.getByLabel(/^GitLab 프로젝트 ID/);
    const readToken = page.getByLabel(/읽기 API 토큰/);
    const hookSecret = page.getByLabel('웹훅 Secret Token', { exact: true });
    await expect(address).toBeEnabled();
    await expect(address).toHaveValue('');
    await expect(ids).toHaveValue('');
    await address.fill(mock.baseUrl);
    await ids.fill('21, 34');
    await readToken.fill(token);
    await hookSecret.fill(secret);
    await form.query.fill('engine');
    expect(mock.calls).toHaveLength(0);

    const first = responseAt(page, searchEndpoint);
    await form.search.click();
    const initialResult = await first;
    expect(initialResult.ok(), await initialResult.text()).toBeTruthy();
    expect(initialResult.request().postDataJSON()).toMatchObject({ expectedVersion: original.version, baseUrl: mock.baseUrl, query: 'engine', page: 1 });
    expect(initialResult.request().postDataJSON()).not.toHaveProperty('webhookSecret');
    await expect(form.result(other.path)).toBeVisible();
    const bounds = await form.region.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);
    const second = responseAt(page, searchEndpoint);
    await form.next.click();
    const nextPage = await second;
    expect(nextPage.ok(), await nextPage.text()).toBeTruthy();
    expect(nextPage.request().postDataJSON()).toMatchObject({ query: 'engine', page: 2 });
    await expect(form.result(repository.path)).toBeVisible();

    await form.query.fill(`${mock.baseUrl}-other/${repository.path}`);
    const outsideScope = responseAt(page, searchEndpoint);
    await form.search.click();
    expect((await outsideScope).status()).toBe(400);
    await expect(form.region.getByRole('alert')).toContainText('설정한 GitLab 주소');
    await expect(ids).toHaveValue('21, 34');

    const cloneUrl = `${mock.baseUrl}/${repository.path}.git`;
    await form.query.fill(cloneUrl);
    const exact = responseAt(page, searchEndpoint);
    await form.query.press('Enter');
    const exactResult = await exact;
    expect(exactResult.ok(), await exactResult.text()).toBeTruthy();
    expect(exactResult.request().postDataJSON()).toMatchObject({ query: cloneUrl, page: 1 });
    await expect(form.region.getByRole('link', { name: /^Engine GitLab/ })).toHaveAttribute('href', `${mock.baseUrl}/${repository.path}`);
    await form.result(repository.path).click();
    await expect(form.added(repository.path)).toBeVisible();
    await expect(ids).toHaveValue(/21\s*,\s*34\s*,\s*42/);
    await expect(hookSecret).toHaveValue(secret);
    await expect(readToken).toHaveValue(token);
    expect(await settings()).toEqual(original);
    expect(mock.calls.map(({ url }) => url.pathname)).toEqual([
      projectEndpoint, projectEndpoint, `${projectEndpoint}/${encodeURIComponent(repository.path)}`,
    ]);

    const reading = responseAt(page, `${integration}/sync-preview`);
    await page.getByRole('button', { name: '연결 미리보기', exact: true }).click();
    const preview = await reading;
    expect(preview.ok(), await preview.text()).toBeTruthy();
    expect(preview.request().postDataJSON()).toMatchObject({ projectIds: [21, 34, 42] });
    expect((await preview.json() as GitlabSyncPreview).candidates).toMatchObject([{ issueId: issue.id, projectId: repository.id }]);
    await expect(page.getByRole('region', { name: '티켓 연결 후보', exact: true })).toContainText(mrTitle);
    expect(await settings()).toEqual(original);
    expect((await workspace()).gitlabLinks.filter(link => link.issueId === issue.id)).toHaveLength(0);

    const saving = responseAt(page, integration, 'PATCH');
    await page.getByRole('button', { name: '연결 설정 저장', exact: true }).click();
    const saved = await saving;
    expect(saved.ok(), await saved.text()).toBeTruthy();
    expect((await saved.json() as GitlabSettings).projectIds).toEqual([21, 34, 42]);
    const syncing = responseAt(page, `${integration}/sync`);
    await page.getByRole('button', { name: '지금 동기화', exact: true }).click();
    const synced = await syncing;
    expect(synced.ok(), await synced.text()).toBeTruthy();
    expect(await synced.json() as GitlabSyncResult).toMatchObject({ linked: 1 });
    await expect(page.getByRole('region', { name: '연결된 개발 활동', exact: true }).getByRole('link').filter({ hasText: mrTitle }))
      .toHaveAttribute('href', mr(mock.baseUrl).web_url);
    expect((await workspace()).gitlabLinks.filter(link => link.issueId === issue.id)).toMatchObject([{ kind: 'merge_request', projectId: 42 }]);
    expect(mock.calls.every(read => read.method === 'GET' && read.token === token)).toBeTruthy();
  } finally {
    try {
      const current = await settings();
      if (current.baseUrl === mock.baseUrl) {
        const cleared = await request.patch(integration, { data: { expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '' } });
        expect(cleared.ok(), await cleared.text()).toBeTruthy();
      }
      await request.delete(`/api/issues/${issue.id}`);
    } finally { await mock.close(); }
  }
});

test('조회 중 GitLab 주소와 읽기 토큰을 바꾸면 이전 저장소를 추가할 수 없다', async ({ page, request }) => {
  const { projects: [project] } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const before = await (await request.get(integration)).json() as GitlabSettings;
  const token = `synthetic-search-token-${randomUUID()}`;
  const newToken = `synthetic-updated-token-${randomUUID()}`;
  const stale = { id: 92, name: 'Stale Engine', path: 'old/stale' };
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const secondContext = `${context}/second`;
  const mock = await fakeGitlab((incoming, response, url, baseUrl) => {
    if (url.pathname === projectEndpoint && incoming.headers['private-token'] === token) {
      started.resolve();
      void release.promise.then(() => { if (!response.destroyed) reply(response, [repositoryJson(baseUrl, stale)]); });
      return;
    }
    if (url.pathname === `${secondContext}/api/v4/projects` && incoming.headers['private-token'] === newToken) {
      return reply(response, [repositoryJson(`${baseUrl}/second`)]);
    }
    return reply(response, {}, 404);
  });
  try {
    await page.goto(`/#/${project.id}/development`);
    const form = searchForm(page);
    const address = page.getByLabel('GitLab 주소', { exact: true });
    const readToken = page.getByLabel(/읽기 API 토큰/);
    const ids = page.getByLabel(/^GitLab 프로젝트 ID/);
    await address.fill(mock.baseUrl);
    await readToken.fill(token);
    await ids.fill('21');
    await form.query.fill('engine');
    const [pending] = await Promise.all([
      page.waitForRequest(item => new URL(item.url()).pathname === searchEndpoint),
      form.search.click(),
    ]);
    await started.promise;
    await address.fill(`${mock.baseUrl}/second`);
    await readToken.fill(newToken);
    release.resolve();
    await (await pending.response())?.finished();
    await expect(form.result(stale.path)).toHaveCount(0);
    await expect(ids).toHaveValue('21');
    await form.query.fill('engine');
    const renewed = responseAt(page, searchEndpoint);
    await form.search.click();
    const current = await renewed;
    expect(current.ok(), await current.text()).toBeTruthy();
    await expect(form.result(repository.path)).toBeVisible();
    await expect(form.result(stale.path)).toHaveCount(0);
    expect(await (await request.get(integration)).json()).toEqual(before);
  } finally {
    release.resolve();
    await mock.close();
  }
});
