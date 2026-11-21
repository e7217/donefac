import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIResponse } from '@playwright/test';
import type { AttachmentHead, DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types';

const previewEndpoint = '/api/document-markdown-import/preview';
const applyEndpoint = '/api/document-markdown-import/apply';
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });

async function json<T>(response: APIResponse, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

test('360px에서 문서 ZIP을 검토하고 다른 공간에 첨부와 본문 이미지를 가져온다', async ({ page, request, context }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const readWorkspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [sourceProject, targetProject], users: [actor] } = await readWorkspace();
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `문서 ZIP ${randomUUID().slice(0, 8)}`;
  const rootTitle = `${prefix} 운영 가이드`;
  const childTitle = `${prefix} 설정 절차`;
  const parentTitle = `${prefix} 대상 문서`;
  const original = '저장된 시작 절차입니다.';
  const childText = '가져온 하위 문서에서 볼 검사 문장입니다.';
  const localDraft = ' 저장하지 않은 편집 문장';
  const filename = '절차 참고 자료.txt';
  const bytes = Buffer.from('Markdown ZIP 첨부 합성 원본\r\n');
  const imageName = '설정 화면.png';
  const imageAlt = '원본에 삽입한 설정 화면';
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');

  async function createPage(projectId: string, title: string, content: RichContent, parentId: string | null = null) {
    return json<DocPage>(await request.post('/api/documents', { headers, data: { projectId, title, content, parentId } }), 201);
  }

  async function attach(document: DocPage, filename: string, mimeType: string, bytes: Buffer) {
    return json<AttachmentHead>(await request.post(`/api/attachments?${new URLSearchParams({
      resourceType: 'document', resourceId: document.id, filename,
    })}`, { data: bytes, headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-File-Type': mimeType } }), 201);
  }

  try {
    const root = await createPage(sourceProject.id, rootTitle, body(paragraph(original)));
    const child = await createPage(sourceProject.id, childTitle, body(paragraph(childText)), root.id);
    const parent = await createPage(targetProject.id, parentTitle, body(paragraph('가져온 문서의 상위 위치')));
    const attachment = await attach(child, filename, 'text/plain', bytes);
    const image = await attach(child, imageName, 'image/png', imageBytes);
    await json<DocPage>(await request.patch(`/api/documents/${child.id}`, { headers, data: {
      expectedVersion: child.version,
      content: body(paragraph(childText), { type: 'image', attrs: { src: `/api/attachments/${image.id}/content?inline=1`, alt: imageAlt } }),
    } }));

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${sourceProject.id}/documents/${root.id}`);
    const sourceParagraph = page.locator('.docs-prose p').filter({ hasText: original }).first();
    await expect(sourceParagraph).toBeVisible({ timeout: 35_000 });
    await sourceParagraph.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(localDraft);
    await expect(sourceParagraph).toContainText(localDraft.trim());

    const exportMenu = page.getByRole('button', { name: '문서 내보내기', exact: true });
    await exportMenu.click();
    await page.getByRole('button', { name: '문서 트리 ZIP 내보내기', exact: true }).click();
    const exportDialog = page.getByRole('dialog', { name: '문서 Markdown ZIP 내보내기', exact: true });
    const holdingDownload = page.waitForEvent('download');
    await exportDialog.getByRole('button', { name: 'Markdown ZIP 내려받기', exact: true }).click();
    const download = await holdingDownload;
    const downloaded = { name: download.suggestedFilename(), mimeType: 'application/zip', buffer: await readFile(await download.path()) };
    await exportDialog.getByRole('button', { name: '내보내기 닫기', exact: true }).click();

    const importButton = page.getByRole('button', { name: 'Markdown ZIP 가져오기', exact: true });
    await importButton.click();
    const dialog = page.getByRole('dialog', { name: 'Markdown ZIP 가져오기', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const target = dialog.getByLabel('가져올 문서 공간', { exact: true });
    const parentPicker = dialog.getByLabel('상위 문서', { exact: true });
    await expect(target).toBeFocused();
    await expect(target).toHaveValue(sourceProject.id);
    await target.selectOption(targetProject.id);
    await parentPicker.selectOption(parent.id);
    await dialog.getByLabel('가져올 ZIP 파일', { exact: true }).setInputFiles(downloaded);

    const close = dialog.getByRole('button', { name: '가져오기 닫기', exact: true });
    page.once('dialog', prompt => { void prompt.dismiss(); });
    await close.click();
    await expect(dialog).toBeVisible();
    await target.press('Control+s');
    const before = await readWorkspace();
    expect(before.documents.find(item => item.id === root.id)).toEqual(root);
    const importedDocs = async () => (await readWorkspace()).documents.filter(document => document.projectId === targetProject.id
      && [rootTitle, childTitle].includes(document.title));
    const previewRequest = page.waitForResponse(response => new URL(response.url()).pathname === previewEndpoint);
    await dialog.getByRole('button', { name: 'ZIP 미리보기', exact: true }).click();
    const previewResponse = await previewRequest;
    expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
    expect(new URL(previewResponse.url()).searchParams.get('projectId')).toBe(targetProject.id);
    expect(new URL(previewResponse.url()).searchParams.get('parentId')).toBe(parent.id);
    const review = dialog.getByRole('region', { name: 'ZIP 가져오기 미리보기', exact: true });
    await expect(review).toContainText('문서 2개 · 첨부 2개');
    await expect(review).toContainText(rootTitle);
    await expect(review).toContainText(childTitle);
    expect(await importedDocs()).toEqual([]);

    // Let the first apply commit, then drop the browser response so the same preview is used on recheck.
    await page.route(url => url.pathname === applyEndpoint, async route => {
      const applied = await route.fetch();
      expect(applied.ok(), await applied.text()).toBe(true);
      await route.abort('failed');
    }, { times: 1 });
    await review.getByRole('button', { name: '문서와 첨부 가져오기', exact: true }).click();
    const recheck = review.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(recheck).toBeVisible();
    await expect(target).toBeDisabled();
    expect(await importedDocs()).toHaveLength(2);
    await recheck.click();
    await expect(dialog.getByRole('heading', { name: '가져오기 완료', exact: true })).toBeVisible();
    const receipt = dialog.getByRole('region', { name: '가져오기 완료', exact: true });
    await expect(receipt).toContainText('문서 2개 · 첨부 2개');
    await expect(receipt.getByRole('button', { name: `${rootTitle} 열기`, exact: true })).toBeVisible();

    const imported = await importedDocs();
    expect(imported).toHaveLength(2);
    const savedRoot = imported.find(item => item.title === rootTitle)!;
    const savedChild = imported.find(item => item.title === childTitle)!;
    expect(savedRoot).toMatchObject({ parentId: parent.id, status: 'draft', version: 1 });
    expect(savedRoot.plainText).toContain(original);
    expect(savedRoot.plainText).not.toContain(localDraft.trim());
    expect(savedChild).toMatchObject({ parentId: savedRoot.id, status: 'draft', version: 1 });
    expect(savedChild.plainText).toContain(childText);
    const importedFiles = await json<AttachmentHead[]>(await request.get(`/api/attachments?${new URLSearchParams({
      resourceType: 'document', resourceId: savedChild.id,
    })}`));
    expect(importedFiles).toHaveLength(2);
    const savedAttachment = importedFiles.find(file => file.filename === filename)!;
    const savedImage = importedFiles.find(file => file.filename === imageName)!;
    expect(savedAttachment).toMatchObject({ size: bytes.length });
    expect(savedAttachment.id).not.toBe(attachment.id);
    expect(savedImage).toMatchObject({ size: imageBytes.length, mimeType: 'image/png' });
    expect(savedImage.id).not.toBe(image.id);
    const importedBytes = await request.get(`/api/attachments/${savedAttachment.id}/content`);
    expect(importedBytes.ok(), await importedBytes.text()).toBe(true);
    expect(await importedBytes.body()).toEqual(bytes);

    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(importButton).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/documents/${root.id}$`));
    await expect(sourceParagraph).toContainText(localDraft.trim());
    expect((await readWorkspace()).documents.find(item => item.id === root.id)).toEqual(root);

    const reader = await context.newPage();
    try {
      const imagePath = `/api/attachments/${savedImage.id}/content?inline=1`;
      const imageRequest = reader.waitForResponse(response => response.url().endsWith(imagePath));
      await reader.goto(`/#/${targetProject.id}/documents/${savedChild.id}`);
      await expect(reader.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(childTitle);
      await expect(reader.locator('.docs-prose p').filter({ hasText: childText }).first()).toBeVisible();
      const importedImage = reader.getByRole('img', { name: imageAlt, exact: true });
      await expect(importedImage).toHaveAttribute('src', imagePath);
      await importedImage.scrollIntoViewIfNeeded();
      await expect(importedImage).toHaveJSProperty('naturalWidth', 1);
      const response = await imageRequest;
      expect(response.ok()).toBe(true);
      expect(response.headers()['content-type']).toBe('image/png');
      expect(await response.body()).toEqual(imageBytes);
    } finally { await reader.close(); }
  } finally {
    const fixtures = (await readWorkspace()).documents.filter(document => document.title.startsWith(prefix));
    const byId = new Map(fixtures.map(document => [document.id, document]));
    const depth = (document: DocPage): number => {
      const parent = document.parentId ? byId.get(document.parentId) : undefined;
      return parent ? depth(parent) + 1 : 0;
    };
    for (const document of fixtures.sort((a, b) => depth(b) - depth(a))) {
      const removed = await request.delete(`/api/documents/${document.id}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
  }
});
