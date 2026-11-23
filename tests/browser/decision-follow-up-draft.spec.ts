import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Response } from '@playwright/test';
import { documentNodes } from '../../shared/document-references';
import type { DecisionFollowUpPage, DocPage, DocumentIssueLinkResult, Issue, RichContent, WorkspaceSnapshot } from '../../shared/types';

type DraftInput = { requestId: string; revision: string; title: string; destinationProjectId: string | null;
  projectId?: string; status?: string; assigneeId?: string; q?: string; offset?: number };
type DraftResult = { document: DocPage; duplicate: boolean };

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const paragraph = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function removeFixture(request: APIRequestContext, resource: 'issues' | 'documents', id: string) {
  const deleted = await request.delete(`/api/${resource}/${id}`);
  if (deleted.ok()) {
    const { trashEntryId } = await deleted.json() as { trashEntryId?: string };
    if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`);
  }
}

test('360px 팀 결정 후속 업무의 검토한 페이지를 새 위치에 한 번 저장하고 같은 조건으로 돌아온다', async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [destination, reportProject], users: [assignee] } = await workspace(request);
  const token = randomUUID().slice(0, 8);
  const query = `결정 초안 검증 ${token}`;
  const title = `팀 결정 회의 초안 ${token}`;
  const firstText = `편집 전 합의한 검증 절차 ${token}`;
  const secondText = `추가 회의에서 확정한 담당 범위 ${token}`;
  const amendedText = `원본 문서의 현재 문장 ${token}`;
  const oldPageText = `초안에 넣지 않을 이전 페이지 근거 ${token}`;
  const resultPath = '/api/decision-follow-ups';
  const draftPath = `${resultPath}/meeting-draft`;
  const issued: Issue[] = [];
  const sourceDocuments: DocPage[] = [];
  const attempts: DraftInput[] = [];
  let committed: DocPage | undefined;

  async function createIssue(name: string, dueDate: string) {
    const result = await json<Issue>(await request.post('/api/issues', { data: {
      projectId: reportProject.id, title: `${query} ${name}`, dueDate, assigneeId: assignee.id,
    } }), 201);
    issued.push(result);
    return result;
  }

  async function createSource(name: string, text: string, projectId: string | null) {
    const result = await json<DocPage>(await request.post('/api/documents', { data: { title: `${query} ${name}`, projectId, content: paragraph(text) } }), 201);
    sourceDocuments.push(result);
    return result;
  }

  async function cite(issue: Issue, source: DocPage, text: string) {
    return (await json<DocumentIssueLinkResult>(await request.post(`/api/documents/${source.id}/decision-links`, { data: {
      requestId: randomUUID(), expectedDocumentVersion: source.version, issueId: issue.id,
      sourceSelection: { from: 1, to: text.length + 1, text },
    } }), 201)).link;
  }

  function waitForReport(offset: number) {
    return page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === resultPath && Number(url.searchParams.get('offset') ?? 0) === offset &&
        url.searchParams.get('projectId') === reportProject.id && url.searchParams.get('q') === query;
    }, { timeout: 45_000 });
  }
  const waitForDraft = () => page.waitForResponse(response => new URL(response.url()).pathname === draftPath && response.request().method() === 'POST');
  const meetingDocuments = async () => (await workspace(request)).documents.filter(document => document.title === title);

  try {
    const [priorSource, firstSource, secondSource] = await Promise.all([
      createSource('이전 페이지 문서', oldPageText, reportProject.id),
      createSource('최초 결정 저장본', firstText, destination.id),
      createSource('팀 공통 결정 원본', secondText, null),
    ]);
    for (let index = 0; index < 20; index += 1) {
      await cite(await createIssue(`이전 페이지 ${index + 1}`, '2030-03-01'), priorSource, oldPageText);
    }
    const issue = await createIssue('현재 페이지 결정 업무', '2030-03-10');
    const sources = await Promise.all([cite(issue, firstSource, firstText), cite(issue, secondSource, secondText)]);
    await json<DocPage>(await request.patch(`/api/documents/${firstSource.id}`, { data: {
      expectedVersion: firstSource.version, title: `${query} 편집된 파일`, content: paragraph(amendedText),
    } }));

    const filters = { status: 'all', assigneeId: assignee.id, q: query, scope: 'team', decisionProject: reportProject.id };
    const firstPage = waitForReport(0);
    await page.goto(`/#/${destination.id}/reports/decision-follow-ups?${new URLSearchParams(filters)}`, { waitUntil: 'domcontentloaded' });
    expect((await json<DecisionFollowUpPage>(await firstPage)).total).toBe(22);
    const report = page.getByRole('tabpanel', { name: '결정 후속 업무', exact: true });
    const nextPage = waitForReport(20);
    await report.getByRole('button', { name: '다음 페이지', exact: true }).click();
    const initial = await json<DecisionFollowUpPage>(await nextPage);
    expect(initial.offset).toBe(20);
    expect(new Set(initial.items.map(item => item.linkId))).toEqual(new Set(sources.map(link => link.id)));

    const pageTwoHash = new URL(page.url()).hash;
    const liveSource = report.getByRole('link', { name: `현재 문서 열기 ${secondSource.title}`, exact: true });
    const sharedSourceHash = `#/${destination.id}/documents/${secondSource.id}`;
    await expect(liveSource).toHaveAttribute('href', sharedSourceHash);
    await liveSource.click();
    await expect(page).toHaveURL(url => url.hash === sharedSourceHash);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(secondSource.title);
    const returnedPage = waitForReport(20);
    await page.goBack();
    expect((await json<DecisionFollowUpPage>(await returnedPage)).revision).toBe(initial.revision);
    await expect(page).toHaveURL(url => url.hash === pageTwoHash);
    await expect(report.getByRole('link', { name: `현재 문서 열기 ${secondSource.title}`, exact: true })).toBeVisible();

    await report.getByRole('button', { name: '회의 초안 만들기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '회의 초안 만들기', exact: true });
    const titleInput = dialog.getByRole('textbox', { name: '회의 초안 제목', exact: true });
    const location = dialog.getByRole('combobox', { name: '저장 위치', exact: true });
    const submit = dialog.getByRole('button', { name: '회의 초안 저장', exact: true });
    await expect(location).toHaveValue(reportProject.id);
    await location.selectOption(destination.id);
    await titleInput.fill(title);
    const bounds = await dialog.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(360);

    const changed = await json<Issue>(await request.patch(`/api/issues/${issue.id}`, { data: {
      expectedVersion: issue.version, dueDate: '2030-03-15', title: `${query} 다시 확인한 업무`,
    } }));
    await page.route(`**${draftPath}`, async route => {
      attempts.push(route.request().postDataJSON() as DraftInput);
      if (attempts.length !== 2) return route.continue();
      committed = (await json<DraftResult>(await route.fetch(), 201)).document;
      await route.abort('failed');
    });

    const stale = waitForDraft();
    await submit.click();
    expect((await stale).status()).toBe(409);
    const reload = dialog.getByRole('button', { name: '최신 보고서 불러오기', exact: true });
    await expect(reload).toBeEnabled();
    await expect(titleInput).toHaveValue(title);
    await expect(location).toHaveValue(destination.id);
    expect(await meetingDocuments()).toEqual([]);
    const revisedPage = waitForReport(20);
    await reload.click();
    const reviewed = await json<DecisionFollowUpPage>(await revisedPage);
    expect(reviewed.revision).not.toBe(initial.revision);
    expect(reviewed.items.every(item => item.issue.title === changed.title)).toBe(true);
    await expect(titleInput).toHaveValue(title);
    await expect(location).toHaveValue(destination.id);

    await submit.click();
    const retry = dialog.getByRole('button', { name: '초안 저장 결과 다시 확인', exact: true });
    await expect(retry).toBeEnabled();
    expect(await meetingDocuments()).toEqual([committed]);
    const response = waitForDraft();
    await retry.click();
    const { document, duplicate } = await json<DraftResult>(await response);
    expect(document).toEqual(committed);
    expect(duplicate).toBe(true);
    expect(attempts).toHaveLength(3);
    const expected = { projectId: reportProject.id, status: 'all', assigneeId: assignee.id, q: query,
      offset: 20, title, destinationProjectId: destination.id };
    expect(attempts[0]).toMatchObject({ ...expected, revision: initial.revision });
    expect(attempts[1]).toMatchObject({ ...expected, revision: reviewed.revision });
    expect(attempts[1].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[2]).toEqual(attempts[1]);
    expect(document).toMatchObject({ projectId: destination.id, title, status: 'draft' });
    expect(document.plainText).toContain('2030-03-15');
    expect(document.plainText).not.toContain(amendedText);
    expect(document.plainText).not.toContain(oldPageText);
    const nodes = [...documentNodes(document.content)];
    expect(nodes.filter(node => node.type === 'issueReference').map(node => node.attrs?.issueId)).toEqual([issue.id]);
    expect(new Set(nodes.filter(node => node.type === 'documentReference').map(node => node.attrs?.documentId)))
      .toEqual(new Set([firstSource.id, secondSource.id]));
    const links = (await workspace(request)).resourceLinks.filter(link => link.documentId === document.id);
    expect(links.map(link => [link.issueId, link.documentSource])).toEqual([[issue.id, undefined]]);

    await dialog.getByRole('button', { name: '문서 열기', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title);
    const body = page.locator('[aria-label="문서 본문"]');
    await expect(body.getByRole('heading', { name: '회의 메모', exact: true })).toBeVisible();
    await expect(body.locator('blockquote')).toHaveCount(2);
    await expect(body.locator('blockquote', { hasText: firstText })).toBeVisible();
    await expect(body.locator('blockquote', { hasText: secondText })).toBeVisible();
    await body.getByRole('button', { name: new RegExp(`참조 업무 열기 ${issue.key}`) }).click();
    const detail = page.getByRole('dialog', { name: changed.title, exact: true });
    await expect(detail.getByRole('region', { name: '연결된 문서', exact: true }).getByRole('button', { name: title, exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(detail).toHaveCount(0);

    const latest = await json<Issue>(await request.patch(`/api/issues/${issue.id}`, { data: {
      expectedVersion: changed.version, title: `${query} 저장 뒤 바뀐 업무`,
    } }));
    const backlink = body.getByRole('link', { name: '결정 후속 업무 보고서 열기', exact: true });
    const href = await backlink.getAttribute('href');
    expect(Object.fromEntries(new URLSearchParams(href?.split('?')[1]))).toEqual({ ...filters, offset: '20' });
    const returned = waitForReport(20);
    await backlink.click();
    const live = await json<DecisionFollowUpPage>(await returned);
    expect(live.total).toBe(22);
    expect(live.items.every(item => item.issue.title === latest.title)).toBe(true);
    await expect(report.getByRole('article', { name: `${issue.key} 결정 후속 업무`, exact: true })).toHaveCount(2);
    await expect(report.getByRole('article').first()).toContainText(latest.title);
    expect(await meetingDocuments()).toEqual([document]);
  } finally {
    for (const document of await meetingDocuments()) await removeFixture(request, 'documents', document.id);
    for (const source of sourceDocuments) await removeFixture(request, 'documents', source.id);
    for (const item of issued) await removeFixture(request, 'issues', item.id);
  }
});
