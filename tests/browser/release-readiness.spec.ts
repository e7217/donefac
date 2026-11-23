import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import type {
  DeliveryBlockerDraftResult, DeliveryBlockerReport, Issue, PlanningItem, WorkspaceSnapshot,
} from '../../shared/types';

async function readJson<T>(response: Pick<APIResponse | Response, 'status' | 'json' | 'text'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));

async function removeFixture(request: APIRequestContext, resource: 'issues' | 'documents', id: string) {
  const response = await request.delete(`/api/${resource}/${id}`);
  if (response.ok()) {
    const { trashEntryId } = await response.json() as { trashEntryId?: string };
    if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`);
  }
}

function readReport(page: Page, path: string, releaseId: string, reason?: string) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === path &&
      url.searchParams.get('releaseId') === releaseId && url.searchParams.get('reason') === (reason ?? null);
  });
}

test('360px에서 선택한 릴리스의 준비 점검을 열고 업무와 회의 초안에서 같은 범위로 돌아온다', async ({ page, request }) => {
  test.setTimeout(115_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await workspace(request);
  const prefix = `릴리스 준비 검사 ${randomUUID().slice(0, 8)}`;
  const title = `${prefix} 회의 문서`;
  const reportPath = `/api/projects/${project.id}/delivery-blockers`;
  const draftPath = `${reportPath}/meeting-draft`;
  const cutoff = '2030-01-10';
  const plan = await readJson<PlanningItem>(await request.post('/api/planning-items', { data: {
    projectId: project.id, name: prefix, kind: 'release', startDate: '2030-01-07', endDate: '2030-01-15', targetDate: cutoff,
  } }), 201);
  const planHash = `#/${project.id}/planning/${plan.id}`;
  const reportHash = `#/${project.id}/reports/blockers?release=${plan.id}`;
  const issues: Issue[] = [];
  async function issue(suffix: string, fields: Partial<Issue>) {
    const value = await readJson<Issue>(await request.post('/api/issues', { data: {
      projectId: project.id, title: `${prefix} ${suffix}`, ...fields,
    } }), 201);
    issues.push(value);
    return value;
  }
  try {
    const missing = await issue('종료일 미정 업무', { releaseId: plan.id, startDate: '2030-01-07', dueDate: cutoff });
    const late = await issue('기한 초과 업무', { releaseId: plan.id, startDate: '2030-01-07', endDate: '2030-01-11' });
    const excluded = await issue('릴리스에 속하지 않는 업무', {});

    await page.goto(`/${planHash}`);
    await expect(page.getByRole('region', { name: '릴리스 상세', exact: true })).toBeVisible();
    const planningLink = page.getByRole('link', { name: '릴리스 준비 점검', exact: true });
    await expect(planningLink).toHaveAttribute('href', reportHash);
    const initialRequest = readReport(page, reportPath, plan.id);
    await planningLink.click();
    const initial = await readJson<DeliveryBlockerReport>(await initialRequest);
    expect(initial.release).toMatchObject({ id: plan.id, name: plan.name, deadline: cutoff, deadlineSource: 'targetDate' });
    expect(initial.counts.reasons).toMatchObject({ missing_schedule: 1, after_release_date: 1 });
    await expect(page).toHaveURL(new RegExp(`reports/blockers\\?release=${plan.id}$`));

    const report = page.getByRole('tabpanel', { name: '진행 차단', exact: true });
    await expect(report.getByRole('heading', { name: '릴리스 준비 점검', exact: true })).toBeVisible();
    const bounds = await report.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const releaseScope = report.getByRole('region', { name: '릴리스 범위', exact: true });
    await expect(releaseScope).toContainText(plan.name);
    await expect(releaseScope).toContainText(`릴리스 목표일 ${cutoff}`);
    const releaseFilter = report.getByRole('combobox', { name: '진행 차단 릴리스', exact: true });
    const reasonFilter = report.getByRole('combobox', { name: '진행 차단 원인', exact: true });
    const card = (value: Issue) => report.getByRole('article', { name: `준비 확인 업무 ${value.key}`, exact: true });
    await expect(releaseFilter).toHaveValue(plan.id);
    await expect(card(missing)).toContainText('종료일 미정');
    await expect(card(late)).toContainText('릴리스 기한 초과');
    await expect(card(excluded)).toHaveCount(0);

    const narrowedRequest = readReport(page, reportPath, plan.id, 'missing_schedule');
    await reasonFilter.selectOption('missing_schedule');
    const narrowed = await readJson<DeliveryBlockerReport>(await narrowedRequest);
    expect(narrowed.items.map(row => row.issue.id)).toEqual([missing.id]);
    await expect(card(late)).toHaveCount(0);
    const scopedHash = `${reportHash}&reason=missing_schedule`;
    await expect.poll(() => new URL(page.url()).hash).toBe(scopedHash);
    const openIssue = card(missing).getByRole('button', { name: `${missing.key} ${missing.title} 업무 열기`, exact: true });
    await openIssue.click();
    const detail = page.getByRole('dialog', { name: missing.title, exact: true });
    await expect(detail).toBeVisible();
    const [reportRoute, overlayQuery] = new URL(page.url()).hash.split('?');
    expect(reportRoute).toBe(`#/${project.id}/reports/blockers`);
    expect(Object.fromEntries(new URLSearchParams(overlayQuery))).toEqual({
      issue: missing.id, release: plan.id, reason: 'missing_schedule',
    });
    await detail.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).toBe(scopedHash);
    await expect(openIssue).toBeFocused();

    await report.getByRole('button', { name: '회의 초안 만들기', exact: true }).click();
    const draft = page.getByRole('dialog', { name: '회의 초안 만들기', exact: true });
    await draft.getByRole('textbox', { name: '회의 초안 제목', exact: true }).fill(title);
    const draftRequest = page.waitForResponse(response => new URL(response.url()).pathname === draftPath &&
      response.request().method() === 'POST');
    await draft.getByRole('button', { name: '회의 초안 저장', exact: true }).click();
    const draftResponse = await draftRequest;
    expect(draftResponse.request().postDataJSON()).toMatchObject({
      releaseId: plan.id, revision: narrowed.revision, reason: 'missing_schedule', title,
    });
    const { document } = await readJson<DeliveryBlockerDraftResult>(draftResponse, 201);
    expect(document.plainText).toContain(plan.name);
    expect(document.plainText).toContain('종료일 미정');
    expect(document.plainText).not.toContain(late.title);
    await draft.getByRole('button', { name: '문서 열기', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title);
    const backLink = page.locator('[aria-label="문서 본문"]').getByRole('link', { name: '진행 차단 보고서 열기', exact: true });
    await expect(backLink).toHaveAttribute('href', scopedHash);
    const returnRequest = readReport(page, reportPath, plan.id, 'missing_schedule');
    await backLink.click();
    const returned = await readJson<DeliveryBlockerReport>(await returnRequest);
    expect(returned.items.map(row => row.issue.id)).toEqual([missing.id]);
    await expect(releaseFilter).toHaveValue(plan.id);
    await expect(reasonFilter).toHaveValue('missing_schedule');
    await expect.poll(() => new URL(page.url()).hash).toBe(scopedHash);
    await page.reload();
    await expect(card(missing)).toBeVisible();
    await expect(reasonFilter).toHaveValue('missing_schedule');

    await releaseScope.getByRole('button', { name: '릴리스 간트 열기', exact: true }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${project.id}/gantt/${plan.id}`);
    await expect(page.getByRole('region', { name: '간트 차트', exact: true })).toBeVisible();
  } finally {
    for (const document of (await workspace(request)).documents.filter(value => value.title === title)) {
      await removeFixture(request, 'documents', document.id);
    }
    for (const value of issues) await removeFixture(request, 'issues', value.id);
    await request.delete(`/api/planning-items/${plan.id}?expectedVersion=${plan.version}`);
  }
});
