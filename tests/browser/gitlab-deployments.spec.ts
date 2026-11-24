import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse, type Locator, type Response } from '@playwright/test';
import type { AutomationRule, GitlabDeploymentPage, GitlabDeploymentReviewResult, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

const integration = '/api/integrations/gitlab';
const sha = 'ab'.repeat(20);
const head = 'cd'.repeat(20);
const timestamp = (seconds: number) => new Date(Date.UTC(2024, 7, 21, 8, 0, seconds)).toISOString();

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('360px GitLab 배포가 저장소에 먼저 나타나고 MR 병합 확인 뒤 정확한 티켓에 표시된다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [author] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const original = await json<GitlabSettings>(await request.get(integration));
  const baseUrl = `https://git-${randomUUID()}.example.test/gitlab`;
  const repoName = (id: number) => id === 42 ? 'team/product' : 'team/another';
  const repoUrl = (id: number) => `${baseUrl}/${repoName(id)}`;
  const secret = `synthetic-deployment-${randomUUID()}`;
  const headers = { 'X-Actor-Id': author.id };
  let issue: Issue | undefined;
  let alternate: Issue | undefined;
  let configured = false;

  async function send(event: string, data: object) {
    return json<{ linked: number; runs: unknown[]; deploymentUpdated?: true }>(await request.post(`${integration}/webhook`, {
      headers: { 'X-Gitlab-Event': event, 'X-Gitlab-Token': secret, 'X-Gitlab-Event-UUID': randomUUID() }, data,
    }));
  }

  function observation(deploymentId: number, environment: string, status: string, elapsed: number, repositoryId = 42, job = true) {
    return {
      object_kind: 'deployment', deployment_id: deploymentId, environment, environment_tier: environment,
      status, status_changed_at: timestamp(elapsed), short_sha: sha.slice(0, 8), commit_url: `${repoUrl(repositoryId)}/-/commit/${sha}`,
      project: { id: repositoryId, path_with_namespace: repoName(repositoryId), web_url: repoUrl(repositoryId) },
      deployable_id: job ? deploymentId + 700 : null, deployable_url: job ? `${repoUrl(repositoryId)}/-/jobs/${deploymentId + 700}` : null,
      environment_external_url: 'https://outside.example.test/app',
    };
  }

  const dispose = async (value: Issue | undefined) => {
    if (!value) return;
    const removed = await request.delete(`/api/issues/${value.id}`, { headers });
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  };

  try {
    await json<GitlabSettings>(await request.patch(integration, { headers,
      data: { expectedVersion: original.version, baseUrl, projectIds: [42, 43], webhookSecret: secret },
    }));
    configured = true;
    const id = randomUUID().slice(0, 8);
    issue = await json<Issue>(await request.post('/api/issues', { headers, data: { projectId: project.id, title: `환경 배포 ${id}` } }), 201);
    alternate = await json<Issue>(await request.post('/api/issues', { headers, data: { projectId: project.id, title: `다른 업무 ${id}` } }), 201);
    const first = await send('Deployment Hook', { ...observation(10, 'production', 'success', 5), commit_title: alternate.key });
    expect(first).toMatchObject({ deploymentUpdated: true, linked: 0, runs: [] });
    await send('Deployment Hook', observation(11, 'staging', 'failed', 6, 42, false));
    await send('Deployment Hook', observation(10, 'staging', 'success', 7, 43));
    expect((await json<GitlabDeploymentPage>(await request.get(`/api/issues/${issue.id}/gitlab-deployments`))).total).toBe(0);

    await page.goto(`/#/${project.id}/development`);
    const history = page.getByRole('region', { name: 'GitLab 배포 기록', exact: true });
    const repos = history.getByRole('combobox', { name: '배포 저장소', exact: true });
    const records = history.getByRole('list', { name: 'GitLab 배포 목록', exact: true });
    await expect(repos).toHaveValue('42', { timeout: 30_000 });
    await expect(records.getByRole('listitem')).toHaveCount(2);
    await expect(records.getByRole('button', { name: '이 배포로 상태 검토', exact: true })).toHaveCount(0);
    await repos.selectOption('43');
    await expect(records.getByRole('listitem')).toHaveCount(1);
    await expect(records.getByRole('link', { name: 'GitLab 작업 열기', exact: true })).toHaveAttribute('href', `${repoUrl(43)}/-/jobs/710`);
    await repos.selectOption('42');
    await expect(records.getByRole('listitem')).toHaveCount(2);

    const merged = await send('Merge Request Hook', { object_kind: 'merge_request', project: { id: 42, web_url: repoUrl(42) },
      object_attributes: { id: 301, iid: 12, target_project_id: 42, title: `${issue.key} 병합`, action: 'merge', state: 'merged',
        updated_at: timestamp(4), source_branch: `feature/${issue.key}`, sha: head, merge_commit_sha: sha,
        url: `${repoUrl(42)}/-/merge_requests/12` },
    });
    expect(merged.linked).toBe(1);
    expect((await json<GitlabDeploymentPage>(await request.get(`/api/issues/${alternate.id}/gitlab-deployments`))).total).toBe(0);
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const deployments = panel.getByRole('region', { name: '연결된 GitLab 배포', exact: true });
    const rows = deployments.getByRole('list', { name: 'GitLab 배포 목록', exact: true }).getByRole('listitem');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    const prod = rows.filter({ hasText: 'production' });
    const stage = rows.filter({ hasText: 'staging' });
    await expect(prod).toHaveAttribute('data-deployment-status', 'success');
    await expect(prod.getByText('성공', { exact: true })).toBeVisible();
    await expect(prod.getByRole('link', { name: 'GitLab 작업 열기', exact: true })).toHaveAttribute('href', `${repoUrl(42)}/-/jobs/710`);
    await expect(stage.getByText('실패', { exact: true })).toBeVisible();
    await expect(stage.getByRole('link', { name: 'GitLab 커밋 열기', exact: true })).toHaveAttribute('href', `${repoUrl(42)}/-/commit/${sha}`);
    await expect(stage.locator('time')).toHaveAttribute('datetime', timestamp(6));
    await expect(stage.locator('code')).toHaveText(sha.slice(0, 12));
    const width = (await deployments.boundingBox())!;
    expect(width.x).toBeGreaterThanOrEqual(0);
    expect(width.x + width.width).toBeLessThanOrEqual(361);

    const later = await send('Deployment Hook', observation(11, 'staging', 'success', 9, 42, false));
    expect(later).toMatchObject({ deploymentUpdated: true, linked: 0, runs: [] });
    const stale = await send('Deployment Hook', observation(11, 'staging', 'running', 8, 42, false));
    expect(stale.deploymentUpdated).toBeUndefined();
    await deployments.getByRole('button', { name: '배포 새로고침', exact: true }).click();
    await expect(stage).toHaveAttribute('data-deployment-status', 'success');
    const snapshot = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(snapshot.issues.find(item => item.id === issue?.id)?.status).toBe(issue.status);
  } finally {
    await dispose(alternate);
    await dispose(issue);
    if (configured) {
      const current = await json<GitlabSettings>(await request.get(integration));
      await json<GitlabSettings>(await request.patch(integration, { headers, data: { expectedVersion: current.version,
        baseUrl: original.baseUrl, projectIds: original.projectIds, webhookSecret: '', token: '', signingToken: '', jiraRoutes: original.jiraRoutes ?? [] },
      }));
    }
  }
});

test('360px 티켓에서 완료 웹훅을 받지 못한 배포를 확인해 일반 티켓 편집으로 상태를 저장한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const workspace = () => request.get('/api/workspace').then(response => json<WorkspaceSnapshot>(response));
  const { projects: [project], users: [author] } = await workspace();
  const original = await json<GitlabSettings>(await request.get(integration));
  expect(original.baseUrl).toBe('');
  const suffix = randomUUID();
  const token = `synthetic-review-read-${suffix}`;
  const secret = `synthetic-review-hook-${suffix}`;
  const headers = { 'X-Actor-Id': author.id };
  const repositoryId = 42;
  const deploymentId = 781;
  const jobId = 1241;
  const environment = 'production';
  const repoPath = `/gitlab/api/v4/projects/${repositoryId}`;
  const deploymentsPath = `${repoPath}/deployments`;
  const exactPath = `${deploymentsPath}/${deploymentId}`;
  const rulesPath = '/api/automation-rules';
  const runsPath = `/api/automation-runs?projectId=${encodeURIComponent(project.id)}`;
  const readUrls: URL[] = [];
  let configured = false;
  let issue: Issue | undefined;
  let rule: AutomationRule | undefined;
  let finishedAt: string | null = null;
  let laterFinishedAt: string | null = null;

  const mock = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture.test');
    if (incoming.method !== 'GET' || incoming.headers['private-token'] !== token) return response.writeHead(401).end();
    readUrls.push(url);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === repoPath) return response.end(JSON.stringify({ id: repositoryId, web_url: projectUrl, path_with_namespace: 'team/product' }));
    const deployment = (id: number, job: number, completed: string | null) => ({
      id, sha, status: 'success', updated_at: finishedAt ?? startedAt, environment: { name: environment },
      deployable: { id: job, status: 'success', finished_at: completed, web_url: `${projectUrl}/-/jobs/${job}` },
    });
    const selected = deployment(deploymentId, jobId, finishedAt);
    if (url.pathname === exactPath) return response.end(JSON.stringify(selected));
    if (url.pathname === deploymentsPath) return response.end(JSON.stringify(laterFinishedAt
      ? [{ ...deployment(deploymentId + 1, jobId + 1, laterFinishedAt), updated_at: laterFinishedAt }, selected] : [selected]));
    if (url.pathname === `${exactPath}/merge_requests`) return response.end('[]');
    return response.writeHead(404).end('{}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/gitlab`;
  const projectUrl = `${baseUrl}/team/product`;
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const publish = (event: string, data: object) => request.post(`${integration}/webhook`, {
    headers: { 'X-Gitlab-Event': event, 'X-Gitlab-Token': secret, 'X-Gitlab-Event-UUID': randomUUID() }, data,
  }).then(response => json<{ linked: number; deploymentUpdated?: true }>(response));

  try {
    await json<GitlabSettings>(await request.patch(integration, { headers,
      data: { expectedVersion: original.version, baseUrl, projectIds: [repositoryId], token, webhookSecret: secret },
    }));
    configured = true;
    issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
      projectId: project.id, title: `배포 상태 검토 ${suffix.slice(0, 8)}`,
    } }), 201);
    rule = await json<AutomationRule>(await request.post(rulesPath, { headers, data: {
      projectId: project.id, name: `production 확인 ${suffix.slice(0, 8)}`, enabled: true, trigger: 'deployment.succeeded',
      gitlabProjectIds: [repositoryId], environment, branchPattern: '', issueTypes: [], fromStatuses: [issue.status], toStatusId: 'done',
    } }), 201);
    const repo = { id: repositoryId, web_url: projectUrl, path_with_namespace: 'team/product' };
    expect((await publish('Merge Request Hook', { object_kind: 'merge_request', project: repo, object_attributes: {
      id: 387, iid: 14, target_project_id: repositoryId, title: `${issue.key} 병합`, action: 'merge', state: 'merged',
      updated_at: startedAt, source_branch: `feature/${issue.key}`, sha: head, merge_commit_sha: sha, url: `${projectUrl}/-/merge_requests/14`,
    } })).linked).toBe(1);
    expect((await publish('Deployment Hook', {
      object_kind: 'deployment', deployment_id: deploymentId, environment, environment_tier: environment,
      status: 'running', status_changed_at: startedAt, short_sha: sha.slice(0, 8), commit_url: `${projectUrl}/-/commit/${sha}`,
      project: repo, deployable_id: jobId, deployable_url: `${projectUrl}/-/jobs/${jobId}`,
    })).deploymentUpdated).toBe(true);
    const issuePath = `/api/issues/${issue.id}`;
    const stored = await json<GitlabDeploymentPage>(await request.get(`${issuePath}/gitlab-deployments`));
    expect(stored.items).toEqual([expect.objectContaining({ deploymentId, status: 'running' })]);
    const reviewPath = `${issuePath}/gitlab-deployments/${stored.items[0].instance}/${repositoryId}/${deploymentId}/status-review`;
    const previousRuns = await json(await request.get(runsPath));

    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const row = panel.getByRole('region', { name: '연결된 GitLab 배포', exact: true }).getByRole('listitem');
    const trigger = row.getByRole('button', { name: '이 배포로 상태 검토', exact: true });
    const feedback = panel.getByRole('group', { name: 'GitLab 상태 확인 결과', exact: true });
    const suggestion = feedback.getByRole('region', { name: 'GitLab 상태 변경 제안', exact: true });
    const issueForm = panel.locator('form.issue-detail-form');
    const status = issueForm.getByRole('combobox', { name: '상태', exact: true });
    const title = issueForm.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    await expect(row).toHaveAttribute('data-deployment-status', 'running', { timeout: 30_000 });
    await expect(suggestion).toHaveCount(0);
    const titleDraft = `${issue.title} 편집 초안`;
    const commentDraft = '전송하지 않은 배포 댓글';
    await title.fill(titleDraft);
    await comment.fill(commentDraft);

    async function review(button: Locator) {
      const response = page.waitForResponse(value => new URL(value.url()).pathname === reviewPath && value.request().method() === 'POST');
      await button.press('Enter');
      const received = await response;
      expect(received.request().postDataJSON()).toEqual({});
      expect(received.headers()['cache-control']).toBe('no-store');
      return json<GitlabDeploymentReviewResult>(received);
    }

    finishedAt = new Date().toISOString();
    const checked = await review(trigger);
    expect(readUrls.map(url => url.pathname)).toEqual([repoPath, exactPath, deploymentsPath, `${exactPath}/merge_requests`]);
    expect(Object.fromEntries(readUrls[2].searchParams)).toMatchObject({ environment, status: 'success', order_by: 'finished_at', sort: 'desc', per_page: '2' });
    expect(checked).toMatchObject({ state: 'ready', deployment: { deploymentId, environment, status: 'success' } });
    if (checked.statusReview?.kind !== 'suggestion') throw new Error('선택한 GitLab 배포의 상태 제안이 없습니다.');
    const proposal = checked.statusReview.suggestion;
    expect(proposal).toMatchObject({ issueId: issue.id, issueVersion: issue.version, fromStatus: issue.status, toStatus: 'done',
      rule: { id: rule.id }, evidence: { trigger: 'deployment.succeeded', occurredAt: finishedAt, deployment: { deploymentId, sha } } });
    await expect(feedback).toBeFocused();
    await expect(feedback.getByText(`${environment} 배포 #${deploymentId} · 확인한 상태`)).toContainText('성공');
    await expect(row).toHaveAttribute('data-deployment-status', 'success');
    await expect(suggestion.getByText('선택한 GitLab 배포 기준', { exact: true })).toBeVisible();
    await expect(suggestion).toContainText(`${environment} 배포 #${deploymentId}`);
    await expect(suggestion.getByRole('link', { name: 'GitLab 원본 열기', exact: true })).toHaveAttribute('href', `${projectUrl}/-/jobs/${jobId}`);
    await expect(status).toHaveValue(issue.status);
    await expect(title).toHaveValue(titleDraft);
    await expect(comment).toHaveValue(commentDraft);
    expect((await workspace()).issues.find(value => value.id === issue?.id)).toEqual(issue);

    await suggestion.getByRole('button', { name: '목표 상태로 편집', exact: true }).click();
    await expect(status).toHaveValue('done');
    await expect(status).toBeFocused();
    await expect(title).toHaveValue(titleDraft);
    await expect(comment).toHaveValue(commentDraft);
    expect((await workspace()).issues.find(value => value.id === issue?.id)).toEqual(issue);
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === issuePath && response.request().method() === 'PATCH');
    await issueForm.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const saved = await saving;
    expect(saved.request().postDataJSON()).toMatchObject({
      expectedVersion: issue.version, title: titleDraft, status: 'done', gitlabStatusSuggestionToken: proposal.token,
    });
    expect(await json<Issue>(saved)).toMatchObject({ status: 'done', title: titleDraft, version: issue.version + 1 });
    const savedPanel = page.getByRole('dialog', { name: titleDraft, exact: true });
    await expect(savedPanel.getByRole('textbox', { name: '댓글 내용', exact: true })).toHaveValue(commentDraft);

    laterFinishedAt = new Date().toISOString();
    const previousReads = readUrls.length;
    const superseded = await review(savedPanel.getByRole('button', { name: '이 배포로 상태 검토', exact: true }));
    expect(readUrls.slice(previousReads).map(url => url.pathname)).toEqual([repoPath, exactPath, deploymentsPath]);
    expect(superseded).toMatchObject({ state: 'superseded', deployment: { deploymentId, environment, status: 'success' } });
    expect(superseded.statusReview).toBeUndefined();
    const savedFeedback = savedPanel.getByRole('group', { name: 'GitLab 상태 확인 결과', exact: true });
    await expect(savedFeedback).toContainText('같은 환경에 더 최근에 완료된 성공 배포가 있습니다.');
    await expect(savedFeedback.getByRole('region', { name: 'GitLab 상태 변경 제안', exact: true })).toHaveCount(0);
    expect(await json(await request.get(runsPath))).toEqual(previousRuns);
  } finally {
    try {
      if (rule) await request.delete(`${rulesPath}/${rule.id}?expectedVersion=${rule.version}`, { headers });
      if (issue) {
        const deleted = await request.delete(`/api/issues/${issue.id}`, { headers });
        if (deleted.ok()) {
          const { trashEntryId } = await deleted.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`, { headers });
        }
      }
      if (configured) {
        const current = await json<GitlabSettings>(await request.get(integration));
        await json<GitlabSettings>(await request.patch(integration, { headers,
          data: { expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '' },
        }));
      }
    } finally {
      mock.closeAllConnections();
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
});

test('360px 저장소에서 과거 배포를 동기화해 서로 다른 MR의 티켓 두 개에서 같은 배포를 본다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [author] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const original = await json<GitlabSettings>(await request.get(integration));
  expect(original.baseUrl).toBe('');
  const token = `synthetic-read-${randomUUID()}`;
  const secret = `synthetic-hook-${randomUUID()}`;
  const artifact = 'ad'.repeat(20);
  const headers = { 'X-Actor-Id': author.id };
  const readPaths: string[] = [];
  const issues: Issue[] = [];
  let denyAssociations = false;
  let configured = false;
  const repoPath = '/gitlab/api/v4/projects/42';
  const mock = createServer((incoming, response) => {
    const path = new URL(incoming.url ?? '/', baseUrl).pathname;
    if (incoming.method !== 'GET' || incoming.headers['private-token'] !== token) return response.writeHead(401).end();
    readPaths.push(path);
    response.setHeader('Content-Type', 'application/json');
    if (path === repoPath) return response.end(JSON.stringify({ id: 42, web_url: projectUrl, path_with_namespace: 'team/product' }));
    if (path === `${repoPath}/deployments`) {
      return response.end(JSON.stringify([{ id: 700, sha: artifact, status: 'success', updated_at: timestamp(9),
        environment: { id: 1, name: 'production' }, deployable: null }]));
    }
    if (path === `${repoPath}/deployments/700/merge_requests`) {
      if (denyAssociations) return response.writeHead(403).end('{}');
      return response.end(JSON.stringify([775, 776].map((id, index) => ({ id, iid: 20 + index, state: 'merged', target_project_id: 42 }))));
    }
    response.writeHead(404).end();
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/gitlab`;
  const projectUrl = `${baseUrl}/team/product`;
  try {
    await json<GitlabSettings>(await request.patch(integration, { headers,
      data: { expectedVersion: original.version, baseUrl, projectIds: [42], token, webhookSecret: secret },
    }));
    configured = true;
    const identifier = randomUUID().slice(0, 8);
    for (let index = 0; index < 2; index++) {
      const issue = await json<Issue>(await request.post('/api/issues', { headers,
        data: { projectId: project.id, title: `배포 포함 MR ${index + 1} ${identifier}` } }), 201);
      issues.push(issue);
      const iid = 20 + index;
      const linked = await json<{ linked: number }>(await request.post(`${integration}/webhook`, {
        headers: { 'X-Gitlab-Token': secret, 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Event-UUID': randomUUID() },
        data: { object_kind: 'merge_request', project: { id: 42, web_url: projectUrl }, object_attributes: {
          id: 775 + index, iid, target_project_id: 42, title: `${issue.key} MR`, state: 'merged', action: 'merge',
          source_branch: `feature/${issue.key}`, sha: (index ? 'b' : 'a').repeat(40), merge_commit_sha: (index ? 'e' : 'f').repeat(40),
          url: `${projectUrl}/-/merge_requests/${iid}`, updated_at: timestamp(index),
        } },
      }));
      expect(linked.linked).toBe(1);
    }
    await page.goto(`/#/${project.id}/development`);
    const region = page.getByRole('region', { name: 'GitLab 배포 기록', exact: true });
    const sync = region.getByRole('button', { name: '배포 이력 동기화', exact: true });
    const report = region.getByRole('status', { name: '배포 이력 동기화 결과', exact: true });
    const record = region.getByRole('listitem').filter({ hasText: 'production' });
    await expect(sync).toBeVisible({ timeout: 30_000 });
    await expect(record).toHaveCount(0);
    await sync.click();
    await expect(report).toContainText('배포 1건 조회 · 1건 반영 · 포함 MR 2건 반영');
    await expect(record).toContainText('포함 MR 2개');
    await expect(record).toContainText('GitLab 동기화');
    expect(readPaths).toEqual([repoPath, `${repoPath}/deployments`, `${repoPath}/deployments/700/merge_requests`]);

    denyAssociations = true;
    await sync.click();
    await expect(report).toContainText('배포 1건 조회 · 0건 반영 · 포함 MR 0건 반영');
    await expect(report).toContainText('포함 MR을 조회하지 못한 배포 1건');
    await expect(record).toContainText('포함 MR 2개');
    for (const issue of issues) {
      await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
      const panel = page.getByRole('dialog', { name: issue.title, exact: true });
      const result = panel.getByRole('region', { name: '연결된 GitLab 배포', exact: true }).getByRole('listitem');
      await expect(result).toHaveCount(1);
      await expect(result).toHaveAttribute('data-deployment-id', '700');
      await expect(result).toContainText('포함 MR 2개');
      await expect(result.getByRole('link', { name: 'GitLab 커밋 열기' })).toHaveAttribute('href', `${projectUrl}/-/commit/${artifact}`);
    }
  } finally {
    for (const issue of issues) {
      const deleted = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (!deleted.ok()) continue;
      const { trashEntryId } = await deleted.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
    if (configured) {
      const current = await json<GitlabSettings>(await request.get(integration));
      await json<GitlabSettings>(await request.patch(integration, { headers,
        data: { expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '' },
      }));
    }
    mock.closeAllConnections();
    await new Promise<void>(resolve => mock.close(() => resolve()));
  }
});
