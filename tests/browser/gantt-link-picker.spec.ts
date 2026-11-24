import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Dependency, Issue, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot } from '../../shared/types';

const workspace = async (request: APIRequestContext): Promise<WorkspaceSnapshot> => {
  const response = await request.get('/api/workspace');
  expect(response.ok()).toBeTruthy();
  return response.json();
};

function dateAt(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function createIssue(
  request: APIRequestContext,
  projectId: string,
  title: string,
  issues: Issue[],
  startDate: string | null,
  endDate: string | null,
): Promise<Issue> {
  const response = await request.post('/api/issues', { data: { projectId, title, startDate, endDate } });
  expect(response.status(), await response.text()).toBe(201);
  const issue = await response.json() as Issue;
  issues.push(issue);
  return issue;
}

async function openChart(page: Page, projectId: string, search: string) {
  await page.goto(`/#/${projectId}/gantt`);
  await page.getByLabel('간트 업무 검색', { exact: true }).fill(search);
  return {
    chart: page.getByRole('region', { name: '간트 차트', exact: true }),
    picker: page.getByRole('button', { name: '차트에서 연결', exact: true }),
  };
}

function countDependencyWrites(page: Page) {
  const writes: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/dependencies(?:\/|$)/.test(path) && request.method() !== 'GET') {
      writes.push(request.method());
    }
  });
  return writes;
}

function waitPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

test('360px에서 막대로 연결할 때 후행 날짜 초안과 연결을 함께 검토하고 다른 행 입력을 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const project = (await workspace(request)).projects[0];
  const prefix = `간트 날짜 함께 연결 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  try {
    const predecessor = await createIssue(request, project.id, `${prefix} 선행`, issues, dateAt(1), dateAt(3));
    const successor = await createIssue(request, project.id, `${prefix} 후행`, issues, dateAt(6), dateAt(9));
    const { chart, picker } = await openChart(page, project.id, prefix);
    const predecessorEnd = chart.getByLabel(`${predecessor.key} 종료일`, { exact: true });
    const successorStart = chart.getByLabel(`${successor.key} 시작일`, { exact: true });
    const successorEnd = chart.getByLabel(`${successor.key} 종료일`, { exact: true });
    const draftEnd = dateAt(5), draftStart = dateAt(8), draftFinish = dateAt(10);
    await predecessorEnd.fill(draftEnd);
    await successorStart.fill(draftStart);
    await successorEnd.fill(draftFinish);

    const dialog = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    async function pickPair() {
      await picker.click();
      await chart.getByRole('button', { name: `${predecessor.key} 선행 종료일 선택`, exact: true }).click();
      await chart.getByRole('button', { name: `${successor.key} 후행 종료일 선택`, exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(`${successor.key} · ${successor.title}`, { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('시작일', { exact: true })).toHaveValue(draftStart);
      await expect(dialog.getByLabel('종료일', { exact: true })).toHaveValue(draftFinish);
      await expect(dialog.getByLabel('선후행 연결 작업', { exact: true })).toHaveValue('add');
      await expect(dialog.getByLabel('연결 방향', { exact: true })).toHaveValue('predecessor');
      await expect(dialog.getByLabel('연결 유형', { exact: true })).toHaveValue('FF');
      await expect(dialog.getByText(`${predecessor.key}의 날짜 입력은 간트에 남습니다.`, { exact: false })).toBeVisible();
    }

    await pickPair();
    page.once('dialog', prompt => prompt.accept());
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(picker).toBeFocused();
    await expect(predecessorEnd).toHaveValue(draftEnd);
    await expect(successorStart).toHaveValue(draftStart);
    const before = await workspace(request);
    expect(before.issues.find(issue => issue.id === successor.id)).toEqual(successor);
    expect(before.dependencies.find(link => link.predecessorId === predecessor.id)).toBeUndefined();

    await pickPair();
    await dialog.getByLabel('간격 (근무일)', { exact: true }).fill('1');
    const pendingPreview = waitPost(page, '/api/schedule/row-edit/preview');
    await dialog.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const previewResponse = await pendingPreview;
    expect(previewResponse.ok(), await previewResponse.text()).toBeTruthy();
    expect(previewResponse.request().postDataJSON()).toMatchObject({
      issue: { id: successor.id, expectedVersion: successor.version }, changes: { startDate: draftStart, endDate: draftFinish },
      dependency: { action: 'add', relatedIssue: { id: predecessor.id, expectedVersion: predecessor.version }, direction: 'predecessor', type: 'FF', lagDays: 1 },
    });
    const preview = await previewResponse.json() as SchedulePastePreview;
    expect(preview.changes.map(change => change.id)).toEqual([successor.id]);
    await expect(dialog.getByRole('heading', { name: `${predecessor.key} → ${successor.key}` })).toBeVisible();
    const pendingApply = waitPost(page, '/api/schedule/row-edit/apply');
    await dialog.getByRole('button', { name: '일정과 연결 적용', exact: true }).click();
    const appliedResponse = await pendingApply;
    expect(appliedResponse.ok(), await appliedResponse.text()).toBeTruthy();
    const applied = await appliedResponse.json() as SchedulePasteApplyResult;
    expect(applied.updated.map(issue => issue.id)).toEqual([successor.id]);
    expect(applied.dependencyChanges).toBe(1);
    await expect(dialog).toHaveCount(0);
    await expect(predecessorEnd).toHaveValue(draftEnd);
    await expect(chart.getByRole('button', { name: `${successor.key} 날짜 저장`, exact: true })).toHaveCount(0);
    const after = await workspace(request);
    expect(after.issues.find(issue => issue.id === predecessor.id)).toEqual(predecessor);
    expect(after.issues.find(issue => issue.id === successor.id)).toMatchObject({ startDate: draftStart, endDate: draftFinish });
    expect(after.dependencies.find(link => link.predecessorId === predecessor.id)).toMatchObject({ successorId: successor.id, type: 'FF', lagDays: 1 });

    const pendingUndo = waitPost(page, '/api/schedule/undo');
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    expect((await pendingUndo).ok()).toBeTruthy();
    await expect(predecessorEnd).toHaveValue(draftEnd);
    await expect(successorStart).toHaveValue(successor.startDate!);
    await expect(successorEnd).toHaveValue(successor.endDate!);
    expect((await workspace(request)).dependencies.find(link => link.predecessorId === predecessor.id)).toBeUndefined();
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('선택 업무의 날짜를 유지해 숨은 업무를 찾고 독립 연결 창을 닫을 때도 날짜를 보존한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const project = (await workspace(request)).projects[0];
  const prefix = `간트 선택 날짜 유지 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  try {
    const anchor = await createIssue(request, project.id, `${prefix} 선택 업무`, issues, dateAt(1), dateAt(3));
    const hidden = await createIssue(request, project.id, `${prefix} 숨은 업무`, issues, dateAt(6), dateAt(8));
    const { chart } = await openChart(page, project.id, anchor.title);
    const end = chart.getByLabel(`${anchor.key} 종료일`, { exact: true });
    const draftEnd = dateAt(4);
    await end.fill(draftEnd);

    await page.getByRole('button', { name: '업무 연결', exact: true }).click();
    const standalone = page.getByRole('dialog', { name: '선행·후행 업무 연결', exact: true });
    await standalone.getByLabel('선행 업무', { exact: true }).selectOption(anchor.id);
    page.once('dialog', prompt => prompt.accept());
    await standalone.getByRole('button', { name: '취소', exact: true }).click();
    await expect(standalone).toHaveCount(0);
    await expect(end).toHaveValue(draftEnd);
    await expect(chart.getByRole('checkbox', { name: `${hidden.key} 선택`, exact: true })).toHaveCount(0);

    await chart.getByRole('checkbox', { name: `${anchor.key} 선택`, exact: true }).check();
    const anchorLink = page.getByRole('button', { name: '선택 업무에서 연결', exact: true });
    await anchorLink.click();
    const dialog = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    await expect(dialog.getByLabel('종료일', { exact: true })).toHaveValue(draftEnd);
    const search = dialog.getByRole('textbox', { name: '연결할 업무 검색', exact: true });
    await expect(search).toBeFocused();
    await search.fill(hidden.key);
    await search.press('Enter');
    await expect(dialog.getByLabel('연결 방향', { exact: true })).toHaveValue('successor');
    const pendingPreview = waitPost(page, '/api/schedule/row-edit/preview');
    await dialog.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const preview = await pendingPreview;
    expect(preview.ok(), await preview.text()).toBeTruthy();
    expect(preview.request().postDataJSON()).toMatchObject({ issue: { id: anchor.id }, changes: { endDate: draftEnd },
      dependency: { action: 'add', direction: 'successor', relatedIssue: { id: hidden.id } } });
    const pendingApply = waitPost(page, '/api/schedule/row-edit/apply');
    await dialog.getByRole('button', { name: '일정과 연결 적용', exact: true }).click();
    expect((await pendingApply).ok()).toBeTruthy();
    await expect(dialog).toHaveCount(0);
    await expect(anchorLink).toBeFocused();
    const saved = await workspace(request);
    expect(saved.issues.find(issue => issue.id === anchor.id)).toMatchObject({ endDate: draftEnd });
    expect(saved.dependencies.find(link => link.predecessorId === anchor.id)).toMatchObject({ successorId: hidden.id, type: 'FS' });
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('전체 간트에서 프로젝트 간 차단을 검토하고 닫아도 행의 날짜 입력은 남는다', async ({ page, request }) => {
  const { projects: [first, second] } = await workspace(request);
  const prefix = `교차 연결 날짜 유지 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  try {
    const source = await createIssue(request, first.id, `${prefix} 원인`, issues, dateAt(1), dateAt(3));
    const target = await createIssue(request, second.id, `${prefix} 대상`, issues, dateAt(6), dateAt(8));
    await page.goto(`/#/${first.id}/gantt?${new URLSearchParams({ scope: 'team', ganttQ: prefix })}`);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const end = chart.getByLabel(`${source.key} 종료일`, { exact: true });
    const draftEnd = dateAt(4);
    await end.fill(draftEnd);
    const pickPair = async () => {
      await page.getByRole('button', { name: '차트에서 연결', exact: true }).click();
      await chart.getByRole('button', { name: `${source.key} 선행 업무 선택`, exact: true }).click();
      await chart.getByRole('button', { name: `${target.key} 후행 업무 선택`, exact: true }).click();
    };
    const panel = page.getByRole('region', { name: '프로젝트 간 차단', exact: true });
    const form = panel.getByRole('form', { name: '프로젝트 간 차단 관계 추가', exact: true });
    await pickPair();
    await expect(form.getByRole('combobox', { name: '차단하는 업무', exact: true })).toHaveValue(source.id);
    await form.getByRole('searchbox', { name: '원인 업무 검색', exact: true }).fill(source.key);
    page.once('dialog', prompt => prompt.accept());
    await panel.getByRole('button', { name: '프로젝트 간 차단 닫기', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(end).toHaveValue(draftEnd);

    await pickPair();
    const pending = waitPost(page, '/api/schedule/team-blockers');
    await form.getByRole('button', { name: '차단 관계 저장', exact: true }).click();
    expect((await pending).status()).toBe(201);
    await expect(form).toHaveCount(0);
    await expect(end).toHaveValue(draftEnd);
    expect((await workspace(request)).issues.find(issue => issue.id === source.id)).toEqual(source);
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('간트 막대의 시작점과 종료점을 선택하고 검토한 연결만 저장한다', async ({ page, request }) => {
  const project = (await workspace(request)).projects[0];
  const prefix = `간트 연결점 검증 ${randomUUID()}`;
  const issues: Issue[] = [];
  try {
    const predecessor = await createIssue(request, project.id, `${prefix} 선행`, issues, dateAt(1), dateAt(3));
    const successor = await createIssue(request, project.id, `${prefix} 후행`, issues, dateAt(4), dateAt(6));
    const writes = countDependencyWrites(page);
    const { chart, picker } = await openChart(page, project.id, prefix);
    await expect(picker).toHaveAttribute('aria-pressed', 'false');
    await picker.click();
    await expect(picker).toHaveAttribute('aria-pressed', 'true');
    const instructions = page.getByRole('region', { name: '차트 연결 선택', exact: true }).getByRole('status');
    await expect(instructions).toContainText('선행 업무를 선택하세요.');

    const start = chart.getByRole('button', { name: `${predecessor.key} 선행 시작일 선택`, exact: true });
    await start.click();
    await expect(instructions).toContainText(predecessor.key);
    await expect(instructions).toContainText('후행 업무를 선택하세요.');
    expect(writes).toEqual([]);

    await chart.getByRole('button', { name: `${successor.key} 후행 종료일 선택`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '선행·후행 업무 연결', exact: true });
    await expect(dialog.getByLabel('선행 업무', { exact: true })).toHaveValue(predecessor.id);
    await expect(dialog.getByLabel('후행 업무', { exact: true })).toHaveValue(successor.id);
    await expect(dialog.getByLabel('연결 유형', { exact: true })).toHaveValue('SF');
    await dialog.getByLabel('추가 간격 근무일', { exact: true }).fill('1');
    expect(writes).toEqual([]);
    expect((await workspace(request)).dependencies.find(link => link.predecessorId === predecessor.id)).toBeUndefined();

    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dependencies' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '업무 연결', exact: true }).click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({ predecessorId: predecessor.id, successorId: successor.id, type: 'SF', lagDays: 1 });
    const dependency = await response.json() as Dependency;
    await expect(dialog).toHaveCount(0);
    await expect(picker).toBeFocused();
    const connector = chart.locator(`[data-dependency-id="${dependency.id}"]`);
    await expect(connector).toHaveAttribute('data-dependency-type', 'SF');
    await expect(connector).toHaveAttribute('data-predecessor-anchor', 'startDate');
    await expect(connector).toHaveAttribute('data-successor-anchor', 'endDate');

    await picker.click();
    await chart.getByRole('button', { name: `${predecessor.key} 선행 종료일 선택`, exact: true }).click();
    await chart.getByRole('button', { name: `${successor.key} 후행 시작일 선택`, exact: true }).click();
    const edit = page.getByRole('dialog', { name: '업무 연결 수정', exact: true });
    await expect(edit.getByLabel('연결 유형', { exact: true })).toHaveValue('FS');
    await expect(edit.getByLabel('추가 간격 근무일', { exact: true })).toHaveValue('1');
    expect(writes).toEqual(['POST']);
    page.once('dialog', confirmation => confirmation.accept());
    await edit.getByRole('button', { name: '취소', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(picker).toBeFocused();

    const saved = await workspace(request);
    expect(saved.dependencies.filter(link => link.predecessorId === predecessor.id)).toEqual([dependency]);
    for (const issue of issues) {
      expect(saved.issues.find(item => item.id === issue.id)).toMatchObject({ startDate: issue.startDate, endDate: issue.endDate });
    }
    expect(writes).toEqual(['POST']);
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('360px에서 날짜 없는 행을 키보드로 선택하고 기존 연결의 유형과 간격을 유지해 연다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const project = (await workspace(request)).projects[0];
  const prefix = `날짜 없는 연결 검증 ${randomUUID()}`;
  const issues: Issue[] = [];
  try {
    const predecessor = await createIssue(request, project.id, `${prefix} 선행`, issues, null, null);
    const successor = await createIssue(request, project.id, `${prefix} 후행`, issues, null, null);
    const seeded = await request.post('/api/dependencies', {
      data: { predecessorId: predecessor.id, successorId: successor.id, type: 'SS', lagDays: -2 },
    });
    expect(seeded.status(), await seeded.text()).toBe(201);
    const dependency = await seeded.json() as Dependency;
    const writes = countDependencyWrites(page);
    const { chart, picker } = await openChart(page, project.id, prefix);

    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    const newIssue = page.getByRole('form', { name: '간트에서 업무 만들기', exact: true });
    const title = newIssue.getByLabel('추가할 업무 제목', { exact: true });
    await title.fill('보존할 간트 초안');
    page.once('dialog', confirmation => confirmation.dismiss());
    await picker.click();
    await expect(picker).toHaveAttribute('aria-pressed', 'false');
    await expect(title).toHaveValue('보존할 간트 초안');
    page.once('dialog', confirmation => confirmation.accept());
    await newIssue.getByRole('button', { name: '취소', exact: true }).click();
    await expect(newIssue).toHaveCount(0);

    const choosePredecessor = chart.getByRole('button', { name: `${predecessor.key} 선행 업무 선택`, exact: true });
    const chooseSuccessor = chart.getByRole('button', { name: `${successor.key} 후행 업무 선택`, exact: true });
    await picker.press('Enter');
    await choosePredecessor.press('Enter');
    await expect(chooseSuccessor).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveAttribute('aria-pressed', 'false');
    await expect(picker).toBeFocused();
    expect(writes).toEqual([]);

    await picker.press('Enter');
    await choosePredecessor.press('Enter');
    await expect(chooseSuccessor).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '업무 연결 수정', exact: true });
    await expect(dialog.getByLabel('선행 업무', { exact: true })).toHaveValue(predecessor.id);
    await expect(dialog.getByLabel('후행 업무', { exact: true })).toHaveValue(successor.id);
    await expect(dialog.getByLabel('연결 유형', { exact: true })).toHaveValue('SS');
    await expect(dialog.getByLabel('추가 간격 근무일', { exact: true })).toHaveValue('-2');
    expect(writes).toEqual([]);
    expect((await workspace(request)).dependencies.filter(link => link.predecessorId === predecessor.id)).toEqual([dependency]);

    await dialog.getByLabel('추가 간격 근무일', { exact: true }).fill('2');
    const updated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dependencies/${dependency.id}` && response.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: '연결 변경 저장', exact: true }).click();
    const response = await updated;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ expectedVersion: dependency.version ?? 1, type: 'SS', lagDays: 2 });
    await expect(dialog).toHaveCount(0);
    await expect(picker).toBeFocused();

    const saved = await workspace(request);
    expect(saved.dependencies.filter(link => link.predecessorId === predecessor.id)).toEqual([
      expect.objectContaining({ id: dependency.id, successorId: successor.id, type: 'SS', lagDays: 2 }),
    ]);
    for (const issue of issues) {
      expect(saved.issues.find(item => item.id === issue.id)).toMatchObject({ startDate: null, endDate: null });
    }
    expect(writes).toEqual(['PATCH']);
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('360px 간트에서 선택한 행을 필터로 가려진 같은 프로젝트 업무와 연결한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const project = (await workspace(request)).projects[0];
  const prefix = `간트 선택 업무 연결 ${randomUUID()}`;
  const issues: Issue[] = [];
  try {
    const predecessor = await createIssue(request, project.id, `${prefix} 기준`, issues, dateAt(1), dateAt(2));
    const successor = await createIssue(request, project.id, `${prefix} 상대`, issues, dateAt(4), dateAt(6));
    const writes = countDependencyWrites(page);
    const { chart, picker } = await openChart(page, project.id, predecessor.title);
    const chartSelection = (issue: Issue) => chart.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true });
    await expect(chartSelection(predecessor)).toBeVisible();
    await expect(chartSelection(successor)).toHaveCount(0);
    await expect(picker).toBeDisabled();

    await chartSelection(predecessor).check();
    const anchorLink = page.getByRole('button', { name: '선택 업무에서 연결', exact: true });
    await anchorLink.click();
    const dialog = page.getByRole('dialog', { name: '선행·후행 업무 연결', exact: true });
    await expect(dialog.getByText(`${predecessor.key} · ${predecessor.title}`, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('연결 방향', { exact: true })).toHaveValue('successor');
    const search = dialog.getByRole('searchbox', { name: '연결할 업무 검색', exact: true });
    await search.fill(successor.key);
    const candidate = dialog.getByRole('combobox', { name: '연결할 업무', exact: true });
    await expect(candidate.getByRole('option')).toHaveText(['업무 선택', `${successor.key} · ${successor.title}`]);
    await candidate.selectOption(successor.id);
    await expect(dialog.getByLabel('연결 유형', { exact: true })).toHaveValue('FS');
    expect(writes).toEqual([]);

    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dependencies' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '업무 연결', exact: true }).click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    const dependency = await response.json() as Dependency;
    expect(dependency).toMatchObject({ predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0 });
    await expect(dialog).toHaveCount(0);
    await expect(anchorLink).toBeFocused();
    const chartSearch = page.getByLabel('간트 업무 검색', { exact: true });
    await expect(chartSearch).toHaveValue(predecessor.title);
    await expect(chartSelection(successor)).toHaveCount(0);
    const connector = chart.locator(`[data-dependency-id="${dependency.id}"]`);
    await expect(connector).toHaveCount(0);

    await chartSearch.clear();
    await expect(chartSelection(successor)).toBeVisible();
    await expect(connector).toHaveAttribute('data-dependency-type', 'FS');
    await expect(connector).toHaveAttribute('data-predecessor-anchor', 'endDate');
    await expect(connector).toHaveAttribute('data-successor-anchor', 'startDate');
    const saved = await workspace(request);
    expect(saved.dependencies.filter(link => link.predecessorId === predecessor.id)).toEqual([dependency]);
    for (const issue of issues) {
      expect(saved.issues.find(item => item.id === issue.id)).toMatchObject({ startDate: issue.startDate, endDate: issue.endDate });
    }
    expect(writes).toEqual(['POST']);
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('360px 간트에서 선후행 방향을 검토한 뒤 바꾸고 동시 변경이 있으면 입력을 보존한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const project = (await workspace(request)).projects[0];
  const prefix = `간트 방향 변경 ${randomUUID()}`;
  const issues: Issue[] = [];
  try {
    const predecessor = await createIssue(request, project.id, `${prefix} 선행`, issues, dateAt(1), dateAt(3));
    const successor = await createIssue(request, project.id, `${prefix} 후행`, issues, dateAt(4), dateAt(6));
    const created = await request.post('/api/dependencies', {
      data: { predecessorId: predecessor.id, successorId: successor.id, type: 'FF', lagDays: -2 },
    });
    expect(created.status(), await created.text()).toBe(201);
    const dependency = await created.json() as Dependency;
    const dependencyPath = `/api/dependencies/${dependency.id}`;
    const waitForUpdate = () => page.waitForResponse(response =>
      new URL(response.url()).pathname === dependencyPath && response.request().method() === 'PATCH');
    const writes = countDependencyWrites(page);
    const { chart } = await openChart(page, project.id, prefix);
    const connector = chart.locator(`[data-dependency-id="${dependency.id}"]`);
    await expect(connector).toHaveCount(1);
    const originalPath = await connector.getAttribute('d');
    const list = page.getByRole('region', { name: '업무 연결 목록', exact: true });
    const edit = (before: Issue, after: Issue) => list.getByRole('button', { name: `${before.key}와 ${after.key} 연결 수정`, exact: true });
    await edit(predecessor, successor).click();
    const dialog = page.getByRole('dialog', { name: '업무 연결 수정', exact: true });
    const before = dialog.getByLabel('선행 업무', { exact: true });
    const after = dialog.getByLabel('후행 업무', { exact: true });
    const type = dialog.getByLabel('연결 유형', { exact: true });
    const lag = dialog.getByLabel('추가 간격 근무일', { exact: true });
    const swap = dialog.getByRole('button', { name: '선행·후행 바꾸기', exact: true });
    const save = dialog.getByRole('button', { name: '연결 변경 저장', exact: true });
    await expect(type).toBeFocused();
    await expect(save).toBeDisabled();
    await swap.press('Enter');
    await expect(before).toHaveValue(successor.id);
    await expect(after).toHaveValue(predecessor.id);
    await expect(type).toHaveValue('FF');
    await expect(lag).toHaveValue('-2');
    await expect(dialog.getByRole('status')).toHaveText(`선행 ${successor.key} → 후행 ${predecessor.key}`);
    expect(writes).toEqual([]);
    expect((await workspace(request)).dependencies.find(link => link.id === dependency.id)).toEqual(dependency);
    page.once('dialog', confirmation => confirmation.dismiss());
    await swap.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(before).toHaveValue(successor.id);

    const saved = waitForUpdate();
    await save.click();
    const saveResponse = await saved;
    expect(saveResponse.status(), await saveResponse.text()).toBe(200);
    expect(saveResponse.request().postDataJSON()).toEqual({ expectedVersion: dependency.version, type: 'FF', lagDays: -2, reverse: true });
    const reversed = await saveResponse.json() as Dependency;
    expect(reversed).toMatchObject({ id: dependency.id, predecessorId: successor.id, successorId: predecessor.id, type: 'FF', lagDays: -2 });
    await expect(dialog).toHaveCount(0);
    await expect(edit(successor, predecessor)).toBeFocused();
    await expect.poll(() => connector.getAttribute('d')).not.toEqual(originalPath);

    await edit(successor, predecessor).click();
    await swap.click();
    await lag.fill('3');
    const concurrent = await request.patch(dependencyPath, { data: { expectedVersion: reversed.version, lagDays: 4 } });
    expect(concurrent.status(), await concurrent.text()).toBe(200);
    const latest = await concurrent.json() as Dependency;
    const rejected = waitForUpdate();
    await save.click();
    expect((await rejected).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('다른 작업자가 이 연결을 변경했습니다');
    await expect(before).toHaveValue(predecessor.id);
    await expect(after).toHaveValue(successor.id);
    await expect(lag).toHaveValue('3');
    await expect(save).toBeDisabled();
    page.once('dialog', confirmation => confirmation.accept());
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(edit(successor, predecessor)).toBeFocused();

    const snapshot = await workspace(request);
    expect(snapshot.dependencies.find(link => link.id === dependency.id)).toEqual(latest);
    for (const issue of issues) {
      expect(snapshot.issues.find(item => item.id === issue.id)).toMatchObject({ startDate: issue.startDate, endDate: issue.endDate, version: issue.version });
    }
    expect(writes).toEqual(['PATCH', 'PATCH']);
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});
