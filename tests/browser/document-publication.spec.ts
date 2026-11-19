import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { DocPage, DocumentPublicationView, RichContent, WorkspaceSnapshot } from '../../shared/types';

const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });

test('360px에서 지정한 검토자가 고정된 버전을 확인하고 발행한다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, reviewer] = workspace.users;
  const project = workspace.projects[0];
  const suffix = randomUUID().slice(0, 8);
  const documents: DocPage[] = [];
  async function create(title: string, content: RichContent) {
    const result = await request.post('/api/documents', {
      headers: { 'X-Actor-Id': author.id }, data: { projectId: project.id, title, content },
    });
    expect(result.status(), await result.text()).toBe(201);
    const document = await result.json() as DocPage;
    documents.push(document);
    return document;
  }

  try {
    const included = await create(`포함 대상 ${suffix}`, body(paragraph('현재 포함 문서 원문')));
    const original = await create(`검토 문서 ${suffix}`, body(
      paragraph('검토 대상 원문'),
      { type: 'documentInclude', attrs: { documentId: included.id, label: included.title } },
    ));
    const location = `/#/${project.id}/documents/${original.id}`;
    const endpoint = `/api/documents/${original.id}/publication`;
    const transition = () => page.waitForResponse(result => result.url().endsWith(endpoint) && result.request().method() === 'POST');
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(location);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const open = page.getByRole('button', { name: '검토·발행', exact: true });
    const dialog = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    const close = dialog.getByRole('button', { name: '검토·발행 닫기', exact: true });
    const requestReview = dialog.getByRole('button', { name: '검토 요청 보내기', exact: true });
    const reviewTitle = `${original.title} 검토본`;

    await title.fill(reviewTitle);
    await open.click();
    await expect(dialog).toBeVisible();
    await expect(requestReview).toBeDisabled();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await close.click();
    await expect(title).toHaveValue(reviewTitle);
    const save = page.locator('.docs-save-button');
    await save.click();
    await expect(save).toBeDisabled();

    await open.click();
    await dialog.getByLabel('검토자', { exact: true }).selectOption(reviewer.id);
    await dialog.getByLabel('검토 요청 메모', { exact: true }).fill('팀 문서 제목과 내용을 확인해 주세요.');
    const requestedResponse = transition();
    await requestReview.click();
    const requested = await requestedResponse;
    expect(requested.status(), await requested.text()).toBe(200);
    const submission = await requested.json() as DocumentPublicationView;
    expect(submission.review).toMatchObject({ requestedById: author.id, reviewerId: reviewer.id });
    expect(submission.reviewRevision).toMatchObject({ title: reviewTitle, version: original.version + 1 });
    await expect(dialog.getByText('팀 문서 제목과 내용을 확인해 주세요.', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '검토본 발행', exact: true })).toHaveCount(0);
    await close.click();

    const laterTitle = `${original.title} 다음 편집`;
    const later = await request.patch(`/api/documents/${original.id}`, { data: {
      expectedVersion: submission.documentVersion, title: laterTitle, content: body(paragraph('다음 편집에만 있는 본문')),
    } });
    expect(later.status(), await later.text()).toBe(200);
    const changedInclude = await request.patch(`/api/documents/${included.id}`, { data: {
      expectedVersion: included.version, title: `${included.title} 다른 이름`, content: body(paragraph('변경 후 포함 문서에만 있는 본문')),
    } });
    expect(changedInclude.status(), await changedInclude.text()).toBe(200);
    await page.reload();
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(reviewer.id);
    await expect(title).toHaveValue(laterTitle);

    await open.click();
    const publish = dialog.getByRole('button', { name: '검토본 발행', exact: true });
    await expect(publish).toBeDisabled();
    await dialog.getByRole('button', { name: '검토본 불러오기', exact: true }).click();
    const frozenReview = dialog.getByRole('region', { name: '검토 고정본 내용' });
    await expect(frozenReview).toContainText(reviewTitle);
    await expect(frozenReview).toContainText('검토 대상 원문');
    await expect(frozenReview).toContainText(included.title);
    await expect(frozenReview).not.toContainText('다음 편집에만 있는 본문');
    await expect(frozenReview).not.toContainText('변경 후 포함 문서에만 있는 본문');
    await expect(frozenReview.locator('[contenteditable=true]')).toHaveCount(0);
    await dialog.getByLabel('검토 결과 메모', { exact: true }).fill('검토한 안내를 공유합니다.');
    const publishedResponse = transition();
    await publish.click();
    const published = await publishedResponse;
    expect(published.status(), await published.text()).toBe(200);
    const result = await published.json() as DocumentPublicationView;
    expect(result.published).toMatchObject({ revisionId: submission.reviewRevision!.id, publishedById: reviewer.id, note: '검토한 안내를 공유합니다.' });
    expect(result.review).toBeNull();
    await expect(dialog.getByText('검토한 안내를 공유합니다.', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '발행본 불러오기', exact: true }).click();
    const frozenPublication = dialog.getByRole('region', { name: '발행 고정본 내용' });
    await expect(frozenPublication).toContainText(reviewTitle);
    await expect(frozenPublication).toContainText('검토 대상 원문');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    await expect(title).toHaveValue(laterTitle);
  } finally {
    for (const document of documents.reverse()) await request.delete(`/api/documents/${document.id}`);
  }
});
