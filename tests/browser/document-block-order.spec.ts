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
    const toolbar = page.getByRole('toolbar', { name: '문서 서식' });
    const undo = toolbar.getByRole('button', { name: '실행 취소', exact: true });
    const redo = toolbar.getByRole('button', { name: '다시 실행', exact: true });
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await editor.getByText(introText, { exact: true }).click();
    await expect(action(page, '위로')).toBeDisabled();
    await editor.getByRole('cell', { name: '왼쪽 셀', exact: true }).click();
    await action(page, '위로').press('Enter');
    const firstOrder = [introText, tableText, headingText, checklistText];
    await expect.poll(() => order(page)).toEqual(firstOrder);
    await expect(editor).toBeFocused();
    expect(await editor.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('td')?.textContent)).toBe('왼쪽 셀');

    await undo.click();
    await expect.poll(() => order(page)).toEqual(original);
    await expect(undo).toBeDisabled();
    await expect(editor).toBeFocused();
    await redo.press('Enter');
    await expect.poll(() => order(page)).toEqual(firstOrder);
    await expect(redo).toBeDisabled();
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

test('공동 편집에서 블록을 옮겨도 같은 절의 동료 입력과 커서가 유지된다', async ({ page, browser, baseURL, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(viewport);
  const { document, section, users } = await fixture(request);
  const peerContext = await browser.newContext({ baseURL, viewport: { width: 1050, height: 840 } });
  const offlineContext = await browser.newContext({ baseURL, viewport });
  try {
    await page.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), users[0].id);
    await peerContext.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), users[1].id);
    await offlineContext.addInitScript(actor => localStorage.setItem('teamspace.actor', actor), users[2].id);
    const peer = await peerContext.newPage(), offline = await offlineContext.newPage();
    const enabled = await request.post(`/api/documents/${document.id}/collaboration/enable`, { data: { expectedVersion: document.version } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    const browsers = [page, peer, offline];
    const state = (tab: Page) => tab.locator('.docs-collaboration-state');
    const heading = (tab: Page) => tab.locator('.docs-live-prose').getByRole('heading', { name: new RegExp(headingText) });
    await Promise.all(browsers.map(tab => open(tab, document)));
    for (const tab of browsers) {
      await expect(state(tab)).toHaveText('서버에 동기화됨');
      await expect.poll(() => order(tab)).toEqual(original);
    }

    await heading(offline).click();
    await offline.keyboard.press('End');
    await offlineContext.setOffline(true);
    await expect(state(offline)).toHaveText('연결 끊김');
    await offline.keyboard.insertText(' 오프라인 편집');
    await expect(state(offline)).toHaveText('연결 끊김 · 편집 보관 중');
    await heading(peer).click();
    await peer.keyboard.press('Home');
    await heading(page).click();
    await expect(action(page, '아래로')).toBeEnabled();
    await action(page, '아래로').press('Enter');
    await expect.poll(() => order(peer)).toEqual([introText, tableText, headingText, checklistText]);
    const selection = (tab: Page) => tab.evaluate(() => ({
      block: window.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent,
      offset: window.getSelection()?.anchorOffset,
    }));
    await expect.poll(() => selection(peer)).toEqual({ block: headingText, offset: 0 });
    await peer.keyboard.insertText('동료 입력 ');
    const onlineHeading = `동료 입력 ${headingText}`;
    await expect(heading(page)).toHaveText(onlineHeading);
    await offlineContext.setOffline(false);
    const mergedHeading = `${onlineHeading} 오프라인 편집`;
    const moved = [introText, tableText, mergedHeading, checklistText];
    await expect(state(offline)).toHaveText('서버에 동기화됨');
    for (const tab of browsers) await expect.poll(() => order(tab)).toEqual(moved);

    const toolbar = page.getByRole('toolbar', { name: '문서 서식' });
    await toolbar.getByRole('button', { name: '실행 취소', exact: true }).press('Enter');
    await expect.poll(() => order(peer)).toEqual([introText, mergedHeading, tableText, checklistText]);
    await toolbar.getByRole('button', { name: '다시 실행', exact: true }).press('Enter');
    await expect.poll(() => order(peer)).toEqual(moved);

    // Top-level insertion still uses the visible order after a block move.
    await heading(page).click();
    await heading(page).evaluate(node => {
      const range = window.document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('옮긴 절 아래의 새 문단');
    const final = [introText, tableText, mergedHeading, '옮긴 절 아래의 새 문단', checklistText];
    for (const tab of browsers) await expect.poll(() => order(tab)).toEqual(final);
    await expect(state(page)).toHaveText('서버에 동기화됨');
    await expect.poll(async () => {
      const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
      const body = workspace.documents.find(item => item.id === document.id)?.content.content ?? [];
      return body.slice(0, 5).map(block => [block.type, block.attrs?.sectionId ?? null]);
    }).toEqual([['paragraph', null], ['table', null], ['heading', section], ['paragraph', null], ['taskList', null]]);
    await peer.reload();
    await expect.poll(() => order(peer)).toEqual(final);
  } finally {
    await Promise.all([peerContext.close(), offlineContext.close()]);
    await cleanup(request, document.id);
  }
});
