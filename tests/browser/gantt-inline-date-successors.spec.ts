import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Dependency, Issue, SchedulePasteApplyResult, SchedulePreview, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/schedule/manual-preview';
const applyPath = '/api/schedule/manual-apply';
const undoPath = '/api/schedule/undo';
const date = (offset: number) => new Date(Date.UTC(2026, 10, 23 + offset)).toISOString().slice(0, 10);
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

test('360px에서 여러 행의 날짜 초안을 유지하고 공유 후행 일정을 한 번에 적용하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(95_000);
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [project], users: [actor, peer] } = await workspace();
  const visiblePrefix = `함께 일정 확인 ${randomUUID().slice(0, 8)}`;
  const headers = { 'X-Actor-Id': actor.id };
  const created: Issue[] = [];
  const links: Dependency[] = [];
  async function issue(title: string, start: number, end: number) {
    const saved = await json<Issue>(await request.post('/api/issues', { headers, data: {
      projectId: project.id, title, startDate: date(start), endDate: date(end),
    } }), 201);
    created.push(saved);
    return saved;
  }
  async function link(predecessor: Issue, successor: Issue) {
    links.push(await json<Dependency>(await request.post('/api/dependencies', { headers, data: {
      predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0,
    } }), 201));
  }

  try {
    const first = await issue(`${visiblePrefix} 첫 기준`, 0, 1);
    const second = await issue(`${visiblePrefix} 둘째 기준`, 1, 2);
    const successor = await issue(`${first.key}와 ${second.key}의 공유 후행`, 3, 4);
    const next = await issue(`${first.key}의 두 번째 후행`, 7, 7);
    const later = await issue(`${second.key}의 기존 여유 업무`, 10, 11);
    await link(first, successor);
    await link(second, successor);
    await link(successor, next);
    await link(successor, later);
    const expectedDates = new Map([
      [first.id, { startDate: date(0), endDate: date(3) }],
      [second.id, { startDate: date(2), endDate: date(4) }],
      [successor.id, { startDate: date(7), endDate: date(8) }],
      [next.id, { startDate: date(9), endDate: date(9) }],
    ]);
    const anchors = [first, second].map(value => ({
      id: value.id, expectedVersion: value.version, ...expectedDates.get(value.id)!,
    }));
    async function checkStored(applied: boolean, versionDelta: number) {
      const stored = await workspace();
      for (const issued of created) {
        const { startDate, endDate } = (applied && expectedDates.get(issued.id)) || issued;
        expect(stored.issues.find(value => value.id === issued.id)).toMatchObject({
          startDate, endDate, description: issued.description, version: issued.version + (expectedDates.has(issued.id) ? versionDelta : 0),
        });
      }
      for (const saved of links) expect(stored.dependencies.find(value => value.id === saved.id)).toEqual(saved);
    }

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색', { exact: true }).fill(visiblePrefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const firstEnd = chart.getByLabel(`${first.key} 종료일`, { exact: true });
    const secondStart = chart.getByLabel(`${second.key} 시작일`, { exact: true });
    const secondEnd = chart.getByLabel(`${second.key} 종료일`, { exact: true });
    const review = button(page, '입력한 날짜 2건 검토');
    const dialog = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    const includeSuccessors = dialog.getByRole('checkbox', { name: '후행 일정 함께 검토', exact: true });
    const tableRow = (value: Issue) => dialog.getByRole('row').filter({ hasText: value.title });
    const expectInput = async () => {
      await expect(firstEnd).toHaveValue(date(3));
      await expect(secondStart).toHaveValue(date(2));
      await expect(secondEnd).toHaveValue(date(4));
    };
    for (const hidden of [successor, next, later]) {
      await expect(chart.locator(`[data-issue-id="${hidden.id}"]`)).toHaveCount(0);
    }
    await firstEnd.fill(date(3));
    await secondStart.fill(date(2));
    await secondEnd.fill(date(4));

    async function preview(action: 'open' | 'include' | 'repeat') {
      const pending = nextPost(page, previewPath);
      if (action === 'open') await review.click();
      else if (action === 'include') {
        await expect(includeSuccessors).toBeEnabled();
        await includeSuccessors.focus();
        await includeSuccessors.press('Space');
      } else await button(dialog, '다시 미리보기').click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual({
        changes: expect.arrayContaining(anchors), ...(action !== 'open' ? { rescheduleSuccessors: true } : {}),
      });
      expect(response.request().postDataJSON().changes).toHaveLength(2);
      const result = await json<SchedulePreview>(response);
      expect(result.previewId).toBeTruthy();
      expect(result.blocking ?? []).toEqual([]);
      await expect(includeSuccessors).toBeChecked({ checked: action !== 'open' });
      if (action === 'include') await expect(includeSuccessors).toBeFocused();
      return result;
    }

    const datesOnly = await preview('open');
    expect(datesOnly.changes.map(value => value.id).sort()).toEqual([first.id, second.id].sort());
    await expect(tableRow(successor)).toHaveCount(0);
    const planned = await preview('include');
    expect(planned.previewId).not.toBe(datesOnly.previewId);
    expect(planned.changes).toHaveLength(expectedDates.size);
    expect(new Map(planned.changes.map(change => [change.id, { startDate: change.toStart, endDate: change.toEnd }]))).toEqual(expectedDates);
    for (const moved of [successor, next]) {
      const dates = expectedDates.get(moved.id)!;
      await expect(tableRow(moved).getByText('후행 조정', { exact: true })).toBeVisible();
      await expect(tableRow(moved).locator('.gantt-new-dates')).toHaveText(`${dates.startDate}${dates.endDate}`);
    }
    await expect(tableRow(later)).toHaveCount(0);
    await button(dialog, '취소').click();
    await expect(dialog).toHaveCount(0);
    await expect(review).toBeFocused();
    await expectInput();
    await checkStored(false, 0);

    await preview('open');
    const stalePreview = await preview('include');
    const changedLater = await json<Issue>(await request.patch(`/api/issues/${later.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: later.version, description: '동료의 후행 검토 기록' },
    }));
    created[created.indexOf(later)] = changedLater;
    const apply = button(dialog, '변경 적용');
    const pendingStaleApply = nextPost(page, applyPath);
    await apply.click();
    const rejected = await pendingStaleApply;
    expect(rejected.status(), await rejected.text()).toBe(409);
    expect(rejected.request().postDataJSON()).toEqual({ previewId: stalePreview.previewId });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(apply).toBeDisabled();
    await expect(includeSuccessors).toBeChecked();
    await expectInput();
    await checkStored(false, 0);

    const applyPreview = await preview('repeat');
    expect(applyPreview.previewId).not.toBe(stalePreview.previewId);
    expect(applyPreview.changes).toEqual(stalePreview.changes);
    let persisted: SchedulePasteApplyResult | undefined;
    await page.route(`**${applyPath}`, async route => {
      persisted = await json<SchedulePasteApplyResult>(await route.fetch());
      await route.fulfill({ status: 408, json: { error: '합성 응답 시간 초과' } });
    }, { times: 1 });
    const pendingApply = nextPost(page, applyPath);
    await apply.click();
    const timedOut = await pendingApply;
    expect(timedOut.status(), await timedOut.text()).toBe(408);
    expect(timedOut.request().postDataJSON()).toEqual({ previewId: applyPreview.previewId });
    const recover = button(dialog, '적용 결과 다시 확인');
    await expect(recover).toBeEnabled();
    await expectInput();
    expect(persisted?.updated).toHaveLength(expectedDates.size);
    await checkStored(true, 1);

    const pendingRecovery = nextPost(page, applyPath);
    await recover.click();
    const recovered = await pendingRecovery;
    expect(recovered.request().postDataJSON()).toEqual({ previewId: applyPreview.previewId });
    const receipt = await json<SchedulePasteApplyResult>(recovered);
    expect(receipt).toEqual(persisted);
    await expect(dialog).toHaveCount(0);
    await expect(review).toHaveCount(0);
    await checkStored(true, 1);

    const pendingUndo = nextPost(page, undoPath);
    await button(page, '되돌리기').click();
    const response = await pendingUndo;
    expect(response.request().postDataJSON()).toEqual({ undoId: receipt.undoId });
    expect((await json<SchedulePasteApplyResult>(response)).updated).toHaveLength(expectedDates.size);
    await expect(firstEnd).toHaveValue(date(1));
    await expect(secondStart).toHaveValue(date(1));
    await expect(secondEnd).toHaveValue(date(2));
    await checkStored(false, 2);
  } finally {
    for (const saved of links) await request.delete(`/api/dependencies/${saved.id}`, { headers });
    for (const value of created.reverse()) {
      const response = await request.delete(`/api/issues/${value.id}`, { headers });
      if (!response.ok()) continue;
      const { trashEntryId } = await response.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});
