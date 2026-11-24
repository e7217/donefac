import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { Issue, Milestone, Project, ProjectWorkflow, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

function dateFromToday(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test('360px 이정표에서 연결 업무를 검토하고 숨은 간트 행과 티켓 사이를 이동한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { users: [actor, peer] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const suffix = randomUUID().slice(0, 8);
  const project = await json<Project>(await request.post('/api/projects', {
    data: { key: `MR${suffix.toUpperCase()}`, name: `이정표 검토 ${suffix}` },
  }), 201);
  const headers = { 'X-Actor-Id': actor.id };
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const workflow = await json<ProjectWorkflow>(await request.get(workflowPath));
  const doneStatus = { id: `approved_${suffix}`, label: '승인 마침', category: 'done', color: '#42775f' } as const;
  const cancelledStatus = { id: `removed_${suffix}`, label: '의도적 범위 제외', category: 'cancelled', color: '#5a6171' } as const;
  await json<ProjectWorkflow>(await request.patch(workflowPath, { headers, data: {
    ...workflow, expectedVersion: workflow.version, statuses: [...workflow.statuses, doneStatus, cancelledStatus],
  } }));
  const openStatus = workflow.statuses.find(status => status.category === 'todo')!;
  const targetDate = dateFromToday(4);
  const plannedLate = dateFromToday(7);
  const issues: Issue[] = [];
  const milestones: Milestone[] = [];
  let savedView: SavedView | undefined;

  async function issue(title: string, endDate: string | null, status = openStatus.id) {
    const result = await json<Issue>(await request.post('/api/issues', { headers, data: {
      projectId: project.id, title, status, startDate: endDate ? dateFromToday(1) : null, endDate,
      dueDate: dateFromToday(10),
    } }), 201);
    issues.push(result);
    return result;
  }

  async function milestone(title: string, issueIds: string[]) {
    const result = await json<Milestone>(await request.post('/api/milestones', { headers, data: {
      projectId: project.id, title, date: targetDate, issueIds,
    } }), 201);
    milestones.push(result);
    return result;
  }

  try {
    const late = await issue('외부 승인 대기', plannedLate);
    const unscheduled = await issue('검증 일정 미확정', null);
    const within = await issue('목표일에 배포', targetDate);
    const done = await issue('심사 승인 완료', plannedLate, doneStatus.id);
    const cancelled = await issue('후속 보고서 제외', plannedLate, cancelledStatus.id);
    const reviewItem = await milestone('현장 적용 검토', [late.id, unscheduled.id, within.id, done.id, cancelled.id]);
    const empty = await milestone('후속 출시', []);
    const writes: string[] = [];
    page.on('request', outgoing => {
      const path = new URL(outgoing.url()).pathname;
      if (/^\/api\/(issues|milestones)(\/|$)/.test(path) && ['POST', 'PATCH', 'DELETE'].includes(outgoing.method())) {
        writes.push(`${outgoing.method()} ${path}`);
      }
    });

    const route = `#/${project.id}/gantt`;
    const title = page.getByRole('heading', { name: reviewItem.title, exact: true });
    const search = page.getByLabel('간트 업무 검색', { exact: true });
    const panel = page.getByRole('region', { name: '이정표와 일정 기준선', exact: true });
    const list = panel.locator('.schedule-milestone-list');
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const review = page.getByRole('region', { name: '이정표 연결 업무', exact: true });
    const listTrigger = list.getByRole('button', { name: `${reviewItem.title} 연결 업무 확인`, exact: true });
    const chartMilestone = chart.locator(`[data-milestone-id="${reviewItem.id}"]`);
    const lateRow = chart.locator(`[data-issue-id="${late.id}"]`);
    const lateDetails = review.getByRole('button', { name: `${late.key} 상세 열기`, exact: true });
    const closeReview = review.getByRole('button', { name: '연결 업무 닫기', exact: true });

    await page.goto(`/${route}`);
    await search.fill(within.key);
    await expect(lateRow).toHaveCount(0);
    await list.locator('summary').click();
    await listTrigger.click();
    await expect(page).toHaveURL(url => url.hash.split('?')[0] === route && new URLSearchParams(url.hash.split('?')[1]).get('milestone') === reviewItem.id);
    await expect(title).toBeFocused();
    await expect(review).toContainText(targetDate);
    await expect(review).toContainText('예정');
    for (const label of ['전체 5개', '이정표 이후 1개', '종료일 미정 1개', '이정표 이내 1개', '완료 1개', '취소 1개']) {
      await expect(review.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    await expect(review.getByText(doneStatus.label, { exact: true })).toBeVisible();
    await expect(review.getByText(cancelledStatus.label, { exact: true })).toBeVisible();
    const panelBounds = await review.boundingBox();
    expect(panelBounds).not.toBeNull();
    expect(panelBounds!.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(360);

    const lateFilter = review.getByRole('button', { name: '이정표 이후 1개', exact: true });
    await lateFilter.click();
    await expect(lateFilter).toHaveAttribute('aria-pressed', 'true');
    await expect(review.getByRole('heading', { name: `${late.key} ${late.title}`, exact: true })).toBeVisible();
    await expect(review).toContainText('3일 초과');
    await expect(review.getByRole('button', { name: `${unscheduled.key} 상세 열기`, exact: true })).toHaveCount(0);
    await lateDetails.click();
    const ticket = page.getByRole('dialog', { name: late.title, exact: true });
    await expect(ticket).toBeVisible();
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(ticket).toHaveCount(0);
    await expect(lateDetails).toBeFocused();
    await closeReview.click();
    await expect(review).toHaveCount(0);
    await expect(listTrigger).toBeFocused();

    await chartMilestone.getByRole('button', { name: `${reviewItem.title} 연결 업무 확인`, exact: true }).click();
    await expect(title).toBeFocused();
    await review.getByRole('button', { name: `${late.key} 간트 위치`, exact: true }).click();
    await expect(page).toHaveURL(url => {
      const [path, query] = url.hash.split('?');
      const parameters = new URLSearchParams(query);
      return path === route && parameters.get('milestone') === reviewItem.id &&
        parameters.get('focusIssue') === late.id && parameters.get('focusDate') === 'endDate';
    });
    await expect(search).toHaveValue(within.key);
    await expect(lateRow).toHaveAttribute('data-focused-issue', 'true');
    const endDate = lateRow.getByLabel(`${late.key} 종료일`, { exact: true });
    await expect(endDate).toBeFocused();
    await expect(endDate).toHaveValue(plannedLate);

    await page.goto(`/#/${project.id}/issues?${new URLSearchParams({ issue: late.id })}`);
    const linkedMilestones = ticket.getByRole('region', { name: '연결된 이정표', exact: true });
    await linkedMilestones.getByRole('link', { name: `${reviewItem.title} 간트에서 보기`, exact: true }).click();
    await expect(ticket).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === `${route}?${new URLSearchParams({ milestone: reviewItem.id })}`);
    await expect(title).toBeFocused();
    await page.reload();
    await expect(title).toBeFocused();
    await expect(review.getByRole('button', { name: '이정표 이후 1개', exact: true })).toBeVisible();

    await json<Issue>(await request.patch(`/api/issues/${late.id}`, { headers: { 'X-Actor-Id': peer.id }, data: {
      expectedVersion: late.version, endDate: targetDate,
    } }));
    await page.getByRole('button', { name: '간트 새로고침', exact: true }).click();
    await expect(review.getByRole('button', { name: '이정표 이내 2개', exact: true })).toBeVisible();
    await expect(review.getByRole('button', { name: '이정표 이후 1개', exact: true })).toHaveCount(0);

    savedView = await json<SavedView>(await request.post('/api/views', { headers, data: {
      projectId: project.id, name: '배포 업무만', layout: 'list', filters: { query: within.title, status: 'all', assigneeId: 'all', type: 'all' },
    } }), 201);
    await page.goto(`/${route}?${new URLSearchParams({ milestone: reviewItem.id, savedView: savedView.id })}`);
    await expect(lateRow).toHaveCount(0);
    await review.getByRole('button', { name: `${late.key} 간트 위치`, exact: true }).click();
    await expect(endDate).toBeFocused();
    await closeReview.click();
    await expect(page).toHaveURL(url => {
      const parameters = new URLSearchParams(url.hash.split('?')[1]);
      return !parameters.has('milestone') && parameters.get('savedView') === savedView?.id && parameters.get('focusIssue') === late.id;
    });
    await expect(lateRow).toHaveAttribute('data-focused-issue', 'true');

    await chart.locator(`[data-milestone-id="${empty.id}"]`).getByRole('button', { name: `${empty.title} 연결 업무 확인`, exact: true }).click();
    await expect(review.getByRole('heading', { name: empty.title, exact: true })).toBeFocused();
    await expect(review.getByText('연결된 업무가 없습니다.', { exact: true })).toBeVisible();

    await list.locator('summary').click();
    await list.locator('.schedule-milestone-name').filter({ hasText: empty.title }).click();
    const draftTitle = panel.getByRole('form', { name: '이정표 편집', exact: true }).getByLabel('이정표 제목', { exact: true });
    await draftTitle.fill('저장 대기 중인 두 번째 이정표 제목');
    await listTrigger.click();
    await expect(title).toBeFocused();
    await expect(draftTitle).toHaveValue('저장 대기 중인 두 번째 이정표 제목');
    await closeReview.click();
    await expect(draftTitle).toHaveValue('저장 대기 중인 두 번째 이정표 제목');
    expect(writes).toEqual([]);
  } finally {
    if (savedView) await request.delete(`/api/views/${savedView.id}?expectedVersion=${savedView.version}`, { headers });
    for (const item of milestones) await request.delete(`/api/milestones/${item.id}?expectedVersion=${item.version}`, { headers });
    for (const item of issues) await request.delete(`/api/issues/${item.id}`, { headers });
  }
});
