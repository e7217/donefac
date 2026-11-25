import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { DocPage, Issue, PlanningItem, Project, ProjectIssueSchema, SavedView, SavedViewState, SchedulePreview, WorkspaceSnapshot } from '../../shared/types';

async function createView(request: APIRequestContext, projectId: string, name: string, filters: SavedViewState['filters']) {
  const response = await request.post('/api/views', { data: { projectId, name, layout: 'list', filters } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as SavedView;
}

test('360px에서 업무 공유 보기의 조건을 간트에 적용하고 주소·업무 상세·초안을 보존한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const prefix = `공유 일정 ${suffix}`;
  const workspaceResponse = await request.get('/api/workspace');
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = await workspaceResponse.json() as WorkspaceSnapshot;
  const assigneeId = workspace.users[0].id;
  const projectResponse = await request.post('/api/projects', { data: { key: `GS${suffix}`, name: prefix } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = await projectResponse.json() as Project;
  const schemaPath = `/api/projects/${project.id}/issue-schema`;
  const issues: Issue[] = [];
  const views: SavedView[] = [];
  try {
    const currentSchema = await (await request.get(schemaPath)).json() as ProjectIssueSchema;
    const schema = await request.patch(schemaPath, { data: {
      expectedVersion: currentSchema.version,
      issueTypes: currentSchema.issueTypes,
      fields: [{ id: 'checked', name: '검토 완료', description: '', kind: 'checkbox', required: false, issueTypes: [], options: [], archived: false }],
    } });
    expect(schema.ok(), await schema.text()).toBeTruthy();

    const title = `${prefix} 해당 업무`;
    const common = { projectId: project.id, type: '작업', status: 'in_progress', assigneeId, customFields: { checked: false } };
    const fixtures = [
      { ...common, title },
      { ...common, title: `${prefix} 다른 상태`, status: 'todo' },
      { ...common, title: `${prefix} 미배정`, assigneeId: null },
      { ...common, title: `${prefix} 검토 완료`, customFields: { checked: true } },
      { ...common, title: `${prefix} 버그`, type: '버그' },
      { ...common, title: `${suffix} 다른 검색어` },
    ];
    for (const fields of fixtures) {
      const response = await request.post('/api/issues', { data: fields });
      expect(response.status(), await response.text()).toBe(201);
      issues.push(await response.json() as Issue);
    }
    const [matched] = issues;
    const view = await createView(request, project.id, `${prefix} 저장`, {
      query: prefix,
      status: 'in_progress',
      assigneeId,
      type: '작업',
      fieldFilter: { match: 'all', rules: [{ fieldId: 'checked', operator: 'equals', value: false }] },
    });
    views.push(view);
    const foreign = await createView(request, workspace.projects[0].id, `${prefix} 다른 프로젝트`, {
      query: '', status: 'all', assigneeId: 'all', type: 'all',
    });
    views.push(foreign);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/issues`);
    const sourcePicker = page.getByRole('combobox', { name: '저장된 업무 보기', exact: true });
    await expect(sourcePicker).toBeEnabled({ timeout: 25_000 });
    await sourcePicker.selectOption(view.id);
    const list = page.locator('.issue-table');
    await expect(list.getByText(title, { exact: true })).toBeVisible();
    for (const excluded of issues.slice(1)) await expect(list.getByText(excluded.title, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();

    const ganttPath = `#/${project.id}/gantt`;
    const filteredPath = `${ganttPath}?savedView=${view.id}`;
    const hash = () => new URL(page.url()).hash;
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const rows = chart.locator('.gantt-row[data-issue-id]');
    const matchedRow = chart.locator(`[data-issue-id="${matched.id}"]`);
    const picker = page.getByRole('combobox', { name: '간트 공유 보기', exact: true });
    await expect.poll(hash).toBe(filteredPath);
    await expect(picker).toHaveValue(view.id);
    await expect(rows).toHaveCount(1);
    await expect(matchedRow).toBeVisible();
    await expect(page.getByRole('status', { name: '간트에 표시된 업무', exact: true })).toHaveText(`${issues.length}개 중 1개 업무`);
    const pickerBounds = await picker.boundingBox();
    expect(pickerBounds).not.toBeNull();
    expect(pickerBounds!.x).toBeGreaterThanOrEqual(0);
    expect(pickerBounds!.x + pickerBounds!.width).toBeLessThanOrEqual(360);
    await expect(picker.locator(`option[value="${foreign.id}"]`)).toHaveCount(0);
    const chartSearch = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await chartSearch.fill(issues[1].title);
    await expect(rows).toHaveCount(0);
    await chartSearch.fill('');
    await expect(matchedRow).toBeVisible();

    await page.reload();
    await expect(picker).toHaveValue(view.id);
    await expect(rows).toHaveCount(1);
    await matchedRow.locator('.gantt-issue-name').click();
    const details = page.getByRole('dialog', { name: title, exact: true });
    await expect(details).toBeVisible();
    await expect.poll(hash).toContain(`savedView=${view.id}`);
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect.poll(hash).toBe(filteredPath);
    await expect(matchedRow).toBeVisible();

    const changed = new Date();
    changed.setUTCDate(changed.getUTCDate() + 3);
    const plannedEnd = changed.toISOString().slice(0, 10);
    const endDate = matchedRow.getByLabel(`${matched.key} 종료일`, { exact: true });
    await endDate.fill(plannedEnd);
    const review = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/schedule/manual-preview' && response.request().method() === 'POST');
    const apply = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/schedule/manual-apply' && response.request().method() === 'POST');
    await endDate.press('Enter');
    const previewResponse = await review;
    expect(previewResponse.ok(), await previewResponse.text()).toBeTruthy();
    expect(previewResponse.request().postDataJSON()).toEqual({ changes: [
      { id: matched.id, expectedVersion: matched.version, startDate: null, endDate: plannedEnd },
    ] });
    const proposal = await previewResponse.json() as SchedulePreview;
    expect(proposal.previewId).toBeTruthy();
    const update = await apply;
    expect(update.ok(), await update.text()).toBeTruthy();
    expect(update.request().postDataJSON()).toEqual({ previewId: proposal.previewId });
    const savedWorkspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(savedWorkspace.issues.find(issue => issue.id === matched.id)).toMatchObject({ endDate: plannedEnd, version: matched.version + 1 });
    await expect(endDate).toHaveValue(plannedEnd);
    await expect.poll(hash).toBe(filteredPath);

    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    const draft = page.getByRole('form', { name: '간트에서 업무 만들기', exact: true });
    const draftTitle = draft.getByLabel('추가할 업무 제목', { exact: true });
    await draftTitle.fill('공유 보기 전환 시 보호할 초안');
    const dismissDuringSwitch = page.waitForEvent('dialog').then(confirm => confirm.dismiss());
    await picker.selectOption('');
    await dismissDuringSwitch;
    await expect(draftTitle).toHaveValue('공유 보기 전환 시 보호할 초안');
    await expect.poll(hash).toBe(filteredPath);
    await expect(picker).toHaveValue(view.id);
    const acceptDuringSwitch = page.waitForEvent('dialog').then(confirm => confirm.accept());
    await picker.selectOption('');
    await acceptDuringSwitch;
    await expect(draft).toHaveCount(0);
    await expect.poll(hash).toBe(ganttPath);
    await expect(rows).toHaveCount(issues.length);

    const unavailable = page.getByText('이 프로젝트에서 공유 보기를 열 수 없습니다.', { exact: true });
    for (const unavailableId of [foreign.id, 'not-a-view']) {
      await page.goto(`/${ganttPath}?savedView=${unavailableId}`);
      await expect(unavailable).toBeVisible();
      await expect(rows).toHaveCount(0);
      await page.getByRole('button', { name: '공유 보기 해제', exact: true }).click();
      await expect.poll(hash).toBe(ganttPath);
      await expect(rows).toHaveCount(issues.length);
    }

    const deleted = await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
    views.splice(views.indexOf(view), 1);
    await page.goto(`/${filteredPath}`);
    await page.reload();
    await expect(unavailable).toBeVisible();
    await expect(rows).toHaveCount(0);
    await expect(picker.locator('option:checked')).toHaveText('열 수 없는 공유 보기');
  } finally {
    for (const view of views) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    const snapshot = await request.get('/api/workspace');
    if (snapshot.ok()) {
      const current = await snapshot.json() as WorkspaceSnapshot;
      for (const issue of current.issues.filter(item => item.projectId === project.id)) {
        await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
      }
    }
  }
});

test('릴리스와 일정 조건을 공유 보기에 저장해 보드·간트·문서에서 같은 업무를 본다', async ({page, request}) => {
  test.setTimeout(85_000);
  const prefix = `릴리스 일정 ${randomUUID().slice(0, 8)}`;
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = workspace.projects[0].id;
  const items: PlanningItem[] = [];
  const issues: Issue[] = [];
  const views: string[] = [];
  let document: DocPage | undefined;
  async function plan(kind: PlanningItem['kind']) {
    const response = await request.post('/api/planning-items', { data: {projectId, kind, name: `${prefix} ${kind}`} });
    expect(response.status(), await response.text()).toBe(201);
    const item = await response.json() as PlanningItem;
    items.push(item);
    return item;
  }

  try {
    const release = await plan('release');
    const cycle = await plan('cycle');
    const schedule = { startDate: '2020-03-08', endDate: '2020-03-10' };
    const fixtures = [
      { title: `${prefix} 기간 경계`, releaseId: release.id, ...schedule },
      { title: `${prefix} 다른 사이클`, releaseId: release.id, cycleId: cycle.id, ...schedule },
      { title: `${prefix} 기간 밖`, releaseId: release.id, startDate: '2020-03-26', endDate: '2020-03-27', dueDate: '2020-03-10' },
      { title: `${prefix} 종료 미정`, releaseId: release.id, startDate: '2020-03-10' },
      { title: `${prefix} 릴리스 미지정`, ...schedule },
    ];
    for (const fields of fixtures) {
      const response = await request.post('/api/issues', { data: {projectId, ...fields} });
      expect(response.status(), await response.text()).toBe(201);
      issues.push(await response.json() as Issue);
    }
    const [overlapMatch, , , incomplete] = issues;
    const incompleteView = await createView(request, projectId, `${prefix} 미정 보기`, {
      query: prefix, status: 'all', assigneeId: 'all', type: 'all',
      planning: {releaseId: release.id, dates: {mode: 'needs_dates'}},
    });
    views.push(incompleteView.id);

    await page.setViewportSize({width: 360, height: 820});
    await page.goto(`/#/${projectId}/issues`);
    await page.getByRole('textbox', {name: '업무 검색', exact: true}).fill(prefix);
    await page.getByRole('button', {name: '계획·일정 필터', exact: true}).click();
    const filter = page.getByRole('region', {name: '계획·일정 필터', exact: true});
    await filter.getByRole('combobox', {name: '릴리스 필터', exact: true}).selectOption(`plan:${release.id}`);
    await filter.getByRole('combobox', {name: '사이클 필터', exact: true}).selectOption('none');
    await filter.getByRole('combobox', {name: '일정 조건', exact: true}).selectOption('overlap');
    const firstDay = filter.getByLabel('조회 시작일', {exact: true});
    const lastDay = filter.getByLabel('조회 종료일', {exact: true});
    await firstDay.fill('2020-03-19');
    await lastDay.fill('2020-03-18');
    await filter.getByRole('button', {name: '적용', exact: true}).click();
    await expect(filter.getByRole('alert')).toBeVisible();
    await firstDay.fill('2020-03-10');
    await filter.getByRole('button', {name: '적용', exact: true}).click();
    const list = page.locator('.issue-table');
    await expect(list.getByText(overlapMatch.title, {exact: true})).toBeVisible();
    for (const excluded of issues.slice(1)) await expect(list.getByText(excluded.title, {exact: true})).toHaveCount(0);
    await page.getByRole('button', {name: '보드', exact: true}).click();
    const cards = page.locator('.issue-board-card');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(overlapMatch.title);

    await page.getByRole('button', {name: '현재 보기 저장', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: '업무 보기 저장', exact: true});
    await dialog.getByLabel('보기 이름', {exact: true}).fill(`${prefix} 겹침 보기`);
    const save = page.waitForResponse(response => response.url().endsWith('/api/views') && response.request().method() === 'POST');
    await dialog.getByRole('button', {name: '저장', exact: true}).click();
    const savedResponse = await save;
    expect(savedResponse.status(), await savedResponse.text()).toBe(201);
    const saved = await savedResponse.json() as SavedView;
    views.push(saved.id);
    expect(saved.layout).toBe('board');
    expect(saved.filters.planning).toEqual({cycleId: null, releaseId: release.id, dates: {mode: 'overlap', from: '2020-03-10', to: '2020-03-18'}});
    await page.reload();
    const viewPicker = page.getByRole('combobox', {name: '저장된 업무 보기', exact: true});
    await viewPicker.selectOption(saved.id);
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(overlapMatch.title);

    await page.getByRole('button', {name: '간트에서 열기', exact: true}).click();
    const ganttPath = `#/${projectId}/gantt`;
    await expect.poll(() => new URL(page.url()).hash).toBe(`${ganttPath}?savedView=${saved.id}`);
    const gantt = page.getByRole('region', {name: '간트 차트', exact: true});
    await expect(gantt.locator('.gantt-row[data-issue-id]')).toHaveCount(1);
    await expect(gantt.getByRole('button', {name: `${overlapMatch.key} 일정 이동`, exact: true})).toBeVisible();
    const windowStart = page.getByLabel('간트 표시 시작일', {exact: true});
    await expect(windowStart).toHaveValue('2020-03-03');
    const criteria = page.getByRole('list', {name: '간트에 적용된 계획·일정 조건'});
    await expect(criteria).toContainText(release.name);
    await expect(criteria).toContainText('사이클 미지정');
    await page.getByRole('button', {name: '오늘 중심', exact: true}).click();
    await expect(windowStart).not.toHaveValue('2020-03-03');
    await page.getByRole('button', {name: '보기 기간으로 이동', exact: true}).click();
    await expect(windowStart).toHaveValue('2020-03-03');

    const ganttViewPicker = page.getByRole('combobox', {name: '간트 공유 보기', exact: true});
    await ganttViewPicker.selectOption(incompleteView.id);
    const incompleteRow = gantt.locator(`[data-issue-id="${incomplete.id}"]`);
    await expect(incompleteRow).toBeVisible();
    const endDate = incompleteRow.getByLabel(`${incomplete.key} 종료일`, {exact: true});
    await endDate.fill('2020-03-16');
    const scheduleSaved = page.waitForResponse(response => response.url().endsWith('/api/schedule/manual-apply') && response.request().method() === 'POST');
    await endDate.press('Enter');
    const scheduled = await scheduleSaved;
    expect(scheduled.ok(), await scheduled.text()).toBe(true);
    await expect(gantt.locator('.gantt-row[data-issue-id]')).toHaveCount(0);
    await expect(criteria).toContainText('일정 미정');

    const documentResponse = await request.post('/api/documents', {data: {projectId, title: `${prefix} 회의록`, content: {
      type: 'doc', content: [{type: 'issueList', attrs: {projectId, savedViewId: saved.id, label: saved.name}}],
    }}});
    expect(documentResponse.status(), await documentResponse.text()).toBe(201);
    document = await documentResponse.json() as DocPage;
    await page.goto(`/#/${projectId}/documents`);
    await page.reload();
    await page.getByRole('button', {name: new RegExp(`${document.title} 초안$`)}).click();
    await expect(page.getByRole('textbox', {name: '문서 제목', exact: true})).toHaveValue(document.title);
    const issueList = page.getByRole('region', {name: '업무 목록', exact: true});
    await expect(issueList).toContainText(overlapMatch.title);
    await expect(issueList).toContainText(incomplete.title);
    await expect(issueList).not.toContainText(issues[1].title);
    await expect(issueList).not.toContainText(issues[2].title);

    await page.goto(`/#/${projectId}/issues`);
    await viewPicker.selectOption(saved.id);
    await page.getByRole('button', {name: '계획·일정 필터', exact: true}).click();
    await lastDay.fill('2020-03-20');
    const declined = page.waitForEvent('dialog').then(dialog => dialog.dismiss());
    await viewPicker.selectOption(incompleteView.id);
    await declined;
    await expect(viewPicker).toHaveValue(saved.id);
    await expect(lastDay).toHaveValue('2020-03-20');
    await filter.getByRole('button', {name: '조건 지우기', exact: true}).click();
    await expect(cards).toHaveCount(issues.length);
    await page.getByRole('button', {name: '보기 수정', exact: true}).click();
    const updated = page.waitForResponse(response => response.url().endsWith(`/api/views/${saved.id}`) && response.request().method() === 'PATCH');
    await page.getByRole('dialog', {name: '저장된 보기 수정', exact: true}).getByRole('button', {name: '저장', exact: true}).click();
    const updatedResponse = await updated;
    expect(updatedResponse.ok(), await updatedResponse.text()).toBe(true);
    expect((await updatedResponse.json() as SavedView).filters.planning).toBeUndefined();
  } finally {
    if (document) {
      const response = await request.delete(`/api/documents/${document.id}`);
      if (response.ok()) await request.delete(`/api/trash/${(await response.json()).trashEntryId}`);
    }
    for (const view of await (await request.get(`/api/views?projectId=${projectId}`)).json() as SavedView[]) {
      if (views.includes(view.id)) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    }
    for (const issue of issues) {
      const response = await request.delete(`/api/issues/${issue.id}`);
      if (response.ok()) await request.delete(`/api/trash/${(await response.json()).trashEntryId}`);
    }
    for (const item of items) await request.delete(`/api/planning-items/${item.id}?expectedVersion=${item.version}`);
  }
});

test('여러 릴리스와 지정 여부 필터를 업무에서 편집하고 간트 공유 보기에서 그대로 연다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const prefix = `릴리스 보기 ${randomUUID().slice(0, 8)}`;
  const { projects: [project] } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const releases: PlanningItem[] = [];
  const issues: Issue[] = [];
  let view: SavedView | undefined;
  const list = page.locator('.issue-table');
  const listRow = (issue: Issue) => list.locator(`[data-issue-id="${issue.id}"]`);
  const gantt = page.getByRole('region', { name: '간트 차트', exact: true });
  const ganttRow = (issue: Issue) => gantt.locator(`[data-issue-id="${issue.id}"]`);
  async function createRelease(label: string) {
    const response = await request.post('/api/planning-items', { data: { projectId: project.id, kind: 'release', name: `${prefix} ${label}` } });
    expect(response.status(), await response.text()).toBe(201);
    const release = await response.json() as PlanningItem;
    releases.push(release);
    return release;
  }
  async function createIssue(label: string, releaseId: string | null, dueDate: string | null) {
    const response = await request.post('/api/issues', { data: {
      projectId: project.id, title: `${prefix} ${label}`, releaseId, dueDate, startDate: '2026-11-25', endDate: '2026-11-26',
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }

  try {
    const alpha = await createRelease('A');
    const beta = await createRelease('B');
    const gamma = await createRelease('C');
    const a = await createIssue('첫째 업무', alpha.id, '2026-11-26');
    const b = await createIssue('둘째 업무', beta.id, null);
    const c = await createIssue('셋째 업무', gamma.id, '2026-11-26');
    const unassigned = await createIssue('릴리스 미지정 업무', null, '2026-11-26');
    view = await createView(request, project.id, `${prefix} 공유`, {
      query: prefix, status: 'all', assigneeId: 'all', type: 'all', planning: { releaseFilter: { kind: 'any', ids: [alpha.id, beta.id] } },
    });
    await page.goto(`/#/${project.id}/issues`);
    const viewPicker = page.getByRole('combobox', { name: '저장된 업무 보기', exact: true });
    await viewPicker.selectOption(view.id);
    await expect(listRow(a)).toBeVisible();
    await expect(listRow(b)).toBeVisible();
    await expect(listRow(c)).toHaveCount(0);
    await expect(listRow(unassigned)).toHaveCount(0);

    const toggle = page.getByRole('button', { name: '계획·일정 필터', exact: true });
    const editor = page.getByRole('region', { name: '계획·일정 필터', exact: true });
    const selector = editor.getByRole('combobox', { name: '릴리스 필터', exact: true });
    const schedule = editor.getByRole('combobox', { name: '일정 조건', exact: true });
    const apply = editor.getByRole('button', { name: '적용', exact: true });
    const selection = editor.getByRole('group', { name: '선택할 릴리스', exact: true });
    const choice = (release: PlanningItem) => selection.getByRole('checkbox', { name: release.name, exact: true });
    await toggle.click();
    await expect(selector).toHaveValue('any');
    await expect(choice(alpha)).toBeChecked();
    await expect(choice(beta)).toBeChecked();
    await expect(choice(gamma)).not.toBeChecked();
    await choice(beta).uncheck();
    await apply.click();
    await expect(listRow(a)).toBeVisible();
    await expect(listRow(b)).toHaveCount(0);
    await toggle.click();
    await expect(selector).toHaveValue(`plan:${alpha.id}`);
    await selector.selectOption({ label: '여러 릴리스' });
    await expect(choice(alpha)).toBeChecked();
    await choice(beta).check();
    await schedule.selectOption('due_set');
    await apply.click();
    await expect(listRow(a)).toBeVisible();
    await expect(listRow(b)).toHaveCount(0);
    await expect(listRow(c)).toHaveCount(0);

    await toggle.click();
    await expect(choice(alpha)).toBeChecked();
    await expect(choice(beta)).toBeChecked();
    await choice(alpha).uncheck();
    await choice(gamma).check();
    await schedule.selectOption('all');
    await apply.click();
    await expect(listRow(b)).toBeVisible();
    await expect(listRow(c)).toBeVisible();
    await expect(listRow(a)).toHaveCount(0);
    await expect(listRow(unassigned)).toHaveCount(0);

    const savePath = `/api/views/${view.id}`;
    await page.getByRole('button', { name: '보기 수정', exact: true }).click();
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === savePath && response.request().method() === 'PATCH');
    await page.getByRole('dialog', { name: '저장된 보기 수정', exact: true }).getByRole('button', { name: '저장', exact: true }).click();
    const savedResponse = await saved;
    expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
    view = await savedResponse.json() as SavedView;
    expect(view.filters.planning?.releaseFilter).toEqual({ kind: 'any', ids: [beta.id, gamma.id].sort() });
    expect(view.filters.planning?.releaseId).toBeUndefined();

    await toggle.click();
    await selector.selectOption({ label: '지정됨' });
    await apply.click();
    const applied = page.getByRole('list', { name: '적용된 계획·일정 조건', exact: true });
    await expect(applied).toContainText('릴리스 지정됨');
    await expect(listRow(a)).toBeVisible();
    await expect(listRow(b)).toBeVisible();
    await expect(listRow(c)).toBeVisible();
    await expect(listRow(unassigned)).toHaveCount(0);

    await page.reload();
    await expect(viewPicker).toHaveValue(view.id);
    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    await expect(ganttRow(b)).toBeVisible();
    await expect(ganttRow(c)).toBeVisible();
    await expect(ganttRow(a)).toHaveCount(0);
    await expect(ganttRow(unassigned)).toHaveCount(0);
    const criteria = page.getByRole('list', { name: '간트에 적용된 계획·일정 조건', exact: true });
    await expect(criteria).toContainText(beta.name);
    await expect(criteria).toContainText(gamma.name);
    await page.reload();
    await expect(ganttRow(b)).toBeVisible();
    await expect(ganttRow(c)).toBeVisible();
    await expect(ganttRow(unassigned)).toHaveCount(0);
  } finally {
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of issues) {
      const response = await request.delete(`/api/issues/${issue.id}`);
      if (response.ok()) await request.delete(`/api/trash/${(await response.json()).trashEntryId}`);
    }
    for (const release of releases) await request.delete(`/api/planning-items/${release.id}?expectedVersion=${release.version}`);
  }
});
