import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { DocPage, Issue, TeamNotificationPage, WorkspaceSnapshot } from '../../shared/types';

test('360px에서 업무와 문서 구독을 저장하고 팀 알림에서 원래 항목을 연다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [editor, watcher] = workspace.users;
  const project = workspace.projects[0];
  const prefix = `구독 검사 ${randomUUID().slice(0, 8)}`;
  const editorHeaders = { 'X-Actor-Id': editor.id };
  const watcherHeaders = { 'X-Actor-Id': watcher.id };
  let issue: Issue | undefined;
  let doc: DocPage | undefined;

  try {
    const createdIssue = await request.post('/api/issues', {
      headers: editorHeaders,
      data: { projectId: project.id, title: `${prefix} 업무`, status: 'todo' },
    });
    expect(createdIssue.status(), await createdIssue.text()).toBe(201);
    issue = await createdIssue.json() as Issue;
    const createdDoc = await request.post('/api/documents', {
      headers: editorHeaders,
      data: { projectId: project.id, title: `${prefix} 문서` },
    });
    expect(createdDoc.status(), await createdDoc.text()).toBe(201);
    doc = await createdDoc.json() as DocPage;

    const issueId = issue.id;
    const docId = doc.id;
    const issuesRoute = `/#/${project.id}/issues`;
    const docRoute = `/#/${project.id}/documents/${doc.id}`;
    const issuePanel = page.getByRole('dialog', { name: issue.title, exact: true });
    const issueSubscribe = issuePanel.getByRole('button', { name: '업무 구독', exact: true });
    const issueUnsubscribe = issuePanel.getByRole('button', { name: '업무 구독 해제', exact: true });
    const docSubscribe = page.getByRole('button', { name: '문서 구독', exact: true });
    const docUnsubscribe = page.getByRole('button', { name: '문서 구독 해제', exact: true });
    const selected = page.getByLabel('작업자 선택', { exact: true });
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const notifications = page.getByRole('button', { name: '알림', exact: true });
    const inbox = page.getByRole('dialog', { name: '팀 알림', exact: true });
    const inInbox = (label: string, target: string) => inbox.getByRole('button').filter({ hasText: label }).filter({ hasText: target });
    const readInbox = async () => {
      const response = await request.get('/api/notifications', { headers: watcherHeaders });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json() as TeamNotificationPage).items.filter(item => item.targetId === issueId || item.targetId === docId);
    };

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(issuesRoute);
    await selected.selectOption(watcher.id);
    await page.goto(`${issuesRoute}?issue=${issue.id}`);
    await issueSubscribe.click();
    await expect(issueUnsubscribe).toBeEnabled();
    await page.reload();
    await expect(selected).toHaveValue(watcher.id);
    await expect(issueUnsubscribe).toBeEnabled();

    await issuePanel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await page.goto(docRoute);
    await docSubscribe.click();
    await expect(docUnsubscribe).toBeEnabled();
    await selected.selectOption(editor.id);
    await expect(docSubscribe).toBeEnabled();
    await selected.selectOption(watcher.id);
    await expect(docUnsubscribe).toBeEnabled();

    for (const [resourceType, resourceId] of [['issue', issue.id], ['document', doc.id]]) {
      const comment = await request.post('/api/comments', {
        headers: editorHeaders,
        data: { resourceType, resourceId, body: `${prefix} 새 댓글` },
      });
      expect(comment.status(), await comment.text()).toBe(201);
    }
    const status = await request.patch(`/api/issues/${issue.id}`, {
      headers: editorHeaders,
      data: { expectedVersion: issue.version, status: 'in_progress' },
    });
    expect(status.status(), await status.text()).toBe(200);
    const updatedIssue = await status.json() as Issue;
    const updatedTitle = `${doc.title} 업데이트`;
    const updated = await request.patch(`/api/documents/${doc.id}`, {
      headers: editorHeaders,
      data: { expectedVersion: doc.version, title: updatedTitle },
    });
    expect(updated.status(), await updated.text()).toBe(200);
    expect((await readInbox()).map(item => item.kind).sort()).toEqual([
      'document-comment', 'document-updated', 'issue-comment', 'issue-status-changed',
    ]);

    await notifications.click();
    await expect(inInbox('업무 댓글', issue.title)).toBeVisible();
    await expect(inInbox('문서 댓글', doc.title)).toBeVisible();
    await inInbox('업무 상태 변경', issue.title).click();
    await expect(issuePanel).toBeVisible();
    await expect.poll(async () => (await readInbox()).find(item => item.kind === 'issue-status-changed')?.readAt).toEqual(expect.any(String));
    await issueUnsubscribe.click();
    await expect(issueSubscribe).toBeEnabled();
    await issuePanel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    await notifications.click();
    await inInbox('문서 변경', updatedTitle).click();
    await expect(title).toHaveValue(updatedTitle);
    await expect.poll(async () => (await readInbox()).find(item => item.kind === 'document-updated')?.readAt).toEqual(expect.any(String));
    const draft = `${updatedTitle} 미저장 초안`;
    await title.fill(draft);
    await docUnsubscribe.click();
    await expect(docSubscribe).toBeEnabled();
    await expect(title).toHaveValue(draft);

    const nextStatus = await request.patch(`/api/issues/${issue.id}`, {
      headers: editorHeaders,
      data: { expectedVersion: updatedIssue.version, status: 'review' },
    });
    expect(nextStatus.status(), await nextStatus.text()).toBe(200);
    const nextComment = await request.post('/api/comments', {
      headers: editorHeaders,
      data: { resourceType: 'document', resourceId: doc.id, body: `${prefix} 구독 해제 후 댓글` },
    });
    expect(nextComment.status(), await nextComment.text()).toBe(201);
    expect(await readInbox()).toHaveLength(4);
  } finally {
    if (issue) await request.delete(`/api/issues/${issue.id}`, { headers: editorHeaders });
    if (doc) await request.delete(`/api/documents/${doc.id}`, { headers: editorHeaders });
  }
});
