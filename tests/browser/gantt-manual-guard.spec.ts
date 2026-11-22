import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Issue, SchedulePasteApplyResult, SchedulePreview, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/schedule/manual-preview';
const applyPath = '/api/schedule/manual-apply';
const undoPath = '/api/schedule/undo';

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function workspace(request: APIRequestContext) {
  return readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
}

const schedule = ({ id, version, startDate, endDate }: Issue) => ({ id, version, startDate, endDate });

async function makeFixture(request: APIRequestContext) {
  const { projects: [project], users: [, peer] } = await workspace(request);
  const prefix = `수동 일정 ${randomUUID()}`;
  const baseDate = new Date();
  const date = (offset: number) => {
    const value = new Date(baseDate);
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  };
  const issues: Issue[] = [];
  return {
    peer, date,
    async create(title: string, first: number | null, last: number | null) {
      const issue = await readJson<Issue>(await request.post('/api/issues', { data: {
        projectId: project.id, title: `${prefix} ${title}`,
        startDate: first === null ? null : date(first), endDate: last === null ? null : date(last),
      } }), 201);
      issues.push(issue);
      return issue;
    },
    async stored() {
      const live = new Map((await workspace(request)).issues.map(issue => [issue.id, issue]));
      return issues.map(issue => schedule(live.get(issue.id)!));
    },
    async close() {
      for (const issue of [...issues].reverse()) {
        const removed = await request.delete(`/api/issues/${issue.id}`);
        if (!removed.ok()) continue;
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    },
  };
}

async function openChart(page: Page, issue: Issue) {
  await page.goto(`/#/${issue.projectId}/gantt`);
  await page.getByLabel('간트 업무 검색', { exact: true }).fill(issue.title);
  return {
    chart: page.getByRole('region', { name: '간트 차트', exact: true }),
    dialog: page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true }),
    undo: page.getByRole('button', { name: '되돌리기', exact: true }),
  };
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

test('360px 간트에서 선택 밖의 선행 업무가 바뀌면 이동을 거절하고 새 검토에 반영한다', async ({ page, request }) => {
  const fixture = await makeFixture(request);
  try {
    const predecessor = await fixture.create('숨겨진 선행', 0, 1);
    const successor = await fixture.create('선택한 후행', 3, 4);
    const link = await request.post('/api/dependencies', { data: {
      predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0,
    } });
    expect(link.status(), await link.text()).toBe(201);

    await page.setViewportSize({ width: 360, height: 820 });
    const { chart, dialog, undo } = await openChart(page, successor);
    await expect(chart.locator(`[data-issue-id="${predecessor.id}"]`)).toHaveCount(0);
    await chart.getByRole('checkbox', { name: `${successor.key} 선택`, exact: true }).check();
    const shift = page.getByRole('button', { name: '1개 일정 이동', exact: true });
    const review = page.getByRole('button', { name: '변경 미리보기', exact: true });
    await shift.click();
    await page.getByLabel('이동 일수', { exact: true }).fill('2');
    await page.getByRole('checkbox', { name: '근무일 기준', exact: true }).uncheck();
    const originalPreview = nextPost(page, previewPath);
    await review.click();
    const proposalResponse = await originalPreview;
    expect(proposalResponse.request().postDataJSON()).toEqual({ issueIds: [successor.id], days: 2, workingDays: false });
    const proposal = await readJson<SchedulePreview>(proposalResponse);
    expect(proposal.previewId).toBeTruthy();
    expect(proposal.changes).toMatchObject([{ id: successor.id, toStart: fixture.date(5), toEnd: fixture.date(6) }]);
    await expect(dialog.locator('.gantt-new-dates')).toContainText(fixture.date(5));

    const changedPredecessor = await readJson<Issue>(await request.patch(`/api/issues/${predecessor.id}`, {
      headers: { 'X-Actor-Id': fixture.peer.id },
      data: { expectedVersion: predecessor.version, endDate: fixture.date(8) },
    }));
    const rejected = nextPost(page, applyPath);
    const apply = dialog.getByRole('button', { name: '변경 적용', exact: true });
    await apply.click();
    const response = await rejected;
    expect(response.status(), await response.text()).toBe(409);
    expect(response.request().postDataJSON()).toEqual({ previewId: proposal.previewId });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.locator('.gantt-new-dates')).toContainText(fixture.date(5));
    expect(await fixture.stored()).toEqual([schedule(changedPredecessor), schedule(successor)]);
    await expect(apply).toBeDisabled();
    await expect(undo).toBeDisabled();

    const inspected = nextPost(page, previewPath);
    const reviewAgain = dialog.getByRole('button', { name: '다시 미리보기', exact: true });
    await expect(reviewAgain).toBeFocused();
    await reviewAgain.click();
    const freshResponse = await inspected;
    expect(freshResponse.request().postDataJSON()).toEqual(proposalResponse.request().postDataJSON());
    const fresh = await readJson<SchedulePreview>(freshResponse);
    expect(fresh.previewId).toBeTruthy();
    expect(fresh.previewId).not.toBe(proposal.previewId);
    await expect(dialog.getByText(`${predecessor.key} → ${successor.key}`, { exact: false })).toBeVisible();
    await expect(apply).toBeEnabled();
    await expect(dialog).toBeFocused();
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    expect(await fixture.stored()).toEqual([schedule(changedPredecessor), schedule(successor)]);
  } finally { await fixture.close(); }
});

for (const { title, inline } of [
  { title: '간트 막대 드래그', inline: false },
  { title: '360px 간트 날짜 입력', inline: true },
]) {
  test(`${title} 저장 응답이 끊겨도 같은 결과를 확인하고 한 번 되돌린다`, async ({ page, request }) => {
    const fixture = await makeFixture(request);
    try {
      const issue = await fixture.create(title, 1, 4);
      const proposedEnd = fixture.date(6);
      if (inline) await page.setViewportSize({ width: 360, height: 820 });
      const { chart, dialog, undo } = await openChart(page, issue);
      const end = chart.getByLabel(`${issue.key} 종료일`, { exact: true });

      let lostResult: SchedulePasteApplyResult | undefined;
      let lostRequest: { previewId: string } | undefined;
      await page.route(`**${applyPath}`, async route => {
        lostRequest = route.request().postDataJSON();
        lostResult = await readJson<SchedulePasteApplyResult>(await route.fetch());
        await route.abort('failed');
      }, { times: 1 });
      const preview = nextPost(page, previewPath);
      if (inline) {
        await end.fill(proposedEnd);
        await end.press('Enter');
      } else {
        const handle = chart.getByRole('button', { name: `${issue.key} 종료일 조정`, exact: true });
        await handle.scrollIntoViewIfNeeded();
        const box = await handle.boundingBox();
        expect(box).not.toBeNull();
        const x = box!.x + box!.width / 2;
        const y = box!.y + box!.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 64, y, { steps: 6 });
        await page.mouse.up();
        await expect(dialog.locator('.gantt-new-dates')).toContainText(proposedEnd);
        expect(await fixture.stored()).toEqual([schedule(issue)]);
        await dialog.getByRole('button', { name: '변경 적용', exact: true }).click();
      }

      const previewResponse = await preview;
      expect(previewResponse.request().postDataJSON()).toEqual({ changes: [{
        id: issue.id, expectedVersion: issue.version, startDate: issue.startDate, endDate: proposedEnd,
      }] });
      const proposal = await readJson<SchedulePreview>(previewResponse);
      expect(proposal.previewId).toBeTruthy();
      const recover = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
      await expect(recover).toBeEnabled();
      await expect(recover).toBeFocused();
      if (inline) await expect(end).toHaveValue(proposedEnd);
      const moved = { ...schedule(issue), endDate: proposedEnd, version: issue.version + 1 };
      expect(await fixture.stored()).toEqual([moved]);
      expect(lostRequest).toEqual({ previewId: proposal.previewId });
      expect(lostResult?.undoId).toBeTruthy();

      const confirmation = nextPost(page, applyPath);
      await recover.click();
      const response = await confirmation;
      expect(response.request().postDataJSON()).toEqual(lostRequest);
      expect(await readJson<SchedulePasteApplyResult>(response)).toEqual(lostResult);
      await expect(dialog).toHaveCount(0);
      await expect(end).toHaveValue(proposedEnd);
      expect(await fixture.stored()).toEqual([moved]);

      const undoResponse = nextPost(page, undoPath);
      await undo.click();
      const result = await undoResponse;
      expect(result.request().postDataJSON()).toEqual({ undoId: lostResult?.undoId });
      await readJson(result);
      await expect(undo).toBeDisabled();
      await expect(end).toHaveValue(issue.endDate!);
      expect(await fixture.stored()).toEqual([{ ...schedule(issue), version: issue.version + 2 }]);
    } finally { await fixture.close(); }
  });
}

test('360px 간트 일정 완성의 저장 응답이 끊겨도 결과를 확인하고 원래 있던 날짜만 남긴다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const fixture = await makeFixture(request);
  try {
    const issue = await fixture.create('종료일만 있는 업무', null, 4);
    const proposedStart = fixture.date(2);
    await page.setViewportSize({ width: 360, height: 820 });
    const { dialog, undo } = await openChart(page, issue);
    const partialRow = page.locator('.gantt-unscheduled-row').filter({ hasText: issue.title });
    const complete = partialRow.getByRole('button', { name: '일정 완성', exact: true });

    let lostRequest: { previewId: string } | undefined;
    let lostResult: SchedulePasteApplyResult | undefined;
    await page.route(`**${applyPath}`, async route => {
      lostRequest = route.request().postDataJSON();
      lostResult = await readJson<SchedulePasteApplyResult>(await route.fetch());
      await route.abort('failed');
    }, { times: 1 });
    const preview = nextPost(page, previewPath);
    await complete.click();
    const previewResponse = await preview;
    expect(previewResponse.request().postDataJSON()).toEqual({ changes: [{
      id: issue.id, expectedVersion: issue.version, startDate: proposedStart, endDate: issue.endDate,
    }] });
    const proposal = await readJson<SchedulePreview>(previewResponse);
    expect(proposal.previewId).toBeTruthy();
    const recover = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(recover).toBeEnabled();
    await expect(recover).toBeFocused();
    expect(lostRequest).toEqual({ previewId: proposal.previewId });
    expect(lostResult?.undoId).toBeTruthy();
    const completed = { ...schedule(issue), startDate: proposedStart, version: issue.version + 1 };
    expect(await fixture.stored()).toEqual([completed]);

    const confirmation = nextPost(page, applyPath);
    await recover.click();
    const confirmed = await confirmation;
    expect(confirmed.request().postDataJSON()).toEqual(lostRequest);
    expect(await readJson<SchedulePasteApplyResult>(confirmed)).toEqual(lostResult);
    await expect(dialog).toHaveCount(0);
    await expect(partialRow).toHaveCount(0);
    expect(await fixture.stored()).toEqual([completed]);

    const undoResponse = nextPost(page, undoPath);
    await undo.click();
    const reverted = await undoResponse;
    expect(reverted.request().postDataJSON()).toEqual({ undoId: lostResult?.undoId });
    await readJson(reverted);
    await expect(complete).toBeVisible();
    await expect(undo).toBeDisabled();
    expect(await fixture.stored()).toEqual([{ ...schedule(issue), version: issue.version + 2 }]);
  } finally { await fixture.close(); }
});

test('간트 목록 새로고침이 실패해도 저장 결과를 알리고 일정을 되돌린다', async ({ page, request }) => {
  const fixture = await makeFixture(request);
  try {
    const issue = await fixture.create('저장 후 목록 새로고침', 1, 4);
    const { chart, dialog, undo } = await openChart(page, issue);
    const resize = chart.getByRole('button', { name: `${issue.key} 종료일 조정`, exact: true });
    const preview = nextPost(page, previewPath);
    await resize.press('ArrowRight');
    const proposal = await readJson<SchedulePreview>(await preview);
    expect(proposal.previewId).toBeTruthy();

    const appliedIds: string[] = [];
    page.on('request', sent => {
      if (sent.method() === 'POST' && new URL(sent.url()).pathname === applyPath) {
        appliedIds.push(sent.postDataJSON().previewId);
      }
    });
    const fullWorkspace = (url: URL) => url.pathname === '/api/workspace' && !url.search;
    await page.route(`**${applyPath}`, async route => {
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      await page.route(fullWorkspace, refresh => refresh.fulfill({
        status: 503, json: { error: '간트 목록 응답 실패 재현' },
      }), { times: 1 });
      await route.fulfill({ response });
    }, { times: 1 });

    const saved = nextPost(page, applyPath);
    const refresh = page.waitForResponse(response => fullWorkspace(new URL(response.url())) && response.status() === 503);
    await dialog.getByRole('button', { name: '변경 적용', exact: true }).click();
    const applied = await readJson<SchedulePasteApplyResult>(await saved);
    await refresh;
    await expect(page.getByText('일정을 저장했습니다. 간트 목록을 다시 불러와 주세요.', { exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(undo).toBeEnabled();
    expect(await fixture.stored()).toEqual([{ ...schedule(issue), endDate: fixture.date(5), version: issue.version + 1 }]);

    const undoResponse = nextPost(page, undoPath);
    await undo.click();
    const reverted = await undoResponse;
    expect(reverted.request().postDataJSON()).toEqual({ undoId: applied.undoId });
    await readJson(reverted);
    await expect(undo).toBeDisabled();
    expect(await fixture.stored()).toEqual([{ ...schedule(issue), version: issue.version + 2 }]);
    expect(appliedIds).toEqual([proposal.previewId]);
  } finally { await fixture.close(); }
});
