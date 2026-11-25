import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { Issue, IssueChangeHistoryPage, User, WorkflowStatus } from '../../shared/types';

export interface IssueHandoffPlan {
  issue: Issue;
  actor: User;
  observer: User;
  previousStatus: WorkflowStatus;
  nextStatus: WorkflowStatus;
  startDate: string;
  endDate: string;
  plannedEffortMinutes: number;
}

const timeout = 25_000;
const board = (page: Page) => page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
const boardSearch = (page: Page) => page.getByLabel('보드 업무 검색', { exact: true });

export async function verifyIssueHandoff(writer: BrowserContext, reader: BrowserContext, origin: string, lookupKey: string, plan: IssueHandoffPlan) {
  const { issue, actor, observer, previousStatus, nextStatus, startDate, endDate, plannedEffortMinutes } = plan;
  expect(writer).not.toBe(reader);
  expect(actor.id).not.toBe(observer.id);
  const route = `/#/${issue.projectId}/teamboard?${new URLSearchParams({ boardProject: issue.projectId })}`;
  const issuePath = `/api/issues/${encodeURIComponent(issue.id)}`;
  const openIssue = `${issue.key} 업무 열기`;
  const source = await writer.newPage();
  const receiving = await reader.newPage();
  try {
    await Promise.all([source, receiving].map(async page => {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout });
      await boardSearch(page).fill(lookupKey, { timeout });
      await expect(board(page).locator('[data-issue-id]')).toHaveCount(1, { timeout });
      await expect(board(page).getByRole('button', { name: openIssue, exact: true })).toBeVisible({ timeout });
    }));
    await expect(source.getByLabel('작업자 선택', { exact: true })).toHaveValue(actor.id, { timeout });
    await expect(receiving.getByLabel('작업자 선택', { exact: true })).toHaveValue(observer.id, { timeout });
    const receivedCard = board(receiving).locator(`[data-issue-id="${issue.id}"]`);
    await expect(receivedCard.locator(`[data-board-status="${previousStatus.id}"]`)).toHaveText(previousStatus.label, { timeout });
    await expect(receivedCard.locator('.team-board-card-footer')).toContainText(actor.name, { timeout });

    await board(source).getByRole('button', { name: openIssue, exact: true }).click({ timeout });
    const editing = source.getByRole('dialog', { name: issue.title, exact: true });
    const status = editing.getByRole('combobox', { name: '상태', exact: true });
    const assignee = editing.getByRole('combobox', { name: '담당자', exact: true });
    await expect(status).toHaveValue(previousStatus.id, { timeout });
    await expect(assignee).toHaveValue(actor.id, { timeout });
    await expect(editing.getByText(new RegExp(`^편집 버전 ${issue.version} ·`))).toBeVisible({ timeout });
    await status.selectOption(nextStatus.id, { timeout });
    await assignee.selectOption(observer.id, { timeout });
    await editing.getByLabel('시작일', { exact: true }).fill(startDate, { timeout });
    await editing.getByLabel('종료일', { exact: true }).fill(endDate, { timeout });
    await editing.getByRole('spinbutton', { name: '계획 작업 시간 (분)', exact: true }).fill(String(plannedEffortMinutes), { timeout });
    const [saved] = await Promise.all([
      source.waitForResponse(response => new URL(response.url()).pathname === issuePath && response.request().method() === 'PATCH', { timeout }),
      editing.getByRole('button', { name: '변경사항 저장', exact: true }).click({ timeout }),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    expect(await saved.request().headerValue('origin')).toBe(origin);
    expect(await saved.request().headerValue('x-actor-id')).toBe(actor.id);
    expect(saved.request().postDataJSON()).toMatchObject({ expectedVersion: issue.version, status: nextStatus.id, assigneeId: observer.id });
    const updated = await saved.json() as Issue;
    expect(updated).toMatchObject({ id: issue.id, projectId: issue.projectId, version: issue.version + 1,
      status: nextStatus.id, assigneeId: observer.id, startDate, endDate, plannedEffortMinutes });

    await receiving.bringToFront();
    const [refreshed] = await Promise.all([
      receiving.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === '/api/workspace' && !url.search && response.request().method() === 'GET';
      }, { timeout }),
      receiving.getByRole('button', { name: '팀 보드 새로고침', exact: true }).click({ timeout }),
    ]);
    expect(refreshed.status()).toBe(200);
    expect(await refreshed.request().headerValue('x-actor-id')).toBe(observer.id);
    await expect(receiving.getByRole('status').filter({ hasText: '팀 보드를 새로고침했습니다.' })).toBeVisible({ timeout });
    await expect(boardSearch(receiving)).toHaveValue(lookupKey, { timeout });
    const nextCard = board(receiving).locator(`[data-status-category="${nextStatus.category}"]`).locator(`[data-issue-id="${issue.id}"]`);
    await expect(nextCard.locator(`[data-board-status="${nextStatus.id}"]`)).toHaveText(nextStatus.label, { timeout });
    await expect(nextCard.locator('.team-board-card-footer')).toContainText(observer.name, { timeout });
    await nextCard.getByRole('button', { name: openIssue, exact: true }).click({ timeout });
    const opened = receiving.getByRole('dialog', { name: issue.title, exact: true });
    await expect(opened.getByText(new RegExp(`^편집 버전 ${updated.version} ·`))).toBeVisible({ timeout });
    const [historyResponse] = await Promise.all([
      receiving.waitForResponse(response => new URL(response.url()).pathname === `${issuePath}/change-history` && response.request().method() === 'GET', { timeout }),
      opened.getByRole('button', { name: '변경 이력', exact: true }).click({ timeout }),
    ]);
    expect(historyResponse.status(), await historyResponse.text()).toBe(200);
    expect(await historyResponse.request().headerValue('x-actor-id')).toBe(observer.id);
    const [history] = (await historyResponse.json() as IssueChangeHistoryPage).entries;
    expect(history).toMatchObject({ issueId: issue.id, issueVersion: updated.version, actorId: actor.id, actorName: actor.name,
      origin: 'user', occurredAt: updated.updatedAt, changes: expect.arrayContaining([
        { field: 'status', label: '상태', before: { value: previousStatus.id, display: previousStatus.label }, after: { value: nextStatus.id, display: nextStatus.label } },
        { field: 'assigneeId', label: '담당자', before: { value: actor.id, display: actor.name }, after: { value: observer.id, display: observer.name } },
      ]) });
    const latest = opened.getByRole('region', { name: '필드 변경 기록', exact: true })
      .getByRole('list', { name: '필드 변경 목록', exact: true }).getByRole('listitem').first();
    await expect(latest.locator('.issue-field-history-meta').getByText(actor.name, { exact: true })).toBeVisible({ timeout });
    await expect(latest.locator('time')).toHaveAttribute('datetime', updated.updatedAt, { timeout });
    for (const value of [previousStatus.label, nextStatus.label, observer.name]) {
      await expect(latest.getByText(value, { exact: true })).toBeVisible({ timeout });
    }
    return { updated, history };
  } finally {
    await Promise.allSettled([source.close(), receiving.close()]);
  }
}
