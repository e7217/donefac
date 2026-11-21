import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Response } from '@playwright/test';
import type { Comment, CommentEditResult, CommentEditSnapshot, DocPage, DocumentCommentReplyResult, DocumentSelectionCommentResult, Issue, User, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 }, hasTouch: true });

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const actor = (user: User) => ({ 'X-Actor-Id': user.id });

async function addComment(request: APIRequestContext, user: User, resourceType: Comment['resourceType'], resourceId: string, body: string) {
  return json<Comment>(await request.post('/api/comments', { headers: actor(user), data: { resourceType, resourceId, body } }), 201);
}

async function dispose(request: APIRequestContext, path: string, author: User) {
  const removed = await request.delete(path, { headers: actor(author) });
  if (!removed.ok()) return;
  const { trashEntryId } = await removed.json() as { trashEntryId: string };
  if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`, { headers: actor(author) });
}

async function openEdit(article: Locator, original: string, label: '댓글' | '답글' = '댓글') {
  await article.getByRole('button', { name: `${label} 수정`, exact: true }).click();
  const form = article.getByRole('form', { name: `${label} 수정`, exact: true });
  const field = form.getByRole('textbox', { name: `수정할 ${label}`, exact: true });
  await expect(field).toHaveValue(original);
  await expect(field).toBeEditable();
  return { form, field, save: form.getByRole('button', { name: '수정 저장', exact: true }) };
}

test('360px 업무 댓글에서 작성자가 충돌을 확인하고 같은 저장 요청의 응답 유실을 복구한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { projects: [project], users: [author, reviewer] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const issue = await json<Issue>(await request.post('/api/issues', { headers: actor(author), data: {
    projectId: project.id, title: `댓글 수정 검토 ${randomUUID().slice(0, 8)}`,
  } }), 201);
  try {
    const comment = await addComment(request, author, 'issue', issue.id, '긴급 연락 전에 확인할 내용');
    const otherComment = await addComment(request, reviewer, 'issue', issue.id, '다른 팀원이 작성한 동료 의견');
    const path = `/api/comments/${comment.id}`;
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), author.id);
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const article = panel.locator(`#issue-comment-${comment.id}`);
    const other = panel.locator(`#issue-comment-${otherComment.id}`);
    await expect(article).toBeVisible({ timeout: 30_000 });
    await expect(other).toBeVisible();
    await expect(other.getByRole('button', { name: '댓글 수정', exact: true })).toHaveCount(0);

    const newComment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    await newComment.fill('별도로 작성 중인 새 업무 댓글');
    const { form, field, save } = await openEdit(article, comment.body);
    const draft = '긴급 연락 전에 검토 순서를 문서에 남겼습니다.';
    const latest = '다른 탭에서 정리한 공지 초안입니다.';
    await field.fill(draft);
    const current = await json<CommentEditSnapshot>(await request.get(`${path}/edit`, { headers: actor(author) }));
    await json(await request.patch(path, { headers: actor(author), data: { editToken: current.editToken,
      requestId: randomUUID(), body: latest,
    } }));
    await save.click();
    await expect(form.getByRole('alert')).toBeVisible();
    await expect(field).toHaveValue(draft);
    await form.getByRole('button', { name: '현재 댓글 확인', exact: true }).click();
    await expect(form.getByText(latest, { exact: true })).toBeVisible();
    await expect(field).toHaveValue(draft);

    const attempts: unknown[] = [];
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      const committed = await json<CommentEditResult>(await route.fetch());
      expect(committed.comment.body).toBe(draft);
      expect(committed.duplicate).toBe(false);
      await route.abort('failed');
    });
    await save.click();
    await expect(form.getByRole('alert')).toContainText('수정 결과를 확인하지 못했습니다');
    await expect(field).toHaveValue(draft);
    const retry = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'PATCH');
    await form.getByRole('button', { name: '수정 결과 다시 확인', exact: true }).click();
    expect(await json(await retry)).toMatchObject({ comment: { id: comment.id, body: draft, editVersion: 2 }, duplicate: true });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(form).toHaveCount(0);
    await expect(article.getByText(draft, { exact: true })).toBeVisible();
    await expect(article.getByText('수정됨', { exact: true })).toBeVisible();
    await expect(article.getByRole('button', { name: '댓글 수정', exact: true })).toBeFocused();
    await expect(newComment).toHaveValue('별도로 작성 중인 새 업무 댓글');

    await page.unroute(`**${path}`);
    const second = await openEdit(article, draft);
    const committedBody = '공지에 적힌 확인 순서를 다시 정리했습니다.';
    await second.field.fill(committedBody);
    await page.route(`**${path}`, async route => {
      const result = await json<CommentEditResult>(await route.fetch());
      expect(result.comment.body).toBe(committedBody);
      await route.abort('failed');
    }, { times: 1 });
    await second.save.click();
    await expect(second.form.getByRole('alert')).toContainText('수정 결과를 확인하지 못했습니다');
    const savedAfterLoss = await json<CommentEditSnapshot>(await request.get(`${path}/edit`, { headers: actor(author) }));
    const newerBody = '다른 탭에서 증빙 첨부를 확인했습니다.';
    await json(await request.patch(path, { headers: actor(author), data: {
      editToken: savedAfterLoss.editToken, requestId: randomUUID(), body: newerBody,
    } }));
    await second.form.getByRole('button', { name: '수정 결과 다시 확인', exact: true }).click();
    await expect(second.form.getByRole('alert')).toContainText('수정은 저장됐습니다');
    await expect(second.form.getByText(newerBody, { exact: true })).toBeVisible();
    await expect(second.field).toHaveValue(committedBody);
    await expect(second.field).toBeEditable();
    await Promise.all([
      page.waitForEvent('dialog').then(dialog => dialog.accept()),
      second.form.getByRole('button', { name: '수정 취소', exact: true }).click(),
    ]);
    await expect(second.form).toHaveCount(0);
    await expect(article.getByText(newerBody, { exact: true })).toBeVisible();
    await expect(newComment).toHaveValue('별도로 작성 중인 새 업무 댓글');
  } finally {
    await dispose(request, `/api/issues/${issue.id}`, author);
  }
});

test('360px 문서의 전체 댓글과 발췌 댓글, 답글을 수정하고 원문과 답글 링크를 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { projects: [project], users: [author] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const quote = '작성한 원문과 증빙 파일을 기록한다.';
  const document = await json<DocPage>(await request.post('/api/documents', { headers: actor(author), data: {
    projectId: project.id, title: `문서 댓글 수정 ${randomUUID().slice(0, 8)}`, content: {
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: quote }] }],
    },
  } }), 201);
  const path = `/api/documents/${document.id}`;
  const url = `/#/${project.id}/documents/${document.id}`;
  try {
    const general = await addComment(request, author, 'document', document.id, '문서 전체에 남긴 의견');
    const { comment: root } = await json<DocumentSelectionCommentResult>(await request.post(`${path}/selection-comments`, {
      headers: actor(author), data: { requestId: randomUUID(), expectedDocumentVersion: document.version,
        sourceSelection: { from: 1, to: quote.length + 1, text: quote }, body: '발췌한 문장에 달린 의견' },
    }), 201);
    const { comment: reply } = await json<DocumentCommentReplyResult>(await request.post(`${path}/selection-comments/${root.id}/replies`, {
      headers: actor(author), data: { requestId: randomUUID(), expectedResolutionVersion: 0, body: '원문을 확인한 답글' },
    }), 201);
    const resolved = await json<Comment>(await request.patch(`${path}/selection-comments/${root.id}/resolution`, {
      headers: actor(author), data: { state: 'resolved', expectedVersion: 0 },
    }));
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), author.id);
    await page.goto(`${url}?comment=${reply.id}`);
    const rootArticle = page.locator(`#document-comment-${root.id}`);
    const replyArticle = rootArticle.locator(`#document-comment-${reply.id}`);
    await expect(replyArticle).toBeFocused({ timeout: 30_000 });
    await expect(rootArticle.getByText('해결됨', { exact: true })).toBeVisible();
    await expect(rootArticle.locator('blockquote')).toContainText(quote);
    const generalField = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    await generalField.fill('별도로 작성 중인 새 문서 댓글');
    const cases = [
      { article: rootArticle, label: '댓글', comment: root, draft: '발췌한 문장의 증빙 파일까지 확인했습니다.' },
      { article: replyArticle, label: '답글', comment: reply, draft: '원문과 증빙 파일 이름이 일치하는 것을 확인했습니다.' },
      { article: page.locator(`#document-comment-${general.id}`), label: '댓글', comment: general, draft: '문서 전체 표현을 수정할 필요가 있습니다.' },
    ] as const;
    for (const { article, label, comment, draft } of cases) {
      const { form, field, save } = await openEdit(article, comment.body, label);
      await field.fill(draft);
      await save.click();
      await expect(form).toHaveCount(0);
      await expect(article.getByText(draft, { exact: true })).toBeVisible();
      // The selection article also contains the reply, which may already have its own badge.
      await expect(article.getByText('수정됨', { exact: true }).first()).toBeVisible();
      await expect(generalField).toHaveValue('별도로 작성 중인 새 문서 댓글');
    }

    const comments = await json<Comment[]>(await request.get('/api/comments', {
      headers: actor(author), params: { resourceType: 'document', resourceId: document.id },
    }));
    expect(comments.find(comment => comment.id === root.id)).toMatchObject({
      id: root.id, documentSource: root.documentSource, resolution: resolved.resolution, editVersion: 1,
    });
    expect(comments.find(comment => comment.id === reply.id)).toMatchObject({ parentCommentId: root.id, editVersion: 1 });
    expect(comments.find(comment => comment.id === general.id)?.editVersion).toBe(1);
    const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace', { headers: actor(author) }));
    expect(workspace.documents.find(item => item.id === document.id)).toMatchObject({
      content: document.content, version: document.version,
    });

    const fresh = await page.context().newPage();
    try {
      await fresh.goto(`${url}?comment=${reply.id}`);
      const linkedRoot = fresh.locator(`#document-comment-${root.id}`);
      const linkedReply = linkedRoot.locator(`#document-comment-${reply.id}`);
      await expect(linkedReply).toBeFocused();
      await expect(linkedReply.getByText(cases[1].draft, { exact: true })).toBeVisible();
      await expect(linkedRoot.getByText('해결됨', { exact: true })).toBeVisible();
      await expect(linkedRoot.locator('blockquote')).toContainText(quote);
      expect(await fresh.locator('body').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(362);
    } finally {
      await fresh.close();
    }
  } finally {
    await dispose(request, path, author);
  }
});
