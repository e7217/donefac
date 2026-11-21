import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { Dependency, Issue, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function payload<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => payload<WorkspaceSnapshot>(await request.get('/api/workspace'));

function dateInNextWeek(offset: number): string {
  const date = new Date();
  const daysToNextMonday = (8 - date.getUTCDay()) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + daysToNextMonday + offset);
  return date.toISOString().slice(0, 10);
}

async function fixture(request: APIRequestContext) {
  const { projects: [project, otherProject] } = await workspace(request);
  const token = `흐름 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  const views: SavedView[] = [];
  return {
    project, otherProject, token,
    async issue(title: string, fields: Partial<Pick<Issue, 'projectId' | 'status' | 'startDate' | 'endDate'>> = {}) {
      const issue = await payload<Issue>(await request.post('/api/issues', {
        data: { projectId: project.id, title: `${token} ${title}`, ...fields },
      }), 201);
      issues.push(issue);
      return issue;
    },
    async link(predecessor: Issue, successor: Issue) {
      return payload<Dependency>(await request.post('/api/dependencies', {
        data: { predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0 },
      }), 201);
    },
    async view(query: string) {
      const view = await payload<SavedView>(await request.post('/api/views', {
        data: { projectId: project.id, name: `${token} 공유 보기`, layout: 'list', filters: { query, status: 'all', type: 'all', assigneeId: 'all' } },
      }), 201);
      views.push(view);
      return view;
    },
    async close() {
      for (const view of views) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
      for (const issue of issues.reverse()) {
        const deleted = await request.delete(`/api/issues/${issue.id}`);
        if (!deleted.ok()) continue;
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    },
  };
}

function gantt(page: Page) {
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  const row = (issue: Issue) => chart.locator(`.gantt-row[data-issue-id="${issue.id}"]`);
  const flow = page.getByRole('region', { name: '선후행 흐름', exact: true });
  const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
  return {
    chart, row, flow, search,
    rows: chart.locator('.gantt-row[data-issue-id]'),
    select: (issue: Issue) => row(issue).getByRole('checkbox', { name: `${issue.key} 선택`, exact: true }),
    open: page.getByRole('button', { name: '선후행 흐름 보기', exact: true }),
    close: flow.getByRole('button', { name: '선후행 흐름 닫기', exact: true }),
  };
}

function scheduleApply(page: Page) {
  return page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/apply' && response.request().method() === 'POST');
}

test('360px 간트에서 가려진 선후행 업무를 단계별로 보고 일정을 수정한 뒤 공유 보기로 돌아간다', async ({ page, request }, testInfo) => {
  test.setTimeout(85_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  const d = dateInNextWeek;
  try {
    const upstream = await f.issue('완료된 먼 선행', { status: 'done', startDate: d(0), endDate: d(1) });
    const previous = await f.issue('바로 앞 선행', { startDate: d(2), endDate: d(3) });
    const anchor = await f.issue('현재 표시 기준 업무', { startDate: d(3), endDate: d(4) });
    const next = await f.issue('날짜 미정인 바로 다음 후행');
    const downstream = await f.issue('먼 후행', { startDate: d(8), endDate: d(9) });
    const collateral = await f.issue('같은 선행을 가진 별도 분기', { startDate: d(2), endDate: d(2) });
    const independent = await f.issue('현재 표시 연결 없는 업무');
    const completedMatch = await f.issue('현재 표시 완료 업무', { status: 'done' });
    const foreign = await f.issue('현재 표시 다른 프로젝트 업무', { projectId: f.otherProject.id });
    await f.link(upstream, previous);
    const conflicting = await f.link(previous, anchor);
    await f.link(anchor, next);
    await f.link(next, downstream);
    await f.link(previous, collateral);
    await payload(await request.post(`/api/issues/${anchor.id}/relations`, {
      data: { otherIssueId: foreign.id, type: 'blocks', direction: 'outgoing' },
    }), 201);
    const view = await f.view(`${f.token} 현재 표시`);

    const g = gantt(page);
    const originalHash = `#/${f.project.id}/gantt?savedView=${view.id}`;
    const viewPicker = page.getByRole('combobox', { name: '간트 공유 보기', exact: true });
    const hideDone = page.getByRole('checkbox', { name: '완료 업무 숨기기', exact: true });
    const windowStart = page.getByLabel('간트 표시 시작일', { exact: true });
    const zoomWeek = page.getByRole('button', { name: '주', exact: true });
    await page.goto(`/${originalHash}`);
    await expect(viewPicker).toHaveValue(view.id);
    await g.search.fill('현재 표시');
    await hideDone.check();
    await windowStart.fill(d(0));
    await zoomWeek.click();
    await expect(g.rows).toHaveCount(2);
    await expect(g.row(completedMatch)).toHaveCount(0);
    await g.select(independent).check();
    await g.select(anchor).check();
    await expect(g.open).toHaveCount(0);
    await g.select(independent).uncheck();
    await g.open.press('Enter');
    await expect(g.flow).toBeVisible();
    await expect(windowStart).not.toHaveValue(d(0));
    const flowBounds = (await g.flow.boundingBox())!;
    expect(flowBounds.x).toBeGreaterThanOrEqual(0);
    expect(flowBounds.x + flowBounds.width).toBeLessThanOrEqual(360);
    await expect(g.flow.getByRole('status')).toContainText('기존 보기 밖 4개');

    await expect(g.rows).toHaveCount(5);
    for (const [issue, role, label] of [
      [upstream, 'predecessor', '선행 2단계'], [previous, 'predecessor', '선행 1단계'], [anchor, 'anchor', '기준 업무'],
      [next, 'successor', '후행 1단계'], [downstream, 'successor', '후행 2단계'],
    ] as const) {
      await expect(g.row(issue)).toHaveAttribute('data-dependency-focus-row', role);
      await expect(g.row(issue).getByText(label, { exact: true })).toBeVisible();
    }
    for (const issue of [collateral, independent, completedMatch, foreign]) await expect(g.row(issue)).toHaveCount(0);
    await expect(g.row(anchor).getByText('기준 업무', { exact: true })).toBeInViewport();
    await expect(g.row(next).getByLabel(`${next.key} 시작일`, { exact: true })).toHaveValue('');
    await expect(g.row(next).getByLabel(`${next.key} 종료일`, { exact: true })).toHaveValue('');

    await g.flow.getByRole('button', { name: '기준 업무로 이동', exact: true }).click();
    await expect(g.chart).toBeFocused();
    await expect(g.row(anchor)).toBeInViewport();
    await expect(g.chart.locator(`[data-date="${d(3)}"]`)).toBeInViewport({ ratio: 0.5 });
    const connector = g.chart.locator(`[data-dependency-id="${conflicting.id}"]`);
    await expect(connector).toHaveAttribute('data-dependency-conflict', 'true');
    const start = g.row(anchor).getByLabel(`${anchor.key} 시작일`, { exact: true });
    await page.getByRole('button', { name: '일정 충돌', exact: true }).click();
    const findings = page.getByRole('region', { name: '일정 충돌', exact: true });
    const summary = findings.getByLabel('일정 점검 요약', { exact: true });
    await expect(summary).toContainText(/충돌\s*1건/u);
    await expect(findings.getByRole('button', { name: `${collateral.key} 시작일 수정`, exact: true })).toHaveCount(0);
    await findings.getByRole('button', { name: `${anchor.key} 시작일 수정`, exact: true }).click();
    await expect(start).toBeFocused();
    await expect(g.flow).toBeVisible();
    const saving = scheduleApply(page);
    await start.fill(d(4));
    await start.press('Enter');
    const saved = await saving;
    expect(saved.ok(), await saved.text()).toBe(true);
    await expect.poll(async () => (await workspace(request)).issues.find(issue => issue.id === anchor.id)?.startDate).toBe(d(4));
    await expect(connector).toHaveCount(1);
    await expect(connector).not.toHaveAttribute('data-dependency-conflict', 'true');
    await expect(summary).toContainText(/충돌\s*0건/u);
    await expect(g.flow).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '간트 HTML 내려받기', exact: true }).click(),
    ]);
    const reportPath = testInfo.outputPath('선후행-흐름.html');
    await download.saveAs(reportPath);
    const report = await readFile(reportPath, 'utf8');
    expect(report).toContain(`선후행 흐름 · ${anchor.key} ${anchor.title}`);
    for (const issue of [upstream, next, downstream]) expect(report).toContain(issue.title);
    for (const issue of [collateral, independent, completedMatch, foreign]) expect(report).not.toContain(issue.title);

    await g.close.click();
    await expect(g.flow).toHaveCount(0);
    await expect(g.open).toBeFocused();
    await expect(g.rows).toHaveCount(2);
    await expect(g.row(anchor)).toBeVisible();
    await expect(g.row(independent)).toBeVisible();
    await expect(g.search).toHaveValue('현재 표시');
    await expect(hideDone).toBeChecked();
    await expect(viewPicker).toHaveValue(view.id);
    await expect(windowStart).toHaveValue(d(0));
    await expect(zoomWeek).toHaveClass(/active/u);
    await expect(page).toHaveURL(url => url.hash === originalHash);
  } finally {
    await f.close();
  }
});

test('간트 흐름 전환을 취소하면 미저장 날짜를 보호하고 연결을 해제하면 후행 범위를 다시 계산한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const f = await fixture(request);
  const d = dateInNextWeek;
  try {
    const previous = await f.issue('앞 업무', { startDate: d(0), endDate: d(1) });
    const anchor = await f.issue('초안 기준 업무', { startDate: d(2), endDate: d(3) });
    const next = await f.issue('나중에 연결을 해제할 업무');
    const downstream = await f.issue('해제할 업무의 후행');
    await f.link(previous, anchor);
    const removed = await f.link(anchor, next);
    await f.link(next, downstream);
    const g = gantt(page);
    let dateWrites = 0;
    let linkDeletes = 0;
    page.on('request', work => {
      const path = new URL(work.url()).pathname;
      if (path === '/api/schedule/apply' && work.method() === 'POST') dateWrites++;
      if (path === `/api/dependencies/${removed.id}` && work.method() === 'DELETE') linkDeletes++;
    });
    await page.goto(`/#/${f.project.id}/gantt`);
    await g.search.fill(anchor.title);
    await g.select(anchor).check();
    const end = g.row(anchor).getByLabel(`${anchor.key} 종료일`, { exact: true });
    await end.fill(d(4));
    const dismissOpen = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.type()).toBe('confirm');
      await dialog.dismiss();
    });
    await g.open.click();
    await dismissOpen;
    await expect(g.flow).toHaveCount(0);
    await expect(end).toHaveValue(d(4));
    expect((await workspace(request)).issues.find(issue => issue.id === anchor.id)?.endDate).toBe(d(3));
    await end.press('Escape');
    await expect(end).toHaveValue(d(3));

    await g.open.click();
    await expect(g.flow).toBeVisible();
    const nextStart = g.row(next).getByLabel(`${next.key} 시작일`, { exact: true });
    await nextStart.fill(d(4));
    const dismissClose = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.type()).toBe('confirm');
      await dialog.dismiss();
    });
    await g.close.click();
    await dismissClose;
    await expect(g.flow).toBeVisible();
    await expect(nextStart).toHaveValue(d(4));
    expect((await workspace(request)).issues.find(issue => issue.id === next.id)?.startDate).toBeNull();

    const links = page.getByRole('region', { name: '업무 연결 목록', exact: true });
    const unlink = links.getByRole('button', { name: `${anchor.key}와 ${next.key} 연결 해제`, exact: true });
    await g.flow.getByRole('button', { name: '기준 업무로 이동', exact: true }).click();
    await expect(g.chart).toBeFocused();
    const dismissUnlink = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.type()).toBe('confirm');
      await dialog.dismiss();
    });
    await unlink.click();
    await dismissUnlink;
    await expect(nextStart).toHaveValue(d(4));
    expect(dateWrites).toBe(0);
    expect(linkDeletes).toBe(0);
    expect((await workspace(request)).dependencies.some(dependency => dependency.id === removed.id)).toBe(true);
    await nextStart.press('Escape');
    await expect(nextStart).toHaveValue('');

    const unlinking = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dependencies/${removed.id}` && response.request().method() === 'DELETE');
    await unlink.click();
    const unlinked = await unlinking;
    expect(unlinked.ok(), await unlinked.text()).toBe(true);
    await expect(g.flow).toBeVisible();
    await expect(g.rows).toHaveCount(2);
    await expect(g.row(previous)).toHaveAttribute('data-dependency-focus-row', 'predecessor');
    await expect(g.row(next)).toHaveCount(0);
    await expect(g.row(downstream)).toHaveCount(0);
    expect((await workspace(request)).dependencies.some(dependency => dependency.id === removed.id)).toBe(false);
    await g.close.click();
    await expect(g.rows).toHaveCount(1);
    await expect(g.search).toHaveValue(anchor.title);
  } finally {
    await f.close();
  }
});
