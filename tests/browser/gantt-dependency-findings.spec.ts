import { randomUUID } from 'node:crypto';
import { expect, test, type Locator } from '@playwright/test';
import type { Dependency, Issue, Project, SavedView, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

async function expectUsableFocus(field: Locator) {
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport({ ratio: 0.9 });
  expect(await field.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
}

test('360px 간트에서 공유 보기에 가려진 날짜를 찾아 일정 충돌을 해결한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const prefix = `일정 충돌 ${suffix}`;
  const projectResponse = await request.post('/api/projects', { data: { key: `GF${suffix}`, name: prefix } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = await projectResponse.json() as Project;
  const calendarPath = `/api/projects/${project.id}/calendar`;
  const predecessorEnd = '2026-12-11';
  const holiday = '2026-12-14';
  const nextWorkingDay = '2026-12-15';
  const successorEnd = '2026-12-18';
  const fixtures = [
    { title: `${prefix} 선행`, startDate: '2026-12-10', endDate: predecessorEnd },
    { title: `${prefix} 충돌`, startDate: holiday, endDate: successorEnd },
    { title: `${prefix} 종료일 미정`, startDate: '2026-12-10' },
  ];
  const issues: Issue[] = [];
  let baselineCalendar: WorkCalendar | undefined;
  let changedCalendar: WorkCalendar | undefined;
  let view: SavedView | undefined;
  try {
    const calendarResponse = await request.get(calendarPath);
    expect(calendarResponse.ok(), await calendarResponse.text()).toBeTruthy();
    baselineCalendar = await calendarResponse.json() as WorkCalendar;
    const holidayResponse = await request.patch(calendarPath, { data: {
      ...baselineCalendar, expectedVersion: baselineCalendar.version,
      exceptions: [{ date: holiday, isWorking: false, label: '팀 휴무' }],
    } });
    expect(holidayResponse.ok(), await holidayResponse.text()).toBeTruthy();
    changedCalendar = await holidayResponse.json() as WorkCalendar;

    for (const fixture of fixtures) {
      const response = await request.post('/api/issues', { data: { projectId: project.id, ...fixture } });
      expect(response.status(), await response.text()).toBe(201);
      issues.push(await response.json() as Issue);
    }
    const [predecessor, conflicting, missing] = issues;
    const dependencies: Dependency[] = [];
    for (const [successorId, type] of [[conflicting.id, 'FS'], [missing.id, 'FF']]) {
      const response = await request.post('/api/dependencies', { data: { predecessorId: predecessor.id, successorId, type, lagDays: 0 } });
      expect(response.status(), await response.text()).toBe(201);
      dependencies.push(await response.json() as Dependency);
    }

    const viewResponse = await request.post('/api/views', { data: {
      projectId: project.id, name: `${prefix} 공유 보기`, layout: 'list',
      filters: { query: predecessor.title, status: 'all', assigneeId: 'all', type: 'all' },
    } });
    expect(viewResponse.status(), await viewResponse.text()).toBe(201);
    view = await viewResponse.json() as SavedView;

    const ganttPath = `#/${project.id}/gantt`;
    const sharedPath = `${ganttPath}?savedView=${view.id}`;
    const conflictPath = `${ganttPath}?focusIssue=${conflicting.id}&focusDate=startDate`;
    const missingPath = `${ganttPath}?focusIssue=${missing.id}&focusDate=endDate`;
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const rows = chart.locator('.gantt-row[data-issue-id]');
    const connector = chart.locator(`[data-dependency-id="${dependencies[0].id}"]`);
    const row = (issue: Issue) => chart.locator(`[data-issue-id="${issue.id}"]`);
    const picker = page.getByRole('combobox', { name: '간트 공유 보기', exact: true });
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    const toggle = page.getByRole('button', { name: '일정 충돌', exact: true });
    const panel = page.getByRole('region', { name: '일정 충돌', exact: true });
    const summary = panel.getByLabel('일정 점검 요약', { exact: true });
    const list = panel.getByRole('list', { name: '일정 점검 항목', exact: true });
    const editStart = list.getByRole('button', { name: `${conflicting.key} 시작일 수정`, exact: true });
    const editEnd = list.getByRole('button', { name: `${missing.key} 종료일 수정`, exact: true });
    const start = row(conflicting).getByLabel(`${conflicting.key} 시작일`, { exact: true });
    const end = row(missing).getByLabel(`${missing.key} 종료일`, { exact: true });
    const openPanel = async () => {
      await expect(toggle).toBeVisible();
      if (!await panel.isVisible()) await toggle.click();
      await expect(panel).toBeVisible();
    };
    const expectCounts = async (conflictCount: number) => {
      await expect(summary).toContainText(new RegExp(`충돌\\s*${conflictCount}건`));
      await expect(summary).toContainText(/날짜 미정\s*1건/);
    };

    await page.goto(`/${sharedPath}`);
    await expect(picker).toHaveValue(view.id);
    await search.fill(predecessor.title);
    await expect(row(predecessor)).toBeVisible();
    await expect(rows).toHaveCount(1);
    await openPanel();
    await expectCounts(1);
    const conflictFinding = list.getByRole('listitem').filter({ has: page.getByRole('button', { name: `${conflicting.key} 시작일 수정`, exact: true }) });
    await expect(conflictFinding.getByText(predecessorEnd, { exact: true })).toBeVisible();
    await expect(conflictFinding.getByText(holiday, { exact: true })).toBeVisible();
    await expect(conflictFinding.getByText(nextWorkingDay, { exact: true })).toBeVisible();
    await expect(editEnd).toBeVisible();

    const editLink = conflictFinding.getByRole('button', { name: `${predecessor.key} → ${conflicting.key} 연결 수정`, exact: true });
    await editLink.click();
    const linkEditor = page.getByRole('dialog', { name: '업무 연결 수정', exact: true });
    await expect(linkEditor.getByLabel('선행 업무', { exact: true })).toHaveValue(predecessor.id);
    await expect(linkEditor.getByLabel('후행 업무', { exact: true })).toHaveValue(conflicting.id);
    await expect(linkEditor.getByLabel('연결 유형', { exact: true })).toHaveValue('FS');
    await linkEditor.getByRole('button', { name: '취소', exact: true }).click();
    await expect(editLink).toBeFocused();

    await editStart.click();
    await expect(page).toHaveURL(url => url.hash === conflictPath);
    await expectUsableFocus(start);
    await expect(connector).toHaveAttribute('data-dependency-conflict', 'true');
    await expect(start).toHaveValue(holiday);
    await start.fill(nextWorkingDay);
    const applying = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/schedule/apply' && response.request().method() === 'POST');
    await start.press('Enter');
    const applied = await applying;
    expect(applied.ok(), await applied.text()).toBeTruthy();
    await expect(start).toHaveValue(nextWorkingDay);
    await expect(connector).toHaveCount(1);
    await expect(chart.locator('[data-dependency-conflict]')).toHaveCount(0);
    await openPanel();
    await expectCounts(0);
    await expect(editStart).toHaveCount(0);
    await expect(editEnd).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === sharedPath);
    await expect(picker).toHaveValue(view.id);
    await expect(search).toHaveValue(predecessor.title);
    await expect(rows).toHaveCount(1);
    await expect(row(predecessor)).toBeVisible();

    await page.reload();
    await expect(picker).toHaveValue(view.id);
    await expect(row(missing)).toHaveCount(0);
    await openPanel();
    await expectCounts(0);
    await expect(editStart).toHaveCount(0);
    await editEnd.click();
    await expect(page).toHaveURL(url => url.hash === missingPath);
    await expectUsableFocus(end);
    await expect(end).toHaveValue('');
    await page.reload();
    await expect(page).toHaveURL(url => url.hash === missingPath);
    await expectUsableFocus(end);
    const snapshotResponse = await request.get('/api/workspace');
    expect(snapshotResponse.ok(), await snapshotResponse.text()).toBeTruthy();
    const snapshot = await snapshotResponse.json() as WorkspaceSnapshot;
    expect(snapshot.issues.find(issue => issue.id === conflicting.id)).toMatchObject({ startDate: nextWorkingDay, endDate: successorEnd });
  } finally {
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of issues) {
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    if (baselineCalendar && changedCalendar) {
      await request.patch(calendarPath, { data: { ...baselineCalendar, expectedVersion: changedCalendar.version } });
    }
  }
});
