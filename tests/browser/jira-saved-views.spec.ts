import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import { JIRA_SAVED_VIEW_QUERY_LIMIT } from '../../shared/types';
import type {
  Issue, JiraSavedViewPreview, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview,
  ProjectIssueSchema, ProjectWorkflow, SavedView, WorkspaceSnapshot,
} from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'text' | 'status'>, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

test('360px에서 Jira 원래 프로젝트와 매핑한 검색 조건을 공유 보기와 간트에서 연다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const originalKey = `JR${suffix}`;
  const targetKey = `TM${suffix}`;
  const viewName = `옮긴 Jira 필터 ${suffix}`;
  const originalAssignee = `old_assignee_${suffix}`;
  const originalReporter = `old_reporter_${suffix}`;
  const currentStatus = '팀 개발 대기';
  const currentType = '팀 개발 업무';
  const issues: Issue[] = [];
  let source: LegacyPackageSummary | undefined;
  let saved: SavedView | undefined;

  try {
    const initialWorkspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const [assignee, reporter] = initialWorkspace.users;
    expect(assignee).toBeDefined();
    expect(reporter).toBeDefined();
    const rows = [
      ['1', '운영 업무', 'Open', 'api', originalAssignee, originalReporter, '2026-11-25'],
      ['2', '보류 업무', 'Open', 'hold', originalAssignee, originalReporter, '2026-11-26'],
      ['3', '라벨 없는 업무', 'Open', '', originalAssignee, originalReporter, '2026-11-25'],
      ['4', '완료 업무', 'Closed', 'api', originalAssignee, originalReporter, '2026-11-25'],
      ['5', '요청자가 다른 업무', 'Open', 'api', originalAssignee, '', '2026-11-25'],
      ['6', '기간 밖 마감 업무', 'Open', 'api', originalAssignee, originalReporter, '2026-11-27'],
    ];
    const csv = [
      'Issue id,Issue key,Project id,Project key,Project name,Summary,Created,Updated,Status,Issue Type,Labels,Assignee,Reporter,Due Date',
      ...rows.map(([id, title, status, label, assigneeName, reporterName, dueDate]) => [
        id, `${originalKey}-${id}`, '20800', originalKey, 'Jira 프로젝트', `${title} ${suffix}`,
        '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', status, 'Task', label, assigneeName, reporterName, dueDate,
      ].join(',')),
    ].join('\r\n');
    const query = new URLSearchParams({ filename: `saved-filter-${suffix}.csv`, product: 'jira', instanceKey: `filters-${suffix}` });
    source = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
      headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(csv),
    }), 201);
    const { defaultConfiguration, identities } = await json<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${source.id}`));
    const sourceAssignee = identities.find(identity => identity.sourceValue === originalAssignee);
    const sourceReporter = identities.find(identity => identity.sourceValue === originalReporter);
    if (!sourceAssignee || !sourceReporter) throw new Error('Missing source users from the CSV migration.');
    const configuration = {
      ...defaultConfiguration,
      projects: defaultConfiguration.projects.map(project => ({ ...project, key: targetKey, name: `팀 프로젝트 ${suffix}` })),
      users: { ...defaultConfiguration.users, [sourceAssignee.id]: assignee.id, [sourceReporter.id]: reporter.id },
    };
    const migration = await json<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
    expect(migration.canApply, JSON.stringify(migration.notices)).toBe(true);
    const { import: { projectIds: [projectId] } } = await json<MigrationApplyResult>(await request.post(`/api/migrations/previews/${migration.id}/apply`, {
      data: { expectedVersion: migration.version, acknowledgements: migration.requiredAcknowledgements },
    }), 201);
    const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    issues.push(...workspace.issues.filter(issue => issue.projectId === projectId));
    expect(issues).toHaveLength(6);
    const issue = (title: string) => issues.find(value => value.title === `${title} ${suffix}`)!;
    const included = issue('운영 업무');
    const held = issue('보류 업무');
    const unlabeled = issue('라벨 없는 업무');
    const closed = issue('완료 업무');
    const otherReporter = issue('요청자가 다른 업무');
    const outsideDeadline = issue('기간 밖 마감 업무');
    expect(included.labels).toEqual(['api']);
    expect(held.labels).toEqual(['hold']);
    expect(included.assigneeId).toBe(assignee.id);
    expect(included.reporterId).toBe(reporter.id);
    expect(outsideDeadline.dueDate).toBe('2026-11-27');
    const workflowPath = `/api/projects/${projectId}/workflow`;
    const schemaPath = `/api/projects/${projectId}/issue-schema`;
    const workflow = await json<ProjectWorkflow>(await request.get(workflowPath));
    const schema = await json<ProjectIssueSchema>(await request.get(schemaPath));
    await json<ProjectWorkflow>(await request.patch(workflowPath, { data: {
      ...workflow, expectedVersion: workflow.version,
      statuses: workflow.statuses.map(value => value.id === included.status ? { ...value, label: currentStatus } : value),
    } }));
    await json<ProjectIssueSchema>(await request.patch(schemaPath, { data: {
      ...schema, expectedVersion: schema.version,
      issueTypes: schema.issueTypes.map(value => value.id === included.type ? { ...value, name: currentType } : value),
    } }));

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/issues`);
    await page.getByRole('button', { name: 'Jira 필터 옮기기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Jira 필터 옮기기', exact: true });
    const jqlInput = dialog.getByLabel('Jira 검색식 (JQL)', { exact: true });
    const previewButton = dialog.getByRole('button', { name: '조건 미리보기', exact: true });
    const save = dialog.getByRole('button', { name: '공유 보기 저장', exact: true });
    const postTo = (path: string) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    const previewPath = '/api/views/jira/preview';
    const importPath = '/api/views/jira/import';
    const oversized = 'x'.repeat(JIRA_SAVED_VIEW_QUERY_LIMIT + 1);
    await jqlInput.fill(oversized);
    await expect(jqlInput).toHaveValue(oversized);
    await expect(dialog.getByRole('alert')).toContainText('4,000자');
    await expect(previewButton).toBeDisabled();
    const rejected = postTo(previewPath);
    await jqlInput.fill(`project = ${originalKey} AND (status = "Open" OR labels = "api")`);
    await previewButton.click();
    expect((await rejected).status()).toBe(400);
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(save).toBeDisabled();

    const jql = `project = ${originalKey} AND status = Open AND issuetype = Task AND assignee = ${originalAssignee} AND reporter = ${originalReporter} AND labels NOT IN ("hold") AND due >= "2026/11/25" AND dueDate < "2026-11-27" ORDER BY Rank DESC`;
    await jqlInput.fill(jql);
    async function preview() {
      const pending = postTo(previewPath);
      await previewButton.click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual({ projectId, jql });
      return json<JiraSavedViewPreview>(response);
    }
    const first = await preview();
    expect(first).toMatchObject({
      total: 1,
      filters: { status: included.status, type: included.type, assigneeId: assignee.id,
        reporter: { kind: 'member', memberId: reporter.id }, labels: { exclude: ['hold'], presence: 'set' },
        planning: { dates: { mode: 'due', from: '2026-11-25', to: '2026-11-26' } } },
      orderBy: [{ field: 'Rank', direction: 'desc' }],
    });
    expect(first.issues.map(value => value.id)).toEqual([included.id]);
    const review = dialog.getByRole('region', { name: 'Jira 필터 미리보기', exact: true });
    await expect(review).toContainText(included.title);
    for (const name of [currentStatus, currentType, assignee.name, reporter.name]) {
      await expect(review).toContainText(name);
    }
    await expect(review).not.toContainText(unlabeled.title);
    await expect(review).not.toContainText(otherReporter.title);
    await expect(review).not.toContainText(outsideDeadline.title);
    await expect(review).toContainText('목표 마감일 · 2026-11-25 ~ 2026-11-26');
    const name = dialog.getByLabel('보기 이름', { exact: true });
    const order = dialog.getByRole('checkbox', { name: '프로젝트 정렬 사용', exact: true });
    await name.fill(viewName);
    await expect(save).toBeDisabled();
    await order.check();
    await expect(save).toBeEnabled();

    await json<Issue>(await request.patch(`/api/issues/${held.id}`, {
      data: { expectedVersion: held.version, labels: ['api'] },
    }));
    const stale = postTo(importPath);
    await save.click();
    expect((await stale).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(jqlInput).toHaveValue(jql);
    await expect(name).toHaveValue(viewName);
    await expect(save).toBeDisabled();
    const fresh = await preview();
    expect(fresh.revision).not.toBe(first.revision);
    expect(fresh.issues.map(value => value.id).sort()).toEqual([included.id, held.id].sort());
    await order.check();

    const resultAfterDrop: { view?: SavedView } = {};
    await page.route(url => url.pathname === importPath, async route => {
      const result = await route.fetch();
      resultAfterDrop.view = await json<SavedView>(result, 201);
      await route.fulfill({ status: 408, json: { error: '합성 저장 응답 유실' } });
    }, { times: 1 });
    const creation = postTo(importPath);
    await save.click();
    const response = await creation;
    expect(response.request().postDataJSON()).toEqual({ projectId, jql, name: viewName, layout: 'list', revision: fresh.revision, acceptProjectOrder: true });
    expect(response.status()).toBe(408);
    saved = resultAfterDrop.view;
    if (!saved) throw new Error('The server did not save the reviewed view.');
    expect(saved.filters).toEqual(fresh.filters);
    expect(saved).not.toHaveProperty('jql');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('저장된 업무 보기', { exact: true })).toHaveValue(saved.id);
    await expect(page.getByText(included.title, { exact: true })).toBeVisible();
    await expect(page.getByText(held.title, { exact: true })).toBeVisible();
    await expect(page.getByText(unlabeled.title, { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    for (const value of [included, held]) await expect(chart.locator(`[data-issue-id="${value.id}"]`)).toBeVisible();
    for (const value of [unlabeled, closed, otherReporter, outsideDeadline]) await expect(chart.locator(`[data-issue-id="${value.id}"]`)).toHaveCount(0);
    await expect(page.getByRole('list', { name: '간트에 적용된 계획·일정 조건' })).toContainText('목표 마감일 · 2026-11-25 ~ 2026-11-26');
    await page.reload();
    await expect(chart.locator(`[data-issue-id="${included.id}"]`)).toBeVisible();
    await expect(chart.locator(`[data-issue-id="${unlabeled.id}"]`)).toHaveCount(0);
  } finally {
    if (saved) await request.delete(`/api/views/${saved.id}?expectedVersion=${saved.version}`);
    for (const value of issues) {
      const response = await request.delete(`/api/issues/${value.id}`);
      if (response.ok()) await request.delete(`/api/trash/${(await response.json() as { trashEntryId: string }).trashEntryId}`);
    }
    if (source) await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
  }
});

test('360px에서 Jira 우선순위 일부만 합쳐지는 조건을 막고 전체 그룹을 업무와 간트의 공유 보기로 연다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const originalKey = `JP${suffix}`;
  const targetKey = `TP${suffix}`;
  const rows = [
    ['711', 'Highest', '긴급으로 옮긴 가장 높은 업무'],
    ['712', 'Blocker', '긴급으로 옮긴 차단 업무'],
    ['722', 'Critical', '높음으로 옮긴 중요 업무'],
    ['733', 'Medium', '보통으로 옮긴 일반 업무'],
  ];
  const issues: Issue[] = [];
  let source: LegacyPackageSummary | undefined;
  let saved: SavedView | undefined;

  try {
    const xml = `<entity-engine-xml>
      <Project id="42" pkey="${originalKey}" name="Jira 우선순위 프로젝트"/>
      <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
      ${rows.map(([id, label]) => `<Priority id="${id}" pname="${label}"/>`).join('\n')}
      ${rows.map(([id, , title], index) => `<Issue id="${200 + index}" project="42" number="${1 + index}"
        summary="${title} ${suffix}" status="1" issuetype="3" priority="${id}"
        created="2020-01-01T00:00:00Z" updated="2020-01-02T00:00:00Z"/>`).join('\n')}
    </entity-engine-xml>`;
    const query = new URLSearchParams({ filename: 'entities.xml', product: 'jira', instanceKey: `priority-views-${suffix}` });
    source = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
      headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(xml),
    }), 201);
    const { defaultConfiguration } = await json<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${source.id}`));
    const configuration = {
      ...defaultConfiguration,
      projects: defaultConfiguration.projects.map(project => ({ ...project, key: targetKey, name: `우선순위 이관 ${suffix}` })),
    };
    const migration = await json<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
    expect(migration.canApply, JSON.stringify(migration.notices)).toBe(true);
    const { import: { projectIds: [projectId] } } = await json<MigrationApplyResult>(await request.post(`/api/migrations/previews/${migration.id}/apply`, {
      data: { expectedVersion: migration.version, acknowledgements: migration.requiredAcknowledgements },
    }), 201);
    const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    issues.push(...workspace.issues.filter(issue => issue.projectId === projectId));
    expect(issues).toHaveLength(rows.length);
    const migrated = rows.map(([, , title]) => issues.find(value => value.title === `${title} ${suffix}`)!);
    expect(migrated.map(issue => issue.priority)).toEqual(['urgent', 'urgent', 'high', 'medium']);
    const nativeLow = await json<Issue>(await request.post('/api/issues', {
      data: { projectId, title: `Teamspace에서 추가한 낮은 업무 ${suffix}`, priority: 'low' },
    }), 201);
    issues.push(nativeLow);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/issues`);
    await page.getByRole('button', { name: 'Jira 필터 옮기기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Jira 필터 옮기기', exact: true });
    const jqlInput = dialog.getByLabel('Jira 검색식 (JQL)', { exact: true });
    const previewButton = dialog.getByRole('button', { name: '조건 미리보기', exact: true });
    const save = dialog.getByRole('button', { name: '공유 보기 저장', exact: true });
    const postTo = (path: string) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    const previewPath = '/api/views/jira/preview';
    const viewName = `Jira 우선순위 보기 ${suffix}`;
    await dialog.getByLabel('보기 이름', { exact: true }).fill(viewName);

    const incomplete = `project = ${originalKey} AND priority = 711`;
    await jqlInput.fill(incomplete);
    const rejected = postTo(previewPath);
    await previewButton.click();
    expect((await rejected).status()).toBe(400);
    await expect(dialog.getByRole('alert')).toContainText(/우선순위.*함께 이관된 원본 값/);
    await expect(jqlInput).toHaveValue(incomplete);
    await expect(save).toBeDisabled();
    const rejectedWorkspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    expect(rejectedWorkspace.savedViews?.filter(view => view.projectId === projectId) ?? []).toEqual([]);

    const complete = `project = ${originalKey} AND priority IN ("Highest", 712, "Critical")`;
    await jqlInput.fill(complete);
    const reviewing = postTo(previewPath);
    await previewButton.click();
    const reviewed = await json<JiraSavedViewPreview>(await reviewing);
    const matched = migrated.slice(0, 3);
    const excluded = [...migrated.slice(3), nativeLow];
    expect(reviewed.total).toBe(matched.length);
    expect(new Set(reviewed.filters.priorities)).toEqual(new Set(['urgent', 'high']));
    expect(new Set(reviewed.issues.map(issue => issue.id))).toEqual(new Set(matched.map(issue => issue.id)));
    const review = dialog.getByRole('region', { name: 'Jira 필터 미리보기', exact: true });
    const criteria = review.getByRole('list', { name: '적용할 검색 조건', exact: true });
    await expect(criteria).toContainText(/우선순위.*긴급.*높음/);
    for (const issue of excluded) await expect(review).not.toContainText(issue.title);

    const saving = postTo('/api/views/jira/import');
    await save.click();
    saved = await json<SavedView>(await saving, 201);
    expect(saved.filters).toEqual(reviewed.filters);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('저장된 업무 보기', { exact: true })).toHaveValue(saved.id);
    const listRows = page.locator('.issue-table tbody tr[data-issue-id]');
    await expect(listRows).toHaveCount(matched.length);
    for (const issue of matched) await expect(listRows.filter({ hasText: issue.title })).toBeVisible();

    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const row = (issue: Issue) => chart.locator(`[data-issue-id="${issue.id}"]`);
    for (const issue of matched) await expect(row(issue)).toBeVisible();
    for (const issue of excluded) await expect(row(issue)).toHaveCount(0);
    await expect(page.getByRole('list', { name: '간트에 적용된 우선순위·라벨 조건', exact: true })).toContainText(/우선순위.*긴급.*높음/);
    await page.reload();
    for (const issue of matched) await expect(row(issue)).toBeVisible();
    for (const issue of excluded) await expect(row(issue)).toHaveCount(0);
  } finally {
    if (saved) await request.delete(`/api/views/${saved.id}?expectedVersion=${saved.version}`);
    for (const value of issues) {
      const response = await request.delete(`/api/issues/${value.id}`);
      if (response.ok()) await request.delete(`/api/trash/${(await response.json() as { trashEntryId: string }).trashEntryId}`);
    }
    if (source) await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
  }
});

test('360px에서 Jira 날짜순을 저장하고 응답이 끊겨도 정렬한 공유 보기를 다시 연다', async ({ page, request }) => {
  const projectId = 'project-neo';
  const label = `date-order-${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  const stored: { view?: SavedView } = {};
  const previewPath = '/api/views/jira/preview';
  const importPath = '/api/views/jira/import';
  const expectedSort = [{ field: 'dueDate', direction: 'desc' }];
  const matchingRows = (id: string) => page.locator(`.issue-table tbody tr[data-issue-id="${id}"]`);

  try {
    for (const [title, dueDate] of [['마감일 없이 먼저 등록한 업무', null], ['이른 마감일 업무', '2026-11-24'], ['늦은 마감일 업무', '2026-11-30']]) {
      const issue = await json<Issue>(await request.post('/api/issues', { data: { projectId, title, labels: [label], dueDate } }), 201);
      issues.push(issue);
    }
    const expectedIds = [issues[2].id, issues[1].id, issues[0].id];
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/issues`);
    await page.getByRole('button', { name: 'Jira 필터 옮기기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Jira 필터 옮기기', exact: true });
    await dialog.getByLabel('Jira 검색식 (JQL)', { exact: true }).fill(`project = NEO AND labels = "${label}" ORDER BY dueDate DESC`);
    await dialog.getByLabel('보기 이름', { exact: true }).fill(`Jira 날짜순 ${label}`);
    const reviewed = page.waitForResponse(response => new URL(response.url()).pathname === previewPath && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '조건 미리보기', exact: true }).click();
    const review = await json<JiraSavedViewPreview>(await reviewed);
    expect(review.sort).toEqual(expectedSort);
    expect(review.issues.map(issue => issue.id)).toEqual(expectedIds);
    await expect(dialog.getByText('저장할 정렬 · 목표 마감일 내림차순')).toBeVisible();
    await expect(dialog.getByText(/목표 마감일이 비어 있으면 뒤에 표시합니다/)).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: '프로젝트 정렬 사용', exact: true })).toHaveCount(0);

    await page.route(url => url.pathname === importPath, async route => {
      stored.view = await json<SavedView>(await route.fetch(), 201);
      await route.fulfill({ status: 408, json: { error: '합성 저장 응답 유실' } });
    }, { times: 1 });
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === importPath && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '공유 보기 저장', exact: true }).click();
    expect((await saving).request().postDataJSON()).toMatchObject({ acceptProjectOrder: false, revision: review.revision });
    expect(stored.view?.sort).toEqual(expectedSort);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('저장된 업무 보기', { exact: true })).toHaveValue(stored.view!.id);
    await expect(matchingRows(issues[0].id)).toBeVisible();
    await expect.poll(() => page.locator('.issue-table tbody tr[data-issue-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-issue-id')))).toEqual(expectedIds);
    await page.reload();
    await expect(matchingRows(issues[0].id)).toBeVisible();
    await expect.poll(() => page.locator('.issue-table tbody tr[data-issue-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-issue-id')))).toEqual(expectedIds);
  } finally {
    if (stored.view) await request.delete(`/api/views/${stored.view.id}?expectedVersion=${stored.view.version}`);
    for (const issue of issues) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
    }
  }
});
