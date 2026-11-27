import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Dialog, type Page } from '@playwright/test';
import type { Comment, DocPage, DocumentCommentReplyResult, DocumentSelectionCommentResult, RichContent, TeamNotificationPage, User, WorkspaceSnapshot } from '../../shared/types';

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

test('360px 문서 댓글 검색은 발췌·작성자·답글을 찾고 작성 중인 답글과 정확한 댓글 이동을 보존한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [author, reviewer] } = await expectJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const quote = '측정 기준을 검증하고 결과를 남깁니다.';
  const source = await expectJson<DocPage>(await request.post('/api/documents', { headers: actor(author), data: {
    projectId: project.id, title: `댓글 검색 ${randomUUID().slice(0, 8)}`, content: documentBody(quote),
  } }), 201);
  const path = `/api/documents/${source.id}`;
  const documentHash = `#/${project.id}/documents/${source.id}`;
  try {
    const createAnchor = async (body: string) => (await expectJson<DocumentSelectionCommentResult>(
      await request.post(`${path}/selection-comments`, { headers: actor(author), data: {
        requestId: randomUUID(), expectedDocumentVersion: source.version,
        sourceSelection: { from: 1, to: quote.length + 1, text: quote }, body,
      } }), 201)).comment;
    const open = await createAnchor('팀에서 확인할 측정 항목입니다.');
    const closed = await createAnchor('별도의 처리 완료 항목입니다.');
    const { comment: reply } = await expectJson<DocumentCommentReplyResult>(await request.post(`${path}/selection-comments/${open.id}/replies`, {
      headers: actor(reviewer), data: { requestId: randomUUID(), expectedResolutionVersion: 0, body: 'Ｄｙｎａｍｉｃ 검증의 최종 기록입니다.' },
    }), 201);
    const plain = await expectJson<Comment>(await request.post('/api/comments', { headers: actor(author), data: {
      resourceType: 'document', resourceId: source.id, body: '문서 첫 화면의 일반 의견입니다.',
    } }), 201);
    await expectJson<Comment>(await request.patch(`${path}/selection-comments/${closed.id}/resolution`, {
      headers: actor(author), data: { state: 'resolved', expectedVersion: 0 },
    }));

    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), author.id);
    await page.goto(`/${documentHash}`);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const search = page.getByRole('searchbox', { name: '문서 댓글 검색', exact: true });
    const filters = filterButtons(page);
    const article = (comment: Comment) => page.locator(`#document-comment-${comment.id}`);
    const commentDraft = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    await expect(article(plain)).toBeVisible();
    await commentDraft.fill('보내지 않은 새 댓글');
    await search.fill('측정 기준');
    await expect(article(open)).toBeVisible();
    await expect(article(closed)).toBeVisible();
    await expect(article(plain)).toHaveCount(0);
    await filters.resolved.click();
    await expect(article(closed)).toBeVisible();
    await expect(article(open)).toHaveCount(0);
    await filters.all.click();
    await search.fill(`${reviewer.name}  DYNAMIC`);
    await expect(article(open)).toBeVisible();
    await expect(article(reply)).toBeVisible();
    await expect(article(closed)).toHaveCount(0);
    await expect(article(plain)).toHaveCount(0);

    await article(open).getByRole('button', { name: '답글 쓰기', exact: true }).click();
    const replyDraft = page.getByRole('textbox', { name: '답글 내용', exact: true });
    await replyDraft.fill('보내지 않은 답글');
    await search.fill('일반 의견');
    await expect(article(plain)).toBeVisible();
    await expect(replyDraft).toHaveValue('보내지 않은 답글');
    await expect(article(open).getByText('답글 작성 중', { exact: true })).toBeVisible();
    await expect(commentDraft).toHaveValue('보내지 않은 새 댓글');
    await page.getByRole('button', { name: '답글 닫기', exact: true }).click();
    await expect(article(open)).toHaveCount(0);

    await filters.resolved.click();
    await expect(page.getByText('검색 조건에 맞는 댓글이 없습니다.', { exact: true })).toBeVisible();
    await page.evaluate(hash => { window.location.hash = hash; }, `${documentHash}?comment=${encodeURIComponent(reply.id)}`);
    await expect(filters.open).toHaveAttribute('aria-pressed', 'true');
    await expect(search).toHaveValue('');
    await expect(article(reply)).toBeFocused();
    await expect(commentDraft).toHaveValue('보내지 않은 새 댓글');
    await article(open).getByRole('button', { name: '답글 쓰기', exact: true }).click();
    await expect(replyDraft).toHaveValue('보내지 않은 답글');
    expect(await page.locator('body').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(362);
  } finally {
    const removed = await request.delete(path, { headers: actor(author) });
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`, { headers: actor(author) });
    }
  }
});

test('360px 열린 문서 댓글에 팀원의 변경을 표시하고 본문과 새 댓글 초안을 보존한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  await page.clock.install();
  const { projects: [project], users: [author, reviewer] } = await expectJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const quote = '초기 도면을 기준으로 간섭을 검토합니다.';
  const source = await expectJson<DocPage>(await request.post('/api/documents', { headers: actor(author), data: {
    projectId: project.id, title: `댓글 동기화 ${randomUUID().slice(0, 8)}`, content: documentBody(quote),
  } }), 201);
  const path = `/api/documents/${source.id}`;
  const isCommentRead = (url: string) => {
    const address = new URL(url);
    return address.pathname === '/api/comments' && address.searchParams.get('resourceType') === 'document' &&
      address.searchParams.get('resourceId') === source.id;
  };
  let commentReads = 0;
  page.on('request', observed => {
    if (observed.method() === 'GET' && isCommentRead(observed.url())) commentReads++;
  });
  try {
    const { comment: thread } = await expectJson<DocumentSelectionCommentResult>(await request.post(`${path}/selection-comments`, {
      headers: actor(author), data: { requestId: randomUUID(), expectedDocumentVersion: source.version,
        sourceSelection: { from: 1, to: quote.length + 1, text: quote }, body: '동시에 검토할 문장 댓글' },
    }), 201);
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), author.id);
    await page.goto(`/#/${project.id}/documents/${source.id}`);
    const editor = page.locator('.docs-prose');
    await expect(editor).toHaveText(quote, { timeout: 30_000 });
    await editor.press('End');
    await page.keyboard.insertText(' 아직 저장하지 않은 검토 내용');
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const article = page.locator(`#document-comment-${thread.id}`);
    const draft = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    await expect(article).toBeVisible();
    await draft.fill('보내지 않은 댓글 초안');

    const incoming = await expectJson<Comment>(await request.post('/api/comments', { headers: actor(reviewer), data: {
      resourceType: 'document', resourceId: source.id, body: '동료가 다른 창에서 추가한 의견',
    } }), 201);
    await expect(page.locator(`#document-comment-${incoming.id}`)).toHaveCount(0);
    await page.clock.runFor(15_100);
    await expect(page.locator(`#document-comment-${incoming.id}`)).toBeVisible();
    await expect(draft).toHaveValue('보내지 않은 댓글 초안');
    await expect(draft).toBeFocused();
    await expect(editor).toHaveText(`${quote} 아직 저장하지 않은 검토 내용`);

    const filters = filterButtons(page);
    await filters.open.click();
    await article.getByRole('button', { name: '해결 처리', exact: true }).focus();
    await expectJson<Comment>(await request.patch(`${path}/selection-comments/${thread.id}/resolution`, {
      headers: actor(reviewer), data: { state: 'resolved', expectedVersion: 0 },
    }));
    await page.clock.runFor(15_100);
    await expect(article).toHaveCount(0);
    await expect(filters.open).toBeFocused();
    await filters.resolved.click();
    await expect(article.getByText('해결됨', { exact: true })).toBeVisible();

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenReads = commentReads;
    await page.clock.runFor(31_000);
    expect(commentReads).toBe(hiddenReads);
    const resumed = page.waitForResponse(response => response.request().method() === 'GET' && isCommentRead(response.url()));
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'visibilityState');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await resumed;
    await expect(draft).toHaveValue('보내지 않은 댓글 초안');
  } finally {
    const removed = await request.delete(path, { headers: actor(author) });
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers: actor(author) });
    }
  }
});

test('문서 댓글을 새로고침하는 동안 등록한 댓글을 보존하고 조회 실패 뒤 다시 읽는다', async ({ page, request }) => {
  const { projects: [project], users: [author] } = await expectJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const source = await expectJson<DocPage>(await request.post('/api/documents', { headers: actor(author), data: {
    projectId: project.id, title: `댓글 다시 읽기 ${randomUUID().slice(0, 8)}`, content: documentBody('검토 사항을 정리합니다.'),
  } }), 201);
  const path = `/api/documents/${source.id}`;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let nextRead: 'hold' | 'fail' | undefined;
  try {
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), author.id);
    await page.goto(`/#/${project.id}/documents/${source.id}`);
    const panel = page.getByRole('complementary', { name: '문서 상세 정보', exact: true });
    await expect(panel.getByText('아직 댓글이 없어요', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.route(url => url.pathname === '/api/comments' && url.searchParams.get('resourceId') === source.id, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const action = nextRead;
      nextRead = undefined;
      if (action === 'fail') return route.fulfill({ status: 503, json: { error: '댓글 조회를 다시 시도해 주세요.' } });
      if (action !== 'hold') return route.continue();
      const stale = await route.fetch();
      held.resolve();
      await release.promise;
      await route.fulfill({ response: stale }).catch(() => undefined);
      delivered.resolve();
    });
    const draft = panel.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    const refresh = panel.getByRole('button', { name: '댓글 새로고침', exact: true });
    await draft.fill('늦은 조회가 지우면 안 되는 댓글');
    nextRead = 'hold';
    await refresh.click();
    await held.promise;
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await panel.getByRole('button', { name: '댓글 남기기', exact: true }).click();
    const saved = panel.getByText('늦은 조회가 지우면 안 되는 댓글', { exact: true });
    await expect(saved).toHaveCount(1);
    await expect(refresh).toHaveAttribute('aria-busy', 'false');
    release.resolve();
    await delivered.promise;
    await expect(saved).toHaveCount(1);

    nextRead = 'fail';
    await refresh.click();
    await expect(panel.getByRole('alert').filter({ hasText: '댓글 조회를 다시 시도해 주세요.' })).toBeVisible();
    await expect(saved).toHaveCount(1);
    await expect(refresh).toBeFocused();
    await refresh.press('Enter');
    await expect(panel.getByRole('alert').filter({ hasText: '댓글 조회를 다시 시도해 주세요.' })).toHaveCount(0);
    await expect(saved).toHaveCount(1);
  } finally {
    release.resolve();
    const removed = await request.delete(path, { headers: actor(author) });
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers: actor(author) });
    }
  }
});

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

    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), author.id);
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
      localStorage.setItem('donefac.actor', id);
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

test('360px 문장 답글은 응답을 잃고 대화가 해결돼도 결과를 복구하고 같은 답글로 이동한다', async ({ page, request, browser, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [author, reviewer] } = await expectJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const quote = '보정 표준의 버전과 측정값을 같이 남긴다.';
  const updatedBody = '검토를 마친 뒤 본문을 정리했습니다.';
  const plainDraft = '보내지 않은 문서 전체 댓글';
  const replyBody = '보정 기록과 측정값을 같은 표에서 확인했습니다.';
  const document = await expectJson<DocPage>(await request.post('/api/documents', { headers: actor(author), data: {
    projectId: project.id, title: `답글 검증 ${randomUUID().slice(0, 8)}`, content: documentBody(quote),
  } }), 201);
  const path = `/api/documents/${document.id}`;
  const routeUrl = `/#/${project.id}/documents/${document.id}`;
  const authorContext = await browser.newContext({ baseURL, viewport: { width: 360, height: 820 } });
  try {
    const { comment: root } = await expectJson<DocumentSelectionCommentResult>(await request.post(`${path}/selection-comments`, {
      headers: actor(author), data: { requestId: randomUUID(), expectedDocumentVersion: document.version,
        sourceSelection: { from: 1, to: quote.length + 1, text: quote }, body: '표준과 측정값이 함께 있는지 확인해 주세요.' },
    }), 201);
    await expectJson<DocPage>(await request.patch(path, { headers: actor(author), data: {
      expectedVersion: document.version, content: documentBody(updatedBody),
    } }));
    const replyPath = `${path}/selection-comments/${root.id}/replies`;
    const attempts: unknown[] = [];
    let initialReply: Comment | undefined;
    await page.route(`**${replyPath}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length !== 1) return route.continue();
      const committed = await route.fetch();
      expect(committed.status(), await committed.text()).toBe(201);
      initialReply = (await committed.json() as DocumentCommentReplyResult).comment;
      await route.abort('failed');
    });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), reviewer.id);
    await page.goto(routeUrl);
    const editor = page.locator('.docs-prose');
    await expect(editor).toHaveText(updatedBody);
    await editor.press('End');
    await page.keyboard.insertText(' 미저장 본문');
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const article = page.locator(`#document-comment-${root.id}`);
    const general = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    await general.fill(plainDraft);
    await article.getByRole('button', { name: '답글 쓰기', exact: true }).click();
    const input = page.getByRole('textbox', { name: '답글 내용', exact: true });
    await input.fill(replyBody);
    await page.getByRole('button', { name: '답글 등록', exact: true }).click();
    const retry = page.getByRole('button', { name: '답글 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    expect(initialReply?.parentCommentId).toBe(root.id);
    await expect(input).toHaveValue(replyBody);
    const resolved = await expectJson<Comment>(await request.patch(`${path}/selection-comments/${root.id}/resolution`, {
      headers: actor(author), data: { state: 'resolved', expectedVersion: 0 },
    }));
    expect(resolved.resolution?.state).toBe('resolved');
    const handleBeforeUnload = async (dialog: Dialog) => {
      if (dialog.type() === 'beforeunload') await dialog.accept();
      else await dialog.dismiss();
    };
    page.on('dialog', handleBeforeUnload);
    await page.reload();
    page.off('dialog', handleBeforeUnload);
    const reopenPanel = page.getByRole('button', { name: '정보 패널 열기', exact: true });
    await expect(editor).toHaveText(`${updatedBody} 미저장 본문`);
    if (await reopenPanel.isVisible()) await reopenPanel.click();
    await expect(article.getByText('해결됨', { exact: true })).toBeVisible();
    await expect(general).toHaveValue(plainDraft);
    await article.getByRole('button', { name: '답글 결과 확인 열기', exact: true }).click();
    await expect(input).toHaveValue(replyBody);
    const result = page.waitForResponse(response => new URL(response.url()).pathname === replyPath && response.request().method() === 'POST');
    await retry.click();
    const replay = await expectJson<DocumentCommentReplyResult>(await result);
    expect(replay).toEqual({ comment: initialReply, duplicate: true });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const nestedReply = article.locator(`#document-comment-${replay.comment.id}`);
    await expect(nestedReply).toContainText(replyBody);
    await expect(article.getByRole('button', { name: '답글 쓰기', exact: true })).toHaveCount(0);
    await expect(general).toHaveValue(plainDraft);
    await expect(editor).toHaveText(`${updatedBody} 미저장 본문`);

    await authorContext.addInitScript(actorId => {
      localStorage.setItem('donefac.actor', actorId);
      let copied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (value: string) => { copied = value; }, readText: async () => copied,
      } });
    }, author.id);
    const peer = await authorContext.newPage();
    await peer.goto(routeUrl);
    await peer.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const filters = filterButtons(peer);
    await filters.open.click();
    await expect(peer.locator(`#document-comment-${root.id}`)).toHaveCount(0);
    await peer.getByRole('button', { name: '알림', exact: true }).click();
    const inbox = peer.getByRole('dialog', { name: '팀 알림', exact: true });
    await inbox.getByRole('button').filter({ hasText: document.title }).filter({ hasText: '문장 댓글 답글' }).click();
    await expect(filters.resolved).toHaveAttribute('aria-pressed', 'true');
    const peerRoot = peer.locator(`#document-comment-${root.id}`);
    const peerReply = peerRoot.locator(`#document-comment-${replay.comment.id}`);
    await expect(peerReply).toBeFocused();
    await expect(peerRoot.locator('blockquote')).toContainText(quote);
    await expect.poll(async () => (await expectJson<TeamNotificationPage>(await request.get('/api/notifications', {
      headers: actor(author),
    }))).items.find(item => item.commentId === replay.comment.id)?.readAt).toEqual(expect.any(String));

    await peerReply.getByRole('button', { name: '답글 링크 복사', exact: true }).click();
    const copied = await peer.evaluate(() => navigator.clipboard.readText());
    expect(new URL(copied).hash).toBe(`${routeUrl.slice(1)}?comment=${encodeURIComponent(replay.comment.id)}`);
    const fresh = await authorContext.newPage();
    await fresh.goto(copied);
    await expect(fresh.locator(`#document-comment-${replay.comment.id}`)).toBeFocused();
    expect(await fresh.locator('body').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(362);
  } finally {
    await authorContext.close();
    const removed = await request.delete(path, { headers: actor(author) });
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`, { headers: actor(author) });
    }
  }
});
