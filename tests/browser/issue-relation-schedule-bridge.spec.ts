import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type {
  Dependency, Issue, IssueRelation, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, WorkspaceSnapshot,
} from '../../shared/types';

async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function dateAt(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

test('360px에서 Jira 안쪽 차단 관계의 선행 방향을 확인한 뒤 간트에 연결한다', async ({ page, request, context }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase();
  const project = { id: '10100', key: 'OLD', name: '원본 설계 프로젝트' };
  const prefix = `이관 차단 ${suffix}`;
  const blockedTitle = `${prefix} 구현`;
  const blockerTitle = `${prefix} 설계`;
  const blockedDates = { startDate: dateAt(5), endDate: dateAt(6) };
  const blockerDates = { startDate: dateAt(1), endDate: dateAt(2) };
  const fields = {
    project, status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
    created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z',
  };
  const jira = {
    startAt: 0, total: 2,
    issues: [
      { id: '10200', key: 'OLD-1', fields: {
        ...fields, summary: blockedTitle,
        issuelinks: [{ id: '10300', type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          inwardIssue: { id: '10201', key: 'OLD-2' } }],
      } },
      { id: '10201', key: 'OLD-2', fields: { ...fields, summary: blockerTitle } },
    ],
  };
  const params = new URLSearchParams({ filename: `jira-relations-${suffix}.json`, product: 'jira', instanceKey: `jira-bridge-${suffix}` });
  const uploaded = await request.post(`/api/legacy-import/packages?${params}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(JSON.stringify(jira)),
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const source = await uploaded.json() as LegacyPackageSummary;
  let imported: Issue[] = [];
  try {
    const { defaultConfiguration } = await read<MigrationOptions>(request, `/api/migrations/options?packageId=${source.id}`);
    const configuration = {
      ...defaultConfiguration,
      projects: defaultConfiguration.projects.map(value => ({ ...value, key: `BR${suffix}`, name: `${prefix} 프로젝트` })),
    };
    const checked = await request.post('/api/migrations/preview', { data: { configuration } });
    expect(checked.status(), await checked.text()).toBe(201);
    const plan = await checked.json() as MigrationPreview;
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    const applied = await request.post(`/api/migrations/previews/${plan.id}/apply`, { data: {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    } });
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: { projectIds: [projectId] } } = await applied.json() as MigrationApplyResult;
    const workspace = await read<WorkspaceSnapshot>(request, '/api/workspace');
    imported = workspace.issues.filter(issue => issue.projectId === projectId);
    expect(imported).toHaveLength(2);
    async function setDates(issueTitle: string, dates: Pick<Issue, 'startDate' | 'endDate'>): Promise<Issue> {
      const issue = imported.find(value => value.title === issueTitle)!;
      const result = await request.patch(`/api/issues/${issue.id}`, { data: { ...dates, expectedVersion: issue.version } });
      expect(result.ok(), await result.text()).toBe(true);
      const saved = await result.json() as Issue;
      expect(saved).toMatchObject(dates);
      return saved;
    }
    const blocked = await setDates(blockedTitle, blockedDates);
    const blocker = await setDates(blockerTitle, blockerDates);
    const before = await read<WorkspaceSnapshot>(request, '/api/workspace');

    const relationPath = `/api/issues/${blocked.id}/relations`;
    const relations = await read<IssueRelation[]>(request, relationPath);
    expect(relations).toHaveLength(1);
    const [relation] = relations;
    expect(relation).toMatchObject({ type: 'Blocks', sourceIssueId: blocked.id, targetIssueId: blocker.id });
    expect(relation.origin).toBeUndefined();
    const schedulePath = `${relationPath}/${relation.id}/schedule-dependency`;
    const scheduleWrites: string[] = [];
    page.on('request', work => {
      if (work.method() === 'POST' && new URL(work.url()).pathname === schedulePath) scheduleWrites.push(work.url());
    });

    await page.goto(`/#/${projectId}/issues?issue=${blocked.id}`);
    const panel = page.getByRole('dialog', { name: blocked.title, exact: true });
    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    const comment = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    const relationList = panel.getByRole('region', { name: '업무 관계', exact: true });
    const trigger = relationList.getByRole('button', { name: `${blocker.key} 일정 연결 검토`, exact: true });
    const editor = page.getByRole('dialog', { name: '관계에서 일정 연결', exact: true });
    const direction = editor.getByRole('combobox', { name: '일정 연결 방향', exact: true });
    const type = editor.getByRole('combobox', { name: '연결 유형', exact: true });
    const lag = editor.getByRole('spinbutton', { name: '추가 간격 근무일', exact: true });
    const save = editor.getByRole('button', { name: '업무 연결', exact: true });
    await expect(title).toHaveValue(blocked.title, { timeout: 30_000 });
    const draftTitle = `${blockedTitle} 제목 초안`;
    const draftComment = '보내지 않은 이관 후 메모';
    await title.fill(draftTitle);
    await comment.fill(draftComment);

    await trigger.click();
    await expect(editor).toBeVisible();
    await expect(direction).toBeFocused();
    await expect(direction).toHaveValue('');
    await expect(type).toHaveValue('FS');
    await expect(lag).toHaveValue('0');
    await expect(save).toBeDisabled();
    await expect(editor).toContainText(blocked.key);
    await expect(editor).toContainText(blocker.key);
    await direction.selectOption('target-first');
    await expect(save).toBeEnabled();
    await editor.getByRole('button', { name: '취소', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(scheduleWrites).toHaveLength(0);
    expect((await read<WorkspaceSnapshot>(request, '/api/workspace')).dependencies).toEqual(before.dependencies);

    await trigger.click();
    await expect(direction).toHaveValue('');
    await direction.selectOption('target-first');
    await type.selectOption('SS');
    await lag.fill('1');
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === schedulePath && response.request().method() === 'POST');
    await save.click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({
      expectedVersion: relation.version, predecessorId: blocker.id, successorId: blocked.id, type: 'SS', lagDays: 1,
    });
    const dependency = await response.json() as Dependency;
    expect(dependency).toMatchObject({ predecessorId: blocker.id, successorId: blocked.id, type: 'SS', lagDays: 1 });
    await expect(editor).toHaveCount(0);
    await expect(relationList.getByText('일정 연결됨', { exact: true })).toBeVisible();
    await expect(title).toHaveValue(draftTitle);
    await expect(comment).toHaveValue(draftComment);
    expect(scheduleWrites).toHaveLength(1);

    const after = await read<WorkspaceSnapshot>(request, '/api/workspace');
    for (const issue of [blocked, blocker]) expect(after.issues.find(value => value.id === issue.id)).toEqual(issue);
    expect(after.dependencies.filter(value => [blocked.id, blocker.id].includes(value.predecessorId))).toEqual([dependency]);
    expect(await read<IssueRelation[]>(request, relationPath)).toEqual(relations);

    const chartPage = await context.newPage();
    try {
      await chartPage.goto(`/#/${projectId}/gantt`);
      const connector = chartPage.locator(`[data-dependency-id="${dependency.id}"]`);
      await expect(connector).toHaveAttribute('data-dependency-type', 'SS');
      await expect(connector).toHaveAttribute('data-predecessor-anchor', 'startDate');
      await expect(connector).toHaveAttribute('data-successor-anchor', 'startDate');
    } finally {
      await chartPage.close();
    }
  } finally {
    for (const issue of imported) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
  }
});
