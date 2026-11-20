import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { DocPage, DocRevision, DocumentFollowUpResult, RichContent, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function createDecision(request: APIRequestContext, projectId: string | null, title: string, content: RichContent = {
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '저장된 합성 결정' }] }],
}): Promise<DocPage> {
  const source = await request.post('/api/documents', { data: {
    projectId, title, content,
  } });
  expect(source.status()).toBe(201);
  return source.json();
}

async function cleanupDecision(request: APIRequestContext, documentId: string, issueTitle: string) {
  const response = await request.get('/api/workspace');
  if (response.ok()) {
    const snapshot = await response.json() as WorkspaceSnapshot;
    for (const issue of snapshot.issues.filter(issue => issue.title === issueTitle)) await request.delete(`/api/issues/${issue.id}`);
  }
  await request.delete(`/api/documents/${documentId}`);
}

async function openDecision(page: Page, document: DocPage, routeProjectId: string) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`/#/${routeProjectId}/documents/${document.id}`);
  await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title, { timeout: 20_000 });
}

async function openFollowUp(page: Page) {
  await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('button', { name: '후속 업무 만들기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '후속 업무 만들기', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('360px 문서에서 후속 업무 응답을 잃어도 같은 요청으로 확인하고 초안을 유지한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const { projects } = await workspace(request);
  const project = projects[0];
  const title = `결정 원본 ${randomUUID()}`;
  const issueTitle = `${title} 후속 업무`;
  const document = await createDecision(request, project.id, title);
  const attempts: Record<string, unknown>[] = [];
  const unwantedConfirmations: string[] = [];
  try {
    await openDecision(page, document, project.id);
    const documentTitle = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const editor = page.locator('.docs-prose');
    await expect(editor).toContainText('저장된 합성 결정');
    const unsavedTitle = `${title} 미저장 제목`;
    const unsavedBody = '후속 업무를 만들면서 편집 중인 합성 결정 본문';
    await documentTitle.fill(unsavedTitle);
    await editor.fill(unsavedBody);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    page.on('dialog', async dialog => { unwantedConfirmations.push(dialog.message()); await dialog.dismiss(); });
    const dialog = await openFollowUp(page);
    const projectPicker = dialog.getByRole('combobox', { name: '프로젝트', exact: true });
    await expect(projectPicker).toHaveValue(project.id);
    await expect(projectPicker).toBeDisabled();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const followUpTitle = dialog.getByRole('textbox', { name: '업무 제목', exact: true });
    await followUpTitle.fill(issueTitle);

    await page.route(`**/api/documents/${document.id}/follow-up-issues`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON() as Record<string, unknown>);
      if (attempts.length === 1) {
        expect((await route.fetch()).status()).toBe(201);
        await route.abort('failed');
      } else await route.continue();
    });
    await dialog.getByRole('button', { name: '업무 만들고 연결', exact: true }).click();
    await expect(dialog).toContainText('업무 생성 결과를 확인하지 못했습니다.');
    await expect(followUpTitle).toHaveValue(issueTitle);
    const replay = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}/follow-up-issues`) && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true }).click();
    expect((await replay).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.docs-linked-issue').filter({ hasText: issueTitle })).toHaveCount(1);
    await expect(documentTitle).toHaveValue(unsavedTitle);
    await expect(editor).toContainText(unsavedBody);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    expect(page.url()).toContain(`/documents/${document.id}`);
    expect(unwantedConfirmations).toEqual([]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(attempts[0]).toMatchObject({ expectedDocumentVersion: document.version, issue: { projectId: project.id, title: issueTitle } });
    expect(attempts[1]).toEqual(attempts[0]);
    const snapshot = await workspace(request);
    const issues = snapshot.issues.filter(issue => issue.title === issueTitle);
    expect(issues).toHaveLength(1);
    expect(snapshot.resourceLinks.filter(link => link.documentId === document.id)).toEqual([
      expect.objectContaining({ issueId: issues[0].id, documentId: document.id, kind: '후속 업무' }),
    ]);
    expect(snapshot.documents.find(page => page.id === document.id)).toEqual(document);
  } finally {
    await cleanupDecision(request, document.id, issueTitle);
  }
});

test('공통 문서에서 현재 프로젝트와 다른 프로젝트를 명시하고 문서에 남아서 후속 업무를 본다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const { projects } = await workspace(request);
  const [routeProject, targetProject] = projects;
  expect(targetProject.id).not.toBe(routeProject.id);
  const title = `공통 결정 ${randomUUID()}`;
  const issueTitle = `${title} 후속 업무`;
  const document = await createDecision(request, null, title);
  try {
    await openDecision(page, document, routeProject.id);
    const dialog = await openFollowUp(page);
    const projectPicker = dialog.getByRole('combobox', { name: '프로젝트', exact: true });
    const submit = dialog.getByRole('button', { name: '업무 만들고 연결', exact: true });
    await dialog.getByRole('textbox', { name: '업무 제목', exact: true }).fill(issueTitle);
    await expect(projectPicker).toHaveValue('');
    await expect(submit).toBeDisabled();
    await projectPicker.selectOption(targetProject.id);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.docs-linked-issue').filter({ hasText: issueTitle })).toHaveCount(1);
    expect(page.url()).toContain(`/${routeProject.id}/documents/${document.id}`);
    const snapshot = await workspace(request);
    const created = snapshot.issues.find(issue => issue.title === issueTitle);
    expect(created?.projectId).toBe(targetProject.id);
    expect(snapshot.resourceLinks.filter(link => link.documentId === document.id)).toEqual([
      expect.objectContaining({ documentId: document.id, kind: '후속 업무', issueId: created?.id }),
    ]);
  } finally {
    await cleanupDecision(request, document.id, issueTitle);
  }
});

test('360px 문서에서 고른 본문을 후속 업무에 첨부하고 최초 원문 저장본을 다시 연다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const { projects: [project] } = await workspace(request);
  const title = `결정 원문 ${randomUUID()}`;
  const issueTitle = `${title} 후속 업무`;
  const prefix = '회의 요약 ';
  const marked = '재현 조건';
  const ending = '을 고정하기로 했다.';
  const next = '변경 전에 실측한다.';
  const quote = `${marked}${ending}\n${next}`;
  const document = await createDecision(request, project.id, title, { type: 'doc', content: [
    { type: 'paragraph', content: [
      { type: 'text', text: prefix },
      { type: 'text', text: marked, marks: [{ type: 'bold' }] },
      { type: 'text', text: ending },
    ] },
    { type: 'paragraph', content: [{ type: 'text', text: `${next} 담당자는 회의록에 기록한다.` }] },
  ] });
  try {
    const revisions = await request.get(`/api/documents/${document.id}/revisions`);
    expect(revisions.ok(), await revisions.text()).toBeTruthy();
    const [original] = await revisions.json() as DocRevision[];
    await openDecision(page, document, project.id);
    const editor = page.locator('.docs-prose');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    const action = page.getByRole('button', { name: '선택한 본문으로 후속 업무 만들기', exact: true });
    await expect(action).toBeDisabled();
    await editor.evaluate((element, through) => {
      const [first, second] = Array.from(element.querySelectorAll(':scope > p'));
      const start = first?.querySelector('strong')?.firstChild;
      const end = second?.firstChild;
      if (!start || !end) throw new Error('Expected marked selection in the saved editor body');
      element.focus();
      const range = element.ownerDocument.createRange();
      range.setStart(start, 0);
      range.setEnd(end, through);
      const selection = element.ownerDocument.getSelection();
      if (!selection) throw new Error('Expected browser selection');
      selection.removeAllRanges();
      selection.addRange(range);
    }, next.length);
    await expect(action).toBeEnabled();
    await action.click();

    const dialog = page.getByRole('dialog', { name: '후속 업무 만들기', exact: true });
    const excerpt = dialog.getByRole('region', { name: '선택한 본문', exact: true });
    await expect(excerpt).toBeVisible();
    expect(await excerpt.locator('blockquote').textContent()).toBe(quote);
    await dialog.getByRole('textbox', { name: '업무 제목', exact: true }).fill(issueTitle);
    const submitted = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}/follow-up-issues`) && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '업무 만들고 연결', exact: true }).click();
    const response = await submitted;
    expect(response.status(), await response.text()).toBe(201);
    const sourceSelection = { from: 1 + prefix.length, to: prefix.length + marked.length + ending.length + 3 + next.length, text: quote };
    expect(response.request().postDataJSON()).toMatchObject({ sourceSelection, expectedDocumentVersion: document.version });
    const created = await response.json() as DocumentFollowUpResult;
    expect(created.link.documentSource).toEqual({ ...sourceSelection, revisionId: original.id });
    await expect(dialog).toHaveCount(0);
    expect((await workspace(request)).documents.find(page => page.id === document.id)).toEqual(document);

    const latestTitle = '개정된 결정 원문';
    const latestText = '나중에 수정한 실측 조건';
    const edited = await request.patch(`/api/documents/${document.id}`, { data: {
      expectedVersion: document.version, title: latestTitle,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: latestText }] }] },
    } });
    expect(edited.ok(), await edited.text()).toBeTruthy();
    await page.goto(`/#/${project.id}/issues?issue=${created.issue.id}`);
    await page.reload();
    const issue = page.getByRole('dialog', { name: issueTitle, exact: true });
    await expect(issue).toBeVisible({ timeout: 20_000 });
    await expect(issue.getByRole('button', { name: latestTitle, exact: true })).toBeVisible();
    const evidence = issue.getByRole('region', { name: '결정 근거', exact: true });
    expect(await evidence.locator('blockquote').textContent()).toBe(quote);
    const opening = page.waitForResponse(result => result.url().endsWith(`/api/documents/${document.id}/include-revisions/${original.id}`));
    await evidence.getByRole('button', { name: '원문 저장본 열기', exact: true }).click();
    const stored = await opening;
    expect(stored.ok(), await stored.text()).toBeTruthy();
    expect(await stored.json()).toEqual(original);
    const revision = evidence.getByRole('region', { name: `결정 근거 원문 ${title}`, exact: true });
    await expect(revision.getByText('담당자는 회의록에 기록한다.', { exact: false })).toBeVisible();
    await expect(revision).not.toContainText(latestText);
    await expect(revision.locator('[contenteditable=true]')).toHaveCount(0);
    await expect(evidence.getByRole('button', { name: '원문 저장본 접기', exact: true })).toBeVisible();
  } finally {
    await cleanupDecision(request, document.id, issueTitle);
  }
});
