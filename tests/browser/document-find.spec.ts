import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types';

const viewport = { width: 360, height: 820 };
const text = (value: string): RichContent => ({ type: 'text', text: value });
const paragraph = (...content: RichContent[]): RichContent => ({ type: 'paragraph', content });
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
function fold(label: string, ...content: RichContent[]): RichContent {
  return { type: 'details', content: [
    { type: 'detailsSummary', content: [text(label)] },
    { type: 'detailsContent', content },
  ] };
}
const workspace = async (request: APIRequestContext) => {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<WorkspaceSnapshot>;
};

async function fixture(request: APIRequestContext) {
  const { projects: [project], users } = await workspace(request);
  const added: DocPage[] = [];
  async function current(id: string) {
    const document = (await workspace(request)).documents.find(entry => entry.id === id);
    expect(document).toBeDefined();
    return document!;
  }
  async function create(title: string, content: RichContent) {
    const response = await request.post('/api/documents', { data: { title: `${title} ${randomUUID()}`, projectId: project.id, content } });
    expect(response.status(), await response.text()).toBe(201);
    const document = await response.json() as DocPage;
    added.push(document);
    return document;
  }
  async function cleanup() {
    for (const { id } of added.reverse()) {
      const { version } = await current(id);
      const remove = await request.delete(`/api/documents/${id}?expectedVersion=${version}`);
      expect(remove.ok(), await remove.text()).toBe(true);
      const { trashEntryId } = await remove.json() as { trashEntryId: string };
      const purge = await request.delete(`/api/trash/${trashEntryId}`);
      expect(purge.ok(), await purge.text()).toBe(true);
    }
  }
  return { current, create, cleanup, users };
}

async function openDocument(page: Page, { projectId, id, title }: DocPage) {
  await page.goto(`/#/${projectId}/documents/${id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title);
}

const findPanel = (page: Page) => page.getByRole('search', { name: '문서 본문 찾기', exact: true });
const findInput = (panel: Locator) => panel.getByLabel('찾을 텍스트', { exact: true });
const button = (scope: Locator | Page, name: string) => scope.getByRole('button', { name, exact: true });
const activeMatch = '[data-document-find-active]';
const findMatch = '[data-document-find-match]';
const result = (panel: Locator, count: number, ordinal: number) => expect(panel.getByText(`${count}개 중 ${ordinal}번째`, { exact: true })).toBeVisible();
const synced = (page: Page) => expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');

test('360px에서 현재 문서의 표·접기·초안을 찾고 바꾼 본문을 되돌리고 저장한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(viewport);
  const f = await fixture(request);
  try {
    const included = await f.create('검색 검증의 포함 원문', body(paragraph(text('포함한 원문 Needle'))));
    const document = await f.create('본문 찾기 검증', body(
      { type: 'heading', attrs: { level: 1 }, content: [text('needle 안내')] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [
        paragraph(text('셀 '), { ...text('Need'), marks: [{ type: 'bold' }] }, text('le 값')),
      ] }] }] },
      fold('부록 접기', fold('세부 자료 접기', paragraph(text('접힌 Needle 예시')))),
      { type: 'documentInclude', attrs: { documentId: included.id, label: included.title } },
      paragraph(text('작업 중 본문')),
    ));
    const savedBeforeSearch = await f.current(document.id);
    await openDocument(page, document);

    const editor = page.locator('.docs-prose[contenteditable="true"]');
    const heading = editor.getByRole('heading', { name: 'needle 안내', exact: true });
    const cell = editor.locator('td');
    const outerFold = editor.locator('summary').filter({ hasText: '부록 접기' }).locator('..');
    const innerFold = editor.locator('summary').filter({ hasText: '세부 자료 접기' }).locator('..');
    const includedBody = editor.locator('.doc-included-content');
    const save = button(page, '저장');
    await expect(includedBody).toContainText('포함한 원문 Needle');
    await expect(cell.locator('strong')).toHaveText('Need');
    for (const target of [innerFold, outerFold]) {
      await target.locator(':scope > summary').click();
      await expect(target).toHaveJSProperty('open', false);
    }
    await expect(save).toBeDisabled();

    await heading.click();
    await editor.press('Control+f');
    const panel = findPanel(page);
    const query = findInput(panel);
    await expect(query).toBeFocused();
    const panelBounds = await panel.boundingBox();
    expect(panelBounds?.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds ? panelBounds.x + panelBounds.width : viewport.width + 1).toBeLessThanOrEqual(viewport.width);
    await query.fill('Needle');
    await result(panel, 3, 1);
    await expect(heading.locator(activeMatch)).toHaveText('needle');
    await expect(includedBody.locator(findMatch)).toHaveCount(0);

    await button(panel, '다음 결과').click();
    await result(panel, 3, 2);
    await expect(cell.locator(activeMatch).first()).toBeVisible();
    await expect(outerFold).toHaveJSProperty('open', false);
    await button(panel, '다음 결과').click();
    await result(panel, 3, 3);
    await expect(outerFold).toHaveJSProperty('open', true);
    await expect(innerFold).toHaveJSProperty('open', true);
    await expect(innerFold.locator(activeMatch)).toHaveText('Needle');
    await expect(innerFold.locator(activeMatch)).toBeInViewport();
    await query.press('Enter');
    await result(panel, 3, 1);
    await query.press('Shift+Enter');
    await result(panel, 3, 3);
    await button(panel, '이전 결과').click();
    await result(panel, 3, 2);
    await expect(save).toBeDisabled();
    expect(await f.current(document.id)).toEqual(savedBeforeSearch);

    const caseSensitive = panel.getByLabel('대소문자 구분', { exact: true });
    await caseSensitive.click();
    await expect(heading.locator(findMatch)).toHaveCount(0);
    await expect(panel.getByText(/^2개 중 [12]번째$/u)).toBeVisible();
    await caseSensitive.click();
    await query.press('Escape');
    await expect(panel).toBeHidden();
    await expect(editor.locator(findMatch)).toHaveCount(0);
    await expect(save).toBeDisabled();

    await editor.locator(':scope > p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' 임시 Needle');
    await expect(save).toBeEnabled();
    await button(page, '본문에서 찾기').click();
    await query.fill('임시 Needle');
    await result(panel, 1, 1);
    expect(await f.current(document.id)).toEqual(savedBeforeSearch);

    await button(panel, '바꾸기 열기').click();
    const replacement = panel.getByLabel('바꿀 텍스트', { exact: true });
    await replacement.fill('초안 확정');
    await button(panel, '현재 결과 바꾸기').click();
    await expect(editor.locator(':scope > p').last()).toHaveText('작업 중 본문 초안 확정');
    await query.fill('Needle');
    await expect(panel.getByText(/^3개 중 [1-3]번째$/u)).toBeVisible();
    await replacement.fill('기준값');
    await button(panel, '모두 바꾸기').click();
    await expect(editor.getByRole('heading', { name: '기준값 안내', exact: true })).toBeVisible();
    await expect(cell).toHaveText('셀 기준값 값');
    await expect(innerFold.locator('p')).toHaveText('접힌 기준값 예시');
    await expect(includedBody).toContainText('포함한 원문 Needle');
    await button(panel, '찾기 닫기').click();
    await editor.press('Control+z');
    await expect(cell).toHaveText('셀 Needle 값');
    await expect(cell.locator('strong')).toHaveText('Need');
    await expect(innerFold.locator('p')).toHaveText('접힌 Needle 예시');
    await expect(heading).toBeVisible();
    await expect(editor.locator(':scope > p').last()).toHaveText('작업 중 본문 초안 확정');

    await save.click();
    await expect(save).toBeDisabled();
    const stored = await f.current(document.id);
    expect(stored.version).toBe(savedBeforeSearch.version + 1);
    expect(stored.content.content?.slice(0, -1)).toEqual(savedBeforeSearch.content.content?.slice(0, -1));
    expect(stored.content.content?.at(-1)).toEqual(paragraph(text('작업 중 본문 초안 확정')));
    expect(JSON.stringify(stored.content)).not.toContain('data-document-find');
  } finally { await f.cleanup(); }
});

test('공동 편집 중 찾기 위치가 다른 작업자의 변경을 따라가고 바꾼 문장이 동기화된다', async ({ browser, baseURL, request }) => {
  test.setTimeout(90_000);
  const f = await fixture(request);
  const contexts = await Promise.all(f.users.slice(0, 2).map(async user => {
    const context = await browser.newContext({ baseURL, viewport });
    await context.addInitScript(id => localStorage.setItem('teamspace.actor', id), user.id);
    return context;
  }));
  try {
    expect(contexts).toHaveLength(2);
    const document = await f.create('공동 편집 본문 찾기 검증', body(paragraph(text('처음 표식 끝'))));
    const enable = await request.post(`/api/documents/${document.id}/collaboration/enable`, { data: { expectedVersion: document.version } });
    expect(enable.ok(), await enable.text()).toBe(true);
    const [author, peer] = await Promise.all(contexts.map(context => context.newPage()));
    for (const page of [author, peer]) await openDocument(page, document);
    await Promise.all([synced(author), synced(peer)]);
    const authorBody = author.locator('.docs-live-prose[contenteditable="true"]');
    const peerBody = peer.locator('.docs-live-prose[contenteditable="true"]');
    const savedBeforeSearch = await f.current(document.id);
    await button(author, '본문에서 찾기').click();
    const panel = findPanel(author);
    await findInput(panel).fill('표식');
    await result(panel, 1, 1);
    await expect(authorBody.locator(activeMatch)).toHaveText('표식');
    await expect(peerBody.locator(findMatch)).toHaveCount(0);
    expect(await f.current(document.id)).toEqual(savedBeforeSearch);

    await peerBody.press('Control+Home');
    await peer.keyboard.insertText('동료가 앞에 추가 ');
    await peerBody.press('Control+End');
    await peer.keyboard.insertText(' 또 다른 표식');
    await expect(authorBody).toHaveText('동료가 앞에 추가 처음 표식 끝 또 다른 표식');
    await result(panel, 2, 1);
    await button(panel, '바꾸기 열기').click();
    await panel.getByLabel('바꿀 텍스트', { exact: true }).fill('확정');
    await button(panel, '현재 결과 바꾸기').click();
    const replaced = '동료가 앞에 추가 처음 확정 끝 또 다른 표식';
    const original = '동료가 앞에 추가 처음 표식 끝 또 다른 표식';
    async function durable(text: string) {
      await expect(authorBody).toHaveText(text);
      await expect(peerBody).toHaveText(text);
      await Promise.all([synced(author), synced(peer)]);
      await expect.poll(async () => (await f.current(document.id)).plainText).toBe(text);
    }
    await durable(replaced);
    await result(panel, 1, 1);
    await expect(peerBody.locator(findMatch)).toHaveCount(0);

    await button(panel, '찾기 닫기').click();
    await authorBody.press('Control+z');
    await durable(original);
    await authorBody.press('Control+Shift+z');
    await durable(replaced);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await f.cleanup();
  }
});
