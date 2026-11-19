import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AttachmentHead, DocPage, WorkspaceSnapshot } from '../../shared/types';

const originalPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
const revisedPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNgYPj/n4EBAAcAAf8DN59tAAAAAElFTkSuQmCC', 'base64');
const inlineUrl = (versionId: string) => `/api/attachments/${versionId}/content?inline=1`;

async function download(page: Page, link: Locator, filename: string, bytes: Buffer) {
  const pending = page.waitForEvent('download');
  await link.click();
  const saved = await pending;
  expect(saved.suggestedFilename()).toBe(filename);
  expect(await readFile((await saved.path())!)).toEqual(bytes);
}

test('문서에서 첨부 버전을 올리고 두 이미지와 이전 다운로드를 고정된 버전으로 연다', async ({ page, playwright, baseURL }) => {
  const requests = await playwright.request.newContext({ baseURL });
  let doc: DocPage | undefined;
  const suffix = randomUUID();
  const firstName = `첨부 원본 ${suffix}.png`;
  const nextName = `첨부 수정본 ${suffix}.png`;
  try {
    const workspace = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    const created = await requests.post('/api/documents', { data: { title: `첨부 버전 검증 ${suffix}`, projectId: workspace.projects[0].id } });
    expect(created.status(), await created.text()).toBe(201);
    doc = await created.json() as DocPage;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${doc.projectId}/documents/${doc.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(doc.title);
    const openAttachments = () => page.getByRole('button', { name: '파일 첨부', exact: true }).click();
    const closePanel = () => page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();
    await openAttachments();
    const attachments = page.getByRole('region', { name: '첨부파일', exact: true });
    const editor = page.locator('.docs-prose');
    const rows = attachments.locator('.attachment-row');
    const insert = attachments.getByRole('button', { name: '본문에 삽입', exact: true });
    const save = page.locator('.docs-save-button');

    const initialResponse = page.waitForResponse(response => response.url().includes('/api/attachments?') && response.request().method() === 'POST');
    await attachments.getByLabel('첨부할 파일 선택', { exact: true }).setInputFiles({ name: firstName, mimeType: 'image/png', buffer: originalPng });
    const uploaded = await initialResponse;
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const original = await uploaded.json() as AttachmentHead;
    const oldSrc = inlineUrl(original.currentVersionId);
    await insert.click();
    await expect(editor.locator('img')).toHaveAttribute('src', oldSrc);
    await closePanel();
    await save.click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    await openAttachments();

    const nextResponse = page.waitForResponse(response => response.url().includes(`/api/attachments/${original.id}/versions?`) && response.request().method() === 'POST');
    const chooser = page.waitForEvent('filechooser');
    await attachments.getByRole('button', { name: `${firstName} 새 버전 업로드`, exact: true }).click();
    await (await chooser).setFiles({ name: nextName, mimeType: 'image/png', buffer: revisedPng });
    const appended = await nextResponse;
    expect(appended.status(), await appended.text()).toBe(201);
    const latest = await appended.json() as AttachmentHead;
    expect(latest.id).toBe(original.id);
    expect(latest.currentVersionId).not.toBe(original.currentVersionId);
    expect(latest.versionCount).toBe(2);
    await expect(rows).toHaveCount(1);
    const history = attachments.getByRole('region', { name: `${nextName} 보존 버전`, exact: true });
    await expect(history).toBeVisible();
    await expect(history.getByText('최신 버전', { exact: false })).toBeVisible();
    const historyBounds = await history.boundingBox();
    expect(historyBounds!.x).toBeGreaterThanOrEqual(0);
    expect(historyBounds!.x + historyBounds!.width).toBeLessThanOrEqual(360);
    await download(page, attachments.getByRole('link', { name: `${nextName} 다운로드`, exact: true }), nextName, revisedPng);
    await download(page, history.getByRole('link', { name: `${nextName} 버전 v1 다운로드`, exact: true }), firstName, originalPng);
    await expect(editor.locator('img')).toHaveAttribute('src', oldSrc);

    await closePanel();
    await editor.press('Control+End');
    await editor.press('Enter');
    await openAttachments();
    await insert.click();
    const newSrc = inlineUrl(latest.currentVersionId);
    await expect(editor.locator(`img[src="${newSrc}"]`)).toBeVisible();
    await expect(editor.locator(`img[src="${oldSrc}"]`)).toBeVisible();
    await closePanel();
    await save.click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    await page.reload();
    const displayed = () => editor.locator('img').evaluateAll(nodes => nodes.map(node => ({
      src: node.getAttribute('src'), width: (node as HTMLImageElement).naturalWidth,
    })).sort((a, b) => a.width - b.width));
    await expect.poll(displayed).toEqual([{ src: oldSrc, width: 1 }, { src: newSrc, width: 2 }]);

    await openAttachments();
    const stalePicker = page.waitForEvent('filechooser');
    await attachments.getByRole('button', { name: `${nextName} 새 버전 업로드`, exact: true }).click();
    const pending = await stalePicker;
    const winnerName = `다른 사용자의 수정본 ${suffix}.png`;
    const query = new URLSearchParams({ expectedVersionId: latest.currentVersionId, filename: winnerName });
    const external = await requests.post(`/api/attachments/${original.id}/versions?${query}`, {
      data: originalPng, headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': workspace.users[1].id },
    });
    expect(external.status(), await external.text()).toBe(201);
    const conflict = page.waitForResponse(response => response.url().includes(`/api/attachments/${original.id}/versions?`) && response.request().method() === 'POST');
    await pending.setFiles({ name: `오래된 선택 ${suffix}.png`, mimeType: 'image/png', buffer: revisedPng });
    expect((await conflict).status()).toBe(409);
    await expect(attachments.getByRole('alert')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(winnerName);
    await expect.poll(displayed).toEqual([{ src: oldSrc, width: 1 }, { src: newSrc, width: 2 }]);
  } finally {
    try {
      if (doc) {
        const removed = await requests.delete(`/api/documents/${doc.id}`, { timeout: 5000 });
        expect([200, 404]).toContain(removed.status());
      }
    } finally { await requests.dispose(); }
  }
});
