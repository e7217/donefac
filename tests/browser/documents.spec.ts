import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Comment, DocPage, DocRevision, Issue, RichContent, WorkspaceSnapshot } from '../../shared/types';

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
  syntheticDocument: [async ({ playwright, baseURL }, use, testInfo) => {
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
      await use({ document: created, requests, initialText });
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

test('편집 중인 문서에서 연결 업무를 열 때 이동 확인은 한 번만 표시된다', async ({ page, syntheticDocument }) => {
  const { document, requests } = syntheticDocument;
  let issue: Issue | undefined;
  try {
    const response = await requests.post('/api/issues', { data: { projectId: document.projectId, title: `${document.title} 연결 업무` } });
    expect(response.status()).toBe(201);
    issue = await response.json() as Issue;
    expect((await requests.post('/api/resource-links', { data: { issueId: issue.id, documentId: document.id, kind: 'related' } })).status()).toBe(201);
    await openDocument(page, document);
    await page.locator('.docs-prose').fill('업무를 열기 전에 임시 보관할 문서 편집');
    await page.getByRole('button', { name: '연결', exact: true }).click();
    let dialogs = 0;
    const accept = async (dialog: import('@playwright/test').Dialog) => { dialogs++; await dialog.accept(); };
    page.on('dialog', accept);
    await page.locator('.docs-linked-issue').filter({ hasText: issue.title }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: issue.title, exact: true })).toBeVisible();
    expect(dialogs).toBe(1);
    page.off('dialog', accept);
  } finally { if (issue) await requests.delete(`/api/issues/${issue.id}`); }
});
