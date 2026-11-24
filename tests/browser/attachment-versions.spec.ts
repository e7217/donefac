import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AttachmentHead, DocPage, DocRevision, WorkspaceSnapshot } from '../../shared/types';

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

test('360px에서 파일 버전 링크를 본문에 넣고 고정본에서 휴지통의 원래 바이트를 받는다', async ({ page, playwright, baseURL }) => {
  const requests = await playwright.request.newContext({ baseURL });
  const created: DocPage[] = [];
  const suffix = randomUUID().slice(0, 8);
  const originalName = `작업 절차 초판 ${suffix}.txt`;
  const latestName = `작업 절차 개정 ${suffix}.txt`;
  const originalBytes = Buffer.from('initial procedure\n', 'utf8');
  const latestBytes = Buffer.from('updated procedure\n', 'utf8');
  const firstParagraph = '공동 편집 파일을 추가할 문단';
  const secondParagraph = '검토 당시 파일을 연결할 문단';
  const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

  try {
    const [project] = (await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot).projects;
    const create = async (title: string, content: DocPage['content']) => {
      const response = await requests.post('/api/documents', { data: { projectId: project.id, title, content } });
      expect(response.status(), await response.text()).toBe(201);
      const document = await response.json() as DocPage;
      created.push(document);
      return document;
    };
    const source = await create(`버전 파일 원문 ${suffix}`, { type: 'doc', content: [paragraph(firstParagraph), paragraph(secondParagraph)] });
    const upload = await requests.post(`/api/attachments?${new URLSearchParams({ resourceType: 'document', resourceId: source.id, filename: originalName })}`, {
      data: originalBytes, headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(upload.status(), await upload.text()).toBe(201);
    const first = await upload.json() as AttachmentHead;
    const append = await requests.post(`/api/attachments/${first.id}/versions?${new URLSearchParams({
      expectedVersionId: first.currentVersionId, filename: latestName,
    })}`, { data: latestBytes, headers: { 'Content-Type': 'application/octet-stream' } });
    expect(append.status(), await append.text()).toBe(201);
    const latest = await append.json() as AttachmentHead;
    const oldHref = `/api/attachments/${first.currentVersionId}/content`;
    const newHref = `/api/attachments/${latest.currentVersionId}/content`;

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/documents/${source.id}`);
    const manual = page.locator('.docs-prose');
    await manual.getByText(secondParagraph, { exact: true }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect.poll(() => manual.evaluate(() => window.getSelection()?.toString())).toBe(secondParagraph);
    const openFiles = () => page.getByRole('button', { name: '파일 첨부', exact: true }).click();
    const closePanel = () => page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();
    const attachments = page.getByRole('region', { name: '첨부파일', exact: true });
    await openFiles();
    await attachments.getByRole('button', { name: `${latestName} 버전`, exact: true }).click();
    const versions = attachments.getByRole('region', { name: `${latestName} 보존 버전`, exact: true });
    await versions.getByRole('button', { name: `${latestName} 버전 v1 본문에 링크 삽입`, exact: true }).click();
    await expect(manual.locator('p').filter({ hasText: secondParagraph }).getByRole('link', { name: originalName })).toHaveAttribute('href', oldHref);
    await expect(manual.locator('p').filter({ hasText: firstParagraph }).getByRole('link')).toHaveCount(0);
    await closePanel();
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

    const revisions = await (await requests.get(`/api/documents/${source.id}/revisions`)).json() as DocRevision[];
    const captured = revisions.find(revision => revision.version > source.version);
    expect(captured).toBeDefined();
    const host = await create(`버전 파일 고정본 ${suffix}`, { type: 'doc', content: [{ type: 'documentRevisionInclude', attrs: {
      documentId: source.id, revisionId: captured!.id, label: source.title,
    } }] });

    const enabling = await requests.post(`/api/documents/${source.id}/collaboration/enable`, { data: { expectedVersion: captured!.version } });
    expect(enabling.status(), await enabling.text()).toBe(200);
    await page.reload();
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    const live = page.locator('.docs-live-prose');
    await live.getByText(firstParagraph, { exact: true }).click();
    await page.keyboard.press('End');
    await openFiles();
    await attachments.getByRole('button', { name: `${latestName} 본문에 링크 삽입`, exact: true }).click();
    await expect(live.locator('p').filter({ hasText: firstParagraph }).getByRole('link', { name: latestName })).toHaveAttribute('href', newHref);
    await expect.poll(async () => {
      const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
      return JSON.stringify(snapshot.documents.find(document => document.id === source.id)?.content);
    }).toContain(newHref);

    const removed = await requests.delete(`/api/attachments/${first.id}?expectedVersionId=${latest.currentVersionId}`);
    expect(removed.status(), await removed.text()).toBe(200);
    expect((await requests.get(oldHref)).status()).toBe(404);
    await page.goto(`/#/${project.id}/documents/${host.id}`);
    const frozen = page.getByRole('region', { name: `고정 포함 문서 ${source.title}`, exact: true });
    await frozen.getByRole('button', { name: '고정 버전 내용 보기', exact: true }).click();
    const link = frozen.getByRole('link', { name: originalName, exact: true });
    await expect(link).toHaveAttribute('href', `/api/documents/${source.id}/include-revisions/${captured!.id}/files/${first.currentVersionId}`);
    await expect(frozen.getByRole('link', { name: latestName, exact: true })).toHaveCount(0);
    await download(page, link, originalName, originalBytes);
  } finally {
    try {
      for (const document of created.reverse()) {
        const response = await requests.delete(`/api/documents/${document.id}`, { timeout: 5000 });
        if (response.status() === 404) continue;
        expect(response.status(), await response.text()).toBe(200);
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        expect((await requests.delete(`/api/trash/${trashEntryId}`, { timeout: 5000 })).ok()).toBeTruthy();
      }
    } finally { await requests.dispose(); }
  }
});
