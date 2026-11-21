import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { COLLABORATION_SCHEMA, type CollaborationSession } from '../../shared/collaboration';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes';
import type { DocPage, DocumentPublicationView, RichContent, WorkspaceSnapshot } from '../../shared/types';

const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const documentBody = (...content: RichContent[]): RichContent => ({ type: 'doc', content });

async function expectJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

async function createFixture(request: APIRequestContext) {
  const workspace = await expectJson<WorkspaceSnapshot>(await request.get('/api/workspace'), 200);
  const [author, reviewer] = workspace.users;
  const { id: projectId } = workspace.projects[0];
  const headers = { 'X-Actor-Id': author.id };
  const suffix = randomUUID().slice(0, 8);
  const created: string[] = [];

  async function create(title: string, text: string, parentId: string | null = null) {
    const createdDocument = await expectJson<DocPage>(await request.post('/api/documents', {
      headers, data: { projectId, parentId, title: `${title} ${suffix}`, content: documentBody(paragraph(text)) },
    }), 201);
    created.push(createdDocument.id);
    return createdDocument;
  }

  async function close() {
    for (const id of created.reverse()) {
      const response = await request.delete(`/api/documents/${id}`, { headers });
      if (response.ok()) {
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
  }
  return { author, reviewer, headers, suffix, create, close };
}

async function openDocument(page: Page, document: DocPage) {
  await page.goto(`/#/${document.projectId}/documents/${document.id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title, { timeout: 50_000 });
}

test('360px에서 숨긴 발췌를 포함하고 원본 변경과 발행 당시의 참조를 확인한다', async ({ page, request }) => {
  test.setTimeout(105_000);
  const { author, reviewer, headers, suffix, create, close } = await createFixture(request);
  const editor = page.locator('.docs-prose[contenteditable=true]');
  const referenceRefresh = page.getByRole('button', { name: '참조 새로고침', exact: true });

  async function save(document: DocPage) {
    const pending = page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/documents/${document.id}` && response.request().method() === 'PATCH');
    await page.locator('.docs-save-button').click();
    const response = await pending;
    const saved = await expectJson<DocPage>(response, 200);
    expect(response.request().postDataJSON().contentSchemaVersion).toBe(DOCUMENT_CONTENT_SCHEMA_VERSION);
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    return saved;
  }

  async function updateSource(document: DocPage, content: RichContent) {
    return expectJson<DocPage>(await request.patch(`/api/documents/${document.id}`, {
      headers, data: { expectedVersion: document.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content },
    }), 200);
  }

  async function publish(document: DocPage) {
    const endpoint = `/api/documents/${document.id}/publication`;
    const current = await expectJson<DocumentPublicationView>(await request.get(endpoint, { headers }), 200);
    const review = await expectJson<DocumentPublicationView>(await request.post(endpoint, { headers, data: {
      action: 'request', expectedVersion: current.version, workspaceGeneration: current.workspaceGeneration,
      expectedDocumentVersion: current.documentVersion, reviewerId: reviewer.id,
    } }), 200);
    await expectJson<DocumentPublicationView>(await request.post(endpoint, {
      headers: { 'X-Actor-Id': reviewer.id }, data: {
        action: 'publish', expectedVersion: review.version, workspaceGeneration: review.workspaceGeneration,
      },
    }), 200);
  }

  try {
    const outside = `원문에서만 읽는 내용 ${suffix}`;
    const excerpt = `반복 사용하는 배포 기준 ${suffix}`;
    const changedExcerpt = `개정한 배포 기준 ${suffix}`;
    const laterDefinition = `다음 발췌 정의 ${suffix}`;
    const source = await create('공통 배포 원본', outside);
    const sourceChild = await create('원본의 하위 문서', '원본 하위의 본문', source.id);
    const host = await create('서비스 배포 절차', `포함 문서의 자체 내용 ${suffix}`);
    const hostChild = await create('포함 문서의 하위 문서', '포함 하위의 본문', host.id);
    const withoutExcerpt = await create('발췌가 없는 참고 문서', '일반 본문만 있는 문서');
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), author.id);
    await openDocument(page, source);
    await expect(editor).toBeVisible();

    await editor.getByText(outside, { exact: true }).click();
    await page.keyboard.press('End');
    await page.getByRole('button', { name: '발췌 구역 삽입', exact: true }).click();
    const definition = editor.locator('[data-teamspace-node="documentExcerpt"]');
    await definition.locator('[data-node-view-content] p').first().click();
    await page.getByRole('button', { name: '굵게', exact: true }).click();
    await page.keyboard.insertText(excerpt);
    const hidden = definition.getByRole('checkbox', { name: '원본에서 숨기기', exact: true });
    await hidden.check();
    await expect(hidden).toBeChecked();
    await expect(definition.locator('[data-node-view-content] strong')).toHaveText(excerpt);

    const savedSource = await save(source);
    expect(savedSource.content.content).toContainEqual(paragraph(outside));
    const savedDefinition = savedSource.content.content?.find(block => block.type === 'documentExcerpt');
    expect(savedDefinition?.attrs).toEqual({ hidden: true });
    expect(savedDefinition?.content).toEqual([{
      type: 'paragraph', content: [{ type: 'text', text: excerpt, marks: [{ type: 'bold' }] }],
    }]);

    await openDocument(page, host);
    await page.getByRole('button', { name: '발췌 포함 삽입', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '문서 발췌 포함', exact: true });
    const search = chooser.getByRole('textbox', { name: '참조할 항목 검색', exact: true });
    const results = chooser.locator('.doc-reference-results');
    await search.fill(withoutExcerpt.title);
    await expect(results.getByRole('button')).toHaveCount(0);
    await search.fill(source.title);
    await chooser.getByRole('checkbox', { name: '원본 안내 숨기기', exact: true }).check();
    await results.getByRole('button').filter({ hasText: source.title }).click();
    await expect(chooser).toBeHidden();
    const included = editor.getByRole('region', { name: `발췌한 문서 ${source.title}`, exact: true });
    const sourceButton = `포함 문서 원본 열기 ${source.title}`;
    await expect(included.locator('strong')).toHaveText(excerpt);
    await expect(included).not.toContainText(outside);
    await expect(included.getByRole('button', { name: sourceButton, exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '문서 포함 삽입', exact: true }).click();
    const fullChooser = page.getByRole('dialog', { name: '문서 포함 삽입', exact: true });
    await fullChooser.getByRole('textbox', { name: '참조할 항목 검색', exact: true }).fill(source.title);
    await fullChooser.locator('.doc-reference-results').getByRole('button').filter({ hasText: source.title }).click();
    const fullDocument = editor.getByRole('region', { name: `포함된 문서 ${source.title}`, exact: true });
    await expect(fullDocument).toContainText(outside);
    await expect(fullDocument).not.toContainText(excerpt);
    await expect(fullDocument.getByRole('button', { name: sourceButton, exact: true })).toBeVisible();

    const savedHost = await save(host);
    expect(savedHost.content.content).toContainEqual({ type: 'documentExcerptInclude', attrs: {
      documentId: source.id, label: source.title, noPanel: true,
    } });
    expect(savedHost.plainText).not.toContain(excerpt);
    await publish(savedHost);
    const beforeRefresh = await expectJson<WorkspaceSnapshot>(await request.get('/api/workspace'), 200);

    const changedSource = await updateSource(savedSource, documentBody(
      paragraph(outside),
      { type: 'documentExcerpt', attrs: { hidden: true }, content: [
        paragraph(changedExcerpt),
        { type: 'documentChildList', attrs: { scope: 'current', title: '원본 기준 하위 문서' } },
      ] },
      { type: 'documentExcerpt', attrs: { hidden: false }, content: [paragraph(laterDefinition)] },
    ));
    await referenceRefresh.click();
    await expect(included).toContainText(changedExcerpt);
    await expect(included).not.toContainText(excerpt);
    await expect(included).not.toContainText(outside);
    await expect(included).not.toContainText(laterDefinition);
    await expect(included.getByRole('link', { name: sourceChild.title, exact: true })).toBeVisible();
    await expect(included.getByRole('link', { name: hostChild.title, exact: true })).toHaveCount(0);
    await expect(fullDocument).not.toContainText(changedExcerpt);
    await expect(fullDocument).toContainText(laterDefinition);
    const afterRefresh = await expectJson<WorkspaceSnapshot>(await request.get('/api/workspace'), 200);
    expect(afterRefresh.documents.find(document => document.id === host.id)?.version)
      .toBe(beforeRefresh.documents.find(document => document.id === host.id)?.version);

    await page.getByRole('button', { name: '검토·발행', exact: true }).click();
    const publication = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    await publication.getByRole('button', { name: '발행본 불러오기', exact: true }).click();
    const snapshot = publication.getByRole('region', { name: '발행 고정본 내용', exact: true });
    await expect(snapshot).toContainText('문서 발췌 포함');
    await expect(snapshot).toContainText(source.title);
    await expect(snapshot).not.toContainText(excerpt);
    await expect(snapshot).not.toContainText(changedExcerpt);
    await publication.getByRole('button', { name: '검토·발행 닫기', exact: true }).click();

    await page.reload();
    await expect(included).toContainText(changedExcerpt);
    await updateSource(changedSource, documentBody(paragraph(outside)));
    await referenceRefresh.click();
    await expect(editor.locator('.doc-include-notice').filter({ hasText: '발췌 구역을 찾을 수 없습니다' })).toBeVisible();
    await expect(included).toHaveCount(0);
    await expect(fullDocument).toContainText(outside);
  } finally {
    await close();
  }
});

test('공동 편집에서 선택한 발췌의 본문과 원본 숨김 설정이 함께 동기화된다', async ({ page, browser, baseURL, request }) => {
  test.setTimeout(95_000);
  const { author, reviewer, headers, create, close } = await createFixture(request);
  const peerContext = await browser.newContext({ baseURL });
  try {
    const text = '공동 배포 기준';
    const addition = '에 합의했습니다.';
    const source = await create('공동 발췌 원본', text);
    const session = await expectJson<CollaborationSession>(await request.post(`/api/documents/${source.id}/collaboration/enable`, {
      headers, data: { expectedVersion: source.version },
    }), 200);
    expect(session.schemaVersion).toBe(COLLABORATION_SCHEMA);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), author.id);
    await peerContext.addInitScript(id => localStorage.setItem('teamspace.actor', id), reviewer.id);
    const peer = await peerContext.newPage();
    await openDocument(page, source);
    await openDocument(peer, source);
    await expect(page.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    const editor = page.locator('.docs-live-prose[contenteditable=true]');
    await editor.getByText(text, { exact: true }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
    await page.getByRole('button', { name: '발췌 구역 삽입', exact: true }).click();

    const definition = (client: Page) => client.locator('.docs-live-prose [data-teamspace-node="documentExcerpt"]');
    const checkbox = (client: Page) => definition(client).getByRole('checkbox', { name: '원본에서 숨기기', exact: true });
    const textBody = (client: Page) => definition(client).locator('[data-node-view-content] p');
    await expect(textBody(peer)).toHaveText(text);
    await checkbox(peer).check();
    await textBody(peer).click();
    await peer.keyboard.press('End');
    await peer.keyboard.insertText(addition);
    await expect(checkbox(page)).toBeChecked();
    await expect(textBody(page)).toHaveText(text + addition);
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    const stored = await expectJson<WorkspaceSnapshot>(await request.get('/api/workspace'), 200);
    expect(stored.documents.find(document => document.id === source.id)?.content.content).toContainEqual({
      type: 'documentExcerpt', attrs: { hidden: true }, content: [paragraph(text + addition)],
    });
    await page.reload();
    await expect(checkbox(page)).toBeChecked();
    await expect(textBody(page)).toHaveText(text + addition);
    await textBody(page).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' 확인.');
    await expect(textBody(peer)).toHaveText(text + addition + ' 확인.');
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
  } finally {
    await peerContext.close();
    await close();
  }
});
