import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Dialog, type Page } from '@playwright/test';
import { documentSectionHash } from '../../shared/document-sections';
import type { Comment, DocPage, Issue, RichContent, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function readJson<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

async function createDocument(request: APIRequestContext, projectId: string, title: string, content?: RichContent) {
  return readJson<DocPage>(await request.post('/api/documents', { data: { projectId, title, content } }), 201);
}

async function removeFixture(request: APIRequestContext, resource: 'issues' | 'documents', id: string) {
  const deleted = await request.delete(`/api/${resource}/${id}`);
  if (deleted.ok()) {
    const { trashEntryId } = await deleted.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

function route(page: Page) {
  const [path, query] = new URL(page.url()).hash.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

test('360px 공유 보드에서 연결 문서를 미리 보고 티켓 초안을 유지한다', async ({ page, context, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project, documentProject] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `연결 문서 미리보기 ${randomUUID().slice(0, 8)}`;
  const documents: DocPage[] = [];
  let savedView: SavedView | undefined;
  let issue: Issue | undefined;
  const confirmations: string[] = [];
  let acceptNavigation = false;
  const handleDialog = async (dialog: Dialog) => {
    confirmations.push(dialog.message());
    if (acceptNavigation) await dialog.accept();
    else await dialog.dismiss();
  };

  try {
    const subject = await readJson<Issue>(await request.post('/api/issues', { data: { projectId: project.id, title: `${prefix} 업무` } }), 201);
    issue = subject;
    const storedHeading = `${prefix} 결정`;
    const storedBody = `${prefix} 업무에 연결된 최신 저장 본문`;
    const linkedDocument = await createDocument(request, documentProject.id, `${prefix} 원문`, { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2, sectionId: `linked-${randomUUID()}` }, content: [{ type: 'text', text: storedHeading }] },
      { type: 'paragraph', content: [{ type: 'text', text: storedBody, marks: [{ type: 'bold' }] }] },
    ] });
    documents.push(linkedDocument);
    const unrelatedDocument = await createDocument(request, documentProject.id, `${prefix} 연결 없는 문서`);
    documents.push(unrelatedDocument);
    const link = await request.post('/api/resource-links', { data: { issueId: subject.id, documentId: linkedDocument.id, kind: 'related' } });
    expect(link.status(), await link.text()).toBe(201);
    const view = await readJson<SavedView>(await request.post('/api/views', { data: {
      projectId: project.id, name: `${prefix} 공유 보드`, layout: 'board', filters: { query: prefix, status: 'all', assigneeId: 'all', type: 'all' },
    } }), 201);
    savedView = view;

    const path = `#/${project.id}/issues`;
    const boardHash = `${path}?savedView=${view.id}`;
    const ticketQuery = { issue: subject.id, savedView: view.id };
    const previewQuery = { ...ticketQuery, documentPreview: linkedDocument.id };
    const previewHash = `${path}?${new URLSearchParams(previewQuery)}`;
    await page.goto(`/${boardHash}`);
    await page.locator(`.issue-board-card[data-issue-id="${subject.id}"]`).click();
    await expect.poll(() => route(page)).toEqual({ path, query: ticketQuery });

    const ticket = page.getByRole('dialog', { name: subject.title, exact: true });
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    const trigger = ticket.getByRole('button', { name: `${linkedDocument.title} 미리보기`, exact: true });
    const reader = page.getByRole('dialog', { name: '연결 문서 미리보기', exact: true });
    const close = reader.getByRole('button', { name: '문서 미리보기 닫기', exact: true });
    const fullDocument = reader.getByRole('button', { name: '문서 공간에서 열기', exact: true });
    const draftTitle = `${prefix} 저장 전 제목`;
    const draftComment = `${prefix} 보내기 전 댓글`;
    await title.fill(draftTitle);
    await comment.fill(draftComment);
    page.on('dialog', handleDialog);

    const openReader = async () => {
      await trigger.click();
      await expect(reader).toBeVisible();
      await expect.poll(() => route(page)).toEqual({ path, query: previewQuery });
      await expect(close).toBeFocused();
      await expect(reader.getByRole('heading', { name: storedHeading, exact: true })).toBeVisible();
      await expect(reader.locator('strong').filter({ hasText: storedBody })).toBeVisible();
    };
    const expectPreservedTicket = async () => {
      await expect(reader).toHaveCount(0);
      await expect.poll(() => route(page)).toEqual({ path, query: ticketQuery });
      await expect(trigger).toBeFocused();
      await expect(title).toHaveValue(draftTitle);
      await expect(comment).toHaveValue(draftComment);
    };

    await openReader();
    const bounds = await reader.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await expect(reader.locator('[contenteditable="true"]')).toHaveCount(0);
    await page.keyboard.press('Shift+Tab');
    await expect(fullDocument).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expectPreservedTicket();

    await openReader();
    await close.click();
    await expectPreservedTicket();

    await openReader();
    await page.goBack();
    await expectPreservedTicket();
    await page.goForward();
    await expect(reader).toContainText(storedBody);
    await expect.poll(() => route(page)).toEqual({ path, query: previewQuery });
    await close.click();
    await expectPreservedTicket();
    expect(confirmations).toEqual([]);

    const restored = await context.newPage();
    await restored.goto(`/${previewHash}`);
    const restoredReader = restored.getByRole('dialog', { name: '연결 문서 미리보기', exact: true });
    await expect(restoredReader).toContainText(storedBody);
    await restored.reload();
    await expect(restoredReader).toContainText(storedBody);
    await expect.poll(() => route(restored)).toEqual({ path, query: previewQuery });
    const restoredTicket = restored.getByRole('dialog', { name: subject.title, exact: true });
    await restoredReader.getByRole('button', { name: '문서 미리보기 닫기', exact: true }).click();
    await expect(restoredTicket.getByRole('button', { name: `${linkedDocument.title} 미리보기`, exact: true })).toBeFocused();
    await restored.goto(`/${path}?${new URLSearchParams({ ...ticketQuery, documentPreview: unrelatedDocument.id })}`);
    await expect(restoredTicket).toBeVisible();
    await expect(restoredReader).toHaveCount(0);
    await expect.poll(() => route(restored)).toEqual({ path, query: ticketQuery });
    await restored.close();

    await openReader();
    await fullDocument.click();
    await expect.poll(() => confirmations.length).toBe(1);
    expect(confirmations[0]).toContain('저장하지 않은 업무 변경사항');
    await expect(reader).toBeVisible();
    await expect.poll(() => route(page)).toEqual({ path, query: previewQuery });
    await close.click();
    await expectPreservedTicket();

    await openReader();
    acceptNavigation = true;
    await fullDocument.click();
    await expect.poll(() => confirmations.length).toBe(2);
    await expect(reader).toHaveCount(0);
    await expect(ticket).toHaveCount(0);
    await expect.poll(() => route(page)).toEqual({ path: `#/${documentProject.id}/documents/${linkedDocument.id}`, query: {} });
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(linkedDocument.title);
    const snapshot = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(snapshot.issues.find(item => item.id === subject.id)?.title).toBe(subject.title);
    const comments = await readJson<unknown[]>(await request.get(`/api/comments?resourceType=issue&resourceId=${subject.id}`));
    expect(comments).toEqual([]);
  } finally {
    page.off('dialog', handleDialog);
    if (savedView) await request.delete(`/api/views/${savedView.id}?expectedVersion=${savedView.version}`);
    if (issue) await removeFixture(request, 'issues', issue.id);
    for (const document of documents) await removeFixture(request, 'documents', document.id);
  }
});

test('문서의 절에서 티켓과 다른 연결 문서를 열어도 두 초안을 유지한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project, relatedProject] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `문서 절의 연결 문서 ${randomUUID().slice(0, 8)}`;
  const documents: DocPage[] = [];
  let issue: Issue | undefined;
  const confirmations: string[] = [];
  let acceptNavigation = false;
  const handleDialog = async (dialog: Dialog) => {
    confirmations.push(dialog.message());
    if (acceptNavigation) await dialog.accept();
    else await dialog.dismiss();
  };

  try {
    const subject = await readJson<Issue>(await request.post('/api/issues', { data: { projectId: relatedProject.id, title: `${prefix} 업무` } }), 201);
    issue = subject;
    const sectionId = `host-${randomUUID()}`;
    const sectionTitle = `${prefix} 원래 절`;
    const host = await createDocument(request, project.id, `${prefix} 원래 문서`, { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2, sectionId }, content: [{ type: 'text', text: sectionTitle }] },
      { type: 'paragraph', content: [{ type: 'text', text: '원래 문서의 저장 본문' }] },
    ] });
    documents.push(host);
    const linkedBody = `${prefix} 미리 볼 문서의 저장 본문`;
    const linked = await createDocument(request, relatedProject.id, `${prefix} 미리 볼 문서`, { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: linkedBody }] },
    ] });
    documents.push(linked);
    for (const doc of documents) {
      const link = await request.post('/api/resource-links', { data: { issueId: subject.id, documentId: doc.id, kind: 'related' } });
      expect(link.status(), await link.text()).toBe(201);
    }

    const hostHash = documentSectionHash(host.id, sectionId, project.id);
    const path = hostHash.split('?')[0];
    const ticketQuery = { section: sectionId, issue: subject.id };
    await page.goto(`/${hostHash}`);
    const hostTitle = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const hostDraft = `${prefix} 원래 문서 제목 초안`;
    const section = page.locator(`.docs-prose [data-document-section-id="${sectionId}"]`);
    await expect(section).toHaveText(sectionTitle);
    await hostTitle.fill(hostDraft);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const details = page.getByLabel('문서 상세 정보', { exact: true });
    await details.getByRole('button', { name: '연결', exact: true }).click();
    const linkedIssue = details.locator('.docs-linked-issue').filter({ hasText: subject.title });
    page.on('dialog', handleDialog);
    await linkedIssue.click();

    const ticket = page.getByRole('dialog', { name: subject.title, exact: true });
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    const trigger = ticket.getByRole('button', { name: `${linked.title} 미리보기`, exact: true });
    const draftTitle = `${prefix} 업무 제목 초안`;
    const draftComment = `${prefix} 업무 댓글 초안`;
    await title.fill(draftTitle);
    await comment.fill(draftComment);
    await trigger.click();
    const reader = page.getByRole('dialog', { name: '연결 문서 미리보기', exact: true });
    await expect(reader).toContainText(linkedBody);
    await expect.poll(() => route(page)).toEqual({ path, query: { ...ticketQuery, documentPreview: linked.id } });
    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect.poll(() => route(page)).toEqual({ path, query: ticketQuery });
    await expect(trigger).toBeFocused();
    await expect(title).toHaveValue(draftTitle);
    await expect(comment).toHaveValue(draftComment);
    expect(confirmations).toEqual([]);

    acceptNavigation = true;
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(ticket).toHaveCount(0);
    await expect.poll(() => route(page)).toEqual({ path, query: { section: sectionId } });
    await expect(hostTitle).toHaveValue(hostDraft);
    await expect(section).toHaveText(sectionTitle);
    await expect(linkedIssue).toBeFocused();
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toContain('저장하지 않은 업무 변경사항');
  } finally {
    page.off('dialog', handleDialog);
    if (issue) await removeFixture(request, 'issues', issue.id);
    for (const document of documents) await removeFixture(request, 'documents', document.id);
  }
});

test('문서 댓글 주소에서 연결 업무를 검토하고 보내지 않은 댓글로 돌아온다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project, relatedProject] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `댓글에서 업무 검토 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  const host = await createDocument(request, project.id, `${prefix} 문서`);

  try {
    for (const [index, issueProject] of [project, relatedProject].entries()) {
      const issue = await readJson<Issue>(await request.post('/api/issues', { data: {
        projectId: issueProject.id, title: `${prefix} 업무 ${index + 1}`, dueDate: `2027-06-0${index + 1}`,
      } }), 201);
      issues.push(issue);
      await readJson(await request.post('/api/resource-links', { data: { issueId: issue.id, documentId: host.id, kind: 'related' } }), 201);
    }
    const [first, second] = issues;
    const saved = await readJson<Comment>(await request.post('/api/comments', { data: {
      resourceType: 'document', resourceId: host.id, body: `${prefix} 저장된 논의`,
    } }), 201);
    const path = `#/${project.id}/documents/${host.id}`;
    const commentQuery = { comment: saved.id };
    await page.goto(`/${path}?${new URLSearchParams(commentQuery)}`);
    await expect(page.locator(`#document-comment-${saved.id}`)).toBeFocused();
    const details = page.getByLabel('문서 상세 정보', { exact: true });
    const draft = details.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    const draftText = `${prefix} 보내지 않은 문서 댓글`;
    await draft.fill(draftText);
    await details.getByRole('button', { name: '연결', exact: true }).click();
    const opener = details.locator('.docs-linked-issue').filter({ hasText: first.title });
    await opener.click();
    const firstTicket = page.getByRole('dialog', { name: first.title, exact: true });
    await expect.poll(() => route(page)).toEqual({ path, query: { ...commentQuery, issue: first.id } });
    await firstTicket.getByRole('button', { name: '다음 업무', exact: true }).click();
    const secondTicket = page.getByRole('dialog', { name: second.title, exact: true });
    await expect(secondTicket).toBeVisible();
    await expect.poll(() => route(page)).toEqual({ path, query: { ...commentQuery, issue: second.id } });
    await secondTicket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(opener).toBeFocused();
    await expect.poll(() => route(page)).toEqual({ path, query: commentQuery });
    await details.locator('.docs-detail-tabs').getByRole('button', { name: /^댓글/u }).click();
    await expect(draft).toHaveValue(draftText);
    const comments = await readJson<Comment[]>(await request.get(`/api/comments?resourceType=document&resourceId=${host.id}`));
    expect(comments.map(comment => comment.id)).toEqual([saved.id]);
  } finally {
    for (const issue of issues) await removeFixture(request, 'issues', issue.id);
    await removeFixture(request, 'documents', host.id);
  }
});
