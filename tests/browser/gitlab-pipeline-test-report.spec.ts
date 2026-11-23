import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse, type Request } from '@playwright/test';
import type { GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

const settingsPath = '/api/integrations/gitlab';
const repositoryId = 42;
const pipelineId = 803;
const repositoryPath = `/forge/api/v4/projects/${repositoryId}`;
const pipelinePath = `${repositoryPath}/pipelines/${pipelineId}`;
const reportPath = `${pipelinePath}/test_report_summary`;
const requestSuffix = /\/pipeline-test-report$/u;
const suiteName = '통합 검증';
const omittedSuite = '한도 밖 테스트 스위트';

async function json<T>(response: APIResponse, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(expected);
  return JSON.parse(body) as T;
}

test('360px 티켓과 개발 화면에서 연결된 GitLab 파이프라인의 테스트 결과를 필요한 때 확인한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const id = randomUUID();
  const webhookSecret = `synthetic-gitlab-test-report-${id}`;
  const readToken = `synthetic-pipeline-report-reader-${id}`;
  const privateReportError = `synthetic-private-junit-report-error-${id} ${readToken}`;
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const settings = async () => json<GitlabSettings>(await request.get(settingsPath));
  const { projects: [project] } = await workspace();
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const issue = await json<Issue>(await request.post('/api/issues', {
    data: { projectId: project.id, title: `테스트 파이프라인 검토 ${id.slice(0, 8)}` },
  }), 201);
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const changedAt = new Date(Date.parse(startedAt) + 1_000).toISOString();
  const sha = 'd'.repeat(40);
  const ref = `feature/${issue.key}`;
  const remoteCalls: { path: string; query: string; method?: string; token?: string | string[] }[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let delayNext = false;
  let empty = false;
  let unavailable = false;
  let upstreamStatus = 'failed';
  let upstreamUpdatedAt = startedAt;
  const mock = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    const token = incoming.headers['private-token'];
    remoteCalls.push({ path: url.pathname, query: url.search, method: incoming.method, token });
    response.setHeader('Content-Type', 'application/json');
    if (incoming.method !== 'GET' || url.search || token !== readToken) { response.writeHead(403).end('{}'); return; }
    if (url.pathname === repositoryPath) {
      response.end(JSON.stringify({ id: repositoryId, path_with_namespace: 'team/app', web_url: repositoryUrl }));
    } else if (url.pathname === pipelinePath) {
      response.end(JSON.stringify({ id: pipelineId, iid: 20, project_id: repositoryId, status: upstreamStatus, sha, ref,
        updated_at: upstreamUpdatedAt, web_url: pipelineUrl }));
    } else if (url.pathname === reportPath) {
      if (unavailable) { response.writeHead(404).end('{}'); return; }
      const suite = (name: string, count: number, success: number, failed: number, skipped: number, errors: number) =>
        ({ name, total_count: count, success_count: success, failed_count: failed, skipped_count: skipped, error_count: errors });
      const result = empty ? { total: { count: 0, success: 0, failed: 0, skipped: 0, error: 0 }, test_suites: [] } : {
        total: { count: 20, success: 14, failed: 3, skipped: 2, error: 1, suite_error: privateReportError },
        test_suites: [suite(suiteName, 9, 6, 2, 1, 0), suite('장비 단위 검사', 11, 8, 1, 1, 1),
          ...Array.from({ length: 48 }, (_, index) => suite(`빈 스위트 ${index + 1}`, 0, 0, 0, 0, 0)), suite(omittedSuite, 0, 0, 0, 0, 0)],
      };
      const payload = JSON.stringify(result);
      if (!delayNext) { response.end(payload); return; }
      delayNext = false;
      started.resolve();
      void release.promise.then(() => {
        if (!response.destroyed) response.end(payload);
        finished.resolve();
      });
    } else response.writeHead(404).end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/forge`;
  const repositoryUrl = `${baseUrl}/team/app`;
  const pipelineUrl = `${repositoryUrl}/-/pipelines/${pipelineId}`;
  async function observe(status: string, updatedAt: string) {
    const received = await json<{ linked: number }>(await request.post(`${settingsPath}/webhook`, {
      headers: { 'X-Gitlab-Token': webhookSecret, 'webhook-id': randomUUID() },
      data: { object_kind: 'pipeline', project: { id: repositoryId, web_url: repositoryUrl }, object_attributes: {
        id: pipelineId, iid: 20, status, sha, ref, url: pipelineUrl, updated_at: updatedAt,
      } },
    }));
    expect(received.linked).toBe(1);
    upstreamStatus = status;
    upstreamUpdatedAt = updatedAt;
  }

  try {
    await json(await request.patch(settingsPath, { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId], token: readToken, webhookSecret,
    } }));
    await observe('failed', startedAt);
    const link = (await workspace()).gitlabLinks.find(item => item.issueId === issue.id && item.kind === 'pipeline');
    expect(link).toMatchObject({ state: 'failed', updatedAt: startedAt });
    if (!link) throw new Error('Synthetic pipeline was not connected');
    const apiPath = `/api/issues/${issue.id}/gitlab-links/${link.id}/pipeline-test-report`;
    const calls: { path: string; query: string; method: string }[] = [];
    function recordRequest(sent: Request) {
      const url = new URL(sent.url());
      if (requestSuffix.test(url.pathname)) calls.push({ path: decodeURIComponent(url.pathname), query: url.search, method: sent.method() });
    }
    const canceled: string[] = [];
    page.on('request', recordRequest);
    page.on('requestfailed', sent => { if (requestSuffix.test(sent.url())) canceled.push(sent.failure()?.errorText ?? ''); });

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = ticket.getByRole('region', { name: 'GitLab', exact: true });
    const row = gitlab.getByRole('region', { name: '파이프라인', exact: true }).locator('[data-gitlab-kind="pipeline"]');
    const open = row.getByRole('button', { name: '테스트 결과 확인', exact: true });
    await expect(open).toBeVisible({ timeout: 35_000 });
    expect(calls).toHaveLength(0);
    expect(remoteCalls).toHaveLength(0);
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    await title.fill('저장하지 않은 검토 제목');
    await comment.fill('보내지 않은 검사 메모');
    await open.press('Enter');
    const report = row.getByRole('region', { name: 'GitLab 테스트 결과', exact: true });
    const totals = report.getByRole('group', { name: '전체 테스트', exact: true });
    for (const count of ['전체 20개', '성공 14개', '실패 3개', '건너뜀 2개', '오류 1개']) {
      await expect(totals.getByText(count, { exact: true })).toBeVisible();
    }
    const suite = report.getByRole('list', { name: '테스트 스위트', exact: true }).getByRole('listitem').filter({ hasText: suiteName });
    await expect(suite).toContainText('실패 2개');
    await expect(report).toContainText('일부 테스트 스위트만 표시합니다.');
    await expect(report).toContainText('GitLab에서 테스트 보고서 오류를 보고했습니다.');
    await expect(report).not.toContainText(omittedSuite);
    await expect(report).not.toContainText(privateReportError);
    await expect(report.getByRole('link', { name: 'GitLab에서 파이프라인 열기', exact: true })).toHaveAttribute('href', pipelineUrl);
    expect(await report.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(360);
    expect(calls).toHaveLength(1);

    const retry = report.getByRole('button', { name: '테스트 결과 다시 확인', exact: true });
    delayNext = true;
    try {
      await retry.click();
      await started.promise;
      await observe('success', changedAt);
      await gitlab.getByRole('button', { name: 'GitLab 활동 새로고침', exact: true }).click();
      await expect(row).toHaveAttribute('data-gitlab-state', 'success');
      await expect(report.getByRole('status')).toContainText('파이프라인이 변경되었습니다.');
    } finally { release.resolve(); }
    await finished.promise;
    await expect.poll(() => canceled).toEqual([expect.stringContaining('ERR_ABORTED')]);
    await expect(suite).toHaveCount(0);
    expect(calls).toHaveLength(2);

    empty = true;
    await retry.click();
    await expect(report).toContainText('GitLab에서 확인한 테스트가 없습니다.');
    await expect(report).not.toContainText(suiteName);
    await expect(title).toHaveValue('저장하지 않은 검토 제목');
    await expect(comment).toHaveValue('보내지 않은 검사 메모');
    await row.getByRole('button', { name: '테스트 결과 닫기', exact: true }).press('Enter');
    await expect(report).toHaveCount(0);
    await expect(open).toBeFocused();

    empty = false;
    const development = await page.context().newPage();
    try {
      const beforeDevelopment = remoteCalls.length;
      development.on('request', recordRequest);
      await development.setViewportSize({ width: 360, height: 820 });
      await development.goto(`/#/${project.id}/development`);
      const activity = development.getByRole('region', { name: '연결된 개발 활동', exact: true });
      const trigger = activity.getByRole('button', { name: '테스트 결과 확인', exact: true });
      await expect(trigger).toBeVisible({ timeout: 35_000 });
      expect(calls).toHaveLength(3);
      expect(remoteCalls).toHaveLength(beforeDevelopment);
      await trigger.click();
      const developmentReport = activity.getByRole('region', { name: 'GitLab 테스트 결과', exact: true });
      await expect(developmentReport).toContainText(suiteName);
      unavailable = true;
      await developmentReport.getByRole('button', { name: '테스트 결과 다시 확인', exact: true }).click();
      await expect(developmentReport.getByRole('alert')).toHaveText('GitLab에서 이 파이프라인의 테스트 결과를 제공하지 않습니다.');
      await expect(developmentReport).not.toContainText(suiteName);
    } finally { await development.close(); }

    expect(calls).toEqual(Array(5).fill({ path: apiPath, query: '', method: 'GET' }));
    const complete = [repositoryPath, pipelinePath, reportPath, pipelinePath];
    const incomplete = [repositoryPath, pipelinePath, reportPath];
    expect(remoteCalls).toEqual([...complete, ...incomplete, ...complete, ...complete, ...incomplete]
      .map(path => ({ path, query: '', method: 'GET', token: readToken })));
    const final = await workspace();
    expect(final.issues.find(item => item.id === issue.id)).toEqual(issue);
    expect(final.gitlabLinks.find(item => item.id === link.id)).toMatchObject({ state: 'success', updatedAt: changedAt });
  } finally {
    try {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
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
