import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test as base, expect, type APIRequestContext, type Dialog, type Page } from '@playwright/test';
import type { AutomationRule, GitlabSettings, WebhookEndpoint, WebhookEndpointCreated, WorkspaceSnapshot } from '../../shared/types';

type Fixture = { requests: APIRequestContext; data: WorkspaceSnapshot; prefix: string; baseUrl: string };
const test = base.extend<{ fixture: Fixture }>({ fixture: [async ({ playwright, baseURL }, provide) => {
  const requests = await playwright.request.newContext({ baseURL }), prefix = `개발 설정 충돌 합성 ${randomUUID()}`;
  const mock = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); });
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address(); if (!address || typeof address === 'string') throw new Error('합성 수신 서버를 열지 못했습니다.');
  const mockBase = `http://127.0.0.1:${address.port}`;
  const original = await (await requests.get('/api/integrations/gitlab')).json() as GitlabSettings;
  let configured = false;
  try {
    expect(original.tokenConfigured || original.webhookSecretConfigured || original.signingTokenConfigured).toBe(false);
    const response = await requests.patch('/api/integrations/gitlab', { data: { expectedVersion: original.version, baseUrl: mockBase, projectIds: [42], webhookSecret: `synthetic-${randomUUID()}` } }); expect(response.ok()).toBeTruthy(); configured = true;
    const data = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    await provide({ requests, data, prefix, baseUrl: mockBase });
  } finally {
    try {
      const rules = await (await requests.get('/api/automation-rules')).json() as AutomationRule[]; for (const rule of rules.filter(value => value.name.startsWith(prefix))) expect((await requests.delete(`/api/automation-rules/${rule.id}?expectedVersion=${rule.version}`)).ok()).toBeTruthy();
      const endpoints = await (await requests.get('/api/webhook-endpoints')).json() as WebhookEndpoint[]; for (const endpoint of endpoints.filter(value => value.name.startsWith(prefix))) expect((await requests.delete(`/api/webhook-endpoints/${endpoint.id}?expectedVersion=${endpoint.version}`)).ok()).toBeTruthy();
      if (configured) { const current = await (await requests.get('/api/integrations/gitlab')).json() as GitlabSettings; expect((await requests.patch('/api/integrations/gitlab', { data: { expectedVersion: current.version, baseUrl: original.baseUrl, projectIds: original.projectIds, token: '', webhookSecret: '', signingToken: '' } })).ok()).toBeTruthy(); }
    } finally { await requests.dispose(); mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve())); }
  }
}, { timeout: 30_000 }] });

async function decisions(page: Page, choices: boolean[], action: () => Promise<unknown>) { const messages: string[] = []; const handle = async (dialog: Dialog) => { const accepted = choices[messages.length] ?? false; messages.push(dialog.message()); if (accepted) await dialog.accept(); else await dialog.dismiss(); }; page.on('dialog', handle); try { await action(); } finally { page.off('dialog', handle); } expect(messages).toHaveLength(choices.length); return messages; }

test('GitLab 연결409는 주소와 토큰 초안을 보존하며 명시적 최신 설정 후 새 버전으로 저장한다', async ({ page, fixture }) => {
  const { requests, data, baseUrl } = fixture;
  await page.goto(`/#/${data.projects[0].id}/development`);
  const form = page.locator('.integration-form'), url = form.getByLabel('GitLab 주소', { exact: true }), token = form.getByLabel('읽기 API 토큰', { exact: true });
  await expect(url).toHaveValue(baseUrl); await url.fill(`${baseUrl}/draft`); await token.fill('synthetic-unsaved-read-token');
  const current = await (await requests.get('/api/integrations/gitlab')).json() as GitlabSettings;
  expect((await requests.patch('/api/integrations/gitlab', { data: { expectedVersion: current.version, baseUrl: `${baseUrl}/remote` } })).ok()).toBeTruthy();
  const rejected = page.waitForResponse(value => value.url().endsWith('/api/integrations/gitlab') && value.request().method() === 'PATCH');
  await form.getByRole('button', { name: '연결 설정 저장', exact: true }).click(); const response = await rejected; expect(response.status()).toBe(409); expect(response.request().postDataJSON().expectedVersion).toBe(current.version);
  await expect(url).toHaveValue(`${baseUrl}/draft`); await expect(token).toHaveValue('synthetic-unsaved-read-token');
  await decisions(page, [true], () => form.getByRole('button', { name: '최신 설정', exact: true }).click()); await expect(url).toHaveValue(`${baseUrl}/remote`); await expect(token).toHaveValue(''); await expect(url).toBeEnabled();
  await url.fill(baseUrl); await form.getByRole('button', { name: '연결 설정 저장', exact: true }).click(); await expect(form.getByRole('button', { name: '연결 설정 저장', exact: true })).toBeDisabled();
  const saved = await (await requests.get('/api/integrations/gitlab')).json() as GitlabSettings; expect(saved.baseUrl).toBe(baseUrl); expect(saved.tokenConfigured).toBe(false); expect(saved.version).toBeGreaterThan(current.version);
});

test('자동화·웹훅 입력은409와 복합 탐색 취소에서 유지되고 최신 규칙 및 저장 대기는 안전하게 처리된다', async ({ page, fixture }) => {
  const { requests, data, prefix, baseUrl } = fixture, project = data.projects[0];
  const createdRule = await requests.post('/api/automation-rules', { data: { projectId: project.id, name: `${prefix} 규칙`, enabled: false, trigger: 'merge_request.merged', gitlabProjectIds: [42], branchPattern: '*', issueTypes: [], fromStatuses: ['todo'], toStatusId: 'done', actorId: data.users[0].id, priority: 10 } }); expect(createdRule.ok()).toBeTruthy(); const rule = await createdRule.json() as AutomationRule;
  const createdEndpoint = await requests.post('/api/webhook-endpoints', { data: { name: `${prefix} 수신처`, url: `${baseUrl}/events`, projectIds: [project.id], eventTypes: ['issue.updated'], enabled: false } }); expect(createdEndpoint.ok()).toBeTruthy(); const endpoint = (await createdEndpoint.json() as WebhookEndpointCreated).endpoint;
  let release: () => void = () => undefined;
  try {
    await page.goto(`/#/${project.id}/development`);
    const automation = page.getByRole('region', { name: 'GitLab 상태 자동화 설정', exact: true }), webhooks = page.getByRole('region', { name: '외부 웹훅 설정', exact: true });
    await automation.locator('.automation-rule-card').filter({ hasText: rule.name }).click(); await webhooks.locator('.webhook-endpoint-card').filter({ hasText: endpoint.name }).click();
    const ruleEditor = page.getByRole('region', { name: '자동화 규칙 편집', exact: true }), endpointEditor = page.getByRole('region', { name: '웹훅 엔드포인트 편집', exact: true });
    const ruleName = ruleEditor.getByLabel('자동화 규칙 이름', { exact: true }), endpointName = endpointEditor.getByLabel('웹훅 엔드포인트 이름', { exact: true });
    await ruleName.fill(`${prefix} 보존할 규칙`); await endpointName.fill(`${prefix} 보존할 수신처`);
    expect((await requests.patch(`/api/automation-rules/${rule.id}`, { data: { expectedVersion: rule.version, name: `${prefix} 서버 규칙` } })).ok()).toBeTruthy();
    expect((await requests.patch(`/api/webhook-endpoints/${endpoint.id}`, { data: { expectedVersion: endpoint.version, name: `${prefix} 서버 수신처` } })).ok()).toBeTruthy();
    await automation.getByRole('button', { name: '자동화 설정 새로고침', exact: true }).click(); await webhooks.getByRole('button', { name: '외부 웹훅 새로고침', exact: true }).click();
    await expect(ruleName).toHaveValue(`${prefix} 보존할 규칙`); await expect(endpointName).toHaveValue(`${prefix} 보존할 수신처`);
    const ruleConflict = page.waitForResponse(value => value.url().endsWith(`/automation-rules/${rule.id}`) && value.request().method() === 'PATCH'); await ruleEditor.getByRole('button', { name: '규칙 저장', exact: true }).click(); expect((await ruleConflict).status()).toBe(409); await expect(ruleName).toHaveValue(`${prefix} 보존할 규칙`);
    const endpointConflict = page.waitForResponse(value => value.url().endsWith(`/webhook-endpoints/${endpoint.id}`) && value.request().method() === 'PATCH'); await endpointEditor.getByRole('button', { name: '엔드포인트 저장', exact: true }).click(); expect((await endpointConflict).status()).toBe(409); await expect(endpointName).toHaveValue(`${prefix} 보존할 수신처`);
    await decisions(page, [true], () => ruleEditor.getByRole('button', { name: '최신 규칙', exact: true }).click()); await expect(ruleName).toBeEnabled(); await expect(ruleName).toHaveValue(`${prefix} 서버 규칙`); await expect(automation.locator('.automation-rule-card').filter({ hasText: `${prefix} 서버 규칙` })).toBeVisible();
    await decisions(page, [true], () => endpointEditor.getByRole('button', { name: '최신 엔드포인트', exact: true }).click()); await expect(endpointName).toBeEnabled(); await expect(endpointName).toHaveValue(`${prefix} 서버 수신처`);
    let reached: () => void = () => undefined; const gate = new Promise<void>(resolve => { release = resolve; }), intercepted = new Promise<void>(resolve => { reached = resolve; });
    await page.route(`**/api/automation-rules/${rule.id}`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
    await ruleName.fill(`${prefix} 지연 저장 규칙`); await ruleEditor.getByRole('button', { name: '규칙 저장', exact: true }).click(); await intercepted; await expect(ruleName).toBeDisabled();
    const actor = page.getByLabel('작업자 선택', { exact: true }), previousActor = await actor.inputValue(), nextActor = data.users.find(value => value.id !== previousActor)!;
    const prompts: string[] = []; const unexpected = (dialog: Dialog) => { prompts.push(dialog.message()); void dialog.dismiss(); }; page.on('dialog', unexpected); await actor.selectOption(nextActor.id); page.off('dialog', unexpected); expect(prompts).toHaveLength(0); await expect(actor).toHaveValue(previousActor); expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
    release(); await expect(ruleName).toBeEnabled(); await expect(ruleEditor.getByRole('button', { name: '규칙 저장', exact: true })).toBeDisabled(); await expect(ruleName).toHaveValue(`${prefix} 지연 저장 규칙`);
    await ruleName.fill(`${prefix} 취소할 때 보존할 규칙`); await endpointName.fill(`${prefix} 취소할 때 보존할 수신처`);
    const originalUrl = page.url(); const confirmations = await decisions(page, [true, false], () => actor.selectOption(nextActor.id)); expect(confirmations.some(value => value.includes('자동화'))).toBe(true); expect(confirmations.some(value => value.includes('웹훅'))).toBe(true);
    await expect(actor).toHaveValue(previousActor); await expect(page).toHaveURL(originalUrl); await expect(ruleName).toHaveValue(`${prefix} 취소할 때 보존할 규칙`); await expect(endpointName).toHaveValue(`${prefix} 취소할 때 보존할 수신처`);
    await decisions(page, [true, true], () => actor.selectOption(nextActor.id)); await expect(actor).toHaveValue(nextActor.id); await expect(ruleEditor).toHaveCount(0); await expect(endpointEditor).toHaveCount(0);
  } finally { release(); await page.unroute(`**/api/automation-rules/${rule.id}`); }
});
