import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Issue, Project, SchedulePasteApplyResult, SchedulePastePreview, SchedulePreview, WorkspaceSnapshot } from '../../shared/types';

const manualPreview = '/api/schedule/manual-preview';
const manualApply = '/api/schedule/manual-apply';
const rowPreview = '/api/schedule/row-edit/preview';
const rowApply = '/api/schedule/row-edit/apply';
const date = (day: number) => `2026-11-${day}`;
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));

async function fixture(request: APIRequestContext) {
  const { projects: [first, second], users: [actor] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `간트 날짜 초안 ${randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  return {
    first, second, actor, prefix,
    async issue(project: Project, label: string, startDate: string, endDate: string) {
      const created = await json<Issue>(await request.post('/api/issues', {
        headers, data: { projectId: project.id, title: `${prefix} ${label}`, startDate, endDate },
      }), 201);
      ids.push(created.id);
      return created;
    },
    async close() {
      for (const id of ids.reverse()) {
        const response = await request.delete(`/api/issues/${id}`, { headers });
        if (!response.ok()) continue;
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

function scheduleWrites(page: Page) {
  const paths: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.startsWith('/api/schedule/')) paths.push(path);
  });
  return paths;
}

async function openChart(page: Page, project: Project, actorId: string, prefix: string, scope: '' | '?scope=team') {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorId);
  await page.goto(`/#/${project.id}/gantt${scope}`);
  await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(prefix);
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  return {
    row: (issue: Issue) => chart.locator(`[data-issue-id="${issue.id}"]`),
    start: (issue: Issue) => chart.getByLabel(`${issue.key} 시작일`, { exact: true }),
    end: (issue: Issue) => chart.getByLabel(`${issue.key} 종료일`, { exact: true }),
  };
}

test('프로젝트 간트에서 다른 날짜 칸으로 이동해도 두 행의 입력을 유지하고 고른 행만 저장한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const first = await data.issue(data.first, '첫 날짜 변경', date(23), date(26));
    const second = await data.issue(data.first, '두 번째 날짜 변경', date(24), date(27));
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '');
    const writes = scheduleWrites(page);
    const firstStart = chart.start(first), secondEnd = chart.end(second);
    await firstStart.fill(date(24));
    await firstStart.press('Tab');
    await secondEnd.fill(date(30));
    await chart.start(second).focus();
    await expect(firstStart).toHaveValue(date(24));
    await expect(secondEnd).toHaveValue(date(30));

    const title = chart.row(second).locator('.gantt-issue-name');
    const discarded = page.waitForEvent('dialog', { timeout: 5_000 }).then(async confirmation => {
      const message = confirmation.message();
      await confirmation.dismiss();
      expect(message).toContain('저장하지 않은 간트 입력');
    });
    await Promise.all([discarded, title.click()]);
    await expect(page.locator('.issue-detail-panel')).toHaveCount(0);
    await expect(firstStart).toHaveValue(date(24));
    await expect(secondEnd).toHaveValue(date(30));
    const before = await workspace(request);
    expect(before.issues.find(issue => issue.id === first.id)).toEqual(first);
    expect(before.issues.find(issue => issue.id === second.id)).toEqual(second);
    expect(writes).toEqual([]);

    const previewRequest = nextPost(page, manualPreview), applyRequest = nextPost(page, manualApply);
    const save = button(chart.row(first), `${first.key} 날짜 저장`);
    await save.click();
    const previewResponse = await previewRequest;
    expect(previewResponse.request().postDataJSON()).toEqual({ changes: [{
      id: first.id, expectedVersion: first.version, startDate: date(24), endDate: date(26),
    }] });
    const preview = await json<SchedulePreview>(previewResponse);
    const applyResponse = await applyRequest;
    expect(applyResponse.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    const applied = await json<SchedulePasteApplyResult>(applyResponse);
    expect(applied.updated).toMatchObject([{ id: first.id, version: first.version + 1, startDate: date(24), endDate: date(26) }]);
    await expect(save).toHaveCount(0);
    await expect(secondEnd).toHaveValue(date(30));

    const cancel = button(chart.row(second), `${second.key} 날짜 변경 취소`);
    await cancel.click();
    await expect(cancel).toHaveCount(0);
    await expect(secondEnd).toHaveValue(date(27));
    expect(writes).toEqual([manualPreview, manualApply]);
    const after = await workspace(request);
    expect(after.issues.find(issue => issue.id === first.id)).toEqual(applied.updated[0]);
    expect(after.issues.find(issue => issue.id === second.id)).toEqual(second);
  } finally { await data.close(); }
});

test('전체 프로젝트 간트에서 날짜 초안을 같은 행의 연결 편집에 이어 쓰고 적용할 때 함께 저장한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const otherProject = await data.issue(data.first, '다른 프로젝트 업무', date(20), date(20));
    const predecessor = await data.issue(data.second, '선행 업무', date(19), date(20));
    const anchor = await data.issue(data.second, '날짜와 연결을 함께 검토할 업무', date(23), date(26));
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '?scope=team');
    const writes = scheduleWrites(page);
    const start = chart.start(anchor), end = chart.end(anchor);
    await start.fill(date(24));
    await end.fill(date(27));
    const opener = button(chart.row(anchor), `${anchor.key} 일정과 연결 편집`);
    const editor = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    const editorStart = editor.getByLabel('시작일', { exact: true });
    const editorEnd = editor.getByLabel('종료일', { exact: true });
    await opener.click();
    await expect(editorStart).toHaveValue(date(24));
    await expect(editorEnd).toHaveValue(date(27));
    expect(writes).toEqual([]);
    expect((await workspace(request)).issues.find(issue => issue.id === anchor.id)).toEqual(anchor);

    await editorEnd.fill(date(30));
    const close = button(editor, '일정과 연결 편집 닫기');
    const discardEditor = page.waitForEvent('dialog', { timeout: 5_000 }).then(async confirmation => {
      const message = confirmation.message();
      await confirmation.accept();
      expect(message).toContain('버리고 닫을까요');
    });
    await Promise.all([discardEditor, close.click()]);
    await expect(editor).toHaveCount(0);
    await expect(start).toHaveValue(date(24));
    await expect(end).toHaveValue(date(27));
    expect(writes).toEqual([]);

    await opener.press('Enter');
    await expect(editorStart).toHaveValue(date(24));
    await expect(editorEnd).toHaveValue(date(27));
    const group = editor.getByRole('group', { name: '연결 변경 1', exact: true });
    await group.getByLabel('선후행 연결 작업', { exact: true }).selectOption('add');
    const lookup = group.getByRole('textbox', { name: '연결할 업무 검색', exact: true });
    await lookup.fill(data.prefix);
    await expect(button(group, `${otherProject.key} · ${otherProject.title}`)).toHaveCount(0);
    await button(group, `${predecessor.key} · ${predecessor.title}`).click();
    await group.getByLabel('연결 방향', { exact: true }).selectOption('predecessor');
    await group.getByLabel('연결 유형', { exact: true }).selectOption('FS');

    const previewRequest = nextPost(page, rowPreview);
    await button(editor, '변경 미리보기').click();
    const previewResponse = await previewRequest;
    expect(previewResponse.request().postDataJSON()).toMatchObject({
      projectId: data.second.id, issue: { id: anchor.id, expectedVersion: anchor.version },
      changes: { startDate: date(24), endDate: date(27) }, dependency: {
        action: 'add', direction: 'predecessor', type: 'FS', relatedIssue: { id: predecessor.id, expectedVersion: predecessor.version },
      },
    });
    const preview = await json<SchedulePastePreview>(previewResponse);
    expect(preview.errors).toEqual([]);
    expect((await workspace(request)).issues.find(issue => issue.id === anchor.id)).toEqual(anchor);
    const applyRequest = nextPost(page, rowApply);
    await button(editor, '일정과 연결 적용').click();
    const applyResponse = await applyRequest;
    expect(applyResponse.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    const applied = await json<SchedulePasteApplyResult>(applyResponse);
    expect(applied.updated).toMatchObject([{ id: anchor.id, version: anchor.version + 1, startDate: date(24), endDate: date(27) }]);
    await expect(editor).toHaveCount(0);
    await expect(start).toHaveValue(date(24));
    await expect(end).toHaveValue(date(27));
    await expect(button(chart.row(anchor), `${anchor.key} 날짜 저장`)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/gantt\\?scope=team$`));
    const after = await workspace(request);
    expect(after.issues.find(issue => issue.id === anchor.id)).toEqual(applied.updated[0]);
    expect(after.issues.find(issue => issue.id === otherProject.id)).toEqual(otherProject);
    expect(after.dependencies.filter(link => link.successorId === anchor.id)).toMatchObject([
      { predecessorId: predecessor.id, successorId: anchor.id, type: 'FS', lagDays: 0 },
    ]);
    expect(writes).toEqual([rowPreview, rowApply]);
  } finally { await data.close(); }
});

test('날짜 초안을 연결 편집으로 넘길 때 다른 작업자가 저장한 필드도 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const data = await fixture(request);
  try {
    const anchor = await data.issue(data.second, '날짜 변경이 겹친 업무', date(23), date(26));
    const otherRow = await data.issue(data.first, '같이 보이는 업무', date(24), date(27));
    const chart = await openChart(page, data.first, data.actor.id, data.prefix, '?scope=team');
    const start = chart.start(anchor);
    await start.fill(date(24));
    const { users: [, peer] } = await workspace(request);
    const remote = await json<Issue>(await request.patch(`/api/issues/${anchor.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: anchor.version, endDate: date(30) },
    }));

    await chart.end(otherRow).fill(date(30));
    const refreshRequest = nextPost(page, manualApply);
    await button(chart.row(otherRow), `${otherRow.key} 날짜 저장`).click();
    await json<SchedulePasteApplyResult>(await refreshRequest);
    await expect(start).toHaveAttribute('aria-invalid', 'true');
    await expect(start).toHaveValue(date(24));

    await button(chart.row(anchor), `${anchor.key} 일정과 연결 편집`).click();
    const editor = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    await expect(editor.getByRole('status').filter({ hasText: '업무가 변경됐습니다' })).toBeVisible();
    await expect(editor.getByLabel('시작일', { exact: true })).toHaveValue(date(24));
    await expect(editor.getByLabel('종료일', { exact: true })).toHaveValue(date(30));

    const previewRequest = nextPost(page, rowPreview);
    await button(editor, '변경 미리보기').click();
    const previewResponse = await previewRequest;
    expect(previewResponse.request().postDataJSON()).toEqual({
      projectId: anchor.projectId,
      issue: { id: anchor.id, expectedVersion: remote.version },
      changes: { startDate: date(24) },
    });
    const preview = await json<SchedulePastePreview>(previewResponse);
    expect(preview.errors).toEqual([]);
    const applyRequest = nextPost(page, rowApply);
    await button(editor, '일정과 연결 적용').click();
    const applied = await json<SchedulePasteApplyResult>(await applyRequest);
    expect(applied.updated).toMatchObject([{ id: anchor.id, version: remote.version + 1, startDate: date(24), endDate: date(30) }]);
    await expect(editor).toHaveCount(0);
    await expect(chart.end(anchor)).toHaveValue(date(30));
    expect((await workspace(request)).issues.find(issue => issue.id === anchor.id)).toEqual(applied.updated[0]);
  } finally { await data.close(); }
});
