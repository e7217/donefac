import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import { documentSectionHash, isDocumentSectionId } from '../../shared/document-sections';
import type { DocPage, DocumentPublicationView, RichContent, WorkspaceSnapshot } from '../../shared/types';

const heading = (level: number, text: string): RichContent => ({
  type: 'heading', attrs: { level }, content: text ? [{ type: 'text', text }] : [],
});
const details = (label: string, ...content: RichContent[]): RichContent => ({
  type: 'details', content: [
    { type: 'detailsSummary', content: [{ type: 'text', text: label }] },
    { type: 'detailsContent', content },
  ],
});
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const originalHeading = '설계 개요';
const editedHeading = '편집한 설계 개요';
const includedHeading = '포함한 원문의 절';
const repeatedHeading = '검토 항목';
const firstFold = '첫 번째 검토';
const secondFold = '두 번째 검토';
const nestedFold = '접힌 상세 검토';

async function openOutline(scope: Locator | Page) {
  const summary = scope.locator('summary').filter({ hasText: '문서 목차' });
  const outline = scope.getByRole('navigation', { name: '문서 제목', exact: true });
  await expect(summary).toBeVisible({ timeout: 25_000 });
  await expect(outline).toBeHidden();
  const bounds = await summary.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect(bounds ? bounds.x + bounds.width : 361).toBeLessThanOrEqual(360);
  await summary.click();
  await expect(outline).toBeVisible();
  return outline;
}

function section(scope: Locator, label: string) {
  return scope.locator('summary').filter({ hasText: label }).locator('..');
}

async function closeHeadingSections(scope: Locator) {
  // Fold the nested section while its summary is still visible.
  for (const label of [nestedFold, secondFold, firstFold]) {
    const target = section(scope, label);
    await expect(target).toHaveJSProperty('open', true);
    await target.locator(':scope > summary').click();
    await expect(target).toHaveJSProperty('open', false);
  }
}

async function jumpToSecondHeading(scope: Locator, outline: Locator) {
  const first = section(scope, firstFold);
  const second = section(scope, secondFold);
  const nested = section(scope, nestedFold);
  await expect(nested.getByRole('heading', { name: repeatedHeading, exact: true })).toBeHidden();
  await outline.getByRole('button', { name: `${repeatedHeading} (2/2)`, exact: true }).click();
  await expect(first).toHaveJSProperty('open', false);
  await expect(second).toHaveJSProperty('open', true);
  await expect(nested).toHaveJSProperty('open', true);
  await expect(nested.getByRole('heading', { name: repeatedHeading, exact: true })).toBeInViewport();
}

test('360px 문서 목차에서 같은 제목의 접힌 절로 이동하고 검토·발행·이력의 저장본 제목을 확인한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, reviewer] = workspace.users;
  const { id: projectId } = workspace.projects[0];
  const suffix = randomUUID().slice(0, 8);
  const authorHeaders = { 'X-Actor-Id': author.id };
  const created: DocPage[] = [];
  async function create(title: string, content: RichContent) {
    const response = await request.post('/api/documents', { headers: authorHeaders, data: { projectId, title, content } });
    expect(response.status(), await response.text()).toBe(201);
    const document = await response.json() as DocPage;
    created.push(document);
    return document;
  }

  try {
    const included = await create(`목차에 포함할 문서 ${suffix}`, body(heading(1, includedHeading)));
    const document = await create(`문서 목차 검증 ${suffix}`, body(
      heading(1, originalHeading),
      details(firstFold, heading(2, repeatedHeading)),
      { type: 'documentInclude', attrs: { documentId: included.id, label: included.title } },
      details(secondFold, details(nestedFold, heading(2, repeatedHeading))),
      heading(3, ''),
    ));
    const endpoint = `/api/documents/${document.id}/publication`;
    const initial = await (await request.get(endpoint, { headers: authorHeaders })).json() as DocumentPublicationView;
    const submitted = await request.post(endpoint, { headers: authorHeaders, data: {
      action: 'request', expectedVersion: initial.version, workspaceGeneration: initial.workspaceGeneration,
      expectedDocumentVersion: initial.documentVersion, reviewerId: reviewer.id,
    } });
    expect(submitted.status(), await submitted.text()).toBe(200);
    const review = await submitted.json() as DocumentPublicationView;
    expect(review.reviewRevision?.version).toBe(document.version);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/documents/${document.id}`);
    const editor = page.locator('.docs-prose');
    const topHeading = editor.getByRole('heading', { name: originalHeading, level: 1, exact: true });
    await expect(topHeading).toBeVisible({ timeout: 25_000 });
    await expect(editor.getByRole('heading', { name: includedHeading, level: 1, exact: true })).toBeVisible();
    const outline = await openOutline(page);
    await expect(outline.locator('.document-outline-entry')).toHaveText([originalHeading, `${repeatedHeading} (1/2)`, `${repeatedHeading} (2/2)`]);
    await closeHeadingSections(editor);

    await topHeading.click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('편집한 ');
    await expect(outline.getByRole('button', { name: editedHeading, exact: true })).toBeVisible();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    const selectedText = () => page.evaluate(() => window.getSelection()?.toString());
    expect(await selectedText()).toBe(editedHeading);
    await jumpToSecondHeading(editor, outline);
    expect(await selectedText()).toBe(editedHeading);

    const beforeSave = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(beforeSave.documents.find(item => item.id === document.id)).toMatchObject({
      version: document.version, content: document.content,
    });
    const saveResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}`) && response.request().method() === 'PATCH');
    await page.locator('.docs-save-button').click();
    const saved = await saveResponse;
    expect(saved.status(), await saved.text()).toBe(200);
    expect(await saved.json()).toMatchObject({ version: document.version + 1, plainText: expect.stringContaining(editedHeading) });
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

    await page.getByLabel('작업자 선택', { exact: true }).selectOption(reviewer.id);
    await page.getByRole('button', { name: '검토·발행', exact: true }).click();
    const publication = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    async function checkFixedCopy(kind: '검토' | '발행') {
      await publication.getByRole('button', { name: `${kind}본 불러오기`, exact: true }).click();
      const snapshot = publication.getByRole('region', { name: `${kind} 고정본 내용`, exact: true });
      const fixedOutline = await openOutline(snapshot);
      await expect(fixedOutline.locator('.document-outline-entry')).toHaveText([originalHeading, `${repeatedHeading} (1/2)`, `${repeatedHeading} (2/2)`]);
      await expect(snapshot.getByRole('heading', { name: editedHeading, exact: true })).toHaveCount(0);
      await expect(snapshot.locator('[contenteditable=true]')).toHaveCount(0);
      await closeHeadingSections(snapshot);
      await jumpToSecondHeading(snapshot, fixedOutline);
    }

    await checkFixedCopy('검토');
    await publication.getByLabel('검토 결과 메모', { exact: true }).fill('고정한 설계를 발행합니다.');
    const publishResponse = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'POST');
    await publication.getByRole('button', { name: '검토본 발행', exact: true }).click();
    const released = await publishResponse;
    expect(released.status(), await released.text()).toBe(200);
    const published = await released.json() as DocumentPublicationView;
    expect(published.publishedRevision?.id).toBe(review.reviewRevision?.id);
    await checkFixedCopy('발행');
    await publication.getByRole('button', { name: '검토·발행 닫기', exact: true }).click();

    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const information = page.getByRole('complementary', { name: '문서 상세 정보', exact: true });
    await information.getByRole('button', { name: '이력', exact: true }).click();
    await information.locator('.docs-revision').filter({ hasText: `버전 ${document.version}` }).click();
    const history = information.locator('.docs-history-preview');
    const historyOutline = await openOutline(history);
    await expect(historyOutline.locator('.document-outline-entry')).toHaveText([originalHeading, `${repeatedHeading} (1/2)`, `${repeatedHeading} (2/2)`]);
    await closeHeadingSections(history);
    await jumpToSecondHeading(history, historyOutline);
  } finally {
    for (const document of created.reverse()) {
      const response = await request.delete(`/api/documents/${document.id}`, { headers: authorHeaders });
      if (response.ok()) {
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers: authorHeaders });
      }
    }
  }
});

test('절 링크를 저장해 같은 제목의 정확한 절과 발행 당시 저장본을 연다', async ({ page, context, browser, request }) => {
  test.setTimeout(95_000);
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, reviewer] = workspace.users;
  const { id: projectId } = workspace.projects[0];
  const authorHeaders = { 'X-Actor-Id': author.id };
  const title = `절 링크 검증 ${randomUUID().slice(0, 8)}`;
  const sameTitle = '공유할 설계 절';
  const foldLabel = '접힌 두 번째 절';
  const source = await request.post('/api/documents', { headers: authorHeaders, data: { projectId, title, content: body(
    heading(2, sameTitle), details(foldLabel, heading(2, sameTitle)), { type: 'paragraph' },
  ) } });
  expect(source.status(), await source.text()).toBe(201);
  const document = await source.json() as DocPage;
  const apiPath = `/api/documents/${document.id}`;
  const route = `/#/${projectId}/documents/${document.id}`;
  const peerContext = await browser.newContext({ viewport: { width: 360, height: 820 } });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(route);
    const editor = page.locator('.docs-prose');
    const outline = await openOutline(page);
    const label = `${sameTitle} (2/2)`;
    await outline.getByRole('button', { name: `절 링크 만들기 ${label}`, exact: true }).click();
    const copy = outline.getByRole('button', { name: `절 링크 복사 ${label}`, exact: true });
    await expect(copy).toBeDisabled();
    const first = editor.locator(':scope > h2');
    const targetFold = section(editor, foldLabel);
    const target = targetFold.getByRole('heading', { name: sameTitle, exact: true });
    const id = await target.getAttribute('data-document-section-id');
    expect(isDocumentSectionId(id)).toBe(true);
    expect(await first.getAttribute('data-document-section-id')).toBeNull();
    const saving = page.waitForResponse(response => response.url().endsWith(apiPath) && response.request().method() === 'PATCH');
    await page.locator('.docs-save-button').click();
    const savedResponse = await saving;
    expect(savedResponse.status(), await savedResponse.text()).toBe(200);
    const saved = await savedResponse.json() as DocPage;
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(page.getByText('절 링크를 복사했습니다.', { exact: true })).toBeVisible();
    const href = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    expect(href.hash).toBe(documentSectionHash(document.id, id!, projectId));

    const publicationPath = `${apiPath}/publication`;
    const initial = await (await request.get(publicationPath, { headers: authorHeaders })).json() as DocumentPublicationView;
    const requested = await request.post(publicationPath, { headers: authorHeaders, data: {
      action: 'request', expectedVersion: initial.version, workspaceGeneration: initial.workspaceGeneration,
      expectedDocumentVersion: saved.version, reviewerId: reviewer.id,
    } });
    expect(requested.status(), await requested.text()).toBe(200);
    const review = await requested.json() as DocumentPublicationView;
    const publishedResponse = await request.post(publicationPath, { headers: { 'X-Actor-Id': reviewer.id }, data: {
      action: 'publish', expectedVersion: review.version, workspaceGeneration: review.workspaceGeneration,
    } });
    expect(publishedResponse.status(), await publishedResponse.text()).toBe(200);
    const published = await publishedResponse.json() as DocumentPublicationView;
    const publishedId = published.publishedRevision?.id;
    expect(publishedId).toBeTruthy();

    await editor.locator(':scope > p').last().click();
    await editor.evaluate((element, { id, hash }) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/html', `<h2 data-document-section-id="${id}">복사한 새 제목</h2><p><a href="${hash}">공유 절 열기</a></p>`);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, { id, hash: href.hash });
    const copiedHeading = editor.getByRole('heading', { name: '복사한 새 제목', exact: true });
    await expect(copiedHeading).toBeVisible();
    expect(await copiedHeading.getAttribute('data-document-section-id')).toBeNull();
    await expect(editor.locator(`[data-document-section-id="${id}"]`)).toHaveCount(1);
    await targetFold.locator(':scope > summary').click();
    await expect(targetFold).toHaveJSProperty('open', false);
    const draft = `${title} 미저장 제목`;
    const titleInput = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await titleInput.fill(draft);
    const prompts: string[] = [];
    page.on('dialog', confirmation => { prompts.push(confirmation.message()); void confirmation.dismiss(); });
    await editor.getByRole('link', { name: '공유 절 열기', exact: true }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe(href.hash);
    await expect(targetFold).toHaveJSProperty('open', true);
    await expect(target).toBeFocused();
    await expect(titleInput).toHaveValue(draft);
    await page.goBack();
    await expect.poll(() => new URL(page.url()).hash).toBe(route.slice(1));
    await expect(titleInput).toHaveValue(draft);
    await expect(copiedHeading).toBeVisible();
    expect(prompts).toEqual([]);

    const movedTitle = '옮긴 뒤 이름을 바꾼 설계 절';
    const moved: RichContent = { type: 'heading', attrs: { level: 3, sectionId: id }, content: [{ type: 'text', text: movedTitle }] };
    const movedResponse = await request.patch(apiPath, { headers: authorHeaders, data: {
      expectedVersion: saved.version, contentSchemaVersion: 7, content: body(heading(2, sameTitle), moved),
    } });
    expect(movedResponse.ok(), await movedResponse.text()).toBe(true);
    const peer = await peerContext.newPage();
    await peer.goto(href.href);
    await expect(peer.locator('.docs-prose').getByRole('heading', { name: movedTitle, level: 3, exact: true })).toBeFocused();

    const fixed = new URL(href);
    fixed.hash = documentSectionHash(document.id, id!, projectId, { kind: 'published', revisionId: publishedId! });
    await peer.goto(fixed.href);
    const dialog = peer.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    const snapshot = dialog.getByRole('region', { name: '발행 고정본 내용', exact: true });
    const fixedTarget = section(snapshot, foldLabel).getByRole('heading', { name: sameTitle, exact: true });
    await expect(fixedTarget).toBeFocused();
    await expect(snapshot.getByRole('heading', { name: movedTitle, exact: true })).toHaveCount(0);
    await peerContext.grantPermissions(['clipboard-read', 'clipboard-write']);
    const fixedOutline = await openOutline(snapshot);
    await fixedOutline.getByRole('button', { name: `절 링크 복사 ${label}`, exact: true }).click();
    await expect(snapshot.getByText('절 링크를 복사했습니다.', { exact: true })).toBeVisible();
    expect(new URL(await peer.evaluate(() => navigator.clipboard.readText())).hash).toBe(fixed.hash);

    const missing = new URL(href);
    missing.hash = documentSectionHash(document.id, 'deleted-section', projectId);
    await peer.goto(missing.href);
    await expect(peer.getByText('이 문서에서 연결된 절을 찾을 수 없습니다.', { exact: true })).toBeVisible();
    await expect(peer.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title);
  } finally {
    await peerContext.close();
    const deleted = await request.delete(apiPath, { headers: authorHeaders });
    if (deleted.ok()) {
      const { trashEntryId } = await deleted.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers: authorHeaders });
    }
  }
});

test('공동 편집 절 링크는 서버 ACK 뒤 복사할 수 있고 제목·단계 변경 뒤 같은 ID를 유지한다', async ({ page, request }) => {
  test.setTimeout(55_000);
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const { id: projectId } = workspace.projects[0];
  const authorHeaders = { 'X-Actor-Id': workspace.users[0].id };
  const headingTitle = '공동 검토할 설계';
  const response = await request.post('/api/documents', { headers: authorHeaders, data: {
    projectId, title: `공동 편집 절 링크 ${randomUUID().slice(0, 8)}`, content: body(heading(2, headingTitle)),
  } });
  expect(response.status(), await response.text()).toBe(201);
  const document = await response.json() as DocPage;
  const path = `/api/documents/${document.id}`;
  try {
    const enabled = await request.post(`${path}/collaboration/enable`, { headers: authorHeaders, data: { expectedVersion: document.version } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    let holdAck = false;
    const pending: { route: WebSocketRoute; message: string | Buffer }[] = [];
    await page.routeWebSocket('**/api/collaboration?*', route => {
      const server = route.connectToServer();
      server.onMessage(message => {
        if (holdAck && JSON.parse(String(message)).type === 'ack') pending.push({ route, message });
        else route.send(message);
      });
    });
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/documents/${document.id}`);
    const liveState = page.locator('.docs-collaboration-state');
    await expect(liveState).toHaveText('서버에 동기화됨');
    const outline = await openOutline(page);
    holdAck = true;
    await outline.getByRole('button', { name: `절 링크 만들기 ${headingTitle}`, exact: true }).click();
    const editor = page.locator('.docs-live-prose');
    const target = editor.getByRole('heading', { name: headingTitle, exact: true });
    const id = await target.getAttribute('data-document-section-id');
    expect(isDocumentSectionId(id)).toBe(true);
    async function storedHeading() {
      const { documents } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
      return documents.find(item => item.id === document.id)?.content.content?.[0];
    }
    await expect.poll(storedHeading).toMatchObject({ attrs: { sectionId: id, level: 2 } });
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    const copy = outline.getByRole('button', { name: `절 링크 복사 ${headingTitle}`, exact: true });
    await expect(copy).toBeDisabled();
    holdAck = false;
    for (const { route, message } of pending) route.send(message);
    await expect(liveState).toHaveText('서버에 동기화됨');
    await expect(copy).toBeEnabled();

    await target.click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('개정한 ');
    await page.getByRole('combobox', { name: '문단 서식', exact: true }).selectOption('h3');
    await expect(liveState).toHaveText('서버에 동기화됨');
    await expect(editor.getByRole('heading', { name: `개정한 ${headingTitle}`, level: 3, exact: true })).toHaveAttribute('data-document-section-id', id!);
    await expect.poll(storedHeading).toMatchObject({ attrs: { sectionId: id, level: 3 }, content: [{ type: 'text', text: `개정한 ${headingTitle}` }] });
  } finally {
    const deleted = await request.delete(path, { headers: authorHeaders });
    if (deleted.ok()) {
      const { trashEntryId } = await deleted.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers: authorHeaders });
    }
  }
});
