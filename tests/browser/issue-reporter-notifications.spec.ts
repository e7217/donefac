import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Response } from '@playwright/test';
import type { Comment, Issue, TeamNotificationPage, WorkspaceSnapshot } from '../../shared/types';
import { statusMeta } from '../../shared/workflow-helpers';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('360px 요청자가 상태 변경과 댓글 알림에서 업무와 원래 댓글을 연다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const [project, otherProject] = workspace.projects;
  const [editor, reporter] = workspace.users;
  const editorHeaders = { 'X-Actor-Id': editor.id };
  const reporterHeaders = { 'X-Actor-Id': reporter.id };
  const title = `요청 업무 알림 ${randomUUID().slice(0, 8)}`;
  const projectSubscription = `/api/notifications/subscriptions/project/${project.id}`;
  const { subscribed: originalSubscription } = await json<{ subscribed: boolean }>(
    await request.get(projectSubscription, { headers: reporterHeaders }),
  );
  async function setProjectSubscription(subscribed: boolean) {
    expect(await json(await request.put(projectSubscription, { headers: reporterHeaders, data: { subscribed } })))
      .toEqual({ subscribed });
  }

  let issue: Issue | undefined;
  try {
    await setProjectSubscription(false);
    issue = await json<Issue>(await request.post('/api/issues', {
      headers: reporterHeaders, data: { projectId: project.id, title, status: 'todo', assigneeId: editor.id },
    }), 201);
    expect(issue).toMatchObject({ reporterId: reporter.id, assigneeId: editor.id });
    const issueId = issue.id;
    const route = `/#/${project.id}/issues?issue=${issueId}`;
    const panel = page.getByRole('dialog', { name: title, exact: true });
    const selectedActor = page.getByLabel('작업자 선택', { exact: true });
    const closeIssue = panel.getByRole('button', { name: '업무 상세 닫기', exact: true });
    const statusField = panel.getByRole('combobox', { name: '상태', exact: true });
    const save = panel.getByRole('button', { name: '변경사항 저장', exact: true });
    const commentField = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const trigger = page.getByRole('button', { name: '알림', exact: true });
    const inbox = page.getByRole('dialog', { name: '팀 알림', exact: true });
    const notification = (label: string) => inbox.getByRole('button')
      .filter({ hasText: title }).filter({ hasText: `${label} · ${editor.name}` });
    const statusDetail = (from: string, to: string) =>
      `${statusMeta(workspace, project.id, from).label} → ${statusMeta(workspace, project.id, to).label}`;
    const commentArticle = (id: string) => panel.locator(`#issue-comment-${id}`);

    async function reporterAlerts() {
      const { items } = await json<TeamNotificationPage>(await request.get('/api/notifications', { headers: reporterHeaders }));
      return items.filter(item => item.targetId === issueId);
    }
    async function openAs(actorId: string) {
      await page.goto(route);
      await expect(selectedActor).toHaveValue(actorId);
      await expect(panel).toBeVisible();
    }
    async function changeStatus(status: string) {
      await statusField.selectOption(status);
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${issueId}` &&
        response.request().method() === 'PATCH');
      await save.click();
      expect((await json<Issue>(await saved)).status).toBe(status);
      await expect(save).toBeDisabled();
    }
    async function sendComment() {
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/comments' &&
        response.request().method() === 'POST');
      await panel.getByRole('button', { name: '댓글 등록', exact: true }).click();
      const comment = await json<Comment>(await saved, 201);
      await expect(commentArticle(comment.id)).toBeVisible();
      return comment;
    }

    await page.addInitScript(id => {
      if (!localStorage.getItem('donefac.actor')) localStorage.setItem('donefac.actor', id);
    }, editor.id);
    await openAs(editor.id);
    await changeStatus('in_progress');
    await commentField.fill('재현 결과를 확인했습니다.');
    const ordinary = await sendComment();
    const first = await reporterAlerts();
    expect(first).toHaveLength(2);
    const firstTransition = first.find(item => item.kind === 'issue-status-changed');
    const firstComment = first.find(item => item.kind === 'issue-comment');
    expect(firstTransition).toMatchObject({ actorId: editor.id, readAt: null, detail: statusDetail('todo', 'in_progress') });
    expect(firstComment).toMatchObject({ actorId: editor.id, readAt: null, commentId: ordinary.id });

    await closeIssue.click();
    await page.goto(`/#/${otherProject.id}/issues`);
    await selectedActor.selectOption(reporter.id);
    await trigger.click();
    const transitionAction = notification('업무 상태 변경');
    await expect(transitionAction).toContainText(statusDetail('todo', 'in_progress'));
    const bounds = await inbox.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await transitionAction.click();
    await expect(page).toHaveURL(route);
    await expect(statusField).toHaveValue('in_progress');
    await expect.poll(async () => (await reporterAlerts()).find(item => item.id === firstTransition!.id)?.readAt).toEqual(expect.any(String));

    await closeIssue.click();
    await expect(panel).toBeHidden();
    await trigger.click();
    await notification('업무 댓글').click();
    await expect(page).toHaveURL(route);
    await expect(commentArticle(ordinary.id)).toBeFocused();
    await expect.poll(async () => (await reporterAlerts()).find(item => item.id === firstComment!.id)?.readAt).toEqual(expect.any(String));

    await panel.getByRole('button', { name: '업무 구독', exact: true }).click();
    await expect(panel.getByRole('button', { name: '업무 구독 해제', exact: true })).toBeEnabled();
    await setProjectSubscription(true);
    await changeStatus('review');
    await commentField.fill('요청자가 직접 검토했습니다.');
    await sendComment();
    expect((await reporterAlerts()).map(item => item.id).sort()).toEqual(first.map(item => item.id).sort());

    await closeIssue.click();
    await selectedActor.selectOption(editor.id);
    await openAs(editor.id);
    await changeStatus('done');
    await commentField.fill(`완료했습니다. @${reporter.email}`);
    const mentions = page.getByRole('listbox', { name: '팀원 멘션', exact: true });
    await expect(mentions.getByRole('option').filter({ hasText: reporter.email })).toBeVisible();
    await commentField.press('Enter');
    await expect(mentions).toBeHidden();
    const tagged = await sendComment();
    expect(tagged.mentions?.map(mention => mention.userId)).toEqual([reporter.id]);
    const beforeOverlap = new Set(first.map(item => item.id));
    const overlap = (await reporterAlerts()).filter(item => !beforeOverlap.has(item.id));
    expect(overlap).toHaveLength(2);
    expect(overlap).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'issue-status-changed', detail: statusDetail('review', 'done'), actorId: editor.id }),
      expect.objectContaining({ kind: 'issue-comment-mentioned', commentId: tagged.id, actorId: editor.id }),
    ]));

    await closeIssue.click();
    await selectedActor.selectOption(reporter.id);
    await trigger.click();
    await notification('업무 댓글에서 멘션').click();
    await expect(commentArticle(tagged.id)).toBeFocused();
    await expect.poll(async () => (await reporterAlerts()).find(item => item.commentId === tagged.id)?.readAt).toEqual(expect.any(String));
  } finally {
    await request.put(projectSubscription, { headers: reporterHeaders, data: { subscribed: originalSubscription } });
    if (issue) {
      const removed = await request.delete(`/api/issues/${issue.id}`, { headers: editorHeaders });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers: editorHeaders });
      }
    }
  }
});
