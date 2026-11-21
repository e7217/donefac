import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes';
import type { DocPage, DocumentPublicationView, RichContent, WorkspaceSnapshot } from '../../shared/types';

async function read<T>(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

test('360px 라벨별 문서 목록은 저장한 범위에서 갱신되고 검토본에는 목록 조건이 남는다', async ({ page, request }) => {
  test.setTimeout(120_000);
  const workspace = await read<WorkspaceSnapshot>(request, '/api/workspace');
  const [project, otherProject] = workspace.projects;
  const [author, reviewer] = workspace.users;
  const headers = { 'X-Actor-Id': author.id };
  const suffix = randomUUID().slice(0, 8);
  const labelA = `설계 ${suffix}`;
  const labelB = `결정 ${suffix}`;
  const bothLabels = [labelA, labelB];
  const created: DocPage[] = [];
  const create = async (title: string, projectId: string | null, labels: string[] = [], content?: RichContent) => {
    const result = await request.post('/api/documents', { headers, data: { title: `${title} ${suffix}`, projectId, labels, content } });
    expect(result.status(), await result.text()).toBe(201);
    const document = await result.json() as DocPage;
    created.push(document);
    return document;
  };
  const changeLabels = async (document: DocPage, labels: string[]) => {
    const response = await request.patch(`/api/documents/${document.id}`, { headers, data: { labels, expectedVersion: document.version } });
    expect(response.ok(), await response.text()).toBe(true);
  };

  try {
    const document = await create('팀 설계 색인', project.id, bothLabels);
    const matching = await create('가 설계 결정', project.id, bothLabels);
    const partial = await create('나 설계 초안', project.id, [labelA]);
    const shared = await create('팀 공통 설계', null, bothLabels);
    const other = await create('다른 프로젝트 설계', otherProject.id, bothLabels);
    const path = `/#/${project.id}/documents`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`${path}/${document.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title, { timeout: 30_000 });
    const editor = page.locator('.docs-prose[contenteditable=true]');
    await editor.locator('p').first().click();
    await page.getByRole('button', { name: '라벨별 문서 목록 삽입', exact: true }).click();
    const list = editor.getByRole('region', { name: '라벨별 문서 목록', exact: true });
    const open = (target: DocPage) => list.getByRole('button', { name: `목록 문서 열기 ${target.title}`, exact: true });
    const settings = list.getByRole('button', { name: '문서 목록 설정', exact: true });
    const form = list.getByRole('form', { name: '문서 목록 설정', exact: true });
    await settings.click();
    await expect(form.getByRole('combobox', { name: '문서 목록 범위', exact: true })).toHaveValue(project.id);
    const input = form.getByLabel('목록 라벨', { exact: true });
    await input.fill(labelA);
    await input.press('Enter');
    await input.fill(labelB);
    await form.getByRole('button', { name: '목록 라벨 추가', exact: true }).click();
    await form.getByLabel('목록 제목', { exact: true }).fill('운영 설계 목록');
    await form.getByRole('button', { name: '목록 설정 적용', exact: true }).click();
    await expect(open(matching)).toBeVisible();
    await expect(open(partial)).toBeVisible();
    await expect(open(shared)).toHaveCount(0);
    await expect(open(other)).toHaveCount(0);
    await expect(open(document)).toHaveCount(0);

    await settings.click();
    await form.getByRole('combobox', { name: '라벨 일치 방식', exact: true }).selectOption('all');
    await form.getByRole('combobox', { name: '문서 목록 정렬', exact: true }).selectOption('title');
    await form.getByLabel('내림차순', { exact: true }).uncheck();
    await form.getByLabel('공간 이름 표시', { exact: true }).check();
    await form.getByRole('button', { name: '목록 설정 적용', exact: true }).click();
    await expect(open(matching)).toBeVisible();
    await expect(open(partial)).toHaveCount(0);
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === `/api/documents/${document.id}` && response.request().method() === 'PATCH');
    await page.locator('.docs-save-button').click();
    const saved = await saving;
    expect(saved.ok(), await saved.text()).toBe(true);
    expect(saved.request().postDataJSON().contentSchemaVersion).toBe(DOCUMENT_CONTENT_SCHEMA_VERSION);
    const revision = await saved.json() as DocPage;
    expect(revision.content.content?.find(node => node.type === 'documentLabelList')).toMatchObject({ attrs: {
      projectId: project.id, labels: [labelB, labelA].sort(), match: 'all', sort: 'title', descending: false,
      title: '운영 설계 목록', showSpace: true, excludeCurrent: true,
    } });
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

    await settings.click();
    const listTitle = form.getByLabel('목록 제목', { exact:true });
    await listTitle.fill('적용하지 않은 목록 제목');
    let navigationMessage = '';
    page.once('dialog', async confirmation => { navigationMessage = confirmation.message(); await confirmation.dismiss(); });
    await page.getByRole('complementary', { name: '문서 목록' }).locator('.docs-tree-link').filter({ hasText: partial.title }).click();
    expect(navigationMessage).toContain('적용하지 않은 문서 목록 설정');
    await expect(listTitle).toHaveValue('적용하지 않은 목록 제목');
    await form.getByRole('button', { name:'취소', exact:true }).click();

    const publication = `/api/documents/${document.id}/publication`;
    const initial = await read<DocumentPublicationView>(request, publication);
    const review = await request.post(publication, { headers, data: {
      action: 'request', expectedVersion: initial.version, workspaceGeneration: initial.workspaceGeneration,
      expectedDocumentVersion: revision.version, reviewerId: reviewer.id,
    } });
    expect(review.ok(), await review.text()).toBe(true);

    await changeLabels(matching, [labelA]);
    await changeLabels(partial, bothLabels);
    await page.getByRole('button', { name: '참조 새로고침', exact: true }).click();
    await expect(open(partial)).toBeVisible();
    await expect(open(matching)).toHaveCount(0);
    const after = await read<WorkspaceSnapshot>(request, '/api/workspace');
    expect(after.documents.find(value => value.id === document.id)?.version).toBe(revision.version);

    await page.getByRole('button', { name: '문서 내보내기', exact: true }).click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Markdown 내보내기', exact: true }).click();
    const file = await (await downloading).path();
    expect(file).not.toBeNull();
    const markdown = await readFile(file!, 'utf8');
    expect(markdown).toContain('운영 설계 목록');
    expect(markdown).toContain(labelA);
    expect(markdown).not.toContain(partial.title);

    const outer = await create('다른 문서에 포함한 색인', project.id, [], { type: 'doc', content: [
      { type:'documentInclude', attrs:{ documentId:document.id, label:document.title } },
    ] });
    await page.getByRole('button', { name:'참조 새로고침', exact:true }).click();
    const outerInTree = page.getByRole('complementary', { name:'문서 목록' }).locator('.docs-tree-link').filter({ hasText:outer.title });
    await outerInTree.click();
    const included = page.getByRole('region', { name: `포함된 문서 ${document.title}`, exact: true });
    await expect(included.getByRole('button', { name: `목록 문서 열기 ${partial.title}`, exact: true })).toBeVisible();
    await expect(included.getByRole('button', { name: `목록 문서 열기 ${document.title}`, exact: true })).toHaveCount(0);
    await included.getByRole('button', { name: `목록 문서 열기 ${partial.title}`, exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(partial.title);

    await page.goto(`${path}/${document.id}`);
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(reviewer.id);
    await page.getByRole('button', { name: '검토·발행', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    await dialog.getByRole('button', { name: '검토본 불러오기', exact: true }).click();
    const snapshot = dialog.getByRole('region', { name: '검토 고정본 내용', exact: true });
    await expect(snapshot.getByText(/운영 설계 목록/u)).toContainText(labelA);
    await expect(snapshot.getByRole('region', { name: '라벨별 문서 목록', exact: true })).toHaveCount(0);
    await expect(snapshot.getByText(partial.title, { exact: true })).toHaveCount(0);
  } finally {
    for (const document of created.reverse()) {
      const removed = await request.delete(`/api/documents/${document.id}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId:string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
  }
});
