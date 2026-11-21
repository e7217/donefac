import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Page, type Response } from '@playwright/test';
import type { CustomFieldDefinition, CustomFieldValue, Issue, IssueFieldBreakdown, IssueFieldBreakdownPage, Project, ProjectIssueSchema, ProjectWorkflow, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function read<T>(response: APIResponse | Response, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(expected);
  return JSON.parse(body) as T;
}

function postAt(page: Page, pathname: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST');
}

test('저장된 보기로 숫자 필드를 집계하고 변경이 발생하면 다시 조회한다', async ({ page, request }) => {
  const key = `FB${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const projectResponse = await request.post('/api/projects', { data: { key, name: `필드 집계 ${key}` } });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json() as Project;
  const schemaPath = `/api/projects/${project.id}/issue-schema`;
  const schema = await (await request.get(schemaPath)).json() as ProjectIssueSchema;
  const fields: CustomFieldDefinition[] = [
    { id: 'metric', name: '검증 점수', description: '', kind: 'number', required: false, issueTypes: ['작업'], options: [], archived: false },
    { id: 'approved', name: '검토 완료', description: '', kind: 'checkbox', required: false, issueTypes: [], options: [], archived: false },
  ];
  const patched = await request.patch(schemaPath, { data: { ...schema, expectedVersion: schema.version, fields } });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  const created: Issue[] = [];
  async function createIssue(suffix: string, type: string, customFields: Record<string, CustomFieldValue>) {
    const response = await request.post('/api/issues', { data: { projectId: project.id, title: `집계 대상 ${key} ${suffix}`, type, customFields } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    return issue;
  }

  let view: SavedView | undefined;
  try {
    const zero = await createIssue('영점', '작업', { metric: 0, approved: false });
    await createIssue('양수', '작업', { metric: 20, approved: false });
    await createIssue('값 없음', '작업', { approved: false });
    await createIssue('미적용', '버그', { approved: false });
    await createIssue('선택 제외', '작업', { metric: 99, approved: true });
    const viewResponse = await request.post('/api/views', { data: {
      projectId: project.id, name: '검토 대기', layout: 'list', filters: {
        query: '집계 대상', status: 'all', assigneeId: 'all', type: 'all',
        fieldFilter: { match: 'all', rules: [{ fieldId: 'approved', operator: 'equals', value: false }] },
      },
    } });
    expect(viewResponse.status(), await viewResponse.text()).toBe(201);
    view = await viewResponse.json() as SavedView;

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/reports`);
    await page.getByRole('tab', { name: '필드 집계', exact: true }).click();
    const form = page.getByRole('form', { name: '필드 집계 조회 조건' });
    const bounds = await form.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await form.getByLabel('집계할 사용자 정의 필드').selectOption('metric');
    const viewSelect = form.getByLabel('필드 집계 저장된 보기');
    await viewSelect.selectOption(view.id);

    page.once('dialog', popup => void popup.dismiss());
    await page.getByRole('tab', { name: '작업 시간', exact: true }).click();
    await expect(viewSelect).toHaveValue(view.id);
    const query = form.getByRole('button', { name: '필드 집계 조회', exact: true });
    const summaryPath = `/api/projects/${project.id}/field-breakdown`;
    const summaryResponse = page.waitForResponse(response => response.url().endsWith(summaryPath));
    await query.click();
    const summary = await (await summaryResponse).json() as IssueFieldBreakdown;
    expect(summary).toMatchObject({
      savedView: { id: view.id }, totalIssues: 4, applicableIssues: 3, populatedIssues: 2,
      missingIssues: 1, notApplicableIssues: 1, numeric: { min: 0, max: 20, average: 10, sum: 20 },
    });
    const statistics = page.getByRole('region', { name: '숫자 필드 통계' });
    await expect(statistics).toContainText('평균10');
    const zeroGroup = page.getByRole('button', { name: '그룹 0 업무 보기', exact: true });
    await expect(zeroGroup.locator('xpath=ancestor::tr')).toContainText('25%');
    await zeroGroup.click();
    const groupIssues = page.getByRole('region', { name: '필드 집계 그룹 업무' });
    const issueLink = groupIssues.getByRole('button', { name: `${zero.key} ${zero.title}`, exact: true });
    await issueLink.click();
    const drawer = page.getByRole('dialog', { name: zero.title, exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '업무 상세 닫기' }).click();

    const changedTitle = `${zero.title} 수정됨`;
    const changed = await request.patch(`/api/issues/${zero.id}`, { data: { expectedVersion: zero.version, title: changedTitle } });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    const drillResponse = page.waitForResponse(response => response.url().endsWith(`${summaryPath}/issues`));
    await zeroGroup.click();
    expect((await drillResponse).status()).toBe(409);
    await expect(page.getByRole('status').filter({ hasText: '집계 이후' })).toBeVisible();
    await expect(zeroGroup).toBeDisabled();
    await expect(issueLink).toBeDisabled();

    await query.click();
    await expect(zeroGroup).toBeEnabled();
    await zeroGroup.click();
    await groupIssues.getByRole('button', { name: `${zero.key} ${changedTitle}`, exact: true }).click();
    const changedDrawer = page.getByRole('dialog', { name: changedTitle, exact: true });
    await expect(changedDrawer).toBeVisible();
    await changedDrawer.getByRole('button', { name: '업무 상세 닫기' }).click();
    await form.getByRole('combobox', { name: '비교 기준', exact: true }).selectOption('status');
    const comparing = postAt(page, summaryPath);
    await query.click();
    const response = await comparing;
    expect(response.request().postDataJSON()).toEqual({ fieldId: 'metric', savedViewId: view.id, comparisonBy: 'status' });
    const matrix = await read<IssueFieldBreakdown>(response);
    expect(matrix.numeric?.min).toBe(0);
    const state = matrix.comparison?.columns.find(column => column.count === 4);
    expect(state).toBeTruthy();
    const grid = page.getByRole('table', { name: '필드 교차 집계 표', exact: true });
    await grid.getByRole('button', { name: `0 × ${state!.label} 업무 보기 · 1개`, exact: true }).click();
    await expect(groupIssues.getByRole('button', { name: `${zero.key} ${changedTitle}`, exact: true })).toBeVisible();
  } finally {
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of created) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('360px의 사용자 정의 필드가 없는 프로젝트에서 상태와 담당자 교차표의 정확한 업무를 연다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const keyword = `보고서 대상 ${suffix}`;
  const project = await read<Project>(await request.post('/api/projects', { data: { key: `MX${suffix}`, name: `기본 필드 분포 ${suffix}` } }), 201);
  const { users: [assignee, other] } = await read<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const schema = await read<ProjectIssueSchema>(await request.get(`/api/projects/${project.id}/issue-schema`));
  expect(schema.fields).toEqual([]);
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const current = await read<ProjectWorkflow>(await request.get(workflowPath));
  const state = { id: 'matrix_review', label: `변경 검토 대기 ${suffix}`, color: '#557799', category: 'review' };
  const workflow = await read<ProjectWorkflow>(await request.patch(workflowPath, { data: { ...current, expectedVersion: current.version,
    statuses: [...current.statuses, state],
  } }));
  const doneLabel = workflow.statuses.find(status => status.id === 'done')!.label;
  const issues: Issue[] = [];
  let saved: SavedView | undefined;
  async function create(title: string, status: string, assigneeId: string | null) {
    const issue = await read<Issue>(await request.post('/api/issues', { data: { projectId: project.id, title, status, assigneeId } }), 201);
    issues.push(issue);
    return issue;
  }
  try {
    const reviewAssigned = await create(`${keyword} 담당 있음`, state.id, assignee.id);
    const reviewUnassigned = await create(`${keyword} 담당 미정`, state.id, null);
    const doneUnassigned = await create(`${keyword} 완료 담당 미정`, 'done', null);
    await create(`${keyword} 완료 다른 담당자`, 'done', other.id);
    await create(`저장된 보기에서 제외 ${suffix}`, state.id, assignee.id);
    saved = await read<SavedView>(await request.post('/api/views', { data: {
      projectId: project.id, layout: 'board', name: `분포용 공유 보드 ${suffix}`,
      filters: { query: keyword, status: 'all', assigneeId: 'all', type: 'all' },
    } }), 201);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/reports`);
    await page.getByRole('tab', { name: '필드 집계', exact: true }).click();
    const form = page.getByRole('form', { name: '필드 집계 조회 조건' });
    const primary = form.getByRole('combobox', { name: '집계 기준', exact: true });
    const comparison = form.getByRole('combobox', { name: '비교 기준', exact: true });
    const view = form.getByRole('combobox', { name: '필드 집계 저장된 보기', exact: true });
    await primary.selectOption('status');
    await expect(form.getByRole('combobox', { name: '집계할 사용자 정의 필드', exact: true })).toHaveCount(0);
    await comparison.selectOption('assignee');
    await view.selectOption(saved.id);
    const path = `/api/projects/${project.id}/field-breakdown`;
    const payload = { groupBy: 'status', comparisonBy: 'assignee', savedViewId: saved.id };
    const query = form.getByRole('button', { name: '필드 집계 조회', exact: true });
    const submit = async () => {
      const requested = postAt(page, path);
      await query.click();
      const response = await requested;
      expect(response.request().postDataJSON()).toEqual(payload);
      return read<IssueFieldBreakdown>(response);
    };
    const snapshot = await submit();
    expect(snapshot.totalIssues).toBe(4);
    const row = snapshot.groups.find(item => item.label === state.label);
    const column = snapshot.comparison?.columns.find(item => item.label === '미지정');
    expect(row).toBeTruthy();
    expect(column).toBeTruthy();
    expect(snapshot.comparison?.counts[row!.id]?.[column!.id]).toBe(1);

    const scroll = page.getByRole('region', { name: '교차 집계 표 스크롤', exact: true });
    const matrix = scroll.getByRole('table', { name: '필드 교차 집계 표', exact: true });
    await expect(matrix.getByRole('rowheader', { name: '전체 조회 범위', exact: true })).toBeVisible();
    await expect(matrix.getByRole('columnheader', { name: other.name, exact: true })).toBeVisible();
    const dimensions = await scroll.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
      overflow: getComputedStyle(element).overflowX, page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(dimensions.width).toBeLessThanOrEqual(360);
    expect(dimensions.content).toBeGreaterThan(dimensions.width);
    expect(dimensions.overflow).toMatch(/auto|scroll/);
    expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);

    const cell = matrix.getByRole('button', { name: `${state.label} × 미지정 업무 보기 · 1개`, exact: true });
    const getting = postAt(page, `${path}/issues`);
    await cell.click();
    const response = await getting;
    expect(response.request().postDataJSON()).toMatchObject({ ...payload, revision: snapshot.revision, bucketId: row!.id, comparisonBucketId: column!.id });
    const selected = await read<IssueFieldBreakdownPage>(response);
    expect(selected.issues.map(issue => issue.id)).toEqual([reviewUnassigned.id]);
    const panel = page.getByRole('region', { name: '필드 집계 그룹 업무' });
    await expect(panel.getByRole('heading', { name: `${state.label} × 미지정`, exact: true })).toBeFocused();
    await expect(panel).not.toContainText(doneUnassigned.title);
    await panel.getByRole('button', { name: `${reviewUnassigned.key} ${reviewUnassigned.title}`, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: reviewUnassigned.title, exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '업무 상세 닫기' }).click();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');

    await read<Issue>(await request.patch(`/api/issues/${reviewUnassigned.id}`, { data: {
      expectedVersion: reviewUnassigned.version, assigneeId: assignee.id,
    } }));
    const outdated = postAt(page, `${path}/issues`);
    await cell.click();
    expect((await outdated).status()).toBe(409);
    await expect(page.getByRole('status').filter({ hasText: '집계 이후' })).toBeVisible();
    await expect(cell).toBeDisabled();

    const latest = await submit();
    expect(latest.revision).not.toBe(snapshot.revision);
    expect(latest.comparison?.counts[row!.id]?.[column!.id]).toBeUndefined();
    const absent = matrix.getByRole('row', { name: new RegExp(state.label) });
    await expect(absent.getByRole('cell', { name: '0', exact: true }).first()).toBeVisible();
    await expect(cell).toHaveCount(0);
    await matrix.getByRole('button', { name: `${state.label} × ${assignee.name} 업무 보기 · 2개`, exact: true }).click();
    await expect(panel).toContainText(reviewAssigned.title);
    await expect(panel).toContainText(reviewUnassigned.title);
    await expect(panel).not.toContainText(doneUnassigned.title);
    await expect(matrix.getByRole('button', { name: `${doneLabel} × 미지정 업무 보기 · 1개`, exact: true })).toBeVisible();
  } finally {
    if (saved) await request.delete(`/api/views/${saved.id}?expectedVersion=${saved.version}`);
    for (const issue of issues) {
      const archived = await request.delete(`/api/issues/${issue.id}`);
      if (archived.ok()) {
        const { trashEntryId } = await archived.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});
