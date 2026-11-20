import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { CollaborationSession } from '../../shared/collaboration';
import type { DocPage, DocRevision, DocumentFollowUpResult, DocumentIssueLinkResult, Issue, ResourceLink, RichContent, WorkspaceSnapshot } from '../../shared/types';

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

async function selectFirstParagraph(editor: Locator, from: number, to: number) {
  await editor.evaluate((element, rangeOffsets) => {
    const text = element.querySelector(':scope > p')?.firstChild;
    const selection = element.ownerDocument.getSelection();
    if (!text || !selection) throw new Error('Expected selection in the saved paragraph');
    element.focus();
    const range = element.ownerDocument.createRange();
    range.setStart(text, rangeOffsets.from);
    range.setEnd(text, rangeOffsets.to);
    selection.removeAllRanges();
    selection.addRange(range);
  }, { from, to });
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

test('기존 티켓에 결정 근거를 추가하고 응답 유실 뒤 같은 연결과 원문을 복구한다', async ({ page, context, request }) => {
  test.setTimeout(85_000);
  const { projects: [documentProject, issueProject] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const title = `결정 회의록 ${suffix}`;
  const issueTitle = `기존 작업 ${suffix}`;
  const prefix = '배포 회의 결정. ';
  const quote = '작업 전 계측 기준을 합의한다.';
  const trailing = ' 담당자는 작업 전에 확인한다.';
  const body = `${prefix}${quote}${trailing}`;
  const source = await createDecision(request, documentProject.id, title, {
    type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
  });
  const attempts: Record<string, unknown>[] = [];
  let issuePage: Page | undefined;
  try {
    const created = await request.post('/api/issues', { data: {
      projectId: issueProject.id, title: issueTitle, description: '이미 담당자가 검토 중인 작업',
    } });
    expect(created.status(), await created.text()).toBe(201);
    const issue = await created.json() as Issue;
    const plainResponse = await request.post('/api/resource-links', { data: { issueId: issue.id, documentId: source.id, kind: '설계 참고' } });
    expect(plainResponse.status(), await plainResponse.text()).toBe(201);
    const plain = await plainResponse.json() as ResourceLink;
    const [original] = await (await request.get(`/api/documents/${source.id}/revisions`)).json() as DocRevision[];
    await openDecision(page, source, documentProject.id);
    const action = page.getByRole('button', { name: '선택한 본문을 기존 업무에 연결', exact: true });
    await expect(action).toBeDisabled();
    const documentTitle = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const draftTitle = `${title} 미저장 제목`;
    await documentTitle.fill(draftTitle);
    const editor = page.locator('.docs-prose');
    await selectFirstParagraph(editor, prefix.length, prefix.length + quote.length);
    await expect(action).toBeEnabled();
    await action.click();

    const dialog = page.getByRole('dialog', { name: '기존 업무에 결정 근거 연결', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await expect(dialog.locator('blockquote')).toHaveText(quote);
    await dialog.getByRole('combobox', { name: '프로젝트', exact: true }).selectOption(issueProject.id);
    await dialog.getByRole('textbox', { name: '업무 키 또는 제목 검색', exact: true }).fill(issue.key);
    await dialog.getByRole('radio', { name: new RegExp(`${issue.key}.*${issueTitle}`) }).check();

    const path = `/api/documents/${source.id}/decision-links`;
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON() as Record<string, unknown>);
      if (attempts.length === 1) {
        expect((await route.fetch()).status()).toBe(201);
        await route.abort('failed');
      } else await route.continue();
    });
    await dialog.getByRole('button', { name: '선택한 업무에 연결', exact: true }).click();
    const retry = dialog.getByRole('button', { name: '연결 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    const recovery = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST');
    await retry.click();
    const response = await recovery;
    expect(response.status(), await response.text()).toBe(200);
    const result = await response.json() as DocumentIssueLinkResult;
    const sourceSelection = { from: 1 + prefix.length, to: 1 + prefix.length + quote.length, text: quote };
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ issueId: issue.id, expectedDocumentVersion: source.version, sourceSelection });
    expect(attempts[1]).toEqual(attempts[0]);
    expect(result).toEqual({ issue, duplicate: true, link: { ...plain, documentSource: { ...sourceSelection, revisionId: original.id } } });
    await expect(dialog).toHaveCount(0);
    await expect(documentTitle).toHaveValue(draftTitle);
    await expect(editor).toContainText(body);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    expect((await workspace(request)).resourceLinks.filter(link => link.documentId === source.id)).toEqual([result.link]);

    const edited = await request.patch(`/api/documents/${source.id}`, { data: {
      expectedVersion: source.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '회의록 개정 내용' }] }] },
    } });
    expect(edited.ok(), await edited.text()).toBe(true);
    issuePage = await context.newPage();
    await issuePage.goto(`/#/${issueProject.id}/issues?issue=${issue.id}`);
    const panel = issuePage.getByRole('dialog', { name: issueTitle, exact: true });
    const evidence = panel.getByRole('region', { name: '결정 근거', exact: true });
    await expect(evidence.locator('blockquote')).toHaveText(quote);
    await evidence.getByRole('button', { name: '원문 저장본 열기', exact: true }).click();
    const saved = evidence.getByRole('region', { name: `결정 근거 원문 ${title}`, exact: true });
    await expect(saved).toContainText(body);
    await expect(saved).not.toContainText('회의록 개정 내용');
  } finally {
    if (issuePage) await issuePage.close();
    await cleanupDecision(request, source.id, issueTitle);
  }
});

test('공동 편집에서 문장이 바뀌면 기존 업무에 연결하기 전에 최신 원문을 다시 선택한다', async ({ page, context, request }) => {
  test.setTimeout(75_000);
  const { projects: [project] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const oldText = '처음 검토한 배포 조건';
  const currentText = '공동 편집에서 합의한 배포 조건';
  const title = `공동 편집 결정 ${suffix}`;
  const issueTitle = `공동 편집의 기존 작업 ${suffix}`;
  const source = await createDecision(request, project.id, title, {
    type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: oldText }] }],
  });
  const peer = await context.newPage();
  try {
    const created = await request.post('/api/issues', { data: { projectId: project.id, title: issueTitle } });
    expect(created.status(), await created.text()).toBe(201);
    const issue = await created.json() as Issue;
    const enabled = await request.post(`/api/documents/${source.id}/collaboration/enable`, { data: { expectedVersion: source.version } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    const session = await enabled.json() as CollaborationSession;
    await openDecision(page, source, project.id);
    await openDecision(peer, source, project.id);
    const editor = page.locator('.docs-live-prose');
    const peerEditor = peer.locator('.docs-live-prose');
    await expect(editor).toHaveText(oldText);
    await expect(peerEditor).toHaveText(oldText);
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');

    const action = page.getByRole('button', { name: '선택한 본문을 기존 업무에 연결', exact: true });
    const dialog = page.getByRole('dialog', { name: '기존 업무에 결정 근거 연결', exact: true });
    const submit = dialog.getByRole('button', { name: '선택한 업무에 연결', exact: true });
    async function chooseIssue() {
      await action.click();
      await dialog.getByRole('textbox', { name: '업무 키 또는 제목 검색', exact: true }).fill(issue.key);
      await dialog.getByRole('radio', { name: `${issue.key} ${issueTitle}`, exact: true }).check();
    }
    await selectFirstParagraph(editor, 0, oldText.length);
    await chooseIssue();
    await expect(dialog.locator('blockquote')).toHaveText(oldText);

    await selectFirstParagraph(peerEditor, 0, oldText.length);
    await peer.keyboard.insertText(currentText);
    await expect(page.locator('.docs-live-prose')).toHaveText(currentText);
    await expect.poll(async () => (await workspace(request)).documents.find(item => item.id === source.id)?.version ?? 0).toBeGreaterThan(session.document.version);
    const path = `/api/documents/${source.id}/decision-links`;
    const linked = () => page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST');
    const failure = linked();
    await submit.click();
    expect((await failure).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('본문을 다시 선택해 주세요');
    await expect(submit).toBeDisabled();
    expect((await workspace(request)).resourceLinks.some(link => link.documentId === source.id)).toBe(false);
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await selectFirstParagraph(editor, 0, currentText.length);
    await chooseIssue();
    await expect(dialog.locator('blockquote')).toHaveText(currentText);
    const success = linked();
    await submit.click();
    const response = await success;
    expect(response.status(), await response.text()).toBe(201);
    const saved = await response.json() as DocumentIssueLinkResult;
    expect(saved.link.documentSource).toMatchObject({ text: currentText, from: 1, to: currentText.length + 1 });
    const revision = await request.get(`/api/documents/${source.id}/include-revisions/${saved.link.documentSource!.revisionId}`);
    expect(revision.ok(), await revision.text()).toBe(true);
    expect((await revision.json() as DocRevision).plainText).toBe(currentText);
    await expect(dialog).toHaveCount(0);
  } finally {
    await peer.close();
    await cleanupDecision(request, source.id, issueTitle);
  }
});
