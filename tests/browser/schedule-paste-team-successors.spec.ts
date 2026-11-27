import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type {
  Dependency, Issue, IssueRelation, Project, SchedulePasteApplyResult, SchedulePastePreview, ScheduleUndoResult, WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types';

const previewPath = '/api/schedule/paste-preview';
const applyPath = '/api/schedule/paste-apply';
const undoPath = '/api/schedule/undo';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, expected = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(expected);
  return response.json() as Promise<T>;
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
}

test('360px 붙여넣은 선후행 변경을 프로젝트 간 후행에 반영하고 한 번에 되돌린다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { users: [actor] } = await workspace();
  const headers = { 'X-Actor-Id': actor.id };
  const token = randomUUID().slice(0, 7).toUpperCase();
  const created: Issue[] = [];

  async function project(key: string, name: string) {
    return json<Project>(await request.post('/api/projects', { headers, data: { key, name } }), 201);
  }

  async function issue(projectId: string, title: string, startDate: string, endDate: string, dueDate: string) {
    const saved = await json<Issue>(await request.post('/api/issues', {
      headers, data: { projectId, title, startDate, endDate, dueDate, description: `기존 설명 ${token}`, labels: ['handoff'] },
    }), 201);
    created.push(saved);
    return saved;
  }

  try {
    const sourceProject = await project(`PS${token}`, `붙여넣기 원래 프로젝트 ${token}`);
    const receiving = await project(`PR${token}`, `후행을 받는 프로젝트 ${token}`);
    const calendarPath = `/api/projects/${receiving.id}/calendar`;
    const calendar = await json<WorkCalendar>(await request.get(calendarPath));
    await json<WorkCalendar>(await request.patch(calendarPath, { headers, data: {
      ...calendar, expectedVersion: calendar.version, workingWeekdays: [1, 2, 3, 4, 5],
      exceptions: [{ date: '2026-11-27', isWorking: false, label: '받는 프로젝트 휴무' }],
    } }));
    const source = await issue(sourceProject.id, `차트의 원래 선행 ${token}`, '2026-11-16', '2026-11-20', '2026-11-26');
    const sender = await issue(sourceProject.id, `숨겨진 같은 프로젝트 후행 ${token}`, '2026-11-23', '2026-11-24', '2026-11-30');
    const receiver = await issue(receiving.id, `다른 프로젝트 인계 대상 ${token}`, '2026-11-25', '2026-11-26', '2026-12-02');
    const localLink = await json<Dependency>(await request.post('/api/dependencies', { headers, data: {
      predecessorId: source.id, successorId: sender.id, type: 'FS', lagDays: 0,
    } }), 201);
    const blocker = await json<IssueRelation>(await request.post(`/api/issues/${sender.id}/relations`, {
      headers, data: { type: 'blocks', direction: 'outgoing', otherIssueId: receiver.id },
    }), 201);
    async function stored() {
      const snapshot = await workspace();
      const relations = await json<IssueRelation[]>(await request.get(`/api/issues/${sender.id}/relations`, { headers }));
      expect(relations).toContainEqual(blocker);
      return {
        issues: new Map(snapshot.issues.filter(value => created.some(item => value.id === item.id)).map(value => [value.id, value])),
        link: snapshot.dependencies.find(link => link.id === localLink.id),
      };
    }
    const original = await stored();
    expect(original.link).toEqual(localLink);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    const chartHash = `#/${sourceProject.id}/gantt`;
    await page.goto(`/${chartHash}`);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await search.fill(source.title);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.getByLabel(`${source.key} 종료일`, { exact: true })).toBeVisible();
    await expect(chart.locator(`[data-issue-id="${sender.id}"]`)).toHaveCount(0);
    await expect(chart.locator(`[data-issue-id="${receiver.id}"]`)).toHaveCount(0);
    const opener = page.getByRole('button', { name: '일정 붙여넣기', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '일정 붙여넣기', exact: true });
    const input = dialog.getByRole('textbox', { name: '붙여넣을 일정표', exact: true });
    const successors = dialog.getByRole('checkbox', { name: '후행 일정 함께 검토', exact: true });
    const crossProject = dialog.getByRole('checkbox', { name: '프로젝트 간 차단 포함', exact: true });
    const previewButton = dialog.getByRole('button', { name: '붙여넣기 미리보기', exact: true });
    const apply = dialog.getByRole('button', { name: '검토한 일정 적용', exact: true });
    const dateTable = dialog.getByRole('table', { name: '붙여넣기 일정 변경 목록', exact: true });
    const row = (value: Issue) => dateTable.getByRole('row').filter({ hasText: value.key });
    const linkTable = dialog.getByRole('table', { name: '붙여넣기 업무 연결 변경 목록', exact: true });
    const text = ['업무 키\t선행 업무\t연결 유형\t근무일 간격', `${sender.key}\t${source.key}\tFS\t2`].join('\n');
    const writes: string[] = [];
    page.on('request', sent => {
      const path = new URL(sent.url()).pathname;
      if (sent.method() === 'POST' && (path === applyPath || path === undoPath)) writes.push(path);
    });
    await input.fill(text);

    async function preview(rescheduleSuccessors = false, includeTeamBlockers = false) {
      const requested = nextPost(page, previewPath);
      await previewButton.click();
      const response = await requested;
      expect(response.request().postDataJSON()).toEqual({
        projectId: sourceProject.id, text, ...(rescheduleSuccessors ? { rescheduleSuccessors: true } : {}),
        ...(includeTeamBlockers ? { includeTeamBlockers: true } : {}),
      });
      const result = await json<SchedulePastePreview>(response);
      expect(result.errors).toEqual([]);
      expect(result.previewId).toBeTruthy();
      expect(result.dependencyChanges).toEqual([expect.objectContaining({
        predecessorKey: source.key, successorKey: sender.key, before: { type: 'FS', lagDays: 0 }, after: { type: 'FS', lagDays: 2 },
      })]);
      await expect(apply).toBeEnabled();
      return result;
    }

    await expect(successors).not.toBeChecked();
    const linkOnly = await preview();
    expect(linkOnly.changes).toEqual([]);
    await expect(linkTable).toContainText(source.key);
    await expect(linkTable).toContainText(sender.key);
    await successors.check();
    await expect(apply).toBeDisabled();
    await expect(crossProject).not.toBeChecked();
    const localOnly = await preview(true);
    expect(localOnly.changes.map(value => value.id)).toEqual([sender.id]);
    await expect(row(receiver)).toHaveCount(0);

    await crossProject.focus();
    await crossProject.press('Space');
    await expect(crossProject).toBeChecked();
    await expect(apply).toBeDisabled();
    await expect(input).toHaveValue(text);
    const proposal = await preview(true, true);
    expect(proposal.previewId).not.toBe(localOnly.previewId);
    expect(proposal.followUpIssueIds?.slice().sort()).toEqual([sender.id, receiver.id].sort());
    const projected = new Map([
      [sender.id, { startDate: '2026-11-25', endDate: '2026-11-26' }],
      [receiver.id, { startDate: '2026-11-30', endDate: '2026-12-01' }],
    ]);
    expect(proposal.changes).toHaveLength(projected.size);
    expect(new Map(proposal.changes.map(({ id, toStart, toEnd }) => [id, { startDate: toStart, endDate: toEnd }]))).toEqual(projected);
    for (const value of [sender, receiver]) {
      const { startDate, endDate } = projected.get(value.id)!;
      await expect(row(value).getByText('후행 조정', { exact: true })).toBeVisible();
      await expect(row(value)).toContainText(startDate);
      await expect(row(value)).toContainText(endDate);
    }
    await expect(row(receiver)).toContainText(receiving.name);
    expect(writes).toEqual([]);
    expect(await stored()).toEqual(original);

    const applying = nextPost(page, applyPath);
    await apply.click();
    const appliedResponse = await applying;
    expect(appliedResponse.request().postDataJSON()).toEqual({ previewId: proposal.previewId });
    const applied = await json<SchedulePasteApplyResult>(appliedResponse);
    expect(applied.updated.map(value => value.id).sort()).toEqual([...projected.keys()].sort());
    expect(applied.dependencyChanges).toBe(1);
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === chartHash);
    await expect(search).toHaveValue(source.title);
    const afterApply = await stored();
    expect(afterApply.link).toMatchObject({ ...localLink, lagDays: 2, version: expect.any(Number) });
    expect(afterApply.link!.version).toBeGreaterThan(localLink.version!);
    expect(afterApply.issues.get(source.id)).toEqual(original.issues.get(source.id));
    for (const value of [sender, receiver]) {
      expect(afterApply.issues.get(value.id)).toMatchObject({
        ...projected.get(value.id), version: original.issues.get(value.id)!.version + 1,
        dueDate: value.dueDate, description: value.description, labels: value.labels,
      });
    }

    const undoing = nextPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undone = await undoing;
    expect(undone.request().postDataJSON()).toEqual({ undoId: applied.undoId });
    const undoResult = await json<ScheduleUndoResult>(undone);
    expect(undoResult.updated.map(value => value.id).sort()).toEqual([...projected.keys()].sort());
    expect(undoResult.dependencyChanges).toBe(1);
    const afterUndo = await stored();
    expect(afterUndo.link).toMatchObject({ ...localLink, version: expect.any(Number) });
    expect(afterUndo.issues.get(source.id)).toEqual(original.issues.get(source.id));
    for (const value of [sender, receiver]) {
      expect(afterUndo.issues.get(value.id)).toMatchObject({
        startDate: value.startDate, endDate: value.endDate, dueDate: value.dueDate,
        description: value.description, labels: value.labels, version: original.issues.get(value.id)!.version + 2,
      });
    }
    expect(writes).toEqual([applyPath, undoPath]);
  } finally {
    for (const value of created.reverse()) {
      const removed = await request.delete(`/api/issues/${value.id}`, { headers });
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});
