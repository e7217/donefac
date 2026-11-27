import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types';

const layoutSelector = '[data-donefac-node="documentColumnLayout"]';
const columnSelector = ':scope > [data-layout-grid] > [data-donefac-node="documentColumn"]';
const paragraph = (value?: string): RichContent => ({ type: 'paragraph', ...(value ? { content: [{ type: 'text', text: value }] } : {}) });
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });

async function createDocument(request: APIRequestContext, projectId: string, content: RichContent) {
  const created = await request.post('/api/documents', { data: { projectId, title: `다단 구역 검증 ${randomUUID().slice(0, 8)}`, content } });
  expect(created.status(), await created.text()).toBe(201);
  return await created.json() as DocPage;
}

async function archiveDocument(request: APIRequestContext, document: DocPage) {
  const deleted = await request.delete(`/api/documents/${document.id}`);
  expect(deleted.status(), await deleted.text()).toBe(200);
  const { trashEntryId } = await deleted.json() as { trashEntryId: string };
  expect((await request.delete(`/api/trash/${trashEntryId}`)).ok()).toBe(true);
}

async function columnsStack(layout: Locator) {
  const columns = layout.locator(columnSelector);
  const [left, right] = await Promise.all([columns.first().boundingBox(), columns.nth(1).boundingBox()]);
  return Boolean(left && right && Math.abs(left.x - right.x) < 1 && left.y + left.height <= right.y);
}

test('360px에서 다단 구역을 만들고 키보드로 나온 뒤 저장본을 읽고 순서대로 해제한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const { projects: [project] } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const source = await createDocument(request, project.id, body(paragraph('구역 앞의 본문'), paragraph()));
  const path = `/#/${project.id}/documents/${source.id}`;
  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(path);
    const editor = page.locator('.docs-prose[contenteditable="true"]');
    await editor.locator(':scope > p').last().click();
    await page.keyboard.insertText('/2cols');
    await expect(page.getByRole('group', { name: '블록 추가', exact: true }).getByRole('button', { name: '2단 구역', exact: true })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Enter');
    const firstLayout = editor.locator(layoutSelector).first();
    await expect(firstLayout).toHaveAttribute('data-layout-weights', '1,1');
    await expect(firstLayout).toHaveAttribute('data-layout-border', 'false');
    await expect.poll(() => columnsStack(firstLayout)).toBe(true);
    await page.keyboard.insertText('왼쪽 내용');
    const firstColumns = firstLayout.locator(columnSelector);
    await expect(firstColumns.first()).toHaveText('왼쪽 내용');
    await firstColumns.nth(1).locator('p').click();
    await page.keyboard.insertText('오른쪽 내용');
    await page.keyboard.press('Control+Shift+Enter');
    await page.keyboard.insertText('구역 다음 본문');
    await expect(editor.locator(':scope > p')).toHaveText(['구역 앞의 본문', '구역 다음 본문']);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect.poll(async () => {
      const [first, second] = await Promise.all([firstColumns.first().boundingBox(), firstColumns.nth(1).boundingBox()]);
      return Boolean(first && second && Math.abs(first.y - second.y) < 1 && Math.abs(first.width - second.width) < 1 && first.x + first.width <= second.x);
    }).toBe(true);

    await page.getByRole('button', { name: '3단 구역 삽입', exact: true }).click();
    const secondLayout = editor.locator(layoutSelector).nth(1);
    const secondColumns = secondLayout.locator(columnSelector);
    await expect(secondLayout).toHaveAttribute('data-layout-weights', '1,1,1');
    await expect(secondColumns).toHaveCount(3);
    await page.keyboard.insertText('첫 단');
    await expect(secondColumns.first()).toHaveText('첫 단');
    await secondColumns.last().locator('p').click();
    await page.keyboard.insertText('마지막 단');
    await page.getByRole('button', { name: '구역 다음 본문으로 이동', exact: true }).click();
    await page.keyboard.insertText('전체 뒤 본문');
    await expect(editor.locator(':scope > p')).toHaveText(['구역 앞의 본문', '구역 다음 본문', '전체 뒤 본문']);

    const saveResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${source.id}`) && response.request().method() === 'PATCH');
    await page.locator('.docs-save-button').click();
    const saved = await saveResponse;
    expect(saved.status(), await saved.text()).toBe(200);
    const savedDocument = await saved.json() as DocPage;
    expect(savedDocument.content.content?.map(node => node.type)).toEqual(['paragraph', 'documentColumnLayout', 'paragraph', 'documentColumnLayout', 'paragraph']);
    expect(savedDocument.plainText).toContain('왼쪽 내용\n오른쪽 내용');
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

    await page.reload();
    await expect(firstColumns).toHaveText(['왼쪽 내용', '오른쪽 내용']);
    await expect(secondColumns).toHaveText(['첫 단', '', '마지막 단']);
    const history = page.getByRole('button', { name: '이력', exact: true });
    if (!await history.isVisible()) await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await history.click();
    await page.locator('.docs-revision').filter({ hasText: `버전 ${savedDocument.version}` }).click();
    const historical = page.locator('.docs-history-preview').getByRole('group', { name: '문서 다단 구역', exact: true }).first();
    await expect(historical.locator(columnSelector)).toHaveText(['왼쪽 내용', '오른쪽 내용']);
    await expect.poll(() => columnsStack(historical)).toBe(true);

    await firstColumns.nth(1).locator('p').click();
    await page.keyboard.press('End');
    await page.getByRole('button', { name: '다단 구역 해제', exact: true }).click();
    await page.keyboard.insertText(' 유지');
    await expect(editor.locator(layoutSelector)).toHaveCount(1);
    await expect(editor.locator(':scope > p')).toHaveText(['구역 앞의 본문', '왼쪽 내용', '오른쪽 내용 유지', '구역 다음 본문', '전체 뒤 본문']);
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    await page.reload();
    await expect(editor.locator(layoutSelector)).toHaveCount(1);
    await expect(editor.locator(':scope > p')).toHaveText(['구역 앞의 본문', '왼쪽 내용', '오른쪽 내용 유지', '구역 다음 본문', '전체 뒤 본문']);
  } finally {
    await archiveDocument(request, source);
  }
});

test('공동 편집에서 경계를 가로질러 삭제하면 남은 단의 너비를 맞추고 실행 취소로 원래 비율을 복원한다', async ({ page, request, browser, baseURL }) => {
  test.setTimeout(65_000);
  const { projects: [project], users: [, peerUser] } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const source = await createDocument(request, project.id, body(paragraph('앞 본문'), {
    type: 'documentColumnLayout', attrs: { weights: [1, 3, 1], border: true },
    content: ['첫 단', '두 번째 단', '마지막 단'].map(value => ({ type: 'documentColumn', content: [paragraph(value)] })),
  }, paragraph('뒤 본문')));
  const other = await browser.newContext({ baseURL });
  try {
    const enabled = await request.post(`/api/documents/${source.id}/collaboration/enable`, { data: { expectedVersion: source.version } });
    expect(enabled.status(), await enabled.text()).toBe(200);
    const peer = await other.newPage();
    const path = `/#/${project.id}/documents/${source.id}`;
    await Promise.all([page.goto(path), peer.goto(path)]);
    await peer.getByLabel('작업자 선택', { exact: true }).selectOption(peerUser.id);
    const states = [page, peer].map(current => current.locator('.docs-collaboration-state'));
    await Promise.all(states.map(state => expect(state).toHaveText('서버에 동기화됨')));

    const editor = page.locator('.docs-live-prose[contenteditable="true"]');
    const layout = editor.locator(layoutSelector);
    const peerLayout = peer.locator(`.docs-live-prose ${layoutSelector}`);
    await expect(peerLayout).toHaveAttribute('data-layout-weights', '1,3,1');
    await editor.locator(':scope > p').first().click();
    await editor.evaluate(root => {
      const before = root.querySelector(':scope > p')?.firstChild;
      const second = root.querySelector('[data-layout-grid] > :nth-child(2) > p')?.firstChild;
      const selection = window.getSelection();
      if (!selection || !before || !second) throw new Error('다단 편집 범위를 찾지 못했습니다.');
      selection.setBaseAndExtent(before, before.textContent!.length, second, 0);
    });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain('첫 단');
    await page.keyboard.press('Delete');
    await expect(layout).toHaveAttribute('data-layout-weights', '1');
    await expect(peerLayout).toHaveAttribute('data-layout-weights', '1');
    await expect(peerLayout).toHaveAttribute('data-layout-border', 'true');
    await expect(peerLayout.locator(columnSelector)).toHaveText(['마지막 단']);
    await expect(editor.locator(':scope > p').first()).toHaveText('앞 본문두 번째 단');
    await expect(states[0]).toHaveText('서버에 동기화됨');

    await page.keyboard.press('Control+z');
    await expect(peerLayout).toHaveAttribute('data-layout-weights', '1,3,1');
    await expect(peerLayout.locator(columnSelector)).toHaveText(['첫 단', '두 번째 단', '마지막 단']);
    await peerLayout.locator(columnSelector).nth(1).locator('p').click();
    await peer.keyboard.press('End');
    await peer.keyboard.insertText(' 동료 수정');
    await expect(layout).toHaveAttribute('data-layout-weights', '1,3,1');
    await expect(layout.locator(columnSelector).nth(1)).toHaveText('두 번째 단 동료 수정');
    await expect(states[1]).toHaveText('서버에 동기화됨');
    await page.reload();
    await expect(editor.locator(layoutSelector).locator(columnSelector).nth(1)).toHaveText('두 번째 단 동료 수정');
  } finally {
    await other.close();
    await archiveDocument(request, source);
  }
});
