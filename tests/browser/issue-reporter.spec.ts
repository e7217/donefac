import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

function issueResponse(page: Page, method: 'POST' | 'PATCH', id?: string) {
  const path = id ? `/api/issues/${id}` : '/api/issues';
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

test('360px 업무의 요청자를 기본 지정하고 변경한 뒤 내가 요청한 업무에서 확인한다', async ({ page, request }) => {
  const { projects: [first, second], users: [actor, other], issues } = await workspace(request);
  const historical = issues.find(issue => issue.projectId === first.id && !Object.hasOwn(issue, 'reporterId'))!;
  expect(historical).toBeDefined();
  const prefix = `요청자 검증 ${randomUUID().slice(0, 8)}`;
  const title = `${prefix} 내 첫 요청`;
  const created: Issue[] = [];
  const member = (id: string) => `member:${id}`;
  const details = (name: string) => page.getByRole('dialog', { name, exact: true });
  const row = (issue: Issue) => page.locator(`[data-issue-review-id="${issue.id}"]`);
  const close = (name: string) => details(name).getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
  const stored = async (id: string) => (await workspace(request)).issues.find(issue => issue.id === id);

  async function prepIssue(name: string, projectId: string, reporterId: string | null, assigneeId: string) {
    const response = await request.post('/api/issues', {
      headers: { 'X-Actor-Id': other.id },
      data: { projectId, title: `${prefix} ${name}`, reporterId, assigneeId },
    });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    return issue;
  }

  try {
    const foreign = await prepIssue('둘째 프로젝트', second.id, actor.id, other.id);
    const assignedOnly = await prepIssue('담당만 있는 업무', first.id, other.id, actor.id);
    const blank = await prepIssue('미지정 업무', second.id, null, actor.id);

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${first.id}/issues`);
    await page.getByRole('button', { name: '업무 만들기', exact: true }).first().click();
    const create = details('새 업무 만들기');
    await expect(create.getByRole('combobox', { name: '요청자', exact: true })).toHaveValue(member(actor.id));
    await create.getByLabel('업무 제목', { exact: true }).fill(title);
    await create.getByRole('combobox', { name: '담당자', exact: true }).selectOption({ label: other.name });
    const creating = issueResponse(page, 'POST');
    await create.getByRole('button', { name: '업무 만들기', exact: true }).click();
    const creation = await creating;
    expect(creation.status(), await creation.text()).toBe(201);
    const issue = await creation.json() as Issue;
    created.push(issue);
    expect(Object.hasOwn(creation.request().postDataJSON(), 'reporterId')).toBe(false);
    expect(issue).toMatchObject({ projectId: first.id, title, reporterId: actor.id, assigneeId: other.id });
    await expect(details(title).getByRole('combobox', { name: '요청자', exact: true })).toHaveValue(member(actor.id));
    await close(title);

    await page.goto(`/#/${first.id}/mywork`);
    await expect(page.getByRole('heading', { name: '내 업무', exact: true })).toBeVisible();
    const modes = page.getByRole('combobox', { name: '참여 범위', exact: true });
    await modes.selectOption({ label: '내가 요청한 업무' });
    for (const [reported, project] of [[issue, first], [foreign, second]] as const) {
      await expect(row(reported)).toBeVisible();
      await expect(row(reported).getByText(`${project.name}·요청`, { exact: true })).toBeVisible();
    }
    await expect(row(assignedOnly)).toHaveCount(0);
    await expect(row(blank)).toHaveCount(0);

    await row(issue).click();
    const ticket = details(title);
    const reporter = ticket.getByRole('combobox', { name: '요청자', exact: true });
    const save = ticket.getByRole('button', { name: '변경사항 저장', exact: true });
    await reporter.selectOption(member(other.id));
    const editing = issueResponse(page, 'PATCH', issue.id);
    await save.click();
    const edited = await editing;
    expect(edited.ok(), await edited.text()).toBeTruthy();
    expect(edited.request().postDataJSON()).toMatchObject({ reporterId: other.id, expectedVersion: issue.version });
    const changed = await edited.json() as Issue;
    await expect(save).toBeDisabled();
    await close(title);
    await expect(modes).toHaveValue('reported');
    await expect(row(issue)).toHaveCount(0);
    await expect(row(foreign)).toBeVisible();

    await page.getByLabel('작업자 선택', { exact: true }).selectOption(other.id);
    await modes.selectOption({ label: '내가 요청한 업무' });
    await expect(row(issue)).toBeVisible();
    await expect(row(assignedOnly)).toBeVisible();
    await expect(row(foreign)).toHaveCount(0);
    await row(issue).click();
    await reporter.selectOption({ label: '미지정' });
    const clearing = issueResponse(page, 'PATCH', issue.id);
    await save.click();
    const cleared = await clearing;
    expect(cleared.ok(), await cleared.text()).toBeTruthy();
    expect(cleared.request().postDataJSON()).toMatchObject({ reporterId: null, expectedVersion: changed.version });
    await expect(save).toBeDisabled();
    await close(title);
    await expect(row(issue)).toHaveCount(0);
    await expect(row(assignedOnly)).toBeVisible();
    expect(await stored(issue.id)).toMatchObject({ reporterId: null, assigneeId: other.id });

    await page.goto(`/#/${first.id}/issues?issue=${historical.id}`);
    const historicalReporter = details(historical.title).getByRole('combobox', { name: '요청자', exact: true });
    await expect(historicalReporter).toHaveValue('unknown');
    await expect(historicalReporter.locator('option:checked')).toHaveText('확인되지 않음');
    expect(Object.hasOwn((await stored(historical.id))!, 'reporterId')).toBe(false);
  } finally {
    for (const issue of created.reverse()) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});
