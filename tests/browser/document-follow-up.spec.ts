import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { CollaborationSession } from '../../shared/collaboration';
import type { DecisionFollowUpPage, DocPage, DocRevision, DocumentChecklistWork, DocumentFollowUpResult, DocumentIssueLinkResult, Issue,
  LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, Project, ProjectWorkflow, ResourceLink, RichContent, WorkspaceSnapshot } from '../../shared/types';

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

test('360px 문서에서 원래 Jira 키로 업무에 결정 근거를 붙이고 팀 보고서에서 찾는다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const projectKey = `DF${suffix}`;
  const createProject = await request.post('/api/projects', { data: { key: projectKey, name: `현재 프로젝트 ${suffix}` } });
  expect(createProject.status(), await createProject.text()).toBe(201);
  const project = await createProject.json() as Project;
  const createIssue = await request.post('/api/issues', { data: { projectId: project.id, title: `현재 번호가 같은 업무 ${suffix}` } });
  expect(createIssue.status(), await createIssue.text()).toBe(201);
  const current = await createIssue.json() as Issue;
  const importedTitle = `이관한 검토 업무 ${suffix}`;
  const csv = ['Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type',
    `100,${current.key},${projectKey},${importedTitle},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task`].join('\r\n');
  const stageQuery = new URLSearchParams({ filename: `decision-jira-${suffix}.csv`, product: 'jira', instanceKey: `decision-${suffix}` });
  const stage = await request.post(`/api/legacy-import/packages?${stageQuery}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(csv),
  });
  expect(stage.status(), await stage.text()).toBe(201);
  const pkg = await stage.json() as LegacyPackageSummary;
  const quote = '실사용 전 팀 문서와 티켓 이관을 검토한다.';
  let source: DocPage | undefined;
  try {
    const options = await request.get(`/api/migrations/options?packageId=${pkg.id}`);
    expect(options.ok(), await options.text()).toBeTruthy();
    const { defaultConfiguration } = await options.json() as MigrationOptions;
    const configuration = { ...defaultConfiguration, projects: defaultConfiguration.projects.map(value => ({
      ...value, key: `${projectKey}I`, name: `이관한 프로젝트 ${suffix}`,
    })) };
    const previewResponse = await request.post('/api/migrations/preview', { data: { configuration } });
    expect(previewResponse.status(), await previewResponse.text()).toBe(201);
    const preview = await previewResponse.json() as MigrationPreview;
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    const applied = await request.post(`/api/migrations/previews/${preview.id}/apply`, { data: {
      expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
    } });
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: { projectIds: [importedProjectId] } } = await applied.json() as MigrationApplyResult;
    const imported = (await workspace(request)).issues.find(issue => issue.projectId === importedProjectId && issue.title === importedTitle)!;
    expect(imported).toBeDefined();
    const documentTitle = `이관 검토 회의 ${suffix}`;
    source = await createDecision(request, project.id, documentTitle, {
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: quote }] }],
    });

    await openDecision(page, source, project.id);
    await selectFirstParagraph(page.locator('.docs-prose'), 0, quote.length);
    await page.getByRole('button', { name: '선택한 본문을 기존 업무에 연결', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '기존 업무에 결정 근거 연결', exact: true });
    const projectFilter = dialog.getByRole('combobox', { name: '프로젝트', exact: true });
    await dialog.getByRole('textbox', { name: '업무 키 또는 제목 검색', exact: true }).fill(current.key.toLowerCase());
    const target = dialog.getByRole('radio', { name: `${imported.key} ${imported.title}`, exact: true });
    await expect(target).toHaveCount(0);
    await projectFilter.selectOption('');
    const candidates = dialog.getByRole('radio');
    await expect(candidates).toHaveCount(2);
    await expect(candidates.first()).toHaveAccessibleName(`${current.key} ${current.title}`);
    await expect(dialog.getByText(`Jira 원래 키 ${current.key}`, { exact: true })).toBeVisible();
    await projectFilter.selectOption(importedProjectId);
    await expect(candidates).toHaveCount(1);
    await target.check();
    const sourcePath = `/api/documents/${source.id}/decision-links`;
    const response = page.waitForResponse(value => new URL(value.url()).pathname === sourcePath && value.request().method() === 'POST');
    await dialog.getByRole('button', { name: '선택한 업무에 연결', exact: true }).click();
    const saved = await response;
    expect(saved.status(), await saved.text()).toBe(201);
    expect((await saved.json() as DocumentIssueLinkResult).issue.id).toBe(imported.id);
    await expect(dialog).toHaveCount(0);

    await page.goto(`/#/${project.id}/reports/decision-follow-ups`);
    const report = page.getByRole('tabpanel', { name: '결정 후속 업무', exact: true });
    await report.getByRole('combobox', { name: '결정 후속 업무 프로젝트', exact: true }).selectOption('team');
    await report.getByRole('searchbox', { name: '결정 후속 업무 검색', exact: true }).fill(current.key.toLowerCase());
    await report.getByRole('button', { name: '조건 적용', exact: true }).click();
    const row = report.getByRole('article', { name: `${imported.key} 결정 후속 업무`, exact: true });
    await expect(row).toContainText(documentTitle);
    await expect(row).toContainText(`Jira 원래 키 ${current.key}`);
    await row.getByRole('button', { name: `${imported.key} 결정 근거 열기`, exact: true }).click();
    await expect(row.locator('[data-document-excerpt-start]')).toHaveText(quote);
    await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('q')).toBe(current.key.toLowerCase());
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    if (source) await cleanupDecision(request, source.id, importedTitle);
    else {
      const imported = (await workspace(request)).issues.find(issue => issue.title === importedTitle);
      if (imported) await request.delete(`/api/issues/${imported.id}`);
    }
    await request.delete(`/api/issues/${current.id}`);
    await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

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

test('360px 티켓에서 동료가 고정한 결정 근거를 확인한 뒤 문서 연결만 해제한다', async ({ page, request }) => {
  test.setTimeout(70_000);
  const { projects: [project], users: [actor, peer] } = await workspace(request);
  const token = randomUUID().slice(0, 8);
  const title = `설계 결정 ${token}`, issueTitle = `합의 내용 검토 ${token}`;
  const quote = '장비를 바꾸기 전에 기준 온도를 다시 측정한다.';
  const document = await createDecision(request, project.id, title, {
    type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: quote }] }],
  });
  try {
    const created = await request.post('/api/issues', { data: { projectId: project.id, title: issueTitle } });
    expect(created.status(), await created.text()).toBe(201);
    const issue = await created.json() as Issue;
    const linked = await request.post('/api/resource-links', { data: { issueId: issue.id, documentId: document.id, kind: 'related' } });
    expect(linked.status(), await linked.text()).toBe(201);
    const plain = await linked.json() as ResourceLink;

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    const route = `#/${project.id}/issues?issue=${issue.id}`;
    await page.goto(`/${route}`);
    const panel = page.getByRole('dialog', { name: issueTitle, exact: true });
    const documents = panel.getByRole('region', { name: '연결된 문서', exact: true });
    const unlink = documents.getByRole('button', { name: `${title} 연결 해제`, exact: true });
    const evidence = documents.getByRole('region', { name: '결정 근거', exact: true });
    const titleDraft = panel.getByRole('textbox', { name: '제목', exact: true });
    const commentDraft = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const draftTitle = `${issueTitle} 편집 중`, draftComment = '검토가 끝나면 공유할 댓글';
    await expect(unlink).toBeVisible();
    await titleDraft.fill(draftTitle);
    await commentDraft.fill(draftComment);

    const selection = { from: 1, to: quote.length + 1, text: quote };
    const attaching = await request.post(`/api/documents/${document.id}/decision-links`, {
      headers: { 'X-Actor-Id': peer.id }, data: { requestId: randomUUID(), expectedDocumentVersion: document.version, issueId: issue.id, sourceSelection: selection },
    });
    expect(attaching.status(), await attaching.text()).toBe(201);
    const pinned = (await attaching.json() as DocumentIssueLinkResult).link;
    const pinnedSource = pinned.documentSource!;
    expect(pinned.id).toBe(plain.id);
    expect(pinnedSource).toMatchObject(selection);
    await expect(evidence).toHaveCount(0);

    const path = `/api/resource-links/${plain.id}`;
    const removalRequests: string[] = [];
    page.on('request', sent => {
      if (new URL(sent.url()).pathname === path && sent.method() === 'DELETE') removalRequests.push(sent.url());
    });
    const nextRemoval = () => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'DELETE');
    const rejecting = nextRemoval();
    await unlink.click();
    const rejected = await rejecting;
    expect(new URL(rejected.url()).search).toBe('');
    expect(rejected.status(), await rejected.text()).toBe(409);
    expect(await rejected.json()).toMatchObject({ details: { reason: 'decision_source_changed' } });
    await expect(documents.getByRole('alert')).toContainText('결정 근거');
    await expect(evidence.locator('blockquote')).toHaveText(quote);
    expect((await workspace(request)).resourceLinks.find(link => link.id === plain.id)).toEqual(pinned);
    await expect(titleDraft).toHaveValue(draftTitle);
    await expect(commentDraft).toHaveValue(draftComment);
    await expect(page).toHaveURL(url => url.hash === route);

    async function confirmRemoval(approve: boolean) {
      const confirmation = page.waitForEvent('dialog').then(async dialog => {
        const message = dialog.message();
        await (approve ? dialog.accept() : dialog.dismiss());
        expect(message).toContain('문서 연결과 결정 근거를 해제할까요?');
      });
      await Promise.all([unlink.click(), confirmation]);
    }
    await confirmRemoval(false);
    await expect(evidence.locator('blockquote')).toHaveText(quote);
    expect(removalRequests).toHaveLength(1);

    const committedStatuses: number[] = [];
    await page.route(url => url.pathname === path, async intercepted => {
      if (intercepted.request().method() !== 'DELETE') return intercepted.continue();
      committedStatuses.push((await intercepted.fetch()).status());
      await intercepted.fulfill({ status: 408, json: { error: '합성 응답 유실' } });
    });
    const deleting = nextRemoval();
    await confirmRemoval(true);
    const deleted = await deleting;
    expect(deleted.status(), await deleted.text()).toBe(408);
    expect(Object.fromEntries(new URL(deleted.url()).searchParams)).toEqual({
      expectedDecisionRevisionId: pinnedSource.revisionId,
      expectedDecisionFrom: String(pinnedSource.from),
      expectedDecisionTo: String(pinnedSource.to),
    });
    await expect(evidence).toHaveCount(0);
    await expect(unlink).toHaveCount(0);
    await expect(documents.getByRole('button', { name: '새 연결 문서 만들기', exact: true })).toBeFocused();
    await expect(titleDraft).toHaveValue(draftTitle);
    await expect(commentDraft).toHaveValue(draftComment);
    await expect(page).toHaveURL(url => url.hash === route);
    expect(removalRequests).toHaveLength(2);
    expect(committedStatuses).toEqual([200]);

    const after = await workspace(request);
    expect(after.resourceLinks.some(link => link.id === plain.id)).toBe(false);
    expect(after.documents.find(item => item.id === document.id)).toEqual(document);
    expect(after.issues.find(item => item.id === issue.id)).toEqual(issue);
    const revisions = await request.get(`/api/documents/${document.id}/revisions`);
    expect(revisions.status(), await revisions.text()).toBe(200);
    expect((await revisions.json() as DocRevision[]).find(item => item.id === pinnedSource.revisionId)?.plainText).toBe(quote);
  } finally {
    await cleanupDecision(request, document.id, issueTitle);
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

test('360px 문서에서 직접 연결과 본문의 업무 상태와 결정 당시 원문을 함께 확인한다', async ({ page, request }) => {
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
    const bodyOnlyIssue = await createIssue('본문에서만 참조한 업무', {
      projectId: documentProject.id, assigneeId: nextAssignee.id, status: 'in_progress', dueDate: '2027-05-30',
    });
    const draftOnlyIssue = await createIssue('저장 전 본문 참조', { projectId: documentProject.id });
    const removedIssue = await createIssue('열 수 없는 이전 업무', { projectId: documentProject.id });
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
        { type: 'issueReference', attrs: { issueId: decisionIssue.id, label: decisionIssue.title } },
        { type: 'issueReference', attrs: { issueId: decisionIssue.id, label: decisionIssue.title } },
        { type: 'issueReference', attrs: { issueId: removedIssue.id, label: removedIssue.title } },
      ] },
    } });
    expect(edited.ok(), await edited.text()).toBe(true);
    const removed = await request.delete(`/api/issues/${removedIssue.id}?expectedVersion=${removedIssue.version}`);
    expect(removed.ok(), await removed.text()).toBe(true);
    const { trashEntryId } = await removed.json() as { trashEntryId: string };
    const purged = await request.delete(`/api/trash/${trashEntryId}`);
    expect(purged.ok(), await purged.text()).toBe(true);

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
    await page.locator('.docs-prose > p').filter({ hasText: latestText }).click();
    await page.getByRole('button', { name: '업무 참조 삽입', exact: true }).click();
    const referenceChooser = page.getByRole('dialog', { name: '업무 참조 삽입', exact: true });
    await referenceChooser.getByRole('textbox', { name: '참조할 항목 검색', exact: true }).fill(draftOnlyIssue.key);
    await referenceChooser.getByRole('button', { name: new RegExp(draftOnlyIssue.title) }).click();
    await expect(referenceChooser).toHaveCount(0);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await page.getByRole('button', { name: '연결', exact: true }).click();
    const panel = page.getByRole('region', { name: '연결된 업무', exact: true });
    const cards = panel.locator('.docs-linked-issue');
    const card = (issue: Issue) => cards.filter({ hasText: issue.title });
    const filters = panel.getByLabel('연결된 업무 상태', { exact: true });
    const onlyEvidence = panel.getByRole('checkbox', { name: '결정 근거가 있는 업무만', exact: true });
    await expect(cards).toHaveCount(4);
    await expect(cards.nth(0)).toContainText(decisionIssue.title);
    await expect(cards.nth(1)).toContainText(ordinaryIssue.title);
    await expect(cards.nth(2)).toContainText(bodyOnlyIssue.title);
    await expect(cards.nth(3)).toContainText(closedIssue.title);
    await expect(card(bodyOnlyIssue)).toContainText('본문 참조 1곳');
    await expect(card(bodyOnlyIssue)).toContainText('진행 중');
    await expect(card(bodyOnlyIssue)).toContainText(nextAssignee.name);
    await expect(card(bodyOnlyIssue).locator('time')).toHaveAttribute('datetime', bodyOnlyIssue.dueDate!);
    await expect(card(decisionIssue)).toHaveCount(1);
    await expect(card(decisionIssue)).toContainText('본문 참조 2곳');
    await expect(card(draftOnlyIssue)).toHaveCount(0);
    const inlineReferences = page.getByRole('heading', { name: '본문의 업무 참조', exact: true }).locator('..');
    await expect(inlineReferences.getByRole('button')).toHaveCount(2);
    await expect(inlineReferences.getByRole('button', { name: new RegExp(draftOnlyIssue.title) })).toContainText('저장 전');
    await expect(inlineReferences.getByRole('button', { name: new RegExp(removedIssue.title) })).toBeDisabled();
    await expect(filters.getByRole('option', { name: '전체 4개', exact: true })).toHaveCount(1);
    await expect(filters.getByRole('option', { name: '미완료 3개', exact: true })).toHaveCount(1);
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

    await card(bodyOnlyIssue).click();
    const referenceTicket = page.getByRole('dialog', { name: bodyOnlyIssue.title, exact: true });
    await expect(referenceTicket).toBeVisible();
    await referenceTicket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(card(bodyOnlyIssue)).toBeFocused();
    await expect(title).toHaveValue(draftTitle);

    await filters.selectOption('open');
    await expect(cards).toHaveCount(3);
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
    await expect(inlineReferences.getByRole('button', { name: new RegExp(draftOnlyIssue.title) })).toContainText('저장 전');
    await expect(title).toHaveValue(draftTitle);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
    const persisted = await workspace(request);
    expect(persisted.documents.find(item => item.id === documentId)?.title).toBe(originalTitle);
    expect(persisted.resourceLinks.filter(item => item.documentId === documentId).map(item => item.issueId).sort()).toEqual(
      [decisionIssue.id, ordinaryIssue.id, closedIssue.id].sort(),
    );
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

test('360px 결정 후속 업무에서 마감일과 미정 일정을 구분하고 종료일을 채운 뒤 같은 조건으로 돌아온다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const { projects: [home, target] } = await workspace(request);
  const query = `결정 일정 ${randomUUID().slice(0, 8)}`;
  const excerpt = '결정 당시에는 검증 결과를 첨부하기로 했다.';
  const revisedText = '현재 문서에는 개정된 검증 절차만 남아 있다.';
  const content = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const source = await createDecision(request, home.id, `${query} 회의 원문`, content(excerpt));
  const startDate = '2027-08-11', endDate = '2027-08-13', dueDate = '2027-08-17';
  const issueIds: string[] = [];

  async function followUp(label: string, dates: { startDate: string; endDate?: string; dueDate: string }) {
    const created = await request.post('/api/issues', { data: { projectId: target.id, title: `${query} ${label}`, ...dates } });
    expect(created.status(), await created.text()).toBe(201);
    const issue = await created.json() as Issue;
    issueIds.push(issue.id);
    const linked = await request.post(`/api/documents/${source.id}/decision-links`, { data: {
      requestId: randomUUID(), expectedDocumentVersion: source.version, issueId: issue.id,
      sourceSelection: { from: 1, to: excerpt.length + 1, text: excerpt },
    } });
    expect(linked.status(), await linked.text()).toBe(201);
    return { issue, link: (await linked.json() as DocumentIssueLinkResult).link };
  }

  try {
    const missing = await followUp('종료일을 정할 업무', { dueDate, startDate });
    const planned = await followUp('이미 날짜가 있는 업무', { dueDate: '2027-08-18', startDate, endDate });
    const changed = await request.patch(`/api/documents/${source.id}`, { data: { expectedVersion: source.version, content: content(revisedText) } });
    expect(changed.ok(), await changed.text()).toBeTruthy();

    await page.setViewportSize({ width: 360, height: 820 });
    const parameters = new URLSearchParams({ scope: 'team', decisionProject: target.id, status: 'all', q: query });
    await page.goto(`/#/${home.id}/reports/decision-follow-ups?${parameters}`);
    const report = page.getByRole('tabpanel', { name: '결정 후속 업무', exact: true });
    const row = (issue: Issue) => report.getByRole('article', { name: `${issue.key} 결정 후속 업무`, exact: true });
    const missingRow = row(missing.issue);
    await expect(missingRow.getByText('계획 일정', { exact: true })).toBeVisible();
    await expect(missingRow).toContainText(`${startDate} ~ 종료일 미정`);
    await expect(missingRow.getByText('목표 마감일', { exact: true })).toBeVisible();
    await expect(missingRow.locator(`time[datetime="${dueDate}"]`)).toBeVisible();
    const openDate = missingRow.getByRole('button', { name: '간트에서 날짜 입력', exact: true });
    await expect(openDate).toBeVisible();
    await expect(row(planned.issue).getByRole('button', { name: '간트에서 일정 보기', exact: true })).toBeVisible();
    await expect(row(planned.issue)).toContainText(`${startDate} ~ ${endDate}`);

    const unscheduledOnly = report.getByRole('checkbox', { name: '일정 미정만', exact: true });
    const apply = report.getByRole('button', { name: '조건 적용', exact: true });
    const nextUnscheduledReport = () => page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/decision-follow-ups' && url.searchParams.get('q') === query &&
        url.searchParams.get('projectId') === target.id && url.searchParams.get('unscheduledOnly') === '1';
    });
    await unscheduledOnly.check();
    const filtering = nextUnscheduledReport();
    await apply.click();
    const filtered = await filtering;
    expect(filtered.ok(), await filtered.text()).toBeTruthy();
    expect(await filtered.json() as DecisionFollowUpPage).toMatchObject({ projectId: target.id, total: 1,
      items: [expect.objectContaining({ issue: expect.objectContaining({ id: missing.issue.id, deadline: dueDate, startDate, endDate: null }) })],
    });
    await expect(row(planned.issue)).toHaveCount(0);
    const reportRoute = new URL(page.url()).hash;
    expect(new URLSearchParams(reportRoute.split('?')[1]).get('unscheduledOnly')).toBe('1');

    await openDate.click();
    await expect(page).toHaveURL(url => {
      const [path, search] = url.hash.split('?');
      const routeParams = new URLSearchParams(search);
      return path === `#/${target.id}/gantt` && routeParams.get('focusIssue') === missing.issue.id && routeParams.get('focusDate') === 'endDate';
    });
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const ganttRow = chart.locator(`[data-issue-id="${missing.issue.id}"]`);
    const ending = ganttRow.getByLabel(`${missing.issue.key} 종료일`, { exact: true });
    await expect(ganttRow).toHaveAttribute('data-focused-issue', 'true');
    await expect(ending).toBeFocused();
    await expect(ending).toBeInViewport({ ratio: 0.9 });
    await expect(ending).toHaveValue('');
    await expect(ganttRow.getByLabel(`${missing.issue.key} 시작일`, { exact: true })).toHaveValue(startDate);
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/manual-apply' && response.request().method() === 'POST');
    await ending.fill(endDate);
    await ending.press('Enter');
    const saved = await saving;
    expect(saved.ok(), await saved.text()).toBeTruthy();
    await expect(ending).toHaveValue(endDate);
    await expect.poll(async () => (await workspace(request)).issues.find(issue => issue.id === missing.issue.id)).toMatchObject({ startDate, endDate, dueDate });

    const returning = nextUnscheduledReport();
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === reportRoute);
    const returned = await returning;
    expect(returned.ok(), await returned.text()).toBeTruthy();
    expect(await returned.json() as DecisionFollowUpPage).toMatchObject({ total: 0, items: [] });
    await expect(unscheduledOnly).toBeChecked();
    await expect(report.getByRole('combobox', { name: '결정 후속 업무 프로젝트', exact: true })).toHaveValue(`project:${target.id}`);
    await expect(report.getByRole('combobox', { name: '결정 후속 업무 상태', exact: true })).toHaveValue('all');
    await expect(report.getByRole('searchbox', { name: '결정 후속 업무 검색', exact: true })).toHaveValue(query);
    await expect(report.getByRole('article')).toHaveCount(0);
    await unscheduledOnly.uncheck();
    await apply.click();
    await expect(missingRow.getByRole('button', { name: '간트에서 일정 보기', exact: true })).toBeVisible();
    await expect(missingRow).toContainText(`${startDate} ~ ${endDate}`);
    await expect(missingRow.locator(`time[datetime="${dueDate}"]`)).toBeVisible();

    const revisionPath = `/api/documents/${source.id}/include-revisions/${missing.link.documentSource!.revisionId}`;
    const reading = page.waitForResponse(response => new URL(response.url()).pathname === revisionPath);
    await missingRow.getByRole('button', { name: `${missing.issue.key} 결정 근거 열기`, exact: true }).click();
    expect((await reading).ok()).toBeTruthy();
    await expect(missingRow.locator('[data-document-excerpt-start]')).toHaveText(excerpt);
    await expect(missingRow).not.toContainText(revisedText);
    expect((await workspace(request)).resourceLinks.find(link => link.id === missing.link.id)).toEqual(missing.link);

    const documentRoute = `#/${home.id}/documents/${source.id}`;
    await missingRow.getByRole('link', { name: `현재 문서 열기 ${source.title}`, exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === documentRoute);
    const titleEditor = page.getByRole('textbox', { name: '문서 제목', exact: true });
    const unsavedTitle = `${source.title} 편집 중`;
    await expect(page.locator('.docs-prose')).toHaveText(revisedText);
    await titleEditor.fill(unsavedTitle);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await page.getByRole('button', { name: '연결', exact: true }).click();
    const linkedWork = page.getByRole('region', { name: '연결된 업무', exact: true });
    const linkedRow = linkedWork.getByRole('listitem').filter({ hasText: missing.issue.title });
    const shortcut = linkedRow.getByRole('button', { name: '간트에서 일정 보기', exact: true });
    let guardMessage = '';
    page.once('dialog', async dialog => { guardMessage = dialog.message(); await dialog.dismiss(); });
    await shortcut.click();
    expect(guardMessage).toContain('임시 보관');
    await expect(page).toHaveURL(url => url.hash === documentRoute);
    await expect(titleEditor).toHaveValue(unsavedTitle);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');

    page.once('dialog', dialog => dialog.accept());
    await shortcut.click();
    await expect(page).toHaveURL(url => url.hash === `#/${target.id}/gantt?focusIssue=${missing.issue.id}`);
    await expect(ganttRow.getByRole('button', { name: `${missing.issue.key} 일정 이동`, exact: true })).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === documentRoute);
    await expect(titleEditor).toHaveValue(unsavedTitle);
    await expect(page.locator('.docs-save-state')).toHaveText('저장 필요');
  } finally {
    for (const item of [...issueIds.map(id => `issues/${id}`), `documents/${source.id}`]) {
      const removed = await request.delete(`/api/${item}`);
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
    }
  }
});

function checklistBody(parentLabel: string, nestedLabel: string): RichContent {
  const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const item = (content: RichContent[]): RichContent => ({ type: 'taskItem', attrs: { checked: false }, content });
  return { type: 'doc', content: [paragraph('회의 안건'), { type: 'taskList', content: [
    item([{ type: 'paragraph', content: [{ type: 'text', text: parentLabel, marks: [{ type: 'bold' }] }] },
      paragraph('이 설명은 체크리스트 제목에 포함하지 않습니다.'),
      { type: 'taskList', content: [item([paragraph(nestedLabel)])] }]),
    item([paragraph('다음 담당자에게 알림')]),
  ] }] };
}

test('360px에서 체크리스트 항목을 후속 업무로 만들고 기존 업무에도 근거를 연결한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const { projects: [project], users: [actor, assignee] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const title = `회의 체크리스트 ${suffix}`;
  const parentLabel = `외부 통신 검증 ${suffix}`;
  const nestedLabel = `재시도 조건 확인 ${suffix} 🔎`;
  const quote = `${nestedLabel} 완료 기준`;
  const existingTitle = `기존 통신 시험 ${suffix}`;
  const source = await createDecision(request, project.id, title, checklistBody(parentLabel, nestedLabel));
  try {
    const created = await request.post('/api/issues', { data: { projectId: project.id, title: existingTitle } });
    expect(created.status(), await created.text()).toBe(201);
    const existing = await created.json() as Issue;
    const enabled = await request.post(`/api/documents/${source.id}/collaboration/enable`, { data: { expectedVersion: source.version } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await openDecision(page, source, project.id);
    const editor = page.locator('.docs-live-prose');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    const newIssue = page.getByRole('button', { name: '체크리스트 항목으로 후속 업무 만들기', exact: true });
    const existingIssue = page.getByRole('button', { name: '체크리스트 항목을 기존 업무에 연결', exact: true });
    await editor.getByText('회의 안건', { exact: true }).click();
    await expect(newIssue).toHaveCount(0);
    const nested = editor.getByText(nestedLabel, { exact: true });
    await nested.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' 완료 기준');
    await expect.poll(async () => (await workspace(request)).documents.find(document => document.id === source.id)?.plainText).toContain(quote);
    await expect(newIssue).toBeEnabled();
    await newIssue.click();
    const dialog = page.getByRole('dialog', { name: '후속 업무 만들기', exact: true });
    await expect(dialog.getByRole('textbox', { name: '업무 제목', exact: true })).toHaveValue(quote);
    await expect(dialog.getByRole('region', { name: '선택한 체크리스트 항목', exact: true }).locator('blockquote')).toHaveText(quote);
    await dialog.getByRole('combobox', { name: '담당자', exact: true }).selectOption(assignee.id);
    await dialog.getByText('추가 속성', { exact: true }).click();
    await dialog.getByLabel('목표 마감일', { exact: true }).fill('2027-02-16');
    const followUpPath = `/api/documents/${source.id}/follow-up-issues`;
    const posting = page.waitForResponse(response => new URL(response.url()).pathname === followUpPath && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '업무 만들고 연결', exact: true }).click();
    const response = await posting;
    expect(response.status(), await response.text()).toBe(201);
    const result = await response.json() as DocumentFollowUpResult;
    expect(result.issue).toMatchObject({ title: quote, assigneeId: assignee.id, dueDate: '2027-02-16' });
    expect(result.link.documentSource).toMatchObject({ text: quote });
    await expect(dialog).toHaveCount(0);
    await expect(newIssue).toBeFocused();

    await editor.getByText(parentLabel, { exact: true }).click();
    await existingIssue.click();
    const link = page.getByRole('dialog', { name: '기존 업무에 결정 근거 연결', exact: true });
    await expect(link.locator('blockquote')).toHaveText(parentLabel);
    await link.getByRole('textbox', { name: '업무 키 또는 제목 검색', exact: true }).fill(existing.key);
    await link.getByRole('radio', { name: new RegExp(`${existing.key}.*${existingTitle}`) }).check();
    const linking = page.waitForResponse(answer => answer.url().endsWith(`/api/documents/${source.id}/decision-links`) && answer.request().method() === 'POST');
    await link.getByRole('button', { name: '선택한 업무에 연결', exact: true }).click();
    const linkedResponse = await linking;
    expect(linkedResponse.status(), await linkedResponse.text()).toBe(201);
    const linked = await linkedResponse.json() as DocumentIssueLinkResult;
    expect(linked.link.documentSource).toMatchObject({ text: parentLabel });
    expect(linked.link.documentSource?.from).toBeLessThan(result.link.documentSource!.from);
    await expect(link).toHaveCount(0);

    const responseReport = await request.get(`/api/projects/${project.id}/decision-follow-ups?assigneeId=${assignee.id}&q=${encodeURIComponent(result.issue.key)}`);
    expect(responseReport.ok(), await responseReport.text()).toBe(true);
    const report = await responseReport.json() as DecisionFollowUpPage;
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ linkId: result.link.id, issue: { id: result.issue.id, assigneeId: assignee.id, deadline: '2027-02-16' } });
  } finally {
    await cleanupDecision(request, source.id, quote);
    for (const issue of (await workspace(request)).issues.filter(item => item.title === existingTitle)) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('360px에서 체크리스트 원문이 바뀌면 작성한 업무 입력을 유지하며 항목을 다시 선택한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const { projects: [project], users: [actor, peer] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const issueTitle = `회의 후속 입력 ${suffix}`;
  const originalLabel = `이전 검사 항목 ${suffix}`;
  const currentLabel = `최신 검사 항목 ${suffix}`;
  const source = await createDecision(request, project.id, `바뀌는 체크리스트 ${suffix}`, checklistBody('상위 업무', originalLabel));
  const path = `/api/documents/${source.id}/follow-up-issues`;
  const nextRequest = () => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
  try {
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await openDecision(page, source, project.id);
    const editor = page.locator('.docs-prose');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.getByText(originalLabel, { exact: true }).click();
    await page.getByRole('button', { name: '체크리스트 항목으로 후속 업무 만들기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '후속 업무 만들기', exact: true });
    const excerpt = dialog.getByRole('region', { name: '선택한 체크리스트 항목', exact: true });
    const title = dialog.getByRole('textbox', { name: '업무 제목', exact: true });
    const description = dialog.getByRole('textbox', { name: '설명', exact: true });
    const assignee = dialog.getByRole('combobox', { name: '담당자', exact: true });
    const due = dialog.getByLabel('목표 마감일', { exact: true });
    const submit = dialog.getByRole('button', { name: '업무 만들고 연결', exact: true });
    await title.fill(issueTitle);
    await description.fill('두 작업장의 결과를 한 표로 확인한다.');
    await assignee.selectOption(peer.id);
    await dialog.getByText('추가 속성', { exact: true }).click();
    await due.fill('2027-02-16');

    const changed = await request.patch(`/api/documents/${source.id}`, { headers: { 'X-Actor-Id': peer.id }, data: {
      expectedVersion: source.version, content: checklistBody('상위 업무', currentLabel),
    } });
    expect(changed.ok(), await changed.text()).toBe(true);
    const current = await changed.json() as DocPage;
    const rejected = nextRequest();
    await submit.click();
    expect((await rejected).status()).toBe(409);
    const reselect = dialog.getByRole('button', { name: '최신 체크리스트 항목 다시 선택', exact: true });
    await reselect.click();
    const cancel = page.getByRole('button', { name: '항목 다시 선택 취소', exact: true });
    await expect(dialog).toHaveCount(0);
    await expect(editor.getByText(currentLabel, { exact: true })).toBeVisible();
    await cancel.click();
    await expect(excerpt.locator('blockquote')).toHaveText(originalLabel);
    await expect(due).toHaveValue('2027-02-16');
    await expect(submit).toBeDisabled();

    await reselect.click();
    await editor.getByText('회의 안건', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' 정리');
    const useItem = page.getByRole('button', { name: '이 체크리스트 항목 사용', exact: true });
    await editor.getByText(currentLabel, { exact: true }).click();
    await expect(useItem).toBeDisabled();
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === `/api/documents/${source.id}` && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: '본문 저장', exact: true }).click();
    const savedResponse = await saving;
    expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
    const latest = await savedResponse.json() as DocPage;
    expect(latest.version).toBeGreaterThan(current.version);
    expect(latest.plainText).toContain('회의 안건 정리');
    await editor.getByText(currentLabel, { exact: true }).click();
    await useItem.click();
    await expect(excerpt.locator('blockquote')).toHaveText(currentLabel);
    await expect(title).toHaveValue(issueTitle);
    await expect(description).toHaveValue('두 작업장의 결과를 한 표로 확인한다.');
    await expect(assignee).toHaveValue(peer.id);
    await expect(due).toHaveValue('2027-02-16');

    const attempts: unknown[] = [];
    await page.route(`**${path}`, async route => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      const result = await route.fetch();
      expect(result.status(), await result.text()).toBe(201);
      await route.fulfill({ status: 408, json: { error: '합성 응답 유실' } });
    });
    await submit.click();
    const retry = dialog.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    const replayed = nextRequest();
    await retry.click();
    const response = await replayed;
    expect(response.status(), await response.text()).toBe(200);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ expectedDocumentVersion: latest.version, sourceSelection: { text: currentLabel } });
    expect(attempts[1]).toEqual(attempts[0]);
    const saved = await response.json() as DocumentFollowUpResult;
    expect(saved.duplicate).toBe(true);
    expect(saved.link.documentSource).toMatchObject({ text: currentLabel });
    const snapshot = await workspace(request);
    expect(snapshot.documents.find(document => document.id === source.id)).toEqual(latest);
    expect(snapshot.issues.filter(issue => issue.title === issueTitle)).toHaveLength(1);
    await expect(dialog).toHaveCount(0);
  } finally {
    await cleanupDecision(request, source.id, issueTitle);
  }
});

test('360px에서 같은 문구의 체크리스트 항목을 구분해 업무를 열고 새 저장본의 연결을 확인한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const { projects: [project], users: [actor, assignee] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const label = `같은 점검 기준 ${suffix}`;
  const source = await createDecision(request, project.id, `체크리스트 연결 검토 ${suffix}`, checklistBody(label, label));
  const issues: Issue[] = [];
  const headers = { 'X-Actor-Id': actor.id };

  async function createIssue(title: string) {
    const response = await request.post('/api/issues', { headers, data: { projectId: project.id, title: `${title} ${suffix}` } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }

  try {
    const first = await createIssue('상위 항목의 연결 업무');
    const additional = await createIssue('상위 항목의 추가 업무');
    const nested = await createIssue('하위 항목의 연결 업무');
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await openDecision(page, source, project.id);
    const editor = page.locator('.docs-prose');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    const items = editor.getByText(label, { exact: true });
    await expect(items).toHaveCount(2);
    const contextual = page.getByRole('region', { name: '연결된 체크리스트 업무', exact: true });
    const opener = (issue: Issue) => contextual.getByRole('button', { name: `${issue.key} 업무 열기`, exact: true });

    async function attach(item: Locator, issue: Issue) {
      await item.click();
      await page.getByRole('button', { name: '체크리스트 항목을 기존 업무에 연결', exact: true }).click();
      const chooser = page.getByRole('dialog', { name: '기존 업무에 결정 근거 연결', exact: true });
      await expect(chooser.locator('blockquote')).toHaveText(label);
      await chooser.getByRole('textbox', { name: '업무 키 또는 제목 검색', exact: true }).fill(issue.key);
      await chooser.getByRole('radio', { name: `${issue.key} ${issue.title}`, exact: true }).check();
      const posting = page.waitForResponse(response => response.url().endsWith(`/api/documents/${source.id}/decision-links`) && response.request().method() === 'POST');
      await chooser.getByRole('button', { name: '선택한 업무에 연결', exact: true }).click();
      const response = await posting;
      expect(response.status(), await response.text()).toBe(201);
      const result = await response.json() as DocumentIssueLinkResult;
      await expect(chooser).toHaveCount(0);
      return result.link.documentSource!;
    }

    const firstSource = await attach(items.first(), first);
    const additionalSource = await attach(items.first(), additional);
    const nestedSource = await attach(items.last(), nested);
    expect(additionalSource).toEqual(firstSource);
    expect(nestedSource.text).toBe(firstSource.text);
    expect(nestedSource.from).toBeGreaterThan(firstSource.to);

    await items.last().click();
    await expect(opener(nested)).toBeVisible();
    await expect(contextual.getByRole('button')).toHaveCount(1);
    await items.first().click();
    await expect(opener(first)).toBeVisible();
    await expect(opener(additional)).toBeVisible();
    await expect(contextual.getByRole('button')).toHaveCount(2);
    await expect(opener(nested)).toHaveCount(0);

    await opener(first).click();
    const drawer = page.getByRole('dialog', { name: first.title, exact: true });
    await expect(drawer).toBeVisible();
    expect(new URL(page.url()).hash).toContain(`/documents/${source.id}`);
    await drawer.getByRole('combobox', { name: '상태', exact: true }).selectOption('in_progress');
    await drawer.getByRole('combobox', { name: '담당자', exact: true }).selectOption(assignee.id);
    await drawer.getByLabel('목표 마감일', { exact: true }).fill('2027-10-28');
    const updating = page.waitForResponse(response => response.url().endsWith(`/api/issues/${first.id}`) && response.request().method() === 'PATCH');
    await drawer.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    expect((await updating).ok()).toBe(true);
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(opener(first)).toBeFocused();
    await expect(opener(first)).toContainText('진행 중');
    await expect(opener(first)).toContainText(assignee.name);
    await expect(opener(first).locator('time[datetime="2027-10-28"]')).toBeVisible();

    await editor.getByText('다음 담당자에게 알림', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' · 다음 회의에서 확인');
    await items.first().click();
    await expect(page.getByRole('button', { name: '체크리스트 항목을 기존 업무에 연결', exact: true })).toBeDisabled();
    await expect(contextual).toHaveCount(0);

    const lookup = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/documents/${source.id}/checklist-work` &&
        Number(url.searchParams.get('expectedDocumentVersion')) > source.version;
    });
    const saving = page.waitForResponse(response => response.url().endsWith(`/api/documents/${source.id}`) && response.request().method() === 'PATCH');
    await page.locator('.docs-save-button').click();
    const saved = await saving;
    expect(saved.ok(), await saved.text()).toBe(true);
    const updated = await saved.json() as DocPage;
    await items.first().click();
    const fresh = await lookup;
    expect(fresh.ok(), await fresh.text()).toBe(true);
    expect(await fresh.json() as DocumentChecklistWork).toEqual({ documentId: source.id, documentVersion: updated.version, links: [] });
    await expect(contextual).toHaveCount(0);

    await page.getByRole('button', { name: '문서에 연결된 업무 보기', exact: true }).click();
    const linked = page.getByRole('region', { name: '연결된 업무', exact: true });
    for (const issue of issues) await expect(linked.locator('.docs-linked-issue').filter({ hasText: issue.title })).toBeVisible();
  } finally {
    for (const item of [...issues.map(({ id }) => `issues/${id}`), `documents/${source.id}`]) {
      const removed = await request.delete(`/api/${item}`, { headers });
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`, { headers });
    }
  }
});
