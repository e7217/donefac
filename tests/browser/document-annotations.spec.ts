import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { DocPage, DocRevision, RichContent, WorkspaceSnapshot } from '../../shared/types';

const doc = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const paragraph = (...content: RichContent[]): RichContent => ({ type: 'paragraph', ...(content.length ? { content } : {}) });
const text = (value: string): RichContent => ({ type: 'text', text: value });

async function archive(request: APIRequestContext, document: DocPage) {
  const response = await request.delete(`/api/documents/${document.id}`);
  expect(response.status(), await response.text()).toBe(200);
  const { trashEntryId } = await response.json() as { trashEntryId: string };
  expect((await request.delete(`/api/trash/${trashEntryId}`)).ok()).toBe(true);
}

test('안내 상자와 상태 배지를 키보드와 도구 모음으로 편집하고 이력과 내보내기에 보존한다', async ({ page, request }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = workspace.projects[0].id;
  const prefix = `문서 안내 ${randomUUID().slice(0, 8)}`;
  const source = await create('편집본', doc(paragraph()));
  let host: DocPage | undefined;
  async function create(suffix: string, content: RichContent) {
    const response = await request.post('/api/documents', { data: { projectId, title: `${prefix} ${suffix}`, content } });
    expect(response.status(), await response.text()).toBe(201);
    return await response.json() as DocPage;
  }
  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/documents/${source.id}`);
    const editor = page.locator('.docs-prose[contenteditable="true"]');
    await editor.locator('p').click();
    await page.keyboard.insertText('/callout');
    const menu = page.getByRole('group', { name: '블록 추가', exact: true });
    await expect(menu.getByRole('button', { name: '안내 상자', exact: true })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Enter');
    const insertCallout = page.getByRole('dialog', { name: '안내 상자 삽입', exact: true });
    await expect(insertCallout.getByLabel('안내 상자 제목 (선택)', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(insertCallout).toBeHidden();
    await expect(editor.locator('p').first()).toHaveText('/callout');
    await expect(editor).toBeFocused();

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await insertCallout.getByLabel('안내 상자 제목 (선택)', { exact: true }).fill('배포 승인');
    await insertCallout.getByRole('combobox', { name: '안내 상자 유형', exact: true }).selectOption('warning');
    await insertCallout.getByRole('button', { name: '삽입', exact: true }).click();
    const callout = editor.locator('[data-teamspace-node="callout"]');
    await expect(callout).toHaveAttribute('data-callout-variant', 'warning');
    await expect(callout).toContainText('배포 승인');
    await expect(editor).toBeFocused();
    await page.keyboard.insertText('승인 ');
    await expect(callout.locator('p')).toHaveText('승인 ');

    await page.getByRole('button', { name: '상태 배지 삽입', exact: true }).click();
    const insertBadge = page.getByRole('dialog', { name: '상태 배지 삽입', exact: true });
    await insertBadge.getByLabel('배지 이름', { exact: true }).fill('대기 중');
    await insertBadge.getByRole('combobox', { name: '배지 색상', exact: true }).selectOption('amber');
    await insertBadge.getByRole('button', { name: '삽입', exact: true }).click();
    await expect(editor).toBeFocused();
    await page.keyboard.insertText(' 후에 배포');
    await expect(callout.locator('p')).toHaveText('승인 대기 중 후에 배포');

    const badge = callout.getByRole('button', { name: '상태 배지 설정 · 대기 중', exact: true });
    await badge.press('Enter');
    const editBadge = page.getByRole('dialog', { name: '상태 배지 설정', exact: true });
    await editBadge.getByLabel('배지 이름', { exact: true }).fill('완료 <확인>');
    await editBadge.getByRole('combobox', { name: '배지 색상', exact: true }).selectOption('green');
    await editBadge.getByRole('button', { name: '적용', exact: true }).click();
    const editedBadge = callout.getByRole('button', { name: '상태 배지 설정 · 완료 <확인>', exact: true });
    await expect(editedBadge).toHaveAttribute('data-status-tone', 'green');
    await expect(editedBadge).toBeFocused();

    await callout.getByRole('button', { name: '안내 상자 설정', exact: true }).click();
    const editCallout = page.getByRole('dialog', { name: '안내 상자 설정', exact: true });
    await editCallout.getByLabel('안내 상자 제목 (선택)', { exact: true }).fill('배포 <결정>');
    await editCallout.getByRole('combobox', { name: '안내 상자 유형', exact: true }).selectOption('tip');
    await editCallout.getByRole('button', { name: '적용', exact: true }).click();
    await expect(callout).toHaveAttribute('data-callout-variant', 'tip');
    await expect(callout.locator('p')).toHaveText('승인 완료 <확인> 후에 배포');

    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    const saved = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(item => item.id === source.id)!;
    expect(saved.content.content?.[0]).toEqual({
      type: 'callout', attrs: { title: '배포 <결정>', variant: 'tip' }, content: [paragraph(
        text('승인 '), { type: 'statusBadge', attrs: { label: '완료 <확인>', tone: 'green' } }, text(' 후에 배포'),
      )],
    });
    expect(saved.plainText).toContain('배포 <결정>');
    expect(saved.plainText).toContain('승인 완료 <확인> 후에 배포');

    async function download(label: string) {
      await page.getByRole('button', { name: '문서 내보내기', exact: true }).click();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label, exact: true }).click()]);
      return readFileSync((await download.path())!, 'utf8');
    }
    const json = JSON.parse(await download('문서 JSON 내보내기')) as { schemaVersion: number; document: DocPage };
    expect(json.schemaVersion).toBe(6);
    expect(json.document.content).toEqual(saved.content);
    const markdown = await download('Markdown 내보내기');
    expect(markdown).toContain('> **팁 · 배포 \\<결정\\>**');
    expect(markdown).toContain('data-status-tone="green"');
    expect(markdown).toContain('완료 &lt;확인&gt;');

    await page.reload();
    await expect(callout).toHaveAttribute('data-callout-variant', 'tip');
    await expect(editedBadge).toHaveAttribute('data-status-tone', 'green');
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await page.getByRole('button', { name: '이력', exact: true }).click();
    await page.locator('.docs-revision').filter({ hasText: `버전 ${saved.version}` }).click();
    const historical = page.locator('.docs-history-preview .doc-readonly-content [data-teamspace-node="callout"]');
    await expect(historical).toContainText('배포 <결정>');
    await expect(historical.locator('[data-teamspace-node="statusBadge"]')).toHaveAttribute('data-status-tone', 'green');
    await expect(historical.getByRole('button')).toHaveCount(0);

    const revisions = await (await request.get(`/api/documents/${source.id}/revisions`)).json() as DocRevision[];
    const revision = revisions.find(item => item.version === saved.version)!;
    host = await create('고정본', doc({ type: 'documentRevisionInclude', attrs: { documentId: source.id, revisionId: revision.id, label: source.title } }));
    await page.reload();
    await page.locator('.docs-tree-link').filter({ hasText: host.title }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(host.title);
    const pinned = page.getByRole('region', { name: `고정 포함 문서 ${source.title}`, exact: true });
    await pinned.getByRole('button', { name: '고정 버전 내용 보기', exact: true }).click();
    await expect(pinned.locator('[data-teamspace-node="callout"]')).toHaveAttribute('data-callout-variant', 'tip');
    await expect(pinned.locator('[data-teamspace-node="statusBadge"]')).toHaveText('완료 <확인>');
    await expect(pinned.getByRole('button', { name: /설정/ })).toHaveCount(0);
  } finally {
    if (host) await archive(request, host);
    await archive(request, source);
  }
});

test('공동 편집 문서에서 슬래시로 추가한 배지를 다른 편집자가 읽는다', async ({ page, request, browser, baseURL }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = workspace.projects[0].id;
  const response = await request.post('/api/documents', { data: {
    projectId, title: `공동 편집 상태 배지 ${randomUUID().slice(0, 8)}`,
    content: doc({ type: 'callout', attrs: { variant: 'info', title: '배포 확인' }, content: [paragraph()] }),
  } });
  expect(response.status(), await response.text()).toBe(201);
  const document = await response.json() as DocPage;
  const peerContext = await browser.newContext({ baseURL });
  try {
    const enabled = await request.post(`/api/documents/${document.id}/collaboration/enable`, { data: { expectedVersion: document.version } });
    expect(enabled.status(), await enabled.text()).toBe(200);
    const peer = await peerContext.newPage();
    const path = `/#/${projectId}/documents/${document.id}`;
    await Promise.all([page.goto(path), peer.goto(path)]);
    const peerState = peer.locator('.docs-collaboration-state');
    await expect(peerState).toHaveText('서버에 동기화됨');
    const editor = page.locator('.docs-live-prose[contenteditable="true"]');
    await editor.locator('.document-callout-content p').click();
    await page.keyboard.insertText('/badge');
    await page.getByRole('group', { name: '블록 추가', exact: true }).getByRole('button', { name: '상태 배지', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '상태 배지 삽입', exact: true });
    await dialog.getByRole('textbox', { name: '배지 이름', exact: true }).fill('검토 대기');
    await dialog.getByRole('combobox', { name: '배지 색상', exact: true }).selectOption('blue');
    await dialog.getByRole('button', { name: '삽입', exact: true }).click();
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    const peerCallout = peer.locator('.docs-live-prose [data-teamspace-node="callout"]');
    await expect(peerCallout).toHaveAttribute('data-callout-title', '배포 확인');
    await expect(peerCallout.getByRole('button', { name: '상태 배지 설정 · 검토 대기', exact: true })).toHaveAttribute('data-status-tone', 'blue');
    await expect(peerCallout).not.toContainText('/badge');
  } finally {
    await peerContext.close();
    await archive(request, document);
  }
});
