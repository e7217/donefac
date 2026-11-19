import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import type { Issue, Project, WebhookDelivery, WebhookEndpoint, WebhookEndpointCreated, WebhookEnvelope, WorkspaceSnapshot } from '../../shared/types';

interface ReceivedWebhook { method: string | undefined; headers: IncomingHttpHeaders; body: string }
interface OutboundFixture {
  request: APIRequestContext; workspace: WorkspaceSnapshot; project: Project;
  prefix: string; receiverUrl: string; received: ReceivedWebhook[];
}
const test = base.extend<{ outbound: OutboundFixture }>({
  outbound: [async ({ playwright, baseURL }, provide) => {
    const request = await playwright.request.newContext({ baseURL });
    const prefix = `웹훅 화면 검증 ${randomUUID()}`, received: ReceivedWebhook[] = [];
    const receiver = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        received.push({ method: incoming.method, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(204); response.end();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', resolve); });
      const address = receiver.address(); if (!address || typeof address === 'string') throw new Error('로컬 합성 웹훅 수신처 포트를 확인하지 못했습니다.');
      const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
      const response = await request.post('/api/projects', { data: { key: `WH${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`, name: prefix, description: '격리된 브라우저 검증용 합성 프로젝트', color: '#5879ed' } });
      expect(response.status()).toBe(201); const project = await response.json() as Project;
      await provide({ request, workspace, project, prefix, receiverUrl: `http://127.0.0.1:${address.port}/synthetic-webhooks`, received });
    } finally {
      try {
        const endpointResponse = await request.get('/api/webhook-endpoints', { timeout: 5000 });
        if (endpointResponse.ok()) for (const endpoint of await endpointResponse.json() as WebhookEndpoint[]) {
          if (endpoint.name.startsWith(prefix)) expect((await request.delete(`/api/webhook-endpoints/${endpoint.id}?expectedVersion=${endpoint.version}`, { timeout: 5000 })).status()).toBe(200);
        }
        const response = await request.get('/api/workspace', { timeout: 5000 });
        if (response.ok()) for (const issue of (await response.json() as WorkspaceSnapshot).issues) {
          if (issue.title.startsWith(prefix)) expect((await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`, { timeout: 5000 })).status()).toBe(200);
        }
      } finally {
        receiver.closeAllConnections();
        await new Promise<void>(resolve => receiver.close(() => resolve()));
        await request.dispose();
      }
    }
  }, { timeout: 30_000 }],
});

test('한 번 발급한 웹훅 키를 확인하고 활성화하면 실제 서명 전송·이력·최신 키 교체가 동작한다', async ({ page, context, outbound: f }) => {
  test.setTimeout(60_000);
  const actorId = f.workspace.users[0].id;
  await context.addInitScript(value => localStorage.setItem('teamspace.actor', value), actorId);
  await page.goto(`/#/${f.project.id}/development`);
  const settings = page.getByRole('region', { name: '외부 웹훅 설정', exact: true });
  await settings.getByRole('button', { name: '엔드포인트 만들기', exact: true }).click();
  const editor = settings.getByRole('region', { name: '웹훅 엔드포인트 편집', exact: true });
  await editor.getByLabel('웹훅 엔드포인트 이름', { exact: true }).fill(f.prefix);
  await editor.getByLabel('웹훅 수신 URL', { exact: true }).fill(f.receiverUrl);
  await editor.getByLabel('업무 생성 웹훅 이벤트', { exact: true }).check();
  await expect(editor.getByLabel('웹훅 엔드포인트 활성화', { exact: true })).toBeDisabled();
  await expect(editor.getByLabel('웹훅 엔드포인트 활성화', { exact: true })).not.toBeChecked();
  const creation = page.waitForResponse(response => response.url().endsWith('/api/webhook-endpoints') && response.request().method() === 'POST');
  await editor.getByRole('button', { name: '엔드포인트 저장', exact: true }).click();
  const creationResponse = await creation; expect(creationResponse.status()).toBe(201);
  const created = await creationResponse.json() as WebhookEndpointCreated;
  expect(created.endpoint.enabled).toBe(false); expect(created.endpoint.projectIds).toEqual([f.project.id]);
  const dialog = page.getByRole('dialog', { name: '웹훅 서명 키를 복사해 주세요', exact: true });
  const secretInput = dialog.getByLabel('발급한 웹훅 서명 키', { exact: true });
  await expect(secretInput).toHaveAttribute('type', 'password');
  expect(await secretInput.inputValue() === created.secret).toBe(true);
  expect(await page.evaluate(secret => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(secret)), created.secret)).toBe(false);
  page.once('dialog', value => value.dismiss());
  expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
  await expect(dialog).toBeVisible();
  page.once('dialog', value => value.dismiss());
  await dialog.getByRole('button', { name: '확인하고 닫기', exact: true }).click();
  await expect(dialog).toBeVisible();
  page.once('dialog', value => value.accept());
  await dialog.getByRole('button', { name: '확인하고 닫기', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await page.locator('body').textContent())?.includes(created.secret)).toBe(false);

  const createIssue = async (suffix: string) => {
    const response = await f.request.post('/api/issues', { headers: { 'X-Actor-Id': actorId }, data: { projectId: f.project.id, title: `${f.prefix} ${suffix}`, description: 'PRIVATE_BODY_NOT_IN_WEBHOOK' } });
    expect(response.status()).toBe(201); return await response.json() as Issue;
  };
  await createIssue('비활성 중 생성');
  expect(await (await f.request.get(`/api/webhook-deliveries?endpointId=${created.endpoint.id}`)).json()).toEqual([]);
  expect(f.received).toHaveLength(0);
  await editor.getByLabel('웹훅 엔드포인트 활성화', { exact: true }).check();
  const activation = page.waitForResponse(response => response.url().endsWith(`/api/webhook-endpoints/${created.endpoint.id}`) && response.request().method() === 'PATCH');
  await editor.getByRole('button', { name: '엔드포인트 저장', exact: true }).click();
  expect((await activation).status()).toBe(200);
  await expect(settings.locator('.webhook-endpoint-card').filter({ hasText: f.prefix }).getByText('활성', { exact: true })).toBeVisible();
  const issue = await createIssue('활성 후 생성');
  await expect.poll(() => f.received.length).toBe(1);
  const received = f.received[0], envelope = JSON.parse(received.body) as WebhookEnvelope;
  expect(received.method).toBe('POST'); expect(received.headers['content-type']).toBe('application/json');
  expect(envelope).toMatchObject({ type: 'issue.created', actorId, origin: 'user', projectId: f.project.id, resource: { id: issue.id, key: issue.key, title: issue.title } });
  expect(received.body.includes('PRIVATE_BODY_NOT_IN_WEBHOOK')).toBe(false);
  expect(received.body.includes(created.secret)).toBe(false);
  expect(received.headers['webhook-id']).toBe(envelope.id);
  const timestamp = received.headers['webhook-timestamp']; expect(typeof timestamp).toBe('string');
  expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(60);
  const signature = createHmac('sha256', Buffer.from(created.secret.slice('whsec_'.length), 'base64')).update(`${envelope.id}.${timestamp}.${received.body}`).digest('base64');
  expect(received.headers['webhook-signature']).toBe(`v1,${signature}`);
  let deliveries: WebhookDelivery[] = [];
  await expect.poll(async () => {
    deliveries = await (await f.request.get(`/api/webhook-deliveries?endpointId=${created.endpoint.id}`)).json() as WebhookDelivery[];
    return deliveries.find(value => value.eventId === envelope.id)?.status;
  }).toBe('succeeded');
  expect(deliveries).toHaveLength(1); expect(deliveries[0]).toMatchObject({ attempts: 1, httpStatus: 204, resourceId: issue.id });
  await settings.getByRole('button', { name: '외부 웹훅 새로고침', exact: true }).click();
  const row = settings.getByRole('region', { name: '웹훅 전송 기록', exact: true }).locator('tbody tr');
  await expect(row).toHaveCount(1); await expect(row).toContainText('업무 생성'); await expect(row).toContainText('전송 완료'); await expect(row).toContainText('HTTP 204');
  await expect(row.getByRole('button', { name: '재시도', exact: true })).toBeDisabled();
  await row.getByRole('button', { name: '상세', exact: true }).click();
  const detail = settings.getByRole('region', { name: '웹훅 전송 상세', exact: true });
  await expect(detail).toContainText(envelope.id); await expect(detail).toContainText(issue.key); await expect(detail).toContainText(issue.title);
  await detail.getByText('전송 JSON', { exact: true }).click();
  expect(JSON.parse(await detail.locator('pre').innerText())).toEqual(envelope);

  // Explicit reload must update the parent collection too, so rotation uses the current CAS version.
  const endpoints = await (await f.request.get('/api/webhook-endpoints')).json() as WebhookEndpoint[];
  const latest = endpoints.find(value => value.id === created.endpoint.id)!;
  expect(JSON.stringify(endpoints).includes(created.secret)).toBe(false);
  const renamed = `${f.prefix} 최신 이름`;
  expect((await f.request.patch(`/api/webhook-endpoints/${latest.id}`, { data: { expectedVersion: latest.version, name: renamed } })).status()).toBe(200);
  await editor.getByRole('button', { name: '최신 엔드포인트', exact: true }).click();
  await expect(editor.getByLabel('웹훅 엔드포인트 이름', { exact: true })).toHaveValue(renamed);
  const rotation = page.waitForResponse(response => response.url().endsWith(`/api/webhook-endpoints/${latest.id}/rotate-secret`) && response.request().method() === 'POST');
  page.once('dialog', value => value.accept());
  await editor.getByRole('button', { name: '서명 키 교체', exact: true }).click();
  const rotationResponse = await rotation; expect(rotationResponse.status()).toBe(200);
  const rotated = await rotationResponse.json() as WebhookEndpointCreated;
  expect(rotated.secret === created.secret).toBe(false);
  await expect(secretInput).toHaveAttribute('type', 'password');
  expect(await secretInput.inputValue() === rotated.secret).toBe(true);
  page.once('dialog', value => value.accept());
  await dialog.getByRole('button', { name: '확인하고 닫기', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settings.screenshot({ path: 'docs/screenshots/integrations.png' });
  await page.reload();
  await expect(settings.locator('.webhook-endpoint-card').filter({ hasText: renamed })).toBeVisible();
  await expect(page.getByLabel('발급한 웹훅 서명 키', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(secrets => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => secrets.some(secret => value.includes(secret))), [created.secret, rotated.secret])).toBe(false);
});
