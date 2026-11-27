import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { DocPage, DocumentSiblingOrder, DocumentTreeMovePreview, WorkspaceSnapshot } from '../../shared/types';

function button(within: Page | Locator, name: string) {
  return within.getByRole('button', { name, exact: true });
}

async function body<T>(response: Pick<APIResponse, 'status' | 'json' | 'text'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function documents(request: APIRequestContext) {
  return body<WorkspaceSnapshot>(await request.get('/api/workspace'));
}

async function fixture(request: APIRequestContext) {
  const { projects: [project], users: [actor, colleague] } = await documents(request);
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `문서 배치 ${randomUUID().slice(0, 8)}`;
  const created: DocPage[] = [];
  return {
    project, actor,
    async create(title: string, parentId: string | null, projectId: string | null = project.id, author = actor.id) {
      const saved = await body<DocPage>(await request.post('/api/documents', {
        headers: { 'X-Actor-Id': author },
        data: { title: `${prefix} ${title}`, parentId, projectId,
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] },
        },
      }), 201);
      created.push(saved);
      return saved;
    },
    async open(page: Page, document: DocPage) {
      await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
      await page.goto(`/#/${project.id}/documents/${document.id}`);
      await expect(page.getByRole('textbox', { name: '문서 제목' })).toHaveValue(document.title);
    },
    peerId: colleague.id,
    async clean() {
      for (const { id } of created.reverse()) {
        const response = await request.delete(`/api/documents/${id}`, { headers });
        if (!response.ok()) continue;
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

function tree(page: Page) { return page.getByRole('complementary', { name: '문서 목록', exact: true }); }
function row(page: Page, document: DocPage) {
  return tree(page).locator('.docs-tree-row').filter({ has: page.locator('.docs-tree-link').getByText(document.title, { exact: true }) });
}
function grip(page: Page, document: DocPage) { return row(page, document).locator('.docs-tree-grip'); }

async function drag(page: Page, source: DocPage, target: Locator, zone: 'before' | 'after' | 'inside' = 'inside') {
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  const { height } = bounds!;
  const y = zone === 'before' ? 5 : zone === 'after' ? height - 5 : height / 2;
  await grip(page, source).dragTo(target, { targetPosition: { x: 32, y } });
}

test('sidebar drag reviews the exact sibling order, detects a stale group and preserves the current document draft', async ({ page, request }) => {
  test.setTimeout(80_000);
  const team = await fixture(request);
  try {
    const parent = await team.create('상위', null);
    const first = await team.create('첫 번째', parent.id);
    const second = await team.create('두 번째', parent.id);
    const moving = await team.create('옮길 문서', parent.id);
    const ownChild = await team.create('옮길 문서의 자녀', moving.id);
    const orderPath = `/api/documents/${moving.id}/sibling-order`;
    const order = async () => body<DocumentSiblingOrder>(await request.get(orderPath));
    const original = await order();

    await team.open(page, first);
    const editor = page.locator('.docs-prose[contenteditable="true"]');
    await editor.fill('현재 문서에 입력 중인 본문');
    const search = tree(page).getByRole('textbox', { name: '문서 찾기' });
    await search.fill(moving.title);
    await expect(row(page, moving)).toBeVisible();
    await expect(tree(page).locator('.docs-tree-grip')).toHaveCount(0);
    await search.clear();

    let added: DocPage | undefined;
    const methods: string[] = [];
    let lost = false;
    await page.route(`**${orderPath}`, async route => {
      const method = route.request().method();
      methods.push(method);
      if (!added && method === 'GET') added = await team.create('동료가 새로 만든 형제', parent.id, team.project.id, team.peerId);
      if (lost && method === 'PATCH') {
        await body<DocumentSiblingOrder>(await route.fetch());
        await route.abort('failed');
      } else await route.continue();
    });
    const dialog = page.getByRole('dialog', { name: '문서 순서 편집' });
    const save = button(dialog, '문서 순서 저장');
    await drag(page, moving, row(page, second), 'before');
    await expect(dialog.getByRole('alert')).toContainText('다른 작업자가 문서 순서나 위치를 변경했습니다.');
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole('list')).toContainText(added!.title);
    expect(methods).toEqual(['GET']);
    const before = await order();
    expect(before.documentIds).toEqual([...original.documentIds, added!.id]);
    await button(dialog, '문서 순서 편집 닫기').click();
    await expect(dialog).toHaveCount(0);
    await expect(row(page, added!)).toBeVisible();

    await drag(page, moving, row(page, first), 'after');
    await expect(dialog.getByRole('listitem').locator('strong')).toHaveText([first.title, moving.title, second.title, added!.title]);
    expect(await order()).toEqual(before);
    lost = true;
    await save.click();
    await expect(dialog.getByRole('status')).toContainText('문서 순서를 저장했습니다.');
    await button(dialog, '문서 순서 편집 닫기').click();
    await expect(editor).toHaveText('현재 문서에 입력 중인 본문');
    await expect(page).toHaveURL(url => url.hash.includes(first.id));
    expect((await order()).documentIds).toEqual([first.id, moving.id, second.id, added!.id]);
    const current = (await documents(request)).documents;
    expect(current.find(document => document.id === ownChild.id)).toEqual(ownChild);
    expect(current.find(document => document.id === first.id)).toEqual(first);
    expect(methods).toEqual(['GET', 'GET', 'PATCH', 'GET']);
  } finally { await team.clean(); }
});

test('sidebar nesting reviews the subtree, protects its dirty child and can return it to space top level', async ({ page, request }) => {
  test.setTimeout(80_000);
  const team = await fixture(request);
  try {
    const parent = await team.create('상위', null);
    const moving = await team.create('이동할 문서', parent.id);
    const child = await team.create('이동할 문서의 자녀', moving.id);
    const common = await team.create('팀 공통 목적지', null, null);
    await team.open(page, child);
    const editor = page.locator('.docs-prose[contenteditable="true"]');
    await editor.fill('옮기기 전에 작성 중인 하위 문서');
    const path = `/api/documents/${moving.id}`;
    const requests: string[] = [];
    page.on('request', request => {
      const route = new URL(request.url()).pathname;
      if (route.startsWith(`${path}/move`)) requests.push(route);
    });
    const dialog = page.getByRole('dialog', { name: '문서 이동', exact: true });
    await drag(page, moving, row(page, child));
    await expect(dialog).toHaveCount(0);
    await drag(page, moving, row(page, common));
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('문서 편집과 목록 설정을 저장한 뒤 이동해 주세요.')).toBeVisible();
    await expect(editor).toHaveText('옮기기 전에 작성 중인 하위 문서');
    expect(requests).toEqual([]);

    await button(page, '저장').click();
    await expect(button(page, '저장')).toBeDisabled();
    const latest = (await documents(request)).documents;
    expect(latest.find(document => document.id === child.id)?.plainText).toBe('옮기기 전에 작성 중인 하위 문서');
    await drag(page, moving, row(page, common));
    const spaceInput = dialog.getByRole('combobox', { name: '이동할 공간' });
    const parentInput = dialog.getByRole('combobox', { name: '이동할 상위 문서' });
    const preview = button(dialog, '이동 미리보기');
    const apply = button(dialog, '문서 이동 적용');
    await expect(spaceInput).toHaveValue('');
    await expect(parentInput).toHaveValue(common.id);
    await expect(apply).toBeDisabled();
    expect(requests).toEqual([]);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === `${path}/move-preview`);
    await preview.click();
    const reviewed = await body<DocumentTreeMovePreview>(await response);
    expect(reviewed.documents.map(document => document.id)).toEqual([moving.id, child.id]);
    await expect(dialog.getByText(child.title, { exact: true })).toBeVisible();
    expect((await documents(request)).documents.find(document => document.id === moving.id)).toEqual(moving);
    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash.includes(child.id));
    await expect(row(page, moving)).toBeVisible();
    const nested = (await documents(request)).documents;
    expect(nested.find(document => document.id === moving.id)).toMatchObject({ projectId: null, parentId: common.id });
    expect(nested.find(document => document.id === child.id)).toMatchObject({ projectId: null, parentId: moving.id });
    await expect(editor).toHaveText('옮기기 전에 작성 중인 하위 문서');

    const projectRoot = tree(page).locator('.docs-tree-group').filter({ hasText: team.project.name });
    await drag(page, moving, projectRoot);
    await expect(spaceInput).toHaveValue(team.project.id);
    await expect(parentInput).toHaveValue('');
    await preview.click();
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(editor).toHaveText('옮기기 전에 작성 중인 하위 문서');
    const unnested = (await documents(request)).documents;
    expect(unnested.find(document => document.id === moving.id)).toMatchObject({ projectId: team.project.id, parentId: null });
    expect(unnested.find(document => document.id === child.id)).toMatchObject({ projectId: team.project.id, parentId: moving.id });
    expect(requests).toEqual([`${path}/move-preview`, `${path}/move`, `${path}/move-preview`, `${path}/move`]);
  } finally { await team.clean(); }
});
