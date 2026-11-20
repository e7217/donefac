import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { documentNotificationSpaceId, type DocPage, type Issue, type TeamNotificationPage, type WorkspaceSnapshot } from '../../shared/types';

test('360px에서 프로젝트 업무와 문서 공간을 구독하고 알림의 새 항목을 연다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [editor, watcher] = workspace.users;
  const [project, otherProject] = workspace.projects;
  const prefix = `공간 구독 검사 ${randomUUID().slice(0, 8)}`;
  const editorHeaders = { 'X-Actor-Id': editor.id };
  const watcherHeaders = { 'X-Actor-Id': watcher.id };
  const projectSpace = documentNotificationSpaceId(project.id);
  const commonSpace = documentNotificationSpaceId(null);
  const issues: Issue[] = [];
  const documents: DocPage[] = [];

  async function createIssue(projectId: string, label: string) {
    const response = await request.post('/api/issues', {
      headers: editorHeaders, data: { projectId, title: `${prefix} ${label}`, status: 'todo' },
    });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }

  async function createDocument(projectId: string | null, label: string) {
    const response = await request.post('/api/documents', {
      headers: editorHeaders, data: { projectId, title: `${prefix} ${label}` },
    });
    expect(response.status(), await response.text()).toBe(201);
    const document = await response.json() as DocPage;
    documents.push(document);
    return document;
  }

  async function notificationsFor(targetId: string) {
    const response = await request.get('/api/notifications', { headers: watcherHeaders });
    expect(response.ok(), await response.text()).toBe(true);
    const inbox = await response.json() as TeamNotificationPage;
    return inbox.items.filter(item => item.targetId === targetId).map(item => item.kind);
  }

  const actor = page.getByLabel('작업자 선택', { exact: true });
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const subscribeIssues = button('프로젝트 업무 구독');
  const unsubscribeIssues = button('프로젝트 업무 구독 해제');
  const subscribeSpace = button('문서 공간 구독');
  const unsubscribeSpace = button('문서 공간 구독 해제');
  const subscribeCommon = button('팀 공통 문서 구독');
  const unsubscribeCommon = button('팀 공통 문서 구독 해제');
  const inbox = page.getByRole('dialog', { name: '팀 알림', exact: true });
  const inInbox = (label: string, title: string) => inbox.getByRole('button').filter({ hasText: label }).filter({ hasText: title });

  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues`);
    await actor.selectOption(watcher.id);
    await subscribeIssues.click();
    await expect(unsubscribeIssues).toBeEnabled();
    await page.reload();
    await expect(actor).toHaveValue(watcher.id);
    await expect(unsubscribeIssues).toBeEnabled();
    await button('보드').click();
    await expect(unsubscribeIssues).toBeEnabled();

    await page.goto(`/#/${project.id}/documents`);
    await subscribeSpace.click();
    await expect(unsubscribeSpace).toBeEnabled();
    await expect(subscribeCommon).toBeEnabled();
    const projectDocument = await createDocument(project.id, '프로젝트 문서');
    const unrelatedDocument = await createDocument(otherProject.id, '다른 프로젝트 문서');
    const unobservedCommon = await createDocument(null, '구독 전 공통 문서');
    expect(await notificationsFor(projectDocument.id)).toEqual(['document-created']);
    expect(await notificationsFor(unrelatedDocument.id)).toEqual([]);
    expect(await notificationsFor(unobservedCommon.id)).toEqual([]);

    await subscribeCommon.click();
    await expect(unsubscribeCommon).toBeEnabled();
    await actor.selectOption(editor.id);
    await expect(subscribeSpace).toBeEnabled();
    await expect(subscribeCommon).toBeEnabled();
    await actor.selectOption(watcher.id);
    await expect(unsubscribeSpace).toBeEnabled();
    await expect(unsubscribeCommon).toBeEnabled();
    const commonDocument = await createDocument(null, '구독 뒤 공통 문서');
    const projectIssue = await createIssue(project.id, '프로젝트 업무');
    const unrelatedIssue = await createIssue(otherProject.id, '다른 프로젝트 업무');
    expect(await notificationsFor(commonDocument.id)).toEqual(['document-created']);
    expect(await notificationsFor(projectIssue.id)).toEqual(['issue-created']);
    expect(await notificationsFor(unrelatedIssue.id)).toEqual([]);

    await button('알림').click();
    await inInbox('새 업무', projectIssue.title).click();
    const issuePanel = page.getByRole('dialog', { name: projectIssue.title, exact: true });
    await expect(issuePanel).toBeVisible();
    await issuePanel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await unsubscribeIssues.click();
    await expect(subscribeIssues).toBeEnabled();
    expect(await notificationsFor((await createIssue(project.id, '구독 해제 뒤 업무')).id)).toEqual([]);

    await button('알림').click();
    await inInbox('새 문서', commonDocument.title).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(commonDocument.title);
    await unsubscribeCommon.click();
    await expect(subscribeCommon).toBeEnabled();
    await expect(unsubscribeSpace).toBeEnabled();
    expect(await notificationsFor((await createDocument(null, '구독 해제 뒤 공통 문서')).id)).toEqual([]);
  } finally {
    for (const [type, id] of [['project', project.id], ['space', projectSpace], ['space', commonSpace]]) {
      await request.put(`/api/notifications/subscriptions/${type}/${encodeURIComponent(id)}`, {
        headers: watcherHeaders, data: { subscribed: false },
      });
    }
    for (const issue of issues) await request.delete(`/api/issues/${issue.id}`, { headers: editorHeaders });
    for (const document of documents) await request.delete(`/api/documents/${document.id}`, { headers: editorHeaders });
  }
});
