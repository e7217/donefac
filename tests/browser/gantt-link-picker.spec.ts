import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Dependency, Issue, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot } from '../../shared/types';
import { applyGanttLink, linkApplyPath, reviewGanttLink } from './gantt-link-review';

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
    if ((path === linkApplyPath || /^\/api\/dependencies(?:\/|$)/.test(path)) && request.method() !== 'GET') {
      writes.push(request.method());
    }
  });
  return writes;
}

function waitPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

test('360px에서 선행·후행 날짜와 연결을 함께 검토하고 최신 저장값과 다른 초안을 보존한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project], users: [, peer] } = await workspace(request);
  const prefix = `간트 날짜 함께 연결 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  try {
    const predecessor = await createIssue(request, project.id, `${prefix} 선행`, issues, dateAt(1), dateAt(12));
    const successor = await createIssue(request, project.id, `${prefix} 후행`, issues, dateAt(6), dateAt(9));
    const unrelated = await createIssue(request, project.id, `${prefix} 독립 업무`, issues, dateAt(7), dateAt(11));
    const { chart, picker } = await openChart(page, project.id, prefix);
    const predecessorEnd = chart.getByLabel(`${predecessor.key} 종료일`, { exact: true });
    const successorStart = chart.getByLabel(`${successor.key} 시작일`, { exact: true });
    const successorEnd = chart.getByLabel(`${successor.key} 종료일`, { exact: true });
    const unrelatedEnd = chart.getByLabel(`${unrelated.key} 종료일`, { exact: true });
    const draftEnd = dateAt(5), draftStart = dateAt(8), draftFinish = dateAt(10);
    const unrelatedDraftEnd = dateAt(14), peerEnd = dateAt(13);
    await predecessorEnd.fill(draftEnd);
    await successorStart.fill(draftStart);
    await successorEnd.fill(draftFinish);
    await unrelatedEnd.fill(unrelatedDraftEnd);

    const dialog = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    const relatedDates = dialog.getByRole('group', { name: '연결 업무의 날짜', exact: true });
    const includeRelated = relatedDates.getByRole('checkbox', { name: '이 업무의 날짜도 저장', exact: true });
    const reviewButton = dialog.getByRole('button', { name: '변경 미리보기', exact: true });
    const applyButton = dialog.getByRole('button', { name: '일정과 연결 적용', exact: true });
    const previewPath = '/api/schedule/row-edit/preview';
    const applyPath = '/api/schedule/row-edit/apply';
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
      await expect(relatedDates.getByText(`${predecessor.key} · ${predecessor.title}`, { exact: true })).toBeVisible();
      await expect(relatedDates).toContainText(predecessor.endDate!);
      await expect(relatedDates).toContainText(draftEnd);
      await expect(includeRelated).toBeChecked();
    }

    await pickPair();
    await includeRelated.uncheck();
    const pendingWithoutRelated = waitPost(page, previewPath);
    await reviewButton.click();
    const withoutRelated = await pendingWithoutRelated;
    expect(withoutRelated.ok(), await withoutRelated.text()).toBeTruthy();
    expect(withoutRelated.request().postDataJSON()).not.toHaveProperty('relatedDates');
    const singleReview = await withoutRelated.json() as SchedulePastePreview;
    expect(singleReview.changes.map(change => change.id)).toEqual([successor.id]);
    expect(singleReview.warnings.some(warning => warning.includes(predecessor.key) && warning.includes(successor.key))).toBe(true);
    page.once('dialog', prompt => prompt.accept());
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(picker).toBeFocused();
    await expect(predecessorEnd).toHaveValue(draftEnd);
    await expect(successorStart).toHaveValue(draftStart);
    await expect(successorEnd).toHaveValue(draftFinish);
    await expect(unrelatedEnd).toHaveValue(unrelatedDraftEnd);
    const before = await workspace(request);
    expect(before.issues.find(issue => issue.id === predecessor.id)).toEqual(predecessor);
    expect(before.issues.find(issue => issue.id === successor.id)).toEqual(successor);
    expect(before.issues.find(issue => issue.id === unrelated.id)).toEqual(unrelated);
    expect(before.dependencies.find(link => link.predecessorId === predecessor.id)).toBeUndefined();

    await pickPair();
    await dialog.getByLabel('간격 (근무일)', { exact: true }).fill('1');
    const pendingPreview = waitPost(page, previewPath);
    await reviewButton.click();
    const previewResponse = await pendingPreview;
    expect(previewResponse.ok(), await previewResponse.text()).toBeTruthy();
    expect(previewResponse.request().postDataJSON()).toMatchObject({
      issue: { id: successor.id, expectedVersion: successor.version }, changes: { startDate: draftStart, endDate: draftFinish },
      dependency: { action: 'add', relatedIssue: { id: predecessor.id, expectedVersion: predecessor.version }, direction: 'predecessor', type: 'FF', lagDays: 1 },
      relatedDates: { issue: { id: predecessor.id, expectedVersion: predecessor.version }, changes: { endDate: draftEnd } },
    });
    const preview = await previewResponse.json() as SchedulePastePreview;
    expect(preview.previewId).toBeTruthy();
    expect(preview.warnings).toEqual([]);
    expect(preview.changes).toHaveLength(2);
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: predecessor.id, fromEnd: predecessor.endDate, toEnd: draftEnd }),
      expect.objectContaining({ id: successor.id, fromStart: successor.startDate, fromEnd: successor.endDate, toStart: draftStart, toEnd: draftFinish }),
    ]));
    const review = dialog.getByRole('region', { name: '일정과 연결 미리보기', exact: true });
    await expect(review.getByRole('heading', { name: `${predecessor.key} · ${predecessor.title}`, exact: true })).toBeVisible();
    await expect(review.getByRole('heading', { name: `${successor.key} · ${successor.title}`, exact: true })).toBeVisible();
    await expect(review.getByRole('heading', { name: `${predecessor.key} → ${successor.key}`, exact: true })).toBeVisible();

    await page.route(`**${applyPath}`, async route => {
      const update = await request.patch(`/api/issues/${predecessor.id}`, {
        headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: predecessor.version, endDate: peerEnd },
      });
      expect(update.ok(), await update.text()).toBeTruthy();
      await route.continue();
    }, { times: 1 });
    const pendingConflict = waitPost(page, applyPath);
    await applyButton.click();
    expect((await pendingConflict).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('날짜와 연결 입력을 유지했습니다.');
    await expect(reviewButton).toBeDisabled();
    const conflict = await workspace(request);
    const latestPredecessor = conflict.issues.find(issue => issue.id === predecessor.id)!;
    expect(latestPredecessor).toMatchObject({ endDate: peerEnd, version: predecessor.version + 1 });
    expect(conflict.issues.find(issue => issue.id === successor.id)).toEqual(successor);
    expect(conflict.dependencies.find(link => link.predecessorId === predecessor.id)).toBeUndefined();

    await dialog.getByRole('button', { name: '최신 업무 불러오기', exact: true }).click();
    await expect(reviewButton).toBeEnabled();
    await expect(relatedDates).toContainText(peerEnd);
    await expect(relatedDates).toContainText(draftEnd);
    await expect(dialog.getByLabel('시작일', { exact: true })).toHaveValue(draftStart);
    await expect(dialog.getByLabel('종료일', { exact: true })).toHaveValue(draftFinish);
    const pendingLatestReview = waitPost(page, previewPath);
    await reviewButton.click();
    const latestReview = await pendingLatestReview;
    expect(latestReview.ok(), await latestReview.text()).toBeTruthy();
    expect(latestReview.request().postDataJSON()).toMatchObject({
      relatedDates: { issue: { id: predecessor.id, expectedVersion: latestPredecessor.version }, changes: { endDate: draftEnd } },
    });
    const latestPreview = await latestReview.json() as SchedulePastePreview;
    expect(latestPreview.previewId).toBeTruthy();
    expect(latestPreview.previewId).not.toBe(preview.previewId);
    expect(latestPreview.changes.find(change => change.id === predecessor.id)).toMatchObject({ fromEnd: peerEnd, toEnd: draftEnd });

    const pendingApply = waitPost(page, applyPath);
    await applyButton.click();
    const appliedResponse = await pendingApply;
    expect(appliedResponse.ok(), await appliedResponse.text()).toBeTruthy();
    const applied = await appliedResponse.json() as SchedulePasteApplyResult;
    expect(applied.updated.map(issue => issue.id).sort()).toEqual([predecessor.id, successor.id].sort());
    expect(applied.dependencyChanges).toBe(1);
    await expect(dialog).toHaveCount(0);
    await expect(predecessorEnd).toHaveValue(draftEnd);
    await expect(unrelatedEnd).toHaveValue(unrelatedDraftEnd);
    await expect(chart.getByRole('button', { name: `${predecessor.key} 날짜 저장`, exact: true })).toHaveCount(0);
    await expect(chart.getByRole('button', { name: `${successor.key} 날짜 저장`, exact: true })).toHaveCount(0);
    await expect(chart.getByRole('button', { name: `${unrelated.key} 날짜 저장`, exact: true })).toBeVisible();
    const after = await workspace(request);
    expect(after.issues.find(issue => issue.id === predecessor.id)).toMatchObject({ startDate: predecessor.startDate, endDate: draftEnd });
    expect(after.issues.find(issue => issue.id === successor.id)).toMatchObject({ startDate: draftStart, endDate: draftFinish });
    expect(after.issues.find(issue => issue.id === unrelated.id)).toEqual(unrelated);
    expect(after.dependencies.find(link => link.predecessorId === predecessor.id)).toMatchObject({ successorId: successor.id, type: 'FF', lagDays: 1 });

    const pendingUndo = waitPost(page, '/api/schedule/undo');
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    expect((await pendingUndo).ok()).toBeTruthy();
    await expect(predecessorEnd).toHaveValue(peerEnd);
    await expect(successorStart).toHaveValue(successor.startDate!);
    await expect(successorEnd).toHaveValue(successor.endDate!);
    await expect(unrelatedEnd).toHaveValue(unrelatedDraftEnd);
    const undone = await workspace(request);
    expect(undone.issues.find(issue => issue.id === predecessor.id)).toMatchObject({ startDate: predecessor.startDate, endDate: peerEnd });
    expect(undone.issues.find(issue => issue.id === successor.id)).toMatchObject({ startDate: successor.startDate, endDate: successor.endDate });
    expect(undone.issues.find(issue => issue.id === unrelated.id)).toEqual(unrelated);
    expect(undone.dependencies.find(link => link.predecessorId === predecessor.id)).toBeUndefined();
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

    const review = await reviewGanttLink(page, dialog);
    expect(review.input).toMatchObject({ issue: { id: predecessor.id },
      dependency: { action: 'add', relatedIssue: { id: successor.id }, type: 'SF', lagDays: 1 } });
    expect(review.preview.changes).toEqual([]);
    expect(writes).toEqual([]);
    expect((await applyGanttLink(page, dialog)).dependencyChanges).toBe(1);
    const dependency = (await workspace(request)).dependencies.find(link => link.predecessorId === predecessor.id && link.successorId === successor.id)!;
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

test('360px 간트에서 새 연결과 필터 밖 후행 일정을 검토하고 응답 유실 뒤 함께 되돌린다', async ({ page, request }) => {
  test.setTimeout(80_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const project = (await workspace(request)).projects[0];
  const mondayOffset = (8 - new Date().getUTCDay()) % 7 || 7;
  const d = (day: number) => dateAt(mondayOffset + day);
  const prefix = `간트 연결 후행 검토 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  try {
    const predecessor = await createIssue(request, project.id, `${prefix} 선행`, issues, d(0), d(3));
    const successor = await createIssue(request, project.id, `${prefix} 후행`, issues, d(0), d(1));
    const hidden = await createIssue(request, project.id, `필터 밖 간접 후행 ${randomUUID()}`, issues, d(2), d(3));
    const side = await createIssue(request, project.id, `필터 밖 다른 후행 ${randomUUID()}`, issues, d(0), d(1));
    for (const [source, target] of [[successor, hidden], [predecessor, side]]) {
      const linked = await request.post('/api/dependencies', { data: { predecessorId: source.id, successorId: target.id, type: 'FS', lagDays: 0 } });
      expect(linked.status(), await linked.text()).toBe(201);
    }
    const { chart, picker } = await openChart(page, project.id, prefix);
    await expect(chart.locator(`[data-issue-id="${hidden.id}"]`)).toHaveCount(0);
    await picker.click();
    await chart.getByRole('button', { name: `${predecessor.key} 선행 업무 선택`, exact: true }).click();
    await chart.getByRole('button', { name: `${successor.key} 후행 업무 선택`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '선행·후행 업무 연결', exact: true });
    const ordinary = await reviewGanttLink(page, dialog);
    expect(ordinary.preview.changes).toEqual([]);
    expect(ordinary.preview.warnings.join(' ')).toContain(successor.key);
    await dialog.getByRole('checkbox', { name: '후행 일정 함께 검토', exact: true }).check();
    const applyButton = dialog.getByRole('button', { name: '검토한 연결 적용', exact: true });
    await expect(applyButton).toBeDisabled();
    const { preview, input } = await reviewGanttLink(page, dialog);
    expect(input.rescheduleSuccessors).toBe(true);
    expect(preview.followUpIssueIds).toEqual(expect.arrayContaining([successor.id, hidden.id]));
    expect(preview.changes).toHaveLength(2);
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: successor.id, toStart: d(4), toEnd: d(7) }),
      expect.objectContaining({ id: hidden.id, toStart: d(8), toEnd: d(9) }),
    ]));
    await expect(dialog.getByRole('list', { name: '후행 일정 변경 목록', exact: true })).toContainText(hidden.key);
    expect((await workspace(request)).issues.find(issue => issue.id === hidden.id)).toEqual(hidden);

    let saved: SchedulePasteApplyResult | undefined;
    await page.route(`**${linkApplyPath}`, async route => {
      const result = await route.fetch();
      expect(result.status(), await result.text()).toBe(200);
      saved = await result.json() as SchedulePasteApplyResult;
      await route.fulfill({ status: 408, json: { error: '합성 응답 유실' } });
    }, { times: 1 });
    const dropped = waitPost(page, linkApplyPath);
    await applyButton.click();
    expect((await dropped).status()).toBe(408);
    const recovery = waitPost(page, linkApplyPath);
    await dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true }).click();
    const recovered = await recovery;
    expect(recovered.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    expect(recovered.status(), await recovered.text()).toBe(200);
    expect(await recovered.json()).toEqual(saved);
    await expect(dialog).toHaveCount(0);
    await expect(picker).toBeFocused();
    const applied = await workspace(request);
    expect(applied.issues.find(issue => issue.id === side.id)).toEqual(side);
    const link = applied.dependencies.find(value => value.predecessorId === predecessor.id && value.successorId === successor.id);
    expect(link).toBeDefined();
    expect(applied.issues.find(issue => issue.id === hidden.id)?.startDate).toBe(d(8));
    const undoing = waitPost(page, '/api/schedule/undo');
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    expect((await undoing).ok()).toBe(true);
    const restored = await workspace(request);
    expect(restored.dependencies.some(value => value.id === link?.id)).toBe(false);
    for (const issue of [successor, hidden]) expect(restored.issues.find(value => value.id === issue.id))
      .toMatchObject({ startDate: issue.startDate, endDate: issue.endDate });
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
    const review = await reviewGanttLink(page, dialog);
    expect(review.input.dependency).toMatchObject({ action: 'update', id: dependency.id, expectedVersion: dependency.version ?? 1, type: 'SS', lagDays: 2 });
    expect(review.preview.warnings.join(' ')).toContain(predecessor.key);
    expect((await applyGanttLink(page, dialog)).dependencyChanges).toBe(1);
    await expect(dialog).toHaveCount(0);
    await expect(picker).toBeFocused();

    const saved = await workspace(request);
    expect(saved.dependencies.filter(link => link.predecessorId === predecessor.id)).toEqual([
      expect.objectContaining({ id: dependency.id, successorId: successor.id, type: 'SS', lagDays: 2 }),
    ]);
    for (const issue of issues) {
      expect(saved.issues.find(item => item.id === issue.id)).toMatchObject({ startDate: null, endDate: null });
    }
    expect(writes).toEqual(['POST']);
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

    await reviewGanttLink(page, dialog);
    expect((await applyGanttLink(page, dialog)).dependencyChanges).toBe(1);
    const dependency = (await workspace(request)).dependencies.find(link => link.predecessorId === predecessor.id && link.successorId === successor.id)!;
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
    const reviewButton = dialog.getByRole('button', { name: '연결 미리보기', exact: true });
    await expect(type).toBeFocused();
    await expect(reviewButton).toBeDisabled();
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

    const first = await reviewGanttLink(page, dialog);
    expect(first.input.dependency).toMatchObject({ id: dependency.id, expectedVersion: dependency.version, type: 'FF', lagDays: -2, reverse: true });
    expect(first.preview.dependencyChanges).toEqual([expect.objectContaining({ predecessorKey: successor.key, successorKey: predecessor.key,
      beforeDirection: { predecessorKey: predecessor.key, successorKey: successor.key } })]);
    const summary = dialog.getByRole('region', { name: '업무 연결 미리보기', exact: true });
    await expect(summary).toContainText(`${predecessor.key} → ${successor.key}`);
    await expect(summary).toContainText(`${successor.key} → ${predecessor.key}`);
    await applyGanttLink(page, dialog);
    const reversed = (await workspace(request)).dependencies.find(link => link.id === dependency.id)!;
    expect(reversed).toMatchObject({ id: dependency.id, predecessorId: successor.id, successorId: predecessor.id, type: 'FF', lagDays: -2 });
    await expect(dialog).toHaveCount(0);
    await expect(edit(successor, predecessor)).toBeFocused();
    await expect.poll(() => connector.getAttribute('d')).not.toEqual(originalPath);

    await edit(successor, predecessor).click();
    await swap.click();
    await lag.fill('3');
    const beforePeer = await reviewGanttLink(page, dialog);
    expect(beforePeer.preview.previewId).toBeTruthy();
    const concurrent = await request.patch(dependencyPath, { data: { expectedVersion: reversed.version, type: 'FS', lagDays: 4 } });
    expect(concurrent.status(), await concurrent.text()).toBe(200);
    const latest = await concurrent.json() as Dependency;
    const apply = dialog.getByRole('button', { name: '검토한 연결 적용', exact: true });
    const rejected = waitPost(page, linkApplyPath);
    await apply.click();
    expect((await rejected).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(before).toHaveValue(predecessor.id);
    await expect(after).toHaveValue(successor.id);
    await expect(type).toHaveValue('FS');
    await expect(lag).toHaveValue('3');
    await expect(apply).toBeDisabled();
    const afterPeer = await reviewGanttLink(page, dialog);
    expect(afterPeer.preview.dependencyChanges?.[0]).toMatchObject({ before: { type: 'FS', lagDays: 4 }, after: { type: 'FS', lagDays: 3 } });
    page.once('dialog', confirmation => confirmation.accept());
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(edit(successor, predecessor)).toBeFocused();

    const snapshot = await workspace(request);
    expect(snapshot.dependencies.find(link => link.id === dependency.id)).toEqual(latest);
    for (const issue of issues) {
      expect(snapshot.issues.find(item => item.id === issue.id)).toMatchObject({ startDate: issue.startDate, endDate: issue.endDate, version: issue.version });
    }
    expect(writes).toEqual(['POST', 'POST']);
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});
