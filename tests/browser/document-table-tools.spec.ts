import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type {
  DocPage, DocRevision, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview,
  RichContent, WorkspaceSnapshot,
} from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const viewport = { width: 360, height: 820 };
const horizontal = '가로 병합 머리글';
const vertical = '세로 병합 머리글';
const resultHeading = '검사 결과';
const first = '첫 번째 값';
const second = '두 번째 값';
const third = '세 번째 값';
const fourth = '네 번째 값';
const expectedOrder = [horizontal, resultHeading, vertical, first, second, third, fourth];

async function readJson<T>(response: Pick<APIResponse | Response, 'status' | 'json' | 'text'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const workspace = async (request: APIRequestContext) => readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));

async function canonical(request: APIRequestContext, id: string) {
  const value = (await workspace(request)).documents.find(document => document.id === id);
  expect(value).toBeDefined();
  return value!;
}

async function purgeDocument(request: APIRequestContext, id: string) {
  const current = (await workspace(request)).documents.find(document => document.id === id);
  if (!current) return;
  const { trashEntryId } = await readJson<{ trashEntryId: string }>(
    await request.delete(`/api/documents/${id}?expectedVersion=${current.version}`),
  );
  const purge = await request.delete(`/api/trash/${trashEntryId}`);
  expect(purge.ok(), await purge.text()).toBe(true);
}

const cell = (type: 'tableCell' | 'tableHeader', text: string, colspan = 1, rowspan = 1): RichContent => ({
  type, attrs: { colspan, rowspan }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const row = (...cells: RichContent[]): RichContent => ({ type: 'tableRow', content: cells });
const originalTable: RichContent = { type: 'table', content: [
  row(cell('tableHeader', horizontal, 2), cell('tableHeader', resultHeading)),
  row(cell('tableHeader', vertical, 1, 2), cell('tableCell', first), cell('tableCell', second)),
  row(cell('tableCell', third), cell('tableCell', fourth)),
] };
const originalBody: RichContent = { type: 'doc', content: [originalTable] };

function structure(content: RichContent) {
  const table = content.content?.find(node => node.type === 'table');
  expect(table).toBeDefined();
  return table!.content!.map(tableRow => tableRow.content!.map(value => [
    value.type, value.attrs?.colspan ?? 1, value.attrs?.rowspan ?? 1,
  ]));
}

const property = (name: string, value: string) => `<property name="${name}"><![CDATA[${value}]]></property>`;
const reference = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
const entity = (kind: string, id: string, content: string) => `<object class="${kind}"><id name="id">${id}</id>${content}</object>`;

async function importConfluenceTable(request: APIRequestContext, name: string, key: string) {
  const storage = '<table><tbody>' +
    `<tr><th colspan="2"><p><strong>${horizontal}</strong></p></th><th><p>${resultHeading}</p></th></tr>` +
    `<tr><th rowspan="2"><p><em>${vertical}</em></p></th><td><p>${first}</p></td><td><p>${second}</p></td></tr>` +
    `<tr><td><p>${third}</p></td><td><p>${fourth}</p></td></tr></tbody></table>`;
  const xml = '<hibernate-generic>' +
    entity('Space', '42', property('key', key) + property('name', name)) +
    entity('Page', '100', property('title', name) + property('version', '1') + reference('space', 'Space', '42') +
      property('creationDate', '2020-01-02T03:04:05Z') + property('lastModificationDate', '2020-01-03T03:04:05Z')) +
    entity('BodyContent', '8100', property('body', storage) + property('bodyType', '2') + reference('content', 'Page', '100')) +
    '</hibernate-generic>';
  const params = new URLSearchParams({ filename: `${key}.zip`, product: 'confluence', instanceKey: `tables-${key.toLowerCase()}` });
  return readJson<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${params}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]),
  }), 201);
}

async function openDocument(page: Page, { id, projectId, title }: DocPage) {
  await page.goto(`/#/${projectId}/documents/${id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title, { timeout: 35_000 });
}

const tools = (page: Page) => page.getByRole('group', { name: '표 편집', exact: true });
const action = (page: Page, name: string) => tools(page).getByRole('button', { name, exact: true });
const byText = (table: Locator, text: string) => table.locator('td, th').filter({ hasText: text });
const synced = (page: Page) => expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');

test('360px에서 Confluence 표의 병합과 머리글을 편집하고 되돌린 결과를 저장한다', async ({ page, request }) => {
  test.setTimeout(115_000);
  await page.setViewportSize(viewport);
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const title = `이관한 병합 표 ${suffix}`;
  const key = `TBL${suffix}`;
  const source = await importConfluenceTable(request, title, key);
  let imported: DocPage | undefined;
  try {
    const { defaultConfiguration } = await readJson<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${source.id}`));
    const configuration = { ...defaultConfiguration, projects: defaultConfiguration.projects.map(mapping => ({ ...mapping, key, name: title })) };
    const preview = await readJson<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    const { import: receipt } = await readJson<MigrationApplyResult>(await request.post(`/api/migrations/previews/${preview.id}/apply`, {
      data: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    }), 201);
    imported = (await workspace(request)).documents.find(document => receipt.projectIds.includes(document.projectId ?? '') && document.title === title);
    expect(imported).toBeDefined();
    expect(structure(imported!.content)).toEqual(structure(originalBody));
    await openDocument(page, imported!);

    const table = page.locator('.docs-prose[contenteditable=true] table');
    await expect(table.locator('th[colspan="2"] strong')).toHaveText(horizontal);
    await expect(table.locator('th[rowspan="2"] em')).toHaveText(vertical);
    await byText(table, vertical).click();
    await action(page, '첫 열 헤더 전환').click();
    await expect(table.locator('td[rowspan="2"] em')).toHaveText(vertical);
    await expect(table.locator('th[colspan="2"] strong')).toHaveText(horizontal);
    await byText(table, vertical).click();
    await action(page, '첫 열 헤더 전환').click();
    await expect(table.locator('th[rowspan="2"] em')).toHaveText(vertical);

    await byText(table, horizontal).click();
    await expect(action(page, '셀 병합')).toBeDisabled();
    await action(page, '셀 나누기').click();
    await expect(table.locator('th[colspan="2"]')).toHaveCount(0);
    await expect(table.locator('tr').first().locator('th')).toHaveCount(3);
    await expect(table.locator('tr').first().locator('th strong')).toHaveText(horizontal);
    await byText(table, resultHeading).click();
    await action(page, '첫 행 헤더 전환').click();
    await expect(table.locator('tr').first().locator('td').filter({ hasText: resultHeading })).toBeVisible();
    await byText(table, resultHeading).click();
    await action(page, '첫 행 헤더 전환').click();
    await expect(table.locator('tr').first().locator('th')).toHaveCount(3);

    await byText(table, first).click();
    await action(page, '셀 범위 시작').click();
    await expect(action(page, '여기까지 선택')).toBeDisabled();
    await action(page, '셀 범위 취소').click();
    await expect(action(page, '셀 범위 시작')).toBeEnabled();
    await action(page, '셀 범위 시작').click();
    await byText(table, second).click();
    await action(page, '여기까지 선택').click();
    await expect(table.locator('td.selectedCell')).toHaveCount(2);
    await action(page, '셀 병합').click();
    const merged = table.locator('td[colspan="2"]');
    await expect(merged.locator('p')).toHaveText([first, second]);
    await expect(page.locator('.docs-prose[contenteditable=true]')).toBeFocused();
    await page.keyboard.press('Control+z');
    await expect(merged).toHaveCount(0);
    await expect(table.locator('tr').nth(1).locator('td')).toHaveText([first, second]);
    await page.keyboard.press('Control+Shift+z');
    await expect(merged.locator('p')).toHaveText([first, second]);

    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    const saved = await canonical(request, imported!.id);
    expect(saved.version).toBeGreaterThan(imported!.version);
    expect(structure(saved.content)).toEqual([
      [['tableHeader', 1, 1], ['tableHeader', 1, 1], ['tableHeader', 1, 1]],
      [['tableHeader', 1, 2], ['tableCell', 2, 1]],
      [['tableCell', 1, 1], ['tableCell', 1, 1]],
    ]);
    const positions = expectedOrder.map(value => saved.plainText.indexOf(value));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    await page.reload();
    await expect(merged.locator('p')).toHaveText([first, second]);
    await expect(table.locator('th[rowspan="2"] em')).toHaveText(vertical);
    await expect(table.locator('tr').first().locator('th strong')).toHaveText(horizontal);

    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '문서 내보내기', exact: true }).click();
    await page.getByRole('button', { name: 'Markdown 내보내기', exact: true }).click();
    const markdown = await readFile(await (await downloading).path(), 'utf8');
    expect(markdown).toContain(`<th rowspan="2"><p><em>${vertical}</em></p></th>`);
    expect(markdown).toContain(`<td colspan="2"><p>${first}</p>&#10;<p>${second}</p></td>`);
  } finally {
    if (imported) await purgeDocument(request, imported.id);
    const discarded = await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
    expect(discarded.ok(), await discarded.text()).toBe(true);
  }
});

test('공동 편집에서 키보드로 셀을 선택하고 다른 편집자와 병합·분할을 공유한다', async ({ browser, baseURL, request }) => {
  test.setTimeout(110_000);
  const { users, projects: [project] } = await workspace(request);
  const created = await readJson<DocPage>(await request.post('/api/documents', { data: {
    projectId: project.id, title: `공동 편집 병합 표 ${randomUUID().slice(0, 8)}`, content: originalBody,
  } }), 201);
  const contexts = await Promise.all(users.slice(0, 2).map(async user => {
    const context = await browser.newContext({ baseURL, viewport: { width: 960, height: 880 } });
    await context.addInitScript(actor => localStorage.setItem('donefac.actor', actor), user.id);
    return context;
  }));
  try {
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([openDocument(a, created), openDocument(b, created)]);
    await a.getByRole('button', { name: '공동 편집 시작', exact: true }).click();
    await Promise.all([synced(a), synced(b)]);
    const aTable = a.locator('.docs-live-prose table');
    const bTable = b.locator('.docs-live-prose table');
    await expect(aTable.locator('th[rowspan="2"]')).toHaveText(vertical);
    await expect(bTable.locator('th[rowspan="2"]')).toHaveText(vertical);

    await a.bringToFront();
    await byText(aTable, vertical).click();
    await action(a, '셀 나누기').click();
    await expect(bTable.locator('th[rowspan="2"]')).toHaveCount(0);
    await expect(bTable.locator('tr').nth(2).locator('th')).toHaveCount(1);
    await Promise.all([synced(a), synced(b)]);

    await b.bringToFront();
    await byText(bTable, first).click();
    await action(b, '셀 범위 시작').press('Enter');
    await expect(b.locator('.docs-live-prose')).toBeFocused();
    await b.keyboard.press('Shift+ArrowRight');
    await expect(bTable.locator('td.selectedCell')).toHaveCount(2);
    await b.keyboard.press('Shift+Tab');
    await expect(action(b, '셀 병합')).toBeFocused();
    await b.keyboard.press('Enter');
    await expect(aTable.locator('td[colspan="2"] p')).toHaveText([first, second]);
    await expect(bTable.locator('td[colspan="2"] p')).toHaveText([first, second]);
    await Promise.all([synced(a), synced(b)]);
    const saved = await canonical(request, created.id);
    expect(saved.version).toBeGreaterThan(created.version);
    expect(structure(saved.content)).toEqual([
      [['tableHeader', 2, 1], ['tableHeader', 1, 1]],
      [['tableHeader', 1, 1], ['tableCell', 2, 1]],
      [['tableHeader', 1, 1], ['tableCell', 1, 1], ['tableCell', 1, 1]],
    ]);
    const checkpointResponse = b.waitForResponse(response => new URL(response.url()).pathname === `/api/documents/${created.id}/checkpoint` &&
      response.request().method() === 'POST');
    await b.getByRole('button', { name: '버전 기록', exact: true }).click();
    const checkpoint = await readJson<DocRevision>(await checkpointResponse);
    expect(checkpoint.content).toEqual(saved.content);
    await a.reload();
    await synced(a);
    await expect(aTable.locator('td[colspan="2"] p')).toHaveText([first, second]);
    await expect(aTable.locator('th[colspan="2"]')).toHaveText(horizontal);
    await expect(aTable.locator('th[rowspan="2"]')).toHaveCount(0);
    expect((await canonical(request, created.id)).content).toEqual(saved.content);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await purgeDocument(request, created.id);
  }
});
