import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type { Comment, DocPage, DocumentSelectionCommentResult, RichContent, TeamNotificationPage, User, WorkspaceSnapshot } from '../../shared/types';

const actor = ({ id }: User) => ({ 'X-Actor-Id': id });
const documentBody = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function expectJson<T>(response: APIResponse | Awaited<ReturnType<Page['waitForResponse']>>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

function filterButtons(page: Page) {
  const group = page.getByRole('group', { name: '문서 댓글 상태', exact: true });
  return {
    all: group.getByRole('button', { name: '전체', exact: true }),
    open: group.getByRole('button', { name: '미해결', exact: true }),
    resolved: group.getByRole('button', { name: '해결됨', exact: true }),
  };
}

test('360px에서 문장 댓글을 해결하고 멘션과 공유 링크로 원문을 찾아 다시 열며 동시 상태 변경을 확인한다', async ({ page, request, browser, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [author, reviewer] } = await expectJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const quote = '시험 온도와 허용 오차를 따로 기록합니다.';
  const currentText = '검토 의견을 반영해 본문을 다시 작성했습니다.';
  const document = await expectJson<DocPage>(await request.post('/api/documents', { headers: actor(author), data: {
    projectId: project.id, title: `문장 댓글 상태 확인 ${randomUUID().slice(0, 8)}`, content: documentBody(quote),
  } }), 201);
  const path = `/api/documents/${document.id}`;
  const documentRoute = `/#/${project.id}/documents/${document.id}`;
  const reviewerContext = await browser.newContext({ baseURL, viewport: { width: 360, height: 820 } });
  try {
    const general = await expectJson<Comment>(await request.post('/api/comments', { headers: actor(author), data: {
      resourceType: 'document', resourceId: document.id, body: '문서 전체의 제안입니다.',
    } }), 201);
    const selection = { from: 1, to: quote.length + 1, text: quote };
    const createAnchor = async (body: string, mentions?: Comment['mentions']) => (await expectJson<DocumentSelectionCommentResult>(
      await request.post(`${path}/selection-comments`, { headers: actor(author), data: {
        requestId: randomUUID(), expectedDocumentVersion: document.version, sourceSelection: selection, body, mentions,
      } }), 201)).comment;
    const mention = `@${reviewer.name}`;
    const pinned = await createAnchor(`${mention} 이 문장을 확인해 주세요.`, [{ from: 0, to: mention.length, userId: reviewer.id }]);
    const other = await createAnchor('추가 검토가 필요한 문장입니다.');
    await expectJson<DocPage>(await request.patch(path, { headers: actor(author), data: {
      expectedVersion: document.version, content: documentBody(currentText),
    } }));
    const resolutionPath = `${path}/selection-comments/${pinned.id}/resolution`;
    const waitForChange = (screen: Page) => screen.waitForResponse(response =>
      new URL(response.url()).pathname === resolutionPath && response.request().method() === 'PATCH');

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), author.id);
    await page.goto(documentRoute);
    const editor = page.locator('.docs-prose');
    await expect(editor).toHaveText(currentText, { timeout: 30_000 });
    const editing = ' 아직 저장하지 않은 본문 편집';
    await editor.press('End');
    await page.keyboard.insertText(editing);
    await expect(editor).toHaveText(`${currentText}${editing}`);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const filters = filterButtons(page);
    const commentDraft = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    const article = page.locator(`#document-comment-${pinned.id}`);
    const generalArticle = page.locator(`#document-comment-${general.id}`);
    await expect(filters.all).toHaveAttribute('aria-pressed', 'true');
    await expect(generalArticle).toHaveText(/문서 전체의 제안/);
    await expect(generalArticle.getByRole('button', { name: '해결 처리', exact: true })).toHaveCount(0);
    await commentDraft.fill('보내지 않은 문서 댓글 초안');
    await filters.open.click();
    await expect(generalArticle).toHaveCount(0);
    await expect(article.locator('blockquote')).toHaveText(quote);
    const resolvedResponse = waitForChange(page);
    await article.getByRole('button', { name: '해결 처리', exact: true }).click();
    const resolved = await expectJson<Comment>(await resolvedResponse);
    expect(resolved.resolution).toMatchObject({ state: 'resolved', version: 1, actorId: author.id });
    expect(resolved.documentSource).toEqual(pinned.documentSource);
    await expect(article).toHaveCount(0);
    await expect(filters.open).toBeFocused();
    await expect(page.locator(`#document-comment-${other.id}`)).toBeVisible();
    await expect(commentDraft).toHaveValue('보내지 않은 문서 댓글 초안');
    await expect(editor).toHaveText(`${currentText}${editing}`);
    await filters.resolved.click();
    await expect(article.getByText('해결됨', { exact: true })).toBeVisible();
    await expect(page.locator(`#document-comment-${other.id}`)).toHaveCount(0);

    await reviewerContext.addInitScript(id => {
      localStorage.setItem('teamspace.actor', id);
      let copied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (value: string) => { copied = value; }, readText: async () => copied,
      } });
    }, reviewer.id);
    const peer = await reviewerContext.newPage();
    await peer.goto(documentRoute);
    await peer.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const peerFilters = filterButtons(peer);
    const peerDraft = peer.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    const peerArticle = peer.locator(`#document-comment-${pinned.id}`);
    await peerDraft.fill('검토자 댓글 초안');
    await peerFilters.open.click();
    await expect(peerArticle).toHaveCount(0);
    await peer.getByRole('button', { name: '알림', exact: true }).click();
    const inbox = peer.getByRole('dialog', { name: '팀 알림', exact: true });
    await inbox.getByRole('button').filter({ hasText: document.title }).filter({ hasText: '문서 댓글에서 멘션' }).click();
    await expect(peerFilters.resolved).toHaveAttribute('aria-pressed', 'true');
    await expect(peerArticle).toBeFocused();
    await expect(peerArticle.locator('blockquote')).toHaveText(quote);
    await expect(peerArticle.getByText(mention, { exact: true })).toBeVisible();
    await expect(peerDraft).toHaveValue('검토자 댓글 초안');
    await expect.poll(async () => (await expectJson<TeamNotificationPage>(await request.get('/api/notifications', { headers: actor(reviewer) })))
      .items.find(item => item.commentId === pinned.id)?.readAt).toEqual(expect.any(String));

    await peerArticle.getByRole('button', { name: '댓글 링크 복사', exact: true }).click();
    const permalink = await peer.evaluate(() => navigator.clipboard.readText());
    expect(new URL(permalink).hash).toBe(`${documentRoute.slice(1)}?comment=${encodeURIComponent(pinned.id)}`);
    const fresh = await reviewerContext.newPage();
    try {
      await fresh.goto(permalink);
      const deepLinked = fresh.locator(`#document-comment-${pinned.id}`);
      await expect(deepLinked).toBeFocused();
      await expect(deepLinked.locator('blockquote')).toHaveText(quote);
      await fresh.goto(`${documentRoute}?comment=${randomUUID()}`);
      await expect(fresh.getByRole('status').filter({ hasText: '이동할 댓글을 찾을 수 없습니다.' })).toBeVisible();
      await expect(fresh.getByRole('heading', { name: '팀과 이야기하기', exact: true })).toBeFocused();
    } finally {
      await fresh.close();
    }

    const reopenedResponse = waitForChange(peer);
    await peerArticle.getByRole('button', { name: '다시 열기', exact: true }).click();
    const reopened = await expectJson<Comment>(await reopenedResponse);
    expect(reopened.resolution).toMatchObject({ state: 'open', version: 2, actorId: reviewer.id });
    await expect(peerArticle).toHaveCount(0);
    await peerFilters.open.click();
    await expect(peerArticle.getByText('미해결', { exact: true })).toBeVisible();

    await expectJson<Comment>(await request.patch(resolutionPath, { headers: actor(author), data: { state: 'resolved', expectedVersion: 2 } }));
    const staleResponse = waitForChange(peer);
    await peerArticle.getByRole('button', { name: '해결 처리', exact: true }).click();
    expect((await staleResponse).status()).toBe(409);
    await expect(peer.getByRole('alert').filter({ hasText: '최신 상태를 확인해 주세요.' })).toBeVisible();
    await expect(peerArticle).toHaveCount(0);
    await expect(peerDraft).toHaveValue('검토자 댓글 초안');
    await peerFilters.resolved.click();
    await expect(peerArticle.locator('blockquote')).toHaveText(quote);
  } finally {
    await reviewerContext.close();
    const removed = await request.delete(path, { headers: actor(author) });
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers: actor(author) });
    }
  }
});
