import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import { documentLabelKey } from '../../shared/document-labels';
import type { DocPage, DocRevision, DocumentSiblingOrder, WorkspaceSnapshot } from '../../shared/types';

const name = '문서 순서 편집';
const orderPath = (document: DocPage) => `/api/documents/${document.id}/sibling-order`;
const button = (within: Page | Locator, label: string) => within.getByRole('button', { name: label, exact: true });

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, expected = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(expected);
  return response.json();
}

async function workspace(request: APIRequestContext) {
  return json<WorkspaceSnapshot>(await request.get('/api/workspace'));
}

async function expectOrder(list: Locator, documents: readonly DocPage[]) {
  const items = list.getByRole('listitem');
  await expect(items).toHaveCount(documents.length);
  for (const [index, document] of documents.entries()) {
    await expect(items.nth(index).getByText(document.title, { exact: true })).toBeVisible();
  }
}

test('360px 문서 순서 편집에서 필터 밖 형제와 최신 목록을 확인하고 저장한 순서를 다시 연다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const { projects: [project], users: [actor, peer] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const prefix = `형제 순서 ${suffix}`;
  const label = `순서 표시 ${suffix}`;
  const local = '문서 순서와 별도로 작성 중인 본문';
  const created: DocPage[] = [];

  async function create(title: string, parentId: string | null, labels: string[] = [], creator = actor.id) {
    const document = await json<DocPage>(await request.post('/api/documents', {
      headers: { 'X-Actor-Id': creator }, data: {
        projectId: project.id, parentId, title: `${prefix} ${title}`, labels,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `저장 본문 ${title}` }] }] },
      },
    }), 201);
    created.push(document);
    return document;
  }

  async function order(document: DocPage) {
    return json<DocumentSiblingOrder>(await request.get(orderPath(document), { headers }));
  }

  try {
    const parent = await create('상위', null);
    const first = await create('다 첫째', parent.id, [label]);
    const hidden = await create('가 필터 밖', parent.id);
    const moving = await create('나 이동할 문서', parent.id, [label]);
    const descendant = await create('가 문서의 자녀', hidden.id);
    const unrelated = await create('별도 상위 문서', null, [label]);
    const initial = await order(first);
    expect(initial).toMatchObject({ projectId: project.id, parentId: parent.id, documentIds: [first.id, hidden.id, moving.id] });
    const revisionsPath = `/api/documents/${first.id}/revisions`;
    const originalHistory = await json<DocRevision[]>(await request.get(revisionsPath));
    const orderActivity = (snapshot: WorkspaceSnapshot) => snapshot.activities.filter(activity =>
      activity.resourceType === 'document' && activity.resourceId === first.id && activity.action === '문서 순서 변경');
    const initialActivity = orderActivity(await workspace(request));

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    const documentUrl = `/#/${project.id}/documents/${first.id}`;
    await page.goto(`${documentUrl}?${new URLSearchParams({ label: documentLabelKey(label) })}`);
    const tree = page.getByRole('complementary', { name: '문서 목록', exact: true });
    const filter = tree.getByRole('combobox', { name: '문서 라벨 필터', exact: true });
    const search = tree.getByRole('textbox', { name: '문서 찾기', exact: true });
    const treeTitle = (document: DocPage) => tree.locator('.docs-tree-link').getByText(document.title, { exact: true });
    await expect(filter).toHaveValue(documentLabelKey(label));
    await search.fill(label);
    await expect(treeTitle(first)).toBeVisible();
    await expect(treeTitle(moving)).toBeVisible();
    await expect(treeTitle(hidden)).toHaveCount(0);
    const editor = page.locator('.docs-prose[contenteditable="true"]');
    await editor.fill(local);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');

    const opener = button(page, name);
    await opener.click();
    const dialog = page.getByRole('dialog', { name, exact: true });
    const list = dialog.getByRole('list', { name: '같은 위치의 문서', exact: true });
    await expectOrder(list, [first, hidden, moving]);
    await expect(list.getByText(unrelated.title, { exact: true })).toHaveCount(0);
    await expect(list.getByText(descendant.title, { exact: true })).toHaveCount(0);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    const up = button(dialog, `${moving.title} 위로 이동`);
    const save = button(dialog, '문서 순서 저장');
    const pendingSave = () => page.waitForResponse(response =>
      new URL(response.url()).pathname === orderPath(first) && response.request().method() === 'PATCH');
    await up.click();
    await expectOrder(list, [first, moving, hidden]);
    const newcomer = await create('새로 추가된 형제', parent.id, [], peer.id);
    const fresh = await order(first);
    expect(fresh.documentIds).toEqual([first.id, hidden.id, moving.id, newcomer.id]);
    expect(fresh.version).not.toBe(initial.version);
    const stale = pendingSave();
    await save.click();
    const rejected = await stale;
    expect(await json<{ details: unknown }>(rejected, 409)).toMatchObject({ details: { reason: 'document_order_stale', currentVersion: fresh.version } });
    expect(rejected.request().postDataJSON()).toEqual({ expectedVersion: initial.version, documentIds: [first.id, moving.id, hidden.id] });
    await expect(dialog.getByRole('alert')).toContainText('순서');
    await expectOrder(list, [first, moving, hidden]);
    expect(await order(first)).toEqual(fresh);

    page.once('dialog', confirm => confirm.accept());
    await button(dialog, '최신 순서 불러오기').click();
    await expectOrder(list, [first, hidden, moving, newcomer]);
    await up.focus();
    await up.press('Space');
    await up.click();
    await expectOrder(list, [moving, first, hidden, newcomer]);
    await expect(up).toBeDisabled();
    const methods: string[] = [];
    const patches: unknown[] = [];
    let committed: DocumentSiblingOrder | undefined;
    await page.route(`**${orderPath(first)}`, async route => {
      const method = route.request().method();
      methods.push(method);
      if (method !== 'PATCH') return route.continue();
      patches.push(route.request().postDataJSON());
      committed = await json<DocumentSiblingOrder>(await route.fetch());
      await route.abort('failed');
    });
    const reconciling = page.waitForResponse(response =>
      new URL(response.url()).pathname === orderPath(first) && response.request().method() === 'GET');
    await save.click();
    const saved = await json<DocumentSiblingOrder>(await reconciling);
    expect(saved).toEqual(committed);
    expect(patches).toEqual([{ expectedVersion: fresh.version, documentIds: [moving.id, first.id, hidden.id, newcomer.id] }]);
    expect(saved.documentIds).toEqual([moving.id, first.id, hidden.id, newcomer.id]);
    expect(saved.version).not.toBe(fresh.version);
    await expect(dialog.getByRole('status')).toContainText('문서 순서를 저장했습니다.');
    await expect(button(dialog, '저장 결과 확인')).toHaveCount(0);
    await expect(save).toBeDisabled();
    await button(dialog, '문서 순서 편집 닫기').click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(filter).toHaveValue(documentLabelKey(label));
    await expect(search).toHaveValue(label);
    await expect(treeTitle(hidden)).toHaveCount(0);
    await expect(editor).toContainText(local);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');

    await search.clear();
    await filter.selectOption('');
    const branch = tree.locator('.docs-tree-row').filter({ has: page.getByText(parent.title, { exact: true }) }).locator('..');
    const branchTitles = branch.locator('.docs-tree-link').getByText(new RegExp(`^${prefix}`));
    const expectedTitles = [parent, moving, first, hidden, descendant, newcomer].map(document => document.title);
    await expect(branchTitles).toHaveText(expectedTitles);
    page.once('dialog', confirm => confirm.accept());
    await page.reload();
    await expect(branchTitles).toHaveText(expectedTitles);
    await expect(editor).toContainText(local);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    expect(await order(moving)).toEqual(saved);
    expect(methods).toEqual(['PATCH', 'GET']);
    const snapshot = await workspace(request);
    const { documents } = snapshot;
    expect(orderActivity(snapshot)).toHaveLength(initialActivity.length + 1);
    for (const previous of created) expect(documents.find(document => document.id === previous.id)).toEqual(previous);
    expect(await json<DocRevision[]>(await request.get(revisionsPath))).toEqual(originalHistory);
  } finally {
    for (const document of created.reverse()) {
      const response = await request.delete(`/api/documents/${document.id}`, { headers });
      if (!response.ok()) continue;
      const { trashEntryId } = await response.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});
