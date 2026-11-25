import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { documentLabelKey } from '../../shared/document-labels';
import { documentSectionHash } from '../../shared/document-sections';
import type { DocPage, DocumentTreeMovePreview, RichContent, WorkspaceSnapshot } from '../../shared/types';

function moveResponse(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

async function snapshot(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function purgeTestDocument(request: APIRequestContext, id: string, headers: Record<string, string>) {
  const deleted = await request.delete(`/api/documents/${id}`, { headers });
  if (deleted.ok()) {
    const { trashEntryId } = await deleted.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`, { headers });
  }
}

test('360px에서 라벨로 가려진 문서 경로를 열고 상위 문서로 이동할 때 초안을 보존한다', async ({ page, request }) => {
  const { projects: [project], users: [author] } = await snapshot(request);
  const headers = { 'X-Actor-Id': author.id };
  const prefix = `탐색 ${randomUUID().slice(0, 8)}`;
  const filter = `${prefix} 라벨`;
  const created: DocPage[] = [];
  async function create(title: string, parentId: string | null, labels: string[] = []) {
    const response = await request.post('/api/documents', { headers,
      data: { title: `${prefix} ${title}`, projectId: null, parentId, labels } });
    expect(response.status(), await response.text()).toBe(201);
    const document = await response.json() as DocPage;
    created.push(document);
    return document;
  }

  try {
    const root = await create('최상위', null);
    const parent = await create('상위', root.id);
    const leaf = await create('하위', parent.id, [filter]);
    const query = new URLSearchParams({ label: documentLabelKey(filter) });
    const address = (document: DocPage) => `#/${project.id}/documents/${document.id}?${query}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), author.id);
    await page.goto(`/${address(leaf)}`);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(title).toHaveValue(leaf.title);
    const tree = page.getByRole('complementary', { name: '문서 목록', exact: true });
    await expect(tree.getByText(parent.title, { exact: true })).toHaveCount(0);

    const path = page.getByRole('navigation', { name: '문서 위치', exact: true });
    await expect(path).toContainText('팀 공통');
    await expect(path.getByRole('link')).toHaveText([root.title, parent.title]);
    await expect(path.locator('[aria-current="page"]')).toHaveText(leaf.title);
    const parentLink = path.getByRole('link', { name: parent.title, exact: true });
    await expect(parentLink).toHaveAttribute('href', address(parent));
    const bounds = await parentLink.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    const editor = page.locator('.docs-prose[contenteditable="true"]');
    const draft = '이동 전에 작성하던 초안';
    await editor.fill(draft);
    page.once('dialog', dialog => dialog.dismiss());
    await parentLink.press('Enter');
    await expect(page).toHaveURL(url => url.hash === address(leaf));
    await expect(editor).toHaveText(draft);

    page.once('dialog', dialog => dialog.accept());
    await parentLink.press('Enter');
    await expect(page).toHaveURL(url => url.hash === address(parent));
    await expect(title).toHaveValue(parent.title);
    await expect(path.getByRole('link')).toHaveText([root.title]);
    await expect(path).toBeFocused();
    expect((await snapshot(request)).documents.find(document => document.id === leaf.id)?.plainText).toBe(leaf.plainText);

    await page.goBack();
    await expect(title).toHaveValue(leaf.title);
    await expect(editor).toHaveText(draft);
  } finally {
    for (const document of created.reverse()) await purgeTestDocument(request, document.id, headers);
  }
});

test('360px에서 하위 문서 변경을 다시 확인하고 트리를 옮긴 후 기존 절 링크를 연다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const initial = await snapshot(request);
  const [source, destination] = initial.projects;
  const [author, otherEditor] = initial.users;
  const authorHeaders = { 'X-Actor-Id': author.id };
  const suffix = randomUUID().slice(0, 8);
  const sectionId = `subtree-${suffix}`;
  const sectionTitle = '이동해도 공유할 설계 절';
  const body: RichContent = { type: 'doc', content: [{
    type: 'heading', attrs: { level: 2, sectionId }, content: [{ type: 'text', text: sectionTitle }],
  }] };
  const created: DocPage[] = [];
  async function create(title: string, projectId: string, parentId: string | null, content?: RichContent): Promise<DocPage> {
    const response = await request.post('/api/documents', {
      headers: authorHeaders, data: { title: `${title} ${suffix}`, projectId, parentId, ...(content && { content }) },
    });
    expect(response.status(), await response.text()).toBe(201);
    const value = await response.json() as DocPage;
    created.push(value);
    return value;
  }

  try {
    const destinationParent = await create('도착 상위 문서', destination.id, null);
    const root = await create('이동할 상위 문서', source.id, null, body);
    const child = await create('이동할 하위 문서', source.id, root.id);
    const grandchild = await create('이동할 세 번째 문서', source.id, child.id);
    const apiPath = `/api/documents/${root.id}`;
    const oldHash = documentSectionHash(root.id, sectionId, source.id);
    const newHash = documentSectionHash(root.id, sectionId, destination.id);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${oldHash}`);
    const heading = page.locator('.docs-prose').getByRole('heading', { name: sectionTitle, exact: true });
    await expect(heading).toBeFocused({ timeout: 25_000 });
    const confirmations: string[] = [];
    page.on('dialog', async confirmation => {
      confirmations.push(confirmation.message());
      await confirmation.dismiss();
    });
    const openDetails = page.getByRole('button', { name: '정보 패널 열기', exact: true });
    const closeDetails = page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true });
    const comment = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    const unsent = `이동 중에도 이어 쓸 댓글 ${suffix}`;
    await openDetails.click();
    await comment.fill(unsent);
    await closeDetails.click();
    const opener = page.getByRole('button', { name: '문서 이동', exact: true });
    const dialog = page.getByRole('dialog', { name: '문서 이동', exact: true });
    await opener.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const scope = dialog.getByRole('combobox', { name: '이동할 공간', exact: true });
    const parent = dialog.getByRole('combobox', { name: '이동할 상위 문서', exact: true });
    await expect(scope).toHaveValue(source.id);
    await expect(parent.locator(`option[value="${root.id}"], option[value="${child.id}"], option[value="${grandchild.id}"]`)).toHaveCount(0);
    await scope.selectOption(destination.id);
    await parent.selectOption(destinationParent.id);
    const previewButton = dialog.getByRole('button', { name: '이동 미리보기', exact: true });
    const applyButton = dialog.getByRole('button', { name: '문서 이동 적용', exact: true });
    const target = { projectId: destination.id, parentId: destinationParent.id };
    await expect(applyButton).toBeDisabled();

    async function preview(): Promise<DocumentTreeMovePreview> {
      const pending = moveResponse(page, `${apiPath}/move-preview`);
      await previewButton.click();
      const response = await pending;
      expect(response.status(), await response.text()).toBe(200);
      expect(response.request().postDataJSON()).toEqual(target);
      await expect(applyButton).toBeEnabled();
      return response.json();
    }

    const first = await preview();
    expect(first).toMatchObject({ ...target, documentId: root.id, sourceProjectId: source.id, sourceParentId: null, changed: true });
    expect(first.documents.map(({ id }) => id)).toEqual([root.id, child.id, grandchild.id]);
    await expect(dialog.getByText(child.title, { exact: true })).toBeVisible();
    await expect(dialog.getByText(grandchild.title, { exact: true })).toBeVisible();

    const update = await request.patch(`/api/documents/${child.id}`, {
      headers: { 'X-Actor-Id': otherEditor.id }, data: { expectedVersion: child.version, title: `${child.title} 수정` },
    });
    expect(update.status(), await update.text()).toBe(200);
    const edited = await update.json() as DocPage;
    const rejectedRequest = moveResponse(page, `${apiPath}/move`);
    await applyButton.click();
    const rejected = await rejectedRequest;
    expect(rejected.status(), await rejected.text()).toBe(409);
    expect(rejected.request().postDataJSON()).toEqual({ ...target, token: first.token });
    await expect(dialog.getByRole('alert')).toContainText('이동 미리보기를 다시 확인해 주세요.');
    await expect(applyButton).toBeDisabled();
    await expect(page).toHaveURL(url => url.hash === oldHash);
    const afterReject = await snapshot(request);
    const rejectedTree = new Map(afterReject.documents.map(document => [document.id, document]));
    expect([rejectedTree.get(root.id), rejectedTree.get(child.id), rejectedTree.get(grandchild.id)]).toEqual([root, edited, grandchild]);

    const reviewed = await preview();
    expect(reviewed.token).not.toBe(first.token);
    await expect(dialog.getByText(edited.title, { exact: true })).toBeVisible();
    const appliedRequest = moveResponse(page, `${apiPath}/move`);
    await applyButton.click();
    const applied = await appliedRequest;
    expect(applied.status(), await applied.text()).toBe(200);
    expect(applied.request().postDataJSON()).toEqual({ ...target, token: reviewed.token });
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(url => url.hash === newHash);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(root.title);
    expect(confirmations).toEqual([]);
    await openDetails.click();
    await expect(comment).toHaveValue(unsent);
    await comment.clear();
    await closeDetails.click();

    const afterMove = await snapshot(request);
    const moved = new Map(afterMove.documents.map(document => [document.id, document]));
    for (const [value, parentId] of [[root, destinationParent.id], [edited, root.id], [grandchild, child.id]] as const) {
      expect(moved.get(value.id)).toMatchObject({ projectId: destination.id, parentId, content: value.content });
    }
    expect(moved.get(destinationParent.id)).toEqual(destinationParent);
    const tree = page.getByRole('complementary', { name: '문서 목록', exact: true });
    for (const value of [destinationParent, root, edited, grandchild]) {
      await expect(tree.locator('.docs-tree-link').filter({ hasText: value.title })).toBeVisible();
    }
    await tree.getByRole('button', { name: `${destinationParent.title} 접기`, exact: true }).click();
    await expect(tree.locator('.docs-tree-link').filter({ hasText: root.title })).toHaveCount(0);

    const reopened = await page.context().newPage();
    try {
      await reopened.goto(`/${oldHash}`);
      await expect(reopened).toHaveURL(url => url.hash === newHash);
      const savedSection = reopened.locator('.docs-prose').getByRole('heading', { name: sectionTitle, exact: true });
      await expect(savedSection).toBeFocused();
      await expect(savedSection).toHaveAttribute('data-document-section-id', sectionId);
    } finally {
      await reopened.close();
    }
  } finally {
    for (const document of created.reverse()) {
      await purgeTestDocument(request, document.id, authorHeaders);
    }
  }
});

test('팀 공통으로 이동한 응답이 유실되면 미리보기로 확인하고 화면을 갱신한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const initial = await snapshot(request);
  const [source] = initial.projects;
  const authorHeaders = { 'X-Actor-Id': initial.users[0].id };
  const title = `응답 유실 문서 이동 ${randomUUID().slice(0, 8)}`;
  const created = await request.post('/api/documents', { headers: authorHeaders, data: { projectId: source.id, title } });
  expect(created.status(), await created.text()).toBe(201);
  const document = await created.json() as DocPage;
  const apiPath = `/api/documents/${document.id}`;
  const hash = `#/${source.id}/documents/${document.id}`;
  let applyRequests = 0;

  try {
    await page.route(`**${apiPath}/move`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      applyRequests++;
      const committed = await route.fetch();
      expect(committed.status(), await committed.text()).toBe(200);
      await route.abort('failed');
    });
    await page.goto(`/${hash}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title, { timeout: 25_000 });
    const activeSpace = page.locator('.docs-breadcrumb > span').first();
    await expect(activeSpace).toHaveText(source.name);
    await page.getByRole('button', { name: '문서 이동', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '문서 이동', exact: true });
    await dialog.getByRole('combobox', { name: '이동할 공간', exact: true }).selectOption({ label: '팀 공통 문서' });
    const previewButton = dialog.getByRole('button', { name: '이동 미리보기', exact: true });
    const applyButton = dialog.getByRole('button', { name: '문서 이동 적용', exact: true });
    await previewButton.click();
    await applyButton.click();
    await expect(dialog.getByRole('alert')).toContainText('이동 결과를 확인하지 못했습니다.');
    await expect(applyButton).toBeDisabled();
    await expect(activeSpace).toHaveText(source.name);
    const committed = (await snapshot(request)).documents.find(value => value.id === document.id);
    expect(committed).toMatchObject({ projectId: null, parentId: null, version: document.version + 1 });

    const pending = moveResponse(page, `${apiPath}/move-preview`);
    await previewButton.click();
    const confirmed = await pending;
    expect(confirmed.status(), await confirmed.text()).toBe(200);
    expect(await confirmed.json()).toMatchObject({
      documentId: document.id, sourceProjectId: null, projectId: null, parentId: null, changed: false,
    });
    await expect(dialog.getByRole('status')).toHaveText('선택한 위치가 현재 문서 위치와 같습니다.');
    await expect(applyButton).toBeDisabled();
    await expect(activeSpace).toHaveText('팀 공통');
    await expect(page).toHaveURL(url => url.hash === hash);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(applyRequests).toBe(1);
    expect((await snapshot(request)).documents.find(value => value.id === document.id)).toEqual(committed);
  } finally {
    await purgeTestDocument(request, document.id, authorHeaders);
  }
});

test('다른 사용자가 문서를 옮겨도 공동 편집 연결과 열린 초안을 유지한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  const initial = await snapshot(request);
  const [source, destination] = initial.projects;
  const [author, mover] = initial.users;
  const authorHeaders = { 'X-Actor-Id': author.id };
  const moverHeaders = { 'X-Actor-Id': mover.id };
  const title = `공동 편집 문서 이동 ${randomUUID().slice(0, 8)}`;
  const initialText = '함께 편집하는 문서의 본문';
  const content: RichContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: initialText }] }] };
  const created = await request.post('/api/documents', { headers: authorHeaders, data: { projectId: source.id, title, content } });
  expect(created.status(), await created.text()).toBe(201);
  const document = await created.json() as DocPage;
  const apiPath = `/api/documents/${document.id}`;

  try {
    const enabled = await request.post(`${apiPath}/collaboration/enable`, {
      headers: authorHeaders, data: { expectedVersion: document.version },
    });
    expect(enabled.status(), await enabled.text()).toBe(200);
    let openedConnections = 0;
    let closedConnections = 0;
    page.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/api/collaboration') return;
      openedConnections++;
      socket.on('close', () => { closedConnections++; });
    });
    await page.addInitScript(actorId => localStorage.setItem('teamspace.actor', actorId), author.id);
    await page.goto(`/#/${source.id}/documents/${document.id}`);
    const liveStatus = page.locator('.docs-collaboration-state');
    const editor = page.locator('.docs-live-prose');
    await expect(liveStatus).toHaveText('서버에 동기화됨', { timeout: 25_000 });
    await expect(editor).toHaveText(initialText);
    const titleInput = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const comment = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    const draftTitle = `${title} 내 제목 초안`;
    const unsent = '같은 문서에서 이어 쓸 댓글 초안';
    await titleInput.fill(draftTitle);
    await comment.fill(unsent);
    const confirmations: string[] = [];
    page.on('dialog', async confirmation => {
      confirmations.push(confirmation.message());
      await confirmation.dismiss();
    });
    const initialConnections = openedConnections;
    expect(initialConnections).toBeGreaterThan(0);
    const previousClosures = closedConnections;

    const target = { projectId: destination.id, parentId: null };
    const preview = await request.post(`${apiPath}/move-preview`, { headers: moverHeaders, data: target });
    expect(preview.status(), await preview.text()).toBe(200);
    const { token } = await preview.json() as DocumentTreeMovePreview;
    const moved = await request.post(`${apiPath}/move`, { headers: moverHeaders, data: { ...target, token } });
    expect(moved.status(), await moved.text()).toBe(200);

    await expect(page).toHaveURL(url => url.hash === `#/${destination.id}/documents/${document.id}`);
    await expect(titleInput).toHaveValue(draftTitle);
    await expect(comment).toHaveValue(unsent);
    await expect(liveStatus).toHaveText('서버에 동기화됨');
    const appended = ' 옮긴 뒤 이어 쓴 본문';
    await editor.press('Control+End');
    await page.keyboard.insertText(appended);
    await expect.poll(async () => (await snapshot(request)).documents.find(value => value.id === document.id)?.plainText).toBe(initialText + appended);
    await expect(liveStatus).toHaveText('서버에 동기화됨');
    expect(openedConnections).toBe(initialConnections);
    expect(closedConnections).toBe(previousClosures);
    expect(confirmations).toEqual([]);
  } finally {
    await purgeTestDocument(request, document.id, authorHeaders);
  }
});
