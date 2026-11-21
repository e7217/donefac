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
  expect(header).toBe('업무 키\t시작일\t종료일\t선행 업무\t연결 유형\t근무일 간격');
  const rows = lines.map(line => line.split('\t'));
  for (const row of rows) expect(row).toHaveLength(6);
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
  const created: Issue[] = [];

  async function createIssue(projectId: string, title: string, startDate: string | null, endDate: string | null) {
    const issue = await json<Issue>(await request.post('/api/issues', {
      data: { projectId, title, startDate, endDate },
    }), 201);
    created.push(issue);
    return issue;
  }

  try {
    const hidden = await createIssue(targetProject.id, `검색에 걸리지 않는 선행 ${randomUUID()}`, day(0), day(3));
    const visible = await createIssue(targetProject.id, `${prefix} 선행`, day(0), day(3));
    const successor = await createIssue(targetProject.id, `${prefix} 후행`, successorStart, originalEnd);
    const partial = await createIssue(targetProject.id, `${prefix} 시작일 미정`, null, originalEnd);
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
    await expect(scheduleDownload(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '일정 붙여넣기', exact: true })).toHaveCount(0);
    const projectFilter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    await projectFilter.selectOption(targetProject.id);
    for (const issue of [visible, successor, partial]) await expect(row(issue)).toBeVisible();
    for (const issue of [other, hidden]) await expect(row(issue)).toHaveCount(0);
    const all = await downloadSheet(page, targetProject.key);
    expect([...new Set(all.rows.map(([key]) => key))].sort()).toEqual([visible.key, successor.key, partial.key].sort());
    expect(all.rows.find(([key]) => key === partial.key)?.[2]).toBe(originalEnd);

    await row(successor).getByRole('checkbox', { name: `${successor.key} 선택`, exact: true }).check();
    const selected = await downloadSheet(page, targetProject.key);
    expect(selected.rows.map(([key]) => key)).toEqual([successor.key, successor.key]);
    expect(selected.rows.map(cells => cells.slice(1, 3))).toEqual([[successorStart, originalEnd], ['', '']]);
    expect(selected.rows.map(cells => cells.slice(3))).toEqual(expect.arrayContaining([
      [hidden.key, 'FF', '-1'],
      [visible.key, 'SS', '2'],
    ]));

    const edited = selected.rows.map(([key, startDate, endDate, predecessor, type, lag]) => [
      key, startDate, endDate ? editedEnd : '', predecessor, type, predecessor === hidden.key ? '3' : lag,
    ].join('\t'));
    const text = `\uFEFF${[selected.header, ...edited].join('\n')}`;
    await page.getByRole('button', { name: '일정 붙여넣기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '일정 붙여넣기', exact: true });
    await expect(dialog).toContainText(`대상 프로젝트 ${targetProject.key} · ${targetProject.name}`);
    await expect(projectFilter).toBeDisabled();
    const input = dialog.getByRole('textbox', { name: '붙여넣을 일정표' });
    const mixed = `${text}\n${[other.key, successorStart, editedEnd, '', '', ''].join('\t')}`;
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
      changes: [{ id: successor.id, fromEnd: originalEnd, toEnd: editedEnd }],
      dependencyChanges: [{ predecessorKey: hidden.key, successorKey: successor.key,
        before: { type: 'FF', lagDays: -1 }, after: { type: 'FF', lagDays: 3 } }],
    });
    await expect(dialog.getByRole('table', { name: '붙여넣기 일정 변경 목록' })).toContainText(editedEnd);
    await expect(dialog.getByRole('table', { name: '붙여넣기 업무 연결 변경 목록' })).toContainText('+3근무일');

    async function expectStored(endDate: string, lagDays: number) {
      const snapshot = await workspace();
      expect(snapshot.issues.find(issue => issue.id === successor.id)).toMatchObject({ startDate: successorStart, endDate });
      expect(snapshot.issues.find(issue => issue.id === partial.id)).toEqual(partial);
      expect(snapshot.dependencies.find(link => link.id === hiddenLink.id)).toMatchObject({ type: 'FF', lagDays });
      expect(snapshot.dependencies.find(link => link.id === visibleLink.id)).toEqual(visibleLink);
    }

    await expectStored(originalEnd, -1);
    await dialog.getByRole('button', { name: '검토한 일정 적용', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expectStored(editedEnd, 3);
    await projectFilter.selectOption(routeProject.id);
    await expect(row(successor)).toHaveCount(0);
    const otherSheet = await downloadSheet(page, routeProject.key);
    expect(otherSheet.rows).toEqual([[other.key, successorStart, originalEnd, '', '', '']]);
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
