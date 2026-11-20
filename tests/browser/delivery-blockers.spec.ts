import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { DeliveryBlockerReason, DeliveryBlockerReport, Issue, IssueRelation, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function create<T>(request: APIRequestContext, route: string, data: object): Promise<T> {
  const response = await request.post(`/api/${route}`, { data });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

test('360px 진행 차단 보고서에서 공유 보기와 원인을 전환하고 차단 관계를 해제한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const workspaceResponse = await request.get('/api/workspace');
  expect(workspaceResponse.ok(), await workspaceResponse.text()).toBe(true);
  const { projects: [project, otherProject] } = await workspaceResponse.json() as WorkspaceSnapshot;
  const tag = randomUUID().slice(0, 8);
  const title = `진행 차단 확인 ${tag}`;
  const issues: Issue[] = [];
  const views: SavedView[] = [];
  const reportRoute = `/#/${project.id}/reports`;
  const reportApi = `/api/projects/${project.id}/delivery-blockers`;

  async function addIssue(name: string, fields: Partial<Issue> = {}) {
    const issue = await create<Issue>(request, 'issues', { projectId: project.id, status: 'in_progress', title: name, ...fields });
    issues.push(issue);
    return issue;
  }

  async function addView(name: string, query: string) {
    const view = await create<SavedView>(request, 'views', {
      projectId: project.id, name, layout: 'list', filters: { query, status: 'all', type: 'all', assigneeId: 'all' },
    });
    views.push(view);
    return view;
  }

  try {
    const manuallyBlocked = await addIssue(`${title} 검토 업무`, { priority: 'high', dueDate: '2030-01-16' });
    const crossProject = await addIssue(`외부 승인 ${tag}`, { projectId: otherProject.id, status: 'todo' });
    const latePredecessor = await addIssue(`배포 준비 ${tag}`, { startDate: '2030-01-07', endDate: '2030-01-10' });
    const conflicting = await addIssue(`${title} 배포 업무`, { startDate: '2030-01-08', endDate: '2030-01-09' });
    const relationPath = `issues/${manuallyBlocked.id}/relations`;
    const relation = await create<IssueRelation>(request, relationPath, { otherIssueId: crossProject.id, type: 'blocks', direction: 'incoming' });
    await create(request, 'dependencies', { predecessorId: latePredecessor.id, successorId: conflicting.id, type: 'FS', lagDays: 0 });
    const combined = await addView(`${title} 전체`, title);
    const manualOnly = await addView(`${title} 검토만`, manuallyBlocked.title);

    await page.goto(reportRoute);
    const deliveryTab = page.getByRole('tab', { name: '진행 차단', exact: true });
    await deliveryTab.click();
    const panel = page.getByRole('tabpanel', { name: '진행 차단', exact: true });
    const savedView = panel.getByRole('combobox', { name: '진행 차단 공유 보기', exact: true });
    const reason = panel.getByRole('combobox', { name: '진행 차단 원인', exact: true });
    const refresh = panel.getByRole('button', { name: '진행 차단 새로고침', exact: true });
    const list = panel.getByRole('list', { name: '차단된 업무 목록', exact: true });
    const targetButton = (issue: Issue) => list.getByRole('button', { name: `${issue.key} ${issue.title} 업무 열기`, exact: true });
    const cards = list.getByRole('article');
    const card = (issue: Issue) => list.getByRole('article', { name: `차단된 업무 ${issue.key}`, exact: true });

    async function readReport(view: SavedView, change: () => Promise<unknown>, expectedReason?: DeliveryBlockerReason): Promise<DeliveryBlockerReport> {
      const result = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === reportApi && url.searchParams.get('savedViewId') === view.id &&
          (expectedReason === undefined || url.searchParams.get('reason') === expectedReason);
      });
      await change();
      const response = await result;
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    }

    await expect(savedView).toBeEnabled();
    const report = await readReport(combined, () => savedView.selectOption(combined.id));
    expect(report.savedView?.id).toBe(combined.id);
    expect(report.total).toBe(2);
    expect(report.counts.reasons).toMatchObject({ issue_block: 1, schedule_conflict: 1 });
    const manual = report.items.find(item => item.issue.id === manuallyBlocked.id);
    expect(manual?.blockers).toMatchObject({ total: 1, items: [{ id: crossProject.id, projectId: otherProject.id, key: crossProject.key }] });
    expect(manual?.deadline).toEqual({ value: manuallyBlocked.dueDate, source: 'dueDate' });
    const schedule = report.items.find(item => item.issue.id === conflicting.id);
    expect(schedule?.scheduleConflicts).toMatchObject({ total: 1, items: [{ predecessor: { id: latePredecessor.id }, type: 'FS',
      endpoint: 'startDate', scheduledDate: conflicting.startDate, requiredDate: '2030-01-11' }] });
    await expect(cards).toHaveCount(2);
    await expect(card(manuallyBlocked)).toContainText(crossProject.title);
    await expect(card(conflicting)).toContainText(latePredecessor.title);
    await expect(card(conflicting).locator('time[datetime="2030-01-11"]')).toHaveText('2030-01-11');
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await reason.selectOption('schedule_conflict');
    await expect(cards).toHaveCount(1);
    await expect(targetButton(conflicting)).toBeVisible();
    await expect(targetButton(manuallyBlocked)).toHaveCount(0);
    const narrowed = await readReport(manualOnly, () => savedView.selectOption(manualOnly.id), 'schedule_conflict');
    expect(narrowed.total).toBe(0);
    await expect(cards).toHaveCount(0);

    await reason.selectOption('issue_block');
    await expect(cards).toHaveCount(1);
    const manualCard = card(manuallyBlocked);
    const externalButton = manualCard.getByRole('button', { name: `${crossProject.key} ${crossProject.title} 업무 열기`, exact: true });
    await expect(externalButton).toBeVisible();
    const beforeOpen = page.url();
    await externalButton.click();
    const externalIssue = page.getByRole('dialog', { name: crossProject.title, exact: true });
    await expect(externalIssue).toBeVisible();
    expect(new URL(page.url()).hash).toContain(`#/${project.id}/reports`);
    await externalIssue.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(externalIssue).toHaveCount(0);
    await expect(page).toHaveURL(beforeOpen);
    await expect(savedView).toHaveValue(manualOnly.id);
    await expect(reason).toHaveValue('issue_block');
    await expect(externalButton).toBeFocused();

    await targetButton(manuallyBlocked).click();
    const detail = page.getByRole('dialog', { name: manuallyBlocked.title, exact: true });
    const relations = detail.getByRole('region', { name: '업무 관계', exact: true });
    await relations.getByRole('button', { name: `${crossProject.key} 관계 해제`, exact: true }).click();
    const confirm = relations.getByRole('group', { name: '업무 관계 해제', exact: true });
    const removed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/${relationPath}/${relation.id}` &&
      response.request().method() === 'DELETE');
    await confirm.getByRole('button', { name: '업무 관계 해제', exact: true }).click();
    expect((await removed).ok()).toBe(true);
    await expect(relations.getByText('연결된 업무 관계가 없습니다.', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(page).toHaveURL(beforeOpen);
    const after = await readReport(manualOnly, () => refresh.click(), 'issue_block');
    expect(after.total).toBe(0);
    expect(after.counts.affected).toBe(0);
    await expect(cards).toHaveCount(0);

    await savedView.selectOption(combined.id);
    await reason.selectOption('schedule_conflict');
    await expect(cards).toHaveCount(1);
    await expect(targetButton(conflicting)).toBeVisible();
    await expect(targetButton(manuallyBlocked)).toHaveCount(0);
  } finally {
    for (const view of views) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of issues) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});
