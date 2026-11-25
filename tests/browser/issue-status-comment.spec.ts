import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Comment, Issue, IssueStatusChangeRequest, IssueStatusChangeResult, TeamNotificationPage, User, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 } });

const actor = (user: User) => ({ 'X-Actor-Id': user.id });
const button = (scope: Page | Locator, name: string) => scope.getByRole('button', { name, exact: true });
const issuePath = (issue: Issue) => `/api/issues/${issue.id}`;
const commentPath = (issue: Issue) => `/api/comments?${new URLSearchParams({ resourceType: 'issue', resourceId: issue.id })}`;
const transitionPath = (issue: Issue) => `${issuePath(issue)}/status-change`;

async function json<T>(response: APIResponse, expectedStatus = 200) {
  expect(response.status(), await response.text()).toBe(expectedStatus);
  return await response.json() as T;
}

async function fixture(request: APIRequestContext) {
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [project], users: [owner, peer] } = await workspace();
  const title = `인수인계 상태 변경 ${randomUUID().slice(0, 8)}`;
  const issue = await json<Issue>(await request.post('/api/issues', { headers: actor(owner), data: {
    projectId: project.id, title, status: 'todo',
  } }), 201);
  return { issue, owner, peer,
    async close() {
      const removed = await request.delete(issuePath(issue), { headers: actor(owner) });
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json()).trashEntryId}`, { headers: actor(owner) });
    },
  };
}

async function openChange(page: Page, issue: Issue, author: User, mode: 'teamboard' | 'issues') {
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), author.id);
  const query = mode === 'teamboard' ? `?${new URLSearchParams({ boardQuery: issue.title })}` : '';
  await page.goto(`/#/${issue.projectId}/${mode}${query}`);
  const row = page.locator(`[data-issue-id="${issue.id}"]`);
  await button(row, `${issue.key} 상태 변경`).click();
  const dialog = page.getByRole('dialog', { name: '업무 상태 변경', exact: true });
  await expect(dialog).toBeVisible();
  return { dialog,
    target: dialog.getByRole('combobox', { name: '변경할 상태', exact: true }),
    note: dialog.getByRole('textbox', { name: '인수인계 댓글', exact: true }),
    apply: button(dialog, '상태 변경 적용'),
    retry: button(dialog, '저장 결과 다시 확인'),
  };
}

test('360px 팀 보드에서 상태·담당자·멘션 댓글을 함께 저장하고 응답 유실 뒤 같은 댓글을 확인한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  const { issue, owner, peer } = f;
  const submitted: IssueStatusChangeRequest[] = [];
  const results: IssueStatusChangeResult[] = [];
  let responseMode: 'lost' | 'unauthorized' | 'normal' = 'lost';
  try {
    const { dialog, target, note, apply, retry } = await openChange(page, issue, owner, 'teamboard');
    await target.selectOption('in_progress');
    await dialog.getByRole('combobox', { name: '담당자', exact: true }).selectOption(`user:${peer.id}`);
    await note.fill(`다음 검토 부탁합니다 @${peer.email}`);
    const option = dialog.getByRole('listbox', { name: '팀원 멘션', exact: true }).getByRole('option').filter({ hasText: peer.email });
    await expect(option).toBeVisible();
    await note.press('Enter');
    await expect(note).toHaveValue(`다음 검토 부탁합니다 @${peer.name} `);
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

    const askDiscard = page.waitForEvent('dialog').then(async prompt => {
      await prompt.dismiss();
      return prompt.message();
    });
    await button(dialog, '취소').click();
    expect(await askDiscard).toContain('댓글');
    await expect(note).toHaveValue(`다음 검토 부탁합니다 @${peer.name} `);

    await page.route(`**${transitionPath(issue)}`, async route => {
      submitted.push(route.request().postDataJSON() as IssueStatusChangeRequest);
      if (responseMode === 'unauthorized') {
        await route.fulfill({ status: 401, json: { error: 'synthetic session expired' } });
        return;
      }
      const response = await route.fetch();
      const result = await json<IssueStatusChangeResult>(response);
      results.push(result);
      if (submitted.length === 1) {
        await json<Issue>(await request.patch(issuePath(issue), { headers: actor(peer), data: {
          expectedVersion: result.issue.version, status: 'review',
        } }));
      }
      if (responseMode === 'lost') await route.fulfill({ status: 503, json: { error: 'synthetic lost response' } });
      else await route.fulfill({ response });
    });
    await apply.click();
    await expect(retry).toBeVisible();
    const liveBeforeRetry = await json<Comment[]>(await request.get(commentPath(issue)));
    expect(liveBeforeRetry).toHaveLength(1);
    expect(liveBeforeRetry[0]).toMatchObject({ authorId: owner.id, body: `다음 검토 부탁합니다 @${peer.name}`,
      mentions: [expect.objectContaining({ userId: peer.id })] });
    await expect(note).toHaveValue(`다음 검토 부탁합니다 @${peer.name} `);
    responseMode = 'unauthorized';
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === transitionPath(issue) && response.status() === 401);
    await retry.click();
    await denied;
    await expect(retry).toBeEnabled();
    await expect(note).toHaveValue(`다음 검토 부탁합니다 @${peer.name} `);
    responseMode = 'normal';
    await retry.click();
    await expect(dialog).toHaveCount(0);
    expect(submitted).toHaveLength(3);
    for (const payload of submitted) expect(payload).toEqual(submitted[0]);
    const first = results[0];
    const recovered = results.at(-1)!;
    expect(first).toMatchObject({ duplicate: false, issue: { status: 'in_progress', assigneeId: peer.id },
      receipt: { requestId: submitted[0].requestId, commentId: liveBeforeRetry[0].id, appliedVersion: issue.version + 1 } });
    expect(recovered).toMatchObject({ duplicate: true, receipt: first.receipt, issue: { status: 'review', version: issue.version + 2 } });
    expect(await json<Comment[]>(await request.get(commentPath(issue)))).toEqual(liveBeforeRetry);
    const inbox = await json<TeamNotificationPage>(await request.get('/api/notifications', { headers: actor(peer) }));
    expect(inbox.items.filter(item => item.kind === 'issue-comment-mentioned' && item.commentId === first.receipt.commentId)).toHaveLength(1);
    await button(page, `${issue.key} 업무 열기`).click();
    const detail = page.getByRole('dialog', { name: issue.title, exact: true });
    await expect(detail.locator(`#issue-comment-${first.receipt.commentId}`)).toContainText(`@${peer.name}`);
  } finally { await f.close(); }
});

test('360px 프로젝트 목록에서 동료가 같은 상태를 먼저 저장해도 인수인계 댓글을 보존한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const f = await fixture(request);
  const { issue, owner, peer } = f;
  const submissions: IssueStatusChangeRequest[] = [];
  const text = '이 댓글을 작성한 상태 변경은 아직 저장되지 않았습니다.';
  try {
    const { dialog, target, note, apply, retry } = await openChange(page, issue, owner, 'issues');
    await target.selectOption('in_progress');
    await note.fill(text);
    await page.route(`**${transitionPath(issue)}`, async route => {
      submissions.push(route.request().postDataJSON() as IssueStatusChangeRequest);
      if (submissions.length > 1) return route.continue();
      await json<Issue>(await request.patch(issuePath(issue), { headers: actor(peer), data: {
        expectedVersion: issue.version, status: 'in_progress',
      } }));
      await route.fulfill({ status: 503, json: { error: 'synthetic lost response before mutation' } });
    });
    await apply.click();
    const reload = button(dialog, '최신 업무 불러오기');
    await expect(retry.or(reload)).toBeVisible();
    if (await retry.isVisible()) await retry.click();
    await expect(reload).toBeVisible();
    await expect(note).toHaveValue(text);
    expect(await json<Comment[]>(await request.get(commentPath(issue)))).toEqual([]);

    await reload.click();
    await expect(note).toHaveValue(text);
    await expect(target).toBeEnabled();
    await expect(target.locator('option[value="in_progress"]')).toHaveCount(0);
    await target.selectOption('review');
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === transitionPath(issue) && response.status() === 200);
    await apply.click();
    const response = await saved;
    const result = await response.json() as IssueStatusChangeResult;
    expect(result).toMatchObject({ duplicate: false, issue: { status: 'review', version: issue.version + 2 } });
    expect(submissions.at(-1)?.requestId).not.toBe(submissions[0].requestId);
    expect(submissions.at(-1)?.expectedVersion).toBe(issue.version + 1);
    const comments = await json<Comment[]>(await request.get(commentPath(issue)));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: result.receipt.commentId, body: text, authorId: owner.id });
    await expect(dialog).toHaveCount(0);
  } finally { await f.close(); }
});

test('360px 팀 보드에서 동료의 최신 담당자와 인수인계 입력을 비교한 뒤 상태를 바꾼다', async ({ page, request }) => {
  const f = await fixture(request);
  const { issue, owner, peer } = f;
  const text = '다음 담당자에게 검토 내용을 넘깁니다.';
  try {
    expect(issue.assigneeId).toBeNull();
    const { dialog, target, note, apply } = await openChange(page, issue, owner, 'teamboard');
    const assignee = dialog.getByRole('combobox', { name: '담당자', exact: true });
    const latest = button(dialog, '최신 업무 불러오기');
    const storedValue = button(dialog, '담당자 저장값 사용');
    const inputValue = button(dialog, '담당자 입력값 사용');
    const waitForTransition = () => page.waitForResponse(response => new URL(response.url()).pathname === transitionPath(issue));
    async function applyOverPeerChange() {
      const transition = waitForTransition();
      await apply.click();
      expect((await transition).status()).toBe(409);
      await latest.click();
      await expect(storedValue).toBeVisible();
    }

    await target.selectOption('in_progress');
    await assignee.selectOption(`user:${owner.id}`);
    const discard = page.waitForEvent('dialog').then(async prompt => {
      await prompt.dismiss();
      return prompt.message();
    });
    await button(dialog, '취소').click();
    expect(await discard).toContain('업무 변경');
    await expect(assignee).toHaveValue(`user:${owner.id}`);
    const peerAssigned = await json<Issue>(await request.patch(issuePath(issue), { headers: actor(peer), data: {
      expectedVersion: issue.version, assigneeId: peer.id,
    } }));
    await applyOverPeerChange();
    await expect(assignee).toHaveValue(`user:${owner.id}`);
    await expect(dialog.locator('.issue-status-property-conflict blockquote')).toHaveText(peer.name);
    await target.selectOption('in_progress');
    await expect(apply).toBeDisabled();
    await storedValue.click();
    await expect(assignee).toHaveValue(`user:${peer.id}`);

    await note.fill(text);
    const peerCleared = await json<Issue>(await request.patch(issuePath(issue), { headers: actor(peer), data: {
      expectedVersion: peerAssigned.version, assigneeId: null,
    } }));
    await applyOverPeerChange();
    await expect(note).toHaveValue(text);
    await expect(dialog.locator('.issue-status-property-conflict blockquote')).toHaveText('미지정');
    await target.selectOption('in_progress');
    await expect(apply).toBeDisabled();
    expect(await json<Comment[]>(await request.get(commentPath(issue)))).toEqual([]);
    await inputValue.click();
    const saved = waitForTransition();
    await apply.click();
    const response = await saved;
    expect(response.request().postDataJSON()).toMatchObject({ expectedVersion: peerCleared.version, assigneeId: peer.id });
    expect(response.status()).toBe(200);
    const result = await response.json() as IssueStatusChangeResult;
    expect(result.issue).toMatchObject({ status: 'in_progress', assigneeId: peer.id, version: peerCleared.version + 1 });
    expect(await json<Comment[]>(await request.get(commentPath(issue)))).toMatchObject([{ id: result.receipt.commentId, body: text }]);
    await expect(dialog).toHaveCount(0);
  } finally { await f.close(); }
});
