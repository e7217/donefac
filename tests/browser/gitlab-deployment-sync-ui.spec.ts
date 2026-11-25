import { expect, test } from '@playwright/test';
import type { GitlabDeployment, GitlabDeploymentPage, GitlabDeploymentSyncResult, GitlabLink, GitlabSettings, WorkspaceSnapshot } from '../../shared/types';

const integration = '/api/integrations/gitlab';
const settings: GitlabSettings = {
  baseUrl: 'https://gitlab.example.test/gitlab', projectIds: [42, 43], version: 17,
  tokenConfigured: false, webhookSecretConfigured: false, signingTokenConfigured: false,
  lastSyncAt: null, lastError: null,
};

function deployment(repositoryId: number, offset: number, synced: boolean): GitlabDeployment {
  return {
    instance: 'synthetic', repositoryId, deploymentId: repositoryId * 100 + offset,
    environment: synced ? `동기화한 ${repositoryId} 배포` : `기존 ${repositoryId} 배포 ${offset}`,
    sha: 'ab'.repeat(20), status: synced ? 'success' : offset === 1 ? 'created' : 'skipped', changedAt: '2024-02-14T12:00:00.000Z',
    projectUrl: `${settings.baseUrl}/team/repo-${repositoryId}`,
    ...(synced ? { source: 'sync', mergeRequests: [{ id: 1201, iid: 3 }, { id: 1202, iid: 8 }] } : {}),
  };
}

function readResult(repositoryId: number, count: number): GitlabDeploymentSyncResult {
  return {
    repositoryId, settingsVersion: settings.version, deploymentsRead: count, deploymentsStored: 2,
    mergeRequestsStored: 2, associationUnavailable: 3, associationLimited: 4, deploymentLimitReached: true,
  };
}

test('배포 조건과 페이지를 저장소 주소에서 열고 연결된 티켓 검토 후 같은 목록으로 돌아온다', async ({ page, context, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const project = snapshot.projects[0];
  const issue = snapshot.issues.find(value => value.projectId === project.id)!;
  const link: GitlabLink = {
    id: 'deployment-history-review-activity', projectId: 43, issueId: issue.id, kind: 'pipeline', iid: 7101,
    title: '배포 검토 파이프라인', webUrl: `${settings.baseUrl}/team/repo-43/-/pipelines/7101`,
    state: 'failed', updatedAt: '2024-02-14T12:00:00.000Z',
  };
  const environment = '배포 / staging';
  await context.route(url => url.pathname === '/api/workspace', route => route.fulfill({ json: { ...snapshot, gitlabLinks: [link] } }));
  await context.route(url => url.pathname === integration, route => route.fulfill({ json: settings }));
  await context.route(url => url.pathname === `${integration}/deployments`, route => {
    const query = new URL(route.request().url()).searchParams;
    const repositoryId = Number(query.get('repositoryId'));
    const offset = Number(query.get('offset'));
    const data: GitlabDeploymentPage = {
      items: offset >= 2 ? [] : [{ ...deployment(repositoryId, offset, false), environment: `${environment}-${offset}`,
        status: query.get('status') === 'failed' ? 'failed' : 'created' }],
      total: 2, offset, limit: 1,
    };
    return route.fulfill({ json: data });
  });

  const name = { name: 'GitLab 배포 기록', exact: true };
  await page.goto(`/#/${project.id}/development`);
  const panel = page.getByRole('region', name);
  const repository = panel.getByRole('combobox', { name: '배포 저장소', exact: true });
  const search = panel.getByRole('searchbox', { name: '배포 환경', exact: true });
  const status = panel.getByRole('combobox', { name: '배포 상태', exact: true });
  const rows = panel.getByRole('list', { name: 'GitLab 배포 목록', exact: true });
  await repository.selectOption('43');
  await search.fill(environment);
  await status.selectOption('failed');
  await panel.getByRole('button', { name: '배포 검색', exact: true }).click();
  await expect(rows.getByRole('listitem')).toHaveAttribute('data-deployment-status', 'failed');
  await expect(page).toHaveURL(url => {
    const parameters = new URLSearchParams(url.hash.split('?')[1]);
    return parameters.get('deploymentRepository') === '43' && parameters.get('deploymentEnvironment') === environment &&
      parameters.get('deploymentStatus') === 'failed' && !parameters.has('deploymentOffset');
  }, { timeout: 5_000 });
  const firstPage = page.url();
  await panel.getByRole('button', { name: '다음 배포', exact: true }).click();
  await expect(rows.getByRole('listitem')).toHaveAttribute('data-deployment-id', '4301');
  await expect(page).toHaveURL(url => new URLSearchParams(url.hash.split('?')[1]).get('deploymentOffset') === '1');
  const secondPage = page.url();

  const opener = page.getByRole('region', { name: '연결된 개발 활동', exact: true }).getByRole('button', { name: issue.key, exact: true });
  await opener.click();
  const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
  await expect(ticket).toBeVisible();
  const ticketPage = page.url();
  await page.goBack();
  await expect(ticket).toHaveCount(0);
  await expect(page).toHaveURL(secondPage);
  await expect(opener).toBeFocused();
  await expect(rows.getByRole('listitem')).toHaveAttribute('data-deployment-id', '4301');
  await page.goForward();
  await expect(ticket).toBeVisible();
  await expect(page).toHaveURL(ticketPage);
  await page.goBack();
  await expect(ticket).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(firstPage);
  await expect(rows.getByRole('listitem')).toHaveAttribute('data-deployment-id', '4300');
  await page.goForward();
  await expect(page).toHaveURL(secondPage);
  await page.reload();
  await expect(repository).toHaveValue('43');
  await expect(search).toHaveValue(environment);
  await expect(status).toHaveValue('failed');
  await expect(rows.getByRole('listitem')).toHaveAttribute('data-deployment-id', '4301');

  const recipient = await context.newPage();
  try {
    await recipient.goto(secondPage);
    const shared = recipient.getByRole('region', name);
    await expect(shared.getByRole('listitem')).toHaveAttribute('data-deployment-id', '4301');
    await expect(shared.getByRole('searchbox', { name: '배포 환경' })).toHaveValue(environment);
    await expect(shared.getByRole('combobox', { name: '배포 상태' })).toHaveValue('failed');

    const stale = new URL(secondPage);
    const [path, query] = stale.hash.split('?');
    const parameters = new URLSearchParams(query);
    parameters.set('deploymentRepository', '99');
    stale.hash = `${path}?${parameters}`;
    await recipient.goto(stale.href);
    await expect(shared.getByRole('combobox', { name: '배포 저장소' })).toHaveValue('42');
    await expect(shared.getByRole('listitem')).toHaveAttribute('data-deployment-id', '4200');
    await expect(recipient).toHaveURL(url => {
      const current = new URLSearchParams(url.hash.split('?')[1]);
      return current.get('deploymentRepository') === '42' && !current.has('deploymentOffset');
    });
  } finally {
    await recipient.close();
  }
});

test('360px에서 선택한 저장소의 배포만 동기화하고 페이지와 최신 결과를 유지한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const firstRequested = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const firstFinished = Promise.withResolvers<void>();
  const requested: { repositoryId: number; expectedVersion: number }[] = [];
  const refreshed: { repositoryId: number; offset: number; environment: string | null }[] = [];
  let synced = false;
  let rejectSync = false;
  let shrinkHistory = false;

  await page.route(url => url.pathname === integration, async route => {
    await route.fulfill({ json: settings });
  });
  await page.route(url => url.pathname === `${integration}/deployments`, async route => {
    const query = new URL(route.request().url()).searchParams;
    const repositoryId = Number(query.get('repositoryId'));
    const offset = Number(query.get('offset'));
    if (synced) refreshed.push({ repositoryId, offset, environment: query.get('environment') });
    const data: GitlabDeploymentPage = {
      items: shrinkHistory && offset > 0 ? [] : [deployment(repositoryId, offset, synced && repositoryId === 43)],
      total: shrinkHistory ? 1 : 2, offset, limit: 1,
    };
    await route.fulfill({ json: data });
  });
  await page.route(url => url.pathname === `${integration}/deployments/sync`, async route => {
    const body = route.request().postDataJSON() as (typeof requested)[number];
    requested.push(body);
    if (body.repositoryId === 42) {
      firstRequested.resolve();
      await releaseFirst.promise;
      try { await route.fulfill({ json: readResult(body.repositoryId, 91) }); }
      catch { /* The client may already have aborted this request when changing repository. */ }
      finally { firstFinished.resolve(); }
      return;
    }
    if (rejectSync) {
      await route.fulfill({ status: 403, json: { error: 'GitLab 저장소를 읽을 권한이 없습니다.' } });
      return;
    }
    synced = true;
    await route.fulfill({ json: readResult(body.repositoryId, 8) });
  });

  try {
    await page.goto(`/#/${project.id}/development`);
    const panel = page.getByRole('region', { name: 'GitLab 배포 기록', exact: true });
    const repository = panel.getByRole('combobox', { name: '배포 저장소', exact: true });
    const synchronize = panel.getByRole('button', { name: '배포 이력 동기화', exact: true });
    const report = panel.getByRole('status', { name: '배포 이력 동기화 결과', exact: true });
    const rows = panel.getByRole('list', { name: 'GitLab 배포 목록', exact: true });
    await expect(repository).toHaveValue('42');
    await expect(rows.getByText('건너뜀', { exact: true })).toBeVisible();
    await synchronize.click();
    await firstRequested.promise;
    await expect(synchronize).toBeDisabled();

    await repository.focus();
    await repository.selectOption('43');
    await expect(repository).toBeFocused();
    await expect(synchronize).toBeEnabled();
    await panel.getByRole('searchbox', { name: '배포 환경', exact: true }).fill('43');
    await panel.getByRole('button', { name: '배포 검색', exact: true }).click();
    await panel.getByRole('button', { name: '다음 배포', exact: true }).click();
    await expect(panel.getByText('기존 43 배포 1', { exact: true })).toBeVisible();
    await expect(rows.getByText('대기 중', { exact: true })).toBeVisible();
    await synchronize.click();
    await expect(report).toContainText('배포 8건 조회 · 2건 반영 · 포함 MR 2건 반영');
    await expect(report).toContainText('배포 조회 한도에 도달했습니다.');
    await expect(report).toContainText('포함 MR을 조회하지 못한 배포 3건');
    await expect(report).toContainText('포함 MR 조회 한도에 도달한 배포 4건');
    const row = panel.getByRole('listitem').filter({ hasText: '동기화한 43 배포' });
    await expect(row).toContainText('GitLab 동기화');
    await expect(row).toContainText('포함 MR 2개');
    await expect(row).toContainText('성공');
    await expect(panel.getByText('2–2 / 2', { exact: true })).toBeVisible();

    releaseFirst.resolve();
    await firstFinished.promise;
    await expect(report).toContainText('배포 8건 조회');
    await expect(repository).toHaveValue('43');
    expect(requested).toEqual([
      { repositoryId: 42, expectedVersion: settings.version },
      { repositoryId: 43, expectedVersion: settings.version },
    ]);
    expect(refreshed).toEqual([{ repositoryId: 43, offset: 1, environment: '43' }]);

    shrinkHistory = true;
    await panel.getByRole('button', { name: '배포 새로고침', exact: true }).click();
    await expect.poll(() => refreshed.slice(1)).toEqual([
      { repositoryId: 43, offset: 1, environment: '43' },
      { repositoryId: 43, offset: 0, environment: '43' },
    ]);
    await expect(row).toHaveAttribute('data-deployment-id', '4300');
    await expect(panel.getByRole('navigation', { name: 'GitLab 배포 페이지', exact: true })).toHaveCount(0);

    rejectSync = true;
    await synchronize.click();
    await expect(panel.getByRole('alert')).toHaveText('GitLab 저장소를 읽을 권한이 없습니다.');
    await expect(row).toBeVisible();
    await expect(synchronize).toBeEnabled();
  } finally {
    releaseFirst.resolve();
  }
});
