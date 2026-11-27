import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { Issue, IssueRelation, TeamNotificationPage, WorkspaceSnapshot } from '../../shared/types';

async function readJson<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const deliveryKinds = new Set(['issue-block-added', 'issue-block-resolved', 'issue-deadline-postponed']);

test('360px 팀 알림에서 다른 프로젝트의 차단 추가와 해소, 마감 연기를 확인하고 업무를 연다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project, otherProject], users: [editor, recipient] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const editorHeaders = { 'X-Actor-Id': editor.id };
  const prefix = `진행 차단 알림 ${randomUUID().slice(0, 8)}`;
  const oldDate = '2030-01-15';
  const newDate = '2030-02-05';
  const issues: Issue[] = [];

  async function makeIssue(fields: Pick<Issue, 'projectId' | 'title'> & Partial<Issue>) {
    const issue = await readJson<Issue>(await request.post('/api/issues', {
      headers: editorHeaders, data: { status: 'in_progress', ...fields },
    }), 201);
    issues.push(issue);
    return issue;
  }

  async function editIssue(issue: Issue, changes: Partial<Issue>) {
    return readJson<Issue>(await request.patch(`/api/issues/${issue.id}`, {
      headers: editorHeaders, data: { expectedVersion: issue.version, ...changes },
    }));
  }

  async function deliveryNotices(actorId: string, targetId: string) {
    const { items } = await readJson<TeamNotificationPage>(await request.get('/api/notifications', {
      headers: { 'X-Actor-Id': actorId },
    }));
    return items.filter(item => item.targetId === targetId && deliveryKinds.has(item.kind));
  }

  try {
    const target = await makeIssue({ projectId: project.id, title: `${prefix} 검토 업무`, assigneeId: recipient.id, dueDate: oldDate });
    const cause = await makeIssue({ projectId: otherProject.id, title: `${prefix} 외부 승인` });
    async function subscribe(id: string) {
      const result = await readJson(await request.put(`/api/notifications/subscriptions/issue/${target.id}`, {
        headers: { 'X-Actor-Id': id }, data: { subscribed: true },
      }));
      expect(result).toEqual({ subscribed: true });
    }
    await subscribe(editor.id);

    await page.addInitScript(actor => localStorage.setItem('donefac.actor', actor), recipient.id);
    await page.goto(`/#/${otherProject.id}/issues`);
    await expect(page.getByLabel('작업자 선택', { exact: true })).toHaveValue(recipient.id);
    const trigger = page.getByRole('button', { name: '알림', exact: true });
    const inbox = page.getByRole('dialog', { name: '팀 알림', exact: true });
    const unread = inbox.getByRole('button', { name: '읽지 않음', exact: true });
    const action = (label: string) => inbox.getByRole('button').filter({ hasText: target.title }).filter({ hasText: label });
    const detail = page.getByRole('dialog', { name: target.title, exact: true });
    const closeDetail = detail.getByRole('button', { name: '업무 상세 닫기', exact: true });
    const targetNotices = () => deliveryNotices(recipient.id, target.id);
    const readAt = async (id: string) => (await targetNotices()).find(item => item.id === id)?.readAt;

    const createRelation = () => request.post(`/api/issues/${target.id}/relations`, {
      headers: editorHeaders, data: { otherIssueId: cause.id, type: 'blocks', direction: 'incoming' },
    });
    const relation = await readJson<IssueRelation>(await createRelation(), 201);
    expect(relation).toMatchObject({ sourceIssueId: cause.id, targetIssueId: target.id, type: 'blocks' });
    expect(await readJson<IssueRelation>(await createRelation())).toEqual(relation);

    const added = await targetNotices();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: 'issue-block-added', projectId: project.id, actorId: editor.id, recipientId: recipient.id,
      targetId: target.id, readAt: null, detail: expect.stringContaining(cause.title) });
    await trigger.click();
    await expect(inbox).toBeVisible();
    const bounds = await inbox.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const addedAction = action('업무 차단 추가');
    await expect(addedAction).toContainText(cause.key);
    await expect(addedAction).toContainText(cause.title);
    await addedAction.click();
    await expect(inbox).toHaveCount(0);
    await expect(detail).toBeVisible();
    await expect(page).toHaveURL(`/#/${project.id}/issues?issue=${target.id}`);
    await expect(detail.getByRole('region', { name: '업무 관계', exact: true })).toContainText(cause.title);
    await expect.poll(() => readAt(added[0].id)).toEqual(expect.any(String));
    await closeDetail.click();

    await subscribe(recipient.id);
    const completed = await editIssue(cause, { status: 'done' });
    await editIssue(completed, { status: 'done' });
    const postponed = await editIssue(target, { dueDate: newDate });
    await editIssue(postponed, { dueDate: newDate });
    const notices = await targetNotices();
    expect(notices.map(item => item.kind).sort()).toEqual([...deliveryKinds].sort());
    for (const notice of notices) expect(notice).toMatchObject({ actorId: editor.id, recipientId: recipient.id, projectId: project.id });
    expect(await deliveryNotices(editor.id, target.id)).toEqual([]);
    const resolved = notices.find(item => item.kind === 'issue-block-resolved')!;
    const extended = notices.find(item => item.kind === 'issue-deadline-postponed')!;
    expect(resolved).toMatchObject({ readAt: null, detail: expect.stringContaining(cause.title) });
    expect(extended).toMatchObject({ readAt: null, detail: expect.stringContaining(oldDate) });

    await trigger.click();
    await unread.click();
    const resolvedAction = action('업무 차단 원인 해소');
    const extendedAction = action('업무 마감 연기');
    await expect(resolvedAction).toContainText(cause.key);
    await expect(resolvedAction).toContainText(cause.title);
    await expect(extendedAction).toContainText(oldDate);
    await expect(extendedAction).toContainText(newDate);
    await expect(addedAction).toHaveCount(0);

    const beforeRead = page.url();
    const resolvedRow = inbox.getByRole('listitem').filter({ hasText: target.title }).filter({ hasText: '업무 차단 원인 해소' });
    await resolvedRow.getByRole('button', { name: `${resolved.targetLabel} 읽음 처리`, exact: true }).click();
    await expect(resolvedAction).toHaveCount(0);
    await expect(page).toHaveURL(beforeRead);
    await expect.poll(() => readAt(resolved.id)).toEqual(expect.any(String));

    await extendedAction.click();
    await expect(detail.getByLabel('목표 마감일', { exact: true })).toHaveValue(newDate);
    await expect.poll(() => readAt(extended.id)).toEqual(expect.any(String));
  } finally {
    for (const issue of issues) {
      const deleted = await request.delete(`/api/issues/${issue.id}`, { headers: editorHeaders });
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId?: string };
        if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`, { headers: editorHeaders });
      }
    }
  }
});
