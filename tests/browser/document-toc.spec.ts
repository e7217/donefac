import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import type { DocPage, DocumentPublicationView, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, RichContent, WorkspaceSnapshot } from '../../shared/types';

const firstHeading = '배포 계획';
const renamedHeading = '수정한 배포 계획';
const repeatedHeading = '점검 항목';
const text = (value: string): RichContent => ({ type: 'text', text: value });
const heading = (level: number, value: string): RichContent => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const fold = (label: string, content: RichContent): RichContent => ({
  type: 'details', content: [{ type: 'detailsSummary', content: [text(label)] }, { type: 'detailsContent', content: [content] }],
});

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as WorkspaceSnapshot;
}

async function removeDocument(request: APIRequestContext, id: string, headers: Record<string, string> = {}) {
  const response = await request.delete(`/api/documents/${id}`, { headers });
  expect(response.status(), await response.text()).toBe(200);
  const { trashEntryId } = await response.json() as { trashEntryId: string };
  const purged = await request.delete(`/api/trash/${trashEntryId}`, { headers });
  expect(purged.ok(), await purged.text()).toBe(true);
}

async function saveDocument(page: Page, id: string): Promise<DocPage> {
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/documents/${id}`) && response.request().method() === 'PATCH');
  await page.locator('.docs-save-button').click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  return await response.json() as DocPage;
}

const tocIn = (scope: Locator) => scope.getByRole('navigation', { name: '본문 목차', exact: true });
const headingInToc = (toc: Locator, label: string) => toc.getByRole('button', { name: label, exact: true });

async function ensureClosed(scope: Locator, name: string) {
  const summary = scope.locator('summary').filter({ hasText: name });
  const closed = summary.locator('..');
  if (await closed.evaluate(node => (node as HTMLDetailsElement).open)) await summary.click();
  await expect(closed).toHaveJSProperty('open', false);
  return closed;
}

test('360px 본문 목차는 같은 제목의 정확한 절을 열고 편집본과 고정 검토본의 목차를 구분한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const { projects: [project], users: [author, reviewer] } = await workspace(request);
  const headers = { 'X-Actor-Id': author.id };
  const created = await request.post('/api/documents', { headers, data: {
    projectId: project.id, title: `본문 목차 ${randomUUID().slice(0, 8)}`,
    content: { type: 'doc', content: [
      { type: 'paragraph' }, heading(1, firstHeading),
      fold('첫 점검', heading(2, repeatedHeading)), fold('두 번째 점검', fold('상세 점검', heading(2, repeatedHeading))),
    ] },
  } });
  expect(created.status(), await created.text()).toBe(201);
  const original = await created.json() as DocPage;

  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/documents/${original.id}`);
    const editor = page.locator('.docs-prose[contenteditable=true]');
    const title = editor.getByRole('heading', { name: firstHeading, exact: true, level: 1 });
    await expect(title).toBeVisible({ timeout: 25_000 });
    await editor.locator(':scope > p').first().click();
    await page.getByRole('button', { name: '본문 목차 삽입', exact: true }).click();
    const toc = tocIn(editor);
    await expect(headingInToc(toc, firstHeading)).toBeVisible();
    await expect(headingInToc(toc, `${repeatedHeading} (1/2)`)).toBeVisible();
    await expect(headingInToc(toc, `${repeatedHeading} (2/2)`)).toBeVisible();
    const options = editor.locator('[data-teamspace-node="documentToc"] summary');
    await options.click();
    await editor.getByRole('combobox', { name: '목차 배치', exact: true }).selectOption('flat');
    await expect(toc).toHaveAttribute('data-outline-layout', 'flat');
    const firstLevel = editor.getByRole('combobox', { name: '시작 제목 단계', exact: true });
    await firstLevel.selectOption('2');
    await expect(headingInToc(toc, firstHeading)).toHaveCount(0);
    await expect(headingInToc(toc, `${repeatedHeading} (2/2)`)).toBeVisible();
    await firstLevel.selectOption('1');
    await options.click();

    const inner = await ensureClosed(editor, '상세 점검');
    const second = await ensureClosed(editor, '두 번째 점검');
    const first = await ensureClosed(editor, '첫 점검');
    await headingInToc(toc, `${repeatedHeading} (2/2)`).click();
    await expect(first).toHaveJSProperty('open', false);
    await expect(second).toHaveJSProperty('open', true);
    await expect(inner).toHaveJSProperty('open', true);
    await expect(inner.getByRole('heading', { name: repeatedHeading, exact: true })).toBeInViewport();

    const saved = await saveDocument(page, original.id);
    expect(saved.content.content?.filter(node => node.type === 'documentToc')).toEqual([
      { type: 'documentToc', attrs: { minLevel: 1, maxLevel: 3, layout: 'flat' } },
    ]);
    expect(saved.plainText.split(repeatedHeading)).toHaveLength(3);
    const publicationPath = `/api/documents/${original.id}/publication`;
    const initialPublication = await request.get(publicationPath, { headers });
    expect(initialPublication.ok(), await initialPublication.text()).toBe(true);
    const initial = await initialPublication.json() as DocumentPublicationView;
    const submitted = await request.post(publicationPath, { headers, data: {
      action: 'request', expectedVersion: initial.version, workspaceGeneration: initial.workspaceGeneration,
      expectedDocumentVersion: saved.version, reviewerId: reviewer.id,
    } });
    expect(submitted.ok(), await submitted.text()).toBe(true);
    const review = await submitted.json() as DocumentPublicationView;
    expect(review.reviewRevision?.version).toBe(saved.version);

    await title.click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('수정한 ');
    await expect(headingInToc(toc, renamedHeading)).toBeVisible();
    await expect(headingInToc(toc, firstHeading)).toHaveCount(0);
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    const selection = () => page.evaluate(() => window.getSelection()?.toString());
    expect(await selection()).toBe(renamedHeading);
    await headingInToc(toc, `${repeatedHeading} (2/2)`).click();
    expect(await selection()).toBe(renamedHeading);

    const edited = await saveDocument(page, original.id);
    expect(edited.version).toBe(saved.version + 1);
    await page.reload();
    await expect(headingInToc(toc, renamedHeading)).toBeVisible();

    await page.getByLabel('작업자 선택', { exact: true }).selectOption(reviewer.id);
    await page.getByRole('button', { name: '검토·발행', exact: true }).click();
    const publication = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    await publication.getByRole('button', { name: '검토본 불러오기', exact: true }).click();
    const fixed = publication.getByRole('region', { name: '검토 고정본 내용', exact: true });
    const fixedToc = tocIn(fixed);
    await expect(headingInToc(fixedToc, firstHeading)).toBeVisible();
    await expect(headingInToc(fixedToc, renamedHeading)).toHaveCount(0);
    const fixedInner = await ensureClosed(fixed, '상세 점검');
    const fixedSecond = await ensureClosed(fixed, '두 번째 점검');
    const fixedFirst = await ensureClosed(fixed, '첫 점검');
    const actualTarget = fixedInner.getByRole('heading', { name: repeatedHeading, exact: true });
    await headingInToc(fixedToc, `${repeatedHeading} (2/2)`).press('Enter');
    await expect(fixedFirst).toHaveJSProperty('open', false);
    await expect(fixedSecond).toHaveJSProperty('open', true);
    await expect(actualTarget).toBeFocused();
    await expect(actualTarget).toBeInViewport();
  } finally {
    await removeDocument(request, original.id, headers);
  }
});

function confluenceExport(key: string, title: string) {
  const property = (name: string, value: string) => `<property name="${name}"><![CDATA[${value}]]></property>`;
  const reference = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`;
  const entity = (type: string, id: string, body: string) => `<object class="${type}"><id name="id">${id}</id>${body}</object>`;
  const storage = '<ac:structured-macro ac:name="toc">' +
    '<ac:parameter ac:name="type">flat</ac:parameter>' +
    '<ac:parameter ac:name="minLevel">2</ac:parameter>' +
    '<ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro>' +
    '<h1>머리말</h1><h2>운영 절차</h2><h3>세부 항목</h3>';
  const xml = '<hibernate-generic>' +
    entity('Space', '42', property('key', key) + property('name', title)) +
    entity('Page', '100', property('title', title) + property('version', '1') + reference('space', 'Space', '42') +
      property('creationDate', '2020-01-02 03:04:05.000') + property('lastModificationDate', '2020-01-03 03:04:05.000')) +
    entity('BodyContent', '200', property('body', storage) + reference('content', 'Page', '100') + property('bodyType', '2')) +
    '</hibernate-generic>';
  return zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]);
}

test('Confluence ZIP에서 이관한 본문 목차가 가로 배치와 제목 단계 선택을 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const key = `TOC${suffix}`, title = `이관한 운영 문서 ${suffix}`;
  const filename = `${key}.zip`;
  const upload = await request.post(`/api/legacy-import/packages?${new URLSearchParams({ filename, instanceKey: `wiki-${suffix}` })}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: confluenceExport(key, title),
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const source = await upload.json() as LegacyPackageSummary;
  let imported: DocPage | undefined;

  try {
    const response = await request.get(`/api/migrations/options?${new URLSearchParams({ packageId: source.id })}`);
    expect(response.ok(), await response.text()).toBe(true);
    const { defaultConfiguration } = await response.json() as MigrationOptions;
    const configuration = { ...defaultConfiguration, projects: defaultConfiguration.projects.map(mapping => ({ ...mapping, key, name: title })) };
    const proposed = await request.post('/api/migrations/preview', { data: { configuration } });
    expect(proposed.status(), await proposed.text()).toBe(201);
    const preview = await proposed.json() as MigrationPreview;
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    expect(preview.notices.some(notice => notice.code.includes('UNSUPPORTED_MACRO'))).toBe(false);
    const applied = await request.post(`/api/migrations/previews/${preview.id}/apply`, {
      data: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    });
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: receipt } = await applied.json() as MigrationApplyResult;
    imported = (await workspace(request)).documents.find(document => document.title === title && receipt.projectIds.includes(document.projectId ?? ''));
    expect(imported).toBeDefined();
    if (!imported) return;
    expect(imported.content.content?.[0]).toEqual({ type: 'documentToc', attrs: { minLevel: 2, maxLevel: 2, layout: 'flat' } });

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${imported.projectId}/documents/${imported.id}`);
    const editor = page.locator('.docs-prose[contenteditable=true]');
    const toc = tocIn(editor);
    const operation = headingInToc(toc, '운영 절차');
    await expect(operation).toBeVisible({ timeout: 25_000 });
    await expect(toc).toHaveAttribute('data-outline-layout', 'flat');
    await expect(headingInToc(toc, '머리말')).toHaveCount(0);
    await expect(headingInToc(toc, '세부 항목')).toHaveCount(0);
    await operation.click();
    await expect(editor.getByRole('heading', { name: '운영 절차', exact: true, level: 2 })).toBeInViewport();
    expect((await workspace(request)).documents.find(document => document.id === imported?.id)?.version).toBe(imported.version);
  } finally {
    if (imported) await removeDocument(request, imported.id);
    const deleted = await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});

test('공동 편집에서 만든 본문 목차가 다른 작업자의 제목 변경을 반영한다', async ({ page, request, browser, baseURL }) => {
  test.setTimeout(60_000);
  const { projects: [project], users: [author, collaborator] } = await workspace(request);
  const headers = { 'X-Actor-Id': author.id };
  const created = await request.post('/api/documents', { headers, data: {
    projectId: project.id, title: `공동 편집 본문 목차 ${randomUUID().slice(0, 8)}`,
    content: { type: 'doc', content: [{ type: 'paragraph' }, heading(1, firstHeading)] },
  } });
  expect(created.status(), await created.text()).toBe(201);
  const document = await created.json() as DocPage;
  const peerContext = await browser.newContext({ baseURL });
  try {
    const enabled = await request.post(`/api/documents/${document.id}/collaboration/enable`, { headers, data: { expectedVersion: document.version } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    const peer = await peerContext.newPage();
    const path = `/#/${project.id}/documents/${document.id}`;
    await Promise.all([page.goto(path), peer.goto(path)]);
    await peer.getByLabel('작업자 선택', { exact: true }).selectOption(collaborator.id);
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');

    const editor = page.locator('.docs-live-prose[contenteditable=true]');
    const peerEditor = peer.locator('.docs-live-prose[contenteditable=true]');
    const toc = tocIn(editor), peerToc = tocIn(peerEditor);
    await editor.locator(':scope > p').first().click();
    await page.keyboard.insertText('/toc');
    await page.getByRole('group', { name: '블록 추가', exact: true }).getByRole('button', { name: '본문 목차', exact: true }).click();
    await expect(headingInToc(peerToc, firstHeading)).toBeVisible();
    await peerEditor.getByRole('heading', { name: firstHeading, exact: true }).click();
    await peer.keyboard.press('Home');
    await peer.keyboard.insertText('수정한 ');
    await expect(headingInToc(toc, renamedHeading)).toBeVisible();
    await expect(headingInToc(toc, firstHeading)).toHaveCount(0);
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');

    await expect.poll(async () => {
      const current = (await workspace(request)).documents.find(item => item.id === document.id);
      return { content: current?.content, plainText: current?.plainText.trim() };
    }).toMatchObject({
      content: { content: expect.arrayContaining([{ type: 'documentToc', attrs: { minLevel: 1, maxLevel: 3, layout: 'list' } }]) },
      plainText: renamedHeading,
    });
  } finally {
    await peerContext.close();
    await removeDocument(request, document.id, headers);
  }
});
