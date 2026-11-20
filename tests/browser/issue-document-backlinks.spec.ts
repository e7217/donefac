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
