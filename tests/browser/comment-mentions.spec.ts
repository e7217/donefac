import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Comment, DocPage, DocumentSelectionCommentResult, Issue, TeamNotificationPage, User, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 }, hasTouch: true });

async function json<T>(response: Awaited<ReturnType<Page['waitForResponse']>> | APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const actor = (user: User) => ({ 'X-Actor-Id': user.id });

async function teammate(request: APIRequestContext, name: string) {
  const email = `${randomUUID()}@example.test`;
  return json<User>(await request.post('/api/users', { data: { name, email } }), 201);
}

async function inbox(request: APIRequestContext, user: User) {
  const result = await json<TeamNotificationPage>(await request.get('/api/notifications', { headers: actor(user) }));
  return result.items;
}

async function addMention(page: Page, field: Locator, user: User, prefix = '', touch = false) {
  await field.focus();
  await field.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length));
  await page.keyboard.insertText(`${prefix}@${user.email}`);
  const choices = page.getByRole('listbox', { name: '팀원 멘션', exact: true });
  const option = choices.getByRole('option').filter({ hasText: user.email });
  await expect(option).toBeVisible();
  if (touch) await option.tap();
  else await field.press('Enter');
  await expect(choices).toBeHidden();
  expect(await field.inputValue()).toContain(`@${user.name}`);
}

async function openNotification(page: Page, label: string, target: string) {
  await page.getByRole('button', { name: '알림', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '팀 알림', exact: true });
  await panel.getByRole('button').filter({ hasText: target }).filter({ hasText: label }).first().click();
}

async function dispose(request: APIRequestContext, path: string) {
  const response = await request.delete(path);
  if (response.ok()) {
    const { trashEntryId } = await response.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

test('360px 업무 댓글에서 동명이인을 이메일로 구분하고 멘션 알림에서 해당 댓글을 연다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { projects: [project], users: [author] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const name = `멘션 검토 ${randomUUID().slice(0, 8)}`;
  const recipient = await teammate(request, name);
  const lookalike = await teammate(request, name);
  const issue = await json<Issue>(await request.post('/api/issues', {
    headers: actor(author), data: { projectId: project.id, title: `${name} 업무`, assigneeId: recipient.id },
  }), 201);
  try {
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), author.id);
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: issue.title, exact: true });
    const field = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    await expect(field).toBeVisible({ timeout: 30_000 });
    await field.fill(`🙂 검토 부탁 @${name}`);
    const choices = page.getByRole('listbox', { name: '팀원 멘션' });
    await expect(choices.getByRole('option')).toHaveCount(2);
    await field.press('Escape');
    await expect(choices).toBeHidden();
    await expect(panel).toBeVisible();
    await field.fill('');
    await addMention(page, field, recipient, '  🙂 검토 부탁 ');
    await addMention(page, field, recipient, '그리고 ', true);
    await addMention(page, field, lookalike, '텍스트로 남길 이름 ');
    await field.evaluate((element: HTMLTextAreaElement, token) => {
      const start = element.value.lastIndexOf(token);
      element.setSelectionRange(start, start + token.length);
    }, `@${name}`);
    await page.keyboard.insertText(`@${name} 확인`);

    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'POST');
    await panel.getByRole('button', { name: '댓글 등록', exact: true }).click();
    const comment = await json<Comment>(await saved, 201);
    const mentions = comment.mentions!;
    expect(comment.body.startsWith('🙂')).toBeTruthy();
    expect(mentions.map(mention => mention.userId)).toEqual([recipient.id, recipient.id]);
    for (const { from, to } of mentions) expect(comment.body.slice(from, to)).toBe(`@${name}`);
    const article = panel.locator(`#issue-comment-${comment.id}`);
    await expect(article.locator('.comment-mention-text')).toHaveCount(2);

    const issueCommentAlerts = (await inbox(request, recipient)).filter(item => item.targetId === issue.id && item.kind.includes('comment'));
    expect(issueCommentAlerts).toHaveLength(1);
    expect(issueCommentAlerts[0]).toMatchObject({ kind: 'issue-comment-mentioned', commentId: comment.id, readAt: null });
    expect((await inbox(request, lookalike)).some(item => item.targetId === issue.id)).toBeFalsy();
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(recipient.id);
    await openNotification(page, '업무 댓글에서 멘션', issue.title);
    await expect(article).toBeFocused();
    await expect.poll(async () => (await inbox(request, recipient)).find(item => item.commentId === comment.id)?.readAt).toEqual(expect.any(String));

    const followUp = await json<Comment>(await request.post('/api/comments', { headers: actor(author), data: {
      resourceType: 'issue', resourceId: issue.id, body: `@${name} 추가 확인`, mentions: [{ userId: recipient.id, from: 0, to: name.length + 1 }],
    } }), 201);
    await panel.getByRole('button', { name: '작업 시간', exact: true }).click();
    const draft = panel.getByRole('textbox', { name: '작업 기록 내용', exact: true });
    await draft.fill('아직 저장하지 않은 작업 시간 메모');
    await page.getByRole('button', { name: '알림', exact: true }).press('Enter');
    const alerts = page.getByRole('dialog', { name: '팀 알림', exact: true });
    const latest = alerts.getByRole('button').filter({ hasText: issue.title }).filter({ hasText: '업무 댓글에서 멘션' }).first();
    await Promise.all([page.waitForEvent('dialog').then(dialog => dialog.dismiss()), latest.press('Enter')]);
    await expect(draft).toHaveValue('아직 저장하지 않은 작업 시간 메모');
    expect((await inbox(request, recipient)).find(item => item.commentId === followUp.id)?.readAt).toBeNull();

    await Promise.all([page.waitForEvent('dialog').then(dialog => dialog.accept()), latest.press('Enter')]);
    await expect(panel.locator(`#issue-comment-${followUp.id}`)).toBeFocused();
    await expect.poll(async () => (await inbox(request, recipient)).find(item => item.commentId === followUp.id)?.readAt).toEqual(expect.any(String));
  } finally {
    await dispose(request, `/api/issues/${issue.id}`);
  }
});

test('360px에서 문서 댓글 초안의 멘션과 문장 댓글 재시도를 보존하고 서로 다른 원래 댓글로 이동한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { projects: [project], users: [author] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `문서 멘션 ${randomUUID().slice(0, 8)}`;
  const recipient = await teammate(request, `${prefix} 검토자`);
  const paragraph = '새 장비의 시험 기준 온도를 확인한다.';
  const doc = await json<DocPage>(await request.post('/api/documents', {
    headers: actor(author), data: { projectId: project.id, title: `${prefix} 시험 기록`,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: paragraph }] }] } },
  }), 201);
  try {
    await page.addInitScript(id => {
      if (!localStorage.getItem('teamspace.actor')) localStorage.setItem('teamspace.actor', id);
    }, author.id);
    await page.goto(`/#/${project.id}/documents/${doc.id}`);
    const editor = page.locator('.docs-prose');
    await expect(editor).toHaveText(paragraph, { timeout: 30_000 });
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const draft = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    await addMention(page, draft, recipient, '문서 검토 ');
    const draftText = await draft.inputValue();
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(editor).toHaveText(paragraph, { timeout: 30_000 });
    if (!(await draft.isVisible())) await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await expect(draft).toHaveValue(draftText);
    const generalResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'POST');
    await page.getByRole('button', { name: '댓글 남기기', exact: true }).click();
    const general = await json<Comment>(await generalResponse, 201);
    expect(general.mentions?.map(mention => mention.userId)).toEqual([recipient.id]);
    await page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();

    await editor.evaluate(element => {
      const paragraphNode = element.querySelector('p')!;
      const range = element.ownerDocument.createRange();
      element.focus();
      range.selectNodeContents(paragraphNode);
      const selection = element.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const actionLabel = '선택한 본문에 댓글 남기기';
    await page.getByRole('button', { name: actionLabel, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: actionLabel, exact: true });
    await addMention(page, dialog.getByRole('textbox', { name: '발췌 댓글', exact: true }), recipient, '온도 확인 ');
    const path = `/api/documents/${doc.id}/selection-comments`;
    const attempts: unknown[] = [];
    await page.route(`**${path}`, async routed => {
      if (routed.request().method() !== 'POST') return routed.continue();
      attempts.push(routed.request().postDataJSON());
      if (attempts.length > 1) return routed.continue();
      const result = await routed.fetch();
      expect(result.status(), await result.text()).toBe(201);
      await routed.abort('failed');
    });
    await dialog.getByRole('button', { name: '발췌 댓글 등록', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('댓글 등록 결과를 확인하지 못했습니다');
    const replay = page.waitForResponse(response => new URL(response.url()).pathname === path);
    await dialog.getByRole('button', { name: '댓글 결과 다시 확인', exact: true }).click();
    const { comment: pinned, duplicate } = await json<DocumentSelectionCommentResult>(await replay);
    expect(duplicate).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(pinned.mentions?.map(mention => mention.userId)).toEqual([recipient.id]);
    expect(pinned.documentSource?.text).toBe(paragraph);
    await expect(dialog).toHaveCount(0);

    const directAlerts = (await inbox(request, recipient)).filter(item => item.targetId === doc.id);
    expect(directAlerts.map(item => [item.kind, item.commentId])).toEqual([
      ['document-comment-mentioned', pinned.id], ['document-comment-mentioned', general.id],
    ]);
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(recipient.id);
    if (await draft.isVisible()) await page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();
    await openNotification(page, '문서 댓글에서 멘션', doc.title);
    const pinnedArticle = page.locator(`#document-comment-${pinned.id}`);
    await expect(pinnedArticle).toBeFocused();
    await expect(pinnedArticle.locator('blockquote')).toHaveText(paragraph);
    await expect.poll(async () => (await inbox(request, recipient)).find(item => item.commentId === pinned.id)?.readAt).toEqual(expect.any(String));
    await page.getByRole('button', { name: '알림', exact: true }).click();
    const alerts = page.getByRole('dialog', { name: '팀 알림', exact: true });
    await alerts.getByRole('button', { name: '읽지 않음', exact: true }).click();
    await alerts.getByRole('button').filter({ hasText: doc.title }).filter({ hasText: '문서 댓글에서 멘션' }).click();
    await expect(page.locator(`#document-comment-${general.id}`)).toBeFocused();
    await expect.poll(async () => (await inbox(request, recipient)).find(item => item.commentId === general.id)?.readAt).toEqual(expect.any(String));
  } finally {
    await dispose(request, `/api/documents/${doc.id}`);
  }
});
