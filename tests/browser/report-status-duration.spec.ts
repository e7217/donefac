import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Issue, Project, ProjectReport, ReportSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 }, timezoneId: 'UTC' });

test('360px 보고서에서 상태 전이와 현재 체류 업무를 확인하고 저장 당시 결과를 다시 연다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const key = `SD${randomUUID().slice(0, 8).toUpperCase()}`;
  const projectResponse = await request.post('/api/projects', { data: { key, name: `${key} 체류 검증` } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project: Project = await projectResponse.json();
  const reportPath = `/api/projects/${project.id}/report`;
  const route = `/#/${project.id}/reports`;
  const issues = new Map<string, Issue>();
  let documentId: string | undefined;

  async function createIssue(title: string, status: string): Promise<Issue> {
    const response = await request.post('/api/issues', { data: { projectId: project.id, title, status } });
    expect(response.status(), await response.text()).toBe(201);
    const issue: Issue = await response.json();
    issues.set(issue.id, issue);
    return issue;
  }

  async function transition(issue: Issue, status: string, title = issue.title): Promise<Issue> {
    const response = await request.patch(`/api/issues/${issue.id}`, { data: { expectedVersion: issue.version, status, title } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const updated: Issue = await response.json();
    issues.set(updated.id, updated);
    return updated;
  }

  try {
    const starting = await createIssue(`${key} 검토 대기 구성 확인`, 'todo');
    const reviewed = await transition(await transition(starting, 'in_progress'), 'review');
    const working = await createIssue(`${key} 진행 중 추적`, 'in_progress');
    const done = await createIssue(`${key} 완료 업무`, 'done');
    const firstDay = starting.createdAt.slice(0, 10);
    const lastDay = done.createdAt.slice(0, 10);
    const previousDay = new Date(Date.parse(`${firstDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

    await page.goto(route);
    const query = page.getByRole('form', { name: '보고서 조회 조건', exact: true });
    const from = query.getByLabel('보고서 시작일', { exact: true });
    const to = query.getByLabel('보고서 종료일', { exact: true });
    const submit = query.getByRole('button', { name: '보고서 조회', exact: true });
    const current = page.getByRole('region', { name: '현재 보고서 집계', exact: true });
    const duration = current.getByRole('region', { name: '상태별 체류 시간', exact: true });
    const history = duration.getByRole('table', { name: '선택 기간의 상태별 기록', exact: true });
    const queue = current.getByRole('region', { name: '현재 상태에 머무는 업무', exact: true });
    const statusFilter = queue.getByLabel('현재 체류 상태 필터', { exact: true });
    const reviewName = `${reviewed.key} ${reviewed.title}`;
    const workingName = `${working.key} ${working.title}`;

    async function loadRange(startDate: string, endDate: string): Promise<ProjectReport> {
      await from.fill(startDate);
      await to.fill(endDate);
      const loaded = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === reportPath && url.searchParams.get('startDate') === startDate && url.searchParams.get('endDate') === endDate;
      });
      await submit.click();
      const response = await loaded;
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    }

    await expect(current).toBeVisible();
    const initial = await loadRange(firstDay, lastDay);
    expect(initial.definitionVersion).toBe(2);
    expect(initial.statusDuration?.completedVisits).toEqual(expect.arrayContaining([
      expect.objectContaining({ statusId: 'in_progress', samples: 1, unknownEntries: 0, medianHours: expect.any(Number) }),
    ]));
    expect(initial.statusDuration?.openIssues.map(issue => issue.issueId)).toEqual(expect.arrayContaining([reviewed.id, working.id]));
    expect(initial.statusDuration?.openIssues.map(issue => issue.issueId)).not.toContain(done.id);

    const observedWorking = history.getByRole('row').filter({ has: page.getByText('진행 중', { exact: true }) });
    await expect(observedWorking).toBeVisible();
    await expect(queue.getByText(/보고서 조회 시점의 미완료 업무/)).toBeVisible();
    await expect(queue.getByRole('button', { name: reviewName, exact: true })).toBeVisible();
    await expect(queue.getByRole('button', { name: workingName, exact: true })).toBeVisible();
    await expect(queue.getByText(done.title, { exact: true })).toHaveCount(0);
    const queueBounds = await queue.boundingBox();
    expect(queueBounds).not.toBeNull();
    expect(queueBounds!.x).toBeGreaterThanOrEqual(0);
    expect(queueBounds!.x + queueBounds!.width).toBeLessThanOrEqual(360);

    await from.fill(previousDay);
    await to.fill(previousDay);
    await expect(query.getByText('조건이 변경되었습니다. 조회하면 아래 결과를 갱신합니다.')).toBeVisible();
    await expect(observedWorking).toBeVisible();
    const earlier = await loadRange(previousDay, previousDay);
    expect(earlier.statusDuration?.completedVisits).toEqual([]);
    expect(earlier.statusDuration?.openIssues.map(issue => issue.issueId)).toContain(reviewed.id);
    await expect(duration.getByText('선택 기간에 관측된 상태 전이가 없습니다.')).toBeVisible();
    await statusFilter.selectOption('review');
    const reviewLink = queue.getByRole('button', { name: reviewName, exact: true });
    await expect(queue.getByRole('button', { name: workingName, exact: true })).toHaveCount(0);
    const beforeOpen = page.url();
    await reviewLink.click();
    const ticket = page.getByRole('dialog', { name: reviewed.title, exact: true });
    await expect(ticket).toBeVisible();
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(ticket).toHaveCount(0);
    await expect(page).toHaveURL(beforeOpen);
    await expect(statusFilter).toHaveValue('review');
    await expect(reviewLink).toBeVisible();
    await expect(queue.getByRole('button', { name: workingName, exact: true })).toHaveCount(0);
    await expect(from).toHaveValue(previousDay);

    await loadRange(firstDay, lastDay);
    const share = page.getByRole('form', { name: '공유 보고서 초안 만들기', exact: true });
    const snapshotTitle = `${key} 체류 기록 보관본`;
    await share.getByLabel('공유 보고서 제목', { exact: true }).fill(snapshotTitle);
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === `${reportPath}-snapshots` && response.request().method() === 'POST');
    await share.getByRole('button', { name: '공유 초안 저장', exact: true }).click();
    const savedResponse = await saved;
    expect(savedResponse.status(), await savedResponse.text()).toBe(201);
    const snapshot: ReportSnapshot = await savedResponse.json();
    documentId = snapshot.documentId;
    expect(snapshot.report.statusDuration?.openIssues.find(issue => issue.issueId === reviewed.id)).toMatchObject({
      statusId: 'review', enteredAt: expect.any(String), elapsedHours: expect.any(Number),
    });
    const savedReport = page.getByRole('region', { name: '저장 보고서 집계', exact: true });
    const savedQueue = savedReport.getByRole('region', { name: '현재 상태에 머무는 업무', exact: true });
    await expect(savedQueue.getByText(/보관 당시 미완료 업무/)).toBeVisible();
    await expect(savedQueue.getByRole('button', { name: reviewName, exact: true })).toBeVisible();
    const href = await page.getByRole('link', { name: '보고서 고정 링크', exact: true }).getAttribute('href');
    expect(href).toBe(`${route.slice(1)}/${snapshot.id}`);

    const finished = await transition(reviewed, 'done', `${key} 확인 완료로 변경`);
    const liveRange = new URLSearchParams({ startDate: firstDay, endDate: finished.updatedAt.slice(0, 10), timeZone: 'UTC' });
    const currentResponse = await request.get(`${reportPath}?${liveRange}`);
    expect(currentResponse.ok(), await currentResponse.text()).toBeTruthy();
    const latest: ProjectReport = await currentResponse.json();
    expect(latest.statusDuration?.openIssues.map(issue => issue.issueId)).toEqual([working.id]);
    expect(latest.statusDuration?.completedVisits).toEqual(expect.arrayContaining([
      expect.objectContaining({ statusId: 'review', samples: 1 }),
    ]));

    await page.goto(`/${href}`);
    await page.reload();
    await expect(page.getByRole('heading', { name: snapshotTitle, exact: true })).toBeVisible();
    await expect(savedQueue.getByRole('button', { name: reviewName, exact: true })).toBeVisible();
    const fixedResponse = await request.get(`${reportPath}-snapshots/${snapshot.id}`);
    expect(fixedResponse.ok(), await fixedResponse.text()).toBeTruthy();
    const fixed: ReportSnapshot = await fixedResponse.json();
    expect(fixed.report.statusDuration).toEqual(snapshot.report.statusDuration);
  } finally {
    if (documentId) await request.delete(`/api/documents/${documentId}`);
    for (const issue of issues.values()) await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
  }
});
