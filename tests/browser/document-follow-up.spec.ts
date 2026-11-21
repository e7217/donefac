import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { CollaborationSession } from '../../shared/collaboration';
import type { DecisionFollowUpPage, DocPage, DocRevision, DocumentFollowUpResult, DocumentIssueLinkResult, Issue, ProjectWorkflow, ResourceLink, RichContent, WorkspaceSnapshot } from '../../shared/types';

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

test('360px 문서에서 연결 업무의 최신 상태와 결정 당시 원문을 함께 확인한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const snapshot = await workspace(request);
  const [documentProject, issueProject] = snapshot.projects;
  const [initialAssignee, nextAssignee] = snapshot.users;
  const suffix = randomUUID().slice(0, 8);
  const originalTitle = `공통 회의록 ${suffix}`;
  const originalText = '승인 전에 시험 기준을 기록하기로 결정했다.';
  const latestText = '개정 회의록은 다른 확인 방법을 정리한다.';
  const created: Issue[] = [];
  let document: DocPage | undefined;

  async function createIssue(title: string, fields: Partial<Issue> = {}) {
    const response = await request.post('/api/issues', { data: {
      projectId: issueProject.id, title: `${title} ${suffix}`, ...fields,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    return issue;
  }

  try {
    const decisionIssue = await createIssue('결정 근거 연결 업무', { assigneeId: initialAssignee.id, status: 'in_progress', dueDate: '2027-05-08', endDate: '2027-05-13' });
    const ordinaryIssue = await createIssue('계획 날짜만 있는 일반 연결', { endDate: '2027-05-24' });
    const bodyOnlyIssue = await createIssue('본문에서만 참조한 업무', { projectId: documentProject.id });
    document = await createDecision(request, null, originalTitle, { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: originalText }] },
      { type: 'issueReference', attrs: { issueId: bodyOnlyIssue.id, label: bodyOnlyIssue.title } },
    ] });
    const documentId = document.id;
    const decision = await request.post(`/api/documents/${documentId}/decision-links`, { data: {
      requestId: randomUUID(), expectedDocumentVersion: document.version, issueId: decisionIssue.id,
      sourceSelection: { from: 1, to: originalText.length + 1, text: originalText },
    } });
    expect(decision.status(), await decision.text()).toBe(201);
    const { link: decisionLink } = await decision.json() as DocumentIssueLinkResult;
    const ordinaryLink = await request.post('/api/resource-links', { data: {
      documentId, issueId: ordinaryIssue.id, kind: '관련 업무',
    } });
    expect(ordinaryLink.status(), await ordinaryLink.text()).toBe(201);
    const followUp = await request.post(`/api/documents/${documentId}/follow-up-issues`, { data: {
      requestId: randomUUID(), expectedDocumentVersion: document.version,
      issue: { projectId: documentProject.id, title: `취소한 후속 업무 ${suffix}`, status: 'cancelled' },
    } });
    expect(followUp.status(), await followUp.text()).toBe(201);
    const { issue: closedIssue } = await followUp.json() as DocumentFollowUpResult;
    created.push(closedIssue);

    const edited = await request.patch(`/api/documents/${documentId}`, { data: {
      expectedVersion: document.version,
      content: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: latestText }] },
        { type: 'issueReference', attrs: { issueId: bodyOnlyIssue.id, label: bodyOnlyIssue.title } },
      ] },
    } });
    expect(edited.ok(), await edited.text()).toBe(true);

    const revisionPrefix = `/api/documents/${documentId}/include-revisions/`;
    const revisionPath = `${revisionPrefix}${decisionLink.documentSource!.revisionId}`;
    const revisionRequests: string[] = [];
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith(revisionPrefix)) revisionRequests.push(pathname);
    });
    await openDecision(page, document, documentProject.id);
    await expect(page.locator('.docs-prose')).toContainText(latestText);
    const draftTitle = `${originalTitle} 편집 중`;
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await title.fill(draftTitle);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await page.getByRole('button', { name: '연결', exact: true }).click();
    const panel = page.getByRole('region', { name: '연결된 업무', exact: true });
    const cards = panel.locator('.docs-linked-issue');
    const card = (issue: Issue) => cards.filter({ hasText: issue.title });
    const filters = panel.getByLabel('연결된 업무 상태', { exact: true });
    const onlyEvidence = panel.getByRole('checkbox', { name: '결정 근거가 있는 업무만', exact: true });
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText(decisionIssue.title);
    await expect(cards.nth(1)).toContainText(ordinaryIssue.title);
    await expect(cards.nth(2)).toContainText(closedIssue.title);
    await expect(card(bodyOnlyIssue)).toHaveCount(0);
    const inlineReferences = page.getByRole('heading', { name: '본문의 업무 참조', exact: true }).locator('..');
    await expect(inlineReferences.getByRole('button', { name: new RegExp(bodyOnlyIssue.title) })).toBeVisible();
    await expect(filters.getByRole('option', { name: '전체 3개', exact: true })).toHaveCount(1);
    await expect(filters.getByRole('option', { name: '미완료 2개', exact: true })).toHaveCount(1);
    await expect(filters.getByRole('option', { name: '종료 1개', exact: true })).toHaveCount(1);
    await expect(card(decisionIssue)).toContainText(issueProject.name);
    await expect(card(decisionIssue)).toContainText(initialAssignee.name);
    await expect(card(decisionIssue)).toContainText('진행 중');
    await expect(card(decisionIssue)).toContainText('목표 마감일');
    await expect(card(decisionIssue).locator('time')).toHaveAttribute('datetime', decisionIssue.dueDate!);
    await expect(card(ordinaryIssue)).toContainText('계획 종료일');
    await expect(card(ordinaryIssue).locator('time')).toHaveAttribute('datetime', ordinaryIssue.endDate!);
    await expect(card(closedIssue)).toContainText('후속 업무');
    await expect(card(closedIssue)).toContainText('기한 없음');

    await filters.selectOption('open');
    await expect(cards).toHaveCount(2);
    await expect(card(closedIssue)).toHaveCount(0);
    await filters.selectOption('closed');
    await expect(cards).toHaveCount(1);
    await expect(card(closedIssue)).toBeVisible();
    await onlyEvidence.check();
    await expect(cards).toHaveCount(0);
    await filters.selectOption('all');
    await expect(cards).toHaveCount(1);
    await expect(card(decisionIssue)).toBeVisible();
    const evidence = panel.getByRole('region', { name: `${decisionIssue.key} 결정 근거`, exact: true });
    await expect(evidence.locator('blockquote')).toHaveText(originalText);
    expect(revisionRequests).toEqual([]);
    const originalResponse = page.waitForResponse(response => new URL(response.url()).pathname === revisionPath);
    await evidence.getByRole('button', { name: '원문 저장본 열기', exact: true }).click();
    const original = await originalResponse;
    expect(original.ok(), await original.text()).toBe(true);
    expect((await original.json() as DocRevision).version).toBe(document.version);
    const reader = evidence.getByRole('region', { name: `결정 근거 원문 ${originalTitle}`, exact: true });
    await expect(reader).toContainText(originalText);
    await expect(reader).not.toContainText(latestText);
    await expect(reader.locator('[contenteditable=true]')).toHaveCount(0);
    expect(revisionRequests).toEqual([revisionPath]);
    await evidence.getByRole('button', { name: '원문 저장본 접기', exact: true }).click();

    await card(decisionIssue).click();
    const ticket = page.getByRole('dialog', { name: decisionIssue.title, exact: true });
    await expect(ticket).toBeVisible();
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(ticket).toHaveCount(0);
    await expect(card(decisionIssue)).toBeFocused();
    await expect(title).toHaveValue(draftTitle);

    const updated = await request.patch(`/api/issues/${decisionIssue.id}`, { data: {
      expectedVersion: decisionIssue.version, status: 'done', assigneeId: nextAssignee.id, dueDate: '2027-06-03',
    } });
    expect(updated.ok(), await updated.text()).toBe(true);
    await panel.getByRole('button', { name: '연결된 업무 새로고침', exact: true }).click();
    await expect(card(decisionIssue)).toContainText('완료');
    await expect(card(decisionIssue)).toContainText(nextAssignee.name);
    await expect(card(decisionIssue).locator('time')).toHaveAttribute('datetime', '2027-06-03');
    await filters.selectOption('open');
    await expect(cards).toHaveCount(0);
    await filters.selectOption('closed');
    await expect(card(decisionIssue)).toBeVisible();
    await onlyEvidence.uncheck();
    await expect(cards).toHaveCount(2);
    await expect(card(closedIssue)).toBeVisible();
    await expect(title).toHaveValue(draftTitle);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    expect((await workspace(request)).documents.find(item => item.id === documentId)?.title).toBe(originalTitle);
  } finally {
    const resources = [
      ...(document ? [`documents/${document.id}`] : []),
      ...created.map(issue => `issues/${issue.id}`),
    ];
    for (const resource of resources) {
      const deleted = await request.delete(`/api/${resource}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});

test('360px에서 프로젝트의 결정 후속 업무를 찾아 고정 원문을 열고 티켓 변경 뒤 보고서로 돌아온다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const { projects: [targetProject, documentProject], users: [firstAssignee, nextAssignee] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const sourceTitle = `결정 검증 ${suffix}`;
  const currentTitle = `개정 회의록 ${suffix}`;
  const originalText = '실험실에서 먼저 검증한다.';
  const revisedText = '개정 회의록은 별도 배포 절차를 기록한다.';
  const source = await createDecision(request, documentProject.id, sourceTitle, {
    type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: originalText }] }],
  });
  const title = `프로젝트 결정 후속 검증 ${suffix}`;
  const ticketResponse = await request.post('/api/issues', { data: {
    projectId: targetProject.id, title, assigneeId: firstAssignee.id, dueDate: '2027-08-14', endDate: '2027-08-24',
  } });
  expect(ticketResponse.status(), await ticketResponse.text()).toBe(201);
  const issue = await ticketResponse.json() as Issue;

  try {
    const linked = await request.post(`/api/documents/${source.id}/decision-links`, { data: {
      requestId: randomUUID(), expectedDocumentVersion: source.version, issueId: issue.id,
      sourceSelection: { from: 1, to: originalText.length + 1, text: originalText },
    } });
    expect(linked.status(), await linked.text()).toBe(201);
    const { link } = await linked.json() as DocumentIssueLinkResult;
    const revised = await request.patch(`/api/documents/${source.id}`, { data: {
      expectedVersion: source.version, title: currentTitle,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: revisedText }] }] },
    } });
    expect(revised.ok(), await revised.text()).toBeTruthy();

    const sourcePath = `/api/projects/${targetProject.id}/decision-follow-ups/${link.id}/source`;
    const revisionPath = `/api/documents/${source.id}/include-revisions/${link.documentSource?.revisionId}`;
    const reads: string[] = [];
    page.on('request', event => {
      const path = new URL(event.url()).pathname;
      if (path === sourcePath || path === revisionPath) reads.push(path);
    });
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${targetProject.id}/reports`);
    await page.getByRole('tab', { name: '결정 후속 업무', exact: true }).click();
    const report = page.getByRole('tabpanel', { name: '결정 후속 업무', exact: true });
    const search = report.getByRole('searchbox', { name: '결정 후속 업무 검색', exact: true });
    const status = report.getByRole('combobox', { name: '결정 후속 업무 상태', exact: true });
    await expect(status).toHaveValue('open');
    await search.fill(sourceTitle);
    await status.selectOption('all');
    await report.getByRole('button', { name: '조건 적용', exact: true }).click();
    const row = report.getByRole('article', { name: `${issue.key} 결정 후속 업무`, exact: true });
    await expect(row).toContainText(currentTitle);
    expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('q')).toBe(sourceTitle);
    expect(new URL(page.url()).hash).toContain('/reports/decision-follow-ups');
    expect(reads).toEqual([]);
    await expect(report.locator('time[datetime="2027-08-14"]')).toBeVisible();

    const evidence = report.getByRole('button', { name: `${issue.key} 결정 근거 열기`, exact: true });
    const frozenRequest = page.waitForResponse(response => new URL(response.url()).pathname === revisionPath);
    await evidence.click();
    expect((await frozenRequest).ok()).toBeTruthy();
    await expect(report.locator('[data-document-excerpt-start]')).toHaveText(originalText);
    await expect(report.getByText(revisedText, { exact: true })).toHaveCount(0);
    expect([...reads].sort()).toEqual([sourcePath, revisionPath].sort());
    await report.getByRole('button', { name: `${issue.key} 결정 근거 접기`, exact: true }).click();

    const applied = new URL(page.url()).hash;
    await page.reload();
    await expect(search).toHaveValue(sourceTitle);
    await expect(status).toHaveValue('all');
    const openIssue = report.getByRole('button', { name: `${issue.key} 업무 열기`, exact: true });
    await openIssue.click();
    const ticket = page.getByRole('dialog', { name: title, exact: true });
    await expect(ticket).toBeVisible();
    expect(new URL(page.url()).hash).toContain('/reports/decision-follow-ups?');
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(openIssue).toBeFocused();
    expect(new URL(page.url()).hash).toBe(applied);

    await openIssue.click();
    await ticket.getByRole('combobox', { name: '상태', exact: true }).selectOption('done');
    await ticket.getByRole('combobox', { name: '담당자', exact: true }).selectOption(nextAssignee.id);
    await ticket.getByLabel('목표 마감일', { exact: true }).fill('2027-08-18');
    const updated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${issue.id}` && response.request().method() === 'PATCH');
    await ticket.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    expect((await updated).ok()).toBeTruthy();
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(row.getByText(nextAssignee.name, { exact: true })).toBeVisible();
    await expect(report.locator('time[datetime="2027-08-18"]')).toBeVisible();
    await status.selectOption('closed');
    await report.getByRole('button', { name: '조건 적용', exact: true }).click();
    await expect(openIssue).toBeVisible();
    await expect(report.getByText('완료', { exact: true })).toBeVisible();
    const bounds = await report.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(360);

    const deleted = await request.delete(`/api/documents/${source.id}`);
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
    const { trashEntryId } = await deleted.json() as { trashEntryId: string };
    try {
      const previousReads = reads.length;
      const missing = page.waitForResponse(response => new URL(response.url()).pathname === sourcePath);
      await evidence.click();
      expect((await missing).status()).toBe(404);
      await expect(report.getByRole('alert')).toContainText('고정 버전을 찾을 수 없습니다.');
      expect(reads.slice(previousReads)).toEqual([sourcePath]);
    } finally {
      await request.delete(`/api/trash/${trashEntryId}`);
    }
  } finally {
    for (const resource of [`issues/${issue.id}`, `documents/${source.id}`]) {
      const deleted = await request.delete(`/api/${resource}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});

test('360px 팀 결정 후속 업무에서 여러 프로젝트와 공통 문서의 근거를 읽고 업무 변경 뒤 필터를 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { projects: [base, other], users: [actor, nextAssignee] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const query = `팀 결정 ${suffix}`;
  const statusId = `team_decision_${suffix}`;
  const statusLabel = '팀 보고서에서 검토 중';
  const workflowPath = `/api/projects/${other.id}/workflow`;
  const originalWorkflow = await (await request.get(workflowPath)).json() as ProjectWorkflow;
  const content = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const documents: DocPage[] = [];
  const issues: Issue[] = [];
  let configured: ProjectWorkflow | undefined;
  async function createIssue(projectId: string, label: string, dates: { dueDate?: string; endDate?: string }, status?: string) {
    const response = await request.post('/api/issues', { data: {
      projectId, title: `${query} ${label}`, assigneeId: actor.id, ...dates, status,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }
  async function connect(issue: Issue, source: DocPage, text: string) {
    const response = await request.post(`/api/documents/${source.id}/decision-links`, { data: {
      issueId: issue.id, expectedDocumentVersion: source.version, requestId: randomUUID(), sourceSelection: { from: 1, to: text.length + 1, text },
    } });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json() as DocumentIssueLinkResult).link;
  }
  const path = `#/${base.id}/reports/decision-follow-ups`;
  const urlQuery = () => Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.split('?')[1]));
  const report = page.getByRole('tabpanel', { name: '결정 후속 업무', exact: true });
  const projectPicker = report.getByRole('combobox', { name: '결정 후속 업무 프로젝트', exact: true });
  const status = report.getByRole('combobox', { name: '결정 후속 업무 상태', exact: true });
  const search = report.getByRole('searchbox', { name: '결정 후속 업무 검색', exact: true });
  const apply = report.getByRole('button', { name: '조건 적용', exact: true });
  const row = (issue: Issue) => report.getByRole('article', { name: `${issue.key} 결정 후속 업무`, exact: true });

  try {
    const patch = await request.patch(workflowPath, { data: {
      ...originalWorkflow, expectedVersion: originalWorkflow.version,
      statuses: [...originalWorkflow.statuses, { id: statusId, label: statusLabel, category: 'review', color: '#497993' }],
    } });
    expect(patch.ok(), await patch.text()).toBeTruthy();
    configured = await patch.json() as ProjectWorkflow;
    const originalText = '첫 회의에서 합의한 검증 절차를 보존한다.';
    const currentText = '개정 회의에서 현재 문장만 바꾼다.';
    const commonText = '공통 문서의 실행 조건을 기록한다.';
    const crossSource = await createDecision(request, base.id, `${query} 원래 저장본`, content(originalText));
    const commonSource = await createDecision(request, null, `${query} 공통 문서`, content(commonText));
    documents.push(crossSource, commonSource);
    const first = await createIssue(base.id, '첫 프로젝트 업무', { endDate: '2027-08-21' });
    const second = await createIssue(other.id, '둘째 프로젝트 업무', { dueDate: '2027-08-14', endDate: '2027-08-25' }, statusId);
    await connect(first, commonSource, commonText);
    const crossed = await connect(second, crossSource, originalText);
    const currentTitle = `${query} 개정 회의록`;
    const changedSource = await request.patch(`/api/documents/${crossSource.id}`, { data: {
      expectedVersion: crossSource.version, title: currentTitle, content: content(currentText),
    } });
    expect(changedSource.ok(), await changedSource.text()).toBeTruthy();

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${base.id}/overview`);
    await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
    await page.getByRole('button', { name: '팀 결정 후속 업무', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === `${path}?scope=team`);
    await expect(projectPicker).toHaveValue('team');
    await search.fill(query);
    await status.selectOption('all');
    await apply.click();
    await expect.poll(urlQuery).toEqual({ scope: 'team', status: 'all', q: query });
    await expect(report.getByRole('article').first()).toHaveAccessibleName(`${second.key} 결정 후속 업무`);
    await expect(report.getByRole('article').last()).toHaveAccessibleName(`${first.key} 결정 후속 업무`);
    await expect(row(first).locator(`[data-decision-issue-project="${base.id}"]`)).toHaveText(base.name);
    await expect(row(first).locator('[data-decision-document-space]')).toContainText('팀 공통 문서');
    await expect(row(second).locator(`[data-decision-issue-project="${other.id}"]`)).toHaveText(other.name);
    await expect(row(second).locator('[data-decision-document-space]')).toContainText(base.name);
    await expect(row(second).getByText(statusLabel, { exact: true })).toBeVisible();
    await expect(row(second)).toContainText(currentTitle);

    await projectPicker.selectOption(`project:${other.id}`);
    const addressed = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/decision-follow-ups' && url.searchParams.get('projectId') === other.id;
    });
    await apply.click();
    const pageResult = await addressed;
    expect(pageResult.ok(), await pageResult.text()).toBeTruthy();
    expect(await pageResult.json() as DecisionFollowUpPage).toMatchObject({ projectId: other.id, total: 1 });
    const selected = { scope: 'team', decisionProject: other.id, status: 'all', q: query };
    await expect.poll(urlQuery).toEqual(selected);
    await expect(row(first)).toHaveCount(0);
    await page.reload();
    await expect(projectPicker).toHaveValue(`project:${other.id}`);
    await expect(search).toHaveValue(query);
    await expect(status).toHaveValue('all');
    await expect.poll(urlQuery).toEqual(selected);

    const evidence = row(second).getByRole('button', { name: `${second.key} 결정 근거 열기`, exact: true });
    const sourcePath = `/api/projects/${other.id}/decision-follow-ups/${crossed.id}/source`;
    const revisionPath = `/api/documents/${crossSource.id}/include-revisions/${crossed.documentSource!.revisionId}`;
    const sourceRead = page.waitForResponse(response => new URL(response.url()).pathname === sourcePath);
    const revisionRead = page.waitForResponse(response => new URL(response.url()).pathname === revisionPath);
    await evidence.click();
    expect((await sourceRead).ok()).toBeTruthy();
    expect((await revisionRead).ok()).toBeTruthy();
    await expect(row(second).locator('[data-document-excerpt-start]')).toHaveText(originalText);
    await expect(row(second)).not.toContainText(currentText);
    await row(second).getByRole('button', { name: `${second.key} 결정 근거 접기`, exact: true }).click();

    const opener = row(second).getByRole('button', { name: `${second.key} 업무 열기`, exact: true });
    await opener.click();
    const detail = page.getByRole('dialog', { name: second.title, exact: true });
    await expect(detail.locator('.issue-panel-breadcrumb')).toContainText(other.name);
    await expect.poll(urlQuery).toEqual({ ...selected, issue: second.id });
    await detail.getByRole('combobox', { name: '담당자', exact: true }).selectOption(nextAssignee.id);
    await detail.getByLabel('목표 마감일', { exact: true }).fill('2027-08-29');
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${second.id}` && response.request().method() === 'PATCH');
    await detail.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    expect((await saved).ok()).toBeTruthy();
    await detail.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect.poll(urlQuery).toEqual(selected);
    await expect(opener).toBeFocused();
    await expect(row(second).getByText(nextAssignee.name, { exact: true })).toBeVisible();
    await expect(row(second).locator('time[datetime="2027-08-29"]')).toBeVisible();
    await projectPicker.selectOption('team');
    await apply.click();
    await expect.poll(urlQuery).toEqual({ scope: 'team', status: 'all', q: query });
    await expect(report.getByRole('article').first()).toHaveAccessibleName(`${first.key} 결정 후속 업무`);
    const bounds = await report.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(360);
  } finally {
    try {
      for (const path of [...issues.map(issue => `issues/${issue.id}`), ...documents.map(document => `documents/${document.id}`)]) {
        const deleted = await request.delete(`/api/${path}`);
        if (deleted.ok()) {
          const { trashEntryId } = await deleted.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`);
        }
      }
    } finally {
      if (configured) await request.patch(workflowPath, { data: { ...originalWorkflow, expectedVersion: configured.version } });
    }
  }
});
