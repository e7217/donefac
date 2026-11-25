import { randomUUID } from 'node:crypto';
import { expect, type APIResponse, type BrowserContext, type Page, type Response } from '@playwright/test';
import { isDocumentSectionId, parseDocumentHash } from '../../shared/document-sections';
import type { DocPage, DocumentPublicationView, LinkedDocumentCreationResult, WorkspaceSnapshot } from '../../shared/types';

interface NativeKnowledgeFixture {
  projectId: string;
  issueId: string;
  issueKey: string;
  authorId: string;
  reviewerId: string;
}

const timeout = 25_000;

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

function nextWrite(page: Page, method: string, pathname: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method, { timeout });
}

export async function verifyNativeKnowledge(writer: BrowserContext, reader: BrowserContext, origin: string, fixture: NativeKnowledgeFixture) {
  const { projectId, issueId, issueKey, authorId, reviewerId } = fixture;
  expect(writer).not.toBe(reader);
  expect(authorId).not.toBe(reviewerId);
  const workspace = await json<WorkspaceSnapshot>(await writer.request.get(new URL('/api/workspace', origin).href));
  const issue = workspace.issues.find(candidate => candidate.id === issueId);
  if (!issue) throw new Error(`Native knowledge ticket ${issueKey} is missing from the protected workspace.`);
  expect(issue).toMatchObject({ projectId, key: issueKey });

  const prefix = `/#/${encodeURIComponent(projectId)}`;
  const publishedTitle = `${issueKey} 설계 결정 기록`;
  const searchTerm = `nativecheck${randomUUID().slice(0, 8)}`;
  const sectionTitle = '현장 검증 결과';
  const publishedBody = `계측기 영점 검증을 마쳤습니다. ${searchTerm}`;
  const draftTitle = `${publishedTitle} 후속 초안`;
  const draftBody = '다음 점검에서는 예비 장비도 확인합니다.';
  const source = await writer.newPage();
  const peer = await reader.newPage();
  try {
    await source.goto(new URL(`${prefix}/issues?${new URLSearchParams({ issue: issueId })}`, origin).href, { waitUntil: 'domcontentloaded', timeout });
    await expect(source.getByLabel('작업자 선택', { exact: true })).toHaveValue(authorId, { timeout });
    const ticket = source.getByRole('dialog', { name: issue.title, exact: true });
    const linked = ticket.getByRole('region', { name: '연결된 문서', exact: true });
    await linked.getByRole('button', { name: '새 연결 문서 만들기', exact: true }).click({ timeout });
    const creator = source.getByRole('dialog', { name: '연결 문서 만들기', exact: true });
    await expect(creator.getByRole('combobox', { name: '공간', exact: true })).toHaveValue(projectId, { timeout });
    await creator.getByRole('textbox', { name: '문서 제목', exact: true }).fill(publishedTitle, { timeout });
    const created = nextWrite(source, 'POST', `/api/issues/${encodeURIComponent(issueId)}/documents`);
    await creator.getByRole('button', { name: '문서 만들기', exact: true }).click({ timeout });
    const { document, link } = await json<LinkedDocumentCreationResult>(await created, 201);
    const documentId = document.id;
    expect(document).toMatchObject({ projectId, title: publishedTitle, authorId });
    expect(link).toMatchObject({ issueId, documentId, kind: '관련 문서' });
    const route = `${prefix}/documents/${encodeURIComponent(documentId)}`;
    const publicationPath = `/api/documents/${encodeURIComponent(documentId)}/publication`;
    await linked.getByRole('button', { name: publishedTitle, exact: true }).click({ timeout });
    const editor = source.locator('.docs-prose');
    const title = source.getByRole('textbox', { name: '문서 제목', exact: true });
    const save = source.getByRole('button', { name: '저장', exact: true });
    const sourcePublication = source.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    await expect(title).toHaveValue(publishedTitle, { timeout });
    await editor.fill('작업 전 장비 연결 상태를 확인했습니다.', { timeout });
    await editor.press('End', { timeout });
    await editor.press('Enter', { timeout });
    await source.getByLabel('문단 서식', { exact: true }).selectOption('h2', { timeout });
    await source.keyboard.insertText(sectionTitle);
    await editor.press('Enter', { timeout });
    await source.keyboard.insertText(publishedBody);
    const heading = editor.getByRole('heading', { name: sectionTitle, level: 2, exact: true });
    await expect(heading).toBeVisible({ timeout });
    await expect(editor).toContainText(publishedBody, { timeout });
    await source.locator('summary').filter({ hasText: '문서 목차' }).click({ timeout });
    const outline = source.getByRole('navigation', { name: '문서 제목', exact: true });
    await outline.getByRole('button', { name: `절 링크 만들기 ${sectionTitle}`, exact: true }).click({ timeout });
    const sectionId = await heading.getAttribute('data-document-section-id', { timeout });
    if (!isDocumentSectionId(sectionId)) throw new Error('Native knowledge editor did not create a valid document section ID.');
    await save.click({ timeout });
    await expect(source.locator('.docs-save-state')).toHaveText('저장됨', { timeout });

    const search = new URLSearchParams({ q: searchTerm, type: 'document', space: `project:${projectId}` });
    await peer.goto(new URL(`${prefix}/search?${search}`, origin).href, { waitUntil: 'domcontentloaded', timeout });
    await expect(peer.getByLabel('작업자 선택', { exact: true })).toHaveValue(reviewerId, { timeout });
    const result = peer.getByRole('region', { name: '검색 결과', exact: true })
      .getByRole('button', { name: `${publishedTitle} 문서 열기` });
    await expect(result).toContainText(searchTerm, { timeout });
    await result.click({ timeout });
    const foundHeading = peer.locator('.docs-prose').getByRole('heading', { name: sectionTitle, level: 2, exact: true });
    await expect(foundHeading).toBeFocused({ timeout });
    await expect(foundHeading).toHaveAttribute('data-document-section-id', sectionId, { timeout });
    expect(parseDocumentHash(new URL(peer.url()).hash)).toEqual({ id: documentId, sectionId });
    await peer.getByRole('button', { name: '저장본 읽기', exact: true }).click({ timeout });
    const reading = peer.getByRole('article', { name: '저장본 읽기', exact: true });
    await expect(reading.getByRole('heading', { name: sectionTitle, level: 2, exact: true })).toBeVisible({ timeout });
    await expect(reading).toContainText(publishedBody, { timeout });

    await source.getByRole('button', { name: '검토·발행', exact: true }).click({ timeout });
    await sourcePublication.getByLabel('검토자', { exact: true }).selectOption(reviewerId, { timeout });
    const requested = nextWrite(source, 'POST', publicationPath);
    await sourcePublication.getByRole('button', { name: '검토 요청 보내기', exact: true }).click({ timeout });
    const submission = await json<DocumentPublicationView>(await requested);
    const revisionId = submission.reviewRevision?.id;
    if (!revisionId) throw new Error('Native knowledge review did not return a frozen revision.');
    expect(submission.review).toMatchObject({ revisionId, requestedById: authorId, reviewerId });
    expect(submission.reviewRevision).toMatchObject({ title: publishedTitle, version: submission.documentVersion });
    await sourcePublication.getByRole('button', { name: '검토·발행 닫기', exact: true }).click({ timeout });
    await title.fill(draftTitle, { timeout });
    await editor.fill(draftBody, { timeout });
    const saved = nextWrite(source, 'PATCH', `/api/documents/${encodeURIComponent(documentId)}`);
    await save.click({ timeout });
    const draft = await json<DocPage>(await saved);
    expect(draft).toMatchObject({ id: documentId, title: draftTitle });
    expect(draft.plainText).toContain(draftBody);
    expect(draft.plainText).not.toContain(publishedBody);

    await peer.goto(new URL(route, origin).href, { waitUntil: 'domcontentloaded', timeout });
    await peer.reload({ waitUntil: 'domcontentloaded', timeout });
    await expect(peer.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(draftTitle, { timeout });
    await peer.getByRole('button', { name: '검토·발행', exact: true }).click({ timeout });
    const peerPublication = peer.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    const publish = peerPublication.getByRole('button', { name: '검토본 발행', exact: true });
    await expect(publish).toBeDisabled({ timeout });
    await peerPublication.getByRole('button', { name: '검토본 불러오기', exact: true }).click({ timeout });
    const frozenReview = peerPublication.getByRole('region', { name: '검토 고정본 내용', exact: true });
    await expect(frozenReview).toContainText(publishedBody, { timeout });
    await expect(frozenReview).not.toContainText(draftBody, { timeout });
    const published = nextWrite(peer, 'POST', publicationPath);
    await publish.click({ timeout });
    const publication = await json<DocumentPublicationView>(await published);
    expect(publication.review).toBeNull();
    expect(publication.published).toMatchObject({ revisionId, publishedById: reviewerId, requestedById: authorId });

    const pin = new URLSearchParams({ publication: 'published', revision: revisionId });
    await source.goto(new URL(`${route}?${pin}`, origin).href, { waitUntil: 'domcontentloaded', timeout });
    const frozenPublication = sourcePublication.getByRole('region', { name: '발행 고정본 내용', exact: true });
    await expect(frozenPublication).toContainText(publishedTitle, { timeout });
    await expect(frozenPublication).toContainText(publishedBody, { timeout });
    await expect(frozenPublication).not.toContainText(draftBody, { timeout });
    await expect(frozenPublication.getByRole('heading', { name: sectionTitle, level: 2, exact: true }))
      .toHaveAttribute('data-document-section-id', sectionId, { timeout });
    return { projectId, issueId, linkId: link.id, documentId, revisionId, sectionId, authorId, reviewerId, publishedTitle, publishedBody, draftTitle, draftBody };
  } finally {
    await Promise.allSettled([source.close(), peer.close()]);
  }
}
