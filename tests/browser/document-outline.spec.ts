import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { DocPage, DocumentPublicationView, RichContent, WorkspaceSnapshot } from '../../shared/types';

const heading = (level: number, text: string): RichContent => ({
  type: 'heading', attrs: { level }, content: text ? [{ type: 'text', text }] : [],
});
const details = (label: string, ...content: RichContent[]): RichContent => ({
  type: 'details', content: [
    { type: 'detailsSummary', content: [{ type: 'text', text: label }] },
    { type: 'detailsContent', content },
  ],
});
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const originalHeading = '설계 개요';
const editedHeading = '편집한 설계 개요';
const includedHeading = '포함한 원문의 절';
const repeatedHeading = '검토 항목';
const firstFold = '첫 번째 검토';
const secondFold = '두 번째 검토';
const nestedFold = '접힌 상세 검토';

async function openOutline(scope: Locator | Page) {
  const summary = scope.locator('summary').filter({ hasText: '문서 목차' });
  const outline = scope.getByRole('navigation', { name: '문서 제목', exact: true });
  await expect(summary).toBeVisible({ timeout: 25_000 });
  await expect(outline).toBeHidden();
  const bounds = await summary.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect(bounds ? bounds.x + bounds.width : 361).toBeLessThanOrEqual(360);
  await summary.click();
  await expect(outline).toBeVisible();
  return outline;
}

function section(scope: Locator, label: string) {
  return scope.locator('summary').filter({ hasText: label }).locator('..');
}

async function closeHeadingSections(scope: Locator) {
  // Fold the nested section while its summary is still visible.
  for (const label of [nestedFold, secondFold, firstFold]) {
    const target = section(scope, label);
    await expect(target).toHaveJSProperty('open', true);
    await target.locator(':scope > summary').click();
    await expect(target).toHaveJSProperty('open', false);
  }
}

async function jumpToSecondHeading(scope: Locator, outline: Locator) {
  const first = section(scope, firstFold);
  const second = section(scope, secondFold);
  const nested = section(scope, nestedFold);
  await expect(nested.getByRole('heading', { name: repeatedHeading, exact: true })).toBeHidden();
  await outline.getByRole('button', { name: `${repeatedHeading} (2/2)`, exact: true }).click();
  await expect(first).toHaveJSProperty('open', false);
  await expect(second).toHaveJSProperty('open', true);
  await expect(nested).toHaveJSProperty('open', true);
  await expect(nested.getByRole('heading', { name: repeatedHeading, exact: true })).toBeInViewport();
}

test('360px 문서 목차에서 같은 제목의 접힌 절로 이동하고 검토·발행·이력의 저장본 제목을 확인한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, reviewer] = workspace.users;
  const { id: projectId } = workspace.projects[0];
  const suffix = randomUUID().slice(0, 8);
  const authorHeaders = { 'X-Actor-Id': author.id };
  const created: DocPage[] = [];
  async function create(title: string, content: RichContent) {
    const response = await request.post('/api/documents', { headers: authorHeaders, data: { projectId, title, content } });
    expect(response.status(), await response.text()).toBe(201);
    const document = await response.json() as DocPage;
    created.push(document);
    return document;
  }

  try {
    const included = await create(`목차에 포함할 문서 ${suffix}`, body(heading(1, includedHeading)));
    const document = await create(`문서 목차 검증 ${suffix}`, body(
      heading(1, originalHeading),
      details(firstFold, heading(2, repeatedHeading)),
      { type: 'documentInclude', attrs: { documentId: included.id, label: included.title } },
      details(secondFold, details(nestedFold, heading(2, repeatedHeading))),
      heading(3, ''),
    ));
    const endpoint = `/api/documents/${document.id}/publication`;
    const initial = await (await request.get(endpoint, { headers: authorHeaders })).json() as DocumentPublicationView;
    const submitted = await request.post(endpoint, { headers: authorHeaders, data: {
      action: 'request', expectedVersion: initial.version, workspaceGeneration: initial.workspaceGeneration,
      expectedDocumentVersion: initial.documentVersion, reviewerId: reviewer.id,
    } });
    expect(submitted.status(), await submitted.text()).toBe(200);
    const review = await submitted.json() as DocumentPublicationView;
    expect(review.reviewRevision?.version).toBe(document.version);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/documents/${document.id}`);
    const editor = page.locator('.docs-prose');
    const topHeading = editor.getByRole('heading', { name: originalHeading, level: 1, exact: true });
    await expect(topHeading).toBeVisible({ timeout: 25_000 });
    await expect(editor.getByRole('heading', { name: includedHeading, level: 1, exact: true })).toBeVisible();
    const outline = await openOutline(page);
    await expect(outline.getByRole('button')).toHaveText([originalHeading, `${repeatedHeading} (1/2)`, `${repeatedHeading} (2/2)`]);
    await closeHeadingSections(editor);

    await topHeading.click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('편집한 ');
    await expect(outline.getByRole('button', { name: editedHeading, exact: true })).toBeVisible();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    const selectedText = () => page.evaluate(() => window.getSelection()?.toString());
    expect(await selectedText()).toBe(editedHeading);
    await jumpToSecondHeading(editor, outline);
    expect(await selectedText()).toBe(editedHeading);

    const beforeSave = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(beforeSave.documents.find(item => item.id === document.id)).toMatchObject({
      version: document.version, content: document.content,
    });
    const saveResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}`) && response.request().method() === 'PATCH');
    await page.locator('.docs-save-button').click();
    const saved = await saveResponse;
    expect(saved.status(), await saved.text()).toBe(200);
    expect(await saved.json()).toMatchObject({ version: document.version + 1, plainText: expect.stringContaining(editedHeading) });
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

    await page.getByLabel('작업자 선택', { exact: true }).selectOption(reviewer.id);
    await page.getByRole('button', { name: '검토·발행', exact: true }).click();
    const publication = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    async function checkFixedCopy(kind: '검토' | '발행') {
      await publication.getByRole('button', { name: `${kind}본 불러오기`, exact: true }).click();
      const snapshot = publication.getByRole('region', { name: `${kind} 고정본 내용`, exact: true });
      const fixedOutline = await openOutline(snapshot);
      await expect(fixedOutline.getByRole('button')).toHaveText([originalHeading, `${repeatedHeading} (1/2)`, `${repeatedHeading} (2/2)`]);
      await expect(snapshot.getByRole('heading', { name: editedHeading, exact: true })).toHaveCount(0);
      await expect(snapshot.locator('[contenteditable=true]')).toHaveCount(0);
      await closeHeadingSections(snapshot);
      await jumpToSecondHeading(snapshot, fixedOutline);
    }

    await checkFixedCopy('검토');
    await publication.getByLabel('검토 결과 메모', { exact: true }).fill('고정한 설계를 발행합니다.');
    const publishResponse = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'POST');
    await publication.getByRole('button', { name: '검토본 발행', exact: true }).click();
    const released = await publishResponse;
    expect(released.status(), await released.text()).toBe(200);
    const published = await released.json() as DocumentPublicationView;
    expect(published.publishedRevision?.id).toBe(review.reviewRevision?.id);
    await checkFixedCopy('발행');
    await publication.getByRole('button', { name: '검토·발행 닫기', exact: true }).click();

    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const information = page.getByRole('complementary', { name: '문서 상세 정보', exact: true });
    await information.getByRole('button', { name: '이력', exact: true }).click();
    await information.locator('.docs-revision').filter({ hasText: `버전 ${document.version}` }).click();
    const history = information.locator('.docs-history-preview');
    const historyOutline = await openOutline(history);
    await expect(historyOutline.getByRole('button')).toHaveText([originalHeading, `${repeatedHeading} (1/2)`, `${repeatedHeading} (2/2)`]);
    await closeHeadingSections(history);
    await jumpToSecondHeading(history, historyOutline);
  } finally {
    for (const document of created.reverse()) {
      const response = await request.delete(`/api/documents/${document.id}`, { headers: authorHeaders });
      if (response.ok()) {
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers: authorHeaders });
      }
    }
  }
});
