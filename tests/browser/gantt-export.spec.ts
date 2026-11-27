import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Issue, Milestone, PlanningItem, SavedView, ScheduleBaseline, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function create<T>(request: APIRequestContext, path: string, data: object): Promise<T> {
  const response = await request.post(`/api/${path}`, { data });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

test('360px 간트에서 현재 보기와 저장된 일정을 내려받아 오프라인으로 열고 인쇄한다', async ({ page, browser, request }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project, otherProject], users: [assignee] } = await workspace(request);
  const token = randomUUID().slice(0, 8);
  const prefix = `간트 보고서 ${token}`;
  const searchTerm = `선택 ${token}`;
  const description = `공유하지 않을 업무 설명 ${token}`;
  const draftTitle = `${searchTerm} 작성 중인 업무`;
  const today = new Date().toISOString().slice(0, 10);
  const date = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const issues: Issue[] = [];
  let view: SavedView | undefined;
  let plan: PlanningItem | undefined;
  let milestone: Milestone | undefined;
  let baseline: ScheduleBaseline | undefined;

  async function addIssue(title: string, fields: Partial<Issue> = {}) {
    const issue = await create<Issue>(request, 'issues', {
      projectId: project.id, title, startDate: date(0), endDate: date(3), ...fields,
    });
    issues.push(issue);
    return issue;
  }

  try {
    const first = await addIssue(`${prefix} ${searchTerm} <b data-report-mark>검토</b> & "일정"`, {
      startDate: date(-3), endDate: date(3), dueDate: date(2), description, assigneeId: assignee.id,
    });
    const second = await addIssue(`${prefix} ${searchTerm} 장기 작업`, { startDate: date(1), endDate: date(200) });
    const hiddenSearch = await addIssue(`${prefix} 다른 검색어`);
    await addIssue(`${prefix} ${searchTerm} 다른 유형`, { type: '버그' });
    await addIssue(`${prefix} ${searchTerm} 완료`, { status: 'done' });
    await addIssue(`${prefix} ${searchTerm} 다른 프로젝트`, { projectId: otherProject.id });
    await create(request, 'dependencies', { predecessorId: first.id, successorId: second.id, type: 'FS', lagDays: 0 });
    await create(request, 'dependencies', { predecessorId: hiddenSearch.id, successorId: second.id, type: 'SS', lagDays: 2 });
    view = await create<SavedView>(request, 'views', {
      projectId: project.id, layout: 'list', name: `${prefix} 공유 보기`,
      filters: { query: prefix, status: 'all', assigneeId: 'all', type: '작업' },
    });
    plan = await create<PlanningItem>(request, 'planning-items', {
      projectId: project.id, kind: 'release', status: 'active', name: `${prefix} 릴리스`,
      startDate: date(0), endDate: date(8), targetDate: date(9),
    });
    milestone = await create<Milestone>(request, 'milestones', {
      projectId: project.id, title: `${prefix} 이정표`, date: date(4), issueIds: [second.id, hiddenSearch.id],
    });
    const before = await workspace(request);
    baseline = await create<ScheduleBaseline>(request, 'baselines', {
      projectId: project.id, name: `${prefix} 기준선`,
      expectedIssueVersions: Object.fromEntries(before.issues.filter(item => item.projectId === project.id).map(item => [item.id, item.version])),
      expectedMilestoneVersions: Object.fromEntries(before.milestones!.filter(item => item.projectId === project.id).map(item => [item.id, item.version])),
      expectedCalendarVersion: before.calendars!.find(item => item.projectId === project.id)!.version,
    });

    const ganttPath = `/#/${project.id}/gantt`;
    await page.goto(`${ganttPath}?savedView=${view.id}`);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await expect(search).toBeVisible({ timeout: 25_000 });
    await search.fill(searchTerm);
    await page.getByRole('checkbox', { name: '완료 업무 숨기기', exact: true }).check();
    await page.getByRole('button', { name: '계획 일정', exact: true }).click();
    await page.getByRole('combobox', { name: '비교 기준선', exact: true }).selectOption(baseline.id);
    await page.getByLabel('간트 표시 시작일', { exact: true }).fill(date(0));
    await expect(page.locator('.gantt-window-controls')).toContainText(date(179));

    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const ganttIssueRows = chart.locator('.gantt-row[data-issue-id]');
    await expect(ganttIssueRows).toHaveCount(2);
    const expectedKeys = await ganttIssueRows.getByRole('checkbox').evaluateAll(boxes => boxes.map(box => box.getAttribute('aria-label')!.replace(/ 선택$/, '')));
    expect(expectedKeys).toEqual(expect.arrayContaining([first.key, second.key]));
    await expect(chart.locator(`[data-planning-id="${plan.id}"]`)).toBeVisible();
    await expect(chart.locator(`[data-milestone-id="${milestone.id}"]`)).toBeVisible();

    const writes: string[] = [];
    page.on('request', sent => {
      const path = new URL(sent.url()).pathname;
      if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(sent.method())) writes.push(`${sent.method()} ${path}`);
    });
    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    const draft = page.getByRole('form', { name: '간트에서 업무 만들기', exact: true }).getByLabel('추가할 업무 제목', { exact: true });
    await draft.fill(draftTitle);
    const inlineDate = chart.getByLabel(`${first.key} 종료일`, { exact: true });
    const unsavedDate = date(380);
    await inlineDate.fill(unsavedDate);
    await expect(inlineDate).toBeFocused();

    const exportButton = page.getByRole('button', { name: '간트 HTML 내려받기', exact: true });
    const bounds = await exportButton.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    expect(download.suggestedFilename()).toBe(`donefac-gantt-${project.key}.html`);
    const file = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(file);
    await expect(inlineDate).toHaveValue(unsavedDate);
    await expect(draft).toHaveValue(draftTitle);
    expect(writes).toEqual([]);
    const after = await workspace(request);
    expect(after.issues).toEqual(before.issues);
    expect(after.dependencies).toEqual(before.dependencies);

    const html = await readFile(file, 'utf8');
    for (const hidden of [description, draftTitle, unsavedDate, assignee.email, ...issues.slice(2).flatMap(issue => [issue.key, issue.title, issue.id])]) {
      expect(html).not.toContain(hidden);
    }

    const offline = await browser.newContext({ offline: true, viewport: { width: 1100, height: 800 } });
    try {
      const report = await offline.newPage();
      const webRequests: string[] = [];
      report.on('request', sent => { if (/^https?:/.test(sent.url())) webRequests.push(sent.url()); });
      await report.goto(pathToFileURL(file).href);
      await expect(report.locator('html')).toHaveAttribute('lang', 'ko');
      await expect(report.getByRole('heading', { name: `${project.key} · ${project.name} 간트`, exact: true })).toBeVisible();
      for (const label of [view.name, searchTerm, '완료 업무 숨기기', baseline.name]) {
        await expect(report.getByText(label, { exact: false }).first()).toBeVisible();
      }
      expect(await report.locator('#export-range time').evaluateAll(times => times.map(time => time.getAttribute('datetime')))).toEqual([date(0), date(179)]);
      await expect(report.locator('script, iframe, [data-report-mark]')).toHaveCount(0);
      const timeline = report.getByRole('table', { name: '일정 타임라인', exact: true });
      const issueRows = timeline.locator('tr[data-kind="issue"]');
      await expect(issueRows).toHaveCount(2);
      for (const [index, key] of expectedKeys.entries()) await expect(issueRows.nth(index)).toContainText(key);
      const firstRow = issueRows.filter({ hasText: first.key });
      await expect(firstRow).toContainText(first.title);
      await expect(firstRow).toContainText(assignee.name);
      for (const day of [first.startDate, first.endDate, first.dueDate]) await expect(firstRow.locator(`time[datetime="${day}"]`).first()).toBeVisible();
      await expect(firstRow.locator('.date-bar.is-clipped-start').first()).toBeVisible();
      await expect(firstRow.locator('.date-bar.is-baseline')).toBeVisible();
      const secondRow = issueRows.filter({ hasText: second.key });
      await expect(secondRow.locator(`time[datetime="${second.endDate}"]`).first()).toBeVisible();
      await expect(secondRow.locator('.date-bar.is-clipped-end').first()).toBeVisible();
      const planRow = timeline.locator('tr[data-kind="plan"]').filter({ hasText: plan.name });
      await expect(planRow.locator(`time[datetime="${plan.targetDate}"]`)).toBeVisible();
      const milestoneRow = timeline.locator('tr[data-kind="milestone"]').filter({ hasText: milestone.title });
      await expect(milestoneRow.locator(`time[datetime="${milestone.date}"]`).first()).toBeVisible();

      const dependencies = report.getByRole('table', { name: '업무 연결', exact: true }).locator('tr.dependency-row');
      await expect(dependencies).toHaveCount(1);
      for (const text of [first.key, second.key, 'FS', '일정 충돌']) await expect(dependencies).toContainText(text);

      await report.emulateMedia({ media: 'print' });
      await expect(timeline).toBeVisible();
      const pdf = (await report.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1');
      expect(pdf.startsWith('%PDF-')).toBe(true);
      const pageSize = pdf.match(/\/MediaBox\s*\[0\s+0\s+([\d.]+)\s+([\d.]+)\]/);
      expect(pageSize).not.toBeNull();
      expect(Number(pageSize![1])).toBeGreaterThan(Number(pageSize![2]));
      expect(webRequests).toEqual([]);
    } finally {
      await offline.close();
    }
  } finally {
    if (baseline) await request.delete(`/api/baselines/${baseline.id}?expectedVersion=${baseline.version}`);
    if (milestone) await request.delete(`/api/milestones/${milestone.id}?expectedVersion=${milestone.version}`);
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of issues) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    if (plan) await request.delete(`/api/planning-items/${plan.id}?expectedVersion=${plan.version}`);
  }
});
