import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Issue, Project, ProjectIssueSchema, SavedView, SavedViewState, WorkspaceSnapshot } from '../../shared/types';

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
    const apply = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/schedule/apply' && response.request().method() === 'POST');
    await endDate.press('Enter');
    const update = await apply;
    expect(update.ok(), await update.text()).toBeTruthy();
    expect(update.request().postDataJSON().changes).toEqual([
      { id: matched.id, expectedVersion: matched.version, startDate: null, endDate: plannedEnd },
    ]);
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
