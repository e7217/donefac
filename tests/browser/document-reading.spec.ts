import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import { documentReadingHash, documentSectionHash } from '../../shared/document-sections';
import type { DocPage, DocumentSelectionCommentResult, RichContent, WorkspaceSnapshot } from '../../shared/types';

const savedBody = '검토 완료한 저장본 문장';
const newBody = '편집 화면에 남긴 문장';
const sectionTitle = '검토 대상 절';
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });

async function placeCursor(target: Locator, start: boolean) {
  await target.evaluate((element, atStart) => {
    element.closest<HTMLElement>('[contenteditable="true"]')?.focus();
    const range = window.document.createRange();
    range.selectNodeContents(element);
    range.collapse(atStart);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, start);
}

async function createDocument(request: APIRequestContext, projectId: string, content: RichContent[]) {
  const response = await request.post('/api/documents', { data: {
    projectId,
    title: `문서 읽기 검증 ${randomUUID()}`,
    labels: ['읽기 테스트'],
    content: { type: 'doc', content },
  } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as DocPage;
}

async function cleanup(request: APIRequestContext, id: string) {
  const removed = await request.delete(`/api/documents/${id}`);
  if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
}

test('360px 저장본 읽기에서 절·참조·첨부를 열고 이전 편집과 댓글 초안으로 돌아온다', async ({ page, request, browser, baseURL }) => {
  const { projects } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = projects[0].id;
  const sectionId = randomUUID();
  const quote = '문장 댓글에 연결할 저장본 근거';
  const quoteComment = '읽기 화면에서 확인할 문장 댓글';
  const peer = await createDocument(request, projectId, [paragraph('참조 문서의 저장된 본문')]);
  const created = await createDocument(request, projectId, [
    paragraph(quote),
    { type: 'details', content: [
      { type: 'detailsSummary', content: [{ type: 'text', text: '접힌 구역' }] },
      { type: 'detailsContent', content: [
        { type: 'heading', attrs: { level: 2, sectionId }, content: [{ type: 'text', text: sectionTitle }] },
        paragraph(savedBody),
      ] },
    ] },
    { type: 'paragraph', content: [{ type: 'text', text: '본문 링크로 문서 열기', marks: [{ type: 'link', attrs: {
      href: `#/${projectId}/documents/${peer.id}`,
    } }] }] },
    { type: 'documentReference', attrs: { documentId: peer.id, label: peer.title } },
  ]);
  const shareContext = await browser.newContext({ baseURL, viewport: { width: 360, height: 820 } });
  try {
    const posted = await request.post(`/api/documents/${created.id}/selection-comments`, { data: {
      requestId: randomUUID(), expectedDocumentVersion: created.version,
      sourceSelection: { from: 1, to: 1 + quote.length, text: quote }, body: quoteComment,
    } });
    expect(posted.status(), await posted.text()).toBe(201);
    const { comment: selectionComment } = await posted.json() as DocumentSelectionCommentResult;
    const attachment = await request.post(`/api/attachments?resourceType=document&resourceId=${created.id}&filename=reading.txt`, {
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Type': 'text/plain' },
      data: Buffer.from('합성 첨부입니다.'),
    });
    expect(attachment.status(), await attachment.text()).toBe(201);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/${documentSectionHash(created.id, sectionId, projectId)}`);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const editor = page.locator('.docs-prose');
    const comment = page.getByRole('textbox', { name: '새 문서 댓글' });
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    const localTitle = `${created.title} 편집 초안`;
    await title.fill(localTitle);
    const original = editor.getByText(savedBody, { exact: true });
    await placeCursor(original, false);
    await page.keyboard.insertText(` ${newBody}`);
    await expect(original).toHaveCount(0);
    await expect(editor.getByText(`${savedBody} ${newBody}`)).toBeVisible();
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).press('Enter');
    await comment.fill('아직 보내지 않은 합성 댓글');
    await page.getByRole('button', { name: '정보 패널 닫기', exact: true }).press('Enter');

    await page.getByRole('button', { name: '저장본 읽기', exact: true }).press('Enter');
    const readHash = documentReadingHash(created.id, projectId, sectionId);
    await expect(page).toHaveURL(url => url.hash === readHash);
    const reader = page.getByRole('article', { name: '저장본 읽기', exact: true });
    await expect(reader.getByRole('heading', { name: created.title, exact: true })).toBeVisible();
    await expect(reader.getByRole('heading', { name: sectionTitle })).toBeFocused();
    await expect(reader.getByText(savedBody, { exact: true })).toBeVisible();
    await expect(reader.getByText(newBody, { exact: false })).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: '문서 서식' })).toHaveCount(0);
    await expect(reader.getByText('읽기 테스트')).toBeVisible();
    await expect(reader.getByRole('button', { name: `참조 문서 열기 ${peer.title}` })).toBeVisible();
    await page.getByRole('button', { name: '읽기 링크 복사' }).press('Enter');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(`/${readHash}`, baseURL).href);
    await expect(reader.getByRole('button', { name: `절 링크 복사 ${sectionTitle}` })).toHaveCount(0);
    await reader.locator('summary').first().press('Enter');
    await reader.getByRole('button', { name: `절 링크 복사 ${sectionTitle}` }).press('Enter');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(`/${readHash}`, baseURL).href);

    const shared = await shareContext.newPage();
    await shareContext.grantPermissions(['clipboard-read', 'clipboard-write']);
    await shared.goto(`/${readHash}`);
    await expect(shared.getByRole('article', { name: '저장본 읽기' }).getByRole('heading', { name: sectionTitle })).toBeFocused();
    await shared.reload();
    await expect(shared).toHaveURL(url => url.hash === readHash);
    await shared.getByRole('article', { name: '저장본 읽기' }).getByRole('link', { name: '본문 링크로 문서 열기' }).press('Enter');
    await expect(shared).toHaveURL(url => url.hash === documentReadingHash(peer.id, projectId));
    await shared.goBack();
    await expect(shared.getByRole('article', { name: '저장본 읽기' }).getByText(savedBody, { exact: true })).toBeVisible();
    await shared.getByRole('button', { name: `참조 문서 열기 ${peer.title}` }).press('Enter');
    await expect(shared).toHaveURL(url => url.hash === documentReadingHash(peer.id, projectId));
    await shared.goBack();
    await shared.getByRole('button', { name: '정보 패널 열기', exact: true }).press('Enter');
    await shared.getByRole('button', { name: '파일', exact: true }).press('Enter');
    await expect(shared.getByRole('link', { name: 'reading.txt 다운로드' })).toBeVisible();
    await expect(shared.getByRole('button', { name: 'reading.txt 삭제' })).toHaveCount(0);
    await expect(shared.getByRole('button', { name: '파일 선택' })).toHaveCount(0);
    const detailTabs = shared.locator('.docs-detail-tabs');
    await detailTabs.getByRole('button', { name: '이력', exact: true }).press('Enter');
    const compare = shared.getByRole('button', { name: '버전 비교', exact: true });
    await expect(compare).toBeEnabled();
    await compare.press('Enter');
    await expect(shared.getByRole('combobox', { name: '비교 대상 버전' }).locator('option:checked')).toContainText('현재 저장본');
    await shared.getByRole('button', { name: '문서 버전 비교 닫기' }).press('Enter');
    await detailTabs.getByRole('button', { name: /^댓글/ }).press('Enter');
    const thread = shared.locator(`#document-comment-${selectionComment.id}`);
    await expect(thread).toContainText(quote);
    await expect(thread).toContainText(quoteComment);
    await thread.getByRole('button', { name: '댓글 링크 복사' }).press('Enter');
    const commentHref = new URL(`/${documentReadingHash(created.id, projectId)}&comment=${selectionComment.id}`, baseURL).href;
    await expect.poll(() => shared.evaluate(() => navigator.clipboard.readText())).toBe(commentHref);
    await shared.goto(commentHref);
    await expect(thread).toBeFocused();
    await expect(shared.getByRole('article', { name: '저장본 읽기', exact: true })).toBeVisible();

    await page.goBack();
    await expect(title).toHaveValue(localTitle);
    await expect(editor.getByText(`${savedBody} ${newBody}`)).toBeVisible();
    await page.getByRole('toolbar', { name: '문서 서식' }).getByRole('button', { name: '실행 취소', exact: true }).press('Enter');
    await expect(editor.getByText(savedBody, { exact: true })).toBeVisible();
    await page.goForward();
    await expect(reader.getByText(savedBody, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '편집으로 돌아가기' }).press('Enter');
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).press('Enter');
    await expect(comment).toHaveValue('아직 보내지 않은 합성 댓글');
  } finally {
    await shareContext.close();
    await cleanup(request, created.id);
    await cleanup(request, peer.id);
  }
});

test('공유한 읽기 주소는 편집 연결 없이 열리고 열린 공동 편집을 읽기로 전환해도 동기화와 실행 취소가 이어진다', async ({ page, request, browser, baseURL }) => {
  const { projects, users } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = projects[0].id;
  const created = await createDocument(request, projectId, [paragraph(savedBody)]);
  const peerContext = await browser.newContext({ baseURL });
  try {
    const enabled = await request.post(`/api/documents/${created.id}/collaboration/enable`, { data: { expectedVersion: created.version } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    await page.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), users[0].id);
    await peerContext.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), users[1].id);
    const peer = await peerContext.newPage();
    const readHash = documentReadingHash(created.id, projectId);
    const editorHref = `/#/${projectId}/documents/${created.id}`;
    const collaborationRequests: string[] = [];
    peer.on('request', request => {
      if (new URL(request.url()).pathname === `/api/documents/${created.id}/collaboration`) collaborationRequests.push(request.url());
    });
    const liveEditor = page.locator('.docs-live-prose');
    const reader = page.getByRole('article', { name: '저장본 읽기', exact: true });
    await Promise.all([page.goto(editorHref), peer.goto(`/${readHash}`)]);
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expect(peer.getByRole('article', { name: '저장본 읽기' })).toContainText(savedBody);
    expect(collaborationRequests).toEqual([]);
    await expect(page.locator('.docs-collaboration-presence')).toContainText('1명 접속');
    await peer.getByRole('button', { name: '편집으로 돌아가기' }).press('Enter');
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');

    await placeCursor(liveEditor.getByText(savedBody, { exact: true }), false);
    await page.context().setOffline(true);
    await expect(page.locator('.docs-collaboration-state')).toHaveText('연결 끊김');
    await page.keyboard.insertText(' 내 오프라인 입력');
    await expect(page.locator('.docs-collaboration-state')).toHaveText('연결 끊김 · 편집 보관 중');
    await page.getByRole('button', { name: '저장본 읽기', exact: true }).press('Enter');
    await expect(reader).toContainText('편집 화면에 저장 대기 중인 변경이 있습니다.');
    await expect(reader).not.toContainText('내 오프라인 입력');
    await page.context().setOffline(false);
    await expect(reader).toContainText('내 오프라인 입력');
    const peerEditor = peer.locator('.docs-live-prose');
    await expect(peerEditor).toContainText('내 오프라인 입력');
    await placeCursor(peerEditor.locator('p').first(), true);
    await peer.keyboard.insertText('동료 입력 ');
    await expect(reader).toContainText(`동료 입력 ${savedBody} 내 오프라인 입력`);
    await page.getByRole('button', { name: '편집으로 돌아가기' }).press('Enter');
    await page.getByRole('toolbar', { name: '문서 서식' }).getByRole('button', { name: '실행 취소', exact: true }).press('Enter');
    await expect(peerEditor).toHaveText(`동료 입력 ${savedBody}`);
    await expect(liveEditor).toHaveText(`동료 입력 ${savedBody}`);
  } finally {
    await page.context().setOffline(false);
    await peerContext.close();
    await cleanup(request, created.id);
  }
});

test('360px 저장본에서 서식과 접힌 본문의 검색 결과를 이동하고 새 저장본을 다시 찾는다', async ({ page, request }) => {
  const { projects, users } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = projects[0].id;
  const query = 'READ(+)';
  const nested = await createDocument(request, projectId, [paragraph('포함된 원문의 READ(+) 문장')]);
  const created = await createDocument(request, projectId, [
    { type: 'paragraph', content: [{ type: 'text', text: 'read' }, { type: 'text', text: '(+)', marks: [{ type: 'bold' }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'READ' }, { type: 'hardBreak' }, { type: 'text', text: '(+)' }] },
    { type: 'codeBlock', content: [{ type: 'text', text: `코드 앞\n${query} 코드 뒤` }] },
    { type: 'details', content: [
      { type: 'detailsSummary', content: [{ type: 'text', text: '접힌 검색 내용' }] },
      { type: 'detailsContent', content: [paragraph(`접힌 본문의 ${query}`)] },
    ] },
    { type: 'documentInclude', attrs: { documentId: nested.id, label: nested.title } },
    paragraph('반복단어 '.repeat(1001)),
  ]);
  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), users[0].id);
    await page.goto(`/#/${projectId}/documents/${created.id}`);
    const editorParagraph = page.locator('.docs-prose').getByText('read(+)', { exact: true });
    await expect(editorParagraph).toBeVisible();
    await placeCursor(editorParagraph, false);
    await page.keyboard.insertText(' 검색에 제외할 편집 초안');
    await page.getByRole('button', { name: '저장본 읽기', exact: true }).press('Enter');
    const reader = page.getByRole('article', { name: '저장본 읽기', exact: true });
    const find = page.getByRole('button', { name: '저장본 본문에서 찾기', exact: true });
    const panel = page.getByRole('search', { name: '저장본 본문 찾기' });
    const input = panel.getByRole('textbox', { name: '찾을 텍스트' });
    const result = panel.getByRole('status');
    const currentBlock = reader.locator('[data-document-reader-find-current]');
    const exactRange = () => page.evaluate(() => [...(CSS.highlights.get('teamspace-document-reader-find-current') ?? [])][0]?.toString());
    const details = reader.locator('details');
    await expect(details).toHaveCount(1);
    await details.locator('summary').press('Enter');
    await expect(details).not.toHaveAttribute('open', '');
    await find.press('Control+f');
    await expect(input).toBeFocused();
    await expect(reader.getByText('포함된 원문의 READ(+) 문장')).toBeVisible();

    await input.fill('검색에 제외할 편집 초안');
    await expect(result).toHaveText('검색 결과 없음');
    await input.fill(query);
    await expect(result).toHaveText('3개 중 1번째');
    await expect.poll(exactRange).toBe('read(+)');
    await expect(currentBlock.locator('strong')).toHaveText('(+)');
    await input.press('Enter');
    await expect(result).toHaveText('3개 중 2번째');
    await expect(currentBlock).toContainText('코드 뒤');
    await expect.poll(exactRange).toBe(query);
    await input.press('Enter');
    await expect(result).toHaveText('3개 중 3번째');
    await expect(details).toHaveAttribute('open', '');
    await expect(currentBlock).toContainText('접힌 본문');
    await expect(input).toBeFocused();
    await input.press('Shift+Enter');
    await expect(result).toHaveText('3개 중 2번째');
    await panel.getByRole('checkbox', { name: '대소문자 구분' }).check();
    await expect(result).toHaveText('2개 중 1번째');
    await expect(currentBlock).toContainText('코드 뒤');
    await input.fill('반복단어');
    await expect(result).toHaveText('1,000개 이상 중 1번째');
    await input.fill(query);

    const updated = await request.patch(`/api/documents/${created.id}`, {
      headers: { 'X-Actor-Id': users[1].id },
      data: { expectedVersion: created.version, content: { type: 'doc', content: [paragraph(`동료가 저장한 ${query}`)] } },
    });
    expect(updated.status(), await updated.text()).toBe(200);
    await page.getByRole('button', { name: '저장본 새로고침', exact: true }).press('Enter');
    await expect(result).toHaveText('1개 중 1번째');
    await expect(currentBlock).toContainText('동료가 저장한');
    await expect(panel.getByRole('button', { name: '모두 바꾸기' })).toHaveCount(0);
    await input.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(find).toBeFocused();
    await expect(currentBlock).toHaveCount(0);
    await expect.poll(exactRange).toBeUndefined();
    await page.getByRole('button', { name: '편집으로 돌아가기', exact: true }).press('Enter');
    await expect(page.locator('.docs-prose')).toContainText('검색에 제외할 편집 초안');
  } finally {
    await cleanup(request, created.id);
    await cleanup(request, nested.id);
  }
});
