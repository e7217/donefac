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
    const issueListLabel = `검토 업무 목록 ${suffix}`;
    const issueSummaryLabel = `검토 업무 현황 ${suffix}`;
    const original = await create(`검토 문서 ${suffix}`, body(
      paragraph('검토 대상 원문'),
      { type: 'documentInclude', attrs: { documentId: included.id, label: included.title } },
      { type: 'issueList', attrs: { projectId: project.id, savedViewId: null, label: issueListLabel } },
      { type: 'issueSummary', attrs: { projectId: project.id, savedViewId: null, label: issueSummaryLabel, groupBy: 'priority' } },
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
      expectedVersion: submission.documentVersion, contentSchemaVersion:4, title: laterTitle, content: body(paragraph('다음 편집에만 있는 본문')),
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
    await expect(frozenReview).toContainText(issueListLabel);
    await expect(frozenReview).toContainText('이 저장본에는 목록 조건이 보관됩니다.');
    await expect(frozenReview).toContainText(issueSummaryLabel);
    await expect(frozenReview).toContainText('우선순위 기준');
    await expect(frozenReview).toContainText('이 저장본에는 집계 설정이 보관됩니다.');
    await expect(frozenReview.getByRole('region', {name:'업무 현황',exact:true})).toHaveCount(0);
    await expect(frozenReview.getByRole('button', { name:/목록 업무 열기/ })).toHaveCount(0);
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
    await expect(frozenPublication).toContainText(issueListLabel);
    await expect(frozenPublication).toContainText(issueSummaryLabel);
    await expect(frozenPublication).toContainText('우선순위 기준');
    await expect(frozenPublication.getByRole('region', {name:'업무 현황',exact:true})).toHaveCount(0);
    await expect(frozenPublication.getByRole('button', { name:/목록 업무 열기/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    await expect(title).toHaveValue(laterTitle);
  } finally {
    for (const document of documents.reverse()) await request.delete(`/api/documents/${document.id}`);
  }
});

test('360px에서 발행본과 고정 검토본의 차이를 보고 메모와 편집 초안을 유지한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, reviewer] = workspace.users;
  const project = workspace.projects[0];
  const suffix = randomUUID().slice(0, 8);
  const firstTitle = `서버 운영 안내 ${suffix}`;
  const opened = await request.post('/api/documents', {
    headers: { 'X-Actor-Id': author.id },
    data: { projectId: project.id, title: firstTitle, content: body(paragraph('현재 발행 중인 원래 절차')) },
  });
  expect(opened.status(), await opened.text()).toBe(201);
  const original = await opened.json() as DocPage;
  const documentPath = `/api/documents/${original.id}`;
  const publicationPath = `${documentPath}/publication`;
  const comparisonPath = `${publicationPath}/comparison`;
  const note = `비교 화면을 열기 전에 작성한 검토 메모 ${suffix}`;
  const latestTitle = `검토 이후 서버에 저장한 별도 초안 ${suffix}`;
  const unsavedTitle = `비교할 때 탭에만 남아 있는 초안 ${suffix}`;

  async function write(action: string, state: Pick<DocumentPublicationView, 'version' | 'workspaceGeneration'>,
    actor: string, data: Record<string, unknown> = {}) {
    const response = await request.post(publicationPath, {
      headers: { 'X-Actor-Id': actor }, data: { action, expectedVersion: state.version, workspaceGeneration: state.workspaceGeneration, ...data },
    });
    expect(response.status(), await response.text()).toBe(200);
    return await response.json() as DocumentPublicationView;
  }
  async function update(before: DocPage, title: string, text: string) {
    const response = await request.patch(documentPath, {
      headers: { 'X-Actor-Id': author.id },
      data: { expectedVersion: before.version, contentSchemaVersion: 4, title, content: body(paragraph(text)) },
    });
    expect(response.status(), await response.text()).toBe(200);
    return await response.json() as DocPage;
  }

  try {
    const state = await (await request.get(publicationPath)).json() as DocumentPublicationView;
    const first = await write('request', state, author.id, { expectedDocumentVersion: original.version, reviewerId: reviewer.id });
    const published = await write('publish', first, reviewer.id);
    const candidate = await update(original, `이번에 검토할 문서 제목 ${suffix}`, '이번 검토에 새로 추가한 배포 단계');
    const pending = await write('request', published, author.id, { expectedDocumentVersion: candidate.version, reviewerId: reviewer.id });
    const later = await update(candidate, latestTitle, '다음 초안의 본문은 검토와 별개');
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/documents/${original.id}`);
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(reviewer.id);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(title).toHaveValue(latestTitle);
    await title.fill(unsavedTitle);
    const open = page.getByRole('button', { name: '검토·발행', exact: true });
    await open.click();
    const dialog = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    const compare = dialog.getByRole('button', { name: '발행본과 비교', exact: true });
    const comparison = dialog.getByRole('region', { name: '발행본과 검토본 비교', exact: true });
    const resultMemo = dialog.getByLabel('검토 결과 메모', { exact: true });
    const publish = dialog.getByRole('button', { name: '검토본 발행', exact: true });
    await resultMemo.fill(note);
    await expect(publish).toBeDisabled();

    const isComparison = (endpoint: string) => new URL(endpoint).pathname === comparisonPath;
    let releaseComparison!: () => void;
    const heldComparison = new Promise<void>(resolve => { releaseComparison = resolve; });
    await page.route(url => url.pathname === comparisonPath, async route => {
      await heldComparison;
      await route.continue();
    }, { times: 1 });
    const pairResponse = page.waitForResponse(response => isComparison(response.url()) && response.request().method() === 'GET');
    try {
      await compare.click();
      await resultMemo.focus();
    } finally {
      releaseComparison();
    }
    expect((await pairResponse).status()).toBe(200);
    await expect(comparison).toContainText(`발행본 · 버전 ${original.version}`);
    await expect(comparison).toContainText(`검토본 · 버전 ${candidate.version}`);
    await expect(comparison).toContainText(original.title);
    await expect(comparison).toContainText(candidate.title);
    await expect(comparison).toContainText('현재 발행 중인 원래 절차');
    await expect(comparison).toContainText('이번 검토에 새로 추가한 배포 단계');
    await expect(comparison).not.toContainText(/다음 초안의 본문|비교할 때 탭에만/u);
    await expect(comparison.locator('[contenteditable=true]')).toHaveCount(0);
    await expect(resultMemo).toHaveValue(note);
    await expect(resultMemo).toBeFocused();
    await expect(publish).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await comparison.getByRole('button', { name: '비교 닫기', exact: true }).click();
    await expect(comparison).toHaveCount(0);
    await expect(compare).toBeFocused();
    await expect(resultMemo).toHaveValue(note);

    await compare.click();
    await expect(comparison).toContainText(candidate.title);
    const isReviewSnapshot = (url: URL) => url.pathname === `${publicationPath}/snapshot` && url.searchParams.get('kind') === 'review';
    await page.route(isReviewSnapshot, async route => {
      await write('withdraw', pending, author.id);
      await route.continue();
    }, { times: 1 });
    const changed = page.waitForResponse(response => isReviewSnapshot(new URL(response.url())) && response.request().method() === 'GET');
    await dialog.getByRole('button', { name: '검토본 불러오기', exact: true }).click();
    expect((await changed).status()).toBe(404);
    await expect(dialog.getByRole('status').filter({ hasText: '상태가 바뀌었거나' })).toBeVisible();
    await expect(comparison).toHaveCount(0);
    await expect(publish).toBeDisabled();
    await expect(resultMemo).toHaveValue(note);
    const discardMemo = page.waitForEvent('dialog').then(async confirmation => {
      expect(confirmation.message()).toContain('메모를 버리고 닫을까요?');
      await confirmation.accept();
    });
    await dialog.getByRole('button', { name: '검토·발행 닫기', exact: true }).click();
    await discardMemo;
    await expect(dialog).toBeHidden();
    await expect(title).toHaveValue(unsavedTitle);
    const saved = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(doc => doc.id === later.id);
    expect(saved?.title).toBe(later.title);
  } finally {
    await request.delete(documentPath);
  }
});
