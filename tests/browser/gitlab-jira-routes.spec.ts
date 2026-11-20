import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import type { GitlabSettings, GitlabSyncPreview, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';

const integration = '/api/integrations/gitlab';

function responseAt(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

test('360px에서 저장소 범위를 고르고 이관된 Jira 키로 미리 본 연결을 저장한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const repo = 742;
  const token = randomUUID().slice(0, 8);
  const instanceKey = `migration-mobile-${token}`;
  const previous = await (await request.get(integration)).json() as GitlabSettings;
  const sourceTitle = `이관한 개발 업무 ${token}`;
  const filename = `gitlab-mobile-${token}.csv`;
  let address = '';
  const calls: string[] = [];
  const upstream = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    const path = new URL(req.url ?? '/', address).pathname;
    res.end(JSON.stringify(path === `/forge/api/v4/projects/${repo}/merge_requests` ? [{
      id: 137, iid: 137, title: 'OLD-1 이전 키가 있는 MR', state: 'merged', source_branch: 'feature/legacy-reference',
      last_commit: { id: 'a'.repeat(40) }, updated_at: '2020-01-02T00:00:00Z', web_url: `${address}/team/repo/-/merge_requests/137`,
    }] : []));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  address = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/forge`;
  let origin: LegacyPackageSummary | undefined;

  try {
    const csv = Buffer.from(`Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type\r\n100,OLD-1,OLD,${sourceTitle},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task\r\n`);
    const staged = await request.post(`/api/legacy-import/packages?${new URLSearchParams({ filename, product: 'jira', instanceKey })}`, {
      data: csv, headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(staged.status(), await staged.text()).toBe(201);
    origin = await staged.json() as LegacyPackageSummary;
    const choices = await (await request.get(`/api/migrations/options?packageId=${origin.id}`)).json() as MigrationOptions;
    const configuration = choices.defaultConfiguration;
    configuration.projects = configuration.projects.map(value => ({ ...value, key: `GL${token.toUpperCase()}`, name: `GitLab 이관 검증 ${token}` }));
    const checked = await request.post('/api/migrations/preview', { data: { configuration } });
    expect(checked.status(), await checked.text()).toBe(201);
    const plan = await checked.json() as MigrationPreview;
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    const applied = await request.post(`/api/migrations/previews/${plan.id}/apply`, { data: {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    } });
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: receipt } = await applied.json() as MigrationApplyResult;
    const [projectId] = receipt.projectIds;
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const issue = snapshot.issues.find(value => value.projectId === projectId && value.title === sourceTitle);
    expect(issue).toBeDefined();
    expect(issue!.key).not.toBe('OLD-1');

    await page.goto(`/#/${projectId}/development`);
    const addressInput = page.getByLabel('GitLab 주소', { exact: true });
    await expect(addressInput).toBeEnabled();
    await addressInput.fill(address);
    await page.getByLabel(/^GitLab 프로젝트 ID/).fill(String(repo));
    const routes = page.getByRole('region', { name: '저장소별 Jira 원본 키 연결', exact: true });
    const destination = routes.getByLabel(`저장소 ${repo} Teamspace 프로젝트`, { exact: true });
    const source = routes.getByLabel(`저장소 ${repo} Jira 원본 인스턴스`, { exact: true });
    await destination.selectOption(projectId);
    await source.selectOption(instanceKey);
    const box = await routes.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(361);
    const mapping = [{ repositoryId: repo, projectId, jiraInstanceKey: instanceKey }];

    const stagedPreview = responseAt(page, `${integration}/sync-preview`);
    await page.getByRole('button', { name: '연결 미리보기', exact: true }).click();
    const preview = await stagedPreview;
    expect(preview.status(), await preview.text()).toBe(200);
    expect(preview.request().postDataJSON()).toMatchObject({ jiraRoutes: mapping });
    expect((await preview.json() as GitlabSyncPreview).candidates).toMatchObject([{ projectId: repo, issueId: issue!.id, originalJiraKey: 'OLD-1' }]);
    const candidates = page.getByRole('region', { name: '티켓 연결 후보', exact: true });
    await expect(candidates).toContainText('원본 Jira 키');
    await expect(candidates.locator('code').filter({ hasText: /^OLD-1$/ })).toBeVisible();
    await expect(candidates.getByRole('button', { name: `업무 ${issue!.key} 열기`, exact: true })).toBeVisible();
    expect(await (await request.get(integration)).json()).toEqual(previous);

    const save = page.getByRole('button', { name: '연결 설정 저장', exact: true });
    const committed = responseAt(page, integration, 'PATCH');
    await save.click();
    const saved = await committed;
    expect(saved.status(), await saved.text()).toBe(200);
    expect((await saved.json() as GitlabSettings).jiraRoutes).toEqual(mapping);
    await expect(addressInput).toBeEnabled();

    const synced = responseAt(page, `${integration}/sync`);
    await page.getByRole('button', { name: '지금 동기화', exact: true }).click();
    const syncedResult = await synced;
    expect(syncedResult.status(), await syncedResult.text()).toBe(200);
    expect(await syncedResult.json()).toMatchObject({ linked: 1 });
    const activity = page.getByRole('region', { name: '연결된 개발 활동', exact: true });
    await expect(activity).toContainText('원본 Jira 키');
    await expect(activity.locator('code').filter({ hasText: /^OLD-1$/ })).toBeVisible();
    await page.reload();
    await expect(destination).toHaveValue(projectId);
    await expect(source).toHaveValue(instanceKey);
    await expect(activity.locator('code').filter({ hasText: /^OLD-1$/ })).toBeVisible();

    await destination.selectOption('');
    const removed = responseAt(page, integration, 'PATCH');
    await save.click();
    const removal = await removed;
    expect(removal.status(), await removal.text()).toBe(200);
    expect(removal.request().postDataJSON()).toMatchObject({ jiraRoutes: [] });
    expect((await removal.json() as GitlabSettings).jiraRoutes ?? []).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.startsWith('GET '))).toBe(true);
  } finally {
    try {
      if (origin) await request.delete(`/api/legacy-import/packages/${origin.id}?expectedVersion=${origin.version}`);
      const current = await (await request.get(integration)).json() as GitlabSettings;
      if (current.baseUrl === address) await request.patch(integration, { data: {
        expectedVersion: current.version, baseUrl: previous.baseUrl, projectIds: previous.projectIds, jiraRoutes: previous.jiraRoutes ?? [],
      } });
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }
});
