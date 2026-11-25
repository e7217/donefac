import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type BrowserContext, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
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

test('360px 공동 편집에서 내 변경만 실행 취소하고 다시 실행한다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  await enable(fixture);
  const contexts = await Promise.all(fixture.actorIds.map(() => browser.newContext({ baseURL, viewport: { width: 360, height: 820 } })));
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [author, peer] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(author, fixture.document), open(peer, fixture.document)]);
    await Promise.all([synced(author), synced(peer)]);
    const toolbarButton = (page: Page, name: string) => page.getByRole('toolbar', { name: '문서 서식' }).getByRole('button', { name, exact: true });
    const undo = toolbarButton(author, '실행 취소');
    const redo = toolbarButton(author, '다시 실행');
    const peerUndo = toolbarButton(peer, '실행 취소');
    const body = author.locator('.docs-live-prose');
    const peerBody = peer.locator('.docs-live-prose');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();

    const myText = ' 내가 쓴 글';
    const peerText = ' 동료가 쓴 글';
    await body.press('Control+End');
    await author.keyboard.insertText(myText);
    await expect(peerBody).toHaveText(fixture.initialText + myText);
    await expect(undo).toBeEnabled();
    await expect(peerUndo).toBeDisabled();
    await peerBody.press('Control+End');
    await peer.keyboard.insertText(peerText);
    await expect(body).toHaveText(fixture.initialText + myText + peerText);

    await undo.press('Enter');
    const peerOnly = fixture.initialText + peerText;
    await expect(body).toHaveText(peerOnly);
    await expect(peerBody).toHaveText(peerOnly);
    await expect(body).toBeFocused();
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();
    await expect(peerUndo).toBeEnabled();
    await expect.poll(async () => (await canonical(fixture)).plainText).toBe(peerOnly);

    await redo.click();
    const both = fixture.initialText + myText + peerText;
    await expect(body).toHaveText(both);
    await expect(peerBody).toHaveText(both);
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await expect.poll(async () => (await canonical(fixture)).plainText).toBe(both);
    await author.reload();
    await synced(author);
    await expect(body).toHaveText(both);
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('공동 편집에서 링크 입력 중 동료가 선택 양쪽에 글을 추가해도 원래 선택에만 링크를 적용한다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  await enable(fixture);
  const contexts = await Promise.all(fixture.actorIds.map(() => browser.newContext({ baseURL, viewport: { width: 360, height: 820 } })));
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [author, peer] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(author, fixture.document), open(peer, fixture.document)]);
    await Promise.all([synced(author), synced(peer)]);
    await expect(author.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    const editor = author.locator('.docs-live-prose');
    await editor.click();
    await editor.press('Control+Home');
    await author.keyboard.press('Shift+End');
    await expect.poll(() => author.evaluate(() => window.getSelection()?.toString())).toBe(fixture.initialText);
    await author.getByRole('toolbar', { name: '문서 서식' }).getByRole('button', { name: '링크', exact: true }).click();
    const href = 'https://example.test/guide';
    const url = author.getByRole('textbox', { name: '링크 URL', exact: true });
    await url.fill(href);

    const peerEditor = peer.locator('.docs-live-prose');
    await peerEditor.click();
    await peerEditor.press('Control+Home');
    const prefix = '동료가 추가한 글 ';
    await peer.keyboard.insertText(prefix);
    await peerEditor.press('Control+End');
    const suffix = ' 뒤에 붙인 글';
    await peer.keyboard.insertText(suffix);
    await expect(editor).toHaveText(prefix + fixture.initialText + suffix);
    await expect(url).toHaveValue(href);
    await author.getByRole('button', { name: '삽입', exact: true }).click();
    for (const view of [editor, peerEditor]) {
      await expect(view.getByRole('link')).toHaveText(fixture.initialText);
      await expect(view.getByRole('link')).toHaveAttribute('href', href);
      await expect(view).toHaveText(prefix + fixture.initialText + suffix);
    }
    await synced(author);
    await author.reload();
    await synced(author);
    await expect(editor.getByRole('link')).toHaveText(fixture.initialText);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('360px 공동 편집에서 슬래시 삽입을 취소하거나 동료가 편집한 뒤 원래 위치에 적용한다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  const created = await fixture.requests.post('/api/documents', { data: {
    projectId: fixture.document.projectId, title: `${fixture.document.title} 참조 대상`,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  } });
  expect(created.status(), await created.text()).toBe(201);
  const target = await created.json() as DocPage;
  await enable(fixture);
  const contexts = await Promise.all(fixture.actorIds.map(() => browser.newContext({ baseURL, viewport: { width: 360, height: 820 } })));
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [author, peer] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(author, fixture.document), open(peer, fixture.document)]);
    await Promise.all([synced(author), synced(peer)]);
    await expect(author.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    const authorEditor = author.locator('.docs-live-prose');
    const peerEditor = peer.locator('.docs-live-prose');
    const menu = author.getByRole('group', { name: '블록 추가', exact: true });
    const reference = author.getByRole('dialog', { name: '문서 참조 삽입', exact: true });
    const list = author.getByRole('dialog', { name: '업무 목록 삽입', exact: true });
    const referenceQuery = '/document', listQuery = '/list';
    const tail = '명령 뒤의 문단';
    const paragraphs = authorEditor.locator(':scope > p');
    await peerEditor.evaluate((node, value) => {
      const editor = (node as HTMLElement & { editor?: Editor }).editor;
      if (!editor) throw new Error('The live editor is unavailable.');
      const { doc, schema, tr } = editor.state;
      const paragraph = schema.nodes.paragraph;
      editor.view.dispatch(tr.insert(doc.content.size, [paragraph.create(), paragraph.create(null, schema.text(value))]));
    }, tail);
    await expect(paragraphs).toHaveText([fixture.initialText, '', tail]);
    await author.bringToFront();

    async function typeCommand(paragraph: Locator, query: string, label: string) {
      await paragraph.click();
      await author.keyboard.press('End');
      if (await paragraph.textContent() === query) {
        await author.keyboard.press('Backspace');
        await author.keyboard.insertText(query.slice(-1));
      } else {
        await expect(paragraph).toHaveText('');
        await author.keyboard.insertText(query);
      }
      await expect(paragraph).toHaveText(query);
      await menu.getByRole('button', { name: label, exact: true }).click();
    }
    async function appendParagraph() {
      const count = await paragraphs.count();
      await peerEditor.evaluate(node => {
        const editor = (node as HTMLElement & { editor?: Editor }).editor;
        if (!editor) throw new Error('The live editor is unavailable.');
        const { doc, schema, tr } = editor.state;
        editor.view.dispatch(tr.insert(doc.content.size, schema.nodes.paragraph.create()));
      });
      await expect(paragraphs).toHaveCount(count + 1);
      await expect(paragraphs.last()).toHaveText('');
      return paragraphs.last();
    }
    async function chooseReference() {
      await reference.getByRole('textbox', { name: '참조할 항목 검색', exact: true }).fill(target.title);
      await reference.locator('.doc-reference-results').getByRole('button').filter({ hasText: target.title }).click();
    }
    const expectSharedCommand = async (query: string) => {
      await expect(authorEditor).toContainText(query);
      await expect(peerEditor).toContainText(query);
      await expect(peer.getByRole('group', { name: '블록 추가', exact: true })).toHaveCount(0);
      await expect.poll(async () => (await canonical(fixture)).plainText).toContain(query);
    };
    await typeCommand(paragraphs.nth(1), referenceQuery, '문서 참조');
    await expect(reference).toBeVisible();
    await expectSharedCommand(referenceQuery);
    await author.keyboard.press('Escape');
    await expect(reference).toHaveCount(0);
    await expect(paragraphs.nth(1)).toHaveText(referenceQuery);
    await expect(authorEditor).toBeFocused();
    await expectSharedCommand(referenceQuery);

    await typeCommand(paragraphs.nth(1), referenceQuery, '문서 참조');
    const prefix = '동료가 앞 문단에 추가 ';
    await peerEditor.evaluate((node, value) => {
      const editor = (node as HTMLElement & { editor?: Editor }).editor;
      if (!editor) throw new Error('The live editor is unavailable.');
      editor.view.dispatch(editor.state.tr.insertText(value, 1));
    }, prefix);
    await expect(paragraphs.first()).toHaveText(prefix + fixture.initialText);
    await expect(paragraphs.nth(1)).toHaveText(referenceQuery);
    await chooseReference();
    await expect(reference).toHaveCount(0);
    const peerReference = peerEditor.locator('[data-teamspace-node="documentReference"]');
    await expect(peerReference).toHaveCount(1);
    await expect(peerReference).toContainText(target.title);
    await expect(peerEditor).not.toContainText(referenceQuery);
    await synced(author);
    const saved = (await canonical(fixture)).content.content ?? [];
    const insertedAt = saved.findIndex(node => node.type === 'documentReference');
    const tailAt = saved.findIndex(node => node.type === 'paragraph' && node.content?.[0]?.text === tail);
    expect(saved.filter(node => node.type === 'documentReference')).toHaveLength(1);
    expect(saved[insertedAt]?.attrs?.documentId).toBe(target.id);
    expect(saved[0]?.content?.[0]?.text).toBe(prefix + fixture.initialText);
    expect(insertedAt).toBeGreaterThan(0);
    expect(insertedAt).toBeLessThan(tailAt);

    await typeCommand(await appendParagraph(), listQuery, '업무 목록');
    await expect(list).toBeVisible();
    await expectSharedCommand(listQuery);
    await list.getByRole('button', { name: '취소', exact: true }).click();
    await expect(list).toHaveCount(0);
    await expectSharedCommand(listQuery);
    await typeCommand(paragraphs.last(), listQuery, '업무 목록');
    await list.getByRole('button', { name: '업무 목록 삽입', exact: true }).click();
    await expect(list).toHaveCount(0);
    await expect(peerEditor.locator('[data-teamspace-node="issueList"]')).toHaveCount(1);
    await expect(peerEditor).not.toContainText(listQuery);
    await synced(author);

    async function overwritePeerCommand(query: string, replacement: string, duplicate = false) {
      await peerEditor.evaluate((node, edit) => {
        const editor = (node as HTMLElement & { editor?: Editor }).editor;
        if (!editor) throw new Error('The live editor is unavailable.');
        const { doc, schema, tr } = editor.state;
        let from: number | undefined;
        doc.forEach((child, offset) => { if (child.type.name === 'paragraph' && child.textContent === edit.query) from = offset + 1; });
        if (from === undefined) throw new Error('The slash command is unavailable.');
        tr.insertText(edit.replacement, from, from + edit.query.length);
        if (edit.duplicate) tr.insert(tr.doc.content.size, schema.nodes.paragraph.create(null, schema.text(edit.query)));
        editor.view.dispatch(tr);
      }, { query, replacement, duplicate });
    }
    async function expectStaleReference() {
      await synced(peer);
      const before = await canonical(fixture);
      await chooseReference();
      await expect(reference.getByRole('alert')).toHaveText('슬래시 명령이 변경되었습니다. 편집 위치를 다시 선택해 주세요.');
      await expect(peerReference).toHaveCount(1);
      expect(await canonical(fixture)).toEqual(before);
    }

    await typeCommand(await appendParagraph(), referenceQuery, '문서 참조');
    await expectSharedCommand(referenceQuery);
    const replacement = '동료가 원래 명령을 바꾼 문단';
    await overwritePeerCommand(referenceQuery, replacement);
    await expect(paragraphs.filter({ hasText: replacement })).toHaveCount(1);
    await expect(authorEditor).not.toContainText(referenceQuery);
    await synced(peer);
    await peerEditor.evaluate((node, query) => {
      const editor = (node as HTMLElement & { editor?: Editor }).editor;
      if (!editor) throw new Error('The live editor is unavailable.');
      const { doc, schema, tr } = editor.state;
      editor.view.dispatch(tr.insert(doc.content.size, schema.nodes.paragraph.create(null, schema.text(query))));
    }, referenceQuery);
    await expect(paragraphs.last()).toHaveText(referenceQuery);
    await expectStaleReference();
    await reference.getByRole('button', { name: '참조 삽입 닫기', exact: true }).click();
    await expect(reference).toHaveCount(0);

    const relocatedQuery = '/link';
    const replacedParagraph = '동료가 명령 위치를 바꾼 문단';
    await typeCommand(await appendParagraph(), relocatedQuery, '문서 참조');
    await expectSharedCommand(relocatedQuery);
    await overwritePeerCommand(relocatedQuery, replacedParagraph, true);
    await expect(paragraphs.filter({ hasText: replacedParagraph })).toHaveCount(1);
    await expect(paragraphs.last()).toHaveText(relocatedQuery);
    await expectStaleReference();
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('공동 편집의 다른 문서 속성은 서로 보존하고 제목을 다르게 바꾸면 충돌을 알린다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  test.setTimeout(75_000);
  await enable(fixture);
  const contexts = await Promise.all(fixture.actorIds.map(() => browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } })));
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [first, peer] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(first, fixture.document), open(peer, fixture.document)]);
    await Promise.all([synced(first), synced(peer)]);
    const title = (page: Page) => page.getByRole('textbox', { name: '문서 제목', exact: true });
    const save = (page: Page) => page.getByRole('button', { name: '속성 저장', exact: true });
    const path = `/api/documents/${fixture.document.id}`;
    const saves = (page: Page) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'PATCH');
    const firstWrites: unknown[] = [];
    first.on('request', request => {
      if (new URL(request.url()).pathname === path && request.method() === 'PATCH') firstWrites.push(request.postDataJSON());
    });

    const draftTitle = `${fixture.document.title} 제목 초안`;
    const draftLabel = '새 문서 라벨 초안';
    await title(first).fill(draftTitle);
    await first.getByRole('textbox', { name: '문서 라벨', exact: true }).fill(draftLabel);
    await first.getByRole('button', { name: '라벨 추가', exact: true }).click();
    const details = peer.getByRole('complementary', { name: '문서 상세 정보', exact: true });
    await details.getByRole('button', { name: '연결', exact: true }).click();
    await details.getByRole('combobox', { name: '작성 상태', exact: true }).selectOption('published');
    const [peerSave] = await Promise.all([saves(peer), save(peer).click()]);
    expect(peerSave.status()).toBe(200);
    await append(peer, ' 동료의 본문 편집');
    await synced(peer);
    await expect(first.locator('.docs-live-prose')).toContainText('동료의 본문 편집');
    await expect(first.locator('.docs-status-pill')).toHaveText('공유 표시');
    await expect(first.locator('.docs-conflict')).toHaveCount(0);
    await expect(title(first)).toHaveValue(draftTitle);
    await expect(first.getByRole('button', { name: `라벨 삭제: ${draftLabel}`, exact: true })).toBeVisible();
    const reviewed = await canonical(fixture);
    expect(reviewed).toMatchObject({ title: fixture.document.title, status: 'published', plainText: `${fixture.initialText} 동료의 본문 편집` });
    expect(firstWrites).toEqual([]);

    const [merged] = await Promise.all([saves(first), save(first).click()]);
    expect(merged.status(), await merged.text()).toBe(200);
    expect(firstWrites).toHaveLength(1);
    expect(firstWrites[0]).toMatchObject({ expectedVersion: reviewed.version, title: draftTitle, labels: [draftLabel] });
    expect(firstWrites[0]).not.toHaveProperty('content');
    expect(await canonical(fixture)).toMatchObject({ version: reviewed.version + 1, title: draftTitle, labels: [draftLabel],
      status: reviewed.status, content: reviewed.content, plainText: reviewed.plainText });
    await expect(first.locator('.docs-save-state')).toHaveText('동기화됨');
    await expect(title(peer)).toHaveValue(draftTitle);

    const localTitle = `${draftTitle} 내 새 제목`, peerTitle = `${draftTitle} 동료가 저장한 제목`;
    await title(first).fill(localTitle);
    await title(peer).fill(peerTitle);
    const [overlap] = await Promise.all([saves(peer), save(peer).click()]);
    expect(overlap.status(), await overlap.text()).toBe(200);
    await expect(first.locator('.docs-conflict')).toBeVisible();
    await expect(title(first)).toHaveValue(localTitle);
    await first.getByRole('button', { name: '서버 최신본 보기', exact: true }).click();
    await expect(first.locator('.docs-latest-preview')).toContainText(peerTitle);
    expect(firstWrites).toHaveLength(1);
    const savedPeerTitle = await canonical(fixture);
    expect(savedPeerTitle).toMatchObject({ title: peerTitle, labels: [draftLabel], status: reviewed.status, plainText: reviewed.plainText });

    const choice = first.getByRole('group', { name: '제목', exact: true });
    const keepMine = choice.getByRole('radio', { name: /내 편집/ });
    const useServer = choice.getByRole('radio', { name: /서버 저장값/ });
    const continueEditing = first.getByRole('button', { name: '선택한 내용으로 편집 계속', exact: true });
    await expect(choice).toContainText(localTitle);
    await expect(choice).toContainText(peerTitle);
    await expect(keepMine).not.toBeChecked();
    await expect(useServer).not.toBeChecked();
    await expect(continueEditing).toBeDisabled();
    await expect(save(first)).toBeDisabled();
    await first.keyboard.press('Control+s');
    await keepMine.check();
    await continueEditing.click();
    await expect(first.locator('.docs-conflict')).toHaveCount(0);
    await expect(title(first)).toHaveValue(localTitle);
    await expect(save(first)).toBeEnabled();
    expect(firstWrites).toHaveLength(1);
    expect(await canonical(fixture)).toEqual(savedPeerTitle);

    const [resolved] = await Promise.all([saves(first), save(first).click()]);
    expect(resolved.status(), await resolved.text()).toBe(200);
    expect(firstWrites).toHaveLength(2);
    expect(firstWrites[1]).toMatchObject({ expectedVersion: savedPeerTitle.version, title: localTitle });
    expect(firstWrites[1]).not.toHaveProperty('content');
    expect(await canonical(fixture)).toMatchObject({ version: savedPeerTitle.version + 1, title: localTitle,
      labels: [draftLabel], status: reviewed.status, content: reviewed.content, plainText: reviewed.plainText });
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('늦은 문서 저장 응답 뒤에도 이어서 입력한 라벨과 동료의 이후 변경을 보존한다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  test.setTimeout(75_000);
  await enable(fixture);
  const contexts = await Promise.all(fixture.actorIds.map(() => browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } })));
  let releaseResponse = () => {};
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [first, peer] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(first, fixture.document), open(peer, fixture.document)]);
    await Promise.all([synced(first), synced(peer)]);
    const title = (page: Page) => page.getByRole('textbox', { name: '문서 제목', exact: true });
    const save = (page: Page) => page.getByRole('button', { name: '속성 저장', exact: true });
    const path = `/api/documents/${fixture.document.id}`;
    const saves = (page: Page) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'PATCH');
    let observeCommit = () => {};
    const commitObserved = new Promise<void>(resolve => { observeCommit = resolve; });
    let held = false;
    await first.route(url => url.pathname === path, async route => {
      if (held || route.request().method() !== 'PATCH') { await route.continue(); return; }
      held = true;
      const response = await route.fetch();
      observeCommit();
      await responseGate;
      await route.fulfill({ response });
    });

    const submittedTitle = `${fixture.document.title} 먼저 저장한 제목`;
    const followUpLabel = '응답을 기다리며 추가한 라벨';
    await title(first).fill(submittedTitle);
    await save(first).click();
    await commitObserved;
    await expect(first.locator('.docs-save-state')).toHaveText('저장 중');
    await expect(title(peer)).toHaveValue(submittedTitle);
    await first.getByRole('textbox', { name: '문서 라벨', exact: true }).fill(followUpLabel);
    await first.getByRole('button', { name: '라벨 추가', exact: true }).click();

    const details = peer.getByRole('complementary', { name: '문서 상세 정보', exact: true });
    await details.getByRole('button', { name: '연결', exact: true }).click();
    await details.getByRole('combobox', { name: '작성 상태', exact: true }).selectOption('published');
    const [peerSave] = await Promise.all([saves(peer), save(peer).click()]);
    expect(peerSave.status()).toBe(200);
    await append(peer, ' 응답을 기다리는 사이 저장된 본문');
    await synced(peer);
    await expect(first.locator('.docs-live-prose')).toContainText('응답을 기다리는 사이 저장된 본문');
    const latest = await canonical(fixture);
    expect(latest).toMatchObject({ title: submittedTitle, status: 'published' });

    const oldReceipt = saves(first);
    releaseResponse();
    const response = await oldReceipt;
    expect(response.status()).toBe(200);
    expect(((await response.json()) as DocPage).version).toBeLessThan(latest.version);
    await expect(first.locator('.docs-conflict')).toHaveCount(0);
    await expect(title(first)).toHaveValue(submittedTitle);
    await expect(first.locator('.docs-status-pill')).toHaveText('공유 표시');
    await expect(first.getByRole('button', { name: `라벨 삭제: ${followUpLabel}`, exact: true })).toBeVisible();
    await expect(save(first)).toBeEnabled();
    expect(await canonical(fixture)).toEqual(latest);

    const [remaining] = await Promise.all([saves(first), save(first).click()]);
    expect(remaining.status(), await remaining.text()).toBe(200);
    expect(remaining.request().postDataJSON()).toMatchObject({ expectedVersion: latest.version, labels: [followUpLabel] });
    expect(remaining.request().postDataJSON()).not.toHaveProperty('content');
    expect(await canonical(fixture)).toMatchObject({ version: latest.version + 1, title: submittedTitle,
      labels: [followUpLabel], status: latest.status, content: latest.content, plainText: latest.plainText });
  } finally {
    releaseResponse();
    await Promise.all(contexts.map(context => context.close()));
  }
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

test('문서 복구 뒤 변경을 모두 저장한 온라인·오프라인 작업자는 최신 문서에 자동으로 연결된다', async ({ browser, baseURL, collaborativeDocument: fixture }) => {
  await enable(fixture);
  const contexts = await Promise.all(fixture.actorIds.map(() => browser.newContext({ baseURL, viewport: { width: 360, height: 820 } })));
  try {
    await Promise.all(contexts.map((context, index) => setActor(context, fixture.actorIds[index])));
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([open(a, fixture.document), open(b, fixture.document)]);
    await Promise.all([synced(a), synced(b)]);
    const titleDraft = '복구 후 이어서 저장할 제목 초안';
    await b.getByRole('textbox', { name: '문서 제목', exact: true }).fill(titleDraft);
    await a.locator('.docs-live-prose').press('Control+End');
    await a.keyboard.insertText(' 복구 전에 팀이 저장한 문장');
    await synced(a);
    await expect(b.locator('.docs-live-prose')).toContainText('복구 전에 팀이 저장한 문장');
    await contexts[1].setOffline(true);
    await expect(b.locator('.docs-collaboration-state')).toHaveText('연결 끊김');

    const current = await canonical(fixture);
    const path = `/api/documents/${fixture.document.id}`;
    const revisions = await (await fixture.requests.get(`${path}/revisions`)).json() as { id: string; version: number }[];
    const original = revisions.find(revision => revision.version === 1);
    expect(original).toBeDefined();
    expect((await fixture.requests.post(`${path}/restore`, { data: { revisionId: original!.id, expectedVersion: current.version } })).status()).toBe(200);
    await expect(a.locator('.docs-live-prose')).toHaveText(fixture.initialText);
    await synced(a);
    await expect(a.locator('.docs-collaboration-recovery')).toHaveCount(0);
    await contexts[1].setOffline(false);
    await expect(b.locator('.docs-live-prose')).toHaveText(fixture.initialText);
    await synced(b);
    await expect(b.locator('.docs-collaboration-recovery')).toHaveCount(0);
    await expect(b.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(titleDraft);
    await b.locator('.docs-live-prose').press('Control+End');
    await b.keyboard.insertText(' 다시 연결한 뒤 입력');
    await synced(b);
    await expect(a.locator('.docs-live-prose')).toHaveText(`${fixture.initialText} 다시 연결한 뒤 입력`);
    expect((await canonical(fixture)).plainText).toBe(`${fixture.initialText} 다시 연결한 뒤 입력`);
  } finally { await Promise.all(contexts.map(context => context.close())); }
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

    const response = b.waitForResponse(result => new URL(result.url()).pathname === `/api/documents/${fixture.document.id}/recovery-copy` && result.request().method() === 'POST');
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
