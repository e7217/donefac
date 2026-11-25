import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes';
import { documentNodes } from '../../shared/document-references';
import { documentSectionHash } from '../../shared/document-sections';
import type { AttachmentHead, DocPage, DocRevision, DocumentTemplateSummary, RichContent, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse, expectedStatus = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(expectedStatus);
  return response.json();
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

function templateList(request: APIRequestContext, projectId: string | null) {
  return request.get(projectId ? `/api/document-templates?projectId=${encodeURIComponent(projectId)}` : '/api/document-templates')
    .then(response => json<DocumentTemplateSummary[]>(response));
}

function createDocument(request: APIRequestContext, projectId: string | null, title: string, content?: RichContent) {
  return request.post('/api/documents', { data: { projectId, title, ...(content && { content }) } })
    .then(response => json<DocPage>(response, 201));
}

function captureTemplate(request: APIRequestContext, document: DocPage, name: string) {
  return request.post('/api/document-templates', { data: {
    requestId: randomUUID(), name, sourceDocumentId: document.id, expectedDocumentVersion: document.version,
  } }).then(response => json<DocumentTemplateSummary>(response, 201));
}

async function purgeDocument(request: APIRequestContext, document: DocPage) {
  const archived = await json<{ trashEntryId: string }>(await request.delete(`/api/documents/${document.id}?expectedVersion=${document.version}`));
  const purged = await request.delete(`/api/trash/${archived.trashEntryId}`);
  expect(purged.ok(), await purged.text()).toBe(true);
}

async function cleanup(request: APIRequestContext, prefix: string, projectId: string) {
  for (const template of (await templateList(request, projectId)).filter(value => value.name.startsWith(prefix))) {
    const response = await request.patch(`/api/document-templates/${template.id}`, { data: { expectedVersion: template.version, archived: true } });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const documents = (await workspace(request)).documents.filter(value => value.title.startsWith(prefix));
  for (const document of documents.sort((left, right) => Number(Boolean(right.parentId)) - Number(Boolean(left.parentId)))) {
    await purgeDocument(request, document);
  }
}

const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const body = (text: string): RichContent => ({ type: 'doc', content: [paragraph(text)] });

function captureDialog(page: Page) {
  const dialog = page.getByRole('dialog', { name: '팀 문서 템플릿', exact: true });
  return { dialog, name: dialog.getByRole('textbox', { name: '템플릿 이름', exact: true }) };
}

async function openNew(page: Page) {
  await page.getByRole('button', { name: '새 문서', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 문서 만들기', exact: true });
  await expect(dialog).toBeVisible();
  return {
    dialog,
    select: dialog.getByRole('combobox', { name: '팀 템플릿', exact: true }),
    title: dialog.getByRole('textbox', { name: '문서 제목', exact: true }),
    space: dialog.getByRole('combobox', { name: '공간', exact: true }),
    submit: dialog.getByRole('button', { name: '문서 만들기', exact: true }),
  };
}

function waitForMutation(page: Page, method: 'POST' | 'PATCH', pathname: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
}

async function expectFitsMobile(dialog: Locator) {
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
}

test('360px 내장 템플릿의 문서 생성 응답을 잃어도 한 번만 만들고 목록을 다시 연다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [actor] } = await workspace(request);
  const prefix = `내장 문서 생성 ${randomUUID().slice(0, 8)}`;
  const title = `${prefix} 회의록`;
  const parent = await createDocument(request, project.id, `${prefix} 상위 문서`);
  const attempts: { status: number; body: string | null; actor: string | undefined }[] = [];
  let failRefresh = false;
  const createdDocuments = () => workspace(request).then(snapshot => snapshot.documents.filter(document => document.title === title));

  try {
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${project.id}/documents/${parent.id}`);
    const { dialog, title: titleInput, submit } = await openNew(page);
    await dialog.getByRole('button', { name: /회의록/u }).click();
    await titleInput.fill(title);
    const parentInput = dialog.getByRole('combobox', { name: '상위 문서', exact: true });
    await parentInput.selectOption(parent.id);

    await page.route('**/api/workspace', async route => {
      if (!failRefresh) return route.continue();
      failRefresh = false;
      await route.fulfill({ status: 503, json: { error: '목록 응답을 잃었습니다.' } });
    });
    await page.route('**/api/documents', async route => {
      const request = route.request();
      if (request.method() !== 'POST' || request.postDataJSON()?.title !== title) return route.continue();
      const response = await route.fetch();
      attempts.push({ status: response.status(), body: request.postData(), actor: request.headers()['x-actor-id'] });
      if (attempts.length === 1) return route.abort('failed');
      if (attempts.length === 2) failRefresh = true;
      await route.fulfill({ response });
    });

    await submit.click();
    const retry = dialog.getByRole('button', { name: /^(문서 만들기|저장 다시 확인)$/u });
    await expect(retry).toBeEnabled();
    const first = await createdDocuments();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ version: 1, projectId: project.id, parentId: parent.id, authorId: actor.id });
    expect(first[0].plainText).toContain('회의 정보');
    await retry.click();
    await expect.poll(() => attempts.length).toBe(2);
    expect(await createdDocuments()).toEqual(first);
    expect(attempts.map(attempt => attempt.status)).toEqual([201, 200]);
    expect(attempts[1].body).toBe(attempts[0].body);
    expect(attempts.map(attempt => attempt.actor)).toEqual([actor.id, actor.id]);

    const reopen = dialog.getByRole('button', { name: '저장한 문서 열기', exact: true });
    await expect(reopen).toBeFocused();
    await expect(dialog.getByRole('alert')).toContainText('목록');
    await expect(titleInput).toBeDisabled();
    await expect(parentInput).toBeDisabled();
    await reopen.click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/documents/${first[0].id}$`));
    await expect(page.locator('.docs-prose')).toContainText('회의 정보');
    expect(attempts).toHaveLength(2);
    expect(await createdDocuments()).toEqual(first);
    const revisions = await json<DocRevision[]>(await request.get(`/api/documents/${first[0].id}/revisions`));
    expect(revisions.map(revision => revision.version)).toEqual([1]);
  } finally {
    await cleanup(request, prefix, project.id);
  }
});

test('360px에서 원본이 삭제된 템플릿의 본문 이미지와 첨부를 열 수 있다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [actor] } = await workspace(request);
  const prefix = `합성 첨부 양식 ${randomUUID().slice(0, 8)}`;
  const title = `${prefix} 새 초안`;
  const templateName = `${prefix} 팀 템플릿`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  const textBytes = Buffer.from('문서 템플릿 다운로드 검증용 원문\n');
  const logoAlt = '합성 양식 로고';
  const linkLabel = '체크리스트 열기';

  try {
    const landing = await createDocument(request, project.id, `${prefix} 시작 문서`);
    const original = await createDocument(request, project.id, `${prefix} 원본`);
    const upload = async (filename: string, bytes: Buffer) => json<AttachmentHead>(await request.post('/api/attachments', {
      params: { resourceType: 'document', resourceId: original.id, filename },
      headers: { 'Content-Type': 'application/octet-stream' }, data: bytes,
    }), 201);
    const logo = await upload('양식 로고.png', png);
    const checklist = await upload('점검 목록.txt', textBytes);
    const logoPath = `/api/attachments/${logo.id}/content?inline=1`;
    const checklistPath = `/api/attachments/${checklist.id}/content`;
    const content: RichContent = { type: 'doc', content: [
      { type: 'image', attrs: { src: logoPath, alt: logoAlt } },
      { type: 'paragraph', content: [{ type: 'text', text: linkLabel, marks: [{ type: 'link', attrs: { href: checklistPath } }] }] },
    ] };
    const source = await json<DocPage>(await request.patch(`/api/documents/${original.id}`, { data: {
      expectedVersion: original.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content,
    } }));
    await page.addInitScript(actorId => localStorage.setItem('teamspace.actor', actorId), actor.id);
    await page.goto(`/#/${project.id}/documents/${source.id}`);
    await page.getByRole('button', { name: '팀 템플릿으로 저장', exact: true }).click();
    const manager = captureDialog(page);
    await expect(manager.dialog).toContainText(source.title);
    await expectFitsMobile(manager.dialog);
    await manager.name.fill(templateName);
    const captured = waitForMutation(page, 'POST', '/api/document-templates');
    await manager.dialog.getByRole('button', { name: '템플릿 저장', exact: true }).click();
    const captureResponse = await captured;
    expect(captureResponse.status(), await captureResponse.text()).toBe(201);
    expect(await captureResponse.json()).toMatchObject({ attachmentCount: 2 });
    await expect(manager.dialog.getByRole('button', { name: templateName, exact: true })).toContainText('첨부 2개');
    await manager.dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await purgeDocument(request, source);
    expect((await request.get(logoPath)).status()).toBe(404);
    expect((await request.get(checklistPath)).status()).toBe(404);

    await page.goto('about:blank');
    await page.goto(`/#/${project.id}/documents/${landing.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(landing.title);
    const form = await openNew(page);
    await form.select.selectOption({ label: templateName });
    await expect(form.dialog).toContainText('첨부 2개');
    await form.title.fill(title);
    const toggle = form.dialog.getByRole('button', { name: '템플릿 미리보기', exact: true });
    await toggle.click();
    const preview = form.dialog.getByRole('region', { name: '템플릿 저장본 미리보기', exact: true });
    await expect(preview).toContainText(`이미지 · ${logoAlt}`);
    await expect(preview).toContainText(linkLabel);
    await expect(preview.getByRole('img')).toHaveCount(0);
    await expect(preview.getByRole('link')).toHaveCount(0);
    await expectFitsMobile(form.dialog);
    await form.dialog.getByRole('button', { name: '템플릿 미리보기 닫기', exact: true }).click();
    await expect(form.title).toHaveValue(title);
    const applied = waitForMutation(page, 'POST', '/api/documents');
    await form.submit.click();
    const applyResponse = await applied;
    expect(applyResponse.status(), await applyResponse.text()).toBe(201);
    const draft = await applyResponse.json() as DocPage;
    await expect(form.dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/documents/${draft.id}$`));
    const copies = await json<AttachmentHead[]>(await request.get('/api/attachments', {
      params: { resourceType: 'document', resourceId: draft.id },
    }));
    expect(copies).toHaveLength(2);
    const copiedLogo = copies.find(file => file.filename === logo.filename)!;
    const copiedChecklist = copies.find(file => file.filename === checklist.filename)!;
    expect(copiedLogo.id).not.toBe(logo.id);
    expect(copiedChecklist.id).not.toBe(checklist.id);

    const editor = page.locator('.docs-prose[contenteditable="true"]');
    const image = editor.getByRole('img', { name: logoAlt, exact: true });
    await expect(image).toHaveAttribute('src', `/api/attachments/${copiedLogo.id}/content?inline=1`);
    await expect(image).toHaveJSProperty('naturalWidth', 1);
    const link = editor.getByRole('link', { name: linkLabel, exact: true });
    const copiedChecklistPath = `/api/attachments/${copiedChecklist.id}/content`;
    await expect(link).toHaveAttribute('href', copiedChecklistPath);
    const linkedFile = await request.get(copiedChecklistPath);
    expect(linkedFile.status()).toBe(200);
    expect(await linkedFile.body()).toEqual(textBytes);

    await page.getByRole('button', { name: '파일 첨부', exact: true }).click();
    await expect(page.locator('.attachment-row').filter({ hasText: logo.filename })).toBeVisible();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: `${checklist.filename} 다운로드`, exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(checklist.filename);
    const path = await download.path();
    expect(path).not.toBeNull();
    expect(await readFile(path!)).toEqual(textBytes);
  } finally {
    await cleanup(request, prefix, project.id);
  }
});

test('360px에서 저장한 문서 템플릿으로 독립 초안을 만들고 응답 유실을 재확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [actor] } = await workspace(request);
  const prefix = `합성 문서 양식 ${randomUUID().slice(0, 8)}`;
  const templateName = `${prefix} 설계 검토`;
  const newTitle = `${prefix} 새 초안`;
  const sectionId = 'design-review';
  const heading = '설계 검토 절차';
  const cellText = '확인 항목';
  const newSourceText = '원본 문서에만 남는 뒤늦은 수정';

  try {
    const parent = await createDocument(request, project.id, `${prefix} 상위 문서`);
    const original = await createDocument(request, project.id, `${prefix} 원본`);
    const originalHref = documentSectionHash(original.id, sectionId, project.id);
    const content: RichContent = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2, sectionId }, content: [{ type: 'text', text: heading }] },
      { type: 'paragraph', content: [
        { type: 'text', text: '사전 검토', marks: [{ type: 'bold' }] },
        { type: 'text', text: '절로 이동', marks: [{ type: 'link', attrs: { href: originalHref } }] },
      ] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(cellText)] }] }] },
    ] };
    const source = await json<DocPage>(await request.patch(`/api/documents/${original.id}`, { data: {
      expectedVersion: original.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content,
    } }));
    await page.addInitScript(actorId => localStorage.setItem('teamspace.actor', actorId), actor.id);
    await page.goto(`/#/${project.id}/documents/${source.id}`);
    const open = page.getByRole('button', { name: '팀 템플릿으로 저장', exact: true });
    await open.click();
    const manager = captureDialog(page);
    await expect(manager.dialog).toContainText(source.title);
    await expectFitsMobile(manager.dialog);
    await manager.name.fill(templateName);
    const captured = waitForMutation(page, 'POST', '/api/document-templates');
    await manager.dialog.getByRole('button', { name: '템플릿 저장', exact: true }).click();
    const captureResponse = await captured;
    expect(captureResponse.status(), await captureResponse.text()).toBe(201);
    expect(captureResponse.request().postDataJSON()).toMatchObject({ name: templateName, sourceDocumentId: source.id, expectedDocumentVersion: source.version });
    const template = await captureResponse.json() as DocumentTemplateSummary;
    await expect(manager.dialog.getByRole('button', { name: templateName, exact: true })).toBeVisible();
    await manager.dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(manager.dialog).toBeHidden();

    const modified = await json<DocPage>(await request.patch(`/api/documents/${source.id}`, { data: {
      expectedVersion: source.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: body(newSourceText),
    } }));
    await purgeDocument(request, modified);
    await page.goto('about:blank');
    await page.goto(`/#/${project.id}/documents/${parent.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(parent.title);
    const form = await openNew(page);
    const option = form.select.getByRole('option', { name: templateName, exact: true });
    await expect(option).toHaveCount(1);
    const previewRequests: URL[] = [];
    await page.route(`**/api/document-templates/${template.id}/preview?*`, async route => {
      previewRequests.push(new URL(route.request().url()));
      await route.continue();
    });
    await form.select.selectOption({ label: templateName });
    await expect(form.title).toHaveValue(templateName);
    await form.title.fill(newTitle);
    const parentInput = form.dialog.getByRole('combobox', { name: '상위 문서', exact: true });
    await parentInput.selectOption(parent.id);
    const toggle = form.dialog.getByRole('button', { name: '템플릿 미리보기', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(previewRequests).toHaveLength(0);
    await toggle.click();
    const preview = form.dialog.getByRole('region', { name: '템플릿 저장본 미리보기', exact: true });
    await expect(preview.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(preview.getByRole('table')).toContainText(cellText);
    await expect(preview).not.toContainText(newSourceText);
    await expect(preview.getByRole('link')).toHaveCount(0);
    expect(previewRequests).toHaveLength(1);
    expect(Object.fromEntries(previewRequests[0].searchParams)).toEqual({ expectedVersion: String(template.version), projectId: project.id });
    await preview.press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(form.title).toHaveValue(newTitle);
    await expect(parentInput).toHaveValue(parent.id);
    expect((await workspace(request)).documents.some(document => document.title === newTitle)).toBe(false);
    await expectFitsMobile(form.dialog);

    const attempts: { responseStatus: number; body: string | null; actor: string | undefined }[] = [];
    await page.route(/\/api\/documents$/u, async route => {
      const outgoing = route.request();
      if (outgoing.method() !== 'POST') return route.continue();
      const response = await route.fetch();
      attempts.push({ responseStatus: response.status(), body: outgoing.postData(), actor: outgoing.headers()['x-actor-id'] });
      if (attempts.length === 1) return route.abort('failed');
      await route.fulfill({ response });
    });
    await form.submit.click();
    const retry = form.dialog.getByRole('button', { name: '저장 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    await expect(form.title).toHaveValue(newTitle);
    await expect(form.title).toBeDisabled();
    const candidates = (await workspace(request)).documents.filter(value => value.title === newTitle);
    expect(candidates).toHaveLength(1);
    const [created] = candidates;
    expect(created).toMatchObject({ projectId: project.id, parentId: parent.id, status: 'draft', version: 1, authorId: actor.id });
    expect(created.plainText).toContain(heading);
    expect(created.plainText).not.toContain(newSourceText);

    await retry.click();
    await expect(form.dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/documents/${created.id}$`));
    expect(attempts.map(attempt => attempt.responseStatus)).toEqual([201, 200]);
    expect(attempts[1]).toMatchObject({ body: attempts[0].body, actor: actor.id });
    expect(attempts[0].actor).toBe(actor.id);
    expect(JSON.parse(attempts[0].body!)).toMatchObject({
      requestId: expect.stringMatching(/^[\da-f-]{36}$/u), templateId: template.id, expectedTemplateVersion: template.version,
      title: newTitle, projectId: project.id, parentId: parent.id,
    });
    const afterRetry = (await workspace(request)).documents.filter(value => value.title === newTitle);
    expect(afterRetry).toEqual([created]);
    const versions = await json<DocRevision[]>(await request.get(`/api/documents/${created.id}/revisions`));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ title: newTitle, version: 1, content: created.content });
    const nodes = [...documentNodes(created.content)];
    expect(nodes.find(node => node.text === '사전 검토')?.marks).toContainEqual({ type: 'bold' });
    const localHref = nodes.find(node => node.text === '절로 이동')?.marks?.find(mark => mark.type === 'link')?.attrs?.href;
    expect(localHref).toEqual(expect.stringMatching(new RegExp(`/documents/${created.id}\\?section=${sectionId}$`)));
    await page.reload();
    const editor = page.locator('.docs-prose[contenteditable="true"]');
    await expect(editor.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(editor.getByRole('table')).toContainText(cellText);
    await expect(editor.getByRole('link', { name: '절로 이동', exact: true })).toHaveAttribute('href', String(localHref));
  } finally {
    await cleanup(request, prefix, project.id);
  }
});

test('프로젝트 템플릿의 범위를 지키고 최신 공통 템플릿을 적용할 때 입력을 보존한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const [project, destination] = (await workspace(request)).projects;
  const prefix = `합성 템플릿 범위 ${randomUUID().slice(0, 8)}`;
  const templateTitle = `${prefix} 프로젝트`;
  const renamedTitle = `${prefix} 프로젝트 개정`;
  const teamTitle = `${prefix} 팀 공통`;
  const newTitle = `${prefix} 다른 프로젝트 초안`;
  const updatedContent = '갱신된 팀 공통 양식';

  try {
    const source = await createDocument(request, project.id, `${prefix} 프로젝트 원본`, body('프로젝트 전용 내용'));
    const common = await createDocument(request, null, `${prefix} 공통 원본`, body('이전 팀 공통 양식'));
    const replacement = await createDocument(request, null, `${prefix} 공통 개정 원본`, body(updatedContent));
    const localTemplate = await captureTemplate(request, source, templateTitle);
    const teamTemplate = await captureTemplate(request, common, teamTitle);
    await page.goto(`/#/${project.id}/documents/${source.id}`);

    await page.getByRole('button', { name: '팀 템플릿으로 저장', exact: true }).click();
    const manager = captureDialog(page);
    await manager.dialog.getByRole('button', { name: templateTitle, exact: true }).click();
    await manager.name.fill(renamedTitle);
    const renamed = waitForMutation(page, 'PATCH', `/api/document-templates/${localTemplate.id}`);
    await manager.dialog.getByRole('button', { name: '이름 저장', exact: true }).click();
    const renamedResponse = await renamed;
    expect(renamedResponse.status(), await renamedResponse.text()).toBe(200);
    const renamedRow = manager.dialog.getByRole('button', { name: renamedTitle, exact: true });
    await expect(renamedRow).toBeVisible();
    const archived = waitForMutation(page, 'PATCH', `/api/document-templates/${localTemplate.id}`);
    await manager.dialog.getByRole('button', { name: '보관', exact: true }).click();
    const archivedResponse = await archived;
    expect(archivedResponse.status(), await archivedResponse.text()).toBe(200);
    expect(await archivedResponse.json()).toMatchObject({ name: renamedTitle, archived: true });
    expect((await templateList(request, project.id)).some(value => value.id === localTemplate.id)).toBe(false);
    const restored = waitForMutation(page, 'PATCH', `/api/document-templates/${localTemplate.id}`);
    await manager.dialog.getByRole('button', { name: '복원', exact: true }).click();
    const restoredResponse = await restored;
    expect(restoredResponse.status(), await restoredResponse.text()).toBe(200);
    expect(await restoredResponse.json()).toMatchObject({ name: renamedTitle, archived: false });
    await manager.dialog.getByRole('button', { name: '닫기', exact: true }).click();

    const form = await openNew(page);
    const localOption = form.select.getByRole('option', { name: renamedTitle, exact: true });
    const teamOption = form.select.getByRole('option', { name: teamTitle, exact: true });
    await expect(localOption).toHaveCount(1);
    await expect(teamOption).toHaveCount(1);
    await form.select.selectOption({ label: renamedTitle });
    await form.title.fill(newTitle);
    await form.space.selectOption(destination.id);
    await expect(localOption).toHaveCount(0);
    await expect(teamOption).toHaveCount(1);
    await form.select.selectOption({ label: teamTitle });
    await expect(form.title).toHaveValue(newTitle);

    const latest = await json<DocumentTemplateSummary>(await request.patch(`/api/document-templates/${teamTemplate.id}`, { data: {
      expectedVersion: teamTemplate.version, sourceDocumentId: replacement.id, expectedDocumentVersion: replacement.version,
    } }));
    const stale = page.waitForResponse(response => new URL(response.url()).pathname === `/api/document-templates/${teamTemplate.id}/preview`);
    const previewButton = form.dialog.getByRole('button', { name: '템플릿 미리보기', exact: true });
    await previewButton.click();
    const staleResponse = await stale;
    expect(staleResponse.status(), await staleResponse.text()).toBe(409);
    expect(new URL(staleResponse.url()).searchParams.get('expectedVersion')).toBe(String(teamTemplate.version));
    const preview = form.dialog.getByRole('region', { name: '템플릿 저장본 미리보기', exact: true });
    await expect(preview.getByRole('alert')).toBeVisible();
    await preview.getByRole('button', { name: '팀 템플릿 다시 불러오기', exact: true }).click();
    await form.dialog.getByRole('button', { name: '최신 템플릿 사용', exact: true }).click();
    await expect(form.title).toHaveValue(newTitle);
    await expect(form.space).toHaveValue(destination.id);
    expect((await workspace(request)).documents.some(value => value.title === newTitle)).toBe(false);
    await previewButton.click();
    await expect(preview).toContainText(updatedContent);
    await expect(preview).not.toContainText('이전 팀 공통 양식');

    const renamedTeam = await json<DocumentTemplateSummary>(await request.patch(`/api/document-templates/${latest.id}`, { data: {
      expectedVersion: latest.version, name: `${teamTitle} 개정`,
    } }));
    const staleCreate = waitForMutation(page, 'POST', '/api/documents');
    await form.submit.click();
    const rejectedCreate = await staleCreate;
    expect(rejectedCreate.status(), await rejectedCreate.text()).toBe(409);
    expect(rejectedCreate.request().postDataJSON()).toMatchObject({ expectedTemplateVersion: latest.version });
    await form.dialog.getByRole('button', { name: '최신 템플릿 사용', exact: true }).click();
    await expect(form.title).toHaveValue(newTitle);

    const applied = waitForMutation(page, 'POST', '/api/documents');
    await form.submit.click();
    const appliedResponse = await applied;
    expect(appliedResponse.status(), await appliedResponse.text()).toBe(201);
    expect(appliedResponse.request().postDataJSON()).toMatchObject({ templateId: renamedTeam.id, expectedTemplateVersion: renamedTeam.version });
    const created = await appliedResponse.json() as DocPage;
    expect(created).toMatchObject({ title: newTitle, projectId: destination.id, parentId: null, version: 1, status: 'draft' });
    expect(created.plainText).toContain(updatedContent);
    expect(created.plainText).not.toContain('이전 팀 공통 양식');
    await expect(form.dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/${destination.id}/documents/${created.id}$`));
    await expect(page.locator('.docs-prose[contenteditable="true"]')).toContainText(updatedContent);
  } finally {
    await cleanup(request, prefix, project.id);
  }
});
