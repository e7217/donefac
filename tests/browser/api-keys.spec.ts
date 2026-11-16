import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import type { ApiKeyCreated, ApiKeyRecord, WorkspaceSnapshot } from '../../shared/types';

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
