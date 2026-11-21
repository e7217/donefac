import { expect, test } from '@playwright/test';
import type { GitlabDeployment, GitlabDeploymentPage, GitlabDeploymentSyncResult, GitlabSettings, WorkspaceSnapshot } from '../../shared/types';

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

test('360px에서 선택한 저장소의 배포만 동기화하고 페이지와 최신 결과를 유지한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const firstRequested = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const firstFinished = Promise.withResolvers<void>();
  const requested: { repositoryId: number; expectedVersion: number }[] = [];
  const refreshed: { repositoryId: number; offset: number }[] = [];
  let synced = false;
  let rejectSync = false;

  await page.route(url => url.pathname === integration, async route => {
    await route.fulfill({ json: settings });
  });
  await page.route(url => url.pathname === `${integration}/deployments`, async route => {
    const query = new URL(route.request().url()).searchParams;
    const repositoryId = Number(query.get('repositoryId'));
    const offset = Number(query.get('offset'));
    if (synced) refreshed.push({ repositoryId, offset });
    const data: GitlabDeploymentPage = {
      items: [deployment(repositoryId, offset, synced && repositoryId === 43)], total: 2, offset, limit: 1,
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
    await expect(repository).toHaveValue('42');
    await expect(panel.getByText('건너뜀', { exact: true })).toBeVisible();
    await synchronize.click();
    await firstRequested.promise;
    await expect(synchronize).toBeDisabled();

    await repository.focus();
    await repository.selectOption('43');
    await expect(repository).toBeFocused();
    await expect(synchronize).toBeEnabled();
    await panel.getByRole('button', { name: '다음 배포', exact: true }).click();
    await expect(panel.getByText('기존 43 배포 1', { exact: true })).toBeVisible();
    await expect(panel.getByText('대기 중', { exact: true })).toBeVisible();
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
    expect(refreshed).toEqual([{ repositoryId: 43, offset: 1 }]);

    rejectSync = true;
    await synchronize.click();
    await expect(panel.getByRole('alert')).toHaveText('GitLab 저장소를 읽을 권한이 없습니다.');
    await expect(row).toBeVisible();
    await expect(synchronize).toBeEnabled();
  } finally {
    releaseFirst.resolve();
  }
});
