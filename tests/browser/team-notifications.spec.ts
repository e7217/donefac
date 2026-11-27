import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { DocPage, Issue, TeamNotificationPage, WorkspaceSnapshot } from '../../shared/types';

test('읽지 않을 알림을 보관하고 받은 알림으로 되돌릴 수 있다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, recipient] = workspace.users;
  const project = workspace.projects[0];
  const prefix = `알림 정리 ${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/issues', {
    headers: { 'X-Actor-Id': author.id },
    data: { projectId: project.id, title: prefix, assigneeId: recipient.id },
  });
  expect(response.status(), await response.text()).toBe(201);
  const issue = await response.json() as Issue;
  const headers = { 'X-Actor-Id': recipient.id };
  async function inbox(filter = 'all') {
    return (await request.get(`/api/notifications?filter=${filter}`, { headers })).json() as Promise<TeamNotificationPage>;
  }
  try {
    const initial = await inbox();
    const notification = initial.items.find(item => item.targetId === issue.id)!;
    expect(notification).toBeDefined();
    const label = notification.targetLabel;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), recipient.id);
    await page.goto(`/#/${project.id}/issues`);
    const trigger = page.getByRole('button', { name: '알림', exact: true });
    const popup = page.getByRole('dialog', { name: '팀 알림', exact: true });
    const act = (action: string) => popup.getByRole('button', { name: `${label} ${action}`, exact: true });
    const unseen = popup.getByRole('button', { name: '읽지 않음', exact: true });
    const close = popup.getByRole('button', { name: '알림함 닫기', exact: true });
    await trigger.click();
    await unseen.click();
    await act('보관').click();
    await expect(act('보관')).toHaveCount(0);
    await expect(close).toBeFocused();
    await expect(trigger).toHaveAccessibleDescription(`읽지 않은 알림 ${initial.unreadCount - 1}개`);

    await popup.getByRole('button', { name: '보관함', exact: true }).click();
    await expect(act('보관 해제')).toBeVisible();
    expect((await inbox('archived')).items.find(item => item.id === notification.id)).toMatchObject({ readAt: null, archivedAt: expect.any(String) });
    await act('보관 해제').click();
    await expect(act('보관 해제')).toHaveCount(0);
    await expect(trigger).toHaveAccessibleDescription(`읽지 않은 알림 ${initial.unreadCount}개`);

    await popup.getByRole('button', { name: '전체', exact: true }).click();
    await act('읽음 처리').click();
    await expect(act('읽지 않음으로 표시')).toBeVisible();
    await act('읽지 않음으로 표시').click();
    await expect(act('읽음 처리')).toBeVisible();
    await unseen.click();
    await expect(act('읽음 처리')).toBeVisible();
    expect((await inbox('unread')).items.find(item => item.id === notification.id)?.readAt).toBeNull();
    const bounds = await popup.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  } finally {
    const removed = await request.delete(`/api/issues/${issue.id}`, { headers: { 'X-Actor-Id': author.id } });
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`, { headers: { 'X-Actor-Id': author.id } });
    }
  }
});

test('팀 알림에서 새 업무를 열고 미저장 문서의 이동을 취소하면 읽지 않은 상태를 유지한다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, recipient] = workspace.users;
  const project = workspace.projects[0];
  const prefix = `알림 검증 ${randomUUID()}`;
  const created = await request.post('/api/documents', {
    headers: { 'X-Actor-Id': recipient.id },
    data: { projectId: project.id, title: `${prefix} 문서` },
  });
  expect(created.status(), await created.text()).toBe(201);
  const doc = await created.json() as DocPage;
  let issue: Issue | undefined;
  try {
    const docRoute = `/#/${project.id}/documents/${doc.id}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), recipient.id);
    await page.goto(docRoute);
    const selected = page.getByLabel('작업자 선택', { exact: true });
    await expect(selected).toHaveValue(recipient.id);
    const draft = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await draft.fill(`${prefix} 미저장 편집`);
    const assignment = await request.post('/api/issues', {
      headers: { 'X-Actor-Id': author.id },
      data: { projectId: project.id, title: `${prefix} 업무`, assigneeId: recipient.id },
    });
    expect(assignment.status(), await assignment.text()).toBe(201);
    issue = await assignment.json() as Issue;
    const issueId = issue.id;
    const readState = async () => {
      const response = await request.get('/api/notifications', { headers: { 'X-Actor-Id': recipient.id } });
      const list = await response.json() as TeamNotificationPage;
      return list.items.find(item => item.targetId === issueId)?.readAt;
    };

    const trigger = page.getByRole('button', { name: '알림', exact: true });
    const popup = page.getByRole('dialog', { name: '팀 알림', exact: true });
    await trigger.click();
    await expect(popup).toBeVisible();
    const bounds = await popup.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await popup.getByRole('button', { name: '읽지 않음', exact: true }).click();
    const target = popup.getByRole('button').filter({ hasText: issue.title });
    const canceled = page.waitForEvent('dialog');
    const firstClick = target.click();
    await (await canceled).dismiss();
    await firstClick;
    await expect(page).toHaveURL(new RegExp(`/documents/${doc.id}$`));
    await expect(draft).toHaveValue(`${prefix} 미저장 편집`);
    await expect(target).toBeVisible();
    expect(await readState()).toBeNull();

    const accepted = page.waitForEvent('dialog');
    const secondClick = target.click();
    await (await accepted).accept();
    await secondClick;
    await expect(page.getByRole('dialog', { name: issue.title, exact: true })).toBeVisible();
    await expect.poll(readState).toEqual(expect.any(String));
    await page.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await selected.selectOption(author.id);
    await trigger.click();
    await expect(popup.getByRole('button', { name: '알림함 닫기', exact: true })).toBeVisible();
    await expect(popup.locator('.team-notifications-results')).toHaveAttribute('aria-busy', 'false');
    await expect(popup.getByText(issue.title, { exact: false })).toHaveCount(0);
  } finally {
    if (issue) await request.delete(`/api/issues/${issue.id}`);
    await request.delete(`/api/documents/${doc.id}`);
  }
});
