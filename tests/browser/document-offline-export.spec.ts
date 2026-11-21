import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { expect, test, type APIResponse, type Download } from '@playwright/test';
import { parse } from 'marked';
import { readLegacyArchive } from '../../server/legacy-import-archive';
import type { AttachmentHead, DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types';

const exportEndpoint = '/api/document-exports/markdown.zip';
const body = (text: string, ...nodes: RichContent[]): RichContent => ({ type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text }] }, ...nodes,
] });

async function json<T>(response: APIResponse, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

async function downloadedZip(download: Download) {
  expect(download.suggestedFilename()).toBe('Teamspace 문서.zip');
  const path = await download.path();
  expect(path).toBeTruthy();
  const { files } = await readLegacyArchive(await readFile(path!), 'offline.zip');
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
    source: string;
    scope: { kind: string; projectId: string | null; documentId: string | null };
    documents: { id: string; parentId: string | null; path: string }[];
    attachments: { id: string; filename: string; path: string }[];
  };
  return { files, manifest };
}

test('360px에서 문서 트리 ZIP을 내려받고 발행본이 없는 오류 뒤에도 미저장 본문을 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [actor] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const unique = randomUUID().slice(0, 8);
  const original = '서버에서 확인한 작업 절차입니다.';
  const localDraft = ' 아직 저장하지 않은 수정 사항';
  const ids: string[] = [];
  try {
    const root = await json<DocPage>(await request.post('/api/documents', { headers, data: {
      projectId: project.id, title: `휴대용 운영 가이드 ${unique}`, content: body(original),
    } }), 201);
    ids.push(root.id);
    const child = await json<DocPage>(await request.post('/api/documents', { headers, data: {
      projectId: project.id, parentId: root.id, title: `하위 작업 설명 ${unique}`, content: body('하위 문서의 저장된 본문'),
    } }), 201);
    ids.push(child.id);
    const fileBytes = Buffer.from('오프라인 첨부 합성 원본\r\n');
    const filename = '운영 실사 확인표.txt';
    const uploaded = await json<AttachmentHead>(await request.post(`/api/attachments?${new URLSearchParams({
      resourceType: 'document', resourceId: child.id, filename,
    })}`, { data: fileBytes, headers: { ...headers, 'Content-Type': 'application/octet-stream' } }), 201);
    const saved = await json<DocPage>(await request.patch(`/api/documents/${root.id}`, { headers, data: { expectedVersion: root.version,
      content: body(original, { type: 'documentReference', attrs: { documentId: child.id, label: '하위 작업 설명 열기' } }),
    } }));

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${project.id}/documents/${root.id}`);
    const paragraph = page.locator('.docs-prose p').filter({ hasText: original }).first();
    await expect(paragraph).toBeVisible({ timeout: 35_000 });
    await paragraph.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(localDraft);
    await expect(paragraph).toContainText(localDraft.trim());
    const menu = page.getByRole('button', { name: '문서 내보내기', exact: true });
    await menu.click();
    await page.getByRole('button', { name: '문서 트리 ZIP 내보내기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '문서 Markdown ZIP 내보내기', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const scope = dialog.getByLabel('내보낼 범위', { exact: true });
    const source = dialog.getByLabel('문서 버전', { exact: true });
    await expect(scope).toBeFocused();
    await expect(scope).toHaveValue('subtree');
    await expect(source).toHaveValue('saved');
    await scope.press('Control+s');
    const submit = dialog.getByRole('button', { name: 'Markdown ZIP 내려받기', exact: true });
    const pendingDownload = page.waitForEvent('download');
    await submit.click();
    const { files, manifest } = await downloadedZip(await pendingDownload);
    expect(manifest.scope).toEqual({ kind: 'subtree', projectId: project.id, documentId: root.id });
    expect(manifest.source).toBe('saved');
    expect(manifest.documents.map(entry => [entry.id, entry.parentId])).toEqual([[root.id, null], [child.id, root.id]]);
    const [rootEntry, childEntry] = manifest.documents;
    const rootMarkdown = files.get(rootEntry.path)!.toString('utf8');
    const rendered = parse(rootMarkdown, { async: false, gfm: true });
    expect(rendered).toContain(original);
    expect(rendered).not.toContain(localDraft);
    expect(rootMarkdown).toContain(`(${posix.relative(posix.dirname(rootEntry.path), childEntry.path).split('/').map(encodeURIComponent).join('/')})`);
    expect(manifest.attachments).toEqual([expect.objectContaining({ id: uploaded.id, filename })]);
    expect(files.get(manifest.attachments[0].path)).toEqual(fileBytes);
    await expect(dialog.getByRole('status')).toContainText('Teamspace 문서.zip');

    await source.selectOption('published');
    const pendingError = page.waitForResponse(response => new URL(response.url()).pathname === exportEndpoint);
    await submit.click();
    expect((await pendingError).status()).toBe(404);
    await expect(dialog.getByRole('alert')).toContainText('승인된 발행본이 없습니다.');
    await expect(source).toHaveValue('published');
    await source.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(menu).toBeFocused();
    await expect(paragraph).toContainText(localDraft.trim());
    const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(workspace.documents.find(item => item.id === root.id)).toEqual(saved);
  } finally {
    for (const id of ids.reverse()) {
      const removed = await request.delete(`/api/documents/${id}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
  }
});
