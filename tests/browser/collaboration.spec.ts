import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';
import type { Editor } from '@tiptap/core';
import type { DocPage, WorkspaceSnapshot } from '../../shared/types';

interface CollaborativeFixture { document: DocPage; requests: APIRequestContext; actorIds: string[]; initialText: string }
const test = base.extend<{ collaborativeDocument: CollaborativeFixture }>({
  collaborativeDocument: [async ({ playwright, baseURL }, provide) => {
    const requests = await playwright.request.newContext({ baseURL });
    const prefix = `공동 편집 검증 ${randomUUID()}`;
    const initialText = '서버의 원본 문장';
    try {
      const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
      expect(snapshot.users.length).toBeGreaterThan(1);
      const response = await requests.post('/api/documents', { data: { projectId: snapshot.projects[0].id, title: prefix, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: initialText }] }] } } });
      expect(response.status()).toBe(201);
      const document = await response.json() as DocPage;
      await provide({ document, requests, actorIds: snapshot.users.slice(0, 2).map(user => user.id), initialText });
    } finally {
      try {
        const snapshot = await (await requests.get('/api/workspace', { timeout: 5000 })).json() as WorkspaceSnapshot;
        for (const document of snapshot.documents.filter(item => item.title.startsWith(prefix))) {
          const deletion = await requests.delete(`/api/documents/${document.id}`, { timeout: 5000 });
          expect([200, 204, 404]).toContain(deletion.status());
        }
      } finally { await requests.dispose(); }
    }
  }, { timeout: 30_000 }],
});

async function setActor(context: BrowserContext, actorId: string) {
  await context.addInitScript(value => localStorage.setItem('teamspace.actor', value), actorId);
}
async function open(page: Page, document: DocPage) {
  await page.goto(`/#/${document.projectId}/documents/${document.id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);
}
async function enable(fixture: CollaborativeFixture) {
  const response = await fixture.requests.post(`/api/documents/${fixture.document.id}/collaboration/enable`, { data: { expectedVersion: fixture.document.version } });
  expect(response.status()).toBe(200);
}
async function synced(page: Page) {
  await expect(page.locator('.docs-live-prose')).toBeVisible();
  await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
}
async function append(page: Page, value: string) {
  await page.locator('.docs-live-prose').click();
  await page.locator('.docs-live-prose').press('Control+End');
  await page.keyboard.insertText(value);
}
async function holdBodyUpdates(target: Page | BrowserContext, shouldHold = () => true) {
  await target.routeWebSocket('**/api/collaboration?*', route => {
    const server = route.connectToServer();
    route.onMessage(message => {
      if (!shouldHold() || (JSON.parse(String(message)) as { type: string }).type !== 'update') server.send(message);
    });
    server.onMessage(message => route.send(message));
  });
}
async function canonical(fixture: CollaborativeFixture) {
  const snapshot = await (await fixture.requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  return snapshot.documents.find(document => document.id === fixture.document.id)!;
}

test('두 브라우저의 실제 공동 편집이 중복 초기화 없이 합쳐지고 서버 저장 후 다시 열린다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  const contexts = await Promise.all(fixture.actorIds.map(() => browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } })));
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(a, fixture.document), open(b, fixture.document)]);
    await a.getByRole('button', { name: '공동 편집 시작', exact: true }).click();
    await Promise.all([synced(a), synced(b)]);
    await expect(a.locator('.docs-live-prose p')).toHaveCount(1);
    await expect(b.locator('.docs-live-prose p')).toHaveCount(1);
    await expect(a.locator('.docs-live-prose')).toHaveText(fixture.initialText);
    await expect(a.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    await expect(b.locator('.docs-collaboration-presence')).toContainText('2명 접속');

    await Promise.all([append(a, ' alpha'), append(b, ' beta')]);
    await expect(a.locator('.docs-live-prose')).toContainText('alpha');
    await expect(a.locator('.docs-live-prose')).toContainText('beta');
    await expect.poll(async () => (await a.locator('.docs-live-prose').innerText()) === (await b.locator('.docs-live-prose').innerText())).toBe(true);
    await Promise.all([synced(a), synced(b)]);
    const text = await a.locator('.docs-live-prose').innerText();
    expect(text.match(/alpha/g)).toHaveLength(1);
    expect(text.match(/beta/g)).toHaveLength(1);
    expect(text.match(/서버의 원본 문장/g)).toHaveLength(1);
    await expect.poll(async () => (await canonical(fixture)).plainText).toBe(text);
    await a.screenshot({ path: 'docs/screenshots/collaboration.png', fullPage: true });

    await a.reload();
    await synced(a);
    await expect(a.locator('.docs-live-prose')).toHaveText(text);
    await expect(a.locator('.docs-live-prose p')).toHaveCount(1);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('공동 편집에서 다른 사람의 커서와 선택 영역이 같은 글을 따라가고 본문에는 저장되지 않는다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  await enable(fixture);
  const [firstActor, secondActor] = fixture.actorIds;
  const contexts = await Promise.all([firstActor, secondActor].map(() => browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } })));
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(a, fixture.document), open(b, fixture.document)]);
    await Promise.all([synced(a), synced(b)]);
    await expect(b.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    const before = await canonical(fixture);
    const aEditor = a.locator('.docs-live-prose'), bEditor = b.locator('.docs-live-prose');
    const caret = b.locator(`.docs-remote-caret[data-actor-id="${firstActor}"]`);
    const selection = bEditor.locator(`.docs-remote-selection[data-actor-id="${firstActor}"]`);

    await a.bringToFront();
    await aEditor.focus();
    await a.keyboard.press('Control+Home');
    for (let index = 0; index < 4; index++) await a.keyboard.press('ArrowRight');
    await a.keyboard.press('Shift+ArrowRight');
    await a.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => a.evaluate(() => window.getSelection()?.toString())).toBe('원본');
    await expect(selection).toHaveText('원본');
    await expect(caret).toBeVisible();
    await expect(caret).toHaveAttribute('aria-hidden', 'true');
    await expect(a.locator(`.docs-remote-caret[data-actor-id="${firstActor}"]`)).toHaveCount(0);
    expect(await bEditor.innerText()).toBe(fixture.initialText);
    expect(await canonical(fixture)).toEqual(before);

    // Make a concurrent edit through the second editor without taking focus from the sender.
    await bEditor.evaluate(node => {
      const editor = (node as HTMLElement & {editor?: Editor}).editor;
      if (!editor) throw new Error('The live editor is unavailable.');
      editor.view.dispatch(editor.state.tr.insertText('앞에 덧붙임 ', 1));
    });
    const changed = `앞에 덧붙임 ${fixture.initialText}`;
    await expect(aEditor).toHaveText(changed);
    await expect(bEditor).toHaveText(changed);
    await expect(selection).toHaveText('원본');
    await synced(b);
    expect((await canonical(fixture)).version).toBe(before.version + 1);

    await a.keyboard.press('ArrowRight');
    await expect(selection).toHaveCount(0);
    await expect(caret).toHaveCount(1);
    await a.getByRole('textbox', { name: '문서 제목', exact: true }).focus();
    await expect(caret).toHaveCount(0);
    await aEditor.focus();
    await a.keyboard.press('Control+End');
    await expect(caret).toBeVisible();
    expect(await bEditor.innerText()).toBe(changed);
    await contexts[0].close();
    await expect(caret).toHaveCount(0);
    await expect(b.locator('.docs-collaboration-presence')).toContainText('1명 접속');
    const stored = await canonical(fixture);
    expect(stored.version).toBe(before.version + 1);
    expect(stored.plainText).toBe(changed);
    expect(JSON.stringify(stored.content)).not.toContain('remote-caret');
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('연결이 끊긴 동안의 편집은 같은 epoch에 재연결하면 다른 사람의 편집과 합쳐진다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  await enable(fixture);
  const contexts = await Promise.all(fixture.actorIds.map(() => browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } })));
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(a, fixture.document), open(b, fixture.document)]);
    await Promise.all([synced(a), synced(b)]);
    await contexts[1].setOffline(true);
    await expect(b.locator('.docs-collaboration-state')).toContainText('연결 끊김');
    await Promise.all([append(a, ' online'), append(b, ' offline')]);
    await synced(a);
    await expect(b.locator('.docs-collaboration-state')).toHaveText('연결 끊김 · 편집 보관 중');
    expect((await canonical(fixture)).plainText).toContain('online');
    expect((await canonical(fixture)).plainText).not.toContain('offline');

    await contexts[1].setOffline(false);
    await Promise.all([synced(a), synced(b)]);
    await expect(a.locator('.docs-live-prose')).toContainText('offline');
    await expect(b.locator('.docs-live-prose')).toContainText('online');
    await expect.poll(async () => (await a.locator('.docs-live-prose').innerText()) === (await b.locator('.docs-live-prose').innerText())).toBe(true);
    const merged = await b.locator('.docs-live-prose').innerText();
    await expect.poll(async () => (await canonical(fixture)).plainText).toBe(merged);
    await b.reload();
    await synced(b);
    await expect(b.locator('.docs-live-prose')).toHaveText(merged);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('같은 작업자의 저장된 탭을 떠나도 다른 탭의 미전송 본문이 다시 열린다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  await enable(fixture);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  try {
    await setActor(context, fixture.actorIds[0]);
    const [editing, leaving] = await Promise.all([context.newPage(), context.newPage()]);
    await holdBodyUpdates(editing);
    await Promise.all([open(editing, fixture.document), open(leaving, fixture.document)]);
    await Promise.all([synced(editing), synced(leaving)]);

    const acknowledged = '서버에서 확인한 문장';
    const pending = '아직 보내지 못한 다른 탭 문장';
    await append(leaving, ` ${acknowledged}`);
    await synced(leaving);
    await expect(editing.locator('.docs-live-prose')).toContainText(acknowledged);
    await append(editing, ` ${pending}`);
    await expect(editing.locator('.docs-collaboration-state')).toHaveText('변경 전송 중');
    expect((await canonical(fixture)).plainText).not.toContain(pending);
    await leaving.getByRole('button', { name: '간트 · 일정', exact: true }).click();
    await expect(leaving.locator('.docs-live-prose')).toHaveCount(0);
    await expect(editing.locator('.docs-live-prose')).toContainText(pending);
    await editing.close();

    const reopened = await context.newPage();
    await open(reopened, fixture.document);
    await synced(reopened);
    await expect(reopened.locator('.docs-live-prose')).toHaveText(`${fixture.initialText} ${acknowledged} ${pending}`);
    expect((await canonical(fixture)).plainText).toBe(`${fixture.initialText} ${acknowledged} ${pending}`);
  } finally { await context.close(); }
});

test('같은 작업자의 두 탭을 닫고 다시 열면 각각의 미전송 본문을 한 번씩 저장한다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  await enable(fixture);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  try {
    await setActor(context, fixture.actorIds[0]);
    let holding = true;
    await holdBodyUpdates(context, () => holding);
    const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
    await Promise.all([open(first, fixture.document), open(second, fixture.document)]);
    await Promise.all([synced(first), synced(second)]);

    const firstText = '첫 탭의 보관 문장', secondText = '둘째 탭의 보관 문장';
    for (const [page, text] of [[first, firstText], [second, secondText]] as const) {
      await append(page, ` ${text}`);
      await expect(page.locator('.docs-collaboration-state')).toHaveText('변경 전송 중');
      await expect(page.locator('.docs-live-prose')).toContainText(text);
    }
    expect((await canonical(fixture)).plainText).toBe(fixture.initialText);
    await Promise.all([first.close(), second.close()]);

    holding = false;
    const reopened = await context.newPage();
    await open(reopened, fixture.document);
    await synced(reopened);
    const content = await reopened.locator('.docs-live-prose').innerText();
    for (const text of [fixture.initialText, firstText, secondText]) expect(content.split(text)).toHaveLength(2);
    expect((await canonical(fixture)).plainText).toBe(content);
  } finally { await context.close(); }
});

test('문서 복구 뒤의 오래된 오프라인 편집은 자동 적용하지 않고 사본으로 복구한다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  await enable(fixture);
  const contexts = await Promise.all(fixture.actorIds.map(() => browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } })));
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(a, fixture.document), open(b, fixture.document)]);
    await Promise.all([synced(a), synced(b)]);
    await append(a, ' durable');
    await synced(a);
    await expect(b.locator('.docs-live-prose')).toContainText('durable');
    await contexts[1].setOffline(true);
    await expect(b.locator('.docs-collaboration-state')).toContainText('연결 끊김');
    await append(b, ' stale-offline');

    await a.getByRole('button', { name: '버전 기록', exact: true }).click();
    await a.locator('.docs-revision').filter({ hasText: '버전 1' }).click();
    a.once('dialog', dialog => dialog.accept());
    await a.getByRole('button', { name: '이 버전으로 복구', exact: true }).click();
    await synced(a);
    await expect(a.locator('.docs-live-prose')).toHaveText(fixture.initialText);
    await contexts[1].setOffline(false);
    await expect(b.locator('.docs-collaboration-recovery')).toBeVisible();
    await expect(b.locator('.docs-live-prose')).toHaveAttribute('contenteditable', 'false');
    await expect(b.locator('.docs-live-prose')).toContainText('stale-offline');
    expect((await canonical(fixture)).plainText).toBe(fixture.initialText);

    const response = b.waitForResponse(result => result.url().endsWith('/api/documents') && result.request().method() === 'POST');
    await b.getByRole('button', { name: '사본으로 보관', exact: true }).click();
    const copied = await (await response).json() as DocPage;
    expect(copied.id).not.toBe(fixture.document.id);
    expect(copied.plainText).toContain('stale-offline');
    await expect(b.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(copied.title);
    await expect(b.locator('.docs-prose')).toContainText('stale-offline');
    expect((await canonical(fixture)).plainText).toBe(fixture.initialText);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('서버에 저장되어도 실제 ACK를 받기 전에는 동기화 완료로 표시하지 않는다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  await enable(fixture);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  try {
    await setActor(context, fixture.actorIds[0]);
    const page = await context.newPage();
    const held: { route: WebSocketRoute; message: string | Buffer }[] = [];
    let holdAcks = false;
    await page.routeWebSocket('**/api/collaboration?*', route => {
      const server = route.connectToServer();
      server.onMessage(message => {
        const parsed = JSON.parse(String(message)) as { type: string };
        if (holdAcks && parsed.type === 'ack') held.push({ route, message });
        else route.send(message);
      });
    });
    await open(page, fixture.document);
    await synced(page);
    holdAcks = true;
    await append(page, ' awaiting-ack');
    await expect.poll(async () => (await canonical(fixture)).plainText.includes('awaiting-ack')).toBe(true);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(page.locator('.docs-collaboration-state')).toHaveText('변경 전송 중');
    await expect(page.locator('.docs-save-state')).not.toHaveText('동기화됨');
    holdAcks = false;
    for (const item of held) item.route.send(item.message);
    await synced(page);
  } finally { await context.close(); }
});
