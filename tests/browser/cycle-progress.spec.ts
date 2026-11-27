import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import { calendarDate, calendarDay } from '../../shared/calendar';
import { reservationLocalDateTime } from '../../shared/time-reservations';
import type { Issue, PlanningItem, WorkspaceSnapshot } from '../../shared/types';

async function read<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('모바일 백로그와 계획 상세에서 추이를 열고 날짜별 업무 근거를 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [actor] } = await read<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const today = reservationLocalDateTime(new Date().toISOString(), 'Asia/Seoul').slice(0, 10);
  const earlier = calendarDate(calendarDay(today) - 7);
  const cycle = await read<PlanningItem>(await request.post('/api/planning-items', { headers, data: {
    projectId: project.id, kind: 'cycle', name: `진행 추이 확인 ${suffix}`, status: 'active', startDate: earlier,
    endDate: calendarDate(calendarDay(today) + 7),
  } }), 201);
  const issues: Issue[] = [];
  const path = `/api/projects/${project.id}/cycles/${cycle.id}/progress`;
  try {
    const planned = await read<Issue>(await request.post('/api/issues', { headers, data: {
      projectId: project.id, cycleId: cycle.id, title: `추정치 확인 업무 ${suffix}`, estimate: 5,
    } }), 201);
    issues.push(planned);
    const unestimated = await read<Issue>(await request.post('/api/issues', { headers, data: {
      projectId: project.id, cycleId: cycle.id, title: `추정치가 없는 업무 ${suffix}`,
    } }), 201);
    issues.push(unestimated);
    const observedDate = reservationLocalDateTime(unestimated.createdAt, 'Asia/Seoul').slice(0, 10);
    const unobservedDate = calendarDate(calendarDay(observedDate) - 3);

    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/backlog/${cycle.id}`);
    const panel = page.getByRole('region', { name: '사이클 진행 추이', exact: true });
    const toggle = panel.getByRole('button', { name: '사이클 진행 추이', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 35_000 });
    await toggle.click();
    const issuesMetric = panel.getByRole('button', { name: '업무 수', exact: true });
    const pointsMetric = panel.getByRole('button', { name: '스토리 포인트', exact: true });
    const summary = panel.locator('dl');
    await expect(issuesMetric).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('img', { name: '업무 수 사이클 범위와 남은 업무 그래프', exact: true })).toBeVisible();
    await expect(summary.locator('dd').nth(0)).toHaveText('2');

    await pointsMetric.click();
    await expect(pointsMetric).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('img', { name: '스토리 포인트 사이클 범위와 남은 업무 그래프', exact: true })).toBeVisible();
    await expect(summary.locator('dd').nth(0)).toHaveText('5');
    await expect(panel.getByText(/추정치 미입력은 범위 1건, 남은 업무 1건입니다/)).toBeVisible();
    await panel.getByRole('button', { name: `${unobservedDate} 변경 근거`, exact: true }).click();
    await expect(panel.getByText('이 날짜에는 관측된 자료가 없습니다.', { exact: true })).toBeVisible();

    await panel.getByRole('button', { name: `${observedDate} 변경 근거`, exact: true }).click();
    const evidence = panel.getByRole('region', { name: `${observedDate} 변경 근거`, exact: true });
    await expect(evidence.getByText('범위 추가 2건', { exact: true })).toBeVisible();
    await evidence.getByRole('button').filter({ hasText: planned.title }).click();
    const details = page.getByRole('dialog', { name: planned.title, exact: true });
    await expect(details).toBeVisible();
    await expect(details.getByRole('spinbutton', { name: '예상 소요 (포인트)', exact: true })).toHaveValue('5');
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(details).toBeHidden();

    await read<Issue>(await request.patch(`/api/issues/${planned.id}`, { headers, data: { expectedVersion: planned.version, estimate: 8 } }));
    const refreshed = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === path && !url.search;
    });
    await panel.getByRole('button', { name: '진행 추이 새로고침', exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    await expect(summary.locator('dd').nth(0)).toHaveText('8');
    await expect(evidence.getByText('이전 5점 → 이후 8점', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await page.goto(`/#/${project.id}/planning/${cycle.id}`);
    const editor = page.getByRole('region', { name: '사이클 상세', exact: true });
    const planningProgress = editor.getByRole('region', { name: '사이클 진행 추이', exact: true });
    await planningProgress.getByRole('button', { name: '사이클 진행 추이', exact: true }).click();
    await planningProgress.getByRole('button', { name: '스토리 포인트', exact: true }).click();
    await expect(planningProgress.locator('dl dd').nth(0)).toHaveText('8');
  } finally {
    for (const issue of issues) {
      const response = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (response.ok()) {
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
    await request.delete(`/api/planning-items/${cycle.id}?expectedVersion=${cycle.version}`, { headers });
  }
});
