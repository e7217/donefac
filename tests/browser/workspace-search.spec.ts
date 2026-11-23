import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { DocPage, GitlabLink, Issue, ProjectIssueSchema, ProjectWorkflow, RichContent, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, expected = 200): Promise<T> {
  const data = await response.text();
  expect(response.status(), data).toBe(expected);
  return JSON.parse(data) as T;
}

const paragraph = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function route(page: Page) {
  const [path, query] = new URL(page.url()).hash.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

function search(page: Page) {
  const form = page.getByRole('form', { name: '업무·문서 검색 조건', exact: true });
  const results = page.getByRole('region', { name: '검색 결과', exact: true });
  return {
    results, rows: results.getByRole('listitem'),
    term: form.getByRole('searchbox', { name: '검색어', exact: true }),
    kind: form.getByRole('combobox', { name: '검색 대상', exact: true }),
    scope: form.getByRole('combobox', { name: '검색 공간', exact: true }),
    label: form.getByRole('combobox', { name: '문서 라벨', exact: true }),
    submit: form.getByRole('button', { name: '검색', exact: true }),
    issue: (issue: Issue) => results.getByRole('button', { name: `${issue.key} 업무 열기`, exact: true }),
    document: (document: DocPage) => results.getByRole('button', { name: `${document.title} 문서 열기` }),
    next: page.getByRole('button', { name: '검색 결과 다음 페이지', exact: true }),
    previous: page.getByRole('button', { name: '검색 결과 이전 페이지', exact: true }),
  };
}

async function fixture(request: APIRequestContext) {
  const snapshot = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [first, second] } = await snapshot();
  const token = randomUUID().slice(0, 8);
  const documents = new Set<DocPage>();
  const issues = new Set<Issue>();
  async function purge(kind: 'documents' | 'issues', id: string) {
    const removed = await request.delete(`/api/${kind}/${id}`);
    if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
  }
  return {
    first, second, token, snapshot,
    async document(projectId: string | null, title: string, fields: Partial<Pick<DocPage, 'parentId' | 'labels' | 'content'>> = {}) {
      const row = await json<DocPage>(await request.post('/api/documents', { data: { projectId, title, ...fields } }), 201);
      documents.add(row);
      return row;
    },
    async issue(projectId: string, title: string, fields: Partial<Pick<Issue, 'status' | 'description' | 'customFields'>> = {}) {
      const row = await json<Issue>(await request.post('/api/issues', { data: { projectId, title, ...fields } }), 201);
      issues.add(row);
      return row;
    },
    async trash(kind: 'documents' | 'issues', row: DocPage | Issue) {
      const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(`/api/${kind}/${row.id}`));
      if (kind === 'documents') documents.delete(row as DocPage);
      else issues.delete(row as Issue);
      return trashEntryId;
    },
    async close() {
      for (const issue of issues) await purge('issues', issue.id);
      for (const document of [...documents].reverse()) await purge('documents', document.id);
    },
  };
}

test('360px 검색에서 업무·공통 문서를 함께 찾고 검색 페이지와 공간·라벨 조건을 복원한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const f = await fixture(request);
  const term = `통합검색-${f.token}`;
  const label = `공유 검토 ${f.token}`;
  const trash: string[] = [];
  try {
    const parent = await f.document(f.second.id, `정리 상위 문서 ${f.token}`);
    const sameDocument = await f.document(f.second.id, term, { labels: [label], parentId: parent.id });
    const sameIssue = await f.issue(f.first.id, term);
    for (let index = 0; index < 20; index++) {
      await f.document(index % 2 ? f.first.id : f.second.id, `${term} 문서 ${index + 1}`);
    }
    const common = await f.document(null, `팀 공통 점검 기록 ${f.token}`, {
      content: paragraph(`안내 본문에서만 ${term} 검색어와 현장 측정 기록을 찾습니다.`), labels: [label],
    });
    const foreign = await f.issue(f.second.id, `외부 프로젝트 보정 업무 ${f.token}`, { description: `설명 본문의 ${term} 연결을 확인합니다.` });
    trash.push(await f.trash('documents', await f.document(f.first.id, `${term} 삭제 문서`)));
    trash.push(await f.trash('issues', await f.issue(f.second.id, `${term} 삭제 업무`)));

    await page.setViewportSize({ width: 360, height: 820 });
    const path = `#/${f.first.id}/search`;
    await page.goto(`/${path}?${new URLSearchParams({ q: term })}`);
    const result = search(page);
    await expect(page.getByRole('heading', { name: '검색 결과', exact: true })).toBeVisible();
    await expect(result.term).toHaveValue(term);
    await expect(result.results).toContainText('검색 결과 24건');
    await expect(result.rows).toHaveCount(20);
    await expect(result.rows.nth(0)).toContainText(sameIssue.key);
    await expect(result.rows.nth(1)).toContainText(parent.title);
    await expect(result.rows.nth(1)).toContainText(f.second.name);
    await expect(result.previous).toBeDisabled();
    await expect(result.results).not.toContainText('삭제 업무');
    await expect(result.results).not.toContainText('삭제 문서');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await result.next.click();
    const secondPage = { path, query: { q: term, page: '2' } };
    await expect.poll(() => route(page)).toEqual(secondPage);
    await expect(result.rows).toHaveCount(4);
    await expect(result.next).toBeDisabled();
    await page.goBack();
    await expect.poll(() => route(page)).toEqual({ path, query: { q: term } });
    await expect(result.rows).toHaveCount(20);
    await page.goForward();
    await expect.poll(() => route(page)).toEqual(secondPage);
    await expect(result.rows).toHaveCount(4);

    await result.issue(foreign).click();
    const drawer = page.getByRole('dialog', { name: foreign.title, exact: true });
    await expect(drawer).toBeVisible();
    await expect.poll(() => route(page)).toEqual({ ...secondPage, query: { ...secondPage.query, issue: foreign.id } });
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect.poll(() => route(page)).toEqual(secondPage);
    await expect(result.rows).toHaveCount(4);
    const commonRow = result.rows.filter({ hasText: common.title });
    await expect(commonRow).toContainText('팀 공통');
    await expect(commonRow).toContainText('현장 측정 기록');
    await result.document(common).click();
    await expect.poll(() => route(page)).toEqual({ path: `#/${f.first.id}/documents/${common.id}`, query: {} });
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(common.title);
    await page.goBack();
    await expect.poll(() => route(page)).toEqual(secondPage);
    await expect(result.document(common)).toBeVisible();

    await result.kind.selectOption('document');
    await result.scope.selectOption(`project:${f.second.id}`);
    await result.label.selectOption(label);
    await result.submit.click();
    await expect.poll(() => route(page)).toEqual({ path, query: { q: term, type: 'document', space: `project:${f.second.id}`, label } });
    await expect(result.results).toContainText('검색 결과 1건');
    await expect(result.rows).toHaveCount(1);
    await expect(result.document(sameDocument)).toBeVisible();
    await expect(result.document(common)).toHaveCount(0);

    await result.scope.selectOption('common');
    await result.submit.click();
    await expect.poll(() => route(page)).toEqual({ path, query: { q: term, type: 'document', space: 'common', label } });
    await expect(result.rows).toHaveCount(1);
    await expect(result.document(common)).toBeVisible();
    await expect(result.document(sameDocument)).toHaveCount(0);
    await page.reload();
    await expect(result.document(common)).toBeVisible();
    await expect(result.scope).toHaveValue('common');
    await expect(result.label).toHaveValue(label);
  } finally {
    for (const id of trash) await request.delete(`/api/trash/${id}`);
    await f.close();
  }
});

test('GitLab MR 주소로 빠른 검색에서 통합 검색까지 연결 업무를 찾고 안전한 검색 주소를 공유한다', async ({ page, request }) => {
  const f = await fixture(request);
  try {
    const first = await f.issue(f.first.id, `검토할 문서 변경 ${f.token}`);
    const second = await f.issue(f.second.id, `운영 적용 확인 ${f.token}`);
    const decoy = await f.issue(f.first.id, `다른 저장소의 변경 ${f.token}`);
    const host = 'gitlab.search.invalid';
    const nestedRepository = `${'division/'.repeat(24)}group/product-${f.token}`;
    const canonical = `https://${host}/scm/${nestedRepository}/-/merge_requests/91`;
    expect(canonical.length).toBeGreaterThan(200);
    const pasted = new URL(canonical);
    pasted.username = 'synthetic-reviewer';
    pasted.password = 'synthetic-user-secret';
    pasted.searchParams.set('token', 'synthetic-query-secret');
    pasted.hash = 'note_244';
    const links: GitlabLink[] = [first, second, decoy].map(({ id }, index) => ({
      id: `synthetic-${id}`, issueId: id, projectId: index === 2 ? 4 : 5, iid: 91, kind: 'merge_request',
      title: '합성 문서 변경 검토', webUrl: index === 2 ? `https://${host}/scm/group/elsewhere/-/merge_requests/91` : canonical,
      state: 'opened', updatedAt: '2026-11-21T00:00:00.000Z',
    }));
    const external: string[] = [];
    await page.route(`https://${host}/**`, async route => { external.push(route.request().url()); await route.abort(); });
    await page.route('**/api/workspace', async route => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const snapshot = await response.json() as WorkspaceSnapshot;
      await route.fulfill({ response, json: { ...snapshot, gitlabLinks: [...snapshot.gitlabLinks, ...links] } });
    });
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${f.first.id}/overview`);
    await page.getByRole('button', { name: '통합 검색', exact: true }).click();
    const quick = page.getByRole('dialog', { name: '통합 검색', exact: true });
    const term = quick.getByRole('textbox', { name: '통합 검색어', exact: true });
    await term.fill(pasted.href);
    await expect(quick.getByText(first.title, { exact: true })).toBeVisible();
    await expect(quick.getByText(second.title, { exact: true })).toBeVisible();
    await expect(quick.getByText(decoy.title, { exact: true })).toHaveCount(0);
    await expect(quick.getByText(/^GitLab MR /u)).toHaveCount(2);
    await quick.getByRole('button', { name: '전체 검색 결과', exact: true }).click();

    const result = search(page);
    const path = `#/${f.first.id}/search`;
    await expect.poll(() => route(page)).toEqual({ path, query: { q: canonical } });
    await expect(result.term).toHaveValue(canonical);
    await expect(result.rows).toHaveCount(2);
    await expect(result.issue(second)).toBeVisible();
    await expect(result.results.getByText(/^GitLab MR /u)).toHaveCount(2);
    await expect(result.results).not.toContainText(/synthetic-user-secret|synthetic-query-secret|note_244/u);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    const scope = `project:${f.second.id}`;
    await result.scope.selectOption(scope);
    await result.submit.click();
    await expect.poll(() => route(page)).toEqual({ path, query: { q: canonical, space: scope } });
    await expect(result.rows).toHaveCount(1);
    await expect(result.issue(first)).toHaveCount(0);
    await page.reload();
    await expect(result.term).toHaveValue(canonical);
    await expect(result.scope).toHaveValue(scope);
    await result.issue(second).click();
    await expect(page.getByRole('dialog', { name: second.title, exact: true })).toBeVisible();

    await page.goto(`/${path}?${new URLSearchParams({ q: pasted.href, space: scope })}`);
    await expect.poll(() => route(page)).toEqual({ path, query: { q: canonical, space: scope } });
    await expect(result.issue(second)).toBeVisible();
    expect(external).toEqual([]);
  } finally {
    await f.close();
  }
});

test('360px에서 Confluence 원본 주소를 검색하고 현재 문서와 공유 필터를 다시 연다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  let trashId: string | undefined;
  try {
    const first = await f.document(f.first.id, `이관 검토 기록 ${f.token}`);
    const second = await f.document(f.second.id, `배포 운영 기록 ${f.token}`);
    const wrongContext = await f.document(f.first.id, `별도 설치의 기록 ${f.token}`);
    const wrongOrigin = await f.document(f.first.id, `별도 원본의 기록 ${f.token}`);
    const origin = `https://wiki-${f.token}.search.invalid`;
    const pageId = '90071992547409931234';
    const classic = `${origin}/wiki/pages/viewpage.action?pageId=${pageId}`;
    const modern = `${origin}/wiki/spaces/TEAM/pages/${pageId}`;
    const titleAlias = `${origin}/wiki/display/TEAM/Original+Name`;
    const otherContext = `${origin}/another-wiki/pages/viewpage.action?pageId=${pageId}`;
    const bodyOnly = await f.document(f.first.id, `본문에만 주소가 있는 문서 ${f.token}`, { content: paragraph(classic) });
    async function saveLink(document: DocPage, url: string) {
      const saved = await json<{ url: string }>(await request.post('/api/atlassian-links', { data: {
        targetType: 'document', targetId: document.id, product: 'confluence', url,
      } }), 201);
      expect(saved.url).toBe(url);
    }
    await saveLink(first, classic);
    await saveLink(first, modern);
    await saveLink(first, titleAlias);
    await saveLink(second, modern);
    await saveLink(wrongContext, otherContext);
    await saveLink(wrongOrigin, classic.replace('wiki-', 'other-'));

    const outbound: string[] = [];
    await page.route(url => url.hostname.endsWith('.search.invalid'), async route => {
      outbound.push(route.request().url()); await route.abort();
    });
    await page.route('**/api/atlassian-links/*/preview', async route => {
      outbound.push(route.request().url()); await route.abort();
    });
    const lookupInputs: string[] = [];
    let slowStarted = false, slowFinished = false;
    let releaseSlow!: () => void;
    const slowRelease = new Promise<void>(resolve => { releaseSlow = resolve; });
    await page.route(url => url.pathname === '/api/atlassian-links/resolve', async route => {
      const input = new URL(route.request().url()).searchParams.get('url') ?? '';
      lookupInputs.push(input);
      if (input !== otherContext) return route.continue();
      slowStarted = true;
      await slowRelease;
      // A correct client may cancel the previous lookup when a new address is entered.
      try { await route.fulfill({ response: await route.fetch() }); }
      catch { /* The previous navigation may have canceled this request. */ }
      finally { slowFinished = true; }
    });
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${f.first.id}/overview`);
    await page.getByRole('button', { name: '통합 검색', exact: true }).click();
    const quick = page.getByRole('dialog', { name: '통합 검색', exact: true });
    const term = quick.getByRole('textbox', { name: '통합 검색어', exact: true });
    try {
      await term.fill(otherContext);
      await expect.poll(() => slowStarted).toBe(true);
      await term.fill(`${classic}&token=synthetic-wiki-secret#private-section`);
      await expect(quick.getByText(first.title, { exact: true })).toBeVisible();
      await expect(quick.getByText(second.title, { exact: true })).toBeVisible();
    } finally {
      releaseSlow();
    }
    await expect.poll(() => slowFinished).toBe(true);
    await expect(quick.getByText(first.title, { exact: true })).toHaveCount(1);
    await expect(quick.getByText(wrongContext.title, { exact: true })).toHaveCount(0);
    await expect(quick.getByText(wrongOrigin.title, { exact: true })).toHaveCount(0);
    await expect(quick.getByText(bodyOnly.title, { exact: true })).toHaveCount(0);
    await expect(quick.getByText('Confluence 원본 주소', { exact: true })).toHaveCount(2);
    await quick.getByRole('button', { name: '전체 검색 결과', exact: true }).click();

    const result = search(page);
    const path = `#/${f.first.id}/search`;
    await expect.poll(() => route(page)).toEqual({ path, query: { q: classic } });
    await expect(result.term).toHaveValue(classic);
    await expect(result.rows).toHaveCount(2);
    await expect(result.results.getByText('Confluence 원본 주소', { exact: true })).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    const scope = `project:${f.second.id}`;
    await result.scope.selectOption(scope);
    await result.submit.click();
    await expect.poll(() => route(page)).toEqual({ path, query: { q: classic, space: scope } });
    await expect(result.rows).toHaveCount(1);
    await expect(result.document(second)).toBeVisible();
    await page.reload();
    await expect(result.term).toHaveValue(classic);
    await expect(result.scope).toHaveValue(scope);
    await result.document(second).click();
    await expect.poll(() => route(page)).toEqual({ path: `#/${f.second.id}/documents/${second.id}`, query: {} });
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(second.title);
    await page.goBack();
    await expect(result.document(second)).toBeVisible();

    const deleted = await json<{ trashEntryId: string }>(await request.delete(`/api/documents/${second.id}`));
    trashId = deleted.trashEntryId;
    await page.reload();
    await expect(result.results).toContainText('검색 결과 0건');
    const restored = await request.post(`/api/trash/${trashId}/restore`);
    expect(restored.ok(), await restored.text()).toBe(true);
    trashId = undefined;
    await page.reload();
    await expect(result.document(second)).toBeVisible();

    await page.goto(`/${path}?${new URLSearchParams({ q: titleAlias })}`);
    await expect(result.rows).toHaveCount(1);
    await expect(result.document(first)).toBeVisible();
    await page.goto(`/${path}?${new URLSearchParams({ q: classic.replace('/wiki/', '/wrong-mount/') })}`);
    await expect(result.results).toContainText('검색 결과 0건');
    expect(lookupInputs).toContain(classic);
    expect(lookupInputs.join('\n')).not.toMatch(/synthetic-wiki-secret|private-section/u);
    expect(outbound).toEqual([]);
  } finally {
    if (trashId) await request.delete(`/api/trash/${trashId}`);
    await f.close();
  }
});

test('작성 중인 문서에서 통합 검색 이동을 제어하고 업무 키·상태·사용자 필드로 찾는다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const f = await fixture(request);
  const schemaPath = `/api/projects/${f.second.id}/issue-schema`;
  const workflowPath = `/api/projects/${f.second.id}/workflow`;
  const schema = await json<ProjectIssueSchema>(await request.get(schemaPath));
  const workflow = await json<ProjectWorkflow>(await request.get(workflowPath));
  let savedSchema: ProjectIssueSchema | undefined;
  let savedWorkflow: ProjectWorkflow | undefined;
  try {
    const id = `search_trace_${f.token}`;
    const status = { id: `search_review_${f.token}`, label: `현장 확인 대기 ${f.token}`, color: '#527299', category: 'review' };
    const marker = `교정 수치 증거 ${f.token}`;
    savedSchema = await json<ProjectIssueSchema>(await request.patch(schemaPath, { data: { ...schema, expectedVersion: schema.version,
      fields: [...schema.fields, { id, name: '검색용 교정 근거', description: '', kind: 'text', required: false, issueTypes: [], options: [], archived: false }],
    } }));
    savedWorkflow = await json<ProjectWorkflow>(await request.patch(workflowPath, { data: { ...workflow, expectedVersion: workflow.version,
      statuses: [...workflow.statuses, status],
    } }));
    const target = await f.issue(f.second.id, `팀 간 출발 업무 ${f.token}`, { status: status.id, customFields: { [id]: marker } });
    const sameTitle = await f.document(null, target.key);
    const editing = await f.document(f.first.id, `현재 편집 중 문서 ${f.token}`, { content: paragraph('보존할 원래 문서 본문') });
    const documentPath = `#/${f.first.id}/documents/${editing.id}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${documentPath}`);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(title).toHaveValue(editing.title);
    const changed = `${editing.title} 초안`;
    await title.fill(changed);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    await title.press('Control+k');
    const quick = page.getByRole('dialog', { name: '통합 검색', exact: true });
    const all = quick.getByRole('button', { name: '전체 검색 결과', exact: true });
    await expect(quick).toBeVisible();
    await quick.getByRole('textbox', { name: '통합 검색어', exact: true }).fill(target.key);
    const cancelled = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.message()).toMatch(/저장하지 않은|편집/);
      await dialog.dismiss();
    });
    await all.click();
    await cancelled;
    await expect.poll(() => route(page)).toEqual({ path: documentPath, query: {} });
    await expect(title).toHaveValue(changed);
    await expect(quick).toBeVisible();
    const accepted = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await all.click();
    await accepted;

    const result = search(page);
    const path = `#/${f.first.id}/search`;
    await expect.poll(() => route(page)).toEqual({ path, query: { q: target.key } });
    await expect(quick).toHaveCount(0);
    await expect(result.rows.first()).toContainText(target.title);
    await expect(result.document(sameTitle)).toBeVisible();
    expect((await f.snapshot()).documents.find(document => document.id === editing.id)?.title).toBe(editing.title);

    await result.term.fill(status.label);
    await result.kind.selectOption('issue');
    await result.scope.selectOption(`project:${f.second.id}`);
    await result.submit.click();
    await expect.poll(() => route(page)).toEqual({ path, query: { q: status.label, type: 'issue', space: `project:${f.second.id}` } });
    await expect(result.rows).toHaveCount(1);
    await expect(result.issue(target)).toBeVisible();
    await expect(result.results).toContainText(status.label);
    await result.term.fill(marker);
    await result.submit.click();
    await expect.poll(() => route(page)).toEqual({ path, query: { q: marker, type: 'issue', space: `project:${f.second.id}` } });
    await expect(result.rows).toHaveCount(1);
    await expect(result.issue(target)).toBeVisible();
  } finally {
    try { await f.close(); }
    finally {
      if (savedWorkflow) await json<ProjectWorkflow>(await request.patch(workflowPath, { data: { ...workflow, expectedVersion: savedWorkflow.version } }));
      if (savedSchema) await json<ProjectIssueSchema>(await request.patch(schemaPath, { data: { ...schema, expectedVersion: savedSchema.version } }));
    }
  }
});
