import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { GitlabProjectWebhookReview } from '../../shared/gitlab-project-webhooks';
import type { GitlabSettings, WorkspaceSnapshot } from '../../shared/types';

const settingsPath = '/api/integrations/gitlab';
const reviewPath = `${settingsPath}/project-webhook-review`;
const registerPath = `${settingsPath}/project-webhook-register`;
const receiverPath = `${settingsPath}/webhook`;

async function readJson<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test.use({ viewport: { width: 360, height: 820 } });

test('360px에서 저장한 저장소의 웹훅을 점검하고 한 번 등록한 뒤 인증 수신과 미확인 결과를 확인한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  const { projects: [project] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const initial = await readJson<GitlabSettings>(await request.get(settingsPath));
  const baseUrl = `http://127.0.0.1:1/forge/tools/${randomUUID()}`;
  const receiverUrl = `https://teamspace-project-webhook.test${receiverPath}`;
  const readToken = `synthetic-project-hook-read-${randomUUID()}`;
  const managementToken = `synthetic-project-hook-manager-${randomUUID()}`;
  const webhookSecret = `synthetic-project-hook-secret-${randomUUID()}`;
  const saved = await readJson<GitlabSettings>(await request.patch(settingsPath, {
    data: { expectedVersion: initial.version, baseUrl, projectIds: [42, 99], token: readToken, webhookSecret },
  }));
  const calls: { action: 'review' | 'register'; body: Record<string, unknown> }[] = [];
  const reviewed = new Set<number>();
  const registered = new Set<number>();
  let pending = false;
  let reviewUnavailable = false;
  let deploymentEvents: boolean | null = true;
  const result = (repositoryId: number, state: GitlabProjectWebhookReview['state']): GitlabProjectWebhookReview => ({
    settingsVersion: saved.version,
    repositoryId,
    receiverUrl,
    authMode: 'secret',
    state,
    hooks: state === 'created' || state === 'configured' || state === 'review' ? [{
      id: repositoryId + 100, pushEvents: true, mergeRequestEvents: true, pipelineEvents: true, deploymentEvents,
      sslVerification: true, unfilteredPush: true, standardPayload: true, active: true,
    }] : [],
    ...(state === 'missing' ? { reviewId: `review-${repositoryId}` } : {}),
  });

  try {
    await page.addInitScript(() => {
      let copied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { copied = text; },
        readText: async () => copied,
      } });
    });
    await page.route(`**${settingsPath}`, route => route.request().method() === 'GET'
      ? route.fulfill({ json: { ...saved, webhookReceiverUrl: receiverUrl } })
      : route.continue());
    await page.route(`**${reviewPath}`, async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.push({ action: 'review', body });
      expect(route.request().method()).toBe('POST');
      expect(new URL(route.request().url()).search).toBe('');
      const repositoryId = Number(body.repositoryId);
      reviewed.add(repositoryId);
      if (repositoryId === 99 && pending) {
        return reviewUnavailable ? route.fulfill({ status: 502, json: {} }) : route.fulfill({ json: result(repositoryId, 'unknown') });
      }
      const existing = deploymentEvents === true ? 'configured' : 'review';
      await route.fulfill({ json: result(repositoryId, registered.has(repositoryId) ? existing : 'missing') });
    });
    await page.route(`**${registerPath}`, async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.push({ action: 'register', body });
      expect(route.request().method()).toBe('POST');
      expect(new URL(route.request().url()).search).toBe('');
      const repositoryId = Number(body.repositoryId);
      expect(reviewed.has(repositoryId)).toBe(true);
      expect(registered.has(repositoryId)).toBe(false);
      if (repositoryId === 99) {
        expect(pending).toBe(false);
        pending = true;
        return route.fulfill({ json: result(repositoryId, 'unknown') });
      }
      registered.add(repositoryId);
      await route.fulfill({ json: result(repositoryId, 'created') });
    });

    await page.goto(`/#/${project.id}/development`);
    const setup = page.getByRole('region', { name: 'GitLab 프로젝트 웹훅 설정', exact: true });
    const receipts = page.getByRole('region', { name: 'GitLab 웹훅 수신 확인', exact: true });
    const firstReceipt = receipts.getByRole('region', { name: '저장소 42', exact: true });
    const secondReceipt = receipts.getByRole('region', { name: '저장소 99', exact: true });
    const draftAddress = page.getByLabel('GitLab 주소', { exact: true });
    const draftId = page.getByLabel(/^GitLab 프로젝트 ID/);
    const draftReadToken = page.getByLabel('읽기 API 토큰', { exact: true });
    const draftSecret = page.getByLabel('웹훅 Secret Token', { exact: true });
    await expect(draftAddress).toHaveValue(baseUrl);
    await draftAddress.fill('https://unsaved-gitlab-draft.test');
    await draftId.fill('777');
    await draftReadToken.fill('unsaved-read-draft');
    await draftSecret.fill('unsaved-webhook-draft');

    const repository = setup.getByRole('combobox', { name: '웹훅 저장소', exact: true });
    const manager = setup.getByLabel('GitLab 관리 API 토큰', { exact: true });
    const credential = setup.getByLabel('웹훅 Secret Token 다시 입력', { exact: true });
    const register = setup.getByRole('button', { name: 'GitLab에 웹훅 등록', exact: true });
    const review = setup.getByRole('button', { name: '웹훅 설정 점검', exact: true });
    const recheck = setup.getByRole('button', { name: '다시 점검', exact: true });
    const width = await setup.boundingBox();
    expect(width).not.toBeNull();
    expect(width!.x).toBeGreaterThanOrEqual(0);
    expect(width!.x + width!.width).toBeLessThanOrEqual(361);
    await expect(repository.getByRole('option')).toHaveText(['저장소 42', '저장소 99']);
    await expect(repository).toHaveValue('42');
    await expect(setup.getByRole('textbox', { name: '웹훅 수신 주소', exact: true })).toHaveValue(receiverUrl);
    await setup.getByRole('button', { name: '수신 주소 복사', exact: true }).click();
    await expect(setup.getByText('수신 주소를 복사했습니다.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(receiverUrl);
    expect(calls).toEqual([]);
    await expect(firstReceipt).toContainText('인증 수신 대기');
    await expect(register).toHaveCount(0);

    await review.click();
    await expect(setup).toContainText('이 수신 주소에 등록된 웹훅이 없습니다.');
    expect(calls).toEqual([{ action: 'review', body: { expectedVersion: saved.version, repositoryId: 42 } }]);
    await expect(register).toBeDisabled();
    await expect(manager).toHaveAttribute('type', 'password');
    await expect(credential).toHaveAttribute('type', 'password');
    await manager.fill(managementToken);
    await expect(register).toBeDisabled();
    await credential.fill(webhookSecret);
    await expect(register).toBeEnabled();
    expect(calls).toHaveLength(1);
    await register.click();
    await expect(setup).toContainText('GitLab에 웹훅을 등록했습니다.');
    const checkedFlags = setup.getByRole('list', { name: '웹훅 설정', exact: true });
    await expect(checkedFlags).toContainText('SSL 검증 켜짐');
    await expect(checkedFlags).toContainText('배포 이벤트 켜짐');
    await expect(credential).toHaveCount(0);
    await expect(setup).not.toContainText(webhookSecret);
    await expect(firstReceipt).toContainText('인증 수신 대기');
    expect(calls[1]).toEqual({ action: 'register', body: {
      expectedVersion: saved.version, repositoryId: 42, reviewId: 'review-42', managementToken, webhookCredential: webhookSecret,
    } });

    const sent = await request.post(receiverPath, {
      headers: { 'X-Gitlab-Token': webhookSecret, 'webhook-id': randomUUID() },
      data: { object_kind: 'push', project_id: 42, project: { id: 42, web_url: `${baseUrl}/team/synthetic` },
        ref: 'refs/heads/synthetic-receipt', before: '0'.repeat(40), after: 'a'.repeat(40), commits: [], total_commits_count: 0 },
    });
    expect(sent.ok(), await sent.text()).toBeTruthy();
    await receipts.getByRole('button', { name: '수신 상태 새로고침', exact: true }).click();
    await expect(firstReceipt).toContainText('인증 수신 확인');
    await expect(secondReceipt).toContainText('인증 수신 대기');

    await repository.selectOption('99');
    await review.click();
    await expect(credential).toHaveValue('');
    await credential.fill(webhookSecret);
    await register.click();
    await expect(setup).toContainText('GitLab에서 웹훅 설정을 확인하지 못했습니다.');
    const manual = setup.getByRole('region', { name: 'GitLab 웹훅 수동 등록', exact: true });
    await expect(manual).toContainText('저장소 99에서 Settings → Webhooks');
    await expect(manual).toContainText('주소가 없을 때만 Add new webhook');
    await expect(manual).toContainText('Secret token에 Teamspace에 저장한 값을 입력하세요.');
    await expect(manual).toContainText('Deployment events와 SSL 검증');
    await expect(manual).not.toContainText(webhookSecret);
    await expect(register).toHaveCount(0);
    await expect(credential).toHaveCount(0);
    await expect(manager).toHaveValue(managementToken);
    await recheck.click();
    await expect(manual).toBeVisible();
    await expect(register).toHaveCount(0);
    reviewUnavailable = true;
    await recheck.click();
    await expect(setup.getByRole('alert')).toContainText('웹훅 설정을 점검하지 못했습니다.');
    await expect(manual).toBeVisible();
    pending = false;
    registered.add(99);
    await recheck.click();
    await expect(setup).toContainText('GitLab에 필요한 웹훅 설정이 등록되어 있습니다.');
    await expect(setup.getByRole('heading', { name: '웹훅 #199', exact: true })).toBeVisible();
    await expect(manual).toHaveCount(0);
    expect(calls.slice(2)).toEqual([
      { action: 'review', body: { expectedVersion: saved.version, repositoryId: 99, managementToken } },
      { action: 'register', body: { expectedVersion: saved.version, repositoryId: 99, reviewId: 'review-99', managementToken, webhookCredential: webhookSecret } },
      { action: 'review', body: { expectedVersion: saved.version, repositoryId: 99, managementToken } },
      { action: 'review', body: { expectedVersion: saved.version, repositoryId: 99, managementToken } },
      { action: 'review', body: { expectedVersion: saved.version, repositoryId: 99, managementToken } },
    ]);
    for (const [value, label] of [[false, '꺼짐'], [null, '확인 불가']] as const) {
      deploymentEvents = value;
      await recheck.click();
      await expect(checkedFlags).toContainText(`배포 이벤트 ${label}`);
      await expect(setup).toContainText('Deployment events를 켠 뒤 다시 점검하세요.');
      await expect(register).toHaveCount(0);
    }
    expect(calls.slice(-2).every(call => call.action === 'review')).toBe(true);
    await expect(secondReceipt).toContainText('인증 수신 대기');
    await expect(draftAddress).toHaveValue('https://unsaved-gitlab-draft.test');
    await expect(draftId).toHaveValue('777');
    await expect(draftReadToken).toHaveValue('unsaved-read-draft');
    await expect(draftSecret).toHaveValue('unsaved-webhook-draft');
    expect(await readJson<GitlabSettings>(await request.get(settingsPath))).toEqual(saved);
  } finally {
    const current = await readJson<GitlabSettings>(await request.get(settingsPath));
    if (current.baseUrl === baseUrl) {
      await readJson(await request.patch(settingsPath, {
        data: { expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '' },
      }));
    }
  }
});

test('등록 응답을 받지 못한 서명 웹훅의 수동 등록 안내는 저장된 인증 방식을 사용한다', async ({ page, request }) => {
  const { projects: [project] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const initial = await readJson<GitlabSettings>(await request.get(settingsPath));
  const receiverUrl = `https://teamspace-project-webhook.test${receiverPath}`;
  const repositoryId = 42;
  const settings: GitlabSettings = { ...initial, baseUrl: 'https://gitlab-signing.test', projectIds: [repositoryId],
    signingTokenConfigured: true, webhookSecretConfigured: true, webhookReceiverUrl: receiverUrl };
  const result = { settingsVersion: settings.version, receiverUrl, repositoryId, authMode: 'signature', state: 'missing',
    reviewId: 'signed-review', hooks: [] } satisfies GitlabProjectWebhookReview;
  const signingToken = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
  await page.route(`**${settingsPath}`, route => route.fulfill({ json: settings }));
  await page.route(`**${reviewPath}`, route => route.fulfill({ json: result }));
  await page.route(`**${registerPath}`, route => route.abort('connectionreset'));

  await page.goto(`/#/${project.id}/development`);
  const setup = page.getByRole('region', { name: 'GitLab 프로젝트 웹훅 설정', exact: true });
  await setup.getByRole('button', { name: '웹훅 설정 점검', exact: true }).click();
  await setup.getByLabel('GitLab 관리 API 토큰', { exact: true }).fill('synthetic-manager');
  await setup.getByLabel('웹훅 Signing Token 다시 입력', { exact: true }).fill(signingToken);
  const register = setup.getByRole('button', { name: 'GitLab에 웹훅 등록', exact: true });
  await register.click();
  const manual = setup.getByRole('region', { name: 'GitLab 웹훅 수동 등록', exact: true });
  await expect(manual).toContainText('Signing token에 Teamspace에 저장한 값을 입력하세요.');
  await expect(manual).toContainText('Generate signing token');
  await expect(manual).not.toContainText('Secret token');
  await expect(manual).not.toContainText(signingToken);
  await expect(register).toHaveCount(0);
});
