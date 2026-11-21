import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Dependency, Issue, ScheduleBulkDateInput, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot } from '../../shared/types';

const previewRoute = '/api/schedule/bulk-dates/preview';
const applyRoute = '/api/schedule/bulk-dates/apply';
const undoRoute = '/api/schedule/undo';
const dialogName = '일정 일괄 편집';
const previewName = '날짜 변경 미리보기';
const applyName = '검토한 일정 적용';

type Dates = Pick<Issue, 'startDate' | 'endDate' | 'dueDate'>;

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

async function workspace(request: APIRequestContext) {
  return readJson<WorkspaceSnapshot>(await request.get('/api/workspace'), 200);
}

const date = (day: number) => `2026-06-${String(day).padStart(2, '0')}`;

const values = ({ id, version, startDate, endDate, dueDate }: Issue) => ({ id, version, startDate, endDate, dueDate });

async function makeFixture(request: APIRequestContext) {
  const projectId = (await workspace(request)).projects[0].id;
  const prefix = `한꺼번에 변경 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  const links: Dependency[] = [];
  return {
    projectId, prefix,
    async create(title: string, dates: Dates) {
      const issue = await readJson<Issue>(await request.post('/api/issues', { data: { projectId, title, ...dates } }), 201);
      issues.push(issue);
      return issue;
    },
    async link(predecessor: Issue, successor: Issue) {
      const link = await readJson<Dependency>(await request.post('/api/dependencies', { data: {
        predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0,
      } }), 201);
      links.push(link);
    },
    async stored() {
      const byId = new Map((await workspace(request)).issues.map(issue => [issue.id, issue]));
      return issues.map(issue => values(byId.get(issue.id)!));
    },
    async close() {
      for (const link of links) await request.delete(`/api/dependencies/${link.id}`);
      for (const issue of issues) {
        const response = await request.delete(`/api/issues/${issue.id}`);
        if (response.ok()) {
          const archived = await response.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${archived.trashEntryId}`);
        }
      }
    },
  };
}

async function openChart(page: Page, projectId: string, prefix: string) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`/#/${projectId}/gantt`);
  const search = page.getByLabel('간트 업무 검색', { exact: true });
  await expect(search).toBeVisible({ timeout: 35_000 });
  await search.fill(prefix);
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  return {
    search, chart,
    open: page.getByRole('button', { name: dialogName, exact: true }),
    dialog: page.getByRole('dialog', { name: dialogName, exact: true }),
    selected: (issue: Issue) => chart.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true }),
  };
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

function selection(issues: Issue[]) {
  return issues.map(({ id, version }) => ({ id, expectedVersion: version })).sort((a, b) => a.id.localeCompare(b.id));
}

test('360px 간트에서 보이는 선택 업무의 날짜만 검토하고 응답 유실 뒤 한 번 적용한 뒤 되돌린다', async ({ page, request }) => {
  test.setTimeout(95_000);
  const fixture = await makeFixture(request);
  try {
    const prefix = `${fixture.prefix} 선택`;
    const first = await fixture.create(`${prefix} 첫 업무`, { startDate: date(1), endDate: date(4), dueDate: date(15) });
    const second = await fixture.create(`${prefix} 둘째 업무`, { startDate: date(2), endDate: date(5), dueDate: date(16) });
    const excluded = await fixture.create(`${fixture.prefix} 필터 밖 후행 업무`, { startDate: date(8), endDate: date(9), dueDate: date(18) });
    await fixture.link(first, excluded);
    const original = [first, second, excluded].map(values);
    const { search, chart, selected, open, dialog } = await openChart(page, fixture.projectId, fixture.prefix);
    await expect(open).toBeDisabled();
    for (const issue of [first, second, excluded]) await selected(issue).check();
    await search.fill(prefix);
    await expect(selected(excluded)).toHaveCount(0);
    await expect(selected(first)).toBeChecked();
    await expect(selected(second)).toBeChecked();
    await open.click();
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    const start = dialog.getByLabel('시작일 변경', { exact: true });
    const end = dialog.getByLabel('종료일 변경', { exact: true });
    const due = dialog.getByLabel('목표 마감일 변경', { exact: true });
    await expect(start).toHaveValue('keep');
    await end.selectOption('set');
    const endValue = dialog.getByLabel('종료일 값', { exact: true });
    await endValue.fill(date(12));
    await due.selectOption('clear');

    const nextPreview = nextPost(page, previewRoute);
    await dialog.getByRole('button', { name: previewName, exact: true }).click();
    const previewResponse = await nextPreview;
    const preview = await readJson<SchedulePastePreview>(previewResponse, 200);
    const input = previewResponse.request().postDataJSON() as ScheduleBulkDateInput;
    expect(input.projectId).toBe(fixture.projectId);
    expect(input.issues.sort((a, b) => a.id.localeCompare(b.id))).toEqual(selection([first, second]));
    expect(input.changes).toEqual({ endDate: date(12), dueDate: null });
    expect(preview.previewId).toBeTruthy();
    expect(preview.errors).toEqual([]);
    expect(preview.changes).toHaveLength(2);
    for (const issue of [first, second]) {
      expect(preview.changes.find(change => change.id === issue.id)).toMatchObject({
        fromStart: issue.startDate, toStart: issue.startDate, fromEnd: issue.endDate, toEnd: date(12), fromDue: issue.dueDate, toDue: null,
      });
    }
    expect(preview.warnings.some(warning => warning.includes(excluded.key))).toBe(true);
    const changes = dialog.getByRole('table', { name: '선택 업무 날짜 변경 목록', exact: true });
    await expect(changes.getByRole('columnheader', { name: '목표 마감일', exact: true })).toBeVisible();
    for (const issue of [first, second]) {
      const row = changes.getByRole('row').filter({ has: page.getByText(issue.key, { exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.getByRole('cell').nth(1)).toContainText(date(12));
      await expect(row.getByRole('cell').nth(2)).toContainText(issue.dueDate!);
      await expect(row.getByRole('cell').nth(2)).toContainText('삭제');
    }
    await expect(changes.getByText(excluded.key, { exact: true })).toHaveCount(0);
    expect(await fixture.stored()).toEqual(original);

    let lostResult: SchedulePasteApplyResult | undefined;
    const attempts: string[] = [];
    await page.route(`**${applyRoute}`, async route => {
      const body = route.request().postDataJSON() as { previewId: string };
      attempts.push(body.previewId);
      if (attempts.length === 1) {
        lostResult = await readJson<SchedulePasteApplyResult>(await route.fetch(), 200);
        await route.fulfill({ status: 408, json: { error: '합성 프록시 응답 시간 초과' } });
      } else if (attempts.length === 2) {
        await route.fulfill({ status: 401, json: { error: '합성 접속 확인 필요' } });
      } else {
        await route.continue();
      }
    });
    await dialog.getByRole('button', { name: applyName, exact: true }).click();
    const recover = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(recover).toBeEnabled();
    await expect(endValue).toHaveValue(date(12));
    await expect(due).toHaveValue('clear');
    const applied = [
      ...[first, second].map(issue => ({ ...values(issue), version: issue.version + 1, endDate: date(12), dueDate: null })),
      values(excluded),
    ];
    expect(await fixture.stored()).toEqual(applied);
    await recover.click();
    await expect(dialog.getByRole('alert')).toContainText('합성 접속 확인 필요');
    await expect(recover).toBeEnabled();
    await expect(endValue).toBeDisabled();
    const nextApply = nextPost(page, applyRoute);
    await recover.click();
    expect(await readJson<SchedulePasteApplyResult>(await nextApply, 200)).toEqual(lostResult);
    await expect(dialog).toHaveCount(0);
    expect(attempts).toEqual([preview.previewId, preview.previewId, preview.previewId]);
    expect(await fixture.stored()).toEqual(applied);
    for (const issue of [first, second]) {
      await expect(chart.getByLabel(`${issue.key} 시작일`, { exact: true })).toHaveValue(issue.startDate!);
      await expect(chart.getByLabel(`${issue.key} 종료일`, { exact: true })).toHaveValue(date(12));
    }

    const nextUndo = nextPost(page, undoRoute);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undoResponse = await nextUndo;
    expect(undoResponse.request().postDataJSON()).toEqual({ undoId: lostResult?.undoId });
    await readJson<{ updated: Issue[] }>(undoResponse, 200);
    expect(await fixture.stored()).toEqual([
      ...[first, second].map(issue => ({ ...values(issue), version: issue.version + 2 })),
      values(excluded),
    ]);
    await expect(chart.getByLabel(`${first.key} 종료일`, { exact: true })).toHaveValue(first.endDate!);
  } finally { await fixture.close(); }
});

test('선택 업무의 날짜 오류와 검토 이후 충돌은 적용을 막고 날짜 선택을 보존한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const fixture = await makeFixture(request);
  try {
    const first = await fixture.create(`${fixture.prefix} 첫 업무`, { startDate: date(1), endDate: date(6), dueDate: date(12) });
    const second = await fixture.create(`${fixture.prefix} 둘째 업무`, { startDate: date(2), endDate: date(3), dueDate: date(12) });
    const { selected, open, dialog } = await openChart(page, fixture.projectId, fixture.prefix);
    for (const issue of [first, second]) await selected(issue).check();
    await open.click();
    const start = dialog.getByLabel('시작일 변경', { exact: true });
    const startValue = dialog.getByLabel('시작일 값', { exact: true });
    await start.selectOption('set');
    await startValue.fill(date(5));
    const previewButton = dialog.getByRole('button', { name: previewName, exact: true });
    const rejectedPreview = nextPost(page, previewRoute);
    await previewButton.click();
    const rejected = await readJson<SchedulePastePreview>(await rejectedPreview, 200);
    expect(rejected.previewId).toBeNull();
    expect(rejected.errors).toEqual(expect.arrayContaining([expect.objectContaining({ key: second.key })]));
    await expect(dialog.getByLabel('선택 업무 날짜 오류', { exact: true })).toContainText(second.key);
    const applyButton = dialog.getByRole('button', { name: applyName, exact: true });
    await expect(applyButton).toBeDisabled();
    expect(await fixture.stored()).toEqual([first, second].map(values));

    const end = dialog.getByLabel('종료일 변경', { exact: true });
    const endValue = dialog.getByLabel('종료일 값', { exact: true });
    await end.selectOption('set');
    await endValue.fill(date(10));
    await dialog.getByLabel('목표 마감일 변경', { exact: true }).selectOption('set');
    const dueValue = dialog.getByLabel('목표 마감일 값', { exact: true });
    await dueValue.fill(date(20));
    const acceptedPreview = nextPost(page, previewRoute);
    await previewButton.click();
    const approved = await readJson<SchedulePastePreview>(await acceptedPreview, 200);
    expect(approved.previewId).toBeTruthy();
    expect(approved.errors).toEqual([]);
    const changed = await readJson<Issue>(await request.patch(`/api/issues/${second.id}`, { data: {
      expectedVersion: second.version, endDate: date(7), dueDate: date(14),
    } }), 200);

    const staleApply = nextPost(page, applyRoute);
    await applyButton.click();
    const collision = await staleApply;
    expect(collision.status(), await collision.text()).toBe(409);
    expect(collision.request().postDataJSON()).toEqual({ previewId: approved.previewId });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(applyButton).toBeDisabled();
    await expect(end).toHaveValue('set');
    await expect(endValue).toHaveValue(date(10));
    await expect(startValue).toHaveValue(date(5));
    await expect(dueValue).toHaveValue(date(20));
    expect(await fixture.stored()).toEqual([first, changed].map(values));

    await dialog.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(endValue).toHaveValue(date(10));
    const refreshedPreview = nextPost(page, previewRoute);
    await previewButton.click();
    const response = await refreshedPreview;
    const fresh = await readJson<SchedulePastePreview>(response, 200);
    expect(fresh.previewId).toBeTruthy();
    expect(fresh.previewId).not.toBe(approved.previewId);
    const input = response.request().postDataJSON() as ScheduleBulkDateInput;
    expect(input.issues.sort((a, b) => a.id.localeCompare(b.id))).toEqual(selection([first, changed]));
    const allDates = { startDate: date(5), endDate: date(10), dueDate: date(20) };
    expect(input.changes).toEqual(allDates);
    expect(fresh.changes.find(change => change.id === second.id)).toMatchObject({ fromEnd: date(7), toEnd: date(10) });
    expect(await fixture.stored()).toEqual([first, changed].map(values));

    const applied = nextPost(page, applyRoute);
    await applyButton.click();
    await readJson<SchedulePasteApplyResult>(await applied, 200);
    await expect(dialog).toHaveCount(0);
    expect(await fixture.stored()).toEqual([first, changed].map(issue => ({ ...values(issue), ...allDates, version: issue.version + 1 })));

    const undone = nextPost(page, undoRoute);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await readJson<{ updated: Issue[] }>(await undone, 200);
    expect(await fixture.stored()).toEqual([first, changed].map(issue => ({ ...values(issue), version: issue.version + 2 })));
  } finally { await fixture.close(); }
});
