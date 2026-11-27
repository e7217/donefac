import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type {
  AutomaticSchedulePreview, DeliveryBlockerDraftResult, Dependency, Issue, IssueRelation, IssueRelationView, LegacyPackageSummary,
  MigrationApplyResult, MigrationOptions, MigrationPreview, ProjectWorkflow, SchedulePasteApplyResult,
  TeamScheduleBlocker, WorkspaceSnapshot,
} from '../../shared/types';

async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

async function preview(page: Page, settings: Locator) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/migrations/preview' && response.request().method() === 'POST');
  await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as MigrationPreview;
}

function dateAt(offset: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

test('360px에서 기존 Jira 업무의 새 관계를 이관해 일정 연결을 검토한다', async ({ page, request, context }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 820 });

  const suffix = randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase();
  const sourceKey = `JR${suffix}`, targetKey = `TR${suffix}`;
  const sourceProject = { id: '4100', key: sourceKey, name: `Jira 관계 원본 ${suffix}` };
  const title = (number: number) => `${suffix} 업무 ${number}`;
  const jira = (withLink: boolean) => ({
    issues: [1, 2, 3].map(number => ({
      id: String(4100 + number), key: `${sourceKey}-${number}`,
      fields: {
        project: sourceProject, summary: title(number), status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
        created: '2020-01-01T00:00:00Z', updated: withLink ? '2020-01-03T00:00:00Z' : '2020-01-02T00:00:00Z',
        issuelinks: withLink && number === 2 ? [{
          id: '4201', type: { id: '4301', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          inwardIssue: { id: '4101', key: `${sourceKey}-1` },
        }] : [],
      },
    })),
  });
  const staged: LegacyPackageSummary[] = [];
  const originalIssues: Issue[] = [];
  async function upload(name: string, withLink: boolean) {
    const filename = `${name}-${suffix}.json`;
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: `relation-refresh-${suffix}` });
    const response = await request.post(`/api/legacy-import/packages?${query}`, {
      headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(JSON.stringify(jira(withLink))),
    });
    expect(response.status(), await response.text()).toBe(201);
    const pkg = await response.json() as LegacyPackageSummary;
    staged.push(pkg);
    return pkg;
  }

  try {
    const original = await upload('jira-before-link', false);
    const { defaultConfiguration } = await read<MigrationOptions>(request, `/api/migrations/options?packageId=${original.id}`);
    const configuration = { ...defaultConfiguration, projects: defaultConfiguration.projects.map(project => ({ ...project, key: targetKey })) };
    const planning = await request.post('/api/migrations/preview', { data: { configuration } });
    expect(planning.status(), await planning.text()).toBe(201);
    const initialPlan = await planning.json() as MigrationPreview;
    expect(initialPlan.canApply, JSON.stringify(initialPlan.notices)).toBe(true);
    const first = await request.post(`/api/migrations/previews/${initialPlan.id}/apply`, { data: {
      expectedVersion: initialPlan.version, acknowledgements: initialPlan.requiredAcknowledgements,
    } });
    expect(first.status(), await first.text()).toBe(201);
    const { import: { projectIds: [projectId] } } = await first.json() as MigrationApplyResult;
    originalIssues.push(...(await read<WorkspaceSnapshot>(request, '/api/workspace')).issues.filter(issue => issue.projectId === projectId));
    expect(originalIssues).toHaveLength(3);
    const [rawBlocker, rawBlocked, nativeNeighbor] = [1, 2, 3].map(number => originalIssues.find(issue => issue.title === title(number))!);
    async function setDates(issue: Issue, offset: number) {
      const response = await request.patch(`/api/issues/${issue.id}`, { data: {
        expectedVersion: issue.version, startDate: dateAt(offset), endDate: dateAt(offset + 1),
      } });
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as Issue;
    }
    const blocker = await setDates(rawBlocker, 1);
    const blocked = await setDates(rawBlocked, 4);
    const nativeEndpoint = `/api/issues/${blocked.id}/relations`;
    const local = await request.post(nativeEndpoint, { data: { otherIssueId: nativeNeighbor.id, type: 'related', direction: 'outgoing' } });
    expect(local.status(), await local.text()).toBe(201);
    const localRelation = await local.json() as IssueRelation;
    expect(localRelation.origin).toBe('donefac');

    const followUp = await upload('jira-with-link', true);
    await page.goto(`/#/${projectId}/settings?section=migration`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await expect(settings).toBeVisible({ timeout: 30_000 });
    const mode = settings.getByRole('combobox', { name: '이관 방식', exact: true });
    async function selectFollowUp() {
      await settings.getByLabel(`이관 패키지 ${followUp.filename}`, { exact: true }).check();
      await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
      await mode.selectOption('append');
    }
    await selectFollowUp();
    const option = settings.getByRole('checkbox', { name: '기존 Jira 업무 사이의 새 관계 추가', exact: true });
    await expect(option).not.toBeChecked();
    expect((await preview(page, settings)).canApply).toBe(false);
    expect(await read<IssueRelation[]>(request, nativeEndpoint)).toEqual([localRelation]);

    await option.check();
    await mode.selectOption('new');
    await mode.selectOption('append');
    await expect(option).toBeChecked();
    const reviewed = await preview(page, settings);
    expect(reviewed.canApply, JSON.stringify(reviewed.notices)).toBe(true);
    expect(reviewed.configuration.appendTo).toMatchObject({ projectId, refreshRelations: true });
    expect(reviewed.counts).toMatchObject({ issues: 0, issueRelations: 1, newJiraRelations: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const count = '기존 업무 사이의 새 Jira 관계 1';
    await expect(review.getByText(count, { exact: true })).toBeVisible();
    const plannedRelations = review.getByRole('region', { name: '추가할 Jira 관계', exact: true });
    await expect(plannedRelations.getByText(`${blocker.key} → ${blocked.key}`, { exact: true })).toBeVisible();
    const sourceButton = plannedRelations.getByRole('button', { name: 'Jira 관계 원본 보기', exact: true });
    await sourceButton.click();
    const originalDialog = page.getByRole('dialog', { name: 'Jira 관계 원본 기록', exact: true });
    await expect(originalDialog.getByRole('region', { name: '원본 객체 상세', exact: true })).toContainText('4201 · 관계');
    await originalDialog.getByRole('button', { name: 'Jira 관계 원본 닫기', exact: true }).click();
    await expect(sourceButton).toBeFocused();
    const downloading = page.waitForEvent('download');
    await review.getByRole('button', { name: '이관 사전 검토 JSON 내보내기', exact: true }).click();
    const downloaded = await downloading;
    const preflight = await readFile((await downloaded.path())!, 'utf8');
    expect(JSON.parse(preflight).counts).toMatchObject({ newJiraRelations: 1 });
    expect(preflight).not.toContain(blocker.key);
    await downloaded.delete();
    const bounds = await review.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    for (const code of reviewed.requiredAcknowledgements) {
      await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    }

    const applying = page.waitForResponse(response => new URL(response.url()).pathname === `/api/migrations/previews/${reviewed.id}/apply` && response.request().method() === 'POST');
    let confirmation = '';
    page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const result = await applying;
    expect(result.status(), await result.text()).toBe(201);
    expect(confirmation).toContain('기존 업무 사이의 새 Jira 관계 1건 추가');
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByRole('heading', { name: '기존 프로젝트의 Jira 이관 결과', exact: true })).toBeVisible();
    await expect(receipt.getByText(count, { exact: true })).toBeVisible();

    const relations = await read<IssueRelation[]>(request, nativeEndpoint);
    expect(relations).toHaveLength(2);
    expect(relations).toContainEqual(localRelation);
    const imported = relations.find(relation => relation.id !== localRelation.id)!;
    expect([imported.sourceIssueId, imported.targetIssueId].sort()).toEqual([blocked.id, blocker.id].sort());
    expect(imported.origin).toBeUndefined();
    const after = await read<WorkspaceSnapshot>(request, '/api/workspace');
    expect(after.issues.filter(issue => issue.projectId === projectId)).toHaveLength(originalIssues.length);
    for (const issue of [blocker, blocked, nativeNeighbor]) expect(after.issues.find(current => current.id === issue.id)).toEqual(issue);
    expect(after.dependencies.some(edge => edge.predecessorId === blocker.id || edge.successorId === blocked.id)).toBe(false);

    await selectFollowUp();
    await option.check();
    const repeated = await preview(page, settings);
    expect(repeated.canApply).toBe(false);
    expect(repeated.counts.newJiraRelations).toBe(0);
    await expect(review.getByText('Jira 관계 원본 보관 1', { exact: true })).toBeVisible();
    await expect(review.getByRole('heading', { name: '적용할 Jira 변경이 없습니다', exact: true })).toBeVisible();
    await expect(review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();
    expect(await read<IssueRelation[]>(request, nativeEndpoint)).toEqual(relations);

    const issuePage = await context.newPage();
    try {
      await issuePage.goto(`/#/${projectId}/issues?issue=${blocked.id}`);
      const panel = issuePage.getByRole('dialog', { name: blocked.title, exact: true });
      const relationList = panel.getByRole('region', { name: '업무 관계', exact: true });
      await relationList.getByRole('button', { name: `${blocker.key} 일정 연결 검토`, exact: true }).click();
      const schedule = issuePage.getByRole('dialog', { name: '관계에서 일정 연결', exact: true });
      const direction = schedule.getByRole('combobox', { name: '일정 연결 방향', exact: true });
      await expect(direction).toHaveValue('');
      await direction.selectOption(imported.sourceIssueId === blocker.id ? 'source-first' : 'target-first');
      const writing = issuePage.waitForResponse(response => new URL(response.url()).pathname === `${nativeEndpoint}/${imported.id}/schedule-dependency` && response.request().method() === 'POST');
      await schedule.getByRole('button', { name: '업무 연결', exact: true }).click();
      const saved = await writing;
      expect(saved.status(), await saved.text()).toBe(201);
      const dependency = await saved.json() as Dependency;
      expect(dependency).toMatchObject({ predecessorId: blocker.id, successorId: blocked.id, type: 'FS' });
      await expect(relationList.getByText('일정 연결됨', { exact: true })).toBeVisible();
      await issuePage.goto(`/#/${projectId}/gantt`);
      await expect(issuePage.locator(`[data-dependency-id="${dependency.id}"]`)).toBeVisible();
    } finally { await issuePage.close(); }
  } finally {
    for (const issue of originalIssues) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 따로 이관한 Jira 프로젝트 간 관계를 열고 후행 일정을 검토한다', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase();
  const source = { id: '5100', key: `JA${suffix}`, name: `Jira 설계 ${suffix}` };
  const target = { id: '5200', key: `JB${suffix}`, name: `Jira 검증 ${suffix}` };
  const projects = [
    { jira: source, issueId: '5101', name: `이관한 설계 ${suffix}`, key: `TA${suffix}`, title: `설계 결정 ${suffix}` },
    { jira: target, issueId: '5201', name: `이관한 검증 ${suffix}`, key: `TB${suffix}`, title: `검증 계획 ${suffix}` },
  ];
  const packages: LegacyPackageSummary[] = [];
  const tickets: Issue[] = [];
  const meetingTitle = `Jira 이관 차단 회의 ${suffix}`;

  async function upload(fixture: typeof projects[number], withRelation = false) {
    const filename = `jira-cross-project-${fixture.key}${withRelation ? '-relation' : ''}.json`;
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: `cross-relation-${suffix}` });
    const response = await request.post(`/api/legacy-import/packages?${query}`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      data: Buffer.from(JSON.stringify({ issues: [{
        id: fixture.issueId, key: `${fixture.jira.key}-1`, fields: {
          project: fixture.jira, summary: fixture.title, status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
          created: '2020-01-01T00:00:00Z', updated: withRelation ? '2020-01-03T00:00:00Z' : '2020-01-02T00:00:00Z',
          issuelinks: withRelation ? [{ id: '5301', type: { id: '5300', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
            outwardIssue: { id: '5201', key: `${target.key}-1` } }] : [],
        },
      }] })),
    });
    expect(response.status(), await response.text()).toBe(201);
    const pkg = await response.json() as LegacyPackageSummary;
    packages.push(pkg);
    return pkg;
  }

  try {
    for (const fixture of projects) {
      const original = await upload(fixture);
      const { defaultConfiguration } = await read<MigrationOptions>(request, `/api/migrations/options?packageId=${original.id}`);
      const configuration = { ...defaultConfiguration, projects: defaultConfiguration.projects.map(project => ({ ...project, name: fixture.name, key: fixture.key })) };
      const draft = await request.post('/api/migrations/preview', { data: { configuration } });
      expect(draft.status(), await draft.text()).toBe(201);
      const reviewed = await draft.json() as MigrationPreview;
      expect(reviewed.canApply, JSON.stringify(reviewed.notices)).toBe(true);
      const applied = await request.post(`/api/migrations/previews/${reviewed.id}/apply`, { data: {
        expectedVersion: reviewed.version, acknowledgements: reviewed.requiredAcknowledgements,
      } });
      expect(applied.status(), await applied.text()).toBe(201);
      const { import: { projectIds: [projectId] } } = await applied.json() as MigrationApplyResult;
      const created = (await read<WorkspaceSnapshot>(request, '/api/workspace')).issues.filter(issue => issue.projectId === projectId);
      tickets.push(...created);
      expect(created).toHaveLength(1);
    }
    const [blocker, blocked] = tickets;
    expect(blocker.projectId).not.toBe(blocked.projectId);
    const later = await upload(projects[0], true);
    await page.goto(`/#/${blocker.projectId}/settings?section=migration`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await expect(settings).toBeVisible({ timeout: 30_000 });
    await settings.getByLabel(`이관 패키지 ${later.filename}`, { exact: true }).check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    await settings.getByRole('combobox', { name: '이관 방식', exact: true }).selectOption('append');
    const option = settings.getByRole('checkbox', { name: '기존 Jira 업무 사이의 새 관계 추가', exact: true });
    await expect(option).toHaveAccessibleDescription(/별도로 이관한 프로젝트 간 관계도 포함됩니다/);
    await option.check();
    const reviewed = await preview(page, settings);
    expect(reviewed.canApply, JSON.stringify(reviewed.notices)).toBe(true);
    expect(reviewed.configuration.appendTo).toMatchObject({ projectId: blocker.projectId, refreshRelations: true });
    expect(reviewed.counts).toMatchObject({ issues: 0, newJiraRelations: 1 });
    expect(reviewed.jiraRelationRefresh).toMatchObject([{ sourceKey: blocker.key, targetKey: blocked.key,
      sourceProjectName: projects[0].name, targetProjectName: projects[1].name }]);
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const plannedRelations = review.getByRole('region', { name: '추가할 Jira 관계', exact: true });
    await expect(plannedRelations.getByRole('heading', { name: `${blocker.key} → ${blocked.key}`, exact: true })).toBeVisible();
    await expect(plannedRelations.getByText(`프로젝트 간 관계 · ${projects[0].name} → ${projects[1].name}`, { exact: true })).toBeVisible();
    const original = plannedRelations.getByRole('button', { name: 'Jira 관계 원본 보기', exact: true });
    await original.click();
    const originalDialog = page.getByRole('dialog', { name: 'Jira 관계 원본 기록', exact: true });
    await expect(originalDialog.getByRole('region', { name: '원본 객체 상세', exact: true })).toContainText('5301 · 관계');
    await originalDialog.getByRole('button', { name: 'Jira 관계 원본 닫기', exact: true }).click();
    for (const code of reviewed.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const applying = page.waitForResponse(response => new URL(response.url()).pathname === `/api/migrations/previews/${reviewed.id}/apply` && response.request().method() === 'POST');
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applying;
    expect(applied.status(), await applied.text()).toBe(201);
    const result = await applied.json() as MigrationApplyResult;
    expect(result.import.projectIds.toSorted()).toEqual([blocker.projectId, blocked.projectId].toSorted());
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByRole('heading', { name: '기존 프로젝트의 Jira 이관 결과', exact: true })).toBeVisible();
    for (const project of projects) {
      await expect(receipt.getByRole('link', { name: `${project.name} 프로젝트 열기`, exact: true })).toBeVisible();
    }

    await page.goto(`/#/${blocker.projectId}/issues?issue=${blocker.id}`);
    const panel = page.getByRole('dialog', { name: blocker.title, exact: true });
    const relations = panel.getByRole('region', { name: '업무 관계', exact: true });
    const linked = relations.getByRole('button').filter({ hasText: blocked.key });
    await expect(linked).toContainText(projects[1].name);
    await linked.click();
    const other = page.getByRole('dialog', { name: blocked.title, exact: true });
    await expect(other.getByRole('region', { name: '업무 관계', exact: true })).toContainText(blocker.key);
    const after = await read<WorkspaceSnapshot>(request, '/api/workspace');
    const unchanged = after.issues.filter(issue => tickets.some(ticket => ticket.projectId === issue.projectId));
    expect(unchanged).toHaveLength(tickets.length);
    for (const ticket of tickets) expect(unchanged.find(issue => issue.id === ticket.id)).toEqual(ticket);

    const linksPath = `/api/issues/${blocked.id}/relations`;
    const [restoredLink] = await read<IssueRelationView[]>(request, linksPath);
    expect(restoredLink).toMatchObject({ sourceIssueId: blocker.id, targetIssueId: blocked.id, type: 'Blocks', verifiedBlockerDirection: 'incoming' });
    const dates = [
      { issue: blocker, startDate: '2026-11-19', endDate: '2026-11-20' },
      { issue: blocked, startDate: '2026-11-16', endDate: '2026-11-17' },
    ];
    for (const { issue, startDate, endDate } of dates) {
      const response = await request.patch(`/api/issues/${issue.id}`, { data: { expectedVersion: issue.version, startDate, endDate } });
      expect(response.status(), await response.text()).toBe(200);
    }
    const schedule = async () => {
      const snapshot = await read<WorkspaceSnapshot>(request, '/api/workspace');
      return {
        dates: dates.map(({ issue }) => {
          const current = snapshot.issues.find(item => item.id === issue.id)!;
          return { id: current.id, startDate: current.startDate, endDate: current.endDate, dueDate: current.dueDate, status: current.status };
        }),
        dependencies: snapshot.dependencies.filter(item => [blocker.id, blocked.id].includes(item.predecessorId) ||
          [blocker.id, blocked.id].includes(item.successorId)),
      };
    };
    const beforeReview = await schedule();
    const candidate = (await read<TeamScheduleBlocker[]>(request, '/api/schedule/team-blockers')).find(item => item.id === restoredLink.id);
    expect(candidate).toMatchObject({ sourceIssueId: blocker.id, targetIssueId: blocked.id, origin: 'jira' });
    await page.goto(`/#/${blocked.projectId}/gantt?scope=team&ganttProject=${blocked.projectId}`);
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(suffix);
    await page.getByLabel('간트 표시 시작일', { exact: true }).fill('2026-11-16');
    await page.getByRole('button', { name: '프로젝트 간 차단', exact: true }).click();
    const blockersPanel = page.getByRole('region', { name: '프로젝트 간 차단', exact: true });
    const pair = blockersPanel.locator(`[data-team-blocker-id="${restoredLink.id}"]`);
    await expect(pair.getByText('Jira 이관 관계', { exact: true })).toBeVisible();
    await expect(pair).toContainText(`차단하는 업무 · ${projects[0].name}`);
    await expect(pair).toContainText(`차단되는 업무 · ${projects[1].name}`);
    const scheduleReview = pair.getByRole('button', { name: `${blocker.key} → ${blocked.key} 프로젝트 간 일정 검토`, exact: true });
    await expect(scheduleReview).toHaveAccessibleDescription('Jira 이관 관계');
    const scheduleDialog = page.getByRole('dialog', { name: '프로젝트 간 후행 일정 검토', exact: true });
    const mutation = (path: string) => page.waitForResponse(response => new URL(response.url()).pathname === `/api/schedule/${path}` &&
      response.request().method() === 'POST');

    const previewing = mutation('team-follow-up-preview');
    await scheduleReview.click();
    const scheduleResponse = await previewing;
    expect(scheduleResponse.status(), await scheduleResponse.text()).toBe(200);
    const proposed = await scheduleResponse.json() as AutomaticSchedulePreview;
    expect(proposed.teamFollowUp).toMatchObject({ relationId: restoredLink.id, sourceIssueId: blocker.id, targetIssueId: blocked.id });
    expect(proposed.blocking).toEqual([]);
    expect(proposed.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd])).toEqual([[blocked.id, '2026-11-23', '2026-11-24']]);
    await expect(scheduleDialog.getByText('Jira 이관 관계', { exact: true })).toBeVisible();
    await expect(scheduleDialog).toContainText(`${blocker.key} → ${blocked.key}`);
    expect(await schedule()).toEqual(beforeReview);
    await scheduleDialog.getByRole('button', { name: '돌아가기', exact: true }).click();
    await expect(scheduleReview).toBeFocused();
    expect(await schedule()).toEqual(beforeReview);

    await scheduleReview.click();
    const savingSchedule = mutation('team-follow-up-apply');
    await scheduleDialog.getByRole('button', { name: '함께 적용', exact: true }).click();
    const savedSchedule = await savingSchedule;
    expect(savedSchedule.status(), await savedSchedule.text()).toBe(200);
    const { undoId } = await savedSchedule.json() as SchedulePasteApplyResult;
    await expect(scheduleDialog).toHaveCount(0);
    expect(await schedule()).toEqual({ ...beforeReview, dates: [beforeReview.dates[0],
      { ...beforeReview.dates[1], startDate: '2026-11-23', endDate: '2026-11-24' }] });
    expect(await read<IssueRelation[]>(request, linksPath)).toEqual([restoredLink]);
    const undoing = mutation('undo');
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undone = await undoing;
    expect(undone.status(), await undone.text()).toBe(200);
    expect(undone.request().postDataJSON()).toEqual({ undoId });
    expect(await schedule()).toEqual(beforeReview);
    expect(await read<IssueRelation[]>(request, linksPath)).toEqual([restoredLink]);

    const localSourceResponse = await request.post('/api/issues', { data: {
      projectId: blocker.projectId, title: `먼저 마치는 선행 업무 ${suffix}`, startDate: '2026-11-17', endDate: '2026-11-18',
    } });
    expect(localSourceResponse.status(), await localSourceResponse.text()).toBe(201);
    const localSource = await localSourceResponse.json() as Issue;
    tickets.push(localSource);
    const localSourcePath = `/api/issues/${localSource.id}/relations`;
    const addedIncoming = await request.post(localSourcePath, { data: { otherIssueId: blocked.id, type: 'blocks', direction: 'outgoing' } });
    expect(addedIncoming.status(), await addedIncoming.text()).toBe(201);
    const incoming = await addedIncoming.json() as IssueRelation;
    await page.reload();
    await page.getByRole('button', { name: '프로젝트 간 차단', exact: true }).click();
    const localPair = blockersPanel.locator(`[data-team-blocker-id="${incoming.id}"]`);
    const incomingPreview = mutation('team-follow-up-preview');
    await localPair.getByRole('button', { name: `${localSource.key} → ${blocked.key} 프로젝트 간 일정 검토`, exact: true }).click();
    const inspected = await incomingPreview;
    expect(inspected.status(), await inspected.text()).toBe(200);
    const incomingPlan = await inspected.json() as AutomaticSchedulePreview;
    expect(incomingPlan.teamFollowUp).toMatchObject({ relationId: incoming.id, sourceEndDate: '2026-11-18' });
    expect(incomingPlan.changes.map(({ id, toStart, toEnd }) => [id, toStart, toEnd])).toEqual([[blocked.id, '2026-11-23', '2026-11-24']]);
    await expect(scheduleDialog.getByRole('table', { name: '검토할 업무 일정' })).toContainText('2026-11-23');
    await scheduleDialog.getByRole('button', { name: '돌아가기', exact: true }).click();
    const removedIncoming = await request.delete(`${localSourcePath}/${incoming.id}?expectedVersion=${incoming.version}`);
    expect(removedIncoming.ok(), await removedIncoming.text()).toBe(true);
    expect(await schedule()).toEqual(beforeReview);

    await blockersPanel.getByRole('button', { name: '차단 관계 추가', exact: true }).click();
    const form = blockersPanel.getByRole('form', { name: '프로젝트 간 차단 관계 추가', exact: true });
    await form.getByLabel('원인 업무 검색', { exact: true }).fill(blocker.key);
    await form.getByRole('combobox', { name: '차단하는 업무', exact: true }).selectOption(blocker.id);
    await form.getByLabel('차단 대상 업무 검색', { exact: true }).fill(blocked.key);
    await form.getByRole('combobox', { name: '차단되는 업무', exact: true }).selectOption(blocked.id);
    const saveBlock = form.getByRole('button', { name: '차단 관계 저장', exact: true });
    const senderPath = `/api/issues/${blocker.id}/relations`;
    const blockerPath = '/api/schedule/team-blockers';
    const senderRoute = (url: URL) => url.pathname === blockerPath;
    const beforeBlocking = await read<WorkspaceSnapshot>(request, '/api/workspace');
    let failedSave: unknown;
    const failFirstSave = async (route: Route) => {
      if (route.request().method() !== 'POST' || failedSave) return route.continue();
      failedSave = route.request().postDataJSON();
      await route.abort('failed');
    };
    await page.route(senderRoute, failFirstSave);
    try {
      await saveBlock.click();
      await expect(form.getByRole('alert')).toBeVisible();
    } finally {
      await page.unroute(senderRoute, failFirstSave);
    }
    expect(failedSave).toEqual({ sourceIssueId: blocker.id, targetIssueId: blocked.id,
      expectedSourceVersion: beforeBlocking.issues.find(issue => issue.id === blocker.id)!.version,
      expectedTargetVersion: beforeBlocking.issues.find(issue => issue.id === blocked.id)!.version });
    expect(await read<IssueRelation[]>(request, linksPath)).toEqual([restoredLink]);
    const savingBlock = page.waitForResponse(response => new URL(response.url()).pathname === blockerPath && response.request().method() === 'POST');
    await saveBlock.click();
    const savedBlock = await savingBlock;
    expect(savedBlock.status(), await savedBlock.text()).toBe(201);
    const nativeBlock = await savedBlock.json() as IssueRelation;
    await expect(blockersPanel.locator(`[data-team-blocker-id="${nativeBlock.id}"]`)).toBeVisible();
    await expect(pair).toHaveCount(0);
    const withNative = await read<IssueRelationView[]>(request, linksPath);
    expect(withNative.map(relation => relation.id)).toEqual([restoredLink.id, nativeBlock.id]);
    expect(withNative[0]).not.toHaveProperty('verifiedBlockerDirection');
    expect(withNative[1]).toEqual(nativeBlock);
    const removedNative = await request.delete(`${senderPath}/${nativeBlock.id}?expectedVersion=${nativeBlock.version}`);
    expect(removedNative.ok(), await removedNative.text()).toBe(true);

    const reportHash = `#/${blocked.projectId}/reports/blockers?reason=issue_block`;
    await page.goto(`/${reportHash}`);
    const report = page.getByRole('tabpanel', { name: '진행 차단', exact: true });
    const card = report.getByRole('article', { name: `차단된 업무 ${blocked.key}`, exact: true });
    await expect(card.getByText('Jira 이관 관계', { exact: true })).toBeVisible();
    const sourceButton = card.getByRole('button', { name: `${blocker.key} ${blocker.title} 업무 열기`, exact: true });
    await sourceButton.click();
    const sourcePanel = page.getByRole('dialog', { name: blocker.title, exact: true });
    await expect(sourcePanel.getByText('Jira 이관 관계 · 이 업무가 차단함', { exact: true })).toBeVisible();
    await sourcePanel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(sourcePanel).toHaveCount(0);
    await expect(sourceButton).toBeFocused();

    await report.getByRole('button', { name: '회의 초안 만들기', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '회의 초안 만들기', exact: true });
    await meeting.getByRole('textbox', { name: '회의 초안 제목', exact: true }).fill(meetingTitle);
    const savingMeeting = page.waitForResponse(response => new URL(response.url()).pathname ===
      `/api/projects/${blocked.projectId}/delivery-blockers/meeting-draft` && response.request().method() === 'POST');
    await meeting.getByRole('button', { name: '회의 초안 저장', exact: true }).click();
    const meetingResponse = await savingMeeting;
    expect(meetingResponse.status(), await meetingResponse.text()).toBe(201);
    const { document } = await meetingResponse.json() as DeliveryBlockerDraftResult;
    expect(document.plainText).toContain('Jira 이관 관계');
    expect(document.plainText).toContain(blocker.title);
    await meeting.getByRole('button', { name: '문서 열기', exact: true }).click();
    const meetingSource = page.locator('[aria-label="문서 본문"]').getByRole('link', { name: '진행 차단 보고서 열기', exact: true });
    await expect(meetingSource).toHaveAttribute('href', reportHash);

    const workflowPath = `/api/projects/${blocked.projectId}/workflow`;
    const workflow = await read<ProjectWorkflow>(request, workflowPath);
    const completion = { id: 'review-complete', category: 'done', label: '검토 완료', color: '#428655' };
    const guarded = await request.patch(workflowPath, { data: {
      ...workflow, expectedVersion: workflow.version, statuses: [...workflow.statuses, completion],
      transitions: [...workflow.transitions, {
        from: blocked.status, to: completion.id, issueTypes: [], requiredFields: [], requireResolvedBlockers: true,
      }],
    } });
    expect(guarded.ok(), await guarded.text()).toBe(true);
    await page.goto(`/#/${blocked.projectId}/issues?issue=${blocked.id}`);
    await page.reload();
    const targetPanel = page.getByRole('dialog', { name: blocked.title, exact: true });
    await targetPanel.getByRole('combobox', { name: '상태', exact: true }).selectOption(completion.id);
    const transitioning = page.waitForResponse(response => new URL(response.url()).pathname ===
      `/api/issues/${blocked.id}` && response.request().method() === 'PATCH');
    await targetPanel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const rejected = await transitioning;
    expect(rejected.status(), await rejected.text()).toBe(422);
    expect(await rejected.json()).toMatchObject({ details: { reason: 'open_issue_blockers' } });
    await targetPanel.getByRole('button', { name: '차단 업무 보기', exact: true }).click();
    const targetRelations = targetPanel.getByRole('region', { name: '업무 관계', exact: true });
    await expect(targetRelations).toBeFocused();
    await expect(targetRelations.getByText('Jira 이관 관계 · 이 업무가 차단됨', { exact: true })).toBeVisible();
    await expect(targetRelations.getByText('열린 차단 업무', { exact: true })).toBeVisible();
    await expect(targetRelations.getByRole('button', { name: `${blocker.key} 업무 열기`, exact: true })).toBeVisible();
  } finally {
    const state = await read<WorkspaceSnapshot>(request, '/api/workspace');
    for (const document of state.documents.filter(value => value.title === meetingTitle)) {
      const removed = await request.delete(`/api/documents/${document.id}?expectedVersion=${document.version}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    for (const issue of tickets) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    for (const pkg of packages) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});
