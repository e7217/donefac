import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import { contentReferences, DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes';
import type { AttachmentHead, DocPage, DocRevision, DocumentTreeCopyOptions, DocumentTreeCopyPreview, RichContent, WorkspaceSnapshot } from '../../shared/types';

const button = (within: Page | Locator, name: string) => within.getByRole('button', { name, exact: true });
const documentPath = (id: string) => `/api/documents/${id}`;
const documentUrl = (document: DocPage) => `/#/${document.projectId}/documents/${document.id}`;
const attachmentPath = (id: string, inline = false) => `/api/attachments/${id}/content${inline ? '?inline=1' : ''}`;
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const title = (page: Page) => page.getByRole('textbox', { name: '문서 제목', exact: true });
const editor = (page: Page) => page.locator('.docs-prose[contenteditable="true"]');

type CopyRequest = DocumentTreeCopyOptions & { token: string; requestId: string };

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function workspace(request: APIRequestContext) {
  return json<WorkspaceSnapshot>(await request.get('/api/workspace'));
}

function waitMutation(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

test('360px에서 저장된 문서 트리를 다른 공간으로 복제하고 독립 편집과 첨부를 확인한다', async ({ page, request }) => {
  test.setTimeout(105_000);
  const { projects: [sourceSpace, destinationSpace], users: [actor, peer] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `트리 복제 ${randomUUID().slice(0, 8)}`;
  const sourceText = '원본에 저장해 둔 설계';
  const localText = '원본에 저장하지 않은 이번 편집';
  const copyEdit = '복제본에만 남길 새 편집';
  const logoFilename = '복제 이미지.png';
  const imageAlt = '합성 설계 로고';
  const linkTitle = '검토 목록 받기';
  const checklistFilename = '검토 목록.txt';
  const unlinkedFilename = '미삽입 메모.txt';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  const checklist = Buffer.from('검토 항목 합성 파일\n');
  const unlinked = Buffer.from('본문에는 없는 별도 메모\n');

  async function createDocument(projectId: string, name: string, parentId: string | null, content: RichContent, extra = {}) {
    return json<DocPage>(await request.post('/api/documents', {
      headers, data: { projectId, parentId, title: `${prefix} ${name}`, content, ...extra },
    }), 201);
  }

  async function upload(document: DocPage, filename: string, bytes: Buffer) {
    return json<AttachmentHead>(await request.post('/api/attachments', {
      params: { resourceType: 'document', resourceId: document.id, filename },
      headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: bytes,
    }), 201);
  }

  async function files(document: DocPage) {
    return json<AttachmentHead[]>(await request.get('/api/attachments', { params: { resourceType: 'document', resourceId: document.id } }));
  }

  async function purge(document: DocPage) {
    const removed = await json<{ trashEntryId: string }>(await request.delete(documentPath(document.id), { headers }));
    const purged = await request.delete(`/api/trash/${removed.trashEntryId}`, { headers });
    expect(purged.ok(), await purged.text()).toBeTruthy();
  }

  try {
    const destination = await createDocument(destinationSpace.id, '도착 상위 문서', null, body(paragraph('복제본이 놓일 자리')));
    const origin = await createDocument(sourceSpace.id, '원본', null, body(paragraph(sourceText)), { status: 'published', icon: '🧪', labels: ['복제 검증'] });
    const child = await createDocument(sourceSpace.id, '하위 문서', origin.id, body(paragraph('하위 설계 검토')));
    const grandchild = await createDocument(sourceSpace.id, '세 번째 문서', child.id, body(paragraph('계층을 확인할 저장 내용')));
    const originalLogo = await upload(origin, logoFilename, png);
    const originalUnlinked = await upload(origin, unlinkedFilename, unlinked);
    const originalChecklist = await upload(child, checklistFilename, checklist);
    const source = await json<DocPage>(await request.patch(documentPath(origin.id), {
      headers, data: { expectedVersion: origin.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: body(
        paragraph(sourceText),
        { type: 'image', attrs: { src: attachmentPath(originalLogo.id, true), alt: imageAlt } },
        { type: 'documentReference', attrs: { documentId: child.id, label: child.title } },
        paragraph('편집을 확인할 마지막 문단'),
      ) },
    }));
    const savedChild = await json<DocPage>(await request.patch(documentPath(child.id), {
      headers, data: { expectedVersion: child.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: body({
        type: 'paragraph', content: [{ type: 'text', text: linkTitle, marks: [{ type: 'link', attrs: { href: attachmentPath(originalChecklist.id) } }] }],
      }) },
    }));
    const previewPath = `${documentPath(source.id)}/copy-preview`;
    const applyPath = `${documentPath(source.id)}/copy`;
    const options = { projectId: destinationSpace.id, parentId: destination.id, title: `${prefix} 복제본`,
      includeDescendants: true, expectedSourceVersion: source.version } satisfies DocumentTreeCopyOptions;

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(documentUrl(source));
    await expect(title(page)).toHaveValue(source.title);
    await editor(page).fill(localText);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    await button(page, '문서 복제').click();
    const dialog = page.getByRole('dialog', { name: '문서 복제', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await dialog.getByLabel('복제본 제목', { exact: true }).fill(options.title);
    await dialog.getByRole('combobox', { name: '복제할 공간', exact: true }).selectOption(options.projectId);
    await dialog.getByRole('combobox', { name: '복제할 상위 문서', exact: true }).selectOption(options.parentId);
    await dialog.getByRole('checkbox', { name: '하위 문서 포함', exact: true }).check();
    const previewButton = button(dialog, '복제 미리보기');
    const apply = button(dialog, '문서 복제 적용');
    const summary = dialog.getByRole('region', { name: '복제 대상 문서', exact: true });

    async function preview() {
      const pending = waitMutation(page, previewPath);
      await previewButton.click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual(options);
      const value = await json<DocumentTreeCopyPreview>(response);
      await expect(apply).toBeEnabled();
      return value;
    }

    const first = await preview();
    expect(first).toMatchObject({ ...options, sourceDocumentId: source.id,
      attachmentCount: 3, attachmentBytes: png.length + checklist.length + unlinked.length });
    expect(first.documents.map(document => document.id)).toEqual([source.id, child.id, grandchild.id]);
    await expect(summary.getByText(grandchild.title, { exact: true })).toBeVisible();

    const editedChild = await json<DocPage>(await request.patch(documentPath(child.id), {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: savedChild.version, title: `${prefix} 갱신된 하위 문서` },
    }));
    const rejected = waitMutation(page, applyPath);
    await apply.click();
    expect(await json<{ details: unknown }>(await rejected, 409)).toMatchObject({ details: { reason: 'copy_preview_stale' } });
    await expect(dialog.getByRole('alert')).toContainText('복제');
    expect((await workspace(request)).documents.filter(document => document.title === options.title)).toEqual([]);
    const valid = await preview();
    expect(valid.token).not.toBe(first.token);
    expect(valid.documents).toContainEqual({ id: editedChild.id, title: editedChild.title, version: editedChild.version });
    await expect(summary.getByText(editedChild.title, { exact: true })).toBeVisible();

    const requests: CopyRequest[] = [];
    let committed: DocPage | undefined;
    await page.route(`**${applyPath}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      requests.push(route.request().postDataJSON());
      if (requests.length > 1) return route.continue();
      committed = await json<DocPage>(await route.fetch(), 201);
      await route.abort('failed');
    });
    await apply.click();
    const retry = button(dialog, '같은 요청으로 다시 확인');
    await expect(retry).toBeVisible();
    expect(new URL(page.url()).hash).toBe(new URL(documentUrl(source), page.url()).hash);
    const replay = waitMutation(page, applyPath);
    await retry.click();
    const copy = await json<DocPage>(await replay);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({ ...options, token: valid.token, requestId: expect.any(String) });
    expect(requests[1]).toEqual(requests[0]);
    expect(copy).toEqual(committed);
    expect(copy).toMatchObject({ projectId: destinationSpace.id, parentId: destination.id, title: options.title,
      status: 'draft', version: 1, authorId: actor.id, icon: source.icon, labels: source.labels });
    expect(copy.id).not.toBe(source.id);
    expect(copy.plainText).toContain(sourceText);
    expect(copy.plainText).not.toContain(localText);

    const stored = (await workspace(request)).documents;
    const copies = stored.filter(document => document.projectId === destinationSpace.id && document.title.startsWith(prefix));
    expect(copies).toHaveLength(4);
    expect(copies.filter(document => document.parentId === destination.id)).toEqual([copy]);
    const copiedChild = copies.find(document => document.parentId === copy.id)!;
    expect(copiedChild).toMatchObject({ title: editedChild.title, status: 'draft', version: 1 });
    const copiedGrandchild = copies.find(document => document.parentId === copiedChild.id)!;
    expect(copiedGrandchild).toMatchObject({ title: grandchild.title, plainText: grandchild.plainText, status: 'draft', version: 1 });
    expect(new Set([source.id, child.id, grandchild.id, copy.id, copiedChild.id, copiedGrandchild.id]).size).toBe(6);
    expect(contentReferences(copy.content)).toMatchObject([{ type: 'document', id: copiedChild.id }]);
    for (const original of [source, editedChild, grandchild]) expect(stored.find(document => document.id === original.id)).toEqual(original);
    const copyHistory = await json<DocRevision[]>(await request.get(`${documentPath(copy.id)}/revisions`));
    expect(copyHistory.map(revision => revision.version)).toEqual([1]);

    const rootFiles = await files(copy);
    const copyLogo = rootFiles.find(file => file.filename === logoFilename)!;
    const copyUnlinked = rootFiles.find(file => file.filename === unlinkedFilename)!;
    const childFiles = await files(copiedChild);
    expect(rootFiles).toHaveLength(2);
    expect(childFiles).toHaveLength(1);
    const [copyChecklist] = childFiles;
    for (const [newFile, oldFile, owner] of [[copyLogo, originalLogo, copy], [copyUnlinked, originalUnlinked, copy], [copyChecklist, originalChecklist, copiedChild]] as const) {
      expect(newFile).toMatchObject({ resourceId: owner.id, filename: oldFile.filename, sha256: oldFile.sha256 });
      expect(newFile.id).not.toBe(oldFile.id);
    }

    const open = button(dialog, '복제본 열기');
    await expect(open).toBeEnabled();
    page.once('dialog', confirm => confirm.dismiss());
    await open.click();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === new URL(documentUrl(source), url).hash);
    page.once('dialog', confirm => confirm.accept());
    await open.click();
    await expect(page).toHaveURL(url => url.hash === new URL(documentUrl(copy), url).hash);
    await expect(title(page)).toHaveValue(copy.title);
    await expect(editor(page).getByRole('img', { name: imageAlt, exact: true })).toHaveAttribute('src', attachmentPath(copyLogo.id, true));
    await editor(page).press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText(copyEdit);
    const writing = waitMutation(page, documentPath(copy.id), 'PATCH');
    await page.locator('.docs-save-button').click();
    const edited = await json<DocPage>(await writing);
    expect(edited.version).toBe(2);
    expect(edited.plainText).toContain(copyEdit);
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    await page.goto(documentUrl(source));
    await expect(editor(page)).toHaveText(localText);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    expect((await workspace(request)).documents.find(document => document.id === source.id)).toEqual(source);

    page.once('dialog', confirm => confirm.accept());
    await page.goto(documentUrl(copy));
    await expect(editor(page)).toContainText(copyEdit);
    for (const original of [grandchild, editedChild, source]) await purge(original);
    for (const original of [originalLogo, originalUnlinked, originalChecklist]) expect((await request.get(attachmentPath(original.id))).status()).toBe(404);
    await page.reload();
    const image = editor(page).getByRole('img', { name: imageAlt, exact: true });
    await expect(image).toHaveAttribute('src', attachmentPath(copyLogo.id, true));
    await expect(image).toHaveJSProperty('naturalWidth', 1);
    await expect(editor(page)).toContainText(copyEdit);
    await page.goto(documentUrl(copiedChild));
    await expect(editor(page).getByRole('link', { name: linkTitle, exact: true })).toHaveAttribute('href', attachmentPath(copyChecklist.id));
    for (const [file, bytes] of [[copyLogo, png], [copyChecklist, checklist], [copyUnlinked, unlinked]] as const) {
      const downloaded = await request.get(attachmentPath(file.id));
      expect(downloaded.ok(), await downloaded.text()).toBeTruthy();
      expect(await downloaded.body()).toEqual(bytes);
    }
  } finally {
    const documents = (await workspace(request)).documents.filter(document => document.title.startsWith(prefix));
    const parents = new Map(documents.map(document => [document.id, document.parentId]));
    const depth = (id: string) => {
      let steps = 0;
      for (let parent = parents.get(id); parent && parents.has(parent); parent = parents.get(parent)) steps++;
      return steps;
    };
    // Find committed copies by prefix even if the browser never received a receipt.
    for (const document of documents.sort((left, right) => depth(right.id) - depth(left.id))) await purge(document);
  }
});
