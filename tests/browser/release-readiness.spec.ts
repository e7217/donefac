import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import type {
  DeliveryBlockerDraftResult, DeliveryBlockerReport, GitlabSettings, Issue, PlanningItem, SavedView, WorkspaceSnapshot,
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

function readReport(page: Page, path: string, releaseId: string | null, reason?: string, savedViewId?: string) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === path &&
      url.searchParams.get('releaseId') === releaseId && url.searchParams.get('reason') === (reason ?? null) &&
      url.searchParams.get('savedViewId') === (savedViewId ?? null);
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

test('360px 릴리스와 진행 차단에서 GitLab 수동 실행 대기를 확인하고 회의 초안에 남긴다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await workspace(request);
  const unique = randomUUID();
  const prefix = `릴리스 GitLab 확인 ${unique.slice(0, 8)}`;
  const draftTitle = `${prefix} 회의 문서`;
  const gitlabPath = '/api/integrations/gitlab';
  const settings = async () => readJson<GitlabSettings>(await request.get(gitlabPath));
  const original = await settings();
  expect(original.baseUrl).toBe('');
  const baseUrl = 'https://gitlab-release-check.example.test';
  const webhookSecret = `synthetic-release-manual-${unique}`;
  const repositoryId = 42;
  const reportPath = `/api/projects/${project.id}/delivery-blockers`;
  const plan = await readJson<PlanningItem>(await request.post('/api/planning-items', { data: {
    projectId: project.id, name: prefix, kind: 'release', targetDate: '2030-01-10',
  } }), 201);
  const reportHash = `#/${project.id}/reports/blockers?release=${plan.id}&reason=gitlab`;
  let issue: Issue | undefined;
  let savedView: SavedView | undefined;
  let draftId: string | undefined;
  const observedAt = Date.now() - 60_000;

  async function pipeline(target: Issue, id: number, source: 'push' | 'schedule', status: 'manual' | 'success') {
    const response = await readJson<{ linked: number }>(await request.post(`${gitlabPath}/webhook`, {
      headers: { 'X-Gitlab-Event': 'Pipeline Hook', 'X-Gitlab-Token': webhookSecret, 'webhook-id': randomUUID() },
      data: { object_kind: 'pipeline', project: { id: repositoryId, web_url: `${baseUrl}/team/release` }, object_attributes: {
        id, source, status, sha: 'a'.repeat(40), ref: `feature/${target.key}`, tag: false,
        updated_at: new Date(observedAt + (id - 601) * 1000).toISOString(),
      } },
    }));
    expect(response.linked).toBe(1);
  }

  try {
    issue = await readJson<Issue>(await request.post('/api/issues', { data: {
      projectId: project.id, title: `${prefix} 검토 업무`, releaseId: plan.id, startDate: '2030-01-07', endDate: '2030-01-08',
    } }), 201);
    savedView = await readJson<SavedView>(await request.post('/api/views', { data: {
      projectId: project.id, name: prefix, layout: 'list', filters: {
        query: prefix, status: 'all', type: 'all', assigneeId: 'all', gitlab: 'manual_pipeline',
      },
    } }), 201);
    await readJson(await request.patch(gitlabPath, { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId], webhookSecret,
    } }));
    await pipeline(issue, 601, 'push', 'manual');
    await pipeline(issue, 602, 'push', 'manual');
    await pipeline(issue, 603, 'schedule', 'manual');

    const releaseRequest = readReport(page, reportPath, plan.id, 'gitlab');
    await page.goto(`/${reportHash}`);
    const release = await readJson<DeliveryBlockerReport>(await releaseRequest);
    expect(release.total).toBe(1);
    expect(release.counts).toMatchObject({ open: 1, affected: 1, reasons: {
      gitlab: 1, issue_block: 0, schedule_conflict: 0, missing_schedule: 0, after_release_date: 0,
    } });
    expect(release.items).toMatchObject([{ issue: { id: issue.id }, gitlab: { blockedMergeRequests: 0, failedPipelines: 0, manualPipelines: 2 } }]);
    const report = page.getByRole('tabpanel', { name: '진행 차단', exact: true });
    const releaseCard = report.getByRole('article', { name: `준비 확인 업무 ${issue.key}`, exact: true });
    await expect(releaseCard.getByText('수동 실행 대기 파이프라인 2건', { exact: true })).toBeVisible();
    const activity = releaseCard.getByRole('list', { name: 'GitLab 원인 활동', exact: true });
    const pushLink = activity.getByRole('link', { name: /파이프라인 #602/u });
    const scheduledLink = activity.getByRole('link', { name: /파이프라인 #603/u });
    const pushUrl = `${baseUrl}/team/release/-/pipelines/602`;
    const scheduledUrl = `${baseUrl}/team/release/-/pipelines/603`;
    await expect(pushLink).toHaveAttribute('href', pushUrl);
    await expect(scheduledLink).toHaveAttribute('href', scheduledUrl);
    await expect(activity.getByRole('link', { name: /파이프라인 #601/u })).toHaveCount(0);
    await expect(activity.getByText('수동 실행 대기 · 예약', { exact: true })).toBeVisible();
    await page.context().route(`${baseUrl}/**`, route => route.fulfill({ status: 200, body: 'synthetic GitLab pipeline' }));
    const [popup] = await Promise.all([page.waitForEvent('popup'), pushLink.click()]);
    await expect(popup).toHaveURL(pushUrl);
    await popup.close();
    expect(new URL(page.url()).hash).toBe(reportHash);

    const openIssue = releaseCard.getByRole('button', { name: `${issue.key} ${issue.title} 업무 열기`, exact: true });
    await openIssue.click();
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    await expect(ticket.getByRole('region', { name: '파이프라인', exact: true }).getByRole('listitem')
      .filter({ hasText: '#602' }).getByText('수동 실행', { exact: true })).toBeVisible();
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(openIssue).toBeFocused();

    await report.getByRole('button', { name: '회의 초안 만들기', exact: true }).click();
    const draft = page.getByRole('dialog', { name: '회의 초안 만들기', exact: true });
    await draft.getByText('요약에 포함할 업무 1개', { exact: true }).click();
    await expect(draft.getByText('수동 실행 대기 파이프라인 2건', { exact: true })).toBeVisible();
    await expect(draft.getByText(/파이프라인 #602 .* 수동 실행 대기 · 푸시/u)).toBeVisible();
    await draft.getByRole('textbox', { name: '회의 초안 제목', exact: true }).fill(draftTitle);
    const capture = page.waitForResponse(response => new URL(response.url()).pathname === `${reportPath}/meeting-draft` &&
      response.request().method() === 'POST');
    await draft.getByRole('button', { name: '회의 초안 저장', exact: true }).click();
    const response = await capture;
    expect(response.request().postDataJSON()).toMatchObject({ releaseId: plan.id, revision: release.revision, reason: 'gitlab', title: draftTitle });
    const { document } = await readJson<DeliveryBlockerDraftResult>(response, 201);
    draftId = document.id;
    expect(document.plainText).toContain('수동 실행 대기 파이프라인 2건');
    expect(document.plainText).toContain('파이프라인 #602');
    expect(JSON.stringify(document.content)).toContain(pushUrl);
    await draft.getByRole('button', { name: '문서 열기', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(draftTitle);
    const documentUrl = page.url();
    const backLink = page.locator('[aria-label="문서 본문"]').getByRole('link', { name: '진행 차단 보고서 열기', exact: true });
    await expect(backLink).toHaveAttribute('href', reportHash);

    await pipeline(issue, 604, 'push', 'success');
    const liveRequest = readReport(page, reportPath, plan.id, 'gitlab');
    await backLink.click();
    const live = await readJson<DeliveryBlockerReport>(await liveRequest);
    expect(live.revision).not.toBe(release.revision);
    expect(live.counts.reasons.gitlab).toBe(1);
    await expect(releaseCard.getByText('수동 실행 대기 파이프라인 1건', { exact: true })).toBeVisible();
    await expect(pushLink).toHaveCount(0);
    await expect(scheduledLink).toBeVisible();

    const projectRequest = readReport(page, reportPath, null, 'gitlab', savedView.id);
    await page.goto(`/#/${project.id}/reports/blockers?savedView=${savedView.id}&reason=gitlab`);
    const projectReport = await readJson<DeliveryBlockerReport>(await projectRequest);
    expect(projectReport.counts.reasons.gitlab).toBe(1);
    const projectCard = report.getByRole('article', { name: `차단된 업무 ${issue.key}`, exact: true });
    await expect(projectCard.getByText('수동 실행 대기 파이프라인 1건', { exact: true })).toBeVisible();
    await expect(projectCard.getByRole('link', { name: /파이프라인 #603/u })).toHaveAttribute('href', scheduledUrl);

    await pipeline(issue, 605, 'schedule', 'success');
    const refreshed = readReport(page, reportPath, null, 'gitlab', savedView.id);
    await report.getByRole('button', { name: '진행 차단 새로고침', exact: true }).click();
    const clear = await readJson<DeliveryBlockerReport>(await refreshed);
    expect(clear.revision).not.toBe(projectReport.revision);
    expect(clear).toMatchObject({ counts: { affected: 0, reasons: { gitlab: 0 } }, total: 0, items: [] });
    await expect(projectCard).toHaveCount(0);
    const clearRelease = await readJson<DeliveryBlockerReport>(await request.get(`${reportPath}?releaseId=${plan.id}&reason=gitlab`));
    expect(clearRelease).toMatchObject({ counts: { open: 1, affected: 0, reasons: { gitlab: 0 } }, total: 0, items: [] });

    await page.goto(documentUrl);
    await expect(page.locator('[aria-label="문서 본문"]')).toContainText('수동 실행 대기 파이프라인 2건');
  } finally {
    if (draftId) await removeFixture(request, 'documents', draftId);
    if (savedView) await request.delete(`/api/views/${savedView.id}?expectedVersion=${savedView.version}`);
    if (issue) await removeFixture(request, 'issues', issue.id);
    await request.delete(`/api/planning-items/${plan.id}?expectedVersion=${plan.version}`);
    const current = await settings();
    if (current.baseUrl === baseUrl) await readJson(await request.patch(gitlabPath, { data: {
      expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
    } }));
  }
});
