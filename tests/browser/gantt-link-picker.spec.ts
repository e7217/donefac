import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Dependency, Issue, WorkspaceSnapshot } from '../../shared/types';

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
    expect(response.request().postDataJSON()).toMatchObject({ expectedVersion: dependency.version ?? 1, type: 'SS', lagDays: 2 });
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
