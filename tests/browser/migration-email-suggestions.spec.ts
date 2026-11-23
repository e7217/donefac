import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, User, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

function responseFor(page: Page, pathname: string, method: 'GET' | 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
}

async function upload(request: APIRequestContext, filename: string, instanceKey: string, content: Buffer) {
  const params = new URLSearchParams({ filename, instanceKey });
  return json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${params}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: content,
  }), 201);
}

async function createPreview(page: Page, settings: Locator) {
  const pending = responseFor(page, '/api/migrations/preview', 'POST');
  await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
  const preview = await json<MigrationPreview>(await pending, 201);
  expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
  return preview;
}

const property = (name: string, value: string) => `<property name="${name}"><![CDATA[${value}]]></property>`;
const reference = (name: string, kind: string, id: string, keyName = 'id') =>
  `<property name="${name}" class="${kind}"><id name="${keyName}">${id}</id></property>`;
const entity = (kind: string, id: string, content: string, keyName = 'id') =>
  `<object class="${kind}"><id name="${keyName}">${id}</id>${content}</object>`;

test('360px 이관에서 이메일 일치 후보를 확인하고 선택한 Jira·Confluence 사용자 매핑만 반영한다', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const assignedMember = workspace.users.find(user => user.id === 'user-min')!;
  const manualEmailMember = workspace.users.find(user => user.id === 'user-jun')!;
  const manualOverrideMember = workspace.users.find(user => user.id === 'user-yun')!;
  const unselectedMember = workspace.users.find(user => user.id === 'user-seo')!;
  expect([assignedMember, manualEmailMember, manualOverrideMember, unselectedMember].every(Boolean)).toBe(true);

  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const jiraProject = { id: '1100', key: `JEM${suffix}`, name: `Jira 사용자 이관 ${suffix}` };
  const wikiProject = { id: '2200', key: `CEM${suffix}`, name: `Confluence 사용자 이관 ${suffix}` };
  const jiraFilename = `email-jira-${suffix}.json`;
  const wikiFilename = `email-wiki-${suffix}.zip`;
  const jiraInstance = `jira-email-${suffix.toLowerCase()}`;
  const wikiInstance = `wiki-email-${suffix.toLowerCase()}`;
  const issueTitle = `업무 담당자와 요청자 ${suffix}`;
  const unmappedIssueTitle = `일치 후보를 제외한 업무 ${suffix}`;
  const wikiTitle = `문서 작성자 ${suffix}`;
  const assignee = { accountId: 'jira-assignee', displayName: 'Jira 원본 담당자', emailAddress: ` ${assignedMember.email.toUpperCase()} ` };
  const requester = { accountId: 'jira-requester', displayName: '직접 지정한 Jira 요청자', emailAddress: manualEmailMember.email };
  const unselected = { accountId: 'jira-unselected', displayName: '선택 해제할 Jira 담당자', emailAddress: unselectedMember.email };
  const ambiguousFirst = { accountId: 'jira-ambiguous-first', displayName: 'Jira 공동 이메일 A', emailAddress: manualOverrideMember.email };
  const ambiguousSecond = { accountId: 'jira-ambiguous-second', displayName: 'Jira 공동 이메일 B', emailAddress: manualOverrideMember.email.toUpperCase() };
  const missingEmail = { accountId: 'jira-missing-email', displayName: unselectedMember.name };
  const wikiAuthorId = 'wiki-author';
  const wikiAuthorName = 'Confluence 원본 작성자';
  const makeIssue = (number: number, summary: string, issueAssignee: typeof assignee | typeof missingEmail, reporter = requester) => ({
    id: String(1100 + number), key: `${jiraProject.key}-${number}`, changelog: { total: 0, histories: [] },
    fields: {
      project: jiraProject, assignee: issueAssignee, reporter, summary,
      status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
      created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z',
    },
  });
  const jira = Buffer.from(JSON.stringify({ issues: [
    makeIssue(1, issueTitle, assignee),
    makeIssue(2, unmappedIssueTitle, unselected),
    makeIssue(3, `모호한 원본 A ${suffix}`, ambiguousFirst),
    makeIssue(4, `모호한 원본 B ${suffix}`, ambiguousSecond),
    makeIssue(5, `이메일 없는 원본 ${suffix}`, missingEmail),
  ] }));
  const wiki = '<hibernate-generic>' +
    entity('Space', wikiProject.id, property('key', wikiProject.key) + property('name', wikiProject.name)) +
    entity('ConfluenceUserImpl', wikiAuthorId, property('name', wikiAuthorId) + property('displayName', wikiAuthorName) +
      property('email', assignedMember.email), 'key') +
    entity('Page', '200', property('title', wikiTitle) + property('version', '1') + reference('space', 'Space', wikiProject.id) +
      reference('creator', 'ConfluenceUserImpl', wikiAuthorId, 'key') +
      property('creationDate', '2020-01-01T00:00:00Z') + property('lastModificationDate', '2020-01-02T00:00:00Z')) +
    entity('BodyContent', '300', property('body', '<p>작성자를 확인할 문서</p>') + property('bodyType', '2') +
      reference('content', 'Page', '200')) + '</hibernate-generic>';
  const staged: LegacyPackageSummary[] = [];
  const unselectedMemberPath = `/api/users/${unselectedMember.id}`;
  let rosterEmailChanged = false;
  try {
    staged.push(await upload(request, jiraFilename, jiraInstance, jira));
    staged.push(await upload(request, wikiFilename, wikiInstance, zip([{ path: 'entities.xml', bytes: Buffer.from(wiki) }])));
    await page.goto(`/#/${workspace.projects[0].id}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await expect(settings).toBeVisible({ timeout: 30_000 });
    await settings.getByLabel(`이관 패키지 ${jiraFilename}`, { exact: true }).check();
    await settings.getByLabel(`이관 패키지 ${wikiFilename}`, { exact: true }).check();
    const loading = responseFor(page, '/api/migrations/options', 'GET');
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    const options = await json<MigrationOptions>(await loading);
    await settings.getByText('사용자 매핑', { exact: true }).click();

    const mapping = (label: string) => settings.getByRole('combobox', { name: `사용자 매핑 ${label}`, exact: true });
    await mapping(requester.displayName).selectOption(manualOverrideMember.id);
    const before = await createPreview(page, settings);
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    for (const code of before.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const apply = review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true });
    await expect(apply).toBeEnabled();

    const opener = settings.getByRole('button', { name: '이메일 일치 후보 검토', exact: true });
    const dialog = page.getByRole('dialog', { name: '이메일 일치 후보 검토', exact: true });
    const candidate = (label: string) => dialog.getByRole('checkbox', { name: `매핑 선택 ${label}`, exact: true });
    await opener.click();
    await expect(dialog.getByRole('checkbox')).toHaveCount(3);
    for (const label of [assignee.displayName, unselected.displayName, wikiAuthorName]) await expect(candidate(label)).toBeChecked();
    await expect(dialog.getByText(jiraInstance, { exact: false }).first()).toBeVisible();
    await expect(dialog.getByText(wikiInstance, { exact: false }).first()).toBeVisible();
    await expect(dialog).toContainText(assignedMember.email);
    await expect(dialog).toContainText(assignedMember.name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(apply).toBeEnabled();
    await expect(mapping(assignee.displayName)).toHaveValue('');

    await opener.click();
    await expect(candidate(unselected.displayName)).toBeChecked();
    const changedEmail = `email-changed-${suffix.toLowerCase()}@example.test`;
    const changedUser = await json<User>(await request.patch(unselectedMemberPath, { data: { email: changedEmail } }));
    rosterEmailChanged = true;
    expect(changedUser.email).toBe(changedEmail);
    await dialog.getByRole('button', { name: '선택한 매핑 반영', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('팀원 정보가 바뀌었습니다. 최신 후보를 확인한 뒤 다시 선택해 주세요.');
    await expect(candidate(unselected.displayName)).toHaveCount(0);
    await expect(candidate(assignee.displayName)).toBeChecked();
    await expect(candidate(wikiAuthorName)).toBeChecked();
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(apply).toBeEnabled();
    await expect(mapping(assignee.displayName)).toHaveValue('');
    await json<User>(await request.patch(unselectedMemberPath, { data: { email: unselectedMember.email } }));
    rosterEmailChanged = false;

    await opener.click();
    await candidate(unselected.displayName).uncheck();
    await dialog.getByRole('button', { name: '선택한 매핑 반영', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(settings.getByText('이메일이 일치하는 사용자 매핑 2건을 반영했습니다. 새 미리보기를 만들어 주세요.', { exact: true })).toBeVisible();
    await expect(review).toHaveCount(0);
    await expect(mapping(assignee.displayName)).toHaveValue(assignedMember.id);
    await expect(mapping(wikiAuthorName)).toHaveValue(assignedMember.id);
    await expect(mapping(requester.displayName)).toHaveValue(manualOverrideMember.id);
    for (const source of [unselected, ambiguousFirst, ambiguousSecond, missingEmail]) {
      await expect(mapping(source.displayName)).toHaveValue('');
    }
    const beforeApply = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(beforeApply.projects.some(project => project.key === jiraProject.key || project.key === wikiProject.key)).toBe(false);

    const proposed = await createPreview(page, settings);
    expect(proposed.id).not.toBe(before.id);
    const identity = (label: string) => options.identities.find(item => item.label === label)!.id;
    expect(proposed.configuration.users).toEqual({
      ...before.configuration.users,
      [identity(assignee.displayName)]: assignedMember.id,
      [identity(wikiAuthorName)]: assignedMember.id,
    });
    await expect(apply).toBeDisabled();
    for (const code of proposed.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const applying = responseFor(page, `/api/migrations/previews/${proposed.id}/apply`, 'POST');
    page.once('dialog', confirmation => confirmation.accept());
    await apply.click();
    const { import: receipt } = await json<MigrationApplyResult>(await applying, 201);
    expect(receipt.projectIds).toHaveLength(2);
    const imported = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(imported.issues.find(issue => issue.title === issueTitle)).toMatchObject({
      assigneeId: assignedMember.id, reporterId: manualOverrideMember.id,
    });
    expect(imported.issues.find(issue => issue.title === unmappedIssueTitle)).toMatchObject({ assigneeId: null });
    expect(imported.documents.find(document => document.title === wikiTitle)).toMatchObject({ authorId: assignedMember.id });
  } finally {
    if (rosterEmailChanged) await json<User>(await request.patch(unselectedMemberPath, { data: { email: unselectedMember.email } }));
    const after = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const projectIds = new Set(after.projects.filter(project => project.key === jiraProject.key || project.key === wikiProject.key)
      .map(project => project.id));
    const resources = [
      ...after.issues.filter(issue => projectIds.has(issue.projectId)).map(issue => `/api/issues/${issue.id}?expectedVersion=${issue.version}`),
      ...after.documents.filter(document => document.projectId && projectIds.has(document.projectId))
        .map(document => `/api/documents/${document.id}?expectedVersion=${document.version}`),
    ];
    for (const path of resources) {
      const deleted = await request.delete(path);
      expect(deleted.ok(), await deleted.text()).toBe(true);
      const { trashEntryId } = await deleted.json() as { trashEntryId: string };
      const purged = await request.delete(`/api/trash/${trashEntryId}`);
      expect(purged.ok(), await purged.text()).toBe(true);
    }
    for (const pack of staged) {
      const deleted = await request.delete(`/api/legacy-import/packages/${pack.id}?expectedVersion=${pack.version}`);
      expect(deleted.ok(), await deleted.text()).toBe(true);
    }
  }
});
