import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { documentNodes } from '../../shared/document-references';
import { documentSectionHash, isMarkdownImportSectionId } from '../../shared/document-sections';
import type { DocPage, DocRevision, WorkspaceSnapshot } from '../../shared/types';

async function readWorkspace(request: APIRequestContext) {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as WorkspaceSnapshot;
}

async function removeTestDocuments(request: APIRequestContext, prefix: string) {
  const documents = (await readWorkspace(request)).documents.filter(document => document.title.startsWith(prefix));
  for (const document of documents.sort((left, right) => Number(Boolean(right.parentId)) - Number(Boolean(left.parentId)))) {
    const archived = await request.delete(`/api/documents/${document.id}`);
    expect(archived.ok(), await archived.text()).toBe(true);
    const { trashEntryId } = await archived.json() as { trashEntryId: string };
    const purged = await request.delete(`/api/trash/${trashEntryId}`);
    expect(purged.ok(), await purged.text()).toBe(true);
  }
}

async function openImport(page: Page, projectId: string, parentId?: string) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`/#/${projectId}/documents${parentId ? `/${parentId}` : ''}`);
  await page.getByRole('button', { name: '새 문서', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 문서 만들기', exact: true });
  await dialog.getByRole('button', { name: /Markdown 가져오기/u }).click();
  if (parentId) await dialog.getByRole('combobox', { name: '상위 문서', exact: true }).selectOption(parentId);
  return dialog;
}

test('360px에서 Markdown 파일을 검토하고 상위 문서 아래에서 편집 가능한 초안으로 저장한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const prefix = `Markdown 파일 ${randomUUID().slice(0, 8)}`;
  const heading = `${prefix} 배포 절차`, title = `${prefix} 편집할 초안`;
  const parentTitle = `${prefix} 상위 문서`;
  const projectId = (await readWorkspace(request)).projects[0].id;
  const parentResponse = await request.post('/api/documents', { data: { projectId, title: parentTitle } });
  expect(parentResponse.status(), await parentResponse.text()).toBe(201);
  const parent = await parentResponse.json() as DocPage;

  const sourceUrl = 'https://gitlab.example.invalid/infra/team/-/blob/main/docs/README.md';
  const originalUrl = 'https://gitlab.example.invalid/infra/team/-/blob/main/archive/docs/README.md';
  const resolvedLink = 'https://gitlab.example.invalid/infra/team/-/blob/main/RunBooks/Recovery.md#RollBack';
  const imageUrl = 'https://assets.example.invalid/team/deployment.png';
  const rawHtml = '<div data-markdown-example="literal">그대로 보존할 HTML</div>';
  const source = [
    `# ${heading}`, '',
    '첫 절차는 **배포 승인**이고 [복구 절차](../RunBooks/Recovery.md#RollBack)를 확인합니다.', '',
    '- [x] 승인 기록', '- [ ] 운영 확인', '',
    '| 구간 | 담당 |', '| --- | --- |', '| 확인 | 운영팀 |', '',
    '```bash', 'echo deployment-check', '```', '',
    `![배포 그림](${imageUrl})`, '', rawHtml, '',
    '[같은 문서의 릴리스 절](#릴리스-확인)', '', '## 릴리스 확인', '', '릴리스 내용을 확인합니다.',
  ].join('\n');

  const externalRequests: string[] = [];
  await page.route(/^https:\/\/(?:gitlab|assets)\.example\.invalid\//, async route => {
    externalRequests.push(route.request().url());
    await route.abort();
  });

  try {
    const dialog = await openImport(page, projectId, parent.id);
    const previewButton = dialog.getByRole('button', { name: '미리보기', exact: true });
    const preview = dialog.getByRole('region', { name: 'Markdown 미리보기', exact: true });
    const submit = dialog.getByRole('button', { name: 'Markdown 문서 만들기', exact: true });
    const titleInput = dialog.getByRole('textbox', { name: '문서 제목', exact: true });
    const sourceUrlInput = dialog.getByLabel(/^원본 파일 URL/u);
    const fileInput = dialog.getByLabel('Markdown 파일', { exact: true });
    const sourceInput = dialog.getByRole('textbox', { name: 'Markdown 내용', exact: true });

    await fileInput.setInputFiles({ name: 'broken.md', mimeType: 'text/markdown', buffer: Buffer.from([0xc3, 0x28]) });
    await expect(dialog.getByRole('alert')).toContainText('UTF-8');
    await expect(submit).toBeDisabled();

    await page.evaluate(() => {
      const originalRead = File.prototype.arrayBuffer;
      const release = new Promise<void>(resolve => window.addEventListener('release-markdown-file-read', () => resolve(), { once: true }));
      File.prototype.arrayBuffer = async function () {
        if (this.name === 'README.md') await release;
        return originalRead.call(this);
      };
    });
    await fileInput.setInputFiles({
      name: 'README.md', mimeType: 'text/markdown', buffer: Buffer.from(source),
    });
    await expect(dialog.getByText('파일 읽는 중…', { exact: true })).toBeVisible();
    await sourceUrlInput.fill(originalUrl);
    await page.evaluate(() => window.dispatchEvent(new Event('release-markdown-file-read')));
    await expect(sourceInput).toHaveValue(source);
    await expect(submit).toBeDisabled();
    await previewButton.click();
    await expect(preview).toBeVisible();
    await expect(preview.getByText('배포 승인', { exact: true })).toBeVisible();
    await expect(preview.getByRole('table')).toContainText('운영팀');
    await expect(dialog).toContainText(/HTML.*텍스트|텍스트.*HTML/u);
    await expect(dialog).toContainText(/이미지.*링크|링크.*이미지/u);
    await expect(preview.locator('img, [data-markdown-example]')).toHaveCount(0);
    expect((await readWorkspace(request)).documents.filter(document => document.title.startsWith(prefix))).toEqual([parent]);

    await titleInput.fill(title);
    await sourceUrlInput.fill(sourceUrl);
    await expect(submit).toBeDisabled();
    await previewButton.click();
    await expect(preview).toBeVisible();
    await expect(titleInput).toHaveValue(title);
    await expect(submit).toBeEnabled();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/documents' && response.request().method() === 'POST'),
      submit.click(),
    ]);
    expect(response.status(), await response.text()).toBe(201);
    const created = await response.json() as DocPage;
    expect(created).toMatchObject({ title, projectId, parentId: parent.id, status: 'draft', version: 1 });
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title);
    await expect(page).toHaveURL(new RegExp(`/documents/${created.id}$`));

    const saved = (await readWorkspace(request)).documents.find(document => document.id === created.id);
    expect(saved?.content).toEqual(created.content);
    const nodes = [...documentNodes(created.content)];
    expect(nodes.find(node => node.type === 'heading')).toMatchObject({
      attrs: { level: 1 }, content: [{ type: 'text', text: heading }],
    });
    expect(nodes.find(node => node.type === 'text' && node.text === '배포 승인')?.marks).toContainEqual({ type: 'bold' });
    expect(nodes.filter(node => node.type === 'taskItem').map(node => node.attrs?.checked)).toEqual([true, false]);
    expect(nodes.find(node => node.type === 'codeBlock')).toMatchObject({
      attrs: { language: 'bash' }, content: [{ type: 'text', text: 'echo deployment-check' }],
    });
    expect(nodes.filter(node => node.type === 'table')).toHaveLength(1);
    expect(nodes.find(node => node.type === 'text' && node.text === '복구 절차')?.marks).toContainEqual(
      expect.objectContaining({ type: 'link', attrs: expect.objectContaining({ href: resolvedLink }) }),
    );
    const sectionId = nodes.find(node => node.type === 'heading' && node.content?.[0].text === '릴리스 확인')?.attrs?.sectionId;
    expect(isMarkdownImportSectionId(sectionId)).toBe(true);
    const sectionHref = documentSectionHash(created.id, String(sectionId));
    expect(nodes.find(node => node.type === 'text' && node.text === '같은 문서의 릴리스 절')?.marks).toContainEqual(
      expect.objectContaining({ type: 'link', attrs: expect.objectContaining({ href: sectionHref }) }),
    );
    expect(nodes.some(node => node.type === 'image')).toBe(false);
    expect(created.plainText).toContain(rawHtml);

    await page.reload();
    const editor = page.locator('.docs-prose[contenteditable="true"]');
    await expect(editor.locator('h1')).toHaveText(heading);
    await expect(editor.getByRole('link', { name: '복구 절차', exact: true })).toHaveAttribute('href', resolvedLink);
    await expect(editor.getByRole('table')).toContainText('운영팀');
    await expect(editor.locator('pre code')).toHaveText('echo deployment-check');
    await expect(editor).toContainText(rawHtml);
    await expect(editor.locator('img, [data-markdown-example]')).toHaveCount(0);
    const sectionLink = editor.getByRole('link', { name: '같은 문서의 릴리스 절', exact: true });
    await expect(sectionLink).toHaveAttribute('href', sectionHref);
    await sectionLink.click();
    await expect(page).toHaveURL(url => url.hash === documentSectionHash(created.id, String(sectionId), projectId));
    const sectionHeading = editor.getByRole('heading', { name: '릴리스 확인', level: 2, exact: true });
    await expect(sectionHeading).toHaveAttribute('data-document-section-id', String(sectionId));
    await expect(sectionHeading).toBeInViewport();
    expect(externalRequests).toEqual([]);
  } finally {
    await removeTestDocuments(request, prefix);
  }
});

test('Markdown 문서 저장 응답과 목록을 잃어도 한 초안의 결과를 다시 연다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const prefix = `Markdown 저장 재시도 ${randomUUID().slice(0, 8)}`;
  const projectId = (await readWorkspace(request)).projects[0].id;
  const attempts: { status: number; body: string | null; actor: string | undefined }[] = [];
  let failRefresh = false;

  try {
    const dialog = await openImport(page, projectId);
    await dialog.getByRole('textbox', { name: 'Markdown 내용', exact: true }).fill(`# ${prefix}\n\n한 번만 저장할 본문입니다.`);
    await dialog.getByRole('button', { name: '미리보기', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Markdown 미리보기', exact: true })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(prefix);

    await page.route('**/api/workspace', async route => {
      if (!failRefresh) return route.continue();
      failRefresh = false;
      await route.fulfill({ status: 503, json: { error: '목록 응답을 잃었습니다.' } });
    });
    await page.route('**/api/documents', async route => {
      const request = route.request();
      if (request.method() !== 'POST' || request.postDataJSON()?.title !== prefix) return route.continue();
      const response = await route.fetch();
      attempts.push({ status: response.status(), body: request.postData(), actor: request.headers()['x-actor-id'] });
      if (attempts.length === 1) return route.abort('failed');
      if (attempts.length === 2) failRefresh = true;
      await route.fulfill({ response });
    });

    await dialog.getByRole('button', { name: 'Markdown 문서 만들기', exact: true }).click();
    const retry = dialog.getByRole('button', { name: '저장 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    const savedDocuments = () => readWorkspace(request).then(workspace => workspace.documents.filter(document => document.title === prefix));
    const first = await savedDocuments();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'draft', version: 1, projectId });
    expect(first[0].plainText).toContain('한 번만 저장할 본문입니다.');

    await retry.click();
    const reopen = dialog.getByRole('button', { name: '저장한 문서 열기', exact: true });
    await expect(reopen).toBeVisible();
    expect(attempts.map(attempt => attempt.status)).toEqual([201, 200]);
    expect(attempts[1].body).toBe(attempts[0].body);
    expect(attempts[1].actor).toBe(attempts[0].actor);
    expect(attempts[0].actor).toBeTruthy();
    expect(JSON.parse(attempts[0].body!).requestId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);

    await reopen.click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/documents/${first[0].id}$`));
    await expect(page.locator('.docs-prose')).toContainText('한 번만 저장할 본문입니다.');
    expect(attempts).toHaveLength(2);
    expect(await savedDocuments()).toEqual(first);
    const revisions = await (await request.get(`/api/documents/${first[0].id}/revisions`)).json() as DocRevision[];
    expect(revisions.map(revision => revision.version)).toEqual([1]);
  } finally {
    await removeTestDocuments(request, prefix);
  }
});
