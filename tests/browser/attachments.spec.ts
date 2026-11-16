import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { Attachment, DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types';

const containsImage = (node: RichContent, src: string): boolean => (node.type === 'image' && node.attrs?.src === src) || Boolean(node.content?.some(child => containsImage(child, src)));

test('문서 첨부파일은 실제 바이트로 저장·다운로드되고 본문 이미지 참조가 유지된다', async ({ page, playwright, baseURL }, testInfo) => {
  // A complete synthetic 1×1 PNG. The browser and filesystem fixture are never
  // given any real team file, token, or legacy Jira/Confluence attachment.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  const prefix = `첨부 회귀 검증 ${randomUUID()}`;
  const filename = `${prefix}.png`;
  // Independent from page.request so cleanup can still run after page timeout.
  const requests = await playwright.request.newContext({ baseURL });
  let created: DocPage | undefined;
  try {
    const workspaceResponse = await requests.get('/api/workspace');
    expect(workspaceResponse.ok()).toBeTruthy();
    const workspace = await workspaceResponse.json() as WorkspaceSnapshot;
    const creation = await requests.post('/api/documents', {
      data: { projectId: workspace.projects[0].id, title: prefix, content: { type: 'doc', content: [{ type: 'paragraph' }] } },
    });
    expect(creation.status()).toBe(201);
    created = await creation.json() as DocPage;
    const document = created;
    await page.goto(`/#/${document.projectId}/documents/${document.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(prefix);
    await page.getByRole('button', { name: '파일 첨부', exact: true }).click();
    await expect(page.getByRole('heading', { name: '문서에 자료 모으기', exact: true })).toBeVisible();

    const uploadedResponse = page.waitForResponse(response => response.url().includes('/api/attachments?') && response.request().method() === 'POST');
    await page.getByLabel('첨부할 파일 선택', { exact: true }).setInputFiles({ name: filename, mimeType: 'image/png', buffer: png });
    const uploaded = await uploadedResponse;
    expect(uploaded.status()).toBe(201);
    const attachment = await uploaded.json() as Attachment;
    expect(attachment.resourceType).toBe('document');
    expect(attachment.resourceId).toBe(document.id);
    expect(attachment.filename).toBe(filename);
    expect(attachment.mimeType).toBe('image/png');
    expect(attachment.size).toBe(png.length);
    expect(attachment.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    await expect(page.locator('.attachment-row').filter({ hasText: filename })).toBeVisible();

    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: `${filename} 다운로드`, exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(filename);
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    expect(await readFile(downloadPath!)).toEqual(png);

    await page.getByRole('button', { name: '본문에 삽입', exact: true }).click();
    const inlinePath = `/api/attachments/${attachment.id}/content?inline=1`;
    await expect(page.locator('.docs-prose img')).toHaveAttribute('src', inlinePath);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    await expect.poll(async () => {
      const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
      const saved = snapshot.documents.find(value => value.id === document.id);
      return saved ? containsImage(saved.content, inlinePath) : false;
    }).toBe(true);

    await page.reload();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(prefix);
    await expect(page.locator('.docs-prose img')).toHaveAttribute('src', inlinePath);
    await expect.poll(async () => page.locator('.docs-prose img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
    await page.getByRole('button', { name: '파일', exact: true }).click();
    await expect(page.locator('.attachment-row').filter({ hasText: filename })).toBeVisible();
    const persistedBytes = await requests.get(`/api/attachments/${attachment.id}/content`);
    expect(persistedBytes.ok()).toBeTruthy();
    expect(await persistedBytes.body()).toEqual(png);

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: `${filename} 삭제`, exact: true }).click();
    await expect(page.locator('.attachment-row').filter({ hasText: filename })).toHaveCount(0);
    const afterDeletion = await requests.get(`/api/attachments/${attachment.id}/content`);
    expect(afterDeletion.status()).toBe(404);
  } finally {
    try {
      const response = await requests.get('/api/workspace', { timeout: 5_000 });
      const workspace = response.ok() ? await response.json() as WorkspaceSnapshot : undefined;
      const ids = new Set(workspace?.documents.filter(document => document.title.startsWith(prefix)).map(document => document.id));
      if (created) ids.add(created.id);
      const failures: string[] = [];
      for (const id of ids) {
        const response = await requests.delete(`/api/documents/${id}`, { timeout: 5_000 });
        if (!response.ok() && response.status() !== 404) failures.push(`${id}: ${response.status()}`);
      }
      if (failures.length) {
        await testInfo.attach('attachment-cleanup-failures', { body: failures.join('\n'), contentType: 'text/plain' });
        throw new Error(`합성 첨부 문서를 정리하지 못했습니다: ${failures.join(', ')}`);
      }
    } finally { await requests.dispose(); }
  }
});
