import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { Comment, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, User, WorkspaceSnapshot } from '../../shared/types';
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

test('360px에서 같은 Jira 원본 계정에 팀원 매핑을 재사용하고 다른 인스턴스와 매핑 충돌은 보존한다', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const [actor, member, conflictFirstMember, conflictSecondMember] = ['user-seo', 'user-min', 'user-jun', 'user-yun']
    .map(id => workspace.users.find(user => user.id === id)!);
  expect([actor, member, conflictFirstMember, conflictSecondMember].every(Boolean)).toBe(true);
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);

  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const instance = `same-jira-${suffix.toLowerCase()}`;
  const accountId = `reuse-${suffix.toLowerCase()}`;
  const conflictingAccountId = `conflict-${suffix.toLowerCase()}`;
  const account = (accountId: string, displayName: string) => ({ accountId, displayName: `${displayName} ${suffix}` });
  const seed = account(accountId, '기존 담당자 매핑'), target = account(accountId, '댓글이 있는 대상 계정'),
    foreign = account(accountId, '다른 Jira의 동명 계정');
  const conflictFirst = account(conflictingAccountId, '직접 매핑한 충돌 A'),
    conflictSecond = account(conflictingAccountId, '직접 매핑한 충돌 B'),
    conflictEmpty = account(conflictingAccountId, '값 없는 충돌 대상');
  const commentBody = `같은 원본으로 확인한 Jira 댓글 ${suffix}`;
  const packs = [
    { tag: 'A', instance, entries: [{ identity: seed }, { identity: conflictFirst }] },
    { tag: 'B', instance, entries: [{ identity: target, comment: commentBody }, { identity: conflictSecond }] },
    { tag: 'C', instance, entries: [{ identity: conflictEmpty }] },
    { tag: 'D', instance: `${instance}-other`, entries: [{ identity: foreign }] },
  ].map((pack, index) => ({ ...pack, filename: `account-reuse-${suffix}-${pack.tag}.json`,
    project: { id: String(2100 + index), key: `AR${suffix}${pack.tag}`, name: `Jira 사용자 원본 ${pack.tag} ${suffix}` },
  }));
  const projectKeys = new Set(packs.map(pack => pack.project.key));
  const staged: LegacyPackageSummary[] = [];
  const title = (identity: typeof seed) => `원본 담당자 확인 · ${identity.displayName}`;
  try {
    for (const [packIndex, pack] of packs.entries()) {
      const issues = pack.entries.map(({ identity, comment }, index) => ({
        id: String(4100 + packIndex * 10 + index), key: `${pack.project.key}-${index + 1}`, changelog: { total: 0, histories: [] },
        fields: {
          project: pack.project, summary: title(identity), assignee: identity, reporter: identity,
          status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
          created: '2020-03-01T00:00:00Z', updated: '2020-03-02T00:00:00Z',
          ...(comment ? { comment: { startAt: 0, maxResults: 1, total: 1, comments: [{
            id: String(5100 + packIndex * 10 + index), author: identity, body: comment, visibility: null,
            created: '2020-03-02T00:00:00Z', updated: '2020-03-02T00:00:00Z',
          }] } } : {}),
        },
      }));
      staged.push(await upload(request, pack.filename, pack.instance, Buffer.from(JSON.stringify({ issues }))));
    }
    await page.goto(`/#/${workspace.projects[0].id}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await expect(settings).toBeVisible({ timeout: 30_000 });
    for (const pack of packs) await settings.getByLabel(`이관 패키지 ${pack.filename}`, { exact: true }).check();
    const loading = responseFor(page, '/api/migrations/options', 'GET');
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    const options = await json<MigrationOptions>(await loading);
    await settings.getByText('사용자 매핑', { exact: true }).click();
    const mapping = (identity: typeof seed) => settings.getByRole('combobox', { name: `사용자 매핑 ${identity.displayName}`, exact: true });
    await expect(mapping(seed)).toHaveAccessibleDescription(`${accountId} · ${packs[0].filename}`);
    await mapping(seed).selectOption(member.id);
    await mapping(conflictFirst).selectOption(conflictFirstMember.id);
    await mapping(conflictSecond).selectOption(conflictSecondMember.id);

    const before = await createPreview(page, settings);
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    for (const code of before.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const apply = review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true });
    await expect(apply).toBeEnabled();

    const name = '같은 원본 계정 매핑 검토';
    const opener = settings.getByRole('button', { name, exact: true });
    const dialog = page.getByRole('dialog', { name, exact: true });
    const candidate = dialog.getByRole('checkbox', { name: `매핑 선택 ${target.displayName} · ${packs[1].filename}`, exact: true });
    await opener.click();
    await expect(candidate).toBeChecked();
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);
    await expect(dialog).toContainText(`기존 매핑 · ${seed.displayName} · ${packs[0].filename}`);
    await expect(dialog).toContainText(packs[1].filename);
    await expect(dialog).toContainText(member.name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await candidate.uncheck();
    await expect(dialog.getByRole('button', { name: '선택한 매핑 반영', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(apply).toBeEnabled();
    await expect(mapping(target)).toHaveValue('');

    await opener.click();
    await expect(candidate).toBeChecked();
    await dialog.getByRole('button', { name: '선택한 매핑 반영', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(review).toHaveCount(0);
    for (const [identity, value] of [[seed, member.id], [target, member.id], [foreign, ''],
      [conflictFirst, conflictFirstMember.id], [conflictSecond, conflictSecondMember.id], [conflictEmpty, '']] as const) {
      await expect(mapping(identity)).toHaveValue(value);
    }

    const proposed = await createPreview(page, settings);
    const identityId = options.identities.find(identity => identity.packageId === staged[1].id && identity.label === target.displayName)?.id;
    expect(identityId).toBeDefined();
    expect(proposed.id).not.toBe(before.id);
    expect(proposed.configuration.users).toEqual({ ...before.configuration.users, [identityId!]: member.id });
    for (const code of proposed.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const applying = responseFor(page, `/api/migrations/previews/${proposed.id}/apply`, 'POST');
    page.once('dialog', confirmation => confirmation.accept());
    await apply.click();
    const { import: receipt } = await json<MigrationApplyResult>(await applying, 201);
    expect(receipt.projectIds).toHaveLength(packs.length);

    const imported = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const issueFor = (identity: typeof seed) => imported.issues.find(issue => issue.title === title(identity));
    expect(issueFor(seed)).toMatchObject({ assigneeId: member.id, reporterId: member.id });
    const targetIssue = issueFor(target);
    expect(targetIssue).toMatchObject({ assigneeId: member.id, reporterId: member.id });
    expect(issueFor(foreign)).toMatchObject({ assigneeId: null });
    expect(issueFor(conflictFirst)).toMatchObject({ assigneeId: conflictFirstMember.id });
    expect(issueFor(conflictSecond)).toMatchObject({ assigneeId: conflictSecondMember.id });
    expect(issueFor(conflictEmpty)).toMatchObject({ assigneeId: null });
    const params = new URLSearchParams({ resourceType: 'issue', resourceId: targetIssue!.id });
    const comments = await json<Comment[]>(await request.get(`/api/comments?${params}`));
    expect(comments).toMatchObject([{ body: commentBody, authorId: member.id }]);
  } finally {
    const after = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const projectIds = new Set(after.projects.filter(project => projectKeys.has(project.key)).map(project => project.id));
    for (const issue of after.issues.filter(issue => projectIds.has(issue.projectId))) {
      const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`));
      await json(await request.delete(`/api/trash/${trashEntryId}`));
    }
    for (const pack of staged) await json(await request.delete(`/api/legacy-import/packages/${pack.id}?expectedVersion=${pack.version}`));
  }
});
