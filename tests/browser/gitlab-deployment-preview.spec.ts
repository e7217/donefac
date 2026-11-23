import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse } from '@playwright/test';
import type { GitlabDeploymentPreviewResult, GitlabSettings, WorkspaceSnapshot } from '../../shared/types';

const integration = '/api/integrations/gitlab';
const previewPath = `${integration}/deployments/preview`;
const upstream = '/forge/api/v4/projects';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>) {
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as T;
}

function reply(response: ServerResponse, data: unknown, status = 200, nextPage = '') {
  response.writeHead(status, { 'Content-Type': 'application/json', 'X-Next-Page': nextPage });
  response.end(JSON.stringify(data));
}

function deployment(id: number, status: 'success' | 'failed') {
  return { id, status, sha: 'ab'.repeat(20), updated_at: '2026-11-19T08:00:00Z', environment: { name: '합성 비공개 배포 환경' } };
}

test('360px GitLab 연결 초안에서 선택한 저장소의 배포를 읽고 일부 결과·빈 결과·성공 없음 상태를 구분한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const { projects: [project] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const settings = () => request.get(integration).then(json<GitlabSettings>);
  const original = await settings();
  const token = `synthetic-deployment-preview-${randomUUID()}`;
  const secretDraft = `synthetic-webhook-preview-${randomUUID()}`;
  const firstRead = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const firstFinished = Promise.withResolvers<void>();
  const calls: { path: string; method?: string; page: string | null; token?: string | string[] }[] = [];
  let baseUrl = '';
  const mock = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    const page = url.searchParams.get('page');
    const privateToken = incoming.headers['private-token'];
    calls.push({ path: url.pathname, method: incoming.method, token: privateToken, page });
    if (incoming.method !== 'GET' || privateToken !== token) return reply(response, {}, 403);
    const projectMatch = /^\/forge\/api\/v4\/projects\/(42|43|44|45|46)$/u.exec(url.pathname);
    if (projectMatch) {
      const id = Number(projectMatch[1]);
      const path = `team/repo-${id}`;
      return reply(response, { id, name: `Fixture ${id}`, path_with_namespace: path, web_url: `${baseUrl}/${path}` });
    }
    if (url.pathname === `${upstream}/42/deployments`) {
      firstRead.resolve();
      void releaseFirst.promise.then(() => {
        if (!response.destroyed) reply(response, [deployment(421, 'failed')]);
        firstFinished.resolve();
      });
      return;
    }
    if (url.pathname === `${upstream}/43/deployments`) {
      return reply(response, [deployment(431, 'success'), deployment(432, 'success'), deployment(433, 'success'), deployment(434, 'failed')], 200, '2');
    }
    if (url.pathname === `${upstream}/43/deployments/431/merge_requests` && (page === '1' || page === '2')) {
      return reply(response, [{ id: 830 + Number(page), iid: Number(page), target_project_id: 43, state: 'merged' }], 200, page === '1' ? '2' : '3');
    }
    if (url.pathname === `${upstream}/43/deployments/432/merge_requests`) return reply(response, {}, 403);
    if (url.pathname === `${upstream}/43/deployments/433/merge_requests`) return reply(response, {}, 429);
    if (url.pathname === `${upstream}/44/deployments`) return reply(response, []);
    if (url.pathname === `${upstream}/45/deployments`) return reply(response, [deployment(451, 'failed')]);
    if (url.pathname === `${upstream}/46/deployments`) return reply(response, { message: token }, 429);
    return reply(response, {}, 404);
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;

  const writes: { path: string; method: string }[] = [];
  const canceled: number[] = [];
  page.on('request', sent => {
    const path = new URL(sent.url()).pathname;
    if ((path === integration || path.startsWith(`${integration}/`)) && !['GET', 'HEAD'].includes(sent.method())) {
      writes.push({ path, method: sent.method() });
    }
  });
  page.on('requestfailed', sent => {
    if (new URL(sent.url()).pathname === previewPath) canceled.push(sent.postDataJSON().repositoryId as number);
  });

  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/development`);
    const address = page.getByLabel('GitLab 주소', { exact: true });
    const ids = page.getByLabel(/^GitLab 프로젝트 ID/);
    const readToken = page.getByLabel('읽기 API 토큰', { exact: true });
    const secret = page.getByLabel('웹훅 Secret Token', { exact: true });
    const projectIds = [42, 43, 44, 45, 46];
    const draftedIds = projectIds.join(', ');
    const repository = page.getByRole('combobox', { name: '배포 조회 저장소', exact: true });
    const preview = page.getByRole('button', { name: '배포 조회 미리보기', exact: true });
    const report = page.getByRole('region', { name: '배포 조회 미리보기 결과', exact: true });
    await expect(address).toHaveValue(original.baseUrl, { timeout: 30_000 });
    await address.fill(baseUrl);
    await ids.fill(draftedIds);
    await readToken.fill(token);
    await secret.fill(secretDraft);
    await expect(repository).toHaveValue('42');
    await expect(report).toHaveCount(0);
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);

    async function read(repositoryId: number) {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === previewPath && response.request().method() === 'POST');
      await preview.click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual({ repositoryId, expectedVersion: original.version, baseUrl, projectIds, token });
      return json<GitlabDeploymentPreviewResult>(response);
    }
    const result = (repositoryId: number, status: GitlabDeploymentPreviewResult['status'], deploymentsRead: number): GitlabDeploymentPreviewResult => ({
      repositoryId, settingsVersion: original.version, status, deploymentsRead, successfulDeployments: 0, mergeRequestsRead: 0,
      deploymentLimitReached: false, associationUnavailable: 0, associationLimited: 0, associationDenied: 0, associationRateLimited: 0,
    });

    const firstSubmitted = page.waitForRequest(sent => new URL(sent.url()).pathname === previewPath && sent.method() === 'POST');
    await preview.click();
    expect((await firstSubmitted).postDataJSON()).toEqual({ repositoryId: 42, expectedVersion: original.version, baseUrl, projectIds, token });
    await firstRead.promise;
    await expect(preview).toBeDisabled();
    await expect(report).toContainText('입력한 설정으로 GitLab 배포를 조회하는 중입니다.');
    await repository.selectOption('43');
    await expect(report).toHaveCount(0);
    await expect(preview).toBeEnabled();
    await expect.poll(() => canceled).toEqual([42]);
    expect(await read(43)).toEqual({ ...result(43, 'partial', 4), successfulDeployments: 3, mergeRequestsRead: 2,
      deploymentLimitReached: true, associationUnavailable: 2, associationLimited: 1, associationDenied: 1, associationRateLimited: 1,
    });
    await expect(report.getByRole('heading', { name: '저장소 43', exact: true })).toBeVisible();
    await expect(report).toContainText('일부 배포 또는 포함 MR만 확인했습니다.');
    for (const [label, count] of [['조회 배포', '4건'], ['성공한 배포', '3건'], ['조회 포함 MR', '2건']]) {
      await expect(report.getByText(label, { exact: true }).locator('..')).toContainText(count);
    }
    for (const note of [
      '배포 조회 한도에 도달했습니다.', '포함 MR을 조회하지 못한 배포 2건', '포함 MR 조회 한도에 도달한 배포 1건',
      '포함 MR 조회 권한이 거부된 배포 1건', 'GitLab 요청 제한으로 포함 MR을 조회하지 못한 배포 1건',
    ]) await expect(report.getByText(note, { exact: true })).toBeVisible();
    await expect(report).not.toContainText('합성 비공개 배포 환경');
    const bounds = await report.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    releaseFirst.resolve();
    await firstFinished.promise;
    await expect(report.getByRole('heading', { name: '저장소 43', exact: true })).toBeVisible();

    await repository.selectOption('44');
    expect(await read(44)).toEqual(result(44, 'empty', 0));
    await expect(report).toContainText('조회 범위에 배포가 없습니다.');
    await expect(report).not.toContainText('일부 배포 또는 포함 MR만 확인했습니다.');
    await repository.selectOption('45');
    expect(await read(45)).toEqual(result(45, 'ok', 1));
    await expect(report).toContainText('성공한 배포가 없어 포함 MR은 확인하지 않았습니다.');
    await expect(report.getByText('조회 포함 MR', { exact: true })).toHaveCount(0);
    await expect(report).not.toContainText('조회 범위에 배포가 없습니다.');

    await repository.selectOption('46');
    const rateLimit = page.waitForResponse(response => new URL(response.url()).pathname === previewPath && response.request().method() === 'POST');
    await preview.click();
    const rejected = await rateLimit;
    expect(rejected.status()).toBe(502);
    expect(rejected.request().postDataJSON()).toEqual({ repositoryId: 46, expectedVersion: original.version, baseUrl, projectIds, token });
    await expect(report.getByRole('alert')).toHaveText('GitLab 요청 제한이 풀린 뒤 배포 조회를 다시 시도해 주세요.');
    await expect(report).not.toContainText(token);

    await expect(address).toHaveValue(baseUrl);
    await expect(ids).toHaveValue(draftedIds);
    await expect(readToken).toHaveValue(token);
    await expect(secret).toHaveValue(secretDraft);
    await expect(page.getByRole('button', { name: '연결 설정 저장', exact: true })).toBeEnabled();
    await readToken.fill(`${token}-edit`);
    await expect(report).toHaveCount(0);
    await expect(repository).toHaveValue('46');
    expect(await settings()).toEqual(original);
    expect(writes).toEqual(Array.from({ length: 5 }, () => ({ path: previewPath, method: 'POST' })));
    expect(calls.every(call => call.method === 'GET' && call.token === token)).toBe(true);
    expect(calls.map(call => `${call.path}${call.page ? `?page=${call.page}` : ''}`).sort()).toEqual([
      ...projectIds.flatMap(id => [`${upstream}/${id}`, `${upstream}/${id}/deployments?page=1`]),
      `${upstream}/43/deployments/431/merge_requests?page=1`, `${upstream}/43/deployments/431/merge_requests?page=2`,
      `${upstream}/43/deployments/432/merge_requests?page=1`, `${upstream}/43/deployments/433/merge_requests?page=1`,
    ].sort());
  } finally {
    releaseFirst.resolve();
    mock.closeAllConnections();
    await new Promise<void>(resolve => mock.close(() => resolve()));
  }
});
