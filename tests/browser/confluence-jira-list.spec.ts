import { randomUUID } from 'node:crypto';
import { expect, test as base, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type {
  DocPage, DocRevision, Issue, JiraSavedViewPreview, LegacyPackageSummary, MigrationApplyResult,
  MigrationOptions, MigrationPreview, SavedView, User, WorkspaceSnapshot,
} from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const beforeList = '공유할 운영 절차입니다.';
const afterList = '업무 표 다음의 회의 기록입니다.';
const archivedUrl = 'https://legacy-jira.example.test/sr/jira.issueviews:searchrequest-xml/123/SearchRequest-123.xml';

async function read<T>(response: Pick<APIResponse, 'status' | 'text'>, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

function wikiExport(key: string, title: string, jql: string) {
  const property = (name: string, value: string) => `<property name="${name}"><![CDATA[${value}]]></property>`;
  const reference = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`;
  const entity = (type: string, id: string, body: string) => `<object class="${type}"><id name="id">${id}</id>${body}</object>`;
  const storage = `<h2>${beforeList}</h2><p><ac:structured-macro ac:name="Jira" ac:schema-version="1">
    <ac:parameter ac:name="jqlQuery">${jql}</ac:parameter>
    <ac:parameter ac:name="columns">key,summary,status,assignee</ac:parameter>
    <ac:parameter ac:name="maximumIssues">20</ac:parameter>
    <ac:parameter ac:name="server">Original Jira</ac:parameter>
    <ac:parameter ac:name="serverId">b9e46485-e571-4e1a-ba01-f721220f8963</ac:parameter>
  </ac:structured-macro></p><p>${afterList}</p><ac:structured-macro ac:name="jiraissues">
    <ac:parameter ac:name="url">${archivedUrl}</ac:parameter></ac:structured-macro>`;
  const xml = '<hibernate-generic>' + entity('Space', '42', property('key', key) + property('name', title)) +
    entity('Page', '100', property('title', title) + property('version', '1') + reference('space', 'Space', '42') +
      property('creationDate', '2020-01-02 03:04:05.000') + property('lastModificationDate', '2020-01-03 03:04:05.000')) +
    entity('BodyContent', '200', property('body', storage) + reference('content', 'Page', '100') + property('bodyType', '2')) +
    '</hibernate-generic>';
  return zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]);
}

function jiraExport(key: string, suffix: string, login: string) {
  return Buffer.from([
    'Issue id,Issue key,Project id,Project key,Project name,Summary,Created,Updated,Status,Issue Type,Assignee',
    ...[['1', 'Open', `배포 예정 ${suffix}`], ['2', 'Closed', `이미 배포함 ${suffix}`]].map(([id, status, title]) =>
      [id, `${key}-${id}`, '20800', key, 'Original Jira project', title,
        '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', status, 'Task', login].join(',')),
  ].join('\r\n'));
}

async function stage(request: APIRequestContext, bytes: Buffer, filename: string, product: string, instanceKey: string) {
  const query = new URLSearchParams({ filename, product, instanceKey });
  return read<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: bytes,
  }), 201);
}

async function apply(request: APIRequestContext, source: LegacyPackageSummary, key: string, name: string,
  member?: { login: string; id: string }) {
  const { defaultConfiguration, identities } = await read<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${source.id}`));
  const users = { ...defaultConfiguration.users };
  if (member) {
    const identity = identities.find(item => item.sourceValue === member.login);
    if (!identity) throw new Error('The Jira archive did not preserve the fixture assignee.');
    users[identity.id] = member.id;
  }
  const configuration = {
    ...defaultConfiguration, users,
    projects: defaultConfiguration.projects.map(mapping => ({ ...mapping, key, name })),
  };
  const plan = await read<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
  expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
  const result = await read<MigrationApplyResult>(await request.post(`/api/migrations/previews/${plan.id}/apply`, {
    data: { expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements },
  }), 201);
  expect(result.import.projectIds).toHaveLength(1);
  return result.import.projectIds[0];
}

const workspace = async (request: APIRequestContext) => read<WorkspaceSnapshot>(await request.get('/api/workspace'));
const currentDoc = (request: APIRequestContext, id: string) => workspace(request).then(snapshot => snapshot.documents.find(doc => doc.id === id));
const nativeViewList = async (request: APIRequestContext, projectId: string) =>
  read<SavedView[]>(await request.get(`/api/views?projectId=${projectId}`));

async function remove(request: APIRequestContext, path: string) {
  const response = await request.delete(path);
  if (response.ok()) {
    const { trashEntryId } = await response.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

type Fixture = {
  original: DocPage; jiraProjectId: string; jql: string; suffix: string; matched: Issue; unmatched: Issue;
  assignee: User; secondActor: User;
};
const test = base.extend<{ migratedJiraList: Fixture }>({
  migratedJiraList: [async ({ request }, provide) => {
    const suffix = randomUUID().slice(0, 7).toUpperCase();
    const jiraKey = `JR${suffix}`, wikiKey = `WK${suffix}`;
    const login = `legacy_owner_${suffix}`;
    const title = `이관한 배포 문서 ${suffix}`;
    const jql = `project = ${jiraKey} AND status = Open AND assignee = ${login} ORDER BY Rank ASC`;
    const { users: [assignee, secondActor] } = await workspace(request);
    expect(assignee).toBeDefined();
    expect(secondActor).toBeDefined();
    const packages: LegacyPackageSummary[] = [];
    let jiraProjectId: string | undefined;
    let wikiProjectId: string | undefined;
    try {
      const jira = await stage(request, jiraExport(jiraKey, suffix, login), `${jiraKey}.csv`, 'jira', `jira-macro-${suffix}`);
      packages.push(jira);
      const wiki = await stage(request, wikiExport(wikiKey, title, jql), `${wikiKey}.zip`, 'confluence', `doc-macro-${suffix}`);
      packages.push(wiki);
      jiraProjectId = await apply(request, jira, `TM${suffix}`, `배포 팀 ${suffix}`, { login, id: assignee.id });
      wikiProjectId = await apply(request, wiki, wikiKey, `문서 공간 ${suffix}`);
      const snapshot = await workspace(request);
      const original = snapshot.documents.find(doc => doc.projectId === wikiProjectId && doc.title === title);
      const matched = snapshot.issues.find(issue => issue.projectId === jiraProjectId && issue.title === `배포 예정 ${suffix}`);
      const unmatched = snapshot.issues.find(issue => issue.projectId === jiraProjectId && issue.title === `이미 배포함 ${suffix}`);
      if (!original || !matched || !unmatched) throw new Error('The source Jira tickets or Confluence page were not imported.');
      expect(original.content.content?.filter(node => node.type === 'codeBlock')).toHaveLength(2);
      expect(matched.assigneeId).toBe(assignee.id);
      await provide({ original, jiraProjectId, jql, suffix, matched, unmatched, assignee, secondActor });
    } finally {
      const snapshot = await workspace(request);
      if (wikiProjectId) {
        for (const doc of snapshot.documents.filter(doc => doc.projectId === wikiProjectId)) await remove(request, `/api/documents/${doc.id}`);
      }
      if (jiraProjectId) {
        for (const issue of snapshot.issues.filter(issue => issue.projectId === jiraProjectId)) await remove(request, `/api/issues/${issue.id}`);
        for (const view of snapshot.savedViews?.filter(view => view.projectId === jiraProjectId) ?? []) {
          await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
        }
      }
      for (const source of packages) await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
    }
  }, { timeout: 70_000 }],
});

function chooserOn(page: Page) {
  return page.getByRole('dialog', { name: 'Jira 업무 목록 복원', exact: true });
}

async function openReview(page: Page, editor: Locator, fixture: Fixture) {
  const macro = editor.locator('pre code').filter({ hasText: 'jqlQuery' });
  await macro.click({ position: { x: 10, y: 10 } });
  await page.getByRole('button', { name: '보관된 Jira 목록 복원', exact: true }).click();
  const chooser = chooserOn(page);
  await chooser.getByLabel('업무 목록 프로젝트', { exact: true }).selectOption(fixture.jiraProjectId);
  await chooser.getByRole('button', { name: 'Jira 조건 검토', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Jira 필터 옮기기', exact: true });
  await expect(review.getByLabel('Jira 검색식 (JQL)', { exact: true })).toHaveValue(fixture.jql);
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/views/jira/preview');
  await review.getByRole('button', { name: '조건 미리보기', exact: true }).click();
  const preview = await read<JiraSavedViewPreview>(await pending);
  expect(preview.issues.map(issue => issue.id)).toEqual([fixture.matched.id]);
  expect(preview.filters).toMatchObject({ status: fixture.matched.status, assigneeId: fixture.assignee.id });
  await review.getByLabel('보기 이름', { exact: true }).fill(`이관한 업무 표 ${fixture.suffix}`);
  await review.getByRole('checkbox', { name: '프로젝트 정렬 사용', exact: true }).check();
  return review;
}

test('360px에서 보관한 Confluence Jira 목록을 복원하고 초안과 원본 이력을 지킨다', async ({ page, request, migratedJiraList: f }) => {
  test.setTimeout(85_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const path = `/#/${f.original.projectId}/documents/${f.original.id}`;
  await page.goto(path);
  const editor = page.locator('.docs-prose[contenteditable=true]');
  const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
  const draftTitle = `${f.original.title} 팀 초안`;
  const draftBody = ' 함께 검토할 새 메모입니다.';
  const archivedQuery = editor.locator('pre code').filter({ hasText: 'jqlQuery' });
  const oldUrl = editor.locator('pre code').filter({ hasText: archivedUrl });
  await expect(archivedQuery).toBeVisible();
  await oldUrl.click({ position: { x: 10, y: 10 } });
  await expect(page.getByRole('button', { name: '보관된 Jira 목록 복원', exact: true })).toHaveCount(0);
  await title.fill(draftTitle);
  await editor.getByText(afterList, { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(draftBody);

  const review = await openReview(page, editor, f);
  const importPath = '/api/views/jira/import';
  const result: { view?: SavedView } = {};
  await page.route(url => url.pathname === importPath, async route => {
    result.view = await read<SavedView>(await route.fetch(), 201);
    await page.route(url => url.pathname === '/api/workspace', workspaceRoute => workspaceRoute.fulfill({
      status: 503, json: { error: '합성 목록 새로고침 실패' },
    }), { times: 1 });
    await route.fulfill({ status: 408, json: { error: '합성 공유 보기 저장 응답 유실' } });
  }, { times: 1 });
  await review.getByRole('button', { name: '공유 보기 저장', exact: true }).click();
  await expect(review).toHaveCount(0);
  const chooser = chooserOn(page);
  const retry = chooser.getByRole('button', { name: '저장된 보기 다시 불러오기', exact: true });
  await expect(retry).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await expect(archivedQuery).toHaveCount(1);
  await expect(title).toHaveValue(draftTitle);
  await retry.click();
  const replace = chooser.getByRole('button', { name: '원본을 업무 목록으로 바꾸기', exact: true });
  await expect(replace).toBeEnabled();
  await expect(archivedQuery).toHaveCount(1);
  await replace.click();
  await expect(chooser).toHaveCount(0);
  const storedView = result.view;
  if (!storedView) throw new Error('The server did not keep the saved Jira view.');
  expect((await nativeViewList(request, f.jiraProjectId)).map(view => view.id)).toEqual([storedView.id]);
  const list = editor.getByRole('region', { name: '업무 목록', exact: true });
  const ticket = list.getByRole('button', { name: `목록 업무 열기 ${f.matched.key} ${f.matched.title}`, exact: true });
  await expect(ticket).toBeVisible();
  await expect(list).not.toContainText(f.unmatched.title);
  await expect(editor).toContainText(beforeList);
  await expect(editor).toContainText(`${afterList}${draftBody}`);
  await expect(archivedQuery).toHaveCount(0);
  await expect(oldUrl).toBeVisible();
  await ticket.click();
  const detail = page.getByRole('dialog', { name: f.matched.title, exact: true });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
  await expect(title).toHaveValue(draftTitle);
  await page.locator('.docs-save-button').click();
  await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
  const savedDoc = await currentDoc(request, f.original.id);
  expect(savedDoc?.title).toBe(draftTitle);
  expect(savedDoc?.content.content?.find(node => node.type === 'issueList')?.attrs).toMatchObject({
    projectId: f.jiraProjectId, savedViewId: storedView.id,
  });
  const revisions = await read<DocRevision[]>(await request.get(`/api/documents/${f.original.id}/revisions`));
  expect(revisions.find(revision => revision.version === f.original.version)?.content).toEqual(f.original.content);

  await read<Issue>(await request.patch(`/api/issues/${f.unmatched.id}`, {
    data: { expectedVersion: f.unmatched.version, status: f.matched.status },
  }));
  await page.getByRole('button', { name: '참조 새로고침', exact: true }).click();
  await expect(list).toContainText(f.unmatched.title);
  expect((await currentDoc(request, f.original.id))?.version).toBe(savedDoc?.version);
  await page.reload();
  await expect(list).toContainText(f.matched.title);
  await expect(title).toHaveValue(draftTitle);
});

test('공동 작업자가 이관 Jira 원본을 편집하면 검토 중인 목록으로 덮어쓰지 않는다', async ({ page, request, browser, baseURL, migratedJiraList: f }) => {
  test.setTimeout(75_000);
  const context = await browser.newContext({ baseURL });
  try {
    const enabled = await request.post(`/api/documents/${f.original.id}/collaboration/enable`, { data: { expectedVersion: f.original.version } });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    const peer = await context.newPage();
    const path = `/#/${f.original.projectId}/documents/${f.original.id}`;
    await Promise.all([page.goto(path), peer.goto(path)]);
    await peer.getByLabel('작업자 선택', { exact: true }).selectOption(f.secondActor.id);
    await expect(page.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    const editor = page.locator('.docs-live-prose[contenteditable=true]');
    const review = await openReview(page, editor, f);
    await review.getByRole('button', { name: '공유 보기 저장', exact: true }).click();
    await expect(review).toHaveCount(0);
    const chooser = chooserOn(page);
    const replace = chooser.getByRole('button', { name: '원본을 업무 목록으로 바꾸기', exact: true });
    await expect(replace).toBeEnabled();

    const peerHeading = peer.locator('.docs-live-prose').getByRole('heading', { name: beforeList, exact: true });
    await peerHeading.click();
    await peer.keyboard.press('Home');
    await peer.keyboard.insertText('동료 검토 · ');
    await expect(editor.getByRole('heading', { name: `동료 검토 · ${beforeList}`, exact: true })).toBeVisible();
    await expect(replace).toBeEnabled();

    const peerMacro = peer.locator('.docs-live-prose pre code').filter({ hasText: 'jqlQuery' });
    await peerMacro.click({ position: { x: 10, y: 10 } });
    await peer.keyboard.press('Home');
    await peer.keyboard.insertText('동료가 남긴 변경 ');
    const originalMacro = editor.locator('pre code').filter({ hasText: 'jqlQuery' });
    await expect(originalMacro).toContainText('동료가 남긴 변경');
    await expect(peer.locator('.docs-collaboration-state')).toHaveText('서버에 동기화됨');
    await expect(chooser.getByRole('alert')).toHaveText('원본 Jira 블록이 변경되었거나 삭제되었습니다. 현재 문서에서 다시 열어 주세요.');
    await expect(replace).toBeDisabled();
    await expect(originalMacro).toContainText('동료가 남긴 변경');
    await expect(editor.getByRole('region', { name: '업무 목록', exact: true })).toHaveCount(0);
    expect(await nativeViewList(request, f.jiraProjectId)).toHaveLength(1);
    expect((await currentDoc(request, f.original.id))?.plainText).toContain('동료가 남긴 변경');
  } finally {
    await context.close();
  }
});
