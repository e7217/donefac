import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AttachmentHead, DocPage, DocRevision, DocumentPublicationView, RichContent, WorkspaceSnapshot } from '../../shared/types';

const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });

test('360px에서 예전 문서 버전을 삽입하고 원본 변경과 휴지통 이동 뒤에도 발행본에서 읽는다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, reviewer] = workspace.users;
  const { id: projectId } = workspace.projects[0];
  const suffix = randomUUID().slice(0, 8);
  const created: DocPage[] = [];
  const archived = new Map<string, string>();
  const authorHeaders = { 'X-Actor-Id': author.id };

  async function create(title: string, content: RichContent) {
    const response = await request.post('/api/documents', { headers: authorHeaders, data: { projectId, title, content } });
    expect(response.status(), await response.text()).toBe(201);
    const document = await response.json() as DocPage;
    created.push(document);
    return document;
  }

  async function edit(document: DocPage, title: string, content: RichContent) {
    const response = await request.patch(`/api/documents/${document.id}`, {
      headers: authorHeaders, data: { expectedVersion: document.version, title, content },
    });
    expect(response.status(), await response.text()).toBe(200);
    return await response.json() as DocPage;
  }

  async function archive(id: string) {
    const response = await request.delete(`/api/documents/${id}`, { headers: authorHeaders });
    expect(response.status(), await response.text()).toBe(200);
    const { trashEntryId } = await response.json() as { trashEntryId: string };
    archived.set(id, trashEntryId);
  }

  async function publish(document: DocPage) {
    const endpoint = `/api/documents/${document.id}/publication`;
    const current = await (await request.get(endpoint, { headers: authorHeaders })).json() as DocumentPublicationView;
    const submitted = await request.post(endpoint, { headers: authorHeaders, data: {
      action: 'request', expectedVersion: current.version, workspaceGeneration: current.workspaceGeneration,
      expectedDocumentVersion: current.documentVersion, reviewerId: reviewer.id,
    } });
    expect(submitted.status(), await submitted.text()).toBe(200);
    const review = await submitted.json() as DocumentPublicationView;
    const published = await request.post(endpoint, { headers: { 'X-Actor-Id': reviewer.id }, data: {
      action: 'publish', expectedVersion: review.version, workspaceGeneration: review.workspaceGeneration,
    } });
    expect(published.status(), await published.text()).toBe(200);
  }

  try {
    const capturedText = `고정한 예전 본문 ${suffix}`;
    const laterText = `고정한 뒤 변경한 본문 ${suffix}`;
    const nestedText = `실시간 원문의 본문 ${suffix}`;
    const imageAlt = `버전에 포함된 이미지 ${suffix}`;
    const nested = await create(`중첩 원문 ${suffix}`, body(paragraph(nestedText)));
    const initialSource = await create(`포함할 초기 원문 ${suffix}`, body(paragraph('첨부할 원문')));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
    const uploaded = await request.post(`/api/attachments?resourceType=document&resourceId=${initialSource.id}&filename=pin.png`, {
      headers: { ...authorHeaders, 'Content-Type': 'application/octet-stream' }, data: png,
    });
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const { currentVersionId: fileId } = await uploaded.json() as AttachmentHead;
    const source = await edit(initialSource, initialSource.title, body(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: capturedText }] },
      { type: 'documentInclude', attrs: { documentId: nested.id, label: nested.title } },
      { type: 'image', attrs: { src: `/api/attachments/${fileId}/content?inline=1`, alt: imageAlt } },
    ));
    const newer = await edit(source, `포함할 현재 원문 ${suffix}`, body(paragraph(`중간 버전 ${suffix}`)));
    const host = await create(`버전 포함 편집 문서 ${suffix}`, body(paragraph(`편집 문서 원문 ${suffix}`)));
    const revisions = await (await request.get(`/api/documents/${source.id}/revisions`)).json() as DocRevision[];
    const originalRevision = revisions.find(revision => revision.version === source.version);
    expect(originalRevision).toBeDefined();

    async function expectPinned(scope: Page | Locator) {
      const region = scope.getByRole('region', { name: `고정 포함 문서 ${source.title}`, exact: true });
      await region.getByRole('button', { name: '고정 버전 내용 보기', exact: true }).click();
      await expect(region.getByText(`고정 버전 ${source.version}`, { exact: true })).toBeVisible();
      await expect(region.getByRole('heading', { name: capturedText, exact: true })).toBeVisible();
      const image = region.getByRole('img', { name: imageAlt, exact: true });
      await expect(image).toHaveAttribute('src', `/api/documents/${source.id}/include-revisions/${originalRevision!.id}/images/${fileId}`);
      await image.scrollIntoViewIfNeeded();
      await expect(image).toHaveJSProperty('naturalWidth', 1);
      await expect(region).toContainText(nested.title);
      await expect(region).not.toContainText(nestedText);
      await expect(region).not.toContainText(laterText);
      expect(await region.evaluate(element => (element as HTMLElement).isContentEditable)).toBe(false);
    }

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/documents/${host.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(host.title);
    await page.getByRole('button', { name: '문서 버전 포함 삽입', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '문서 버전 포함 삽입', exact: true });
    await chooser.getByLabel('참조할 항목 검색', { exact: true }).fill(newer.title);
    await chooser.getByRole('button').filter({ hasText: newer.title }).click();
    const oldVersion = chooser.getByRole('button', { name: `버전 ${source.version} 포함`, exact: true });
    await expect(oldVersion).toContainText(source.title);
    await oldVersion.click();
    await expect(chooser).toBeHidden();
    await expectPinned(page);
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

    const saved = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(document => document.id === host.id);
    expect(saved?.content.content).toContainEqual({ type: 'documentRevisionInclude', attrs: {
      documentId: source.id, revisionId: originalRevision!.id, label: source.title,
    } });
    await edit(newer, `포함할 최종 원문 ${suffix}`, body(paragraph(laterText)));
    await page.reload();
    await expectPinned(page);

    await publish(host);
    await archive(source.id);
    await page.reload();
    await page.getByRole('button', { name: '검토·발행', exact: true }).click();
    const publication = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    await publication.getByRole('button', { name: '발행본 불러오기', exact: true }).click();
    await expectPinned(publication.getByRole('region', { name: '발행 고정본 내용', exact: true }));
  } finally {
    for (const document of created.reverse()) {
      if (!archived.has(document.id)) await archive(document.id);
      await request.delete(`/api/trash/${archived.get(document.id)}`, { headers: authorHeaders });
    }
  }
});
