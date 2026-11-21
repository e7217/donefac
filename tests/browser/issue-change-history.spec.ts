import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Response } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), (await response.text()).slice(0, 1200)).toBe(status);
  return response.json();
}

test.use({ viewport: { width: 360, height: 820 } });

test('360px에서 필드의 변경 전후를 더 읽고 티켓 편집 초안을 보존한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const { projects: [project], users: [actor, peer] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const suffix = randomUUID().slice(0, 8);
  const title = `필드 이력 검증 ${suffix}`;
  const firstDescription = `최초 설명 ${suffix}`;
  const savedDescription = `저장한 첫 변경 ${suffix}`;
  const draftDescription = `아직 저장하지 않은 설명 ${suffix}`;
  const headers = { 'X-Actor-Id': actor.id };
  const issue = await json<Issue>(await request.post('/api/issues', {
    headers, data: { projectId: project.id, title, description: firstDescription, priority: 'medium' },
  }), 201);
  const issuePath = `/api/issues/${issue.id}`;
  const historyPath = `${issuePath}/change-history`;
  try {
    let current = await json<Issue>(await request.patch(issuePath, { headers, data: { expectedVersion: issue.version, description: savedDescription } }));
    for (let i = 0; i < 20; i++) {
      current = await json<Issue>(await request.patch(issuePath, { headers, data: {
        expectedVersion: current.version, priority: i % 2 === 0 ? 'low' : 'medium',
      } }));
    }

    const historyRequests: string[] = [];
    page.on('request', sent => { if (new URL(sent.url()).pathname === historyPath) historyRequests.push(sent.url()); });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const ticket = page.getByRole('dialog', { name: title, exact: true });
    const priority = ticket.getByRole('combobox', { name: '우선순위', exact: true });
    const assignee = ticket.getByRole('combobox', { name: '담당자', exact: true });
    const description = ticket.getByRole('textbox', { name: '설명', exact: true });
    const save = ticket.getByRole('button', { name: '변경사항 저장', exact: true });
    await expect(priority).toHaveValue('medium');
    await priority.selectOption('high');
    await assignee.selectOption(peer.id);
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === issuePath && response.request().method() === 'PATCH');
    await save.click();
    const changed = await json<Issue>(await saving);
    expect(changed).toMatchObject({ priority: 'high', assigneeId: peer.id });
    await expect(save).toBeDisabled();
    expect(historyRequests).toHaveLength(0);

    await description.fill(draftDescription);
    await ticket.getByRole('button', { name: '변경 이력', exact: true }).click();
    const history = ticket.getByRole('region', { name: '필드 변경 기록', exact: true });
    const entries = history.getByRole('list', { name: '필드 변경 목록', exact: true }).getByRole('listitem');
    await expect(entries).toHaveCount(20);
    const newest = entries.first();
    await expect(newest.getByText(actor.name, { exact: true })).toBeVisible();
    await expect(newest).toContainText('변경 전');
    await expect(newest).toContainText('변경 후');
    await expect(newest).toContainText('보통');
    await expect(newest).toContainText('높음');
    await expect(newest).toContainText(peer.name);
    await expect(newest.locator('time')).toHaveAttribute('datetime', changed.updatedAt);
    await expect(ticket.getByRole('region', { name: 'Teamspace 변경 이력', exact: true })).toBeVisible();
    expect(historyRequests).toHaveLength(1);
    await expect(history).not.toContainText(savedDescription);
    await history.getByRole('button', { name: '이전 변경 더 보기', exact: true }).click();
    await expect(entries).toHaveCount(22);
    expect(new URL(historyRequests[1]).searchParams.get('beforeVersion')).toBeTruthy();
    await expect(entries.last()).toContainText(firstDescription);
    await expect(entries.last()).toContainText(savedDescription);
    await expect(history).not.toContainText(draftDescription);
    const panel = ticket.locator('.issue-panel-content');
    expect(await panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

    await ticket.getByRole('button', { name: '상세 정보', exact: true }).click();
    await expect(description).toHaveValue(draftDescription);
    await expect(save).toBeEnabled();
  } finally {
    const removed = await request.delete(issuePath, { headers });
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      expect((await request.delete(`/api/trash/${trashEntryId}`, { headers })).ok()).toBeTruthy();
    }
  }
});
