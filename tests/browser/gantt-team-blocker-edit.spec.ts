import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type { Issue, IssueRelation, ScheduleTeamBlockerApplyResult, ScheduleTeamBlockerPreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

const previewPath = '/api/schedule/team-blocker-edit/preview';
const applyPath = '/api/schedule/team-blocker-edit/apply';
const undoPath = '/api/schedule/undo';

async function readJson<T>(response: Pick<APIResponse, 'ok' | 'text' | 'json'>): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

function nextPost(page: Page, path: string) {
  return page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path);
}

test('360px 팀 간트에서 두 프로젝트의 날짜와 차단 관계를 적용하고 차트에서 확인한 뒤 되돌린다', async ({ page, request }, testInfo) => {
  test.setTimeout(100_000);
  const snapshot = async () => readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [first, second], users: [actor] } = await snapshot();
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `교차 차단 날짜 ${randomUUID().slice(0, 8)}`;
  const created: Issue[] = [];
  async function makeIssue(projectId: string, label: string, startDate: string, endDate: string, dueDate: string) {
    const issue = await readJson<Issue>(await request.post('/api/issues', {
      headers, data: { projectId, title: `${prefix} ${label}`, startDate, endDate, dueDate },
    }));
    created.push(issue);
    return issue;
  }
  const calendarPath = `/api/projects/${second.id}/calendar`;
  const initialCalendar = await readJson<WorkCalendar>(await request.get(calendarPath));
  let calendarChanged = false;

  try {
    await readJson<WorkCalendar>(await request.patch(calendarPath, { headers, data: { ...initialCalendar,
      expectedVersion: initialCalendar.version, workingWeekdays: [1, 2, 3, 4, 5],
      exceptions: [{ date: '2026-11-24', isWorking: false, label: '대상 프로젝트 휴무' }],
    } }));
    calendarChanged = true;
    const source = await makeIssue(first.id, '차단 원인', '2026-11-19', '2026-11-20', '2026-11-30');
    const target = await makeIssue(second.id, '차단 대상', '2026-11-23', '2026-11-26', '2026-12-02');
    const unrelated = await makeIssue(second.id, '독립 업무', '2026-11-24', '2026-11-27', '2026-12-03');
    const relationsPath = `/api/issues/${source.id}/relations`;
    const knownRelation = await readJson<IssueRelation>(await request.post(relationsPath, {
      headers, data: { otherIssueId: unrelated.id, type: 'related', direction: 'outgoing' },
    }));
    async function stored() {
      const data = await snapshot();
      return {
        issues: created.map(row => data.issues.find(issue => issue.id === row.id)),
        dependencies: data.dependencies.filter(link => created.some(row => [link.predecessorId, link.successorId].includes(row.id))),
        relations: await readJson<IssueRelation[]>(await request.get(relationsPath)),
      };
    }
    const before = await stored();
    expect(before.issues).toEqual([source, target, unrelated]);
    expect(before.relations).toEqual([knownRelation]);
    const sourceEnd = '2026-11-23', targetStart = '2026-11-24', targetEnd = '2026-11-27', unrelatedEnd = '2026-11-30';
    const route = `#/${first.id}/gantt?${new URLSearchParams({ scope: 'team', ganttQ: prefix })}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/${route}`);
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await expect(search).toHaveValue(prefix);
    await page.getByLabel('간트 표시 시작일', { exact: true }).fill('2026-11-16');
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const date = (issue: Issue, label: string) => chart.getByLabel(`${issue.key} ${label}`, { exact: true });
    const showBlockers = page.getByRole('checkbox', { name: '프로젝트 간 차단 표시', exact: true });
    await expect(showBlockers).toBeChecked();
    await expect(chart.locator('path[data-team-blocker-id]')).toHaveCount(0);
    await date(source, '종료일').fill(sourceEnd);
    await date(target, '시작일').fill(targetStart);
    await date(target, '종료일').fill(targetEnd);
    await date(unrelated, '종료일').fill(unrelatedEnd);

    const picker = page.getByRole('button', { name: '차트에서 연결', exact: true });
    await picker.click();
    await chart.getByRole('button', { name: `${source.key} 선행 업무 선택`, exact: true }).click();
    await chart.getByRole('button', { name: `${target.key} 후행 업무 선택`, exact: true }).click();
    const panel = page.getByRole('region', { name: '프로젝트 간 차단', exact: true });
    const form = panel.getByRole('form', { name: '프로젝트 간 차단 관계 추가', exact: true });
    await expect(form.getByRole('combobox', { name: '차단하는 업무', exact: true })).toHaveValue(source.id);
    await expect(form.getByRole('combobox', { name: '차단되는 업무', exact: true })).toHaveValue(target.id);
    await expect(form.getByRole('button', { name: '차단 관계 저장', exact: true })).toBeVisible();

    const openReview = form.getByRole('button', { name: '날짜와 차단 관계 검토', exact: true });
    const dialog = page.getByRole('dialog', { name: '프로젝트 간 날짜와 차단 관계 검토', exact: true });
    const review = dialog.getByRole('region', { name: '날짜와 차단 관계 미리보기', exact: true });
    const apply = dialog.getByRole('button', { name: '날짜와 차단 관계 적용', exact: true });
    async function preview() {
      await openReview.click();
      await expect(dialog.getByRole('checkbox', { name: `${source.key} 날짜 입력 포함`, exact: true })).toBeChecked();
      await expect(dialog.getByRole('checkbox', { name: `${target.key} 날짜 입력 포함`, exact: true })).toBeChecked();
      await expect(dialog).toContainText(source.title);
      await expect(dialog).toContainText(target.title);
      await expect(dialog).not.toContainText(unrelated.title);
      const pending = nextPost(page, previewPath);
      await dialog.getByRole('button', { name: '날짜와 차단 관계 미리보기', exact: true }).click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual({
        source: { id: source.id, expectedVersion: source.version, dates: { endDate: sourceEnd } },
        target: { id: target.id, expectedVersion: target.version, dates: { startDate: targetStart, endDate: targetEnd } },
      });
      const result = await readJson<ScheduleTeamBlockerPreview>(response);
      expect(result).toMatchObject({ sourceId: source.id, targetId: target.id });
      expect(result.previewId).toBeTruthy();
      expect(result.changes).toHaveLength(2);
      expect(result.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: source.id, fromEnd: source.endDate, toEnd: sourceEnd }),
        expect.objectContaining({ id: target.id, fromStart: target.startDate, fromEnd: target.endDate, toStart: targetStart, toEnd: targetEnd }),
      ]));
      const calendarWarning = result.warnings.find(warning => warning.includes(`${source.key} → ${target.key}`) && warning.includes('2026-11-25'));
      expect(calendarWarning).toBeTruthy();
      await expect(review.getByText(calendarWarning!, { exact: true })).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
      await expect(apply).toBeEnabled();
      return result;
    }

    const attempts: unknown[] = [];
    const separateWrites: string[] = [];
    page.on('request', value => {
      const path = new URL(value.url()).pathname;
      if (path === applyPath && value.method() === 'POST') attempts.push(value.postDataJSON());
      if (['POST', 'PATCH', 'DELETE'].includes(value.method()) &&
          (path === '/api/schedule/team-blockers' || path.startsWith('/api/dependencies') || path.startsWith('/api/issues/'))) {
        separateWrites.push(`${value.method()} ${path}`);
      }
    });
    await preview();
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(openReview).toBeFocused();
    await expect(date(source, '종료일')).toHaveValue(sourceEnd);
    await expect(date(target, '시작일')).toHaveValue(targetStart);
    await expect(date(target, '종료일')).toHaveValue(targetEnd);
    await expect(date(unrelated, '종료일')).toHaveValue(unrelatedEnd);
    expect(await stored()).toEqual(before);
    expect(attempts).toEqual([]);

    const result = await preview();
    let committed: ScheduleTeamBlockerApplyResult | undefined;
    await page.route(url => url.pathname === applyPath, async intercepted => {
      committed = await readJson<ScheduleTeamBlockerApplyResult>(await intercepted.fetch());
      await intercepted.abort('failed');
    }, { times: 1 });
    await apply.click();
    const retry = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(retry).toBeEnabled();
    await expect(retry).toBeFocused();
    expect(committed?.relation).toMatchObject({ sourceIssueId: source.id, targetIssueId: target.id, type: 'blocks', origin: 'teamspace' });
    expect(committed?.updated).toHaveLength(2);
    const appliedIssues = [
      { ...source, endDate: sourceEnd, version: source.version + 1 },
      { ...target, startDate: targetStart, endDate: targetEnd, version: target.version + 1 },
      unrelated,
    ];
    const applied = await stored();
    expect(applied.issues).toMatchObject(appliedIssues.map(({ id, startDate, endDate, dueDate, version }) =>
      ({ id, startDate, endDate, dueDate, version })));
    expect(applied.dependencies).toEqual(before.dependencies);
    expect(applied.relations).toHaveLength(2);
    expect(applied.relations).toEqual(expect.arrayContaining([knownRelation, committed!.relation]));

    const retrying = nextPost(page, applyPath);
    await retry.click();
    expect(await readJson<ScheduleTeamBlockerApplyResult>(await retrying)).toEqual(committed);
    expect(attempts).toEqual([{ previewId: result.previewId }, { previewId: result.previewId }]);
    await expect(dialog).toHaveCount(0);
    await expect(date(unrelated, '종료일')).toHaveValue(unrelatedEnd);
    await expect(page).toHaveURL(url => url.hash === route);
    await expect(search).toHaveValue(prefix);
    expect(await stored()).toEqual(applied);

    const connector = chart.locator(`path[data-team-blocker-id="${committed!.relation!.id}"]`);
    await expect(connector).toHaveCount(1);
    await expect(connector).toHaveAttribute('data-dependency-conflict', 'true');
    await expect(connector).toHaveAttribute('data-predecessor-anchor', 'endDate');
    await expect(connector).toHaveAttribute('data-successor-anchor', 'startDate');
    await expect(connector).not.toHaveCSS('stroke-dasharray', 'none');
    await expect(chart.locator(`path[data-team-blocker-id="${knownRelation.id}"]`)).toHaveCount(0);
    async function exportedBlockers(label: string) {
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: '간트 HTML 내려받기', exact: true }).click();
      const path = testInfo.outputPath(`team-blockers-${label}.html`);
      await (await pending).saveAs(path);
      const html = await readFile(path, 'utf8');
      return page.evaluate(body => [...new DOMParser().parseFromString(body, 'text/html').querySelectorAll<HTMLTableRowElement>('tr.dependency-row')]
        .filter(row => row.cells[2]?.textContent?.includes('프로젝트 간 차단'))
        .map(row => [row.cells[0].textContent, row.cells[1].textContent]), html);
    }
    expect(await exportedBlockers('shown')).toEqual([[source.key, target.key]]);
    await showBlockers.press('Space');
    await expect(showBlockers).not.toBeChecked();
    await expect(connector).toHaveCount(0);
    await expect(date(unrelated, '종료일')).toHaveValue(unrelatedEnd);
    expect(await exportedBlockers('hidden')).toEqual([]);
    await showBlockers.check();
    await expect(connector).toHaveCount(1);
    expect(await stored()).toEqual(applied);

    const latestUnrelated = await readJson<Issue>(await request.patch(`/api/issues/${unrelated.id}`, {
      headers, data: { expectedVersion: unrelated.version, title: `${unrelated.title} 별도 변경` },
    }));
    const undo = nextPost(page, undoPath);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undone = await undo;
    expect(undone.request().postDataJSON()).toEqual({ undoId: committed?.undoId });
    await readJson(undone);
    const restored = await stored();
    expect(restored.issues).toMatchObject([
      { id: source.id, startDate: source.startDate, endDate: source.endDate, dueDate: source.dueDate, version: source.version + 2 },
      { id: target.id, startDate: target.startDate, endDate: target.endDate, dueDate: target.dueDate, version: target.version + 2 },
      latestUnrelated,
    ]);
    expect(restored.relations).toEqual([knownRelation]);
    expect(restored.dependencies).toEqual(before.dependencies);
    await expect(date(source, '종료일')).toHaveValue(source.endDate!);
    await expect(date(target, '시작일')).toHaveValue(target.startDate!);
    await expect(date(target, '종료일')).toHaveValue(target.endDate!);
    await expect(date(unrelated, '종료일')).toHaveValue(unrelatedEnd);
    await expect(connector).toHaveCount(0);
    await expect(search).toHaveValue(prefix);
    expect(separateWrites).toEqual([]);
  } finally {
    for (const issue of created.reverse()) {
      const response = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (!response.ok()) continue;
      const { trashEntryId } = await response.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
    if (calendarChanged) {
      const latest = await readJson<WorkCalendar>(await request.get(calendarPath));
      await request.patch(calendarPath, { headers, data: { ...initialCalendar, expectedVersion: latest.version } });
    }
  }
});
