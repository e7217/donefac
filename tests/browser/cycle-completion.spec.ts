import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { CycleCompletionPreview, CycleCompletionResult, Issue, PlanningItem, WorkspaceSnapshot } from '../../shared/types';

async function read<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

function workspace(request: APIRequestContext) {
  return request.get('/api/workspace').then(response => read<WorkspaceSnapshot>(response));
}

function day(offset: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function cycleFixture(request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 8);
  const plans: PlanningItem[] = [];
  const issues: Issue[] = [];
  return {
    async plan(projectId: string, name: string, status: PlanningItem['status'], kind: PlanningItem['kind'] = 'cycle') {
      const response = await request.post('/api/planning-items', {
        data: { projectId, kind, name: `${name} ${suffix}`, status, startDate: day(-2), endDate: day(8) },
      });
      const result = await read<PlanningItem>(response, 201);
      plans.push(result);
      return result;
    },
    async issue(cycle: PlanningItem, title: string, status: Issue['status']) {
      const response = await request.post('/api/issues', {
        data: { projectId: cycle.projectId, cycleId: cycle.id, title: `${title} ${suffix}`, status,
          startDate: day(1), endDate: day(3), dueDate: day(6) },
      });
      const result = await read<Issue>(response, 201);
      issues.push(result);
      return result;
    },
    async clean() {
      for (const issue of issues.reverse()) {
        const response = await request.delete(`/api/issues/${issue.id}`);
        if (response.ok()) {
          const { trashEntryId } = await response.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`);
        }
      }
      for (const plan of plans.reverse()) {
        const response = await request.get(`/api/planning-items/${plan.id}`);
        if (response.ok()) {
          const current = await response.json() as PlanningItem;
          await request.delete(`/api/planning-items/${plan.id}?expectedVersion=${current.version}`);
        }
      }
    },
  };
}

function completionResponse(page: Page, cycle: PlanningItem, preview = false) {
  const path = `/api/planning-items/${cycle.id}/complete${preview ? '/preview' : ''}`;
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

async function openCompletion(page: Page, cycle: PlanningItem) {
  await page.goto(`/#/${cycle.projectId}/planning/${cycle.id}`);
  const editor = page.getByRole('region', { name: '사이클 상세', exact: true });
  const open = editor.getByRole('button', { name: '사이클 완료', exact: true });
  const dialog = page.getByRole('dialog', { name: '사이클 완료', exact: true });
  const status = editor.getByLabel('계획 상태', { exact: true });
  await expect(status).toHaveValue('active');
  await expect(status.locator('option[value="completed"]:not(:disabled)')).toHaveCount(0);
  await open.click();
  await expect(dialog).toBeVisible();
  return { dialog, editor, open, destination: dialog.getByRole('combobox', { name: '미완료 업무 이동 대상', exact: true }),
    preview: dialog.getByRole('button', { name: '완료 미리보기', exact: true }),
    apply: dialog.getByRole('button', { name: '사이클 완료 적용', exact: true }) };
}

test('사이클을 완료하며 미완료 업무만 다음 사이클로 옮기고 간트 날짜를 보존한다', async ({ page, request }) => {
  const fixture = cycleFixture(request);
  try {
    const { projects: [project, other] } = await workspace(request);
    const cycle = await fixture.plan(project.id, '완료할 사이클', 'active');
    const destination = await fixture.plan(project.id, '다음 사이클', 'planned');
    const archived = await fixture.plan(project.id, '보관한 사이클', 'archived');
    const otherCycle = await fixture.plan(other.id, '다른 프로젝트 사이클', 'active');
    const modulePlan = await fixture.plan(project.id, '같은 프로젝트 모듈', 'planned', 'module');
    const carry = await fixture.issue(cycle, '이월할 업무', 'in_progress');
    const done = await fixture.issue(cycle, '완료된 업무', 'done');
    const cancelled = await fixture.issue(cycle, '취소된 업무', 'cancelled');
    const existing = await fixture.issue(destination, '다음 사이클의 기존 업무', 'todo');

    const modal = await openCompletion(page, cycle);
    for (const excluded of [cycle, archived, otherCycle, modulePlan]) {
      await expect(modal.destination.locator('option').filter({ hasText: excluded.name })).toHaveCount(0);
    }
    await modal.destination.selectOption({ label: `${destination.name} (계획)` });
    const previewed = completionResponse(page, cycle, true);
    await modal.preview.click();
    const draftResponse = await previewed;
    expect(draftResponse.status(), await draftResponse.text()).toBe(200);
    expect(draftResponse.request().postDataJSON()).toEqual({ destinationId: destination.id, expectedVersion: cycle.version });
    const draft = await draftResponse.json() as CycleCompletionPreview;
    expect(draft.counts).toEqual({ carry: 1, done: 1, cancelled: 1, blocked: 0 });
    expect(draft.issues.map(({ id, disposition }) => [id, disposition])).toEqual(expect.arrayContaining([
      [carry.id, 'carry'], [done.id, 'done'], [cancelled.id, 'cancelled'],
    ]));
    for (const [name, issue] of [['이동할 업무 1건', carry], ['완료 상태 업무 1건', done], ['취소 상태 업무 1건', cancelled]] as const) {
      await expect(modal.dialog.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(modal.dialog.getByText(issue.title, { exact: true })).toBeVisible();
    }
    await expect(modal.dialog.getByText(existing.title, { exact: true })).toHaveCount(0);
    const before = await workspace(request);
    expect(before.planningItems?.find(plan => plan.id === cycle.id)).toEqual(cycle);
    expect(before.issues.find(issue => issue.id === carry.id)).toEqual(carry);

    const committed = completionResponse(page, cycle);
    await modal.apply.click();
    const completed = await committed;
    expect(completed.status(), await completed.text()).toBe(200);
    expect(completed.request().postDataJSON()).toEqual({ previewId: draft.previewId });
    const result = await completed.json() as CycleCompletionResult;
    expect(result.cycle).toMatchObject({ id: cycle.id, status: 'completed', version: cycle.version + 1,
      startDate: cycle.startDate, endDate: cycle.endDate });
    await expect(modal.dialog.getByText('사이클을 완료했습니다.', { exact: false })).toBeVisible();
    await modal.dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(modal.dialog).toHaveCount(0);
    await expect(modal.editor.getByLabel('계획 상태', { exact: true })).toHaveValue('completed');
    await expect(modal.editor.getByRole('checkbox', { name: `${done.key} 계획 연결`, exact: true })).toBeChecked();
    await expect(modal.editor.getByRole('checkbox', { name: `${cancelled.key} 계획 연결`, exact: true })).toBeChecked();
    await expect(modal.editor.getByRole('checkbox', { name: `${carry.key} 계획 연결`, exact: true })).toHaveCount(0);

    const stored = (await workspace(request)).issues;
    expect(stored.find(issue => issue.id === carry.id)).toMatchObject({ cycleId: destination.id, cycle: destination.name,
      version: carry.version + 1, status: carry.status, startDate: carry.startDate, endDate: carry.endDate, dueDate: carry.dueDate });
    for (const issue of [done, cancelled, existing]) expect(stored.find(item => item.id === issue.id)).toEqual(issue);

    await page.locator('.planning-item-card').filter({ hasText: destination.name }).click();
    await expect(modal.editor.getByRole('checkbox', { name: `${carry.key} 계획 연결`, exact: true })).toBeChecked();
    await page.getByRole('link', { name: '간트에서 열기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === `#/${project.id}/gantt/${destination.id}`);
    await page.getByRole('checkbox', { name: '연결된 업무만', exact: true }).check();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const carriedRow = chart.locator(`[data-issue-id="${carry.id}"]`);
    await expect(carriedRow).toBeVisible();
    await expect(carriedRow.getByLabel(`${carry.key} 시작일`, { exact: true })).toHaveValue(carry.startDate!);
    await expect(carriedRow.getByLabel(`${carry.key} 종료일`, { exact: true })).toHaveValue(carry.endDate!);
    for (const issue of [done, cancelled]) await expect(chart.locator(`[data-issue-id="${issue.id}"]`)).toHaveCount(0);
  } finally { await fixture.clean(); }
});

test('360px에서 변경된 미리보기를 다시 검토하고 유실된 응답을 같은 ID로 확인한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const fixture = cycleFixture(request);
  try {
    const { projects: [project] } = await workspace(request);
    const cycle = await fixture.plan(project.id, '응답 재확인 사이클', 'active');
    const changed = await fixture.issue(cycle, '다른 작업자가 완료할 업무', 'todo');
    const carry = await fixture.issue(cycle, '백로그로 이동할 업무', 'review');
    const modal = await openCompletion(page, cycle);
    await modal.dialog.getByRole('button', { name: '사이클 완료 닫기', exact: true }).click();
    await expect(modal.open).toBeFocused();
    await modal.open.click();
    expect(await modal.dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const backlog = modal.destination.locator('option').filter({ hasText: '백로그 (사이클 미지정)' });
    const backlogValue = await backlog.getAttribute('value');
    expect(backlogValue).not.toBeNull();
    await modal.destination.selectOption(backlogValue!);

    const firstPreview = completionResponse(page, cycle, true);
    await modal.preview.click();
    const firstResponse = await firstPreview;
    expect(firstResponse.status(), await firstResponse.text()).toBe(200);
    expect(firstResponse.request().postDataJSON()).toEqual({ expectedVersion: cycle.version, destinationId: null });
    const firstDraft = await firstResponse.json() as CycleCompletionPreview;
    expect(firstDraft.counts.carry).toBe(2);
    await expect(modal.dialog.getByRole('heading', { name: '이동할 업무 2건', exact: true })).toBeVisible();

    const remotelyCompleted = await read<Issue>(await request.patch(`/api/issues/${changed.id}`, { data: {
      expectedVersion: changed.version, status: 'done',
    } }));
    const conflict = completionResponse(page, cycle);
    await modal.apply.click();
    expect((await conflict).status()).toBe(409);
    await expect(modal.dialog.getByRole('alert')).toBeVisible();
    await expect(modal.destination).toHaveValue(backlogValue!);
    const conflictedWorkspace = await workspace(request);
    expect(conflictedWorkspace.issues.find(issue => issue.id === carry.id)).toEqual(carry);
    expect(conflictedWorkspace.planningItems?.find(plan => plan.id === cycle.id)).toEqual(cycle);

    await modal.dialog.getByRole('button', { name: '최신 사이클 확인', exact: true }).click();
    const freshPreview = completionResponse(page, cycle, true);
    await modal.preview.click();
    const freshResponse = await freshPreview;
    expect(freshResponse.status(), await freshResponse.text()).toBe(200);
    const draft = await freshResponse.json() as CycleCompletionPreview;
    expect(draft.previewId).not.toBe(firstDraft.previewId);
    expect(draft.counts).toEqual({ carry: 1, done: 1, cancelled: 0, blocked: 0 });
    await expect(modal.dialog.getByRole('heading', { name: '이동할 업무 1건', exact: true })).toBeVisible();
    await expect(modal.dialog.getByRole('heading', { name: '완료 상태 업무 1건', exact: true })).toBeVisible();

    const attempts: unknown[] = [];
    await page.route(`**/api/planning-items/${cycle.id}/complete`, async route => {
      attempts.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (attempts.length === 1 && response.ok()) return route.abort('failed');
      await route.fulfill({ response });
    });
    await modal.apply.click();
    const retry = modal.dialog.getByRole('button', { name: '같은 완료 요청 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    const afterLost = await workspace(request);
    expect(afterLost.planningItems?.find(plan => plan.id === cycle.id)).toMatchObject({ status: 'completed', version: cycle.version + 1 });
    const checked = completionResponse(page, cycle);
    await retry.click();
    const checkedResponse = await checked;
    expect(checkedResponse.status(), await checkedResponse.text()).toBe(200);
    expect(attempts).toEqual([{ previewId: draft.previewId }, { previewId: draft.previewId }]);
    await expect(modal.dialog.getByText('사이클을 완료했습니다.', { exact: false })).toBeVisible();
    const afterRetry = await workspace(request);
    expect(afterRetry.activities).toEqual(afterLost.activities);
    expect(afterRetry.issues.find(issue => issue.id === changed.id)).toEqual(remotelyCompleted);
    expect(afterRetry.issues.find(issue => issue.id === carry.id)).toMatchObject({ cycleId: null, cycle: null,
      version: carry.version + 1, status: carry.status, startDate: carry.startDate, endDate: carry.endDate, dueDate: carry.dueDate });
  } finally { await fixture.clean(); }
});
