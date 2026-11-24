import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Issue, PlanningItem, PlanScheduleShiftPreview, PlanScheduleShiftResult, Project, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

const today = Date.now();
const day = (offset: number) => new Date(today + offset * 86_400_000).toISOString().slice(0, 10);

test('360px에서 계획과 연결 업무를 미리 보고 적용 응답을 복구한 뒤 함께 되돌린다', async ({ page, request }) => {
  const key = `PS${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const projectResponse = await request.post('/api/projects', { data: { key, name: `계획 이동 ${key}` } });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json() as Project;
  const beforePlanDates = { startDate: day(0), endDate: day(6), targetDate: day(7) };
  const planResponse = await request.post('/api/planning-items', { data: { projectId: project.id, kind: 'cycle', name: `이동 사이클 ${key}`, ...beforePlanDates } });
  expect(planResponse.status(), await planResponse.text()).toBe(201);
  const plan = await planResponse.json() as PlanningItem;
  const issues: Issue[] = [];
  async function createIssue(name: string, values: Partial<Issue>) {
    const response = await request.post('/api/issues', { data: { projectId: project.id, title: name, cycleId: plan.id, ...values } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }
  async function snapshot() {
    return await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  }

  try {
    const moving = await createIssue(`옮길 업무 ${key}`, { startDate: day(1), endDate: day(3) });
    const completed = await createIssue(`완료된 업무 ${key}`, { status: 'done', startDate: day(1), endDate: day(2) });
    const unscheduled = await createIssue(`날짜 미정 업무 ${key}`, {});
    const outside = await createIssue(`다른 업무 ${key}`, { cycleId: null, startDate: day(4), endDate: day(7) });
    expect((await request.post('/api/dependencies', { data: { predecessorId: moving.id, successorId: outside.id } })).status()).toBe(201);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/gantt/${plan.id}`);
    const open = page.getByRole('button', { name: '계획 일정 함께 이동', exact: true });
    await open.click();
    const dialog = page.getByRole('dialog', { name: '계획 일정 함께 이동', exact: true });
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const days = dialog.getByLabel('계획 이동 일수', { exact: true });
    expect(await days.inputValue()).toBe('5');
    await days.fill('3');
    await expect(dialog.getByLabel('연결된 업무도 함께 이동', { exact: true })).toBeChecked();
    await expect(dialog.getByLabel('계획 이동에 근무일 사용', { exact: true })).not.toBeChecked();
    const previewResponse = page.waitForResponse(response => response.url().endsWith(`/planning-items/${plan.id}/schedule-preview`));
    await dialog.getByRole('button', { name: '계획 이동 미리보기', exact: true }).click();
    const previewReply = await previewResponse;
    expect(previewReply.status(), await previewReply.text()).toBe(200);
    const preview = await previewReply.json() as PlanScheduleShiftPreview;
    const movedPlanDates = { startDate: day(3), endDate: day(9), targetDate: day(10) };
    expect(preview.plan).toMatchObject({ id: plan.id, from: beforePlanDates, to: movedPlanDates });
    expect(preview.changes).toMatchObject([{ id: moving.id, toStart: day(4), toEnd: day(6) }]);
    expect(preview.skipped.map(item => [item.id, item.reason])).toEqual(expect.arrayContaining([[completed.id, 'terminal'], [unscheduled.id, 'unscheduled']]));
    expect(preview.warnings.some(warning => warning.includes(outside.key))).toBe(true);
    await expect(dialog).toContainText(day(10));
    await expect(dialog).toContainText(moving.key);
    const beforeApply = await snapshot();
    expect(beforeApply.planningItems!.find(item => item.id === plan.id)).toMatchObject(beforePlanDates);
    expect(beforeApply.issues.find(issue => issue.id === moving.id)!.version).toBe(moving.version);

    let attempts = 0;
    let committed: PlanScheduleShiftResult | undefined;
    await page.route(`**/planning-items/${plan.id}/schedule-apply`, async route => {
      attempts++;
      const response = await route.fetch();
      if (attempts === 1 && response.ok()) {
        committed = await response.json() as PlanScheduleShiftResult;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await dialog.getByRole('button', { name: '계획 이동 적용', exact: true }).click();
    const recover = dialog.getByRole('button', { name: '계획 이동 적용 결과 다시 확인', exact: true });
    await expect(recover).toBeVisible();
    await expect(days).toBeDisabled();
    expect(committed?.plan).toMatchObject(movedPlanDates);
    expect(committed?.updated).toMatchObject([{ id: moving.id, startDate: day(4), endDate: day(6), version: moving.version + 1 }]);
    await recover.click();
    await expect(dialog).toBeHidden();
    expect(attempts).toBe(2);
    const applied = await snapshot();
    expect(applied.planningItems!.find(item => item.id === plan.id)).toMatchObject({ ...movedPlanDates, version: plan.version + 1 });
    expect(applied.issues.find(item => item.id === moving.id)!.version).toBe(moving.version + 1);

    const undoResponse = page.waitForResponse(response => response.url().endsWith('/api/schedule/undo'));
    await page.locator('button[title="마지막 일정 변경 되돌리기"]').click();
    const undone = await undoResponse;
    expect(undone.status(), await undone.text()).toBe(200);
    expect(await undone.json()).toMatchObject({ plan: beforePlanDates, updated: [{ id: moving.id, startDate: moving.startDate, endDate: moving.endDate }] });
    const current = await snapshot();
    expect(current.planningItems!.find(item => item.id === plan.id)).toMatchObject({ ...beforePlanDates, version: plan.version + 2 });
    for (const issue of [completed, unscheduled, outside]) expect(current.issues.find(item => item.id === issue.id)).toEqual(issue);
  } finally {
    for (const issue of issues) await request.delete(`/api/issues/${issue.id}`);
    const current = (await snapshot()).planningItems?.find(item => item.id === plan.id);
    if (current) await request.delete(`/api/planning-items/${plan.id}?expectedVersion=${current.version}`);
  }
});

test('360px에서 계획과 연결 업무를 이동할 때 다른 프로젝트의 작업 달력으로 차단을 검토한다', async ({ page, request }) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase();
  const projects: Project[] = [];
  for (const key of [`PSA${suffix}`, `PSB${suffix}`]) {
    const response = await request.post('/api/projects', { data: { key, name: `계획 차단 ${key}` } });
    expect(response.status(), await response.text()).toBe(201);
    projects.push(await response.json() as Project);
  }
  const [sourceProject, targetProject] = projects;
  const planDates = { startDate: '2026-11-16', endDate: '2026-11-20', targetDate: '2026-11-23' };
  const planResponse = await request.post('/api/planning-items', { data: {
    projectId: sourceProject.id, kind: 'cycle', name: `차단 일정 사이클 ${suffix}`, ...planDates,
  } });
  expect(planResponse.status(), await planResponse.text()).toBe(201);
  const plan = await planResponse.json() as PlanningItem;
  const calendarPath = `/api/projects/${targetProject.id}/calendar`;
  const initialCalendar = await request.get(calendarPath);
  expect(initialCalendar.ok(), await initialCalendar.text()).toBe(true);
  const calendar = await initialCalendar.json() as WorkCalendar;
  const issues: Issue[] = [];
  let calendarChanged: WorkCalendar | undefined;
  async function createIssue(values: Partial<Issue>) {
    const response = await request.post('/api/issues', { data: values });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }
  async function snapshot() {
    const response = await request.get('/api/workspace');
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as WorkspaceSnapshot;
  }
  function nextPost(path: string) {
    return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
  }

  try {
    const source = await createIssue({ projectId: sourceProject.id, cycleId: plan.id, title: `옮길 선행 업무 ${suffix}`,
      startDate: '2026-11-16', endDate: '2026-11-17' });
    const target = await createIssue({ projectId: targetProject.id, title: `다른 프로젝트의 후행 업무 ${suffix}`,
      startDate: '2026-11-19', endDate: '2026-11-26' });
    const relation = await request.post(`/api/issues/${source.id}/relations`, {
      data: { otherIssueId: target.id, type: 'blocks', direction: 'outgoing' },
    });
    expect(relation.status(), await relation.text()).toBe(201);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${sourceProject.id}/gantt/${plan.id}`);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.locator(`[data-issue-id="${target.id}"]`)).toHaveCount(0);
    await page.getByRole('button', { name: '계획 일정 함께 이동', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '계획 일정 함께 이동', exact: true });
    const days = dialog.getByLabel('계획 이동 일수', { exact: true });
    const includeLinked = dialog.getByLabel('연결된 업무도 함께 이동', { exact: true });
    const warnings = dialog.getByRole('region', { name: '일정·의존성 경고', exact: true });
    const apply = dialog.getByRole('button', { name: '계획 이동 적용', exact: true });
    await days.fill('3');

    async function preview() {
      const pending = nextPost(`/api/planning-items/${plan.id}/schedule-preview`);
      await dialog.getByRole('button', { name: '계획 이동 미리보기', exact: true }).click();
      const response = await pending;
      expect(response.status(), await response.text()).toBe(200);
      return await response.json() as PlanScheduleShiftPreview;
    }
    await includeLinked.uncheck();
    const planOnly = await preview();
    expect(planOnly.previewId).toBeTruthy();
    expect(planOnly.changes).toEqual([]);
    expect(planOnly.warnings).toEqual([]);
    await expect(warnings).toHaveCount(0);

    await includeLinked.check();
    const linked = await preview();
    const warning = (required: string) =>
      `프로젝트 간 차단 관계 ${source.key} → ${target.key} · 선행 업무 종료일 2026-11-20에 따라 후행 업무 시작일은 ${required} 이후여야 합니다.`;
    expect(linked.changes).toMatchObject([{ id: source.id, toStart: '2026-11-19', toEnd: '2026-11-20' }]);
    expect(linked.warnings).toEqual([warning('2026-11-23')]);
    await expect(warnings.getByText(warning('2026-11-23'), { exact: true })).toBeVisible();
    await expect(apply).toBeEnabled();

    const { users: [, peer] } = await snapshot();
    const changed = await request.patch(calendarPath, { headers: { 'X-Actor-Id': peer.id }, data: {
      ...calendar, expectedVersion: calendar.version,
      exceptions: [{ date: '2026-11-23', isWorking: false, label: '후행 프로젝트 휴무일' }],
    } });
    expect(changed.ok(), await changed.text()).toBe(true);
    calendarChanged = await changed.json() as WorkCalendar;
    const staleApply = nextPost(`/api/planning-items/${plan.id}/schedule-apply`);
    await apply.click();
    const rejected = await staleApply;
    expect(rejected.status(), await rejected.text()).toBe(409);
    expect(rejected.request().postDataJSON()).toEqual({ previewId: linked.previewId });
    await expect(dialog.getByRole('alert')).toContainText('프로젝트 간 차단');
    await expect(apply).toBeDisabled();
    await expect(days).toHaveValue('3');
    await expect(includeLinked).toBeChecked();
    const unchanged = await snapshot();
    expect(unchanged.planningItems?.find(item => item.id === plan.id)).toEqual(plan);
    expect(unchanged.issues.find(issue => issue.id === source.id)).toEqual(source);

    const reviewed = await preview();
    expect(reviewed.warnings).toEqual([warning('2026-11-24')]);
    await expect(warnings.getByText(warning('2026-11-24'), { exact: true })).toBeVisible();
    const freshApply = nextPost(`/api/planning-items/${plan.id}/schedule-apply`);
    await apply.click();
    const confirmed = await freshApply;
    expect(confirmed.status(), await confirmed.text()).toBe(200);
    expect(confirmed.request().postDataJSON()).toEqual({ previewId: reviewed.previewId });
    const result = await confirmed.json() as PlanScheduleShiftResult;
    expect(result.updated).toMatchObject([{ id: source.id, version: source.version + 1, startDate: '2026-11-19', endDate: '2026-11-20' }]);
    expect(result.warnings).toEqual([warning('2026-11-24')]);
    await expect(dialog).toBeHidden();
    expect((await snapshot()).issues.find(issue => issue.id === target.id)).toEqual(target);

    const undoing = nextPost('/api/schedule/undo');
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undone = await undoing;
    expect(undone.ok(), await undone.text()).toBe(true);
    const restored = await snapshot();
    expect(restored.planningItems?.find(item => item.id === plan.id)).toMatchObject({ ...planDates, version: plan.version + 2 });
    expect(restored.issues.find(issue => issue.id === source.id)).toMatchObject({
      startDate: source.startDate, endDate: source.endDate, version: source.version + 2,
    });
    expect(restored.issues.find(issue => issue.id === target.id)).toEqual(target);
    const restoredCalendar = await request.get(calendarPath);
    expect(restoredCalendar.ok(), await restoredCalendar.text()).toBe(true);
    expect(await restoredCalendar.json()).toEqual(calendarChanged);
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
    const current = (await snapshot()).planningItems?.find(item => item.id === plan.id);
    if (current) await request.delete(`/api/planning-items/${plan.id}?expectedVersion=${current.version}`);
    if (calendarChanged) await request.patch(calendarPath, { data: { ...calendar, expectedVersion: calendarChanged.version } });
  }
});
