import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type WebSocketRoute } from '@playwright/test';
import type { CollaborationSession } from '../../shared/collaboration';
import type { Comment, DocPage, DocumentSelectionCommentResult, RichContent, WorkspaceSnapshot } from '../../shared/types';

const actionLabel = '선택한 본문에 댓글 남기기';
const content = (...children: RichContent[]): RichContent => ({ type: 'doc', content: children });
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function createDocument(request: APIRequestContext, projectId: string | null, title: string, body: RichContent): Promise<DocPage> {
  const response = await request.post('/api/documents', { data: { projectId, title, content: body } });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

async function cleanDocument(request: APIRequestContext, id: string) {
  const response = await request.delete(`/api/documents/${id}`);
  if (response.ok()) {
    const { trashEntryId } = await response.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

async function selectParagraph(editor: Locator, combineNext = false) {
  await editor.evaluate((element, acrossBlocks) => {
    const [first, second] = element.querySelectorAll(':scope > p');
    const selection = element.ownerDocument.getSelection();
    if (!first || !selection || (acrossBlocks && !second)) throw new Error('Expected document text selection');
    element.focus();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(first);
    if (acrossBlocks) range.setEnd(second, second.childNodes.length);
    selection.removeAllRanges();
    selection.addRange(range);
  }, combineNext);
}

test('360px 문장 댓글은 응답 유실을 복구하고 일반 댓글 초안과 예전 원문을 보존한다', async ({ page, request, browser, baseURL }) => {
  test.setTimeout(85_000);
  const { projects: [project] } = await workspace(request);
  const title = `원문에 남길 검토 ${randomUUID().slice(0, 8)}`;
  const mark = '측정 조건';
  const line = '을 먼저 정합니다.';
  const next = '검토 결과를 기록합니다.';
  const quote = `${mark}${line}\n${next}`;
  const originalOnly = '이 단락은 예전 저장본에만 있습니다.';
  const source = await createDocument(request, null, title, content(
    { type: 'paragraph', content: [{ type: 'text', text: mark, marks: [{ type: 'bold' }] }, { type: 'text', text: line }] },
    paragraph(next), paragraph(originalOnly),
  ));
  const route = `/#/${project.id}/documents/${source.id}`;
  const path = `/api/documents/${source.id}/selection-comments`;
  const text = '이 범위에서 단위를 명시해 주세요.';
  const priorDraft = '아직 보내지 않은 별도의 문서 전체 댓글';
  const unsavedTitle = `${title} 편집 중인 제목`;
  const attempts: unknown[] = [];
  const reader = await browser.newContext({ baseURL, viewport: { width: 360, height: 820 } });

  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(route);
    const editor = page.locator('.docs-prose');
    const action = page.getByRole('button', { name: actionLabel, exact: true });
    const titleInput = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(editor).toContainText(originalOnly, { timeout: 25_000 });
    await expect(action).toBeDisabled();
    await titleInput.fill(unsavedTitle);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const generalComment = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    await generalComment.fill(priorDraft);
    await page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();
    await selectParagraph(editor, true);
    await action.click();
    const dialog = page.getByRole('dialog', { name: actionLabel, exact: true });
    const input = dialog.getByRole('textbox', { name: '발췌 댓글', exact: true });
    await expect(input).toBeFocused();
    await expect(dialog.locator('blockquote')).toHaveText(quote);
    await expect(dialog).toBeInViewport();
    await input.fill(text);

    await page.route(`**${path}`, async routed => {
      if (routed.request().method() !== 'POST') return routed.continue();
      attempts.push(routed.request().postDataJSON());
      if (attempts.length === 1) {
        const serverResponse = await routed.fetch();
        expect(serverResponse.status(), await serverResponse.text()).toBe(201);
        await routed.abort('failed');
      } else await routed.continue();
    });
    await dialog.getByRole('button', { name: '발췌 댓글 등록', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('댓글 등록 결과를 확인하지 못했습니다');
    await expect(input).toHaveValue(text);
    const reply = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '댓글 결과 다시 확인', exact: true }).click();
    const replay = await reply;
    expect(replay.status(), await replay.text()).toBe(200);
    const saved = await replay.json() as DocumentSelectionCommentResult;
    expect(saved.duplicate).toBe(true);
    expect(saved.comment.documentSource?.text).toBe(quote);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(dialog).toHaveCount(0);
    const article = page.locator(`#document-comment-${saved.comment.id}`);
    await expect(article).toBeFocused();
    await expect(article.getByRole('region', { name: '댓글이 달린 본문' }).locator('blockquote')).toHaveText(quote);
    await expect(generalComment).toHaveValue(priorDraft);
    await expect(titleInput).toHaveValue(unsavedTitle);
    expect(new URL(page.url()).hash).toBe(route.slice(1));

    const changed = await request.patch(`/api/documents/${source.id}`, { data: {
      expectedVersion: source.version, title: '다른 작성자가 고친 제목', content: content(paragraph('현재 문서의 새 본문')),
    } });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const other = await reader.newPage();
    await other.goto(route);
    await expect(other.locator('.docs-prose')).toHaveText('현재 문서의 새 본문');
    await other.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const savedArticle = other.locator('.docs-comment').filter({ hasText: text });
    await expect(savedArticle).toHaveCount(1);
    await expect(savedArticle.locator('blockquote')).toHaveText(quote);
    const pinnedPath = `/api/documents/${source.id}/include-revisions/${saved.comment.documentSource!.revisionId}`;
    const pinnedReply = other.waitForResponse(response => response.url().endsWith(pinnedPath));
    await savedArticle.getByRole('button', { name: '원문 저장본 열기', exact: true }).click();
    expect((await pinnedReply).ok()).toBeTruthy();
    const original = savedArticle.getByRole('region', { name: `댓글 원문 저장본 ${title}`, exact: true });
    await expect(original.getByText(originalOnly, { exact: true })).toBeVisible();
    await expect(original.getByText(mark, { exact: true })).toHaveJSProperty('tagName', 'STRONG');
    const listed = await request.get(`/api/comments?resourceType=document&resourceId=${source.id}`);
    expect(await listed.json() as Comment[]).toEqual([saved.comment]);
  } finally {
    await reader.close();
    await cleanDocument(request, source.id);
  }
});

test('공동 편집 문장 댓글은 ACK를 기다리고 오래된 발췌를 거절한 뒤 재선택 입력을 복구한다', async ({ page, request, browser, baseURL }) => {
  test.setTimeout(85_000);
  const { projects: [project], users: [, peerActor] } = await workspace(request);
  const initial = '원래의 공동 편집 문장';
  const local = '저장 확인이 필요한 문장';
  const remote = '동료가 고친 최신 문장';
  const feedback = '이 문장에 시험 환경을 적어 주세요.';
  const source = await createDocument(request, project.id, `공동 검토 ${randomUUID().slice(0, 8)}`, content(paragraph(initial)));
  const apiPath = `/api/documents/${source.id}`;
  const route = `/#/${project.id}/documents/${source.id}`;
  const peerContext = await browser.newContext({ baseURL });
  let holdAck = false;
  const queued: { route: WebSocketRoute; message: string | Buffer }[] = [];

  try {
    const enabled = await request.post(`${apiPath}/collaboration/enable`, { data: { expectedVersion: source.version } });
    expect(enabled.ok(), await enabled.text()).toBeTruthy();
    await page.routeWebSocket('**/api/collaboration?*', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        if (holdAck && JSON.parse(String(message)).type === 'ack') queued.push({ route: socket, message });
        else socket.send(message);
      });
    });
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(route);
    const live = page.locator('.docs-collaboration-state');
    const editor = page.locator('.docs-live-prose');
    const action = page.getByRole('button', { name: actionLabel, exact: true });
    await expect(live).toHaveText('서버에 동기화됨');
    const peer = await peerContext.newPage();
    await peer.goto(route);
    await peer.getByLabel('작업자 선택', { exact: true }).selectOption(peerActor.id);
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');

    holdAck = true;
    await selectParagraph(editor);
    await page.keyboard.insertText(local);
    await expect(editor).toHaveText(local);
    await selectParagraph(editor);
    await expect.poll(() => queued.length).toBeGreaterThan(0);
    await expect(action).toBeDisabled();
    holdAck = false;
    for (const { route: socket, message } of queued.splice(0)) socket.send(message);
    await expect(live).toHaveText('서버에 동기화됨');
    await expect(action).toBeEnabled();
    await action.click();
    const dialog = page.getByRole('dialog', { name: actionLabel, exact: true });
    const box = dialog.getByRole('textbox', { name: '발췌 댓글', exact: true });
    await expect(dialog.locator('blockquote')).toHaveText(local);
    await box.fill(feedback);

    const peerEditor = peer.locator('.docs-live-prose');
    await expect(peerEditor).toHaveText(local);
    await selectParagraph(peerEditor);
    await peer.keyboard.insertText(remote);
    await expect(editor).toHaveText(remote);
    await expect.poll(async () => {
      const session = await request.get(`${apiPath}/collaboration`);
      return (await session.json() as CollaborationSession).document.plainText;
    }).toBe(remote);
    const waitForWrite = () => page.waitForResponse(response =>
      response.url().endsWith(`${apiPath}/selection-comments`) && response.request().method() === 'POST');
    const rejected = waitForWrite();
    await dialog.getByRole('button', { name: '발췌 댓글 등록', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('문서의 저장본이 변경됐습니다.');
    await expect(box).toHaveValue(feedback);
    const before = await request.get(`/api/comments?resourceType=document&resourceId=${source.id}`);
    expect(await before.json()).toEqual([]);

    await dialog.getByRole('button', { name: '본문 다시 선택', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await selectParagraph(editor);
    await action.click();
    await expect(box).toHaveValue(feedback);
    await expect(dialog.locator('blockquote')).toHaveText(remote);
    const accepted = waitForWrite();
    await dialog.getByRole('button', { name: '발췌 댓글 등록', exact: true }).click();
    const response = await accepted;
    expect(response.status(), await response.text()).toBe(201);
    const { comment } = await response.json() as DocumentSelectionCommentResult;
    expect(comment.documentSource?.text).toBe(remote);
    await expect(page.locator(`#document-comment-${comment.id}`)).toContainText(feedback);
  } finally {
    await peerContext.close();
    await cleanDocument(request, source.id);
  }
});
