import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import type { ApiKeyCreated, ApiKeyIssuanceInput, ApiKeyRecord, WorkspaceSnapshot } from '../../shared/types';

interface KeyFixture { requests: APIRequestContext; workspace: WorkspaceSnapshot; created: { id: string; actorId: string }[]; prefix: string }
const test = base.extend<{ keys: KeyFixture }>({
  keys: [async ({ playwright, baseURL }, provide) => {
    const requests = await playwright.request.newContext({ baseURL });
    const created: KeyFixture['created'] = [];
    try {
      const workspace = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
      await provide({ requests, workspace, created, prefix: `브라우저 키 검증 ${randomUUID()}` });
    } finally {
      try {
        for (const item of created) {
          const values = await (await requests.get('/api/api-keys', { headers: { 'X-Actor-Id': item.actorId }, timeout: 5000 })).json() as ApiKeyRecord[];
          const key = values.find(value => value.id === item.id);
          if (key && !key.revokedAt) expect((await requests.post(`/api/api-keys/${item.id}/revoke`, { headers: { 'X-Actor-Id': item.actorId }, data: { expectedVersion: key.version }, timeout: 5000 })).status()).toBe(200);
        }
      } finally { await requests.dispose(); }
    }
  }, { timeout: 30_000 }],
});

test('API 키 전체 값은 한 번만 표시되고 명시적으로 닫은 뒤 실제 자동화 접근·폐기가 동작한다', async ({ page, context, keys }) => {
  const actorId = keys.workspace.users[0].id;
  await context.addInitScript(value => localStorage.setItem('teamspace.actor', value), actorId);
  await page.goto(`/#/${keys.workspace.projects[0].id}/settings`);
  await expect(page.getByRole('heading', { name: '개인 API 키', exact: true })).toBeVisible();
  await page.getByLabel('API 키 이름', { exact: true }).fill(keys.prefix);
  await page.getByLabel('API 키 만료', { exact: true }).selectOption('30');
  const response = page.waitForResponse(value => value.url().endsWith('/api/api-keys') && value.request().method() === 'POST');
  await page.getByRole('button', { name: 'API 키 발급', exact: true }).click();
  const created = await (await response).json() as ApiKeyCreated;
  keys.created.push({ id: created.key.id, actorId });
  const dialog = page.getByRole('dialog', { name: 'API 키를 복사해주세요', exact: true });
  await expect(dialog.getByLabel('발급한 API 키', { exact: true })).toHaveValue(created.token);
  expect(await page.evaluate(token => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(token)), created.token)).toBe(false);
  page.once('dialog', value => value.dismiss());
  expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
  await expect(dialog).toBeVisible();
  page.once('dialog', value => value.dismiss());
  await dialog.getByRole('button', { name: '확인하고 닫기', exact: true }).click();
  await expect(dialog).toBeVisible();
  page.once('dialog', value => value.accept());
  await dialog.getByRole('button', { name: '확인하고 닫기', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(created.token);
  const row = page.locator('.api-key-row').filter({ hasText: keys.prefix });
  await expect(row).toContainText('읽기 전용');
  const projects = await keys.requests.get('/api/v1/projects', { headers: { Authorization: `Bearer ${created.token}` } });
  expect(projects.status()).toBe(200);
  expect((await projects.json()).map((project: { id: string }) => project.id)).toEqual([keys.workspace.projects[0].id]);
  await page.getByRole('button', { name: 'API 키 목록 새로고침', exact: true }).click();
  await expect(row).toBeVisible();
  await expect(row).not.toContainText('사용 기록 없음');
  await page.locator('.api-keys-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/api-keys.png' });
  page.once('dialog', value => value.accept());
  await page.getByRole('button', { name: `${keys.prefix} API 키 폐기`, exact: true }).click();
  await expect(row).toContainText('폐기됨');
  expect((await keys.requests.get('/api/v1/projects', { headers: { Authorization: `Bearer ${created.token}` } })).status()).toBe(401);
  await page.reload();
  await expect(page.locator('.api-key-row').filter({ hasText: keys.prefix })).toContainText('폐기됨');
  await expect(page.getByLabel('발급한 API 키', { exact: true })).toHaveCount(0);
});

test('폐기 응답이 늦어져도 작업자를 바꾸면 이전 작업자의 목록으로 덮어쓰지 않는다', async ({ page, context, keys }) => {
  const [actorA, actorB] = keys.workspace.users;
  const records: ApiKeyCreated[] = [];
  for (const [index, actor] of [actorA, actorB].entries()) {
    const response = await keys.requests.post('/api/api-keys', { headers: { 'X-Actor-Id': actor.id }, data: { name: `${keys.prefix}-${index}`, access: 'read', projectIds: [keys.workspace.projects[0].id], expiresAt: null } });
    expect(response.status()).toBe(201); const value = await response.json() as ApiKeyCreated;
    records.push(value); keys.created.push({ id: value.key.id, actorId: actor.id });
  }
  await context.addInitScript(value => localStorage.setItem('teamspace.actor', value), actorA.id);
  await page.goto(`/#/${keys.workspace.projects[0].id}/settings`);
  await expect(page.locator('.api-key-row').filter({ hasText: records[0].key.name })).toBeVisible();
  let releaseResponse = () => {};
  const gate = new Promise<void>(resolve => { releaseResponse = resolve; });
  let reportHeld = () => {};
  const held = new Promise<void>(resolve => { reportHeld = resolve; });
  await page.route(`**/api/api-keys/${records[0].key.id}/revoke`, async route => {
    const response = await route.fetch(); reportHeld(); await gate; await route.fulfill({ response });
  });
  const owners: string[] = [];
  page.on('request', request => { if (request.method() === 'GET' && request.url().endsWith('/api/api-keys')) owners.push(request.headers()['x-actor-id']); });
  try {
    page.once('dialog', value => value.accept());
    await page.getByRole('button', { name: `${records[0].key.name} API 키 폐기`, exact: true }).click();
    await held;
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(actorB.id);
    await expect(page.locator('.api-key-row').filter({ hasText: records[1].key.name })).toBeVisible();
    owners.length = 0;
    const completion = page.waitForResponse(response => response.url().endsWith(`/api/api-keys/${records[0].key.id}/revoke`));
    releaseResponse(); await completion;
    await page.getByRole('button', { name: 'API 키 목록 새로고침', exact: true }).click();
    await expect(page.locator('.api-key-row').filter({ hasText: records[1].key.name })).toBeVisible();
    await expect(page.locator('.api-key-row').filter({ hasText: records[0].key.name })).toHaveCount(0);
    expect(owners.every(owner => owner === actorB.id)).toBe(true);
  } finally { releaseResponse(); }
});

test('발급과 폐기 응답을 잃어도 같은 API 키를 확인하고 새 키를 발급한다', async ({ page, context, keys }) => {
  const actorId = keys.workspace.users[0].id;
  const projectId = keys.workspace.projects[0].id;
  const name = `${keys.prefix} 복구`;
  const sent: { body: string | null; actor: string }[] = [];
  let lost: ApiKeyCreated | undefined;
  let replacement: ApiKeyCreated | undefined;
  await context.addInitScript(value => localStorage.setItem('teamspace.actor', value), actorId);
  await page.goto(`/#/${projectId}/settings`);
  const keyName = page.getByLabel('API 키 이름', { exact: true });
  const issue = page.getByRole('button', { name: 'API 키 발급', exact: true });
  const retry = page.getByRole('button', { name: '발급 결과 다시 확인', exact: true });
  const secret = page.getByLabel('발급한 API 키', { exact: true });
  const alerts = page.locator('.api-keys-settings').getByRole('alert');
  await page.route('**/api/api-keys', async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    sent.push({ body: request.postData(), actor: (await request.allHeaders())['x-actor-id'] });
    const response = await route.fetch();
    if (sent.length === 1) {
      expect(response.status()).toBe(201);
      lost = await response.json() as ApiKeyCreated;
      keys.created.push({ id: lost.key.id, actorId });
      await route.abort('failed');
      return;
    }
    if (sent.length === 2) {
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ key: lost!.key, duplicate: true });
    } else {
      expect(response.status()).toBe(201);
      replacement = await response.json() as ApiKeyCreated;
      keys.created.push({ id: replacement.key.id, actorId });
    }
    await route.fulfill({ response });
  });
  await keyName.fill(name);
  await page.getByLabel('API 키 만료', { exact: true }).selectOption('30');
  await issue.click();
  await expect(alerts).toContainText('같은 요청으로 다시 확인');
  await expect(secret).toHaveCount(0);
  expect(await page.evaluate(token => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(token)), lost!.token)).toBe(false);
  await page.reload();
  await expect(keyName).toHaveValue(name);
  await expect(keyName).toBeDisabled();
  await retry.click();
  const revoke = page.getByRole('button', { name: '이 키 폐기', exact: true });
  await expect(revoke).toBeVisible();
  await expect(page.locator('.api-key-form').getByText(`${lost!.key.prefix}…`)).toBeVisible();
  await expect(secret).toHaveCount(0);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0].actor).toBe(actorId);

  const siblingResponse = await keys.requests.post('/api/api-keys', { headers: { 'X-Actor-Id': actorId },
    data: { name, projectIds: [projectId], access: 'read', expiresAt: null } });
  const sibling = await siblingResponse.json() as ApiKeyCreated;
  keys.created.push({ id: sibling.key.id, actorId });
  const revokeBodies: unknown[] = [];
  await page.route(`**/api/api-keys/${lost!.key.id}/revoke`, async route => {
    revokeBodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (revokeBodies.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await revoke.click();
  await expect(alerts).toContainText('같은 키의 폐기를 다시 확인');
  await revoke.click();
  await expect(issue).toBeEnabled();
  const firstInput = JSON.parse(sent[0].body!) as ApiKeyIssuanceInput;
  const expectedRevoke = { expectedVersion: lost!.key.version, restoreGeneration: firstInput.restoreGeneration };
  expect(revokeBodies).toEqual([expectedRevoke, expectedRevoke]);
  await issue.click();
  await expect(secret).toBeVisible();
  await expect(secret).toHaveValue(replacement!.token);
  expect(replacement!.key.id).not.toBe(lost!.key.id);
  expect((JSON.parse(sent[2].body!) as ApiKeyIssuanceInput).requestId).not.toBe(firstInput.requestId);
  for (const [record, status] of [[lost!, 401], [sibling, 200], [replacement!, 200]] as const) {
    expect((await keys.requests.get('/api/v1/projects', { headers: { Authorization: `Bearer ${record.token}` } })).status()).toBe(status);
  }
});
