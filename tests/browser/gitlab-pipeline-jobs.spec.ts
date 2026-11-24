import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse } from '@playwright/test';
import type { GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

const settingsPath = '/api/integrations/gitlab';
const repositoryId = 42;
const pipelineId = 802;
const sha = 'e'.repeat(40);
const repositoryPath = `/forge/api/v4/projects/${repositoryId}`;
const pipelinePath = `${repositoryPath}/pipelines/${pipelineId}`;
const jobsPath = `${pipelinePath}/jobs`;
const triggerJobsPath = `${pipelinePath}/trigger_jobs`;
const bridgesPath = `${pipelinePath}/bridges`;

async function json<T>(response: APIResponse, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(expected);
  return JSON.parse(body) as T;
}

test('360px 티켓과 개발 화면에서 저장 내용을 유지하며 GitLab 실패·수동·트리거 작업을 직접 확인한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const unique = randomUUID();
  const token = `synthetic-gitlab-jobs-read-${unique}`;
  const secret = `synthetic-gitlab-jobs-webhook-${unique}`;
  const upstreamError = `upstream-private-job-error-${unique}`;
  const at = new Date(Date.now() - 60_000).toISOString();
  const changedAt = new Date(Date.parse(at) + 1_000).toISOString();
  const latestAt = new Date(Date.parse(at) + 2_000).toISOString();
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const settings = async () => json<GitlabSettings>(await request.get(settingsPath));
  const { projects: [project] } = await workspace();
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const issue = await json<Issue>(await request.post('/api/issues', {
    data: { projectId: project.id, title: `CI 작업 확인 ${unique.slice(0, 8)}` },
  }), 201);
  const ref = `feature/${issue.key}`;
  const requests: { url: URL; method?: string; credential?: string | string[] }[] = [];
  let baseUrl = '';
  let unavailable = false;
  let bridgesUnavailable = false;
  let recovered = false;
  let upstreamUpdatedAt = at;
  const repoUrl = () => `${baseUrl}/team/app`;
  const pipelineUrl = () => `${repoUrl()}/-/pipelines/${pipelineId}`;
  const jobUrl = (id: number) => `${repoUrl()}/-/jobs/${id}`;
  const downstreamUrl = () => `${baseUrl}/team/deployment/-/pipelines/940`;
  const mock = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    requests.push({ url, method: incoming.method, credential: incoming.headers['private-token'] });
    response.setHeader('Content-Type', 'application/json');
    const pipeline = { id: pipelineId, iid: 19, project_id: repositoryId, status: recovered ? 'success' : 'failed', sha,
      ref, updated_at: upstreamUpdatedAt, web_url: pipelineUrl(), yaml_errors: recovered ? null : upstreamError };
    const job = (id: number, name: string, stage: string, status: string, allowFailure: boolean, reason: string | null) => ({
      id, name, stage, status, allow_failure: allowFailure, failure_reason: reason, pipeline, web_url: jobUrl(id),
    });
    if (url.pathname === repositoryPath) response.end(JSON.stringify({ id: repositoryId, path_with_namespace: 'team/app', web_url: repoUrl() }));
    else if (url.pathname === pipelinePath) response.end(JSON.stringify(pipeline));
    else if (url.pathname === jobsPath) {
      if (unavailable) response.writeHead(503).end(JSON.stringify({ message: `${upstreamError} ${token}` }));
      else response.end(JSON.stringify(recovered ? [] : [
        job(815, '실패한 통합 검사', 'integration-test', 'failed', false, 'script_failure'),
        job(814, '수동 검토 작업', 'deployment', 'manual', true, null),
      ]));
    } else if (url.pathname === bridgesPath) {
      if (bridgesUnavailable) response.writeHead(403).end(JSON.stringify({ message: `${upstreamError} ${token}` }));
      else response.end(JSON.stringify(recovered ? [] : [
        { ...job(818, '배포팀 파이프라인 실행', 'trigger', 'success', false, null),
          downstream_pipeline: { id: 940, status: 'failed', web_url: downstreamUrl() } },
        { ...job(817, '다운스트림 생성 실패', 'trigger', 'failed', true, 'script_failure'), downstream_pipeline: null },
        { ...job(816, '주소를 확인할 트리거 작업', 'trigger', 'success', false, null),
          web_url: 'https://link-fixture.invalid/team/app/-/jobs/816',
          downstream_pipeline: { id: 941, status: 'pending', web_url: new URL('/outside/repo/-/pipelines/941', baseUrl).href } },
      ]));
    } else response.writeHead(404).end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;

  async function observePipeline(status: string, updatedAt: string) {
    const received = await json<{ linked: number }>(await request.post(`${settingsPath}/webhook`, {
      headers: { 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() },
      data: { object_kind: 'pipeline', project: { id: repositoryId, web_url: repoUrl() }, object_attributes: {
        id: pipelineId, iid: 19, status, sha, ref, url: pipelineUrl(), updated_at: updatedAt,
      } },
    }));
    expect(received.linked).toBe(1);
    upstreamUpdatedAt = updatedAt;
  }

  try {
    await json(await request.patch(settingsPath, { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
    } }));
    await observePipeline('running', at);
    const saved = (await workspace()).gitlabLinks.find(link => link.issueId === issue.id && link.kind === 'pipeline');
    expect(saved?.state).toBe('running');

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = panel.getByRole('region', { name: 'GitLab', exact: true });
    const pipelineRow = gitlab.getByRole('region', { name: '파이프라인', exact: true }).locator('[data-gitlab-kind="pipeline"]');
    const open = pipelineRow.getByRole('button', { name: 'CI 작업 확인', exact: true });
    await expect(open).toBeVisible({ timeout: 35_000 });
    expect(requests).toHaveLength(0);
    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    await title.fill('저장하지 않은 티켓 제목');
    await comment.fill('보내지 않은 댓글 본문');
    await open.press('Enter');
    const jobs = pipelineRow.getByRole('region', { name: 'GitLab CI 작업', exact: true });
    const job = jobs.getByRole('link', { name: '실패한 통합 검사', exact: true });
    await expect(job).toHaveAttribute('href', jobUrl(815));
    await expect(jobs).toContainText('integration-test');
    await expect(jobs).toContainText('작업 스크립트 실패');
    await expect(jobs.getByRole('link', { name: '수동 검토 작업', exact: true })).toHaveAttribute('href', jobUrl(814));
    await expect(jobs).toContainText('실패 허용');
    await expect(jobs).toContainText('파이프라인 설정 오류');
    const triggers = jobs.getByRole('region', { name: 'GitLab 트리거 작업', exact: true });
    const triggerList = triggers.getByRole('list', { name: '트리거 작업', exact: true });
    const trigger = triggerList.getByRole('listitem').filter({ hasText: '배포팀 파이프라인 실행' });
    const failedTrigger = triggerList.getByRole('listitem').filter({ hasText: '다운스트림 생성 실패' });
    const unsafeTrigger = triggerList.getByRole('listitem').filter({ hasText: '주소를 확인할 트리거 작업' });
    const downstream = trigger.getByRole('link', { name: '다운스트림 파이프라인 #940 열기', exact: true });
    await expect(triggerList.getByRole('listitem')).toHaveCount(3);
    await expect(trigger.getByRole('link', { name: '배포팀 파이프라인 실행', exact: true })).toHaveAttribute('href', jobUrl(818));
    await expect(trigger.getByText('성공', { exact: true })).toBeVisible();
    await expect(trigger.getByText('실패', { exact: true })).toBeVisible();
    await expect(downstream).toHaveAttribute('href', downstreamUrl());
    await expect(downstream).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(failedTrigger.getByText('실패', { exact: true })).toBeVisible();
    await expect(failedTrigger).toContainText('작업 스크립트 실패');
    await expect(failedTrigger.getByRole('link', { name: /^다운스트림 파이프라인/u })).toHaveCount(0);
    await expect(unsafeTrigger).toContainText('#941');
    await expect(unsafeTrigger.getByText('대기 중', { exact: true })).toBeVisible();
    await expect(unsafeTrigger.getByRole('link')).toHaveCount(0);
    await expect(pipelineRow).toHaveAttribute('data-gitlab-state', 'running');
    await expect(jobs).not.toContainText(upstreamError);
    await expect(jobs).not.toContainText(token);
    expect(await jobs.evaluate(region => region.getBoundingClientRect().width)).toBeLessThanOrEqual(360);

    const refreshActivity = gitlab.getByRole('button', { name: 'GitLab 활동 새로고침', exact: true });
    const retry = jobs.getByRole('button', { name: 'CI 작업 다시 확인', exact: true });
    const invalidated = jobs.getByRole('status').filter({ hasText: '파이프라인이 변경되었습니다.' });
    const beforeUpdate = requests.length;
    await observePipeline('failed', changedAt);
    await refreshActivity.click();
    await expect(pipelineRow).toHaveAttribute('data-gitlab-state', 'failed');
    await expect(invalidated).toBeVisible();
    await expect(job).toHaveCount(0);
    await expect(triggers).toHaveCount(0);
    expect(requests).toHaveLength(beforeUpdate);

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const jobsRequest = /\/pipeline-jobs$/u;
    await page.route(jobsRequest, async route => {
      try {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        started.resolve();
        await release.promise;
        await route.fulfill({ response }).catch(() => undefined);
      } catch (cause) {
        started.reject(cause);
        await route.abort().catch(() => undefined);
      } finally { finished.resolve(); }
    }, { times: 1 });
    try {
      await retry.click();
      await started.promise;
      await expect(jobs.getByRole('status')).toHaveText('GitLab CI 작업을 확인하고 있습니다.');
      const beforeTimestampUpdate = requests.length;
      const aborted = page.waitForEvent('requestfailed', sent => jobsRequest.test(sent.url()));
      await observePipeline('failed', latestAt);
      await refreshActivity.click();
      await expect(invalidated).toBeVisible();
      expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED');
      expect(requests).toHaveLength(beforeTimestampUpdate);
    } finally { release.resolve(); }
    await finished.promise;
    await expect(job).toHaveCount(0);
    await expect(triggers).toHaveCount(0);
    const refreshed = (await workspace()).gitlabLinks.find(link => link.id === saved?.id);
    expect(refreshed).toMatchObject({ state: 'failed', updatedAt: latestAt });

    bridgesUnavailable = true;
    await retry.click();
    await expect(job).toHaveAttribute('href', jobUrl(815));
    await expect(triggers.getByText('GitLab 트리거 작업을 확인하지 못했습니다.', { exact: true })).toBeVisible();
    await expect(triggerList).toHaveCount(0);
    await expect(jobs).not.toContainText(upstreamError);
    await expect(jobs).not.toContainText(token);
    bridgesUnavailable = false;

    unavailable = true;
    await retry.click();
    await expect(jobs.getByRole('alert')).toBeVisible();
    await expect(jobs).not.toContainText(upstreamError);
    await expect(jobs).not.toContainText(token);
    unavailable = false;
    recovered = true;
    await retry.click();
    await expect(triggers.getByText('조회한 트리거 작업이 없습니다.', { exact: true })).toBeVisible();
    await expect(jobs.getByText('성공', { exact: true })).toBeVisible();
    await expect(jobs.getByRole('alert')).toHaveCount(0);
    await expect(job).toHaveCount(0);
    await expect(title).toHaveValue('저장하지 않은 티켓 제목');
    await expect(comment).toHaveValue('보내지 않은 댓글 본문');
    await pipelineRow.getByRole('button', { name: 'CI 작업 닫기', exact: true }).press('Enter');
    await expect(jobs).toHaveCount(0);
    await expect(open).toBeFocused();

    const development = await page.context().newPage();
    try {
      await development.setViewportSize({ width: 360, height: 820 });
      const countBefore = requests.length;
      recovered = false;
      await development.goto(`/#/${project.id}/development`);
      const developmentOpen = development.getByRole('region', { name: '연결된 개발 활동', exact: true })
        .getByRole('button', { name: 'CI 작업 확인', exact: true });
      await expect(developmentOpen).toBeVisible({ timeout: 35_000 });
      expect(requests).toHaveLength(countBefore);
      await developmentOpen.click();
      await expect(development.getByRole('region', { name: 'GitLab CI 작업', exact: true })
        .getByRole('link', { name: '수동 검토 작업', exact: true })).toBeVisible();
      await expect(development.getByRole('region', { name: 'GitLab 트리거 작업', exact: true })
        .getByRole('link', { name: '다운스트림 파이프라인 #940 열기', exact: true })).toHaveAttribute('href', downstreamUrl());
    } finally { await development.close(); }

    const final = await workspace();
    expect(final.gitlabLinks.find(link => link.id === saved?.id)).toEqual(refreshed);
    expect(final.issues.find(item => item.id === issue.id)).toMatchObject({ title: issue.title, status: issue.status, version: issue.version });
    expect(requests.filter(call => call.url.pathname === jobsPath)).toHaveLength(6);
    expect([5, 6]).toContain(requests.filter(call => call.url.pathname === bridgesPath).length);
    expect(new Set(requests.map(call => call.url.pathname))).toEqual(new Set([repositoryPath, pipelinePath, jobsPath, triggerJobsPath, bridgesPath]));
    expect(requests.every(call => call.method === 'GET' && call.credential === token)).toBe(true);
  } finally {
    try {
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
      const current = await settings();
      if (current.baseUrl === baseUrl) await json(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    } finally {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
});
