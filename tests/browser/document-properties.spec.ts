import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { CollaborationSession } from '../../shared/collaboration';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes';
import type { DocPage, DocumentPublicationView, RichContent, WorkspaceSnapshot } from '../../shared/types';

const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const properties = (group: string, value: string, hidden = false): RichContent => ({
  type: 'documentProperties', attrs: { group, hidden, entries: [{ name: '상태', value }] },
});
const title = (page: Page) => page.getByRole('textbox', { name: '문서 제목', exact: true });
const path = (document: DocPage) => `/#/${document.projectId ?? 'all'}/documents/${document.id}`;

async function read<T>(request: APIRequestContext, route: string) {
  const response = await request.get(route);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function save(page: Page, document: DocPage) {
  const saving = page.waitForResponse(response => new URL(response.url()).pathname === `/api/documents/${document.id}` &&
    response.request().method() === 'PATCH');
  await page.locator('.docs-save-button').click();
  const saved = await saving;
  expect(saved.status(), await saved.text()).toBe(200);
  expect(saved.request().postDataJSON().contentSchemaVersion).toBe(DOCUMENT_CONTENT_SCHEMA_VERSION);
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  return saved.json() as Promise<DocPage>;
}

async function fixture(request: APIRequestContext) {
  const workspace = await read<WorkspaceSnapshot>(request, '/api/workspace');
  const suffix = randomUUID().slice(0, 8);
  const headers = { 'X-Actor-Id': workspace.users[0].id };
  const created: string[] = [];

  async function create(name: string, projectId: string | null, content: RichContent, selectedLabels: string[] = []) {
    const response = await request.post('/api/documents', { headers, data: { title: `${name} ${suffix}`, projectId, labels: selectedLabels, content } });
    expect(response.status(), await response.text()).toBe(201);
    const document = await response.json() as DocPage;
    created.push(document.id);
    return document;
  }
  async function close() {
    for (const id of created.reverse()) {
      const removed = await request.delete(`/api/documents/${id}`, { headers });
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
  }
  return { workspace, headers, suffix, create, close };
}

test('360px에서 문서 속성과 보고서를 작성하고 최신 집계와 고정 검토본을 확인한다', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { workspace, headers, suffix, create, close } = await fixture(request);
  const [project, otherProject] = workspace.projects;
  const reviewer = workspace.users[1];
  const group = '배포 결정';
  const labels = [`보고 ${suffix}`, `결정 ${suffix}`];

  try {
    const source = await create('가 배포 승인', project.id, body(paragraph('승인 근거를 기록합니다.')), labels);
    const host = await create('나 배포 회의 보고서', project.id, body(paragraph('배포 결정을 확인합니다.')));
    const partial = await create('다 한 가지 라벨', project.id, body(properties(group, '보고서 밖의 라벨')), [labels[0]]);
    const other = await create('라 다른 프로젝트', otherProject.id, body(properties(group, '보고서 밖의 공간')), labels);
    const common = await create('마 팀 공통', null, body(properties(group, '보고서 밖의 공통 문서')), labels);
    const otherGroup = await create('바 다른 그룹', project.id, body(properties('다른 그룹', '보고서 밖의 그룹')), labels);
    const reader = await create('사 원본 포함 문서', project.id, body({
      type: 'documentInclude', attrs: { documentId: source.id, label: source.title },
    }));

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(path(source));
    await expect(title(page)).toHaveValue(source.title, { timeout: 30_000 });
    const editor = page.locator('.docs-prose[contenteditable=true]');
    await editor.getByText('승인 근거를 기록합니다.', { exact: true }).click();
    await page.getByRole('button', { name: '문서 속성 삽입', exact: true }).click();
    const definition = editor.getByRole('region', { name: '문서 속성', exact: true });
    await definition.getByRole('button', { name: '문서 속성 설정', exact: true }).click();
    const definitionForm = definition.getByRole('form', { name: '문서 속성 설정', exact: true });
    await definitionForm.getByLabel('속성 그룹', { exact: true }).fill(group);
    await definitionForm.getByLabel('원본에서 숨기기', { exact: true }).check();
    if (!await definitionForm.getByLabel('속성 이름 1', { exact: true }).count()) {
      await definitionForm.getByRole('button', { name: '속성 추가', exact: true }).click();
    }
    await definitionForm.getByLabel('속성 이름 1', { exact: true }).fill('상태');
    await definitionForm.getByRole('textbox', { name: '속성 값 1', exact: true }).fill('팀 검토 대기');
    await definitionForm.getByRole('button', { name: '속성 추가', exact: true }).click();
    await definitionForm.getByLabel('속성 이름 2', { exact: true }).fill('결정 이유');
    await definitionForm.getByRole('textbox', { name: '속성 값 2', exact: true }).fill('실제 시험 필요');
    await definitionForm.getByRole('button', { name: '문서 속성 적용', exact: true }).click();
    const savedSource = await save(page, source);
    expect(savedSource.content.content?.find(node => node.type === 'documentProperties')?.attrs).toEqual({
      group, hidden: true, entries: [{ name: '상태', value: '팀 검토 대기' }, { name: '결정 이유', value: '실제 시험 필요' }],
    });

    await page.goto(path(reader));
    await expect(title(page)).toHaveValue(reader.title);
    const include = page.getByRole('region', { name: `포함된 문서 ${source.title}`, exact: true });
    await expect(include.getByText('승인 근거를 기록합니다.', { exact: true })).toBeVisible();
    await expect(include.getByText('팀 검토 대기', { exact: true })).toHaveCount(0);

    await page.goto(path(host));
    await expect(title(page)).toHaveValue(host.title);
    await editor.getByText('배포 결정을 확인합니다.', { exact: true }).click();
    await page.getByRole('button', { name: '문서 속성 보고서 삽입', exact: true }).click();
    const report = editor.getByRole('region', { name: '문서 속성 보고서', exact: true });
    const reportSettings = report.getByRole('button', { name: '문서 속성 보고서 설정', exact: true });
    await reportSettings.click();
    const reportForm = report.getByRole('form', { name: '문서 속성 보고서 설정', exact: true });
    await expect(reportForm.getByRole('combobox', { name: '문서 공간', exact: true })).toHaveValue(project.id);
    const bounds = await reportForm.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);
    await reportForm.getByLabel('속성 그룹', { exact: true }).fill(group);
    await reportForm.getByLabel('문서 라벨', { exact: true }).fill(labels.join('\n'));
    await reportForm.getByRole('combobox', { name: '라벨 일치 방식', exact: true }).selectOption('all');
    await reportForm.getByLabel('표시 열', { exact: true }).fill('결정 이유\n상태');
    await reportForm.getByLabel('보고서 제목', { exact: true }).fill('운영 배포 보고서');
    await reportForm.getByRole('combobox', { name: '정렬', exact: true }).selectOption('title');
    await reportForm.getByLabel('내림차순', { exact: true }).uncheck();
    await reportForm.getByLabel('최대 행 수', { exact: true }).fill('7');
    await reportForm.getByRole('button', { name: '보고서 설정 적용', exact: true }).click();
    const grid = report.getByRole('table', { name: '운영 배포 보고서', exact: true });
    const sourceLink = (document: DocPage) => grid.getByRole('link', { name: `원본 문서 열기 ${document.title}`, exact: true });
    await expect(sourceLink(source)).toBeVisible();
    await expect(grid.getByRole('columnheader').nth(1)).toHaveText('결정 이유');
    await expect(grid.getByRole('columnheader').nth(2)).toHaveText('상태');
    await expect(grid.getByRole('cell', { name: '실제 시험 필요', exact: true })).toBeVisible();
    await expect(grid.getByRole('cell', { name: '팀 검토 대기', exact: true })).toBeVisible();
    for (const outside of [partial, other, common, otherGroup]) await expect(sourceLink(outside)).toHaveCount(0);

    const savedHost = await save(page, host);
    expect(savedHost.content.content?.find(node => node.type === 'documentPropertyReport')?.attrs).toEqual({
      group, projectId: project.id, labels: labels.toSorted(), match: 'all', columns: ['결정 이유', '상태'],
      sort: 'title', descending: false, limit: 7, title: '운영 배포 보고서',
    });
    const reviewPath = `/api/documents/${host.id}/publication`;
    const currentReview = await read<DocumentPublicationView>(request, reviewPath);
    const requested = await request.post(reviewPath, { headers, data: {
      action: 'request', expectedVersion: currentReview.version, workspaceGeneration: currentReview.workspaceGeneration,
      expectedDocumentVersion: savedHost.version, reviewerId: reviewer.id,
    } });
    expect(requested.status(), await requested.text()).toBe(200);

    const rewritten = await request.patch(`/api/documents/${source.id}`, { headers, data: {
      expectedVersion: savedSource.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
      content: body(paragraph('승인 근거를 기록합니다.'), properties(group, '팀 검토 완료', true)),
    } });
    expect(rewritten.status(), await rewritten.text()).toBe(200);
    await page.getByRole('button', { name: '참조 새로고침', exact: true }).click();
    await expect(grid.getByRole('cell', { name: '팀 검토 완료', exact: true })).toBeVisible();
    await expect(grid.getByRole('cell', { name: '팀 검토 대기', exact: true })).toHaveCount(0);
    const later = await read<WorkspaceSnapshot>(request, '/api/workspace');
    expect(later.documents.find(document => document.id === host.id)?.version).toBe(savedHost.version);
    await page.reload();
    await expect(grid.getByRole('cell', { name: '팀 검토 완료', exact: true })).toBeVisible();
    await sourceLink(source).click();
    await expect(title(page)).toHaveValue(source.title);

    await page.goto(path(host));
    await expect(title(page)).toHaveValue(host.title);
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(reviewer.id);
    await page.getByRole('button', { name: '검토·발행', exact: true }).click();
    const reviewing = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    await reviewing.getByRole('button', { name: '검토본 불러오기', exact: true }).click();
    const frozen = reviewing.getByRole('region', { name: '검토 고정본 내용', exact: true });
    await expect(frozen.getByText(/운영 배포 보고서/u)).toBeVisible();
    await expect(frozen.getByRole('table')).toHaveCount(0);
    await expect(frozen.getByText('팀 검토 완료', { exact: true })).toHaveCount(0);
    await expect(frozen.getByText('팀 검토 대기', { exact: true })).toHaveCount(0);
  } finally {
    await close();
  }
});

test('360px에서 라벨이 붙은 여러 프로젝트 문서의 속성을 모아 원본으로 이동하고 고정 검토본에는 범위를 남긴다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const { workspace, headers, suffix, create, close } = await fixture(request);
  const [home, remote] = workspace.projects;
  const reviewer = workspace.users[1];
  const group = '프로젝트 합동 검토';
  const labels = [`릴리스 ${suffix}`, `운영 ${suffix}`];
  await page.setViewportSize({ width: 360, height: 820 });

  try {
    const homeNote = await create('공동 점검', home.id, body(properties(group, '현장 승인')), labels);
    const remoteNote = await create('공동 점검', remote.id, body(properties(group, '기술 승인', true)), labels);
    const common = await create('팀 공통 점검', null, body(properties(group, '운영 승인')), labels);
    const partial = await create('라벨 하나만 일치', remote.id, body(properties(group, '집계하면 안 되는 값')), [labels[0]]);
    const wrongGroup = await create('다른 속성 그룹', home.id, body(properties('별도 그룹', '집계하면 안 되는 그룹')), labels);
    const host = await create('합동 검토 보고서', home.id, body(paragraph('다른 프로젝트의 승인 근거를 함께 확인합니다.')));

    await page.goto(path(host));
    await expect(title(page)).toHaveValue(host.title, { timeout: 30_000 });
    const editor = page.locator('.docs-prose[contenteditable=true]');
    await editor.getByText('다른 프로젝트의 승인 근거를 함께 확인합니다.', { exact: true }).click();
    await page.getByRole('button', { name: '문서 속성 보고서 삽입', exact: true }).click();
    const report = editor.getByRole('region', { name: '문서 속성 보고서', exact: true });
    const settings = report.getByRole('button', { name: '문서 속성 보고서 설정', exact: true });
    const form = report.getByRole('form', { name: '문서 속성 보고서 설정', exact: true });
    const submit = form.getByRole('button', { name: '보고서 설정 적용', exact: true });
    const space = form.getByRole('combobox', { name: '문서 공간', exact: true });
    const selectedSpaces = form.getByRole('group', { name: '집계할 문서 공간', exact: true });
    const choice = (name: string) => selectedSpaces.getByRole('checkbox', { name, exact: true });
    await settings.click();
    await expect(space).toHaveValue(home.id);
    await expect(selectedSpaces).toHaveCount(0);
    await space.selectOption({ label: '여러 문서 공간' });
    await expect(choice(home.name)).toBeChecked();
    await expect(choice('팀 공통 문서')).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await choice(remote.name).check();
    await expect(submit).toBeEnabled();
    await form.getByLabel('보고서 제목', { exact: true }).fill('프로젝트 합동 승인 현황');
    await form.getByLabel('속성 그룹', { exact: true }).fill(group);
    await form.getByLabel('문서 라벨', { exact: true }).fill(labels.join('\n'));
    await form.getByLabel('표시 열', { exact: true }).fill('상태');
    const bounds = await selectedSpaces.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await submit.click();

    const grid = report.getByRole('table', { name: '프로젝트 합동 승인 현황', exact: true });
    const link = (document: DocPage) => grid.getByRole('link', { name: `원본 문서 열기 ${document.title}`, exact: true });
    const homeRow = grid.getByRole('row').filter({ has: page.getByRole('cell', { name: '현장 승인', exact: true }) });
    const remoteRow = grid.getByRole('row').filter({ has: page.getByRole('cell', { name: '기술 승인', exact: true }) });
    await expect(homeRow.getByRole('rowheader')).toContainText(home.name);
    await expect(remoteRow.getByRole('rowheader')).toContainText(remote.name);
    await expect(link(homeNote)).toHaveCount(2);
    for (const outside of [common, partial, wrongGroup]) await expect(link(outside)).toHaveCount(0);
    const saved = await save(page, host);
    expect(saved.content.content?.find(node => node.type === 'documentPropertyReport')?.attrs).toMatchObject({
      projectId: null, projectIds: [home.id, remote.id], group, labels: labels.toSorted(), columns: ['상태'],
    });

    await page.reload();
    await expect(remoteRow).toBeVisible();
    const remoteLink = remoteRow.getByRole('link', { name: `원본 문서 열기 ${remoteNote.title}`, exact: true });
    await expect(remoteLink).toHaveAttribute('href', `#/${remote.id}/documents/${remoteNote.id}`);
    await expect(remoteLink).toHaveAccessibleDescription(remote.name);
    await remoteLink.click();
    await expect(page).toHaveURL(url => url.hash === `#/${remote.id}/documents/${remoteNote.id}`);
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === `#/${home.id}/documents/${host.id}`);
    await expect(remoteRow).toBeVisible();

    await settings.click();
    await expect(space.locator('option:checked')).toHaveText('여러 문서 공간');
    await expect(choice(home.name)).toBeChecked();
    await expect(choice(remote.name)).toBeChecked();
    await space.selectOption(remote.id);
    await expect(selectedSpaces).toHaveCount(0);
    await submit.click();
    await expect(remoteRow).toBeVisible();
    await expect(homeRow).toHaveCount(0);

    await settings.click();
    await space.selectOption({ label: '여러 문서 공간' });
    await expect(choice(remote.name)).toBeChecked();
    await choice(home.name).check();
    await choice('팀 공통 문서').check();
    await submit.click();
    const commonRow = grid.getByRole('row').filter({ has: page.getByRole('link', { name: `원본 문서 열기 ${common.title}`, exact: true }) });
    await expect(commonRow.getByRole('rowheader')).toContainText('팀 공통 문서');
    const withCommon = await save(page, host);
    expect(withCommon.content.content?.find(node => node.type === 'documentPropertyReport')?.attrs?.projectIds).toEqual([remote.id, home.id, null]);
    const publication = `/api/documents/${host.id}/publication`;
    const state = await read<DocumentPublicationView>(request, publication);
    const requested = await request.post(publication, { headers, data: {
      action: 'request', expectedVersion: state.version, workspaceGeneration: state.workspaceGeneration,
      expectedDocumentVersion: withCommon.version, reviewerId: reviewer.id,
    } });
    expect(requested.status(), await requested.text()).toBe(200);
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(reviewer.id);
    await page.getByRole('button', { name: '검토·발행', exact: true }).click();
    const reviewing = page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
    await reviewing.getByRole('button', { name: '검토본 불러오기', exact: true }).click();
    const frozen = reviewing.getByRole('region', { name: '검토 고정본 내용', exact: true });
    await expect(frozen).toContainText('문서 공간 3곳');
    await expect(frozen).toContainText(home.id);
    await expect(frozen).toContainText(remote.id);
    await expect(frozen).toContainText('팀 공통');
    await expect(frozen.getByRole('table')).toHaveCount(0);
    await expect(frozen).not.toContainText('기술 승인');
  } finally {
    await close();
  }
});

test('공동 편집에서 속성 값과 추가한 항목을 동기화하고 다시 연다', async ({ page, browser, baseURL, request }) => {
  test.setTimeout(90_000);
  const { workspace, headers, create, close } = await fixture(request);
  const [author, collaborator] = workspace.users;
  const context = await browser.newContext({ baseURL });
  try {
    const source = await create('배포 속성 동시 편집', workspace.projects[0].id, body(
      paragraph('협업에서 확인한 값'), properties('배포', '검토 요청'),
    ));
    const sessionPath = `/api/documents/${source.id}/collaboration`;
    const enabled = await request.post(`${sessionPath}/enable`, { headers, data: { expectedVersion: source.version } });
    expect(enabled.status(), await enabled.text()).toBe(200);
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), author.id);
    await context.addInitScript(id => localStorage.setItem('donefac.actor', id), collaborator.id);
    const peer = await context.newPage();
    await Promise.all([page.goto(path(source)), peer.goto(path(source))]);
    await expect(page.locator('.docs-collaboration-presence')).toContainText('2명 접속', { timeout: 30_000 });
    const definition = (current: Page) => current.locator('.docs-live-prose').getByRole('region', { name: '문서 속성', exact: true });
    await expect(definition(peer).getByText('검토 요청', { exact: true })).toBeVisible();
    await definition(page).getByRole('button', { name: '문서 속성 설정', exact: true }).click();
    const form = definition(page).getByRole('form', { name: '문서 속성 설정', exact: true });
    const value = form.getByRole('textbox', { name: '속성 값 1', exact: true });
    await value.fill('작성 중인 검토 초안');
    await definition(peer).getByRole('button', { name: '문서 속성 설정', exact: true }).click();
    const peerForm = definition(peer).getByRole('form', { name: '문서 속성 설정', exact: true });
    await peerForm.getByRole('textbox', { name: '속성 값 1', exact: true }).fill('동료 검토 반영');
    await peerForm.getByRole('button', { name: '문서 속성 적용', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('입력한 값은 유지됩니다.');
    await expect(value).toHaveValue('작성 중인 검토 초안');
    await expect(form.getByRole('button', { name: '문서 속성 적용', exact: true })).toBeDisabled();
    page.once('dialog', confirmation => confirmation.accept());
    await form.getByRole('button', { name: '최신 설정 불러오기', exact: true }).click();
    await expect(value).toHaveValue('동료 검토 반영');
    await value.fill('검토 완료');
    await form.getByRole('button', { name: '속성 추가', exact: true }).click();
    await form.getByLabel('속성 이름 2', { exact: true }).fill('결정 이유');
    await form.getByRole('textbox', { name: '속성 값 2', exact: true }).fill('조건 A 충족');
    await form.getByRole('button', { name: '문서 속성 적용', exact: true }).click();
    await expect(definition(peer).getByText('검토 완료', { exact: true })).toBeVisible();
    await expect(definition(peer).getByText('조건 A 충족', { exact: true })).toBeVisible();
    const saved = await read<CollaborationSession>(request, sessionPath);
    expect(saved.document.version).toBeGreaterThan(source.version);
    expect(saved.document.content.content?.find(node => node.type === 'documentProperties')?.attrs).toEqual({
      group: '배포', hidden: false, entries: [{ name: '상태', value: '검토 완료' }, { name: '결정 이유', value: '조건 A 충족' }],
    });
    await peer.reload();
    await expect(definition(peer).getByText('조건 A 충족', { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await close();
  }
});
