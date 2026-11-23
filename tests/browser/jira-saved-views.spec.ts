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
