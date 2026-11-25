import { expect, test, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AutomationRule, GitlabSettings, GitlabWebhookStatus, Issue, WorkspaceSnapshot } from '../../shared/types';

async function readJson<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

test('360px GitLab 설정에서 이벤트별 인증 수신을 확인하고 설정 초안과 인증 변경을 반영한다', async ({ page, request }) => {
  test.setTimeout(95_000);
  const settingsPath = '/api/integrations/gitlab';
  const statusPath = `${settingsPath}/webhook-status`;
  const webhookPath = `${settingsPath}/webhook`;
  const instanceRequests: string[] = [];
  const mock = createServer((incoming, response) => {
    instanceRequests.push(incoming.url ?? '');
    response.writeHead(404).end();
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  const secret = `synthetic-receipt-${randomUUID()}`;
  const rotatedSecret = `synthetic-rotated-receipt-${randomUUID()}`;
  const draftToken = `synthetic-read-draft-${randomUUID()}`;
  const repositoryIds = [42, 99];
  let issue: Issue | undefined;
  let rule: AutomationRule | undefined;

  const workspace = async () => readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const readSettings = async () => readJson<GitlabSettings>(await request.get(settingsPath));
  const status = async () => readJson<GitlabWebhookStatus>(await request.get(statusPath));
  const send = (data: object, deliveryId = randomUUID(), token = secret) => request.post(webhookPath, {
    data, headers: { 'X-Gitlab-Token': token, 'webhook-id': deliveryId },
  });

  try {
    const original = await readSettings();
    expect(original.baseUrl).toBe('');
    const { projects: [project], users: [actor] } = await workspace();
    issue = await readJson<Issue>(await request.post('/api/issues', {
      data: { projectId: project.id, title: `GitLab 수신 검증 ${randomUUID()}` },
    }), 201);
    const configured = await readJson<GitlabSettings>(await request.patch(settingsPath, {
      data: { expectedVersion: original.version, baseUrl, projectIds: repositoryIds, webhookSecret: secret },
    }));
    const emptyReceipts = repositoryIds.map(repositoryId => ({ repositoryId, lastDelivery: null }));
    expect(await status()).toEqual({ settingsVersion: configured.version, repositories: emptyReceipts });

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/development`);
    const panel = page.getByRole('region', { name: 'GitLab 웹훅 수신 확인', exact: true });
    const first = panel.getByRole('region', { name: '저장소 42', exact: true });
    const second = panel.getByRole('region', { name: '저장소 99', exact: true });
    const firstSummary = first.locator('summary').filter({ hasText: '이벤트별 수신' });
    const secondSummary = second.locator('summary').filter({ hasText: '이벤트별 수신' });
    const firstEvents = first.getByRole('list', { name: '이벤트별 인증 수신', exact: true });
    const secondEvents = second.getByRole('list', { name: '이벤트별 인증 수신', exact: true });
    const secondEvent = (label: string) => secondEvents.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });
    const refresh = panel.getByRole('button', { name: '수신 상태 새로고침', exact: true });
    const readToken = page.getByLabel('읽기 API 토큰', { exact: true });
    const refreshStatus = async () => {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === statusPath && response.request().method() === 'GET');
      await refresh.click();
      const response = await pending;
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as GitlabWebhookStatus;
    };
    await expect(first).toContainText('인증 수신 대기');
    await expect(second).toContainText('인증 수신 대기');
    await expect(firstSummary).toHaveText('이벤트별 수신 0/4');
    await expect(secondSummary).toHaveText('이벤트별 수신 0/4');
    await secondSummary.click();
    await expect(secondEvents.getByText('수신 대기', { exact: true })).toHaveCount(4);

    const projectUrl = `${baseUrl}/team/receipt-check`;
    const noKeyPush = {
      object_kind: 'push', project_id: 42, project: { id: 42, web_url: projectUrl, path_with_namespace: 'team/receipt-check' },
      ref: 'refs/heads/feature/receipt-check', before: '0'.repeat(40), after: 'a'.repeat(40), commits: [], total_commits_count: 0,
    };
    const pushDeliveryId = randomUUID();
    expect((await send(noKeyPush, pushDeliveryId, `invalid-${randomUUID()}`)).status()).toBe(401);
    expect(await refreshStatus()).toEqual({ settingsVersion: configured.version, repositories: emptyReceipts });
    await expect(first).toContainText('인증 수신 대기');

    const sentAt = Date.now();
    const pushResult = await readJson<{ duplicate: boolean; linked: number }>(await send(noKeyPush, pushDeliveryId));
    expect(pushResult).toMatchObject({ duplicate: false, linked: 0 });
    const pushStatus = await refreshStatus();
    const receipt = pushStatus.repositories.find(repository => repository.repositoryId === 42)?.lastDelivery;
    const receivedAt = receipt?.receivedAt ?? '';
    expect(receipt).toMatchObject({ event: 'push', authentication: 'secret-token', duplicate: false, linked: 0, automationRuns: 0 });
    expect(Date.parse(receivedAt)).toBeGreaterThanOrEqual(sentAt);
    expect(Date.parse(receivedAt)).toBeLessThanOrEqual(Date.now());
    await expect(first).toContainText('인증 수신 확인');
    await expect(first).toContainText('Push');
    await expect(first).toContainText('Secret Token');
    await expect(first.locator('time').first()).toHaveAttribute('datetime', receivedAt);
    await expect(first).toContainText('업무 연결 0건');
    await expect(second).toContainText('인증 수신 대기');
    await expect(firstSummary).toHaveText('이벤트별 수신 1/4');
    await expect(secondEvents.getByText('수신 대기', { exact: true })).toHaveCount(4);

    await readToken.fill(draftToken);
    const secondProjectUrl = `${baseUrl}/team/second`;
    const sha = 'b'.repeat(40);
    const occurredAt = new Date(Date.now() - 1_000).toISOString();
    const mr = {
      object_kind: 'merge_request', project: { id: 99 }, object_attributes: {
        id: 771, iid: 1, action: 'open', state: 'opened', title: `${issue.key} synthetic receipt`,
        source_branch: `feature/${issue.key}`, web_url: `${secondProjectUrl}/-/merge_requests/1`, updated_at: occurredAt,
      },
    };
    const mrDeliveryId = randomUUID();
    const mrResult = await readJson<{ duplicate: boolean; linked: number }>(await send(mr, mrDeliveryId));
    expect(mrResult).toMatchObject({ duplicate: false, linked: 1 });
    const mrReceipt = (await status()).repositories[1].lastDelivery;
    const pipeline = {
      object_kind: 'pipeline', project: { id: 99, web_url: secondProjectUrl }, object_attributes: {
        id: 812, iid: 2, status: 'failed', sha, ref: `feature/${issue.key}`,
        url: `${secondProjectUrl}/-/pipelines/812`, updated_at: occurredAt,
      },
    };
    expect(await readJson(await send(pipeline))).toMatchObject({ duplicate: false, linked: 1 });
    const unrelatedSha = 'c'.repeat(40);
    const deployment = {
      object_kind: 'deployment', project: { id: 99, web_url: secondProjectUrl, path_with_namespace: 'team/second' },
      deployment_id: 871, environment: 'staging', status: 'success', status_changed_at: occurredAt,
      short_sha: unrelatedSha.slice(0, 8), commit_url: `${secondProjectUrl}/-/commit/${unrelatedSha}`,
    };
    expect(await readJson(await send(deployment))).toMatchObject({ duplicate: false, deploymentUpdated: true });
    expect(await readJson(await send(mr, mrDeliveryId))).toMatchObject({ duplicate: true, linked: 0 });
    const duplicate = await readJson<{ duplicate: boolean; linked: number }>(await send(noKeyPush, pushDeliveryId));
    expect(duplicate).toMatchObject({ duplicate: true, linked: 0 });
    const both = await refreshStatus();
    expect(both.repositories).toMatchObject([
      { repositoryId: 42, lastDelivery: { event: 'push', duplicate: true, linked: 0 }, lastAcceptedByEvent: { push: receipt } },
      { repositoryId: 99, lastDelivery: { event: 'merge_request', duplicate: true, linked: 0 }, lastAcceptedByEvent: {
        merge_request: mrReceipt, pipeline: { event: 'pipeline', duplicate: false, linked: 1 },
        deployment: { event: 'deployment', duplicate: false, deploymentUpdated: true },
      } },
    ]);
    expect(Object.keys(both.repositories[0].lastAcceptedByEvent ?? {})).toEqual(['push']);
    expect(Object.keys(both.repositories[1].lastAcceptedByEvent ?? {}).sort()).toEqual(['deployment', 'merge_request', 'pipeline']);
    await expect(first).toContainText('중복 전송');
    await expect(second).toContainText('중복 전송');
    await expect(firstSummary).toHaveText('이벤트별 수신 1/4');
    await expect(secondSummary).toHaveText('이벤트별 수신 3/4');
    await expect(secondEvent('Merge Request')).toContainText('업무 연결 1건');
    await expect(secondEvent('Merge Request')).toContainText('자동화 기록 0건');
    await expect(secondEvent('Merge Request')).toContainText('상태 자동화 · Merge Request 열림');
    await expect(secondEvent('Merge Request')).toContainText('대상 티켓 1건 · 활성 규칙 범위 없음 1건');
    await expect(secondEvent('Merge Request').locator('time').first()).toHaveAttribute('datetime', mrReceipt?.receivedAt ?? '');
    await expect(secondEvent('Pipeline')).toContainText('업무 연결 1건');
    await expect(secondEvent('Pipeline')).toContainText('상태 자동화 · 파이프라인 실패');
    await expect(secondEvent('배포 이벤트')).toContainText('배포 기록 반영');
    await expect(secondEvent('배포 이벤트')).toContainText('대상 티켓 0건 · 확인된 자동화 대상 티켓이 없습니다.');
    await expect(secondEvent('Push')).toContainText('수신 대기');
    await firstSummary.click();
    await expect(firstEvents.getByText('수신 대기', { exact: true })).toHaveCount(3);
    await expect(readToken).toHaveValue(draftToken);
    expect(await readSettings()).toEqual(configured);
    const links = (await workspace()).gitlabLinks.filter(link => link.issueId === issue?.id);
    expect(links).toHaveLength(2);
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'merge_request', projectId: 99, iid: 1 }),
      expect.objectContaining({ kind: 'pipeline', projectId: 99, state: 'failed' }),
    ]));

    rule = await readJson<AutomationRule>(await request.post('/api/automation-rules', { data: {
      projectId: project.id, name: `수신 결과 ${randomUUID()}`, trigger: 'merge_request.merged', enabled: false,
      gitlabProjectIds: [99], branchPattern: 'feature/*', issueTypes: [], fromStatuses: ['todo'], toStatusId: 'done', actorId: actor.id, priority: 100,
    } }), 201);
    rule = await readJson<AutomationRule>(await request.patch(`/api/automation-rules/${rule.id}`, {
      data: { ...rule, expectedVersion: rule.version, enabled: true },
    }));
    const merged = { ...mr, object_attributes: { ...mr.object_attributes, action: 'merge', state: 'merged', updated_at: new Date().toISOString() } };
    expect(await readJson(await send(merged))).toMatchObject({ linked: 1, runs: [expect.objectContaining({ issueId: issue.id, outcome: 'changed' })] });
    await refreshStatus();
    await expect(secondEvent('Merge Request')).toContainText('대상 티켓 1건 · 상태 변경 1건');
    expect((await workspace()).issues.find(item => item.id === issue?.id)?.status).toBe('done');

    const older = { ...merged, object_attributes: { ...merged.object_attributes, updated_at: occurredAt } };
    expect(await readJson(await send(older))).toMatchObject({ linked: 0, runs: [expect.objectContaining({ issueId: issue.id, outcome: 'ignored' })] });
    const latest = await refreshStatus();
    await expect(secondEvent('Merge Request')).toContainText('대상 티켓 1건 · 적용 보류 1건');
    await expect(secondEvent('Merge Request')).toContainText('최신 수신 이벤트보다 오래된 이벤트입니다.');
    await expect(readToken).toHaveValue(draftToken);

    const remote = await readJson<GitlabSettings>(await request.patch(settingsPath, {
      data: { expectedVersion: configured.version, token: `other-actor-read-token-${randomUUID()}` },
    }));
    expect(await refreshStatus()).toEqual({ ...latest, settingsVersion: remote.version });
    await expect(panel.getByRole('alert')).toContainText('연결 설정이 변경되었습니다');
    await expect(first).toHaveCount(0);
    await expect(readToken).toHaveValue(draftToken);
    await readToken.fill('');
    await page.getByRole('button', { name: '최신 설정', exact: true }).click();
    await expect(first).toContainText('중복 전송');
    await page.getByLabel('웹훅 Secret Token', { exact: true }).fill(rotatedSecret);
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === settingsPath && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: '연결 설정 저장', exact: true }).click();
    const saved = await saving;
    expect(saved.ok(), await saved.text()).toBe(true);
    const rotated = await saved.json() as GitlabSettings;
    expect(rotated.version).toBe(remote.version + 1);
    await expect(first).toContainText('인증 수신 대기');
    await expect(second).toContainText('인증 수신 대기');
    await expect(firstSummary).toHaveText('이벤트별 수신 0/4');
    await expect(secondSummary).toHaveText('이벤트별 수신 0/4');
    await secondSummary.click();
    await expect(secondEvents.getByText('수신 대기', { exact: true })).toHaveCount(4);
    expect((await send(noKeyPush)).status()).toBe(401);
    expect(await status()).toEqual({ settingsVersion: rotated.version, repositories: emptyReceipts });
    expect(instanceRequests).toEqual([]);
  } finally {
    try {
      if (rule) await request.delete(`/api/automation-rules/${rule.id}?expectedVersion=${rule.version}`);
      if (issue) await request.delete(`/api/issues/${issue.id}`);
      const current = await readSettings();
      if (current.baseUrl === baseUrl) {
        await readJson(await request.patch(settingsPath, {
          data: { expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '' },
        }));
      }
    } finally {
      await new Promise<void>(resolve => mock.close(() => resolve()));
    }
  }
});
