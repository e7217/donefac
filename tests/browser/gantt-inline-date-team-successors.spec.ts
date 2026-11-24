import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import type {
  Dependency, Issue, IssueRelation, Project, SchedulePasteApplyResult, SchedulePreview, ScheduleUndoResult,
  WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types';

const previewPath = '/api/schedule/manual-preview';
const applyPath = '/api/schedule/manual-apply';
const undoPath = '/api/schedule/undo';
const date = (day: number) => `2026-11-${day}`;
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

test('360px 여러 날짜 초안과 프로젝트 간 공통 후행 일정을 함께 변경하고 한 번에 되돌린다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const workspace = () => request.get('/api/workspace').then(response => json<WorkspaceSnapshot>(response));
  const { projects: [sourceProject], users: [actor] } = await workspace();
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const prefix = `차트에서 고른 업무 ${suffix}`;
  const created: Issue[] = [];
  async function createIssue(project: Project, title: string, start: number, end: number) {
    const issue = await json<Issue>(await request.post('/api/issues', { headers, data: {
      projectId: project.id, title, startDate: date(start), endDate: date(end),
    } }), 201);
    created.push(issue);
    return issue;
  }
  const block = (source: Issue, target: Issue) => request.post(`/api/issues/${source.id}/relations`, {
    headers, data: { type: 'blocks', direction: 'outgoing', otherIssueId: target.id },
  }).then(response => json<IssueRelation>(response, 201));

  try {
    const receiving = await json<Project>(await request.post('/api/projects', { headers, data: {
      key: `FD${suffix}`, name: `받는 프로젝트 ${suffix}`,
    } }), 201);
    const calendarPath = `/api/projects/${receiving.id}/calendar`;
    const calendar = await json<WorkCalendar>(await request.get(calendarPath));
    await json<WorkCalendar>(await request.patch(calendarPath, { headers, data: {
      ...calendar, expectedVersion: calendar.version, workingWeekdays: [1, 2, 3, 4, 5],
      exceptions: [{ date: date(23), isWorking: false, label: '후행 프로젝트 휴무' }],
    } }));

    const first = await createIssue(sourceProject, `${prefix} 첫 선행`, 16, 17);
    const second = await createIssue(sourceProject, `${prefix} 둘째 선행`, 17, 18);
    const common = await createIssue(receiving, `검색 밖 공통 후행 ${suffix}`, 19, 20);
    const downstream = await createIssue(receiving, `검색 밖 현지 후행 ${suffix}`, 24, 24);
    const firstBlocker = await block(first, common);
    const secondBlocker = await block(second, common);
    const localLink = await json<Dependency>(await request.post('/api/dependencies', {
      headers, data: { predecessorId: common.id, successorId: downstream.id, type: 'FS', lagDays: 0 },
    }), 201);
    const original = new Map((await workspace()).issues.filter(issue => created.some(value => value.id === issue.id))
      .map(issue => [issue.id, issue]));
    const expected = new Map([
      [first.id, { startDate: date(16), endDate: date(19) }],
      [second.id, { startDate: date(17), endDate: date(20) }],
      [common.id, { startDate: date(24), endDate: date(25) }],
      [downstream.id, { startDate: date(26), endDate: date(26) }],
    ]);
    const anchorIds = [first.id, second.id].sort();
    const anchors = [first, second].map(issue => ({ id: issue.id, expectedVersion: original.get(issue.id)!.version, ...expected.get(issue.id)! }));
    async function stored() {
      const snapshot = await workspace();
      expect(snapshot.dependencies.find(link => link.id === localLink.id)).toEqual(localLink);
      for (const [source, edge] of [[first, firstBlocker], [second, secondBlocker]] as const) {
        const relations = await json<IssueRelation[]>(await request.get(`/api/issues/${source.id}/relations`, { headers }));
        expect(relations).toContainEqual(edge);
      }
      return new Map(snapshot.issues.filter(issue => original.has(issue.id)).map(issue => [issue.id, issue]));
    }

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    const chartHash = `#/${sourceProject.id}/gantt?${new URLSearchParams({ scope: 'team', ganttQ: prefix })}`;
    await page.goto(`/${chartHash}`);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const firstEnd = chart.getByLabel(`${first.key} 종료일`, { exact: true });
    const secondEnd = chart.getByLabel(`${second.key} 종료일`, { exact: true });
    const review = button(page, '입력한 날짜 2건 검토');
    const dialog = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    const successors = dialog.getByRole('checkbox', { name: '후행 일정 함께 검토', exact: true });
    const crossProject = dialog.getByRole('checkbox', { name: '프로젝트 간 차단 포함', exact: true });
    const apply = button(dialog, '변경 적용');
    const previewRow = (issue: Issue) => dialog.getByRole('row').filter({ hasText: issue.title });
    const writes: string[] = [];
    page.on('request', sent => {
      const path = new URL(sent.url()).pathname;
      if (sent.method() === 'POST' && (path === applyPath || path === undoPath)) writes.push(path);
    });
    await expect(firstEnd).toBeVisible();
    await expect(chart.locator(`[data-issue-id="${common.id}"]`)).toHaveCount(0);
    await expect(chart.locator(`[data-issue-id="${downstream.id}"]`)).toHaveCount(0);
    await firstEnd.fill(date(19));
    await secondEnd.fill(date(20));
    await expect(review).toBeEnabled();

    async function preview(action: () => Promise<void>, followUp: boolean, includeTeamBlockers = false) {
      const received = nextPost(page, previewPath);
      await action();
      const response = await received;
      const input = response.request().postDataJSON();
      expect(input).toEqual({ changes: expect.arrayContaining(anchors),
        ...(followUp ? { rescheduleSuccessors: true } : {}), ...(includeTeamBlockers ? { includeTeamBlockers: true } : {}),
      });
      expect(input.changes).toHaveLength(2);
      const proposal = await json<SchedulePreview>(response);
      expect(proposal.previewId).toBeTruthy();
      expect(proposal.blocking ?? []).toEqual([]);
      return proposal;
    }
    async function enableFollowUp() {
      const datesOnly = await preview(() => review.click(), false);
      expect(datesOnly.changes.map(change => change.id).sort()).toEqual(anchorIds);
      await expect(successors).not.toBeChecked();
      const localOnly = await preview(() => successors.click(), true);
      await expect(successors).toBeChecked();
      expect(localOnly.changes.map(change => change.id).sort()).toEqual(anchorIds);
      await expect(previewRow(common)).toHaveCount(0);
      await expect(crossProject).not.toBeChecked();
      await expect(crossProject).toBeEnabled();
      const crossProjectPlan = await preview(async () => {
        await crossProject.focus();
        await crossProject.press('Space');
      }, true, true);
      await expect(crossProject).toBeChecked();
      expect(crossProjectPlan.previewId).not.toBe(localOnly.previewId);
      expect(crossProjectPlan.changes).toHaveLength(expected.size);
      expect(new Map(crossProjectPlan.changes.map(({ id, toStart, toEnd }) => [id, { startDate: toStart, endDate: toEnd }]))).toEqual(expected);
      for (const issue of [common, downstream]) {
        const { startDate, endDate } = expected.get(issue.id)!;
        const row = previewRow(issue);
        await expect(row).toHaveCount(1);
        await expect(row.getByText('후행 조정', { exact: true })).toBeVisible();
        await expect(row.locator('.gantt-new-dates')).toHaveText(`${startDate}${endDate}`);
      }
      return crossProjectPlan;
    }

    await enableFollowUp();
    expect(writes).toEqual([]);
    expect(await stored()).toEqual(original);
    await button(dialog, '취소').click();
    await expect(dialog).toHaveCount(0);
    await expect(firstEnd).toHaveValue(date(19));
    await expect(secondEnd).toHaveValue(date(20));
    await expect(review).toBeFocused();
    expect(await stored()).toEqual(original);

    const plan = await enableFollowUp();
    expect(writes).toEqual([]);
    const applying = nextPost(page, applyPath);
    await apply.click();
    const appliedResponse = await applying;
    expect(appliedResponse.request().postDataJSON()).toEqual({ previewId: plan.previewId });
    const applied = await json<SchedulePasteApplyResult>(appliedResponse);
    expect(applied.updated.map(issue => issue.id).sort()).toEqual([...expected.keys()].sort());
    await expect(dialog).toHaveCount(0);
    await expect(review).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === chartHash);
    const afterApply = await stored();
    for (const [id, dates] of expected) {
      expect(afterApply.get(id)).toMatchObject({ ...dates, version: original.get(id)!.version + 1 });
    }

    const undoing = nextPost(page, undoPath);
    await button(page, '되돌리기').click();
    const undoneResponse = await undoing;
    expect(undoneResponse.request().postDataJSON()).toEqual({ undoId: applied.undoId });
    const undone = await json<ScheduleUndoResult>(undoneResponse);
    expect(undone.updated.map(issue => issue.id).sort()).toEqual([...expected.keys()].sort());
    await expect(firstEnd).toHaveValue(date(17));
    await expect(secondEnd).toHaveValue(date(18));
    const afterUndo = await stored();
    for (const [id, issue] of original) {
      expect(afterUndo.get(id)).toMatchObject({
        startDate: issue.startDate, endDate: issue.endDate, version: issue.version + 2,
      });
    }
    expect(writes).toEqual([applyPath, undoPath]);
  } finally {
    for (const issue of created.reverse()) {
      const removed = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});
