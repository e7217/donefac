import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { createApp } from '../../server/app.js';
import type { DocPage, WorkspaceSnapshot } from '../../shared/types';

interface LegacyFixture { requests: APIRequestContext; apiOrigin: string; document: DocPage; backup: Record<string, unknown> }
// Native legacy import replaces this private in-process SQLite instance only.
// The retained developer API and every other browser fixture remain untouched.
const test = base.extend<{ legacy: LegacyFixture }>({
  legacy: [async ({ playwright }, provide) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'donefac-legacy-browser-'));
    const service = createApp({ dataDir });
    const server = service.app.listen(0, '127.0.0.1');
    service.attachWebSocket(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('격리 API 주소를 확인하지 못했습니다.');
    const apiOrigin = `http://127.0.0.1:${address.port}`;
    const requests = await playwright.request.newContext({ baseURL: apiOrigin });
    try {
      const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
      const document = await (await requests.post('/api/documents', { data: { title: '격리된 이전 형식 문서', projectId: snapshot.projects[0].id, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '가져온 수동 문서 본문' }] }] } } })).json() as DocPage;
      const backup = await (await requests.get('/api/export')).json() as Record<string, unknown>;
      backup.schemaVersion = 2;
      delete backup.collabStates; delete backup.workflows; delete backup.savedViews;
      expect((await requests.post(`/api/documents/${document.id}/collaboration/enable`, { data: { expectedVersion: document.version } })).status()).toBe(200);
      await provide({ requests, apiOrigin, document, backup });
    } finally {
      await requests.dispose();
      service.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, { timeout: 30_000 }],
});

async function isolatedPage(context: BrowserContext, fixture: LegacyFixture): Promise<Page> {
  await context.addInitScript(origin => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const endpoint = new URL(url, location.href);
        if (endpoint.pathname === '/api/collaboration') {
          const target = new URL(origin);
          endpoint.host = target.host;
          endpoint.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
        }
        super(endpoint, protocols);
      }
    };
  }, fixture.apiOrigin);
  const page = await context.newPage();
  await page.route('**/api/**', async route => {
    const source = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixture.apiOrigin}${source.pathname}${source.search}` });
    await route.fulfill({ response });
  });
  await page.goto(`/#/${fixture.document.projectId}/documents/${fixture.document.id}`);
  await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
  return page;
}

test('이전 형식 가져오기로 공동 편집이 해제되면 확인 후 수동 편집으로 돌아가고 속성·댓글은 보존한다', async ({ browser, baseURL, legacy }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  try {
    const page = await isolatedPage(context, legacy);
    await page.locator('.docs-live-prose').click();
    await page.locator('.docs-live-prose').press('Control+End');
    await page.keyboard.insertText(' live-body');
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await page.getByRole('textbox', { name: '문서 제목', exact: true }).fill('아직 저장하지 않은 내 제목');
    const comment = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    await comment.fill('보내지 않은 의견도 그대로 유지합니다.');
    expect((await legacy.requests.post('/api/import', { data: { data: legacy.backup } })).status()).toBe(200);
    await expect(page.locator('.docs-collaboration-recovery')).toBeVisible();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '최신 문서 열기', exact: true }).click();
    await expect(page.locator('.docs-live-prose')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue('아직 저장하지 않은 내 제목');

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '최신 문서 열기', exact: true }).click();
    await expect(page.locator('.docs-live-prose')).toHaveCount(0);
    await expect(page.locator('.docs-prose')).toHaveText('가져온 수동 문서 본문');
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue('아직 저장하지 않은 내 제목');
    await expect(comment).toHaveValue('보내지 않은 의견도 그대로 유지합니다.');
    await expect(page.getByRole('button', { name: '공동 편집 시작', exact: true })).toBeVisible();

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '편집 버리고 최신본 열기', exact: true }).click();
    await page.locator('.docs-prose').fill('수동 편집으로 이어쓴 내용');
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    const snapshot = await (await legacy.requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(snapshot.documents.find(document => document.id === legacy.document.id)?.plainText).toBe('수동 편집으로 이어쓴 내용');
    await expect(comment).toHaveValue('보내지 않은 의견도 그대로 유지합니다.');
    expect((await (await legacy.requests.get(`/api/documents/${legacy.document.id}/collaboration`)).json()).enabled).toBe(false);
  } finally { await context.close(); }
});

test('이전 형식 가져오기 뒤 재접속·재열기에서도 오래된 오프라인 편집을 숨기거나 자동 적용하지 않는다', async ({ browser, baseURL, legacy }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  try {
    const page = await isolatedPage(context, legacy);
    await context.setOffline(true);
    await expect(page.locator('.docs-collaboration-state')).toContainText('연결 끊김');
    await page.locator('.docs-live-prose').click();
    await page.locator('.docs-live-prose').press('Control+End');
    await page.keyboard.insertText(' old-pending');
    expect((await legacy.requests.post('/api/import', { data: { data: legacy.backup } })).status()).toBe(200);
    await context.setOffline(false);
    await expect(page.locator('.docs-collaboration-recovery')).toBeVisible();
    await expect(page.locator('.docs-live-prose')).toHaveAttribute('contenteditable', 'false');
    await expect(page.locator('.docs-live-prose')).toContainText('old-pending');
    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.locator('.docs-collaboration-recovery')).toBeVisible();
    await expect(page.locator('.docs-live-prose')).toContainText('old-pending');
    await expect(page.locator('.docs-live-prose')).toHaveAttribute('contenteditable', 'false');
    const before = await (await legacy.requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(before.documents.find(document => document.id === legacy.document.id)?.plainText).toBe('가져온 수동 문서 본문');
    let copied: DocPage | undefined;
    let replayed: DocPage | undefined;
    let blockList = false;
    let trashBeforeRefresh = false;
    let archivedCopyId: string | undefined;
    await page.route('**/api/workspace', route => blockList ? route.abort('failed') : route.fallback());
    await page.route(url => url.pathname === '/api/documents' || url.pathname === `/api/documents/${legacy.document.id}/recovery-copy`, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch({ url: `${legacy.apiOrigin}${new URL(route.request().url()).pathname}` });
      expect(response.ok(), await response.text()).toBe(true);
      const copy = await response.json() as DocPage;
      if (!copied) {
        copied = copy;
        expect(response.status()).toBe(201);
        return route.abort('failed');
      }
      if (!replayed) {
        replayed = copy;
        expect(response.status()).toBe(200);
        blockList = true;
      }
      if (trashBeforeRefresh) {
        const removed = await legacy.requests.delete(`/api/documents/${copy.id}`);
        expect(removed.status(), await removed.text()).toBe(200);
        archivedCopyId = (await removed.json() as { trashEntryId: string }).trashEntryId;
        trashBeforeRefresh = false;
      }
      return route.fulfill({ response });
    });
    const copyButton = page.getByRole('button', { name: '사본으로 보관', exact: true });
    await copyButton.click();
    await expect.poll(() => copied?.id).toBeTruthy();
    await expect(copyButton).toBeEnabled();
    const original = before.documents.find(document => document.id === legacy.document.id)!;
    const rename = await legacy.requests.patch(`/api/documents/${original.id}`, {
      data: { expectedVersion: original.version, title: '동료가 이름을 바꾼 원본' },
    });
    expect(rename.status(), await rename.text()).toBe(200);
    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue('동료가 이름을 바꾼 원본');
    await copyButton.click();
    await expect.poll(() => replayed?.id).toBe(copied!.id);
    await expect(copyButton).toBeEnabled();
    await expect(page.locator('.docs-live-prose')).toContainText('old-pending');
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('donefac:collaboration-pending:')))).toBe(true);
    blockList = false;
    trashBeforeRefresh = true;
    await copyButton.click();
    await expect.poll(() => archivedCopyId).toBeTruthy();
    await expect(copyButton).toBeEnabled();
    await expect(page.locator('.docs-live-prose')).toContainText('old-pending');
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('donefac:collaboration-pending:')))).toBe(true);
    const restoredCopy = await legacy.requests.post(`/api/trash/${archivedCopyId}/restore`, { data: {} });
    expect(restoredCopy.status(), await restoredCopy.text()).toBe(200);
    await copyButton.click();
    await expect(page).toHaveURL(url => url.hash.endsWith(`/documents/${copied!.id}`));
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(`${legacy.document.title} (공동 편집 복구 사본)`);
    await expect(page.locator('.docs-live-prose')).toHaveCount(0);
    await expect(page.locator('.docs-prose')).toContainText('old-pending');
    const after = await (await legacy.requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(after.documents.find(document => document.id === legacy.document.id)?.plainText).toBe('가져온 수동 문서 본문');
    expect(after.documents.filter(document => document.id !== original.id && document.plainText.includes('old-pending')).map(document => document.id)).toEqual([copied!.id]);
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('donefac:collaboration-pending:')))).toBe(false);
  } finally { await context.close(); }
});
