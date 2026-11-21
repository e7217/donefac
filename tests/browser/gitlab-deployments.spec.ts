import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { GitlabDeploymentPage, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types';

const integration = '/api/integrations/gitlab';
const sha = 'ab'.repeat(20);
const head = 'cd'.repeat(20);
const timestamp = (seconds: number) => new Date(Date.UTC(2024, 7, 21, 8, 0, seconds)).toISOString();

async function json<T>(response: APIResponse, status = 200): Promise<T> {
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
