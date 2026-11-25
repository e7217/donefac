import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { documentSectionHash } from '../../shared/document-sections';
import type { DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types';

const viewport = { width: 360, height: 820 };
const headingText = '연결된 검토 절';
const tableText = '표 머리글';
const checklistText = '체크리스트 항목';
const introText = '첫 문단';
const original = [introText, headingText, tableText, checklistText];
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });

async function fixture(request: APIRequestContext) {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const section = randomUUID();
  const response = await request.post('/api/documents', { data: {
    projectId: workspace.projects[0].id, title: `본문 블록 순서 ${randomUUID().slice(0, 8)}`,
    content: { type: 'doc', content: [
      paragraph(introText),
      { type: 'heading', attrs: { level: 2, sectionId: section }, content: [{ type: 'text', text: headingText }] },
      { type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2 }, content: [paragraph(tableText)] }] },
        { type: 'tableRow', content: ['왼쪽 셀', '오른쪽 셀'].map(text => ({ type: 'tableCell', content: [paragraph(text)] })) },
      ] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph(checklistText)] }] },
    ] },
  } });
  expect(response.status(), await response.text()).toBe(201);
  return { document: await response.json() as DocPage, section, users: workspace.users };
}

async function cleanup(request: APIRequestContext, id: string) {
  const removed = await request.delete(`/api/documents/${id}`);
  if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
}

async function open(page: Page, document: DocPage) {
  await page.goto(`/#/${document.projectId}/documents/${document.id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);
}

function order(page: Page) {
  return page.locator('.docs-prose > *').evaluateAll(nodes => {
    while (nodes.at(-1)?.matches('p') && !nodes.at(-1)?.textContent) nodes.pop();
    return nodes.flatMap(node => {
      if (node.matches('p,h2')) return [node.textContent];
      if (node.querySelector('table')) return [node.querySelector('th')?.textContent];
      if (node.matches('ul')) return [node.querySelector('li p')?.textContent];
      return [];
    });
  });
}

function action(page: Page, direction: '위로' | '아래로') {
  return page.getByRole('group', { name: '본문 블록 순서', exact: true })
    .getByRole('button', { name: `블록 ${direction} 이동`, exact: true });
}

test('360px에서 표와 제목 블록을 이동하고 선택·절 링크·저장본을 유지한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize(viewport);
  const { document, section } = await fixture(request);
  try {
    await open(page, document);
    await expect.poll(() => order(page)).toEqual(original);
    const editor = page.locator('.docs-prose');
    await editor.getByText(introText, { exact: true }).click();
    await expect(action(page, '위로')).toBeDisabled();
    await editor.getByRole('cell', { name: '왼쪽 셀', exact: true }).click();
    await action(page, '위로').press('Enter');
    await expect.poll(() => order(page)).toEqual([introText, tableText, headingText, checklistText]);
    await expect(editor).toBeFocused();
    expect(await editor.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('td')?.textContent)).toBe('왼쪽 셀');

    await page.keyboard.press('Control+z');
    await expect.poll(() => order(page)).toEqual(original);
    await editor.getByRole('cell', { name: '왼쪽 셀', exact: true }).click();
    await action(page, '위로').click();
    await editor.getByRole('heading', { name: headingText, exact: true }).click();
    await action(page, '아래로').click();
    await expect(action(page, '아래로')).toBeDisabled();
    const finalOrder = [introText, tableText, checklistText, headingText];
    await expect.poll(() => order(page)).toEqual(finalOrder);

    const writing = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}`) && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    const saved = await writing;
    expect(saved.ok(), await saved.text()).toBe(true);
    const body = (await saved.json() as DocPage).content.content!;
    expect(body.slice(0, 4).map(node => node.type)).toEqual(['paragraph', 'table', 'taskList', 'heading']);
    expect(body.slice(4).every(node => node.type === 'paragraph' && !node.content?.length)).toBe(true);
    expect(body[1].content?.[0].content?.[0].attrs?.colspan).toBe(2);
    expect(body[2].content?.[0].attrs?.checked).toBe(true);
    expect(body[3].attrs?.sectionId).toBe(section);
    await page.goto(`/${documentSectionHash(document.id, section, document.projectId ?? undefined)}`);
    await page.reload();
    await expect.poll(() => order(page)).toEqual(finalOrder);
    await expect(editor.getByRole('heading', { name: headingText, exact: true })).toBeInViewport();
  } finally { await cleanup(request, document.id); }
});

test('공동 편집에서는 블록 이동 없이 같은 문단을 계속 편집한다', async ({ page, browser, baseURL, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize(viewport);
  const { document, section, users } = await fixture(request);
  const context = await browser.newContext({ baseURL, viewport });
  try {
    await context.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), users[1].id);
    const peer = await context.newPage();
    const enabled = await request.post(`/api/documents/${document.id}/collaboration/enable`, { data: { expectedVersion: document.version } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    await Promise.all([open(page, document), open(peer, document)]);
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expect.poll(() => order(peer)).toEqual(original);
    for (const browserPage of [page, peer]) {
      await browserPage.locator('.docs-live-prose').getByRole('heading', { name: headingText, exact: true }).click();
      await expect(browserPage.getByRole('group', { name: '본문 블록 순서', exact: true })).toHaveCount(0);
    }
    const updatedHeading = `${headingText} 공동 편집`;
    await peer.keyboard.press('End');
    await peer.keyboard.insertText(' 공동 편집');
    const edited = [introText, updatedHeading, tableText, checklistText];
    await expect.poll(() => order(page)).toEqual(edited);
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expect.poll(async () => {
      const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
      return workspace.documents.find(item => item.id === document.id)?.content.content?.[1].attrs?.sectionId;
    }).toBe(section);
    await peer.reload();
    await expect.poll(() => order(peer)).toEqual(edited);
  } finally {
    await context.close();
    await cleanup(request, document.id);
  }
});
