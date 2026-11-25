import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes';
import { documentSectionHash } from '../../shared/document-sections';
import type { DocPage, DocumentPublicationList, DocumentPublicationView, WorkspaceSnapshot } from '../../shared/types';

async function publicationFixture(request: APIRequestContext) {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, reviewer] = workspace.users;
  const created: DocPage[] = [];
  async function create(title: string, text: string, projectId: string | null, section?: {id: string; title: string}) {
    const response = await request.post('/api/documents', {
      headers: { 'X-Actor-Id': author.id }, data: { projectId, title, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: {
        type: 'doc', content: [
          ...(section ? [{ type: 'heading', attrs: { level: 2, sectionId: section.id }, content: [{ type: 'text', text: section.title }] }] : []),
          { type: 'paragraph', content: [{ type: 'text', text }] },
        ],
      } },
    });
    expect(response.status(), await response.text()).toBe(201);
    const document = await response.json() as DocPage;
    created.push(document);
    return document;
  }
  const publicationPath = (document: DocPage) => `/api/documents/${document.id}/publication`;
  async function state(document: DocPage) {
    const response = await request.get(publicationPath(document));
    expect(response.ok(), await response.text()).toBeTruthy();
    return await response.json() as DocumentPublicationView;
  }
  async function transition(document: DocPage, current: DocumentPublicationView, actorId: string, action: 'request' | 'publish') {
    const response = await request.post(publicationPath(document), {
      headers: { 'X-Actor-Id': actorId }, data: {
        action, expectedVersion: current.version, workspaceGeneration: current.workspaceGeneration,
        ...(action === 'request' ? { reviewerId: reviewer.id, expectedDocumentVersion: current.documentVersion } : {}),
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    return await response.json() as DocumentPublicationView;
  }
  async function publish(document: DocPage) {
    const submitted = await transition(document, await state(document), author.id, 'request');
    return transition(document, submitted, reviewer.id, 'publish');
  }
  return { workspace, author, reviewer, create, state, transition, publish, async clear() {
    for (const document of created.reverse()) await request.delete(`/api/documents/${document.id}`);
  } };
}

test('검토함에서 버전을 열고 새 발행 뒤에도 처음 발행한 본문과 절 주소를 유지한다', async ({ page, context, request }) => {
  const { workspace, author, reviewer, create, state, transition, publish, clear } = await publicationFixture(request);
  const project = workspace.projects[0];
  const key = randomUUID().slice(0, 8);

  try {
    const previousSection = { id: `published-${randomUUID()}`, title: '첫 발행의 절' };
    const published = await create(`발행 검색 ${key}`, '팀에 발행한 초기 안내', project.id, previousSection);
    const common = await create(`공통 발행 ${key}`, '팀 공통 발행 안내', null);
    const firstRelease = await publish(published);
    await publish(common);
    const draftTitle = `검토 전 새 편집 ${key}`;
    const changed = await request.patch(`/api/documents/${published.id}`, {
      data: { expectedVersion: published.version, title: draftTitle, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '두 번째 발행의 안내' }] },
      ] } },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/overview`);
    const actor = page.getByLabel('작업자 선택', { exact: true });
    await expect(actor).toBeVisible();
    // The first workspace snapshot predates this document. The row still opens
    // through the normal route after it refreshes the workspace on demand.
    const assigned = await create(`맡은 검토 ${key}`, '검토 당시 안내 문구', project.id);
    const assignedState = await transition(assigned, await state(assigned), author.id, 'request');
    const inbox = page.getByRole('button', { name: '검토함·발행본', exact: true });
    await actor.selectOption(reviewer.id);
    await expect(inbox).toHaveAttribute('aria-description', '배정된 검토 1개');
    await inbox.click();
    const library = page.getByRole('region', { name: '문서 검토·발행 목록' });
    const assignedTab = library.getByRole('tab', { name: '내 검토', exact: true });
    await expect(assignedTab).toHaveAttribute('aria-selected', 'true');
    const bounds = await library.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const assignedRow = library.getByRole('button', { name: `${assigned.title} 검토본 열기`, exact: true });
    await assignedRow.click();
    await expect(page).toHaveURL(new RegExp(`/documents/${assigned.id}\\?publication=review&revision=${assignedState.reviewRevision!.id}$`));
    const dialog = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    const review = dialog.getByRole('region', { name: '검토 고정본 내용' });
    await expect(review).toContainText('검토 당시 안내 문구');
    await dialog.getByLabel('검토 결과 메모', { exact: true }).fill('검토 절차 설명을 보완해 주세요.');
    await dialog.getByRole('button', { name: '수정 요청 보내기', exact: true }).click();
    const reviewState = dialog.getByRole('region', { name: '현재 검토 요청', exact: true });
    await expect(reviewState.getByRole('heading', { name: '수정 요청됨', exact: true })).toBeVisible();
    await expect(reviewState.getByText('검토 절차 설명을 보완해 주세요.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`/documents/${assigned.id}$`));
    await expect(inbox).toHaveAttribute('aria-description', '배정된 검토 0개');
    await page.goBack();
    await expect(assignedTab).toHaveAttribute('aria-selected', 'true');
    await expect(assignedRow).toHaveCount(0);
    await actor.selectOption(author.id);
    const requestedTab = library.getByRole('tab', { name: '내 요청', exact: true });
    await requestedTab.click();
    await expect(page).toHaveURL(/\/publication\/requested$/);
    await expect(library.getByText('수정 요청', { exact: true })).toBeVisible();
    await expect(assignedRow).toBeVisible();

    const publishedTab = library.getByRole('tab', { name: '발행본', exact: true });
    await publishedTab.click();
    const scope = library.getByLabel('검토·발행 조회 범위', { exact: true });
    await expect(scope).toHaveValue('project');
    const publishedRow = library.getByRole('button', { name: `${published.title} 발행본 열기`, exact: true });
    const commonRow = library.getByRole('button', { name: `${common.title} 발행본 열기`, exact: true });
    await expect(publishedRow).toBeVisible();
    await expect(commonRow).toHaveCount(0);
    await scope.selectOption('common');
    await expect(commonRow).toBeVisible();
    await expect(publishedRow).toHaveCount(0);
    await scope.selectOption('project');
    const search = library.getByLabel('검토·발행 문서 검색', { exact: true });
    await search.fill(published.title);
    await library.getByRole('button', { name: '검토·발행 검색 실행', exact: true }).click();
    await expect(publishedRow).toBeVisible();
    await publishedRow.click();
    await expect(page).toHaveURL(new RegExp(`\\?publication=published&revision=${firstRelease.publishedRevision!.id}$`));
    const savedLink = page.url();
    const frozenPublication = dialog.getByRole('region', { name: '발행 고정본 내용' });
    await expect(frozenPublication).toContainText(published.title);
    await expect(frozenPublication).toContainText('팀에 발행한 초기 안내');
    await expect(frozenPublication).not.toContainText(draftTitle);
    await page.reload();
    await expect(frozenPublication).toContainText(published.title);

    const secondRelease = await publish(published);
    await page.goto(savedLink);
    await page.reload();
    await expect(frozenPublication).toContainText('이전 발행 당시 저장본');
    await expect(frozenPublication).toContainText('팀에 발행한 초기 안내');
    await expect(frozenPublication).not.toContainText('두 번째 발행의 안내');
    await frozenPublication.getByText('문서 목차', { exact: true }).click();
    const exactSectionHash = documentSectionHash(published.id, previousSection.id, project.id, {
      kind: 'published', revisionId: firstRelease.publishedRevision!.id,
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await frozenPublication.getByRole('button', { name: `절 링크 복사 ${previousSection.title}`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(exactSectionHash, page.url()).href);
    await page.goto(`/${exactSectionHash}`);
    await page.reload();
    await expect(frozenPublication.getByRole('heading', { name: previousSection.title, exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: '발행본 불러오기', exact: true }).click();
    await expect(frozenPublication).toContainText(secondRelease.publishedRevision!.title);
    await expect(frozenPublication).toContainText('두 번째 발행의 안내');
    await expect(frozenPublication.getByRole('heading', { name: previousSection.title, exact: true })).toHaveCount(0);
  } finally {
    await clear();
  }
});

test('360px 검토함에서 프로젝트와 검색 페이지를 주소로 복원하고 뒤로 갈 때 같은 저장본에 초점을 준다', async ({ page, request }) => {
  test.setTimeout(105_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { workspace, author, reviewer, create, state, transition, clear } = await publicationFixture(request);
  const [contextProject, scopedProject] = workspace.projects;
  const query = `검토 돌아오기 ${randomUUID().slice(0, 8)}`;
  const title = `${query} 공통 제목`;
  const library = page.getByRole('region', { name: '문서 검토·발행 목록', exact: true });
  const scope = library.getByLabel('검토·발행 조회 범위', { exact: true });
  const project = library.getByLabel('검토·발행 프로젝트', { exact: true });
  const search = library.getByRole('searchbox', { name: '검토·발행 문서 검색', exact: true });
  const pagination = library.getByRole('navigation', { name: '검토·발행 목록 페이지', exact: true });
  const next = pagination.getByRole('button', { name: '검토·발행 다음 페이지', exact: true });
  const reviewRows = library.getByRole('button', { name: `${title} 검토본 열기`, exact: true });
  const publishedRows = library.getByRole('button', { name: `${title} 발행본 열기`, exact: true });
  const actor = page.getByLabel('작업자 선택', { exact: true });
  const dialog = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });

  async function submitFilters() {
    await scope.selectOption('project');
    await project.selectOption(scopedProject.id);
    await search.fill(query);
    await search.press('Enter');
  }

  async function expectQueue(tab: 'assigned' | 'published', offset: number) {
    await expect(page).toHaveURL(url => {
      const [path, raw] = url.hash.split('?');
      const parameters = new URLSearchParams(raw);
      return path === `#/${contextProject.id}/publication/${tab}` && parameters.get('scope') === (tab === 'assigned' ? 'project' : null) &&
        parameters.get('projectId') === scopedProject.id && parameters.get('q') === query &&
        parameters.get('offset') === (offset ? String(offset) : null);
    });
    await expect(scope).toHaveValue('project');
    await expect(project).toHaveValue(scopedProject.id);
    await expect(search).toHaveValue(query);
  }

  async function listAt(tab: 'assigned' | 'published', offset: number) {
    const params = new URLSearchParams({ tab, scope: 'project', projectId: scopedProject.id, q: query, offset: String(offset) });
    const response = await request.get(`/api/document-publications?${params}`, { headers: { 'X-Actor-Id': reviewer.id } });
    expect(response.status(), await response.text()).toBe(200);
    return await response.json() as DocumentPublicationList;
  }

  try {
    const documents = new Map<string, DocPage>();
    for (let index = 1; index <= 32; index++) {
      const document = await create(title, `${query} 저장본 ${index}`, scopedProject.id);
      await transition(document, await state(document), author.id, 'request');
      documents.set(document.id, document);
    }
    for (const projectId of [contextProject.id, null]) {
      const decoy = await create(title, `${query} 다른 공간의 저장본`, projectId);
      await transition(decoy, await state(decoy), author.id, 'request');
    }

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), reviewer.id);
    await page.goto(`/#/${contextProject.id}/publication/assigned`);
    await expect(library.getByRole('tab', { name: '내 검토', exact: true })).toHaveAttribute('aria-selected', 'true');
    await submitFilters();
    await expectQueue('assigned', 0);
    await expect(pagination).toContainText('1–30 / 32');
    await next.click();
    await expectQueue('assigned', 30);
    await expect(pagination).toContainText('31–32 / 32');
    const queueUrl = page.url();
    const secondPage = await listAt('assigned', 30);
    expect(secondPage).toMatchObject({ offset: 30, total: 32, projectId: scopedProject.id });
    expect(secondPage.items).toHaveLength(2);
    const [otherItem, selected] = secondPage.items;
    const row = reviewRows.nth(1);

    await page.reload();
    await expect(page).toHaveURL(queueUrl);
    await expectQueue('assigned', 30);
    await expect(pagination).toContainText('31–32 / 32');
    await expect(reviewRows).toHaveCount(2);
    await row.click();
    const exactReview = new RegExp(`/documents/${selected.documentId}\\?publication=review&revision=${selected.revision.id}$`);
    await expect(page).toHaveURL(exactReview);
    await expect(dialog.getByRole('region', { name: '검토 고정본 내용', exact: true })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(exactReview);
    await expect(dialog.getByRole('region', { name: '검토 고정본 내용', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(queueUrl);
    await expectQueue('assigned', 30);
    await expect(row).toBeFocused();
    await expect(reviewRows.first()).not.toBeFocused();

    await row.press('Enter');
    await expect(page).toHaveURL(exactReview);
    for (const item of [selected, otherItem]) {
      const document = documents.get(item.documentId)!;
      const released = await transition(document, await state(document), reviewer.id, 'publish');
      expect(released.publishedRevision?.id).toBe(item.revision.id);
    }
    expect((await listAt('assigned', 30)).total).toBe(30);
    await page.goBack();
    await expectQueue('assigned', 0);
    await expect(pagination).toContainText('1–30 / 30');
    await expect(library.getByRole('heading', { name: '내 검토', exact: true })).toBeFocused();
    await expect(next).toBeDisabled();

    await library.getByRole('tab', { name: '발행본', exact: true }).click();
    await submitFilters();
    await expectQueue('published', 0);
    const releases = await listAt('published', 0);
    expect(releases.items).toHaveLength(2);
    const [published] = releases.items;
    async function openPublishedDocument() {
      await publishedRows.first().click();
      await expect(page).toHaveURL(new RegExp(`/documents/${published.documentId}\\?publication=published&revision=${published.revision.id}$`));
      await expect(dialog.getByRole('region', { name: '발행 고정본 내용', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    await openPublishedDocument();
    await page.goBack();
    await expectQueue('published', 0);
    await expect(publishedRows.first()).toBeFocused();
    await openPublishedDocument();
    await actor.selectOption(author.id);
    await expect(actor).toHaveValue(author.id);
    await page.goBack();
    await expectQueue('published', 0);
    await expect(publishedRows).toHaveCount(2);
    const focusInQueue = await publishedRows.evaluateAll(rows => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(rows.some(row => row === document.activeElement))));
    }));
    expect(focusInQueue).toBe(false);
  } finally {
    await clear();
  }
});
