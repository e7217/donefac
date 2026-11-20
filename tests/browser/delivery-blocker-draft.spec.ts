import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Response } from '@playwright/test';
import type { DeliveryBlockerReport, DocPage, Issue, SavedView, WorkspaceSnapshot } from '../../shared/types';

type DraftRequest = { requestId: string; revision: string; title: string; savedViewId: string; reason: 'issue_block' };
type DraftResult = { document: DocPage; duplicate: boolean };

async function readJson<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function workspace(request: APIRequestContext) {
  return readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
}

async function removeFixture(request: APIRequestContext, resource: 'issues' | 'documents', id: string) {
  const response = await request.delete(`/api/${resource}/${id}`);
  if (response.ok()) {
    const { trashEntryId } = await response.json() as { trashEntryId?: string };
    if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`);
  }
}

test('360px 진행 차단 보고서에서 변경된 조건을 다시 검토하고 회의 초안을 한 번만 저장한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project, otherProject] } = await workspace(request);
  const token = randomUUID().slice(0, 8);
  const prefix = `차단 회의 검증 ${token}`;
  const meetingTitle = `사용자가 정한 회의 제목 ${token}`;
  const reportPath = `/api/projects/${project.id}/delivery-blockers`;
  const draftPath = `${reportPath}/meeting-draft`;
  const issues: Issue[] = [];
  const attempts: DraftRequest[] = [];
  let view: SavedView | undefined;
  let committed: DocPage | undefined;

  async function issue(title: string, fields: Partial<Issue> = {}) {
    const value = await readJson<Issue>(await request.post('/api/issues', {
      data: { title, projectId: project.id, status: 'in_progress', ...fields },
    }), 201);
    issues.push(value);
    return value;
  }

  async function linkBlocker(target: Issue, source: Issue) {
    await readJson(await request.post(`/api/issues/${target.id}/relations`, {
      data: { otherIssueId: source.id, type: 'blocks', direction: 'incoming' },
    }), 201);
  }

  const meetingDocuments = async () => (await workspace(request)).documents.filter(value => value.projectId === project.id && value.title === meetingTitle);
  const draftResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === draftPath && response.request().method() === 'POST');

  try {
    const first = await issue(`${prefix} 먼저 차단`, { dueDate: '2030-01-16' });
    const newlyBlocked = await issue(`${prefix} 새로 차단`);
    const scheduleOnly = await issue(`${prefix} 일정 충돌만`, { startDate: '2030-01-08', endDate: '2030-01-09' });
    const cause = await issue(`다른 프로젝트 승인 ${token}`, { projectId: otherProject.id, status: 'todo' });
    const predecessor = await issue(`배포 선행 일정 ${token}`, { startDate: '2030-01-07', endDate: '2030-01-10' });
    await linkBlocker(first, cause);
    await readJson(await request.post('/api/dependencies', {
      data: { predecessorId: predecessor.id, successorId: scheduleOnly.id, type: 'FS', lagDays: 0 },
    }), 201);
    const savedView = await readJson<SavedView>(await request.post('/api/views', {
      data: { projectId: project.id, layout: 'list', name: `${prefix} 공유 보기`, filters: { query: prefix, status: 'all', type: 'all', assigneeId: 'all' } },
    }), 201);
    view = savedView;

    const waitForScopedReport = () => page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === reportPath && url.searchParams.get('savedViewId') === savedView.id &&
        url.searchParams.get('reason') === 'issue_block';
    });
    await page.goto(`/#/${project.id}/reports`);
    await page.getByRole('tab', { name: '진행 차단', exact: true }).click();
    const report = page.getByRole('tabpanel', { name: '진행 차단', exact: true });
    const viewInput = report.getByRole('combobox', { name: '진행 차단 공유 보기', exact: true });
    const reasonInput = report.getByRole('combobox', { name: '진행 차단 원인', exact: true });
    const card = (value: Issue) => report.getByRole('article', { name: `차단된 업무 ${value.key}`, exact: true });
    await viewInput.selectOption(savedView.id);
    const initialResponse = waitForScopedReport();
    await reasonInput.selectOption('issue_block');
    const initial = await readJson<DeliveryBlockerReport>(await initialResponse);
    expect(initial.items.map(row => row.issue.id)).toEqual([first.id]);
    await expect(card(first)).toContainText(cause.title);
    await expect(card(scheduleOnly)).toHaveCount(0);

    await report.getByRole('button', { name: '회의 초안 만들기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '회의 초안 만들기', exact: true });
    const titleInput = dialog.getByRole('textbox', { name: '회의 초안 제목', exact: true });
    const submit = dialog.getByRole('button', { name: '회의 초안 저장', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await titleInput.fill(meetingTitle);
    await linkBlocker(newlyBlocked, cause);

    await page.route(`**${draftPath}`, async route => {
      const body = route.request().postDataJSON() as DraftRequest;
      attempts.push(body);
      if (attempts.length !== 2) return route.continue();
      const result = await readJson<DraftResult>(await route.fetch(), 201);
      expect(result.duplicate).toBe(false);
      committed = result.document;
      await route.abort('failed');
    });

    const stale = draftResponse();
    await submit.click();
    expect((await stale).status()).toBe(409);
    const reload = dialog.getByRole('button', { name: '최신 보고서 불러오기', exact: true });
    await expect(reload).toBeEnabled();
    await expect(titleInput).toHaveValue(meetingTitle);
    expect(await meetingDocuments()).toEqual([]);
    const currentResponse = waitForScopedReport();
    await reload.click();
    const current = await readJson<DeliveryBlockerReport>(await currentResponse);
    expect(current.revision).not.toBe(initial.revision);
    expect(current.items.map(row => row.issue.id).sort()).toEqual([first.id, newlyBlocked.id].sort());
    await expect(titleInput).toHaveValue(meetingTitle);
    await expect(submit).toBeEnabled();
    await dialog.getByText('요약에 포함할 업무 2개', { exact: true }).click();
    await expect(dialog.getByText(newlyBlocked.title, { exact: false })).toBeVisible();
    expect(await meetingDocuments()).toEqual([]);

    await submit.click();
    const retry = dialog.getByRole('button', { name: '초안 저장 결과 다시 확인', exact: true });
    await expect(retry).toBeEnabled();
    await expect(titleInput).toHaveValue(meetingTitle);
    await expect(titleInput).not.toBeEditable();
    expect(await meetingDocuments()).toEqual([committed]);

    const replay = draftResponse();
    await retry.click();
    const result = await readJson<DraftResult>(await replay);
    expect(result).toEqual({ duplicate: true, document: committed });
    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toMatchObject({ revision: initial.revision, title: meetingTitle, savedViewId: savedView.id, reason: 'issue_block' });
    expect(attempts[1]).toMatchObject({ revision: current.revision, title: meetingTitle, savedViewId: savedView.id, reason: 'issue_block' });
    expect(attempts[1].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[2]).toEqual(attempts[1]);
    const document = result.document;
    expect(document).toMatchObject({ projectId: project.id, title: meetingTitle, status: 'draft' });
    const referenceIds = document.content.content?.filter(node => node.type === 'issueReference').map(node => node.attrs?.issueId);
    expect(referenceIds).toHaveLength(3);
    expect(referenceIds).toEqual(expect.arrayContaining([first.id, newlyBlocked.id, cause.id]));
    expect(document.plainText).not.toContain(scheduleOnly.title);
    expect(document.plainText).not.toContain(predecessor.title);
    expect(await meetingDocuments()).toEqual([document]);
    const links = (await workspace(request)).resourceLinks.filter(link => link.documentId === document.id);
    expect(links.map(link => link.issueId).sort()).toEqual([first.id, newlyBlocked.id, cause.id].sort());
    for (const link of links) expect(link.kind).toBe('진행 차단 회의');

    await dialog.getByRole('button', { name: '문서 열기', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(meetingTitle);
    const body = page.locator('[aria-label="문서 본문"]');
    await expect(body.getByRole('heading', { name: '차단 업무', exact: true })).toBeVisible();
    await expect(body.getByRole('heading', { name: '회의 메모', exact: true })).toBeVisible();
    await expect(body.getByText(`보기 ${savedView.name} · 원인 수동 차단`, { exact: true })).toBeVisible();
    await expect(body.getByText('미완료 업무 3개 · 차단된 업무 3개', { exact: true })).toBeVisible();
    await expect(body.getByText('수동 차단 2개 · 간트 일정 충돌 1개 · GitLab 조치 0개', { exact: true })).toBeVisible();
    await expect(body.getByText('선택한 조건에 해당하는 업무 2개 중 2개를 기록했습니다.', { exact: true })).toBeVisible();
    await expect(body.getByText(`${cause.key} · ${cause.title}`, { exact: false }).first()).toBeVisible();
    await expect(body.getByRole('button', { name: `참조 업무 열기 ${cause.key} ${cause.title}`, exact: true })).toHaveCount(1);

    const renamed = await readJson<Issue>(await request.patch(`/api/issues/${cause.id}`, {
      data: { expectedVersion: cause.version, title: `현재 외부 승인 이름 ${token}` },
    }));
    const source = body.getByRole('link', { name: '진행 차단 보고서 열기', exact: true });
    await expect(source).toHaveAttribute('href', `#/${project.id}/reports/blockers?savedView=${savedView.id}&reason=issue_block`);
    const sourceResponse = waitForScopedReport();
    await source.click();
    const live = await readJson<DeliveryBlockerReport>(await sourceResponse);
    expect(live.revision).not.toBe(current.revision);
    await expect(viewInput).toHaveValue(savedView.id);
    await expect(reasonInput).toHaveValue('issue_block');
    await expect(card(first)).toContainText(renamed.title);
    await expect(card(scheduleOnly)).toHaveCount(0);
    expect(await meetingDocuments()).toEqual([document]);

    for (const linked of [first, renamed]) {
      await card(first).getByRole('button', { name: `${linked.key} ${linked.title} 업무 열기`, exact: true }).click();
      const detail = page.getByRole('dialog', { name: linked.title, exact: true });
      const backlinks = detail.getByRole('region', { name: '연결된 문서', exact: true });
      await expect(backlinks.getByRole('button', { name: meetingTitle, exact: true })).toBeVisible();
      await expect(backlinks.getByText('본문 참조 1곳', { exact: true })).toBeVisible();
      await detail.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
      await expect(detail).toHaveCount(0);
    }
  } finally {
    for (const document of await meetingDocuments()) await removeFixture(request, 'documents', document.id);
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const item of issues) await removeFixture(request, 'issues', item.id);
  }
});
