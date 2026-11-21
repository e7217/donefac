import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator } from '@playwright/test';
import type { DocPage, DocumentIssueLinkResult, DocumentSelectionCommentResult, Issue, RichContent, WorkspaceSnapshot } from '../../shared/types';

const boldText = '허용 오차';
const italicText = '두 번 확인합니다.';
const quote = `${boldText}를 ${italicText}`;
const earlier = `위쪽의 같은 문장 · ${quote}`;
const cellPrefix = '표 안의 결정 · ';
const cellSuffix = ' 측정 담당자에게 공유합니다.';
const originalEnd = '이 문단은 원문 저장본의 마지막에 있습니다.';
const latestBody = '같은 문장은 삭제하고 지금 적용할 절차를 기록했습니다.';
const highlight = '[data-document-excerpt]';
const startMarker = '[data-document-excerpt-start]';

test.use({ viewport: { width: 360, height: 820 } });

const text = (value: string): RichContent => ({ type: 'text', text: value });
const paragraph = (...content: RichContent[]): RichContent => ({ type: 'paragraph', content });
const documentBody = (...content: RichContent[]): RichContent => ({ type: 'doc', content });

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function removeFixture(request: APIRequestContext, kind: 'issues' | 'documents', id: string) {
  const removed = await request.delete(`/api/${kind}/${id}`);
  if (removed.ok()) {
    const { trashEntryId } = await removed.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

async function selectFormattedExcerpt(cell: Locator) {
  await cell.scrollIntoViewIfNeeded();
  await cell.evaluate(element => {
    const editor = element.closest<HTMLElement>('[contenteditable="true"]');
    const first = element.querySelector('strong')?.firstChild;
    const last = element.querySelector('em')?.firstChild;
    const selection = element.ownerDocument.getSelection();
    if (!editor || !first || !last || !selection) throw new Error('Expected a formatted excerpt in the editable table cell');
    editor.focus({ preventScroll: true });
    const range = element.ownerDocument.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.textContent?.length ?? 0);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

async function expectExactExcerpt(original: Locator) {
  const first = original.locator(startMarker);
  const allHighlights = original.locator(highlight);
  const chosenCell = original.getByRole('cell').filter({ hasText: cellPrefix });
  await expect(first).toHaveCount(1);
  await expect(first).toBeFocused();
  await expect(first).toBeInViewport();
  expect((await allHighlights.allTextContents()).join('')).toBe(quote);
  await expect(chosenCell.locator(highlight)).toHaveCount(await allHighlights.count());
  await expect(chosenCell).toHaveText(`${cellPrefix}${quote}${cellSuffix}`);
  await expect(chosenCell.locator('strong')).toHaveText(boldText);
  await expect(chosenCell.locator('em')).toHaveText(italicText);
  await expect(original.getByText(earlier, { exact: true }).locator(highlight)).toHaveCount(0);
  await expect(original.getByText(earlier, { exact: true })).toBeVisible();
  await expect(original.getByText('표의 다른 셀', { exact: true })).toBeVisible();
  await expect(original.getByText(originalEnd, { exact: true })).toBeVisible();
  await expect(original.getByText(latestBody, { exact: true })).toHaveCount(0);
}

test('360px에서 반복 문장 중 표에 있는 발췌를 저장본에서 정확히 찾고 티켓과 문서 초안을 유지한다', async ({ page, context, request }) => {
  test.setTimeout(90_000);
  const { projects: [project] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const suffix = randomUUID().slice(0, 8);
  const originalTitle = `발췌 위치 검증 ${suffix}`;
  const issueTitle = `측정 검토 ${suffix}`;
  const original = documentBody(
    paragraph(text(earlier)),
    ...Array.from({ length: 36 }, (_, index) => paragraph(text(`검토 회의의 배경 자료 ${index + 1}`))),
    { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableCell', content: [paragraph(
        text(cellPrefix),
        { ...text(boldText), marks: [{ type: 'bold' }] },
        text('를 '),
        { ...text(italicText), marks: [{ type: 'italic' }] },
        text(cellSuffix),
      )] },
      { type: 'tableCell', content: [paragraph(text('표의 다른 셀'))] },
    ] }] },
    paragraph(text(originalEnd)),
  );
  const source = await readJson<DocPage>(await request.post('/api/documents', {
    data: { projectId: project.id, title: originalTitle, content: original },
  }), 201);
  const apiDocument = `/api/documents/${source.id}`;
  const documentRoute = `/#/${project.id}/documents/${source.id}`;
  let issue: Issue | undefined;
  try {
    issue = await readJson<Issue>(await request.post('/api/issues', { data: { projectId: project.id, title: issueTitle } }), 201);
    await page.goto(documentRoute);
    const editor = page.locator('.docs-prose');
    const tableCell = editor.getByRole('cell').filter({ hasText: cellPrefix });
    await expect(tableCell).toBeVisible({ timeout: 25_000 });
    await selectFormattedExcerpt(tableCell);
    const action = page.getByRole('button', { name: '선택한 본문을 기존 업무에 연결', exact: true });
    await expect(action).toBeEnabled();
    await action.click();
    const connect = page.getByRole('dialog', { name: '기존 업무에 결정 근거 연결', exact: true });
    await expect(connect.locator('blockquote')).toHaveText(quote);
    await connect.getByRole('textbox', { name: '업무 키 또는 제목 검색', exact: true }).fill(issue.key);
    await connect.getByRole('radio', { name: new RegExp(`${issue.key}.*${issueTitle}`) }).check();
    const linked = page.waitForResponse(response =>
      new URL(response.url()).pathname === `${apiDocument}/decision-links` && response.request().method() === 'POST');
    await connect.getByRole('button', { name: '선택한 업무에 연결', exact: true }).click();
    const { link } = await readJson<DocumentIssueLinkResult>(await linked, 201);
    const selection = link.documentSource;
    if (!selection) throw new Error('Expected a pinned document selection on the saved relation');
    expect(selection.text).toBe(quote);
    expect(selection.from).toBeGreaterThan(earlier.length);
    await expect(connect).toHaveCount(0);

    const { comment: savedComment } = await readJson<DocumentSelectionCommentResult>(await request.post(`${apiDocument}/selection-comments`, {
      data: { requestId: randomUUID(), expectedDocumentVersion: source.version,
        body: '측정 담당자가 확인 결과를 남겨 주세요.',
        sourceSelection: { from: selection.from, to: selection.to, text: selection.text } },
    }), 201);
    expect(savedComment.documentSource).toEqual(selection);

    const currentTitle = `${originalTitle} 개정`;
    await readJson<DocPage>(await request.patch(apiDocument, {
      data: { expectedVersion: source.version, title: currentTitle, content: documentBody(paragraph(text(latestBody))) },
    }));

    const ticketPage = await context.newPage();
    await ticketPage.goto(`/#/${project.id}/issues`);
    await ticketPage.getByRole('button', { name: '보드', exact: true }).click();
    await ticketPage.getByRole('textbox', { name: '업무 검색', exact: true }).fill(issueTitle);
    await ticketPage.locator(`.issue-board-card[data-issue-id="${issue.id}"]`).click();
    const ticket = ticketPage.getByRole('dialog', { name: issueTitle, exact: true });
    const titleDraft = `${issueTitle} 저장하지 않은 제목`;
    const commentDraft = '저장본을 확인하는 동안 유지할 댓글';
    const title = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    await title.fill(titleDraft);
    await comment.fill(commentDraft);
    const ticketEvidence = ticket.getByRole('region', { name: '결정 근거', exact: true });
    const openTicketOriginal = ticketEvidence.getByRole('button', { name: '원문 저장본 열기', exact: true });
    await openTicketOriginal.click();
    const ticketOriginal = ticketEvidence.getByRole('region', { name: `결정 근거 원문 ${originalTitle}`, exact: true });
    await expectExactExcerpt(ticketOriginal);
    const revisit = ticketEvidence.getByRole('button', { name: '발췌 위치로 이동', exact: true });
    await revisit.focus();
    await expect(revisit).toBeFocused();
    await expect(ticketOriginal.locator(startMarker)).not.toBeInViewport();
    await revisit.press('Enter');
    await expect(ticketOriginal.locator(startMarker)).toBeFocused();
    await expect(ticketOriginal.locator(startMarker)).toBeInViewport();
    await ticketOriginal.locator(startMarker).press('Escape');
    await expect(openTicketOriginal).toBeFocused();
    await expect(ticketOriginal.locator(highlight)).toHaveCount(0);
    await expect(ticket).toBeVisible();
    await expect(title).toHaveValue(titleDraft);
    await expect(comment).toHaveValue(commentDraft);

    await page.reload();
    await expect(editor).toHaveText(latestBody);
    const docTitle = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(docTitle).toHaveValue(currentTitle);
    const docDraft = `${currentTitle} 저장하지 않은 제목`;
    await docTitle.fill(docDraft);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const sidebar = page.getByRole('complementary', { name: '문서 상세 정보', exact: true });
    await sidebar.getByRole('button', { name: '연결', exact: true }).click();
    const linkedEvidence = sidebar.getByRole('region', { name: `${issue.key} 결정 근거`, exact: true });
    const revisionPath = `${apiDocument}/include-revisions/${selection.revisionId}`;
    let releaseRevision = () => {};
    const heldRevision = new Promise<void>(resolve => { releaseRevision = resolve; });
    await page.route(`**${revisionPath}`, async route => {
      await heldRevision;
      await route.continue();
    });
    try {
      const load = page.waitForRequest(request => new URL(request.url()).pathname === revisionPath);
      await linkedEvidence.getByRole('button', { name: '원문 저장본 열기', exact: true }).click();
      await load;
      await docTitle.focus();
      await expect(docTitle).toBeFocused();
    } finally {
      releaseRevision();
    }
    const linkedOriginal = linkedEvidence.getByRole('region', { name: `결정 근거 원문 ${originalTitle}`, exact: true });
    await expect(linkedOriginal.locator(startMarker)).toHaveCount(1);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(docTitle).toBeFocused();
    await linkedOriginal.getByRole('button', { name: '발췌 위치로 이동', exact: true }).press('Enter');
    await expectExactExcerpt(linkedOriginal);

    await sidebar.getByRole('button', { name: /^댓글/ }).click();
    const documentComment = sidebar.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    const draftDocumentComment = '작성 중인 문서 전체 댓글';
    await documentComment.fill(draftDocumentComment);
    const commentEvidence = sidebar.locator(`#document-comment-${savedComment.id}`).getByRole('region', { name: '댓글이 달린 본문', exact: true });
    await commentEvidence.getByRole('button', { name: '원문 저장본 열기', exact: true }).click();
    const commentOriginal = commentEvidence.getByRole('region', { name: `댓글 원문 저장본 ${originalTitle}`, exact: true });
    await expectExactExcerpt(commentOriginal);
    await expect(documentComment).toHaveValue(draftDocumentComment);
    await expect(docTitle).toHaveValue(docDraft);
    await expect(editor).toHaveText(latestBody);

    await commentOriginal.locator(startMarker).press('Escape');
    await page.unroute(`**${revisionPath}`);
    await page.route(`**${revisionPath}`, async route => {
      const response = await route.fetch();
      const revision = await response.json();
      await route.fulfill({ response, json: { ...revision, content: documentBody(paragraph(text(earlier))) } });
    }, { times: 1 });
    await commentEvidence.getByRole('button', { name: '원문 저장본 열기', exact: true }).click();
    await expect(commentOriginal.getByRole('status')).toHaveText('저장본에서 발췌 위치를 찾을 수 없습니다.');
    await expect(commentOriginal.getByText(earlier, { exact: true })).toBeVisible();
    await expect(commentOriginal.locator(highlight)).toHaveCount(0);
    await expect(commentOriginal.getByRole('button', { name: '발췌 위치로 이동', exact: true })).toHaveCount(0);
  } finally {
    if (issue) await removeFixture(request, 'issues', issue.id);
    await removeFixture(request, 'documents', source.id);
  }
});
