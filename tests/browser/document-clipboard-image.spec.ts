import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import type { AttachmentHead, DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types';

const viewport = { width: 360, height: 820 };
const lead = '스크린샷 앞의 문장';
const anchor = '스크린샷을 붙일 문장';
const tail = '스크린샷 뒤의 문장';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function createDocument(request: APIRequestContext, projectId: string, title: string) {
  const content: RichContent = { type: 'doc', content: [lead, anchor, tail].map(text => ({
    type: 'paragraph', content: [{ type: 'text', text }],
  })) };
  const response = await request.post('/api/documents', { data: { projectId, title, content } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as DocPage;
}

async function openDocument(page: Page, document: DocPage) {
  await page.goto(`/#/${document.projectId}/documents/${document.id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);
}

async function purgeDocument(request: APIRequestContext, id: string) {
  const current = (await workspace(request)).documents.find(document => document.id === id);
  if (!current) return;
  const deletion = await request.delete(`/api/documents/${id}?expectedVersion=${current.version}`);
  expect(deletion.ok(), await deletion.text()).toBe(true);
  const { trashEntryId } = await deletion.json() as { trashEntryId: string };
  const purge = await request.delete(`/api/trash/${trashEntryId}`);
  expect(purge.ok(), await purge.text()).toBe(true);
}

function matchesUpload(document: DocPage, url: string, method: string) {
  const target = new URL(url);
  return method === 'POST' && target.pathname === '/api/attachments' && target.searchParams.get('resourceId') === document.id;
}

function waitForUpload(page: Page, document: DocPage) {
  return page.waitForResponse(response => matchesUpload(document, response.url(), response.request().method()));
}

async function holdUpload(page: Page, document: DocPage) {
  let started = false;
  const released = Promise.withResolvers<void>();
  await page.route('**/api/attachments?*', async route => {
    if (matchesUpload(document, route.request().url(), route.request().method())) {
      started = true;
      await released.promise;
    }
    await route.continue();
  });
  return { waitForStart: () => expect.poll(() => started).toBe(true), release: () => released.resolve() };
}

async function placeCaret(page: Page, editor: Locator, text: string, position: 'Home' | 'End') {
  await editor.getByText(text, { exact: true }).click();
  await page.keyboard.press(position);
}

async function pasteImage(editor: Locator, filename: string) {
  await editor.evaluate((element, { filename, bytes }) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([Uint8Array.from(bytes)], filename, { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, { filename, bytes: Array.from(png) });
}

async function uploadedImage(response: Response, document: DocPage, filename: string) {
  expect(response.status(), await response.text()).toBe(201);
  expect(response.request().headers()).toMatchObject({ 'content-type': 'application/octet-stream', 'x-file-type': 'image/png' });
  const attachment = await response.json() as AttachmentHead;
  expect(attachment).toMatchObject({
    resourceType: 'document', resourceId: document.id, filename, mimeType: 'image/png', size: png.length,
    sha256: createHash('sha256').update(png).digest('hex'), versionCount: 1,
  });
  expect(attachment.currentVersionId).toBeTruthy();
  return attachment;
}

const inlinePath = (attachment: AttachmentHead) => `/api/attachments/${attachment.currentVersionId}/content?inline=1`;

function imageSources(node: RichContent): string[] {
  if (node.type === 'image') return [String(node.attrs?.src)];
  return node.content?.flatMap(imageSources) ?? [];
}

async function expectPersistedImage(request: APIRequestContext, document: DocPage, path: string) {
  await expect.poll(async () => {
    const saved = (await workspace(request)).documents.find(value => value.id === document.id);
    return saved && imageSources(saved.content);
  }).toEqual([path]);
  const savedFile = await request.get(path);
  expect(savedFile.ok(), await savedFile.text()).toBe(true);
  expect(savedFile.headers()['content-type']).toContain('image/png');
  expect(await savedFile.body()).toEqual(png);
}

async function expectImageBetweenParagraphs(editor: Locator, filename: string, path: string) {
  const image = editor.getByRole('img', { name: filename, exact: true });
  await expect(image).toHaveAttribute('src', path);
  await expect(image.locator('xpath=preceding-sibling::*[1]')).toHaveText(anchor);
  await expect(image.locator('xpath=following-sibling::*[1]')).toContainText(tail);
}

test('수동 편집에서 스크린샷을 붙여넣고 새 첨부 버전이 올라와도 같은 이미지로 다시 열린다', async ({ page, request }) => {
  const [project] = (await workspace(request)).projects;
  const suffix = randomUUID();
  const filename = `검토 화면 ${suffix}.png`;
  const document = await createDocument(request, project.id, `클립보드 수동 편집 ${suffix}`);
  try {
    await page.setViewportSize(viewport);
    await openDocument(page, document);
    const editor = page.locator('.docs-prose[contenteditable=true]');
    await placeCaret(page, editor, anchor, 'End');
    const [response] = await Promise.all([waitForUpload(page, document), pasteImage(editor, filename)]);
    const attachment = await uploadedImage(response, document, filename);
    const path = inlinePath(attachment);
    await expectImageBetweenParagraphs(editor, filename, path);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');

    await placeCaret(page, editor, tail, 'End');
    await editor.evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', '일반 붙여넣기');
      clipboardData.setData('text/html', '<strong>일반 붙여넣기</strong>');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await expect(editor.locator('strong')).toHaveText('일반 붙여넣기');
    const list = await request.get('/api/attachments', { params: { resourceType: 'document', resourceId: document.id } });
    expect(list.ok(), await list.text()).toBe(true);
    const files = await list.json() as AttachmentHead[];
    expect(files.map(file => file.currentVersionId)).toEqual([attachment.currentVersionId]);

    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    await expectPersistedImage(request, document, path);

    const newVersion = await request.post(`/api/attachments/${attachment.id}/versions`, {
      params: { filename: '새 이미지.gif', expectedVersionId: attachment.currentVersionId },
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Type': 'image/gif' }, data: gif,
    });
    expect(newVersion.status(), await newVersion.text()).toBe(201);
    const latest = await newVersion.json() as AttachmentHead;
    expect(latest.currentVersionId).not.toBe(attachment.currentVersionId);
    expect(latest.versionCount).toBe(2);

    await page.reload();
    await expectImageBetweenParagraphs(editor, filename, path);
    await expect(editor.locator('strong')).toHaveText('일반 붙여넣기');
    await expect.poll(async () => editor.getByRole('img', { name: filename, exact: true })
      .evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
    await expectPersistedImage(request, document, path);
  } finally {
    await purgeDocument(request, document.id);
  }
});

test('공동 편집에서 스크린샷 업로드 중 동료가 앞에 문단을 추가해도 원래 위치에 동기화된다', async ({ browser, baseURL, request }) => {
  const { projects: [project], users: [firstActor, secondActor] } = await workspace(request);
  const suffix = randomUUID();
  const filename = `공동 편집 화면 ${suffix}.png`;
  const document = await createDocument(request, project.id, `클립보드 공동 편집 ${suffix}`);
  const contexts = await Promise.all([firstActor, secondActor].map(async actor => {
    const context = await browser.newContext({ baseURL, viewport });
    await context.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    return context;
  }));
  try {
    const enable = await request.post(`/api/documents/${document.id}/collaboration/enable`, {
      data: { expectedVersion: document.version },
    });
    expect(enable.ok(), await enable.text()).toBe(true);
    const [author, peer] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([openDocument(author, document), openDocument(peer, document)]);
    await expect(author.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    const authorEditor = author.locator('.docs-live-prose[contenteditable=true]');
    const peerEditor = peer.locator('.docs-live-prose[contenteditable=true]');
    const upload = await holdUpload(author, document);
    try {
      await placeCaret(author, authorEditor, anchor, 'End');
      await pasteImage(authorEditor, filename);
      await upload.waitForStart();
      await expect(authorEditor.locator('img')).toHaveCount(0);

      const preceding = '동료가 추가한 앞 문단';
      await placeCaret(peer, peerEditor, lead, 'End');
      await peerEditor.evaluate((element, text) => {
        const before = element.ownerDocument.createElement('p');
        const inserted = element.ownerDocument.createElement('p');
        inserted.textContent = text;
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/html', before.outerHTML + inserted.outerHTML);
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, preceding);
      await expect(authorEditor.locator(':scope > p')).toHaveText([lead, preceding, anchor, tail]);

      const response = waitForUpload(author, document);
      upload.release();
      const attachment = await uploadedImage(await response, document, filename);
      expect(attachment.authorId).toBe(firstActor.id);
      const path = inlinePath(attachment);
      await Promise.all([expectImageBetweenParagraphs(authorEditor, filename, path), expectImageBetweenParagraphs(peerEditor, filename, path)]);
      await expect(peerEditor.locator('p').nth(1)).toHaveText(preceding);
      await expect(author.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
      await expectPersistedImage(request, document, path);

      await peer.reload();
      await expectImageBetweenParagraphs(peerEditor, filename, path);
      await expect(peerEditor.locator('p').nth(1)).toHaveText(preceding);
    } finally {
      upload.release();
    }
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await purgeDocument(request, document.id);
  }
});

test('업로드 중에 다른 문서를 열면 원본의 첨부파일에서 이미지를 다시 삽입할 수 있다', async ({ page, request }) => {
  const [project] = (await workspace(request)).projects;
  const suffix = randomUUID();
  const filename = `이동 중 붙인 이미지 ${suffix}.png`;
  const original = await createDocument(request, project.id, `클립보드 원본 ${suffix}`);
  let destination: DocPage | undefined;
  try {
    destination = await createDocument(request, project.id, `클립보드 다른 문서 ${suffix}`);
    await page.setViewportSize(viewport);
    await openDocument(page, original);
    const editor = page.locator('.docs-prose[contenteditable=true]');
    const upload = await holdUpload(page, original);
    try {
      await placeCaret(page, editor, anchor, 'End');
      await pasteImage(editor, filename);
      await upload.waitForStart();
      await openDocument(page, destination);
      await expect(editor).toBeVisible();

      const response = waitForUpload(page, original);
      upload.release();
      const attachment = await uploadedImage(await response, original, filename);
      const path = inlinePath(attachment);
      await expect(page.getByText('원래 문서의 파일 탭에서 확인해 주세요.', { exact: false })).toBeVisible();
      await expect(editor.locator('img')).toHaveCount(0);
      await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

      const saved = (await workspace(request)).documents;
      expect(saved.find(document => document.id === original.id)?.content).toEqual(original.content);
      expect(saved.find(document => document.id === destination?.id)?.content).toEqual(destination.content);

      await openDocument(page, original);
      await expect(editor.locator('img')).toHaveCount(0);
      await placeCaret(page, editor, anchor, 'End');
      await page.getByRole('button', { name: '파일 첨부', exact: true }).click();
      const file = page.locator('.attachment-row').filter({ hasText: filename });
      await expect(file).toBeVisible();
      await file.getByRole('button', { name: '본문에 삽입', exact: true }).click();
      await expect(editor.locator('img')).toHaveAttribute('src', path);
      await page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();
      await page.locator('.docs-save-button').click();
      await expectPersistedImage(request, original, path);

      await openDocument(page, destination);
      await expect(editor.locator('img')).toHaveCount(0);
    } finally {
      upload.release();
    }
  } finally {
    if (destination) await purgeDocument(request, destination.id);
    await purgeDocument(request, original.id);
  }
});
