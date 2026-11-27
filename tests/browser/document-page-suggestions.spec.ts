import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types';

const viewport = { width: 360, height: 820 };
const introduction = '참고 자료';
const secondParagraph = '검토 내용';
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const route = (doc: DocPage) => `#/${doc.projectId ?? 'all'}/documents/${doc.id}`;
const menu = (page: Page) => page.getByRole('group', { name: '문서 링크 검색', exact: true });
const editor = (page: Page) => page.locator('.docs-prose');

async function fixture(request: APIRequestContext) {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [original, destination] = workspace.projects;
  const query = randomUUID().slice(0, 8);
  const ids: string[] = [];
  const create = async (title: string, projectId: string | null, content: RichContent, parentId?: string) => {
    const response = await request.post('/api/documents', { data: { title, projectId, content, parentId } });
    expect(response.status(), await response.text()).toBe(201);
    const doc = await response.json() as DocPage;
    ids.push(doc.id);
    return doc;
  };
  const cleanup = async () => {
    for (const id of [...ids].reverse()) {
      const removed = await request.delete(`/api/documents/${id}`);
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
    }
  };
  try {
    const source = await create('문서 링크 작성', original.id, body(paragraph(introduction), paragraph(secondParagraph)));
    const parent = await create(`장비 기준 ${query}`, destination.id, body(paragraph('상위 문서')));
    const title = `검증 절차 ${query.toUpperCase()}`;
    const target = await create(title, destination.id, body(paragraph('팀 프로젝트 문서')), parent.id);
    const common = await create(title, null, body(paragraph('팀 공통 문서')));
    return { source, parent, target, common, query, destination, users: workspace.users, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function open(page: Page, doc: DocPage) {
  await page.goto(`/${route(doc)}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(doc.title);
}

async function endOfParagraph(page: Page, text: string) {
  await editor(page).getByText(text, { exact: true }).click();
  await page.keyboard.press('End');
}

test('360px에서 @로 프로젝트와 문서 경로를 검색하고 링크를 저장해 이동한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize(viewport);
  const { source, parent, target, common, query, destination, cleanup } = await fixture(request);
  try {
    await open(page, source);
    await endOfParagraph(page, introduction);
    await page.keyboard.insertText(' user@example.com ');
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.insertText('@');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.insertText('그대로 ');
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.insertText('@검증 ' + query);
    const projectOption = menu(page).getByRole('button', { name: `${target.title} ${destination.name} / ${parent.title}`, exact: true });
    const commonOption = menu(page).getByRole('button', { name: `${common.title} 팀 공통`, exact: true });
    await expect(projectOption).toBeVisible();
    await expect(commonOption).toBeVisible();
    const projectFirst = await projectOption.getAttribute('aria-current') === 'true';
    await page.keyboard.press('ArrowDown');
    await expect(projectFirst ? commonOption : projectOption).toHaveAttribute('aria-current', 'true');
    if (projectFirst) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.insertText('후속 기록');
    const link = editor(page).getByRole('link', { name: target.title, exact: true });
    await expect(link).toHaveAttribute('href', route(target));
    await expect(editor(page).locator('p').first()).toHaveText(`${introduction} user@example.com @그대로 ${target.title} 후속 기록`);

    await endOfParagraph(page, secondParagraph);
    await page.keyboard.insertText(` @팀 공통 ${query}`);
    await expect(menu(page).getByRole('button')).toHaveCount(1);
    await commonOption.click();
    await expect(editor(page).getByRole('link', { name: common.title, exact: true }).last()).toHaveAttribute('href', route(common));

    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    await page.reload();
    await editor(page).getByRole('link', { name: target.title, exact: true }).first().click();
    await expect(page).toHaveURL(url => url.hash === route(target));
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(target.title);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await page.getByRole('complementary', { name: '문서 상세 정보', exact: true }).getByRole('button', { name: '연결', exact: true }).click();
    const backlinks = page.locator('.docs-reference-list').filter({ hasText: '이 문서를 참조하는 문서' });
    await expect(backlinks.getByRole('button').filter({ hasText: source.title })).toContainText('내 문서에 링크함');
  } finally { await cleanup(); }
});

test('공동 편집 중 다른 사용자가 수정하면 열린 제안을 닫고 다시 삽입한 링크를 동기화한다', async ({ page, browser, baseURL, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize(viewport);
  const { source, target, query, destination, users, cleanup } = await fixture(request);
  const context = await browser.newContext({ baseURL, viewport });
  try {
    const enabled = await request.post(`/api/documents/${source.id}/collaboration/enable`, { data: { expectedVersion: source.version } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    await context.addInitScript(actor => localStorage.setItem('donefac.actor', actor), users[1].id);
    const peer = await context.newPage();
    await Promise.all([open(page, source), open(peer, source)]);
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await endOfParagraph(peer, secondParagraph);
    await endOfParagraph(page, introduction);
    await page.keyboard.insertText(` @${query}`);
    await expect(menu(page)).toBeVisible();
    await expect(editor(peer).locator('p').first()).toHaveText(`${introduction} @${query}`);
    await peer.keyboard.insertText(' 공동 편집');
    await expect(menu(page)).toHaveCount(0);
    await expect(editor(page).locator('p').last()).toHaveText(`${secondParagraph} 공동 편집`);
    await expect(editor(page).locator('p').first()).toHaveText(`${introduction} @${query}`);

    await endOfParagraph(page, `${introduction} @${query}`);
    await page.keyboard.insertText(` @${destination.name} ${query}`);
    await menu(page).getByRole('button').filter({ hasText: target.title }).click();
    await expect(editor(peer).getByRole('link', { name: target.title, exact: true })).toHaveAttribute('href', route(target));
    await expect(editor(peer).locator('p').first()).toHaveText(`${introduction} @${query} ${target.title}`);
    await expect(editor(peer).locator('p').last()).toHaveText(`${secondParagraph} 공동 편집`);
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await peer.reload();
    await expect(editor(peer).getByRole('link', { name: target.title, exact: true })).toHaveAttribute('href', route(target));
  } finally {
    await context.close();
    await cleanup();
  }
});
