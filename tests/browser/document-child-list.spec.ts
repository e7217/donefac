import { randomUUID } from 'node:crypto';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes';
import type { DocPage, DocRevision, DocumentSiblingOrder, DocumentTreeMovePreview, RichContent, WorkspaceSnapshot } from '../../shared/types';

const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const content = (...nodes: RichContent[]): RichContent => ({ type: 'doc', content: nodes });
const collection = (title: string): RichContent => ({ type: 'documentChildList', attrs: { scope: 'current', title } });

async function fixture(request: APIRequestContext) {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  const workspace = await response.json() as WorkspaceSnapshot;
  const project = workspace.projects[0];
  const headers = { 'X-Actor-Id': workspace.users[0].id };
  const suffix = randomUUID().slice(0, 8);
  const created: string[] = [];
  const trashed = new Map<string, string>();
  return {
    workspace,
    headers,
    async create(title: string, parentId: string | null = null, body?: RichContent, projectId: string | null = project.id) {
      const result = await request.post('/api/documents', { headers, data: { title: `${title} ${suffix}`, projectId, parentId, content: body } });
      expect(result.status(), await result.text()).toBe(201);
      const saved = await result.json() as DocPage;
      created.push(saved.id);
      return saved;
    },
    async update(document: DocPage, fields: Partial<DocPage>) {
      const result = await request.patch(`/api/documents/${document.id}`, { headers, data: {
        ...fields, expectedVersion: document.version, contentSchemaVersion: 10,
      } });
      expect(result.status(), await result.text()).toBe(200);
      return result.json() as Promise<DocPage>;
    },
    async move(document: DocPage, parentId: string) {
      const path = `/api/documents/${document.id}`;
      const target = { projectId: document.projectId, parentId };
      const preview = await request.post(`${path}/move-preview`, { headers, data: target });
      expect(preview.status(), await preview.text()).toBe(200);
      const { token } = await preview.json() as DocumentTreeMovePreview;
      const applied = await request.post(`${path}/move`, { headers, data: { ...target, token } });
      expect(applied.status(), await applied.text()).toBe(200);
    },
    async trash(documentId: string) {
      const result = await request.delete(`/api/documents/${documentId}`, { headers });
      expect(result.status(), await result.text()).toBe(200);
      const { trashEntryId } = await result.json() as { trashEntryId: string };
      trashed.set(documentId, trashEntryId);
    },
    async restore(documentId: string) {
      const restored = await request.post(`/api/trash/${trashed.get(documentId)}/restore`, { headers });
      expect(restored.status(), await restored.text()).toBe(200);
      trashed.delete(documentId);
    },
    async read(documentId: string) {
      const result = await request.get('/api/workspace', { headers });
      expect(result.ok(), await result.text()).toBe(true);
      const current = (await result.json() as WorkspaceSnapshot).documents.find(document => document.id === documentId);
      expect(current).toBeDefined();
      return current!;
    },
    async close() {
      for (const id of created.reverse()) {
        let trashEntryId = trashed.get(id);
        if (!trashEntryId) {
          const result = await request.delete(`/api/documents/${id}`, { headers });
          if (result.ok()) ({ trashEntryId } = await result.json() as { trashEntryId: string });
        }
        if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

const test = base.extend<{ wiki: Awaited<ReturnType<typeof fixture>> }>({
  wiki: async ({ request }, provide) => {
    const files = await fixture(request);
    try { await provide(files); }
    finally { await files.close(); }
  },
});

function documentTitle(page: Page) {
  return page.getByRole('textbox', { name: '문서 제목', exact: true });
}

async function openDocument(page: Page, document: DocPage) {
  await page.goto(`/#/${document.projectId ?? 'all'}/documents/${document.id}`);
  await expect(documentTitle(page)).toHaveValue(document.title, { timeout: 30_000 });
}

async function refreshReferences(page: Page) {
  await page.getByRole('button', { name: '참조 새로고침', exact: true }).click();
}

test('360px에서 목록의 사용자 지정 순서를 저장하고 같은 순서를 최신 포함에서 읽는다', async ({ page, request, wiki }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const root = await wiki.create('수동 순서 색인', null, content(collection('원본 순서 목록')));
  const zulu = await wiki.create('Zulu 배포', root.id);
  const alpha = await wiki.create('Alpha 시작', root.id);
  const mike = await wiki.create('Mike 검증', root.id);
  await openDocument(page, root);
  const editor = page.locator('.docs-prose[contenteditable=true]');
  const block = editor.getByRole('region', { name: '하위 문서 목록', exact: true });
  const links = block.getByRole('link');
  await expect(links).toHaveText([alpha.title, mike.title, zulu.title]);
  await block.getByRole('button', { name: '하위 문서 목록 설정', exact: true }).click();
  const form = block.getByRole('form', { name: '하위 문서 목록 설정', exact: true });
  await form.getByRole('combobox', { name: '문서 정렬', exact: true }).selectOption({ label: '사용자 지정 순서' });
  await form.getByRole('button', { name: '목록 설정 적용', exact: true }).click();
  await expect(links).toHaveText([alpha.title, mike.title, zulu.title]);
  const saving = page.waitForResponse(reply => new URL(reply.url()).pathname === `/api/documents/${root.id}` && reply.request().method() === 'PATCH');
  await page.locator('.docs-save-button').click();
  const reply = await saving;
  expect(reply.ok(), await reply.text()).toBe(true);
  expect(reply.request().postDataJSON().contentSchemaVersion).toBe(14);
  const saved = await reply.json() as DocPage;
  expect(saved.content.content?.find(node => node.type === 'documentChildList')?.attrs?.sort).toBe('manual');
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

  const orderUrl = `/api/documents/${zulu.id}/sibling-order`;
  const response = await request.get(orderUrl, { headers: wiki.headers });
  expect(response.ok(), await response.text()).toBe(true);
  const initial = await response.json() as DocumentSiblingOrder;
  const reordered = await request.patch(orderUrl, { headers: wiki.headers, data: { expectedVersion: initial.version, documentIds: [mike.id, zulu.id, alpha.id] } });
  expect(reordered.ok(), await reordered.text()).toBe(true);
  await refreshReferences(page);
  await expect(links).toHaveText([mike.title, zulu.title, alpha.title]);

  const order = await reordered.json() as DocumentSiblingOrder;
  const explicitlyRestored = await request.patch(orderUrl, { headers: wiki.headers, data: { expectedVersion: order.version, documentIds: initial.documentIds } });
  expect(explicitlyRestored.ok(), await explicitlyRestored.text()).toBe(true);
  const history = await request.get(`/api/documents/${root.id}/revisions`, { headers: wiki.headers });
  expect(history.ok(), await history.text()).toBe(true);
  const currentRevision = (await history.json() as DocRevision[]).find(revision => revision.version === saved.version);
  expect(currentRevision).toBeDefined();
  const host = await wiki.create('같은 목록의 최신 포함과 고정본', null, content(
    { type: 'documentInclude', attrs: { documentId: root.id, label: root.title } },
    { type: 'documentRevisionInclude', attrs: { documentId: root.id, revisionId: currentRevision!.id, label: root.title } },
  ));
  await refreshReferences(page);
  await page.getByRole('complementary', { name: '문서 목록', exact: true }).locator('.docs-tree-link').filter({ hasText: host.title }).click();
  await expect(documentTitle(page)).toHaveValue(host.title);
  const live = page.getByRole('region', { name: `포함된 문서 ${root.title}`, exact: true });
  await expect(live.getByRole('region', { name: '하위 문서 목록', exact: true }).getByRole('link')).toHaveText([zulu.title, alpha.title, mike.title]);
  const pinned = page.getByRole('region', { name: `고정 포함 문서 ${root.title}`, exact: true });
  await pinned.getByRole('button', { name: '고정 버전 내용 보기', exact: true }).click();
  await expect(pinned).toContainText('사용자 지정 순서');
  await expect(pinned.getByRole('link', { name: zulu.title, exact: true })).toHaveCount(0);
});

test('360px에서 하위 문서 목록을 저장하고 계층 이동·이름 변경·휴지통을 반영한다', async ({ page, wiki }) => {
  test.setTimeout(120_000);
  const root = await wiki.create('배포 안내', null, content(paragraph('절차를 선택하세요.')));
  const later = await wiki.create('Runbook 8 배포', root.id);
  const earlier = await wiki.create('Runbook 2 준비', root.id);
  const alpha = await wiki.create('단계 1 절차', later.id);
  const beta = await wiki.create('단계 2 절차', later.id);
  const greatGrandchild = await wiki.create('세 번째 수준', beta.id);
  const unrelated = await wiki.create('Runbook 10 별도 문서');
  await page.setViewportSize({ width: 360, height: 820 });
  await openDocument(page, root);

  const editor = page.locator('.docs-prose[contenteditable=true]');
  await editor.getByText('절차를 선택하세요.', { exact: true }).click();
  await page.getByRole('button', { name: '하위 문서 목록 삽입', exact: true }).click();
  const block = editor.getByRole('region', { name: '하위 문서 목록', exact: true });
  const links = block.getByRole('link');
  await expect(links).toHaveText([earlier.title, later.title]);
  await expect(block.getByRole('link', { name: unrelated.title, exact: true })).toHaveCount(0);

  const settings = block.getByRole('button', { name: '하위 문서 목록 설정', exact: true });
  const form = block.getByRole('form', { name: '하위 문서 목록 설정', exact: true });
  await settings.click();
  await expect(form.getByRole('combobox', { name: '목록 범위', exact: true })).toHaveValue('current');
  const bounds = await form.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);
  await form.getByLabel('표시 단계', { exact: true }).fill('2');
  await form.getByLabel('최상위 문서 수', { exact: true }).fill('1');
  await form.getByRole('combobox', { name: '문서 정렬', exact: true }).selectOption('title');
  await form.getByLabel('내림차순', { exact: true }).check();
  await form.getByLabel('목록 제목', { exact: true }).fill('배포 절차 색인');
  await form.getByRole('button', { name: '목록 설정 적용', exact: true }).click();
  await expect(links).toHaveText([later.title, beta.title, alpha.title]);
  const branch = block.getByRole('listitem').filter({ has: page.getByRole('link', { name: later.title, exact: true }) }).first();
  await expect(branch.getByRole('list').getByRole('link')).toHaveText([beta.title, alpha.title]);
  await expect(block.getByRole('link', { name: greatGrandchild.title, exact: true })).toHaveCount(0);

  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname === `/api/documents/${root.id}` && reply.request().method() === 'PATCH');
  await page.locator('.docs-save-button').click();
  const saved = await pending;
  expect(saved.status(), await saved.text()).toBe(200);
  expect(saved.request().postDataJSON().contentSchemaVersion).toBe(DOCUMENT_CONTENT_SCHEMA_VERSION);
  const savedDocument = await saved.json() as DocPage;
  expect(savedDocument.content.content?.find(node => node.type === 'documentChildList')?.attrs).toMatchObject({
    scope: 'current', documentId: null, projectId: null, depth: 2, first: 1, sort: 'title', descending: true, style: 'list', title: '배포 절차 색인',
  });
  expect(savedDocument.plainText).not.toContain(beta.title);
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

  await settings.click();
  const draftTitle = form.getByLabel('목록 제목', { exact: true });
  await draftTitle.fill('적용하지 않은 제목');
  let confirmation = '';
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
  await page.getByRole('complementary', { name: '문서 목록', exact: true }).locator('.docs-tree-link').filter({ hasText: unrelated.title }).click();
  expect(confirmation).toContain('적용하지 않은 문서 목록 설정');
  await expect(draftTitle).toHaveValue('적용하지 않은 제목');
  await form.getByRole('button', { name: '취소', exact: true }).click();

  const renamed = await wiki.update(later, { title: `${later.title} 개정` });
  await refreshReferences(page);
  await expect(links).toHaveText([renamed.title, beta.title, alpha.title]);
  await wiki.move(unrelated, root.id);
  await refreshReferences(page);
  await expect(links).toHaveText([unrelated.title]);
  await wiki.trash(unrelated.id);
  await refreshReferences(page);
  await expect(links).toHaveText([renamed.title, beta.title, alpha.title]);
  await wiki.restore(unrelated.id);
  await refreshReferences(page);
  await expect(links).toHaveText([unrelated.title]);
  expect((await wiki.read(root.id)).version).toBe(savedDocument.version);

  await page.reload();
  await expect(links).toHaveText([unrelated.title]);
  await links.first().click();
  await expect(documentTitle(page)).toHaveValue(unrelated.title);
});

test('포함 문서의 상대 목록은 원문 자식을 보고 고정 포함은 저장한 조건을 표시한다', async ({ page, request, wiki }) => {
  test.setTimeout(85_000);
  const source = await wiki.create('공통 배포 절차', null, content(collection('원래 배포 목록')));
  const sourceChild = await wiki.create('원문 하위 문서', source.id);
  const reply = await request.get(`/api/documents/${source.id}/revisions`, { headers: wiki.headers });
  expect(reply.ok(), await reply.text()).toBe(true);
  const originals = await reply.json() as DocRevision[];
  const original = originals.find(revision => revision.version === source.version)!;
  expect(original).toBeDefined();
  const host = await wiki.create('포함과 고정본 비교', null, content(
    { type: 'documentInclude', attrs: { documentId: source.id, label: source.title } },
    { type: 'documentRevisionInclude', attrs: { documentId: source.id, revisionId: original.id, label: source.title } },
  ));
  const hostChild = await wiki.create('포함한 문서의 하위', host.id);

  await openDocument(page, host);
  const included = page.getByRole('region', { name: `포함된 문서 ${source.title}`, exact: true });
  const liveList = included.getByRole('region', { name: '하위 문서 목록', exact: true });
  const pinned = page.getByRole('region', { name: `고정 포함 문서 ${source.title}`, exact: true });
  await expect(liveList.getByRole('link')).toHaveText([sourceChild.title]);
  await expect(liveList).not.toContainText(hostChild.title);
  await expect(liveList.getByRole('button', { name: '하위 문서 목록 설정', exact: true })).toHaveCount(0);
  await pinned.getByRole('button', { name: '고정 버전 내용 보기', exact: true }).click();
  await expect(pinned).toContainText('원래 배포 목록');
  await expect(pinned).not.toContainText(sourceChild.title);
  await expect(pinned.getByRole('link', { name: sourceChild.title, exact: true })).toHaveCount(0);
  await expect(pinned.getByRole('button', { name: '하위 문서 목록 설정', exact: true })).toHaveCount(0);

  await wiki.update(source, { content: content(collection('갱신된 배포 목록')) });
  const renamed = await wiki.update(sourceChild, { title: `${sourceChild.title} 수정됨` });
  await refreshReferences(page);
  await expect(liveList).toContainText('갱신된 배포 목록');
  await expect(liveList.getByRole('link')).toHaveText([renamed.title]);
  await expect(pinned).toContainText('원래 배포 목록');
  await expect(pinned).not.toContainText('갱신된 배포 목록');
  await expect(pinned).not.toContainText(renamed.title);

  await liveList.getByRole('link', { name: renamed.title, exact: true }).click();
  await expect(documentTitle(page)).toHaveValue(renamed.title);
});

test('공동 편집에서 다른 상위 문서 범위와 제목 형식이 동기화된다', async ({ page, browser, baseURL, request, wiki }) => {
  test.setTimeout(90_000);
  const root = await wiki.create('공동 편집의 하위 탐색');
  const ownChild = await wiki.create('원래 하위 문서', root.id);
  const library = await wiki.create('별도 지식 모음');
  const libraryChild = await wiki.create('별도 지식 모음의 하위', library.id);
  const libraryLeaf = await wiki.create('별도 지식 모음의 상세 절차', libraryChild.id);
  const enabled = await request.post(`/api/documents/${root.id}/collaboration/enable`, {
    headers: wiki.headers, data: { expectedVersion: root.version },
  });
  expect(enabled.status(), await enabled.text()).toBe(200);
  const [author, collaborator] = wiki.workspace.users;
  await page.addInitScript(id => localStorage.setItem('donefac.actor', id), author.id);
  const context = await browser.newContext({ baseURL });
  try {
    await context.addInitScript(id => localStorage.setItem('donefac.actor', id), collaborator.id);
    const peer = await context.newPage();
    await Promise.all([openDocument(page, root), openDocument(peer, root)]);
    await expect(page.locator('.docs-collaboration-presence')).toContainText('2명 접속');
    const editor = page.locator('.docs-live-prose[contenteditable=true]');
    await editor.locator('p').first().click();
    await page.keyboard.insertText('/');
    await page.getByRole('group', { name: '블록 추가', exact: true }).getByRole('button', { name: '하위 문서 목록', exact: true }).click();
    const localList = editor.getByRole('region', { name: '하위 문서 목록', exact: true });
    const peerList = peer.locator('.docs-live-prose').getByRole('region', { name: '하위 문서 목록', exact: true });
    await expect(peerList.getByRole('link', { name: ownChild.title, exact: true })).toBeVisible();
    await localList.getByRole('button', { name: '하위 문서 목록 설정', exact: true }).click();
    const form = localList.getByRole('form', { name: '하위 문서 목록 설정', exact: true });
    await form.getByRole('combobox', { name: '목록 범위', exact: true }).selectOption('document');
    await form.getByRole('combobox', { name: '상위 문서', exact: true }).selectOption(library.id);
    await form.getByRole('combobox', { name: '표시 형식', exact: true }).selectOption('h3');
    await form.getByRole('spinbutton', { name: '표시 단계', exact: true }).fill('');
    await form.getByLabel('목록 제목', { exact: true }).fill('공용 문서 탐색');
    await form.getByRole('button', { name: '목록 설정 적용', exact: true }).click();

    for (const list of [localList, peerList]) {
      const heading = list.getByRole('heading', { name: libraryChild.title, level: 3, exact: true });
      await expect(heading.getByRole('link', { name: libraryChild.title, exact: true })).toBeVisible();
      await expect(list.getByRole('link', { name: libraryLeaf.title, exact: true })).toBeVisible();
      await expect(list.getByRole('link', { name: ownChild.title, exact: true })).toHaveCount(0);
      await expect(list).toContainText('공용 문서 탐색');
    }

    await localList.getByRole('button', { name: '하위 문서 목록 설정', exact: true }).click();
    const localTitle = form.getByLabel('목록 제목', { exact: true });
    await localTitle.fill('이 편집자의 임시 제목');
    await peerList.getByRole('button', { name: '하위 문서 목록 설정', exact: true }).click();
    const peerForm = peerList.getByRole('form', { name: '하위 문서 목록 설정', exact: true });
    await peerForm.getByLabel('목록 제목', { exact: true }).fill('다른 편집자가 적용한 제목');
    await peerForm.getByRole('button', { name: '목록 설정 적용', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('입력한 값은 유지됩니다');
    await expect(localTitle).toHaveValue('이 편집자의 임시 제목');
    await expect(form.getByRole('button', { name: '목록 설정 적용', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: '취소', exact: true }).click();
    await expect(localList).toContainText('다른 편집자가 적용한 제목');

    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    const persisted = (await wiki.read(root.id)).content.content?.find(node => node.type === 'documentChildList');
    expect(persisted?.attrs).toMatchObject({ scope: 'document', documentId: library.id, depth: 'all', title: '다른 편집자가 적용한 제목', style: 'h3' });
    await peer.reload();
    await expect(peerList.getByRole('link', { name: libraryChild.title, exact: true })).toBeVisible();
    await expect(peerList.getByRole('link', { name: libraryLeaf.title, exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
