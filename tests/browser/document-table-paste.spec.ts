import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { DocPage, WorkspaceSnapshot } from '../../shared/types';

const viewport = { width: 360, height: 820 };
const labels = ['처음 선택한 단락', '표를 넣을 단락', '아래에 남길 단락'];

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

async function fixture(request: APIRequestContext) {
  const state = await workspace(request);
  const page = await json<DocPage>(await request.post('/api/documents', { data: {
    title: `팀 표 붙여넣기 ${randomUUID().slice(0, 8)}`, projectId: state.projects[0].id,
    content: { type: 'doc', content: labels.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) },
  } }), 201);
  const saved = async () => (await workspace(request)).documents.find(document => document.id === page.id)!;
  return {
    page, users: state.users, saved,
    async purge() {
      const current = await saved();
      if (!current) return;
      const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(`/api/documents/${page.id}?expectedVersion=${current.version}`));
      await json(await request.delete(`/api/trash/${trashEntryId}`));
    },
  };
}

async function openDocument(browser: Page, document: DocPage) {
  await browser.goto(`/#/${document.projectId}/documents/${document.id}`);
  await expect(browser.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title, { timeout: 35_000 });
}

const editor = (page: Page) => page.locator('.docs-prose[contenteditable=true]');
const paragraph = (page: Page, label: string) => editor(page).locator(':scope > p').filter({ hasText: label });
const pasteButton = (page: Page) => page.getByRole('button', { name: '표 데이터 붙여넣기', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: '표 데이터 붙여넣기', exact: true });
const input = (page: Page) => dialog(page).getByRole('textbox', { name: '표 데이터', exact: true });
const table = (page: Page) => editor(page).locator('table');
const undo = (page: Page) => page.getByRole('button', { name: '실행 취소', exact: true });
const synchronized = (page: Page) => expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');

test('360px에서 표 데이터만 검토하고 선택 위치를 바꿔 서식 있는 문서에 표 한 장을 추가한다', async ({ page, context, request }) => {
  test.setTimeout(80_000);
  await page.setViewportSize(viewport);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const f = await fixture(request);
  try {
    await openDocument(page, f.page);
    await paragraph(page, labels[0]).click();
    await pasteButton(page).click();
    await expect(input(page)).toBeFocused();
    await input(page).fill('망가진 데이터\t"닫히지 않은 값');
    const insert = dialog(page).getByRole('button', { name: '표 삽입', exact: true });
    await expect(dialog(page).getByRole('alert')).toContainText('닫히지 않은 큰따옴표');
    await expect(insert).toBeDisabled();
    const spreadsheet = '제목\t설명\t상태\n"문서 ""검사"""\t"여러 줄\n텍스트 그대로"\t\n다음\t<code>그대로</code>';
    await input(page).fill('');
    await page.evaluate(text => navigator.clipboard.writeText(text), spreadsheet);
    await input(page).press('Control+V');
    await expect(dialog(page).getByRole('status')).toHaveText('3행 · 3열');
    await expect(dialog(page).getByRole('columnheader', { name: '상태', exact: true })).toBeVisible();
    await expect(dialog(page).locator('td code')).toHaveCount(0);
    const bounds = await dialog(page).boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.width + bounds!.x).toBeLessThanOrEqual(viewport.width);
    await expect(table(page)).toHaveCount(0);

    const header = dialog(page).getByRole('checkbox', { name: '첫 행을 머리글로 사용' });
    await header.uncheck();
    await expect(dialog(page).getByRole('columnheader')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: '다른 위치 선택', exact: true }).click();
    await paragraph(page, labels[1]).click();
    await page.getByRole('button', { name: '이 위치에서 표 검토', exact: true }).click();
    await expect(input(page)).toHaveValue(spreadsheet);
    await expect(header).not.toBeChecked();
    await header.check();
    await insert.click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(table(page).locator('th')).toHaveText(['제목', '설명', '상태']);
    await expect(table(page).locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1);
    await expect(table(page).locator('td').last()).toBeEmpty();
    await expect(table(page).locator('td code')).toHaveCount(0);
    await undo(page).click();
    await expect(table(page)).toHaveCount(0);
    await expect(editor(page).locator(':scope > p').nth(2)).toHaveText(labels[2]);
    await page.getByRole('button', { name: '다시 실행', exact: true }).click();
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    const saved = await f.saved();
    expect(saved.content.content?.slice(0, 4).map(node => node.type)).toEqual(['paragraph', 'paragraph', 'table', 'paragraph']);
    await page.reload();
    await expect(table(page).locator('tbody td').nth(4)).toHaveText('<code>그대로</code>');
  } finally {
    await f.purge();
  }
});

test('공동 편집에서 동료가 고치고 옮긴 블록을 따라가 표만 삽입하고 되돌린다', async ({ browser, baseURL, request }) => {
  test.setTimeout(105_000);
  const f = await fixture(request);
  const contexts = await Promise.all(f.users.slice(0, 2).map(async user => {
    const context = await browser.newContext({ viewport, baseURL });
    await context.addInitScript(actor => localStorage.setItem('donefac.actor', actor), user.id);
    return context;
  }));
  try {
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([openDocument(a, f.page), openDocument(b, f.page)]);
    await a.getByRole('button', { name: '공동 편집 시작', exact: true }).click();
    await Promise.all([synchronized(a), synchronized(b)]);
    await a.bringToFront();
    await paragraph(a, labels[1]).click();
    await pasteButton(a).click();
    await input(a).fill('항목\t계획\nA\t해야 할 일');

    await b.bringToFront();
    await paragraph(b, labels[1]).click();
    await b.keyboard.press('End');
    await b.keyboard.insertText(' · 동료가 추가한 본문');
    await synchronized(b);
    await b.getByRole('button', { name: '블록 위로 이동', exact: true }).click();
    await expect(editor(a).locator(':scope > p').first()).toContainText(labels[1]);
    await expect(paragraph(a, labels[1])).toContainText('동료가 추가한 본문');
    await a.bringToFront();
    await expect(input(a)).toHaveValue('항목\t계획\nA\t해야 할 일');
    await dialog(a).getByRole('button', { name: '표 삽입', exact: true }).click();
    await expect(table(b).locator('th')).toHaveText(['항목', '계획']);
    await synchronized(a);
    expect((await f.saved()).content.content?.slice(0, 4).map(node => node.type)).toEqual(['paragraph', 'table', 'paragraph', 'paragraph']);

    await undo(a).click();
    await expect(table(b)).toHaveCount(0);
    await expect(paragraph(b, labels[1])).toContainText('동료가 추가한 본문');
    await synchronized(a);
    const saved = await f.saved();
    expect(saved.content.content?.some(node => node.type === 'table')).toBe(false);
    expect(saved.content.content?.[0].content?.[0].text).toContain(labels[1]);
    expect(saved.plainText).toContain('동료가 추가한 본문');
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await f.purge();
  }
});
