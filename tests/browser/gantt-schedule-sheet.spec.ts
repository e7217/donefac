import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIResponse, type Page, type Response } from '@playwright/test';
import type { Dependency, Issue, SchedulePastePreview, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

function scheduleDownload(page: Page) {
  return page.getByRole('button', { name: '일정 편집용 TSV 내려받기', exact: true });
}

async function downloadSheet(page: Page, projectKey: string) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    scheduleDownload(page).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`teamspace-schedule-${projectKey}.tsv`);
  const bytes = await readFile(await download.path());
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const [header, ...lines] = bytes.toString('utf8', 3).replace(/\r?\n$/, '').split(/\r?\n/);
  expect(header).toBe('업무 키\t시작일\t종료일\t목표 마감일\t선행 업무\t연결 유형\t근무일 간격\t내보낸 기준');
  const rows = lines.map(line => line.split('\t'));
  for (const row of rows) expect(row).toHaveLength(8);
  return { header, rows };
}

test('360px 전체 프로젝트 간트에서 선택 업무의 TSV를 편집해 적용하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(70_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [routeProject, targetProject] } = await workspace();
  const prefix = `일정표 ${randomUUID().slice(0, 8)}`;
  const day = (offset: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const successorStart = day(7);
  const originalEnd = day(10);
  const editedEnd = day(15);
  const originalDue = day(17);
  const editedDue = day(21);
  const originalPartialDue = day(20);
  const created: Issue[] = [];

  async function createIssue(projectId: string, title: string, startDate: string | null, endDate: string | null, dueDate: string | null = null) {
    const issue = await json<Issue>(await request.post('/api/issues', {
      data: { projectId, title, startDate, endDate, dueDate },
    }), 201);
    created.push(issue);
    return issue;
  }

  try {
    const hidden = await createIssue(targetProject.id, `검색에 걸리지 않는 선행 ${randomUUID()}`, day(0), day(3));
    const visible = await createIssue(targetProject.id, `${prefix} 선행`, day(0), day(3));
    const successor = await createIssue(targetProject.id, `${prefix} 후행`, successorStart, originalEnd, originalDue);
    const partial = await createIssue(targetProject.id, `${prefix} 시작일 미정`, null, originalEnd, originalPartialDue);
    const other = await createIssue(routeProject.id, `${prefix} 다른 프로젝트`, successorStart, originalEnd);
    const dependency = async (predecessor: Issue, type: Dependency['type'], lagDays: number) =>
      json<Dependency>(await request.post('/api/dependencies', {
        data: { predecessorId: predecessor.id, successorId: successor.id, type, lagDays },
      }), 201);
    const hiddenLink = await dependency(hidden, 'FF', -1);
    const visibleLink = await dependency(visible, 'SS', 2);

    await page.goto(`/#/${routeProject.id}/gantt?scope=team`);
    await expect(page.getByRole('heading', { name: '전체 프로젝트 간트', exact: true })).toBeVisible();
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await search.fill(prefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const row = (issue: Issue) => chart.locator(`[data-issue-id="${issue.id}"]`);
    await expect(row(other)).toBeVisible();
    await expect(page.getByRole('button', { name: '일정 붙여넣기', exact: true })).toBeEnabled();
    const team = await downloadSheet(page, 'all');
    expect([...new Set(team.rows.map(([key]) => key))].sort()).toEqual([visible.key, successor.key, partial.key, other.key].sort());
    const projectFilter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await projectFilter.selectOption(targetProject.id);
    for (const issue of [visible, successor, partial]) await expect(row(issue)).toBeVisible();
    for (const issue of [other, hidden]) await expect(row(issue)).toHaveCount(0);
    const all = await downloadSheet(page, targetProject.key);
    expect([...new Set(all.rows.map(([key]) => key))].sort()).toEqual([visible.key, successor.key, partial.key].sort());
    expect(all.rows.find(([key]) => key === partial.key)?.slice(1, 4)).toEqual(['', originalEnd, originalPartialDue]);

    await row(successor).getByRole('checkbox', { name: `${successor.key} 선택`, exact: true }).check();
    await row(partial).getByRole('checkbox', { name: `${partial.key} 선택`, exact: true }).check();
    const selected = await downloadSheet(page, targetProject.key);
    expect(selected.rows.map(([key]) => key).sort()).toEqual([successor.key, successor.key, partial.key].sort());
    const successorRows = selected.rows.filter(([key]) => key === successor.key);
    expect(successorRows.map(cells => cells.slice(1, 4))).toEqual([[successorStart, originalEnd, originalDue], ['', '', '']]);
    expect(successorRows.map(cells => cells.slice(4, 7))).toEqual(expect.arrayContaining([
      [hidden.key, 'FF', '-1'],
      [visible.key, 'SS', '2'],
    ]));

    const edited = selected.rows.map(([key, startDate, endDate, dueDate, predecessor, type, lag, baseline]) => [
      key, startDate, key === successor.key && endDate ? editedEnd : endDate,
      dueDate ? (key === partial.key ? '-' : editedDue) : '', predecessor, type, predecessor === hidden.key ? '3' : lag, baseline,
    ].join('\t'));
    const text = `\uFEFF${[selected.header, ...edited].join('\n')}`;
    await page.getByRole('button', { name: '일정 붙여넣기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '일정 붙여넣기', exact: true });
    await expect(dialog).toContainText(`대상 프로젝트 ${targetProject.key} · ${targetProject.name}`);
    await expect(projectFilter).toBeDisabled();
    const input = dialog.getByRole('textbox', { name: '붙여넣을 일정표' });
    const mixed = `${text}\n${[other.key, successorStart, editedEnd, '', '', '', '', ''].join('\t')}`;
    await input.fill(mixed);
    const discard = page.waitForEvent('dialog');
    await page.evaluate(() => history.back());
    const prompt = await discard;
    expect(prompt.message()).toContain('저장하지 않은 간트 입력');
    await prompt.dismiss();
    await expect(page).toHaveURL(new RegExp(`ganttProject=${targetProject.id}`));
    await expect(input).toHaveValue(mixed);

    async function inspectPaste() {
      const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/schedule/paste-preview'
        && value.request().method() === 'POST');
      await dialog.getByRole('button', { name: '붙여넣기 미리보기', exact: true }).click();
      return json<SchedulePastePreview>(await response);
    }
    const rejected = await inspectPaste();
    expect(rejected.errors.some(error => error.key === other.key)).toBe(true);
    expect(rejected.previewId).toBeFalsy();
    await input.fill(text);
    const preview = await inspectPaste();
    expect(preview).toMatchObject({
      projectId: targetProject.id,
      errors: [],
      changes: expect.arrayContaining([
        expect.objectContaining({ id: successor.id, fromEnd: originalEnd, toEnd: editedEnd, fromDue: originalDue, toDue: editedDue }),
        expect.objectContaining({ id: partial.id, fromEnd: originalEnd, toEnd: originalEnd, fromDue: originalPartialDue, toDue: null }),
      ]),
      dependencyChanges: [{ predecessorKey: hidden.key, successorKey: successor.key,
        before: { type: 'FF', lagDays: -1 }, after: { type: 'FF', lagDays: 3 } }],
    });
    expect(preview.changes).toHaveLength(2);
    const dateTable = dialog.getByRole('table', { name: '붙여넣기 일정 변경 목록' });
    await expect(dateTable).toContainText(editedEnd);
    await expect(dateTable.getByRole('columnheader', { name: '목표 마감일', exact: true })).toBeVisible();
    const newDeadline = dateTable.getByRole('row', { name: new RegExp(successor.key) })
      .getByRole('cell', { name: new RegExp(`${originalDue}.*${editedDue}`) });
    await newDeadline.scrollIntoViewIfNeeded();
    await expect(newDeadline).toBeInViewport();
    await expect(dateTable.getByRole('row', { name: new RegExp(partial.key) })
      .getByRole('cell', { name: new RegExp(`${originalPartialDue}.*미정.*삭제`) })).toBeVisible();
    await expect(dialog.getByRole('table', { name: '붙여넣기 업무 연결 변경 목록' })).toContainText('+3근무일');

    async function expectStored(endDate: string, lagDays: number, dueDate = originalDue, partialDue: string | null = originalPartialDue) {
      const snapshot = await workspace();
      expect(snapshot.issues.find(issue => issue.id === successor.id)).toMatchObject({ startDate: successorStart, endDate, dueDate });
      expect(snapshot.issues.find(issue => issue.id === partial.id)).toMatchObject({ startDate: null, endDate: originalEnd, dueDate: partialDue });
      expect(snapshot.dependencies.find(link => link.id === hiddenLink.id)).toMatchObject({ type: 'FF', lagDays });
      expect(snapshot.dependencies.find(link => link.id === visibleLink.id)).toEqual(visibleLink);
    }

    await expectStored(originalEnd, -1);
    await dialog.getByRole('button', { name: '검토한 일정 적용', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expectStored(editedEnd, 3, editedDue, null);
    await projectFilter.selectOption(routeProject.id);
    await expect(row(successor)).toHaveCount(0);
    const otherSheet = await downloadSheet(page, routeProject.key);
    expect(otherSheet.rows.map(cells => cells.slice(0, 7))).toEqual([[other.key, successorStart, originalEnd, '', '', '', '']]);
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await projectFilter.selectOption(targetProject.id);
    await expect(row(successor).getByLabel(`${successor.key} 종료일`, { exact: true })).toHaveValue(originalEnd);
    await expectStored(originalEnd, -1);

    await page.goto(`/#/${targetProject.id}/gantt`);
    await search.fill(prefix);
    const inline = row(successor).getByLabel(`${successor.key} 종료일`, { exact: true });
    await inline.fill(editedEnd);
    await expect(inline).toBeFocused();
    const project = await downloadSheet(page, targetProject.key);
    expect(project.rows).toHaveLength(all.rows.length);
    expect(project.rows).toEqual(expect.arrayContaining(all.rows));
    await expect(inline).toHaveValue(editedEnd);
    await expectStored(originalEnd, -1);
  } finally {
    for (const issue of created.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});

test('360px 전체 프로젝트 일정표의 여러 날짜와 프로젝트별 연결을 함께 적용하고 되돌린다', async ({ page, request }) => {
  test.setTimeout(80_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const workspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [first, second] } = await workspace();
  const prefix = `팀 일정표 ${randomUUID().slice(0, 8)}`;
  const originalStart = '2026-12-01', originalEnd = '2026-12-04';
  const updatedStart = '2026-12-03', updatedEnd = '2026-12-08';
  const created: Issue[] = [];
  async function issue(projectId: string, title: string) {
    const value = await json<Issue>(await request.post('/api/issues', {
      data: { projectId, title, startDate: originalStart, endDate: originalEnd },
    }), 201);
    created.push(value);
    return value;
  }
  async function link(predecessor: Issue, successor: Issue, type: Dependency['type']) {
    return json<Dependency>(await request.post('/api/dependencies', {
      data: { predecessorId: predecessor.id, successorId: successor.id, type, lagDays: 0 },
    }), 201);
  }

  try {
    const firstLead = await issue(first.id, `숨은 선행 ${randomUUID()}`);
    const secondLead = await issue(second.id, `숨은 선행 ${randomUUID()}`);
    const left = await issue(first.id, `${prefix} 첫 번째`);
    const right = await issue(second.id, `${prefix} 두 번째`);
    const skipped = await issue(second.id, `${prefix} 선택 안 함`);
    const oldFirstLink = await link(firstLead, left, 'SS');
    const oldSecondLink = await link(secondLead, right, 'FF');

    await page.goto(`/#/${first.id}/gantt?scope=team`);
    const projectFilter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await expect(projectFilter).toHaveValue('');
    await page.getByRole('textbox', { name: '간트 업무 검색', exact: true }).fill(prefix);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.locator(`[data-issue-id="${skipped.id}"]`)).toBeVisible();
    await expect(chart.locator(`[data-issue-id="${firstLead.id}"]`)).toHaveCount(0);
    for (const task of [left, right]) await chart.getByRole('checkbox', { name: `${task.key} 선택`, exact: true }).check();
    const sheet = await downloadSheet(page, 'all');
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows.map(cells => cells.slice(0, 7))).toEqual(expect.arrayContaining([
      [left.key, originalStart, originalEnd, '', firstLead.key, 'SS', '0'],
      [right.key, originalStart, originalEnd, '', secondLead.key, 'FF', '0'],
    ]));
    const edited = [sheet.header, ...sheet.rows.map(([key, start, end, , predecessor, type, , baseline]) => [
      key, key === left.key ? updatedStart : start, key === right.key ? updatedEnd : end,
      '', predecessor, key === right.key ? '-' : type, key === right.key ? '' : '2', baseline,
    ].join('\t'))].join('\n');
    const peerEnd = '2026-12-07';
    const peerLeft = await json<Issue>(await request.patch(`/api/issues/${left.id}`, {
      headers: { 'X-Actor-Id': 'user-seo' }, data: { expectedVersion: left.version, endDate: peerEnd },
    }));
    await json<Dependency>(await request.patch(`/api/dependencies/${oldFirstLink.id}`, {
      headers: { 'X-Actor-Id': 'user-seo' }, data: { expectedVersion: oldFirstLink.version, type: 'SF' },
    }));

    const opener = page.getByRole('button', { name: '일정 붙여넣기', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '일정 붙여넣기', exact: true });
    await expect(dialog).toContainText('전체 프로젝트');
    await expect(projectFilter).toBeDisabled();
    const textarea = dialog.getByRole('textbox', { name: '붙여넣을 일정표' });
    const apply = dialog.getByRole('button', { name: '검토한 일정 적용', exact: true });
    const waitPost = (path: string) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    async function review(text: string) {
      await textarea.fill(text);
      const pending = waitPost('/api/schedule/paste-preview');
      await dialog.getByRole('button', { name: '붙여넣기 미리보기', exact: true }).click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual({ projectId: null, text });
      return json<SchedulePastePreview>(response);
    }

    const crossProject = [left.key, '', '', '', secondLead.key, 'FS', '0', ''].join('\t');
    const rejected = await review(`${edited}\n${crossProject}`);
    expect(rejected.previewId).toBeNull();
    expect(rejected.errors).toEqual(expect.arrayContaining([expect.objectContaining({ key: left.key, line: 4, message: expect.stringMatching(/프로젝트/) })]));
    await expect(apply).toBeDisabled();

    const conflictingText = edited.split('\n').map(line => {
      const cells = line.split('\t');
      if (cells[0] === left.key) {
        cells[2] = updatedEnd;
        cells[5] = 'FF';
      }
      return cells.join('\t');
    }).join('\n');
    const sameCell = await review(conflictingText);
    expect(sameCell.previewId).toBeNull();
    const comparison = dialog.getByRole('region', { name: '일정표 값 비교' });
    await expect(comparison).toContainText(`현재 ${peerEnd} · 입력 ${updatedEnd}`);
    await expect(comparison).toContainText('내보낸 값 SS · 현재 SF · 입력 FF');
    await expect(apply).toBeDisabled();
    const endChoice = comparison.getByRole('combobox', { name: new RegExp(`${left.key} 종료일 선택`) });
    const typeChoice = comparison.getByRole('combobox', { name: new RegExp(`${left.key} 연결 유형 선택`) });
    async function reviewChoices() {
      const response = waitPost('/api/schedule/paste-preview');
      await comparison.getByRole('button', { name: '선택한 값으로 다시 미리보기' }).click();
      return json<SchedulePastePreview>(await response);
    }
    await endChoice.selectOption('current');
    expect((await reviewChoices()).previewId).toBeNull();
    await expect(endChoice).toHaveValue('current');
    await expect(apply).toBeDisabled();
    await typeChoice.selectOption('input');
    const preview = await reviewChoices();
    expect(preview).toMatchObject({ projectId: null, projectIds: [first.id, second.id].sort(), errors: [], previewId: expect.any(String) });
    await expect(comparison.getByRole('combobox', { name: new RegExp(`${left.key} 연결 유형 선택`) })).toHaveValue('input');
    await expect(textarea).toHaveValue(conflictingText);
    const dates = dialog.getByRole('table', { name: '붙여넣기 일정 변경 목록' });
    const links = dialog.getByRole('table', { name: '붙여넣기 업무 연결 변경 목록' });
    for (const project of [first, second]) {
      await expect(dates).toContainText(`${project.key} · ${project.name}`);
      await expect(links).toContainText(`${project.key} · ${project.name}`);
    }
    const before = await workspace();
    expect(before.issues.find(item => item.id === left.id)).toEqual(peerLeft);
    expect(before.issues.find(item => item.id === right.id)).toEqual(right);

    const appliedIds: string[] = [];
    await page.route('**/api/schedule/paste-apply', async route => {
      appliedIds.push(route.request().postDataJSON().previewId);
      const result = await route.fetch();
      if (appliedIds.length === 1 && result.ok()) await route.fulfill({ status: 408, json: { error: '합성 응답 유실' } });
      else await route.fulfill({ response: result });
    });
    const firstApply = waitPost('/api/schedule/paste-apply');
    await apply.click();
    expect((await firstApply).status()).toBe(408);
    const retry = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    await expect(retry).toBeFocused();
    await expect(textarea).toBeDisabled();
    await retry.click();
    await expect(dialog).toHaveCount(0);
    expect(appliedIds).toEqual([preview.previewId, preview.previewId]);
    await expect(projectFilter).toHaveValue('');

    const after = await workspace();
    expect(after.issues.find(item => item.id === left.id)).toMatchObject({ startDate: updatedStart, endDate: peerEnd, version: peerLeft.version + 1 });
    expect(after.issues.find(item => item.id === right.id)).toMatchObject({ endDate: updatedEnd, version: right.version + 1 });
    expect(after.issues.find(item => item.id === skipped.id)).toEqual(skipped);
    expect(after.dependencies.find(value => value.id === oldFirstLink.id)).toMatchObject({ type: 'FF', lagDays: 2 });
    expect(after.dependencies.find(value => value.id === oldSecondLink.id)).toBeUndefined();

    const undo = waitPost('/api/schedule/undo');
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    expect((await undo).status()).toBe(200);
    const restored = await workspace();
    expect(restored.issues.find(item => item.id === left.id)).toMatchObject({ startDate: originalStart, endDate: peerEnd, version: peerLeft.version + 2 });
    expect(restored.issues.find(item => item.id === right.id)).toMatchObject({ endDate: originalEnd, version: right.version + 2 });
    expect(restored.dependencies.find(value => value.id === oldFirstLink.id)).toMatchObject({ type: 'SF', lagDays: 0 });
    expect(restored.dependencies.find(value => value.id === oldSecondLink.id)).toMatchObject({ type: 'FF', lagDays: 0 });
  } finally {
    for (const task of created.reverse()) await request.delete(`/api/issues/${task.id}`);
  }
});
