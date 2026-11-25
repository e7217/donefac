import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { DocPage, Issue, LinkedDocumentCreationResult, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });
const field = (within: Locator | Page, name: string) => within.getByLabel(name, { exact: true });

function nextConfirmation(page: Page, accept: boolean) {
  return page.waitForEvent('dialog').then(async dialog => {
    const message = dialog.message();
    if (accept) await dialog.accept();
    else await dialog.dismiss();
    return message;
  });
}

async function purge(request: APIRequestContext, kind: 'documents' | 'issues', id: string, actorId: string) {
  const headers = { 'X-Actor-Id': actorId };
  const deleted = await request.delete(`/api/${kind}/${id}`, { headers });
  if (!deleted.ok()) return;
  const { trashEntryId } = await deleted.json() as { trashEntryId: string };
  expect((await request.delete(`/api/trash/${trashEntryId}`, { headers })).ok()).toBe(true);
}

test('360px 티켓에서 연결 문서 저장 응답을 잃어도 같은 요청으로 한 건만 만들고 양쪽에서 연다', async ({ page, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [actor] } = await workspace(request);
  const suffix = randomUUID().slice(0, 8);
  const documentTitle = `티켓 설계 초안 ${suffix}`;
  const headers = { 'X-Actor-Id': actor.id };
  const issue = await json<Issue>(await request.post('/api/issues', {
    headers, data: { projectId: project.id, title: `설계 연결 업무 ${suffix}` },
  }), 201);
  let parent: DocPage | undefined;
  try {
    parent = await json<DocPage>(await request.post('/api/documents', {
      headers, data: { projectId: null, title: `팀 공통 설계 모음 ${suffix}` },
    }), 201);
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    const query = new URLSearchParams({ boardQuery: issue.title });
    await page.goto(`/#/${project.id}/teamboard?${query}`);
    const board = page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
    await button(board, `${issue.key} 업무 열기`).click({ timeout: 35_000 });
    const ticketLocation = page.url();
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    const linked = ticket.getByRole('region', { name: '연결된 문서', exact: true });
    const opener = button(linked, '새 연결 문서 만들기');
    const draftTitle = `${issue.title} 수정 중`;
    const draftComment = '설계 문서 연결과 별도로 작성 중인 댓글';
    await field(ticket, '제목').fill(draftTitle);
    await field(ticket, '댓글 내용').fill(draftComment);

    const creator = page.getByRole('dialog', { name: '연결 문서 만들기', exact: true });
    const title = field(creator, '문서 제목');
    const space = creator.getByRole('combobox', { name: '공간', exact: true });
    await opener.click();
    await expect(title).toBeFocused();
    await expect(space).toHaveValue(project.id);
    await title.fill('닫을 연결 문서 초안');
    const discard = nextConfirmation(page, true);
    await button(creator, '취소').click();
    expect(await discard).toContain('버릴');
    await expect(creator).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(field(ticket, '제목')).toHaveValue(draftTitle);

    await opener.click();
    await title.fill(documentTitle);
    await space.selectOption('');
    await creator.getByRole('combobox', { name: '상위 문서', exact: true }).selectOption(parent.id);
    await creator.getByRole('combobox', { name: '기본 템플릿', exact: true }).selectOption('design');
    const endpoint = `/api/issues/${issue.id}/documents`;
    let firstResult: LinkedDocumentCreationResult | undefined;
    const attempts: { body: string | null; actor: string }[] = [];
    await page.route(`**${endpoint}`, async route => {
      const sent = route.request();
      attempts.push({ body: sent.postData(), actor: sent.headers()['x-actor-id'] });
      if (attempts.length > 1) { await route.continue(); return; }
      firstResult = await json<LinkedDocumentCreationResult>(await route.fetch(), 201);
      await route.abort('connectionreset');
    });
    await button(creator, '문서 만들기').click();
    const retry = button(creator, '저장 결과 다시 확인');
    await expect(retry).toBeEnabled();
    await expect(title).toBeDisabled();
    expect(firstResult?.document).toMatchObject({ title: documentTitle, projectId: null, parentId: parent.id, status: 'draft' });
    expect(firstResult?.link).toMatchObject({ issueId: issue.id, documentId: firstResult?.document.id });
    const keepChecking = nextConfirmation(page, false);
    await button(creator, '닫기').click();
    expect(await keepChecking).toMatch(/저장|결과/);
    await expect(retry).toBeEnabled();

    const retryResponse = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST');
    await retry.click();
    const restored = await json<LinkedDocumentCreationResult>(await retryResponse);
    expect(restored).toEqual(firstResult);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0].actor).toBe(actor.id);
    expect(JSON.parse(attempts[0].body ?? '{}')).toMatchObject({ expectedIssueProjectId: project.id, projectId: null, parentId: parent.id });
    await expect(creator).toHaveCount(0);
    const newDocument = button(linked, documentTitle);
    await expect(newDocument).toBeFocused();
    await expect(linked).toContainText('팀 공통');
    expect(page.url()).toBe(ticketLocation);
    await expect(field(ticket, '제목')).toHaveValue(draftTitle);
    await expect(field(ticket, '댓글 내용')).toHaveValue(draftComment);
    const snapshot = await workspace(request);
    expect(snapshot.documents.filter(value => value.title === documentTitle)).toEqual([restored.document]);
    expect(snapshot.resourceLinks.filter(value => value.documentId === restored.document.id)).toEqual([restored.link]);

    await button(linked, `${documentTitle} 미리보기`).click();
    const preview = page.getByRole('dialog', { name: '연결 문서 미리보기', exact: true });
    await expect(preview.getByRole('heading', { name: '검증 계획', exact: true })).toBeVisible();
    await button(preview, '문서 미리보기 닫기').click();
    await expect(field(ticket, '댓글 내용')).toHaveValue(draftComment);

    const openDocument = nextConfirmation(page, true);
    await newDocument.click();
    expect(await openDocument).toContain('버리');
    await expect(field(page, '문서 제목')).toHaveValue(documentTitle);
    await button(page, '정보 패널 열기').click();
    const documentPanel = page.getByRole('complementary', { name: '문서 상세 정보', exact: true });
    await button(documentPanel, '연결').click();
    const linkedIssue = documentPanel.getByRole('button', { name: new RegExp(issue.key) }).filter({ hasText: issue.title });
    await linkedIssue.click();
    await expect(ticket).toBeVisible();
  } finally {
    const snapshot = await workspace(request);
    for (const document of snapshot.documents.filter(value => value.title === documentTitle)) await purge(request, 'documents', document.id, actor.id);
    if (parent) await purge(request, 'documents', parent.id, actor.id);
    await purge(request, 'issues', issue.id, actor.id);
  }
});

test('티켓에서 변경된 프로젝트 팀 템플릿을 확인하고 저장 뒤 목록만 다시 불러온다', async ({ page, request }) => {
  type Template = import('../../shared/types').DocumentTemplateSummary;
  test.setTimeout(90_000);
  const { projects: [project], users: [actor, peer] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const documentTitle = `검증 문서 초안 ${suffix}`;
  const issue = await json<Issue>(await request.post('/api/issues', {
    headers, data: { projectId: project.id, title: `템플릿 검증 업무 ${suffix}` },
  }), 201);
  const sources: DocPage[] = [];
  let currentTemplate: Template | undefined;
  async function createSource(title: string, text: string) {
    const document = await json<DocPage>(await request.post('/api/documents', {
      headers, data: { title, projectId: project.id,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
    }), 201);
    sources.push(document);
    return document;
  }
  try {
    const source = await createSource(`원래 검증 양식 ${suffix}`, '검증 환경을 기록합니다.');
    const revisedBody = '재현 절차와 기대 결과를 기록합니다.';
    const replacement = await createSource(`최신 검증 양식 ${suffix}`, revisedBody);
    const template = await json<Template>(await request.post('/api/document-templates', {
      headers, data: { requestId: randomUUID(), name: `프로젝트 검증 양식 ${suffix}`,
        sourceDocumentId: source.id, expectedDocumentVersion: source.version },
    }), 201);
    currentTemplate = template;
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${project.id}/teamboard?${new URLSearchParams({ boardQuery: issue.title })}`);
    await button(page.getByRole('region', { name: '전체 프로젝트 보드', exact: true }), `${issue.key} 업무 열기`).click({ timeout: 35_000 });
    const ticketLocation = page.url();
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    const linked = ticket.getByRole('region', { name: '연결된 문서', exact: true });
    await button(linked, '새 연결 문서 만들기').click();
    const creator = page.getByRole('dialog', { name: '연결 문서 만들기', exact: true });
    const title = field(creator, '문서 제목');
    const submit = button(creator, '문서 만들기');
    await creator.getByRole('combobox', { name: '팀 템플릿', exact: true }).selectOption(template.id);
    await title.fill(documentTitle);
    const previewToggle = button(creator, '템플릿 미리보기');
    const preview = creator.getByRole('region', { name: '템플릿 저장본 미리보기', exact: true });
    await previewToggle.click();
    await expect(preview).toContainText(source.plainText);
    await button(creator, '템플릿 미리보기 닫기').press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(previewToggle).toBeFocused();
    await expect(title).toHaveValue(documentTitle);

    const latest = await json<Template>(await request.patch(`/api/document-templates/${template.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: template.version,
        sourceDocumentId: replacement.id, expectedDocumentVersion: replacement.version },
    }));
    currentTemplate = latest;
    const endpoint = `/api/issues/${issue.id}/documents`;
    const waitForPost = () => page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST');
    let postCount = 0;
    let failRefresh = false;
    let refreshFailures = 0;
    await page.route(`**${endpoint}`, async route => {
      postCount++;
      const response = await route.fetch();
      if (response.status() === 201) failRefresh = true;
      await route.fulfill({ response });
    });
    await page.route('**/api/workspace', async route => {
      if (!failRefresh) { await route.continue(); return; }
      failRefresh = false;
      refreshFailures++;
      await route.fulfill({ status: 503, json: { error: '합성 목록 조회 실패' } });
    });

    const rejectedResponse = waitForPost();
    await submit.click();
    const rejected = await rejectedResponse;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().postDataJSON()).toMatchObject({ templateId: template.id, expectedTemplateVersion: template.version });
    expect(await rejected.json()).toMatchObject({ details: { reason: 'template_version_conflict' } });
    await button(creator, '최신 템플릿 사용').click();
    await expect(title).toHaveValue(documentTitle);
    expect((await workspace(request)).documents.some(value => value.title === documentTitle)).toBe(false);
    await previewToggle.click();
    await expect(preview).toContainText(revisedBody);

    const savedResponse = waitForPost();
    await submit.click();
    const saved = await savedResponse;
    expect(saved.request().postDataJSON()).toMatchObject({ templateId: latest.id, expectedTemplateVersion: latest.version, title: documentTitle });
    const created = await json<LinkedDocumentCreationResult>(saved, 201);
    expect(created.document).toMatchObject({ projectId: project.id, title: documentTitle, plainText: revisedBody });
    const reload = button(creator, '문서 목록 다시 불러오기');
    await expect(reload).toBeEnabled();
    expect(refreshFailures).toBe(1);
    await reload.click();
    await expect(creator).toHaveCount(0);
    await expect(button(linked, documentTitle)).toBeFocused();
    expect(postCount).toBe(2);
    expect(page.url()).toBe(ticketLocation);
    const snapshot = await workspace(request);
    expect(snapshot.documents.filter(value => value.title === documentTitle)).toEqual([created.document]);
    expect(snapshot.resourceLinks.filter(value => value.documentId === created.document.id)).toEqual([created.link]);
  } finally {
    if (currentTemplate) await json<Template>(await request.patch(`/api/document-templates/${currentTemplate.id}`, {
      headers, data: { expectedVersion: currentTemplate.version, archived: true },
    }));
    for (const document of (await workspace(request)).documents.filter(value => value.title === documentTitle)) await purge(request, 'documents', document.id, actor.id);
    for (const document of sources) await purge(request, 'documents', document.id, actor.id);
    await purge(request, 'issues', issue.id, actor.id);
  }
});
