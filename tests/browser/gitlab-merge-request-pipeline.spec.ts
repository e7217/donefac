import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { AutomationRule, GitlabIssueRefreshResult, GitlabLink, GitlabMergeRequestPipeline, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

const settingsPath = '/api/integrations/gitlab';
const rulesPath = '/api/automation-rules';
const repositoryId = 42;
const mrId = 872;
const mrIid = 8;
const pipelineId = 802;
const jobId = 814;
const sourceSha = 'e'.repeat(40);
const pipelineSha = 'a'.repeat(40);
const pipelineRef = `refs/merge-requests/${mrIid}/merge`;
const upstreamRepo = `/forge/api/v4/projects/${repositoryId}`;
const upstreamMr = `${upstreamRepo}/merge_requests/${mrIid}`;
const upstreamPipeline = `${upstreamRepo}/pipelines/${pipelineId}`;
const upstreamJobs = `${upstreamPipeline}/jobs`;
const upstreamTriggerJobs = `${upstreamPipeline}/trigger_jobs`;
const upstreamBridges = `${upstreamPipeline}/bridges`;
const unrelatedUrl = 'https://unrelated.invalid/team/other/-/pipelines/703?secret=synthetic#jobs';
const button = (container: Locator, name: string) => container.getByRole('button', { name, exact: true });

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

async function check(page: Page, trigger: Locator, path: string, status = 200) {
  const receiving = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET');
  await trigger.press('Enter');
  const response = await receiving;
  expect(response.status(), await response.text()).toBe(status);
  expect(response.request().method()).toBe('GET');
  expect(new URL(response.url()).search).toBe('');
  expect(response.headers()['cache-control']).toBe('no-store');
  return response;
}

test('360px에서 MR 최신 파이프라인을 확인하고 티켓에 연결해 해당 실행으로 상태를 검토한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const suffix = randomUUID();
  const token = `synthetic-mr-pipeline-api-${suffix}`;
  const secret = `synthetic-mr-pipeline-hook-${suffix}`;
  const at = new Date(Date.now() - 60_000).toISOString();
  const snapshot = () => request.get('/api/workspace').then(response => json<WorkspaceSnapshot>(response));
  const settings = () => request.get(settingsPath).then(response => json<GitlabSettings>(response));
  const initialSettings = await settings();
  expect(initialSettings.baseUrl).toBe('');
  const { projects: [project] } = await snapshot();
  const issue = await json<Issue>(await request.post('/api/issues', { data: {
    projectId: project.id, title: `MR 최신 파이프라인 합성 업무 ${suffix.slice(0, 8)}`,
  } }), 201);
  const branch = `feature/${issue.key}`;
  const calls: { path: string; method?: string; token?: string | string[] }[] = [];
  let mode: 'ready' | 'null' | 'unreported' = 'ready';
  let currentSourceSha = sourceSha;
  let pipelineUpdatedAt = at;
  let includeCanonicalPipelineUrl = false;
  let moveHeadDuringNextRead = false;
  let baseUrl = '';
  const repoUrl = () => `${baseUrl}/team/app`;
  const mrUrl = () => `${repoUrl()}/-/merge_requests/${mrIid}`;
  const pipelineUrl = () => `${repoUrl()}/-/pipelines/${pipelineId}`;
  const jobUrl = () => `${repoUrl()}/-/jobs/${jobId}`;
  const mrFields = () => ({ id: mrId, iid: mrIid, project_id: repositoryId, target_project_id: repositoryId,
    source_project_id: repositoryId, title: `${issue.key} 합성 병합 요청`, state: 'opened', source_branch: branch,
    target_branch: 'main', sha: currentSourceSha, diff_refs: { head_sha: currentSourceSha }, updated_at: at, web_url: mrUrl() });
  const pipeline = () => ({ id: pipelineId, iid: 19, project_id: repositoryId, status: 'failed', ref: pipelineRef,
    source: 'merge_request_event', tag: false, sha: pipelineSha, created_at: at, updated_at: pipelineUpdatedAt,
    finished_at: pipelineUpdatedAt, web_url: includeCanonicalPipelineUrl ? pipelineUrl() : unrelatedUrl });
  const remote = createServer((incoming, response) => {
    const path = new URL(incoming.url ?? '/', 'http://fixture.test').pathname;
    calls.push({ path, method: incoming.method, token: incoming.headers['private-token'] });
    response.setHeader('Content-Type', 'application/json');
    if (path === upstreamRepo) response.end(JSON.stringify({ id: repositoryId, path_with_namespace: 'team/app', web_url: repoUrl() }));
    else if (path === upstreamMr) response.end(JSON.stringify({ ...mrFields(), ...(mode === 'unreported' ? {} : {
      head_pipeline: mode === 'null' ? null : { id: pipelineId, project_id: repositoryId, sha: pipelineSha, web_url: unrelatedUrl },
    }) }));
    else if (path === upstreamPipeline) {
      if (moveHeadDuringNextRead) {
        currentSourceSha = 'b'.repeat(40);
        moveHeadDuringNextRead = false;
      }
      response.end(JSON.stringify(pipeline()));
    } else if (path === upstreamJobs) response.end(JSON.stringify([{
      id: jobId, name: '실패한 MR 통합 검사', stage: 'integration', status: 'failed', allow_failure: false,
      failure_reason: 'script_failure', pipeline: pipeline(), web_url: jobUrl(),
    }]));
    else if (path === upstreamTriggerJobs || path === upstreamBridges) response.end('[]');
    else response.writeHead(404).end('{}');
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  baseUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/forge`;
  let rule: AutomationRule | undefined;

  try {
    const configured = await json<GitlabSettings>(await request.patch(settingsPath, { data: {
      expectedVersion: initialSettings.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret,
    } }));
    const webhook = await json<{ linked: number }>(await request.post(`${settingsPath}/webhook`, {
      headers: { 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() },
      data: { object_kind: 'merge_request', project: { id: repositoryId, web_url: repoUrl() },
        object_attributes: { ...mrFields(), action: 'open' } },
    }));
    expect(webhook.linked).toBe(1);
    const before = await snapshot();
    const links = before.gitlabLinks.filter(link => link.issueId === issue.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: 'merge_request', state: 'opened', iid: mrIid, sourceSha });
    const mrPath = `/api/issues/${encodeURIComponent(issue.id)}/gitlab-links/${encodeURIComponent(links[0].id)}`;
    const lookupPath = `${mrPath}/merge-request-pipeline`;
    const jobsPath = `${mrPath}/merge-request-pipeline-jobs`;
    const browserWrites: string[] = [];
    page.context().on('request', sent => {
      const { pathname } = new URL(sent.url());
      if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(sent.method())) browserWrites.push(`${sent.method()} ${pathname}`);
    });

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    const gitlab = ticket.getByRole('region', { name: 'GitLab', exact: true });
    const panel = gitlab.getByRole('region', { name: 'GitLab MR 최신 파이프라인', exact: true });
    const trigger = button(gitlab, 'MR 최신 파이프라인 확인');
    const retry = button(panel, 'MR 최신 파이프라인 다시 확인');
    const openPipeline = panel.getByRole('link', { name: `파이프라인 #${pipelineId} GitLab에서 열기`, exact: true });
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    await expect(trigger).toBeVisible();
    expect(calls).toHaveLength(0);
    await title.fill('저장하지 않은 업무 제목');
    await comment.fill('보내지 않은 검토 댓글');
    await check(page, trigger, lookupPath);
    await expect(openPipeline).toHaveAttribute('href', pipelineUrl());
    await expect(panel.getByText('실패', { exact: true })).toBeVisible();
    await expect(panel).not.toContainText(unrelatedUrl);
    expect(calls.map(call => call.path)).toEqual([upstreamRepo, upstreamMr, upstreamPipeline, upstreamMr]);

    const jobs = panel.getByRole('region', { name: 'GitLab CI 작업', exact: true });
    await expect(jobs).toHaveCount(0);
    await check(page, button(panel, 'CI 작업 확인'), jobsPath);
    await expect(jobs.getByRole('link', { name: '실패한 MR 통합 검사', exact: true })).toHaveAttribute('href', jobUrl());
    await expect(jobs).toContainText('작업 스크립트 실패');
    expect(calls.filter(call => call.path === upstreamJobs)).toHaveLength(1);
    expect(await jobs.evaluate(region => region.getBoundingClientRect().width)).toBeLessThanOrEqual(360);

    const completedPipelineReads = calls.filter(call => call.path === upstreamPipeline).length;
    mode = 'null';
    await check(page, retry, lookupPath);
    await expect(panel).toContainText('이 MR에 최신 파이프라인이 없습니다.');
    await expect(openPipeline).toHaveCount(0);
    await expect(jobs).toHaveCount(0);
    mode = 'unreported';
    await check(page, retry, lookupPath);
    await expect(panel).toContainText('MR의 최신 파이프라인을 확인할 수 없습니다.');
    await expect(panel).not.toContainText('이 MR에 최신 파이프라인이 없습니다.');
    await expect(button(panel, 'CI 작업 확인')).toHaveCount(0);
    expect(calls.filter(call => call.path === upstreamPipeline)).toHaveLength(completedPipelineReads);

    mode = 'ready';
    moveHeadDuringNextRead = true;
    await check(page, retry, lookupPath, 409);
    await expect(panel).toContainText('변경되었습니다.');
    await expect(openPipeline).toHaveCount(0);
    await expect(title).toHaveValue('저장하지 않은 업무 제목');
    await expect(comment).toHaveValue('보내지 않은 검토 댓글');
    currentSourceSha = sourceSha;

    const development = await page.context().newPage();
    try {
      await development.setViewportSize({ width: 360, height: 820 });
      const callsBeforeDevelopment = calls.length;
      await development.goto(`/#/${project.id}/development`);
      const activity = development.getByRole('region', { name: '연결된 개발 활동', exact: true });
      const developmentTrigger = button(activity, 'MR 최신 파이프라인 확인');
      await expect(developmentTrigger).toBeVisible();
      expect(calls).toHaveLength(callsBeforeDevelopment);
      await check(development, developmentTrigger, lookupPath);
      const details = activity.getByRole('region', { name: 'GitLab MR 최신 파이프라인', exact: true });
      await expect(details.getByRole('link', { name: `파이프라인 #${pipelineId} GitLab에서 열기`, exact: true })).toHaveAttribute('href', pipelineUrl());
      await expect(button(details, 'CI 작업 확인')).toBeVisible();
      await expect(button(details, '이 업무에 파이프라인 연결')).toHaveCount(0);
      expect(calls.filter(call => call.path === upstreamJobs)).toHaveLength(1);
    } finally { await development.close(); }

    const after = await snapshot();
    expect(after.issues.find(item => item.id === issue.id)).toEqual(before.issues.find(item => item.id === issue.id));
    expect(after.gitlabLinks.filter(link => link.issueId === issue.id)).toEqual(links);
    expect(after.activities).toEqual(before.activities);
    expect(await settings()).toEqual(configured);
    expect(browserWrites).toEqual([]);

    includeCanonicalPipelineUrl = true;
    rule = await json<AutomationRule>(await request.post(rulesPath, { data: {
      projectId: project.id, name: `MR 파이프라인 결과 검토 ${suffix.slice(0, 8)}`, enabled: true, trigger: 'pipeline.failed',
      gitlabProjectIds: [repositoryId], branchPattern: pipelineRef, pipelineSources: ['merge_request_event'],
      issueTypes: [], fromStatuses: [issue.status], toStatusId: 'done',
    } }), 201);
    pipelineUpdatedAt = new Date().toISOString();
    const runsPath = `/api/automation-runs?projectId=${encodeURIComponent(project.id)}`;
    const beforeRuns = await json(await request.get(runsPath));
    const postTo = (path: string) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    const attach = button(panel, '이 업무에 파이프라인 연결');
    const readPipeline = async () => {
      const result = await json<GitlabMergeRequestPipeline>(await check(page, retry, lookupPath));
      if (result.kind !== 'pipeline') throw new Error('The synthetic MR must have a verified latest pipeline.');
      expect(result.revision).toMatch(/^[a-f\d]{64}$/);
      return result;
    };
    const prior = await readPipeline();
    currentSourceSha = 'c'.repeat(40);
    const rejected = postTo(lookupPath);
    await attach.click();
    expect((await rejected).status()).toBe(409);
    await expect(panel.getByRole('alert')).toBeVisible();
    expect((await snapshot()).gitlabLinks.filter(link => link.issueId === issue.id)).toEqual(links);
    const fresh = await readPipeline();
    expect(fresh.pipeline).toEqual(prior.pipeline);
    expect(fresh.revision).not.toBe(prior.revision);

    let savedLink: GitlabLink | undefined;
    await page.route(url => url.pathname === lookupPath, async route => {
      savedLink = await json<GitlabLink>(await route.fetch(), 201);
      await route.fulfill({ status: 408, json: { error: '합성 연결 응답 유실' } });
    }, { times: 1 });
    const attaching = postTo(lookupPath);
    await attach.click();
    const attached = await attaching;
    expect(attached.request().postDataJSON()).toEqual({ repositoryId, pipelineId, sha: pipelineSha, revision: fresh.revision });
    expect(attached.status()).toBe(408);
    if (!savedLink) throw new Error('Teamspace did not save the inspected pipeline.');
    expect(savedLink).toMatchObject({ issueId: issue.id, projectId: repositoryId, kind: 'pipeline', state: 'failed',
      sourceSha: pipelineSha, pipelineSource: 'merge_request_event', webUrl: pipelineUrl(), manualLinkId: expect.any(String) });
    const review = button(panel, '연결한 파이프라인으로 상태 검토');
    await expect(review).toBeEnabled();
    expect(browserWrites).toEqual([`POST ${lookupPath}`, `POST ${lookupPath}`]);
    await expect(title).toHaveValue('저장하지 않은 업무 제목');
    await expect(comment).toHaveValue('보내지 않은 검토 댓글');
    const attachedWorkspace = await snapshot();
    const attachedLinks = attachedWorkspace.gitlabLinks.filter(link => link.issueId === issue.id);
    expect(attachedLinks).toHaveLength(2);
    expect(attachedLinks).toEqual(expect.arrayContaining([...links, savedLink]));
    expect(attachedWorkspace.issues.find(item => item.id === issue.id)).toEqual(issue);
    expect(await json(await request.get(runsPath))).toEqual(beforeRuns);

    const reviewing = postTo(`/api/issues/${encodeURIComponent(issue.id)}/gitlab-links/${encodeURIComponent(savedLink.id)}/status-review`);
    await review.click();
    const result = await json<GitlabIssueRefreshResult>(await reviewing);
    expect(result.failures).toEqual([]);
    expect(result.statusReview).toMatchObject({ kind: 'suggestion', suggestion: { issueId: issue.id, toStatus: 'done', rule: { id: rule.id },
      evidence: { link: { id: savedLink.id }, trigger: 'pipeline.failed' } } });
    const proposal = gitlab.getByRole('region', { name: 'GitLab 상태 변경 제안', exact: true });
    await expect(proposal).toContainText(rule.name);
    await button(proposal, '목표 상태로 편집').click();
    const form = ticket.locator('form.issue-detail-form');
    await expect(form.getByRole('combobox', { name: '상태', exact: true })).toHaveValue('done');
    await expect(title).toHaveValue('저장하지 않은 업무 제목');
    await expect(comment).toHaveValue('보내지 않은 검토 댓글');
    expect((await snapshot()).issues.find(item => item.id === issue.id)).toEqual(issue);
    const applying = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${encodeURIComponent(issue.id)}` && response.request().method() === 'PATCH');
    await button(form, '변경사항 저장').click();
    expect(await json<Issue>(await applying)).toMatchObject({ title: '저장하지 않은 업무 제목', status: 'done' });
    expect(await json(await request.get(runsPath))).toEqual(beforeRuns);
    expect(calls.every(call => call.method === 'GET' && call.token === token)).toBe(true);
    expect(calls.every(call => [upstreamRepo, upstreamMr, upstreamPipeline, upstreamJobs, upstreamTriggerJobs, upstreamBridges].includes(call.path))).toBe(true);
  } finally {
    try {
      if (rule) await request.delete(`${rulesPath}/${rule.id}?expectedVersion=${rule.version}`);
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json() as { trashEntryId: string }).trashEntryId}`);
      const current = await settings();
      if (current.baseUrl === baseUrl) await json(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    } finally {
      remote.closeAllConnections();
      await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve()));
    }
  }
});
