import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import type { Issue, PlanningItem, PlanningKind, Project, WorkspaceSnapshot } from '../../shared/types';

const labels: Record<PlanningKind, string> = { cycle: '사이클', module: '모듈', release: '릴리스' };
const today = new Date().toISOString().slice(0, 10);
const day = (offset: number) => {
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
};
interface PlanningFixture {
  request: APIRequestContext;
  project: Project;
  plans: Record<PlanningKind, PlanningItem>;
  linked: Record<PlanningKind, Issue>;
  unlinked: Issue;
}

const test = base.extend<{ planning: PlanningFixture }>({
  planning: [async ({ playwright, baseURL }, provide) => {
    // Independent request lifetime lets teardown run after a page/test timeout.
    const request = await playwright.request.newContext({ baseURL, timeout: 10000 });
    let project: Project | null = null;
    const plans = {} as Record<PlanningKind, PlanningItem>;
    const linked = {} as Record<PlanningKind, Issue>;
    try {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
      const projectResponse = await request.post('/api/projects', {
        data: { key: `GP${suffix}`, name: `간트 계획 검증 ${suffix}`, description: '간트 계획 항목의 합성 브라우저 검사' },
      });
      expect(projectResponse.status(), await projectResponse.text()).toBe(201);
      project = await projectResponse.json() as Project;
      for (const [index, kind] of (['cycle', 'module', 'release'] as const).entries()) {
        const planResponse = await request.post('/api/planning-items', {
          data: {
            projectId: project.id, kind, name: `${labels[kind]} 검증 ${suffix}`, status: 'active',
            startDate: day(index), endDate: day(index + 5), targetDate: day(index + 6),
          },
        });
        expect(planResponse.status(), await planResponse.text()).toBe(201);
        plans[kind] = await planResponse.json() as PlanningItem;
        const issueResponse = await request.post('/api/issues', {
          data: {
            projectId: project.id, title: `${labels[kind]} 연결 업무 ${suffix}`,
            [`${kind}Id`]: plans[kind].id, startDate: day(index + 1), endDate: day(index + 3),
          },
        });
        expect(issueResponse.status(), await issueResponse.text()).toBe(201);
        linked[kind] = await issueResponse.json() as Issue;
      }
      const unlinkedResponse = await request.post('/api/issues', {
        data: { projectId: project.id, title: `간트에서 배정할 업무 ${suffix}`, startDate: day(0), endDate: day(2) },
      });
      expect(unlinkedResponse.status(), await unlinkedResponse.text()).toBe(201);
      const unlinked = await unlinkedResponse.json() as Issue;
      await provide({ request, project, plans, linked, unlinked });
    } finally {
      try {
        if (project) {
          const response = await request.get('/api/workspace', { timeout: 5000 });
          if (response.ok()) {
            const workspace = await response.json() as WorkspaceSnapshot;
            for (const issue of workspace.issues.filter(item => item.projectId === project!.id)) {
              await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`, { timeout: 5000 });
            }
            for (const item of (workspace.planningItems || []).filter(item => item.projectId === project!.id)) {
              await request.delete(`/api/planning-items/${item.id}?expectedVersion=${item.version}`, { timeout: 5000 });
            }
          }
        }
        // Projects have no DELETE API; the isolated harness removes its entire
        // temporary database/checkout after the suite, including this project.
      } finally { await request.dispose(); }
    }
  }, { timeout: 45000 }],
});

async function workspace(fixture: PlanningFixture): Promise<WorkspaceSnapshot> {
  const response = await fixture.request.get('/api/workspace');
  expect(response.ok()).toBeTruthy();
  return await response.json() as WorkspaceSnapshot;
}

test('계획 기간·목표를 간트에 표시하고 종류별 업무를 필터링하며 충돌을 복구한 계획 편집과 업무 연결을 저장한다', async ({ page, planning: f }) => {
  test.setTimeout(75000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/#/${f.project.id}/gantt`);
  const issueRows = page.locator('.gantt-row[data-issue-id]');
  await expect(issueRows).toHaveCount(4);
  await page.getByRole('button', { name: '계획 일정', exact: true }).click();
  const panel = page.getByRole('region', { name: '간트 계획 일정', exact: true });
  const kind = panel.getByLabel('간트 계획 종류', { exact: true });
  const onlyLinked = page.getByRole('checkbox', { name: '연결된 업무만', exact: true });

  for (const planKind of ['cycle', 'module', 'release'] as const) {
    const item = f.plans[planKind];
    await kind.selectOption(planKind);
    const select = panel.getByRole('button', { name: `${labels[planKind]} ${item.name} 간트 선택`, exact: true });
    await select.click();
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    const planRow = page.locator(`[data-planning-id="${item.id}"]`);
    await expect(planRow.getByRole('img', { name: `${item.name} 계획 기간 ${item.startDate} ~ ${item.endDate}`, exact: true })).toBeVisible();
    await expect(planRow.getByRole('img', { name: `${item.name} 계획 목표일 ${item.targetDate}`, exact: true })).toBeVisible();
    await onlyLinked.check();
    await expect(issueRows).toHaveCount(1);
    await expect(page.locator(`.gantt-row[data-issue-id="${f.linked[planKind].id}"]`)).toBeVisible();
  }

  const cycle = f.plans.cycle;
  await kind.selectOption('cycle');
  await panel.getByRole('button', { name: `사이클 ${cycle.name} 간트 선택`, exact: true }).click();
  const editor = panel.getByRole('form', { name: '선택한 계획 일정 편집', exact: true });
  const start = editor.getByLabel('계획 간트 시작일', { exact: true });
  const end = editor.getByLabel('계획 간트 종료일', { exact: true });
  const target = editor.getByLabel('계획 간트 목표일', { exact: true });
  const changedDates = { startDate: day(-1), endDate: day(8), targetDate: day(9) };
  await start.fill(changedDates.startDate);
  await end.fill(changedDates.endDate);
  await target.fill(changedDates.targetDate);
  const external = await f.request.patch(`/api/planning-items/${cycle.id}`, {
    data: { expectedVersion: cycle.version, description: '동시 작업자가 변경한 합성 계획 설명' },
  });
  expect(external.status(), await external.text()).toBe(200);
  const latestCycle = await external.json() as PlanningItem;
  const conflictResponse = page.waitForResponse(response => response.url().endsWith(`/api/planning-items/${cycle.id}`) && response.request().method() === 'PATCH');
  await editor.getByRole('button', { name: '계획 일정 저장', exact: true }).click();
  const conflict = await conflictResponse;
  expect(conflict.status()).toBe(409);
  expect(conflict.request().postDataJSON().expectedVersion).toBe(cycle.version);
  await expect(start).toHaveValue(changedDates.startDate);
  await expect(end).toHaveValue(changedDates.endDate);
  await expect(target).toHaveValue(changedDates.targetDate);

  page.once('dialog', dialog => void dialog.accept());
  await editor.getByRole('button', { name: '계획 일정 최신 정보', exact: true }).click();
  await expect(start).toHaveValue(cycle.startDate!);
  await expect(end).toHaveValue(cycle.endDate!);
  await start.fill(changedDates.startDate);
  await end.fill(changedDates.endDate);
  await target.fill(changedDates.targetDate);
  const saveResponse = page.waitForResponse(response => response.url().endsWith(`/api/planning-items/${cycle.id}`) && response.request().method() === 'PATCH');
  await editor.getByRole('button', { name: '계획 일정 저장', exact: true }).click();
  const savedResponse = await saveResponse;
  expect(savedResponse.status()).toBe(200);
  expect(savedResponse.request().postDataJSON()).toMatchObject({ expectedVersion: latestCycle.version, ...changedDates });
  const saved = await savedResponse.json() as PlanningItem;
  await expect(editor.getByRole('button', { name: '계획 일정 저장', exact: true })).toBeDisabled();
  await expect(page.getByRole('img', { name: `${cycle.name} 계획 기간 ${changedDates.startDate} ~ ${changedDates.endDate}`, exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: `${cycle.name} 계획 목표일 ${changedDates.targetDate}`, exact: true })).toBeVisible();
  const afterDates = await workspace(f);
  for (const original of [...Object.values(f.linked), f.unlinked]) {
    const current = afterDates.issues.find(item => item.id === original.id)!;
    expect({ start: current.startDate, end: current.endDate, version: current.version }).toEqual({ start: original.startDate, end: original.endDate, version: original.version });
  }

  await editor.getByRole('button', { name: '계획 상세 열기', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/#/${f.project.id}/planning/${cycle.id}$`));
  const detail = page.getByRole('region', { name: '사이클 상세', exact: true });
  await expect(detail.getByLabel('계획 이름', { exact: true })).toHaveValue(cycle.name);
  await expect(detail.getByLabel('계획 시작일', { exact: true })).toHaveValue(changedDates.startDate);
  await expect(detail.getByLabel('계획 종료일', { exact: true })).toHaveValue(changedDates.endDate);
  await page.getByRole('link', { name: '간트에서 열기', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/#/${f.project.id}/gantt/${cycle.id}$`));
  await expect(panel.getByRole('button', { name: `사이클 ${cycle.name} 간트 선택`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await onlyLinked.uncheck();
  await expect(issueRows).toHaveCount(4);
  await page.getByRole('checkbox', { name: `${f.unlinked.key} 선택`, exact: true }).check();
  await page.getByRole('button', { name: '선택 업무 연결', exact: true }).click();
  const assignment = page.getByRole('dialog', { name: '계획 업무 연결', exact: true });
  await expect(assignment).toContainText(f.unlinked.key);
  await expect(assignment).toContainText(cycle.name);
  const reviewedIssue = assignment.getByRole('row').filter({ hasText: f.unlinked.key });
  await expect(reviewedIssue.getByRole('cell').nth(1)).toHaveText('미지정');
  await expect(reviewedIssue.getByRole('cell').nth(2)).toHaveText('이 계획에 연결');
  await expect(assignment.getByRole('checkbox', { name: `${f.unlinked.key} 계획 변경 선택`, exact: true })).toBeChecked();
  const assignedResponse = page.waitForResponse(response => response.url().endsWith(`/api/planning-items/${cycle.id}/issues`) && response.request().method() === 'POST');
  await assignment.getByRole('button', { name: '계획 연결 적용', exact: true }).click();
  const assigned = await assignedResponse;
  expect(assigned.status()).toBe(200);
  expect(assigned.request().postDataJSON()).toMatchObject({
    expectedVersion: saved.version,
    assignments: [{ issueId: f.unlinked.id, assigned: true, expectedVersion: f.unlinked.version }],
  });
  await expect(assignment.getByRole('status')).toHaveText('1개 업무의 계획 연결을 적용했습니다.');
  await assignment.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(assignment).toHaveCount(0);
  await onlyLinked.check();
  await expect(issueRows).toHaveCount(2);
  await expect(page.locator(`.gantt-row[data-issue-id="${f.unlinked.id}"]`)).toBeVisible();
  const linkedIssue = (await workspace(f)).issues.find(item => item.id === f.unlinked.id)!;
  expect(linkedIssue.cycleId).toBe(cycle.id);
  expect(linkedIssue.startDate).toBe(f.unlinked.startDate);
  expect(linkedIssue.endDate).toBe(f.unlinked.endDate);
  expect(linkedIssue.moduleId ?? null).toBeNull();
  expect(linkedIssue.releaseId ?? null).toBeNull();
});

test('360px에서 계획 목표일 이동이 타임라인을 실제로 보이고 새 업무는 선택한 사이클에 연결된다', async ({ page, planning: f }) => {
  const cycle = f.plans.cycle;
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`/#/${f.project.id}/gantt/${cycle.id}`);
  const panel = page.getByRole('region', { name: '간트 계획 일정', exact: true });
  await expect(panel.getByRole('button', { name: `사이클 ${cycle.name} 간트 선택`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  const planRow = page.locator(`[data-planning-id="${cycle.id}"]`);
  await planRow.getByRole('button', { name: `목표 ${cycle.targetDate}`, exact: true }).click();
  const scroller = page.locator('.gantt-scroll');
  const marker = planRow.getByRole('img', { name: `${cycle.name} 계획 목표일 ${cycle.targetDate}`, exact: true });
  await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(538);
  await expect.poll(() => marker.evaluate(element => {
    const chart = element.closest('.gantt-scroll')!;
    const bounds = chart.getBoundingClientRect(), target = element.getBoundingClientRect();
    return target.width > 0 && target.height > 0 &&
      target.right > Math.max(0, bounds.left) && target.left < Math.min(window.innerWidth, bounds.right) &&
      target.bottom > Math.max(0, bounds.top) && target.top < Math.min(window.innerHeight, bounds.bottom);
  })).toBe(true);

  const onlyLinked = page.getByRole('checkbox', { name: '연결된 업무만', exact: true });
  await onlyLinked.check();
  await expect(page.locator('.gantt-row[data-issue-id]')).toHaveCount(1);
  await page.getByRole('button', { name: '업무 추가', exact: true }).click();
  const create = page.getByRole('form', { name: '간트에서 업무 만들기', exact: true });
  await expect(create.getByLabel('추가할 업무 사이클', { exact: true })).toHaveValue(cycle.id);
  const title = `${f.project.key} 모바일 사이클 업무`;
  await create.getByLabel('추가할 업무 제목', { exact: true }).fill(title);
  await create.getByLabel('추가할 업무 시작일', { exact: true }).fill(day(1));
  await create.getByLabel('추가할 업무 종료일', { exact: true }).fill(day(3));
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/issues') && response.request().method() === 'POST');
  await create.getByRole('button', { name: '간트에 추가', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().cycleId).toBe(cycle.id);
  const created = await response.json() as Issue;
  await expect(create).toHaveCount(0);
  await expect(onlyLinked).toBeChecked();
  await expect(page.locator('.gantt-row[data-issue-id]')).toHaveCount(2);
  await expect(page.locator(`.gantt-row[data-issue-id="${created.id}"]`)).toContainText(title);
  const persisted = (await workspace(f)).issues.find(issue => issue.id === created.id)!;
  expect(persisted).toMatchObject({ title, cycleId: cycle.id, startDate: day(1), endDate: day(3) });
  expect(persisted.moduleId ?? null).toBeNull();
  expect(persisted.releaseId ?? null).toBeNull();
});
