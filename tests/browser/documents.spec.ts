import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Dialog, type Page } from '@playwright/test';
import { documentSectionHash } from '../../shared/document-sections';
import type { Comment, DocPage, DocRevision, DocumentPublicationView, Issue, RichContent, WorkspaceSnapshot } from '../../shared/types';

const richParagraph = (text: string): RichContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

type DocumentFixture = {
  document: DocPage;
  requests: APIRequestContext;
  initialText: string;
};

// This context belongs to the fixture, rather than page.request. Its teardown can
// remove synthetic records even after a test timeout has closed the browser page.
const test = base.extend<{ syntheticDocument: DocumentFixture }>({
  syntheticDocument: [async ({ playwright, baseURL }, provideFixture, testInfo) => {
    const requests = await playwright.request.newContext({ baseURL });
    const prefix = `문서 회귀 검증 ${randomUUID()}`;
    const initialText = '합성 원본 문서입니다. 실제 팀 자료를 사용하지 않습니다.';
    let created: DocPage | undefined;
    try {
      const workspaceResponse = await requests.get('/api/workspace', { timeout: 10_000 });
      expect(workspaceResponse.ok()).toBeTruthy();
      const workspace = await workspaceResponse.json() as WorkspaceSnapshot;
      expect(workspace.projects.length).toBeGreaterThan(0);
      const response = await requests.post('/api/documents', {
        timeout: 10_000,
        data: { projectId: workspace.projects[0].id, title: prefix, content: richParagraph(initialText) },
      });
      expect(response.status()).toBe(201);
      created = await response.json() as DocPage;
      await provideFixture({ document: created, requests, initialText });
    } finally {
      try {
        const response = await requests.get('/api/workspace', { timeout: 5_000 });
        const workspace = response.ok() ? await response.json() as WorkspaceSnapshot : undefined;
        // The unique prefix also catches a recovery copy if the UI timed out
        // immediately after the server created it, before the response was read.
        const ids = new Set(workspace?.documents.filter(document => document.title.startsWith(prefix)).map(document => document.id));
        if (created) ids.add(created.id);
        const failures: string[] = [];
        for (const id of ids) {
          const deletion = await requests.delete(`/api/documents/${id}`, { timeout: 5_000 });
          if (!deletion.ok() && deletion.status() !== 404) failures.push(`${id}: ${deletion.status()}`);
        }
        if (failures.length) {
          await testInfo.attach('document-cleanup-failures', { body: failures.join('\n'), contentType: 'text/plain' });
          throw new Error(`합성 문서를 정리하지 못했습니다: ${failures.join(', ')}`);
        }
      } finally { await requests.dispose(); }
    }
  }, { timeout: 30_000 }],
});

async function openDocument(page: Page, document: DocPage) {
  await page.goto(`/#/${document.projectId}/documents/${document.id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);
  await expect(page.locator('.docs-prose')).toBeVisible();
}

test('문서 편집·댓글이 저장되고 이전 내용 복구는 새 버전으로 기록된다', async ({ page, syntheticDocument }) => {
  const { document, requests, initialText } = syntheticDocument;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openDocument(page, document);

  const editedTitle = `${document.title} 수정`;
  const editedText = '브라우저에서 작성하고 저장한 문서 내용입니다.';
  await page.getByRole('textbox', { name: '문서 제목', exact: true }).fill(editedTitle);
  await page.locator('.docs-prose').fill(editedText);
  const saveResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}`) && response.request().method() === 'PATCH');
  await page.locator('.docs-save-button').click();
  const saved = await saveResponse;
  expect(saved.status()).toBe(200);
  expect(saved.request().postDataJSON().expectedVersion).toBe(document.version);
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  await expect.poll(async () => {
    const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    return snapshot.documents.find(value => value.id === document.id)?.plainText;
  }).toBe(editedText);

  const comment = '저장된 설계에 대한 합성 검증 의견입니다.';
  await page.getByRole('textbox', { name: '새 문서 댓글', exact: true }).fill(comment);
  await page.getByRole('button', { name: '댓글 남기기', exact: true }).click();
  await expect(page.locator('.docs-comment p')).toHaveText(comment);
  const comments = await (await requests.get(`/api/comments?resourceType=document&resourceId=${document.id}`)).json() as Comment[];
  expect(comments.map(value => value.body)).toEqual([comment]);

  await page.reload();
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(editedTitle);
  await expect(page.locator('.docs-prose')).toContainText(editedText);
  await expect(page.locator('.docs-comment p')).toHaveText(comment);
  await page.getByRole('button', { name: '이력', exact: true }).click();
  await expect(page.locator('.docs-revision')).toHaveCount(2);
  await page.locator('.docs-revision').filter({ hasText: '버전 1' }).click();
  await expect(page.locator('.docs-history-preview')).toContainText(initialText);
  page.once('dialog', dialog => dialog.accept());
  const restoreResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}/restore`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '이 버전으로 복구', exact: true }).click();
  const restored = await restoreResponse;
  expect(restored.status()).toBe(200);
  expect(restored.request().postDataJSON().expectedVersion).toBe(2);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);
  await expect(page.locator('.docs-prose')).toContainText(initialText);
  await expect(page.locator('.docs-author-row')).toContainText('버전 3');
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');

  const revisions = await (await requests.get(`/api/documents/${document.id}/revisions`)).json() as DocRevision[];
  expect(revisions.map(value => value.version)).toEqual([3, 2, 1]);
  expect(revisions.find(value => value.version === 2)?.plainText).toBe(editedText);
  expect(revisions.find(value => value.version === 1)?.plainText).toBe(initialText);
  expect(errors).toEqual([]);
});

test('수동 문서의 제목 초안은 다른 사용자가 저장한 본문·상태와 함께 보존된다', async ({ page, syntheticDocument }) => {
  const { document, requests } = syntheticDocument;
  const { users } = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  const peer = users.find(user => user.id !== document.authorId);
  expect(peer).toBeDefined();
  const path = `/api/documents/${document.id}`;
  const peerHeaders = { 'X-Actor-Id': peer!.id };
  const browserWrites: unknown[] = [];
  page.on('request', request => {
    if (request.url().endsWith(path) && request.method() === 'PATCH') browserWrites.push(request.postDataJSON());
  });

  await page.addInitScript(actorId => localStorage.setItem('teamspace.actor', actorId), document.authorId);
  await openDocument(page, document);
  await expect(page.getByRole('button', { name: '공동 편집 시작', exact: true })).toBeVisible();
  const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
  const save = page.getByRole('button', { name: '저장', exact: true });
  const localTitle = `${document.title} 내 제목`;
  const peerBody = '다른 작업자가 새로 저장한 본문입니다.';
  await title.fill(localTitle);

  const remote = await requests.patch(path, {
    headers: peerHeaders,
    data: { expectedVersion: document.version, content: richParagraph(peerBody), status: 'published' },
  });
  expect(remote.status()).toBe(200);
  const remoteDocument = await remote.json() as DocPage;
  await expect(page.locator('.docs-prose')).toHaveText(peerBody);
  await expect(page.locator('.docs-status-pill')).toHaveText('공유 표시');
  await expect(title).toHaveValue(localTitle);
  await expect(page.locator('.docs-conflict')).toHaveCount(0);

  const saving = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'PATCH');
  await save.click();
  const response = await saving;
  expect(response.status()).toBe(200);
  const saved = await response.json() as DocPage;
  expect(saved).toMatchObject({ title: localTitle, plainText: peerBody, status: 'published' });
  expect(browserWrites).toEqual([{ expectedVersion: remoteDocument.version, title: localTitle }]);
  await expect(save).toBeDisabled();

  await title.fill(`${document.title} 두 번째 내 제목`);
  const peerTitle = `${document.title} 다른 작업자 제목`;
  const renamed = await requests.patch(path, { headers: peerHeaders, data: { expectedVersion: saved.version, title: peerTitle } });
  expect(renamed.status()).toBe(200);
  const renamedDocument = await renamed.json() as DocPage;
  await page.getByRole('button', { name: '서버 최신본 보기', exact: true }).click();
  const review = page.getByRole('form', { name: '문서 속성 충돌 검토', exact: true });
  const savedTitle = review.getByRole('radio', { name: '서버 저장값', exact: true });
  await expect(savedTitle).toHaveAccessibleDescription(peerTitle);
  await savedTitle.check();
  await review.getByRole('button', { name: '선택한 내용으로 편집 계속', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(title).toHaveValue(peerTitle);
  await expect(save).toBeDisabled();
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  expect(snapshot.documents.find(value => value.id === document.id)).toMatchObject({
    version: renamedDocument.version, title: peerTitle, plainText: peerBody, status: 'published',
  });
  expect(browserWrites).toHaveLength(1);
});

test('문서의 미저장 편집은 새로고침과 409 충돌에도 유지되고 사본으로 보관된다', async ({ page, syntheticDocument }) => {
  const { document, requests } = syntheticDocument;
  await openDocument(page, document);
  const localTitle = `${document.title} 내 편집`;
  const localText = '다른 사용자의 변경으로 덮어쓰면 안 되는 내 문서 내용입니다.';
  const remoteText = '다른 사용자가 먼저 저장한 문서 내용입니다.';
  await page.getByRole('textbox', { name: '문서 제목', exact: true }).fill(localTitle);
  await page.locator('.docs-prose').fill(localText);

  const remote = await requests.patch(`/api/documents/${document.id}`, {
    data: { expectedVersion: document.version, title: `${document.title} 다른 편집`, content: richParagraph(remoteText) },
  });
  expect(remote.status()).toBe(200);
  // Posting a comment calls refresh(), reproducing a new server snapshot while
  // the rich-text buffer is dirty. Saving must retain its original base version.
  await page.getByRole('textbox', { name: '새 문서 댓글', exact: true }).fill('스냅샷을 새로 불러오는 합성 댓글');
  await page.getByRole('button', { name: '댓글 남기기', exact: true }).click();
  await expect(page.locator('.docs-comment p')).toContainText('스냅샷을 새로 불러오는 합성 댓글');
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(localTitle);
  await expect(page.locator('.docs-prose')).toContainText(localText);

  const saveResponse = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}`) && response.request().method() === 'PATCH');
  await page.locator('.docs-save-button').click();
  const rejected = await saveResponse;
  expect(rejected.request().postDataJSON().expectedVersion).toBe(document.version);
  expect(rejected.status()).toBe(409);
  await expect(page.locator('.docs-conflict')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(localTitle);
  await expect(page.locator('.docs-prose')).toContainText(localText);
  await page.getByRole('button', { name: '서버 최신본 보기', exact: true }).click();
  await expect(page.locator('.docs-latest-preview')).toContainText(remoteText);

  const copyResponse = page.waitForResponse(response => response.url().endsWith('/api/documents') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '내 편집을 새 문서로 보관', exact: true }).click();
  const copiedResponse = await copyResponse;
  expect(copiedResponse.status()).toBe(201);
  const copy = await copiedResponse.json() as DocPage;
  expect(copy.id).not.toBe(document.id);
  expect(copy.plainText).toBe(localText);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(`${localTitle} (편집 사본)`);
  await expect(page.locator('.docs-prose')).toContainText(localText);
  await expect(page.locator('.docs-save-button')).toBeDisabled();
  const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  expect(snapshot.documents.find(value => value.id === document.id)?.plainText).toBe(remoteText);
  expect(snapshot.documents.find(value => value.id === document.id)?.version).toBe(2);
});

test('문서 이동을 취소할 수 있고 승인한 이동 후에도 로컬 초안을 복원한다', async ({ page, syntheticDocument }) => {
  const { document } = syntheticDocument;
  await openDocument(page, document);
  const localText = '문서를 떠나도 보존할 합성 편집 내용입니다.';
  await page.locator('.docs-prose').fill(localText);

  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('.project-navigation button').filter({ hasText: /^업무/ }).click();
  await expect(page.locator('.docs-prose')).toContainText(localText);
  expect(page.url()).toContain(`/documents/${document.id}`);

  page.once('dialog', dialog => dialog.accept());
  await page.locator('.project-navigation button').filter({ hasText: /^업무/ }).click();
  await expect(page.locator('.documents-feature')).toHaveCount(0);
  await page.getByRole('button', { name: '문서', exact: true }).click();
  await page.locator('.docs-tree-link').filter({ hasText: document.title }).click();
  await expect(page.locator('.docs-prose')).toContainText(localText);
  await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
});

test('보내지 않은 문서 댓글은 이동을 막고 문서·작업자별로 따로 복원된다', async ({ page, syntheticDocument }) => {
  const { document, requests } = syntheticDocument;
  const second = await (await requests.post('/api/documents', {
    data: { projectId: document.projectId, title: `${document.title} 두 번째 문서`, content: richParagraph('두 번째 합성 문서') },
  })).json() as DocPage;
  await openDocument(page, document);
  const actorPicker = page.getByLabel('작업자 선택', { exact: true });
  const initialActor = await actorPicker.inputValue();
  const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  const otherActor = snapshot.users.find(user => user.id !== initialActor);
  expect(otherActor).toBeDefined();
  const commentA = '첫 번째 문서에서 아직 보내지 않은 의견';
  const commentB = '두 번째 문서에서 아직 보내지 않은 의견';
  const commentOtherActor = '다른 작업자에게만 보이는 임시 의견';
  const commentInput = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
  await commentInput.fill(commentA);
  await expect(page.locator('.docs-save-button')).toBeDisabled();

  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('.docs-tree-link').getByText(second.title, { exact: true }).click();
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);
  await expect(commentInput).toHaveValue(commentA);

  page.once('dialog', dialog => dialog.accept());
  await page.locator('.docs-tree-link').getByText(second.title, { exact: true }).click();
  await expect(commentInput).toHaveValue('');
  await commentInput.fill(commentB);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.docs-tree-link').getByText(document.title, { exact: true }).click();
  await expect(commentInput).toHaveValue(commentA);

  page.once('dialog', dialog => dialog.accept());
  await actorPicker.selectOption(otherActor!.id);
  await expect(actorPicker).toHaveValue(otherActor!.id);
  await expect(commentInput).toHaveValue('');
  await commentInput.fill(commentOtherActor);
  page.once('dialog', dialog => dialog.accept());
  await actorPicker.selectOption(initialActor);
  await expect(commentInput).toHaveValue(commentA);

  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('.project-navigation button').filter({ hasText: /^업무/ }).click();
  await expect(commentInput).toHaveValue(commentA);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.project-navigation button').filter({ hasText: /^업무/ }).click();
  await expect(page.locator('.documents-feature')).toHaveCount(0);
  await page.getByRole('button', { name: '문서', exact: true }).click();
  await page.locator('.docs-tree-link').getByText(document.title, { exact: true }).click();
  await expect(commentInput).toHaveValue(commentA);
  expect(await (await requests.get(`/api/comments?resourceType=document&resourceId=${document.id}`)).json()).toEqual([]);

  await page.getByRole('button', { name: '댓글 남기기', exact: true }).click();
  await expect(page.locator('.docs-comment p')).toHaveText(commentA);
  await expect(commentInput).toHaveValue('');
  await page.reload();
  await expect(commentInput).toHaveValue('');
  await expect(page.locator('.docs-comment p')).toHaveText(commentA);
});

test('문서 저장 응답을 기다리는 동안 작업자 전환을 막고 다른 작업자의 초안은 보존한다', async ({ page, syntheticDocument }) => {
  const { document, requests } = syntheticDocument;
  await openDocument(page, document);
  const picker = page.getByLabel('작업자 선택', { exact: true });
  const actorA = await picker.inputValue();
  const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  const actorB = snapshot.users.find(user => user.id !== actorA);
  expect(actorB).toBeDefined();
  await picker.selectOption(actorB!.id);
  await page.locator('.docs-prose').fill('작업자 B의 아직 저장하지 않은 초안');
  page.once('dialog', dialog => dialog.accept());
  await picker.selectOption(actorA);
  await expect(page.locator('.docs-prose')).not.toContainText('작업자 B의 아직 저장하지 않은 초안');
  await page.locator('.docs-prose').fill('작업자 A가 저장하는 내용');

  let releaseResponse = () => {};
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  let observeRequest = () => {};
  const requestObserved = new Promise<void>(resolve => { observeRequest = resolve; });
  let requestActor = '';
  await page.route(`**/api/documents/${document.id}`, async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    requestActor = route.request().headers()['x-actor-id'];
    const response = await route.fetch();
    observeRequest();
    await responseGate;
    await route.fulfill({ response });
  });
  try {
    await page.locator('.docs-save-button').click();
    await requestObserved;
    await expect(page.locator('.docs-save-state')).toHaveText('저장 중');
    await picker.selectOption(actorB!.id);
    await expect(picker).toHaveValue(actorA);
    await expect(page.locator('.docs-prose')).toContainText('작업자 A가 저장하는 내용');
  } finally { releaseResponse(); }
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  expect(requestActor).toBe(actorA);
  await picker.selectOption(actorB!.id);
  await expect(page.locator('.docs-prose')).toContainText('작업자 B의 아직 저장하지 않은 초안');
  await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
  const revisions = await (await requests.get(`/api/documents/${document.id}/revisions`)).json() as DocRevision[];
  expect(revisions[0].authorId).toBe(actorA);
  expect(revisions[0].plainText).toBe('작업자 A가 저장하는 내용');
});

test('360px에서 다른 프로젝트 연결 업무를 열고 돌아와도 문서 절과 초안을 유지한다', async ({ page, syntheticDocument }) => {
  test.setTimeout(65_000);
  const { document, requests } = syntheticDocument;
  const workspace = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  const documentProject = workspace.projects.find(project => project.id === document.projectId);
  const issueProject = workspace.projects.find(project => project.id !== document.projectId);
  const assignee = workspace.users[1];
  if (!documentProject || !issueProject || !assignee) throw new Error('교차 프로젝트 업무를 검증할 합성 자료가 없습니다.');
  const sectionId = `decision-${randomUUID()}`;
  const sectionHeading = '일정 결정 사항';
  const originalBody = '업무를 연결한 저장 본문입니다.';
  const saved = await requests.patch(`/api/documents/${document.id}`, {
    data: { expectedVersion: document.version, content: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2, sectionId }, content: [{ type: 'text', text: sectionHeading }] },
      richParagraph(originalBody).content![0],
    ] } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const documentHash = documentSectionHash(document.id, sectionId, documentProject.id);
  const routePath = documentHash.split('?')[0];
  const currentRoute = () => {
    const [path, search] = new URL(page.url()).hash.split('?');
    return { path, parameters: Object.fromEntries(new URLSearchParams(search)) };
  };
  const prompts: string[] = [];
  let approve = false;
  const handleDialog = async (dialog: Dialog) => {
    prompts.push(dialog.message());
    if (approve) await dialog.accept();
    else await dialog.dismiss();
  };
  let issue: Issue | undefined;
  try {
    const response = await requests.post('/api/issues', { data: {
      projectId: issueProject.id, title: `${document.title} 연결 업무`, assigneeId: assignee.id, status: 'in_progress',
    } });
    expect(response.status(), await response.text()).toBe(201);
    issue = await response.json() as Issue;
    expect((await requests.post('/api/resource-links', { data: { issueId: issue.id, documentId: document.id, kind: 'related' } })).status()).toBe(201);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${documentHash}`);
    const localTitle = `${document.title} 현지 편집`;
    const localBody = '업무를 확인하는 동안에도 유지할 문서 편집';
    const localComment = '아직 보내지 않은 이 문서의 댓글';
    const docTitle = page.locator('.docs-title-input');
    const editor = page.locator('.docs-prose');
    const section = editor.locator(`[data-document-section-id="${sectionId}"]`);
    const documentComment = page.getByRole('textbox', { name: '새 문서 댓글', exact: true });
    await expect(section).toHaveText(sectionHeading);
    await expect(docTitle).toHaveValue(document.title);
    await docTitle.fill(localTitle);
    const paragraph = editor.getByText(originalBody, { exact: true });
    await paragraph.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(` ${localBody}`);
    await expect(editor).toContainText(localBody);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await documentComment.fill(localComment);
    const details = page.getByLabel('문서 상세 정보', { exact: true });
    await details.getByRole('button', { name: '연결', exact: true }).click();
    const linkedIssue = details.locator('.docs-linked-issue').filter({ hasText: issue.title });
    await expect(linkedIssue).toContainText(assignee.name);
    await expect(linkedIssue).toContainText('진행 중');

    page.on('dialog', handleDialog);
    await linkedIssue.click();
    const drawer = page.getByRole('dialog', { name: issue.title, exact: true });
    const ticketTitle = drawer.getByRole('textbox', { name: '제목', exact: true });
    const ticketComment = drawer.getByRole('textbox', { name: '댓글 내용', exact: true });
    const closeTicket = drawer.getByRole('button', { name: '업무 상세 닫기', exact: true });
    await expect(drawer.locator('.issue-panel-breadcrumb')).toContainText(issueProject.name);
    await expect(closeTicket).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => drawer.evaluate(element => element.contains(window.document.activeElement))).toBe(true);
    await expect.poll(currentRoute).toEqual({ path: routePath, parameters: { section: sectionId, issue: issue.id } });
    await expect(docTitle).toHaveValue(localTitle);
    await expect(editor).toContainText(localBody);
    await expect(section).toHaveText(sectionHeading);
    expect(prompts).toEqual([]);

    // The ticket still has its own confirmation, even though the document stays mounted.
    const localTicketTitle = '아직 저장하지 않은 연결 업무 제목';
    const localTicketComment = '아직 보내지 않은 연결 업무의 댓글';
    await ticketTitle.fill(localTicketTitle);
    await ticketComment.fill(localTicketComment);
    await page.goBack();
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toContain('저장하지 않은 업무 변경사항');
    await expect.poll(currentRoute).toEqual({ path: routePath, parameters: { section: sectionId, issue: issue.id } });
    await expect(ticketTitle).toHaveValue(localTicketTitle);
    await expect(ticketComment).toHaveValue(localTicketComment);
    await expect(docTitle).toHaveValue(localTitle);

    approve = true;
    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await expect.poll(currentRoute).toEqual({ path: routePath, parameters: { section: sectionId } });
    await expect(linkedIssue).toBeFocused();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('저장하지 않은 업무 변경사항');
    await page.goForward();
    await expect.poll(currentRoute).toEqual({ path: routePath, parameters: { section: sectionId, issue: issue.id } });
    await expect(ticketTitle).toHaveValue(issue.title);
    await expect(ticketComment).toHaveValue('');
    await drawer.getByRole('button', { name: document.title, exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect.poll(currentRoute).toEqual({ path: routePath, parameters: { section: sectionId } });
    expect(prompts).toHaveLength(2);
    await expect(linkedIssue).toBeVisible();
    await details.getByRole('button', { name: '댓글', exact: true }).click();
    await expect(documentComment).toHaveValue(localComment);
    await expect(docTitle).toHaveValue(localTitle);
    await expect(editor).toContainText(localBody);

    // Leaving the document is still guarded, and the approved departure stashes its drafts.
    await details.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();
    approve = false;
    await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
    const issueNavigation = page.locator('.project-navigation button').filter({ hasText: /^업무/ });
    await issueNavigation.click();
    await expect.poll(() => prompts.length).toBe(3);
    expect(prompts[2]).toContain('저장하지 않은 편집');
    await expect.poll(currentRoute).toEqual({ path: routePath, parameters: { section: sectionId } });
    await expect(docTitle).toHaveValue(localTitle);
    approve = true;
    await issueNavigation.click();
    await expect(page.locator('.documents-feature')).toHaveCount(0);
    await page.goBack();
    await expect.poll(currentRoute).toEqual({ path: routePath, parameters: { section: sectionId } });
    await expect(docTitle).toHaveValue(localTitle);
    await expect(editor).toContainText(localBody);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await expect(documentComment).toHaveValue(localComment);
    expect(prompts).toHaveLength(4);
  } finally {
    page.off('dialog', handleDialog);
    if (issue) await requests.delete(`/api/issues/${issue.id}`);
  }
});

test('고정 발행 문서 주소에 업무 상세를 열어도 발행 버전과 절을 유지한다', async ({ page, syntheticDocument }) => {
  test.setTimeout(60_000);
  const { document, requests, initialText } = syntheticDocument;
  const workspace = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  const author = workspace.users.find(user => user.id === document.authorId);
  const reviewer = workspace.users.find(user => user.id !== document.authorId);
  const otherProject = workspace.projects.find(project => project.id !== document.projectId);
  if (!author || !reviewer || !document.projectId || !otherProject) throw new Error('고정 발행본을 검증할 합성 자료가 없습니다.');
  const path = `/api/documents/${document.id}/publication`;
  const sectionId = `published-${randomUUID()}`;
  const sectionHeading = '발행한 업무 결정';
  let issue: Issue | undefined;
  try {
    const response = await requests.post('/api/issues', { data: { projectId: otherProject.id, title: `${document.title} 발행 연결 업무` } });
    expect(response.status(), await response.text()).toBe(201);
    issue = await response.json() as Issue;
    const prepared = await requests.patch(`/api/documents/${document.id}`, {
      headers: { 'X-Actor-Id': author.id }, data: { expectedVersion: document.version, content: { type: 'doc', content: [
        { type: 'heading', attrs: { level: 2, sectionId }, content: [{ type: 'text', text: sectionHeading }] },
        richParagraph(initialText).content![0],
        { type: 'issueReference', attrs: { issueId: issue.id, label: issue.title } },
      ] } },
    });
    expect(prepared.status(), await prepared.text()).toBe(200);
    const state = await (await requests.get(path)).json() as DocumentPublicationView;
    const reviewResponse = await requests.post(path, { headers: { 'X-Actor-Id': author.id }, data: {
      action: 'request', reviewerId: reviewer.id, expectedVersion: state.version, workspaceGeneration: state.workspaceGeneration,
      expectedDocumentVersion: state.documentVersion,
    } });
    expect(reviewResponse.status(), await reviewResponse.text()).toBe(200);
    const review = await reviewResponse.json() as DocumentPublicationView;
    const publishResponse = await requests.post(path, { headers: { 'X-Actor-Id': reviewer.id }, data: {
      action: 'publish', expectedVersion: review.version, workspaceGeneration: review.workspaceGeneration,
    } });
    expect(publishResponse.status(), await publishResponse.text()).toBe(200);
    const release = await publishResponse.json() as DocumentPublicationView;
    const revision = release.publishedRevision;
    if (!revision) throw new Error('발행 검증에 사용할 저장본이 생성되지 않았습니다.');
    const publishedHash = documentSectionHash(document.id, sectionId, document.projectId, { kind: 'published', revisionId: revision.id });
    await page.goto(`/${publishedHash}&issue=${issue.id}`);
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    await expect(ticket.locator('.issue-panel-breadcrumb')).toContainText(otherProject.name);
    await expect.poll(() => Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.split('?')[1]))).toEqual({
      issue: issue.id, publication: 'published', revision: revision.id, section: sectionId,
    });
    await expect(ticket.getByRole('button', { name: '업무 상세 닫기', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(ticket).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).hash).toBe(publishedHash);
    const publishedContent = page.getByRole('region', { name: '발행 고정본 내용', exact: true });
    await expect(publishedContent).toContainText(initialText);
    await expect(publishedContent.getByRole('heading', { name: sectionHeading, exact: true })).toBeVisible();
  } finally { if (issue) await requests.delete(`/api/issues/${issue.id}`); }
});
