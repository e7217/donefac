import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes';
import type { DocPage, Issue, RichContent, WorkspaceSnapshot } from '../../shared/types';

async function readJson<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

async function removeFixture(request: APIRequestContext, resource: 'issues' | 'documents', id: string) {
  const deleted = await request.delete(`/api/${resource}/${id}`);
  if (deleted.ok()) {
    const { trashEntryId } = await deleted.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

function paragraph(text: string): RichContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

test('360px 티켓에서 같은 제목의 문서를 공간과 상위 경로로 구분하고 응답을 잃어도 한 번만 연결한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const snapshot = () => request.get('/api/workspace').then(response => readJson<WorkspaceSnapshot>(response));
  const { projects: [issueProject, documentProject] } = await snapshot();
  const prefix = `제목이 같은 연결 문서 ${randomUUID().slice(0, 8)}`;
  const docs: DocPage[] = [];
  const issue = await readJson<Issue>(await request.post('/api/issues', { data: { projectId: issueProject.id, title: `${prefix} 검토 티켓` } }), 201);
  async function createDoc(projectId: string | null, title: string, parentId?: string) {
    const doc = await readJson<DocPage>(await request.post('/api/documents', { data: { projectId, title, parentId } }), 201);
    docs.push(doc);
    return doc;
  }

  try {
    const review = await createDoc(documentProject.id, '설계 검토 상위 문서');
    const operations = await createDoc(documentProject.id, '운영 안내 상위 문서');
    const wanted = await createDoc(documentProject.id, prefix, review.id);
    await createDoc(documentProject.id, prefix, operations.id);
    await createDoc(issueProject.id, prefix);
    await createDoc(null, prefix);

    await page.goto(`/#/${issueProject.id}/issues?issue=${issue.id}`);
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    const links = ticket.getByRole('region', { name: '연결된 문서', exact: true });
    const picker = links.getByRole('region', { name: '연결할 문서 선택', exact: true });
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    const draftTitle = `${prefix} 작성 중인 제목`;
    const draftComment = '연결하는 동안 보존할 댓글';
    await title.fill(draftTitle);
    await comment.fill(draftComment);
    const search = picker.getByRole('searchbox', { name: '연결할 문서 검색', exact: true });
    await search.fill(prefix);
    const results = picker.getByRole('list', { name: '문서 검색 결과', exact: true });
    const candidates = results.getByRole('button');
    await expect(candidates).toHaveCount(4);
    await expect(candidates.filter({ hasText: '팀 공통 문서' })).toHaveCount(1);
    const space = picker.getByRole('combobox', { name: '문서 공간', exact: true });
    await space.selectOption('common');
    await expect(candidates).toHaveCount(1);
    await space.selectOption(`project:${documentProject.id}`);
    await expect(candidates).toHaveCount(2);
    const chosen = candidates.filter({ hasText: review.title });
    await expect(chosen).toContainText(documentProject.name);
    await expect(candidates.filter({ hasText: operations.title })).toBeVisible();
    await chosen.press('Enter');
    await expect(chosen).toHaveAttribute('aria-pressed', 'true');
    const submit = picker.getByRole('button', { name: '문서 연결', exact: true });

    const attempts: { issueId: string; documentId: string }[] = [];
    await page.route('**/api/resource-links', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      expect((await route.fetch()).status()).toBe(201);
      await route.abort('failed');
    });
    await submit.click();
    await expect.poll(async () => (await snapshot()).resourceLinks.filter(link => link.issueId === issue.id)).toEqual([
      expect.objectContaining({ issueId: issue.id, documentId: wanted.id }),
    ]);
    await expect(submit).toBeEnabled();
    await expect(chosen).toHaveAttribute('aria-pressed', 'true');
    const replay = page.waitForResponse(response => response.url().endsWith('/api/resource-links') && response.request().method() === 'POST');
    await submit.click();
    expect((await replay).status()).toBe(200);
    await expect(links.getByRole('button', { name: wanted.title, exact: true })).toHaveCount(1);
    await expect(chosen).toHaveCount(0);
    await expect(title).toHaveValue(draftTitle);
    await expect(comment).toHaveValue(draftComment);
    const after = await snapshot();
    expect(after.issues.find(value => value.id === issue.id)).toEqual(issue);
    expect(after.resourceLinks.filter(link => link.issueId === issue.id)).toEqual([expect.objectContaining({ documentId: wanted.id })]);
    expect(after.activities.filter(item => item.resourceId === issue.id && item.action === '문서 연결')).toHaveLength(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ issueId: issue.id, documentId: wanted.id });
    expect(attempts[1]).toEqual(attempts[0]);
  } finally {
    await removeFixture(request, 'issues', issue.id);
    for (const document of docs.reverse()) await removeFixture(request, 'documents', document.id);
  }
});

test('360px 문서에서 다른 프로젝트의 업무를 페이지와 정확한 업무 번호로 찾아 초안을 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const snapshot = () => request.get('/api/workspace').then(response => readJson<WorkspaceSnapshot>(response));
  const { projects: [documentProject, issueProject] } = await snapshot();
  const prefix = `검색할 여러 업무 ${randomUUID().slice(0, 8)}`;
  const document = await readJson<DocPage>(await request.post('/api/documents', {
    data: { projectId: documentProject.id, title: `${prefix}의 결정`, content: { type: 'doc', content: [paragraph('서버에 저장한 문서 본문')] } },
  }), 201);
  const issues: Issue[] = [];
  try {
    for (let index = 0; index < 9; index++) {
      issues.push(await readJson<Issue>(await request.post('/api/issues', {
        data: { projectId: index === 0 ? documentProject.id : issueProject.id, title: `${prefix} ${index}` },
      }), 201));
    }
    const expected = issues[8];
    await page.goto(`/#/${documentProject.id}/documents/${document.id}`);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(title).toHaveValue(document.title);
    const draftTitle = `${prefix} 저장하지 않은 제목`;
    await title.fill(draftTitle);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const aside = page.getByLabel('문서 상세 정보', { exact: true });
    await aside.getByRole('button', { name: '연결', exact: true }).click();
    const picker = aside.getByRole('region', { name: '연결할 업무 선택', exact: true });
    const search = picker.getByRole('searchbox', { name: '연결할 업무 검색', exact: true });
    await search.fill(prefix);
    await picker.getByRole('combobox', { name: '업무 프로젝트', exact: true }).selectOption(`project:${issueProject.id}`);
    const results = picker.getByRole('list', { name: '업무 검색 결과', exact: true });
    await expect(results.getByRole('button')).toHaveCount(5);
    await expect(results.getByText(issues[0].key, { exact: true })).toHaveCount(0);
    const next = picker.getByRole('button', { name: '업무 다음 페이지', exact: true });
    await next.click();
    await expect(results.getByRole('button')).toHaveCount(3);
    await expect(results.getByText(expected.key, { exact: true })).toBeVisible();
    await search.fill(expected.key.toLowerCase());
    const target = results.getByRole('button').filter({ hasText: expected.key });
    await expect(target).toHaveCount(1);
    await expect(target).toContainText(issueProject.name);
    await target.click();
    await expect(target).toHaveAttribute('aria-pressed', 'true');
    await picker.getByRole('button', { name: '업무 연결', exact: true }).click();
    await expect(aside.locator('.docs-linked-issue').filter({ hasText: expected.key })).toHaveCount(1);
    await expect(target).toHaveCount(0);
    await expect(title).toHaveValue(draftTitle);
    const saved = await snapshot();
    expect(saved.documents.find(value => value.id === document.id)).toEqual(document);
    expect(saved.resourceLinks.filter(link => link.documentId === document.id)).toEqual([
      expect.objectContaining({ issueId: expected.id, documentId: document.id }),
    ]);
  } finally {
    for (const issue of issues) await removeFixture(request, 'issues', issue.id);
    await removeFixture(request, 'documents', document.id);
  }
});

test('360px 티켓에서 본문 참조 문서를 찾아 미리 보고 참조 삭제를 반영한다', async ({ page, context, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [issueProject, documentProject] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `업무 본문 참조 ${randomUUID().slice(0, 8)}`;
  const documents: DocPage[] = [];
  let issue: Issue | undefined;
  async function createDocument(suffix: string, ...content: RichContent[]) {
    const document = await readJson<DocPage>(await request.post('/api/documents', {
      data: { projectId: documentProject.id, title: `${prefix} ${suffix}`, content: { type: 'doc', content } },
    }), 201);
    documents.push(document);
    return document;
  }

  try {
    const subject = await readJson<Issue>(await request.post('/api/issues', {
      data: { projectId: issueProject.id, title: `${prefix} 티켓` },
    }), 201);
    issue = subject;
    const savedBody = `${prefix} 다른 프로젝트의 저장 본문`;
    const issueReference: RichContent = { type: 'issueReference', attrs: { issueId: subject.id, label: subject.title } };
    const linked = await createDocument('별도 연결 문서', issueReference);
    const source = await createDocument('본문 참조 문서',
      paragraph(savedBody), issueReference,
      { type: 'documentInclude', attrs: { documentId: linked.id, label: linked.title } },
      { type: 'details', content: [
        { type: 'detailsSummary', content: [{ type: 'text', text: '접기 영역 안의 참조' }] },
        { type: 'detailsContent', content: [issueReference] },
      ] },
    );
    const containing = await createDocument('본문 참조 문서를 포함한 문서', {
      type: 'documentInclude', attrs: { documentId: source.id, label: source.title },
    });
    const link = await request.post('/api/resource-links', {
      data: { issueId: subject.id, documentId: linked.id, kind: 'related' },
    });
    expect(link.status(), await link.text()).toBe(201);

    const ticketHref = `/#/${issueProject.id}/issues?issue=${subject.id}`;
    const previewHref = `${ticketHref}&documentPreview=${source.id}`;
    await page.goto(ticketHref);
    const ticket = page.getByRole('dialog', { name: subject.title, exact: true });
    const references = ticket.getByRole('region', { name: '본문에서 이 업무를 참조한 문서', exact: true });
    const titleAction = references.getByRole('button', { name: source.title, exact: true });
    const previewAction = references.getByRole('button', { name: `${source.title} 미리보기`, exact: true });
    await expect(titleAction).toBeVisible();
    await expect(references.getByText('본문 참조 2곳', { exact: true })).toBeVisible();
    await expect(references.getByRole('button', { name: containing.title, exact: true })).toHaveCount(0);
    await expect(references.getByRole('button', { name: linked.title, exact: true })).toHaveCount(0);
    await expect(ticket.getByRole('button', { name: linked.title, exact: true })).toHaveCount(1);
    await expect(ticket.getByRole('button', { name: `${linked.title} 미리보기`, exact: true })).toHaveCount(1);
    await expect(ticket.getByRole('region', { name: '연결된 문서', exact: true }).getByText('본문 참조 1곳', { exact: true })).toBeVisible();

    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    const draftTitle = `${prefix} 저장 전 제목`;
    const draftComment = `${prefix} 보내기 전 댓글`;
    await title.fill(draftTitle);
    await comment.fill(draftComment);
    const confirmations: string[] = [];
    page.on('dialog', async dialog => {
      confirmations.push(dialog.message());
      await dialog.dismiss();
    });

    const reader = page.getByRole('dialog', { name: '연결 문서 미리보기', exact: true });
    async function openReader() {
      await previewAction.click();
      await expect(page).toHaveURL(previewHref);
      await expect(reader.getByRole('heading', { name: source.title, exact: true })).toBeVisible();
      await expect(reader.getByText(savedBody, { exact: true })).toBeVisible();
    }
    async function expectDrafts() {
      await expect(page).toHaveURL(ticketHref);
      await expect(reader).toHaveCount(0);
      await expect(previewAction).toBeFocused();
      await expect(title).toHaveValue(draftTitle);
      await expect(comment).toHaveValue(draftComment);
    }

    await openReader();
    await page.goBack();
    await expectDrafts();
    await openReader();
    const referencesInReader = reader.getByRole('button', { name: `참조 업무 열기 ${subject.key} ${subject.title}`, exact: true, includeHidden: true });
    await expect(referencesInReader).toHaveCount(3);
    const nestedReference = referencesInReader.last();
    await reader.getByText('접기 영역 안의 참조', { exact: true }).click();
    await expect(nestedReference).toBeHidden();
    const jump = reader.getByRole('button', { name: '본문 참조로 이동', exact: true });
    await jump.click();
    await expect(jump).toBeFocused();
    await expect(referencesInReader.first()).toHaveAttribute('aria-current', 'location');
    await jump.click();
    await expect(nestedReference).toHaveAttribute('aria-current', 'location');
    await expect(nestedReference).toBeVisible();
    await nestedReference.click();
    await expectDrafts();
    await openReader();
    await reader.getByRole('button', { name: '문서 미리보기 닫기', exact: true }).click();
    await expectDrafts();
    expect(confirmations).toEqual([]);

    const stored = await context.newPage();
    await stored.setViewportSize({ width: 360, height: 820 });
    await stored.goto(previewHref);
    const storedReader = stored.getByRole('dialog', { name: '연결 문서 미리보기', exact: true });
    await expect(storedReader.getByText(savedBody, { exact: true })).toBeVisible();
    await stored.reload();
    await expect(storedReader.getByText(savedBody, { exact: true })).toBeVisible();
    await expect(stored).toHaveURL(previewHref);
    await storedReader.getByRole('button', { name: '문서 미리보기 닫기', exact: true }).click();
    const storedTicket = stored.getByRole('dialog', { name: subject.title, exact: true });
    await storedTicket.getByRole('button', { name: source.title, exact: true }).click();
    await expect(stored.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(source.title);

    await readJson<DocPage>(await request.patch(`/api/documents/${source.id}`, {
      data: {
        expectedVersion: source.version,
        contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
        content: { type: 'doc', content: [paragraph(`${prefix} 업무 참조가 삭제된 본문`)] },
      },
    }));
    await stored.goto(previewHref);
    await stored.reload();
    await expect(stored).toHaveURL(ticketHref);
    await expect(storedReader).toHaveCount(0);
    await expect(storedTicket.getByRole('button', { name: source.title, exact: true })).toHaveCount(0);
    await expect(storedTicket.getByRole('button', { name: `${source.title} 미리보기`, exact: true })).toHaveCount(0);
    await expect(storedTicket.getByRole('button', { name: linked.title, exact: true })).toHaveCount(1);
    await stored.close();
  } finally {
    if (issue) await removeFixture(request, 'issues', issue.id);
    for (const document of documents.reverse()) await removeFixture(request, 'documents', document.id);
  }
});
