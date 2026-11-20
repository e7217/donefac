import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Issue, PlanningItem, SavedView, WorkspaceSnapshot } from '../../shared/types';

const columns = [
  '업무 키', '프로젝트', '제목', '유형', '상태', '우선순위', '담당자',
  '시작일', '종료일', '목표 마감일', '라벨', '사이클', '모듈', '릴리스',
];

function parseCsv(bytes: Buffer): string[][] {
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const source = bytes.subarray(3).toString('utf8');
  const field = /"(?:[^"]|"")*"|[^",\r\n]*/y;
  const rows: string[][] = [];
  let offset = 0;
  while (offset < source.length) {
    const row: string[] = [];
    for (;;) {
      field.lastIndex = offset;
      const cell = field.exec(source)?.[0];
      if (cell === undefined) throw new Error(`Invalid CSV cell at offset ${offset}`);
      row.push(cell.startsWith('"') ? cell.slice(1, -1).replaceAll('""', '"') : cell);
      offset = field.lastIndex;
      if (source[offset] === ',') {
        offset++;
        continue;
      }
      if (offset < source.length) {
        expect(source.slice(offset, offset + 2)).toBe('\r\n');
        offset += 2;
      }
      rows.push(row);
      break;
    }
  }
  return rows;
}

async function downloadCsv(page: Page, button: Locator, filename: string) {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toBe(filename);
  const bytes = await readFile(await download.path());
  const [header, ...rows] = parseCsv(bytes);
  expect(header).toEqual(columns);
  for (const row of rows) expect(row).toHaveLength(columns.length);
  return { rows, bytes };
}

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('360px에서 저장된 목록의 검색·조건·순서와 현재 선택대로 업무 CSV를 내려받는다', async ({ page, request }) => {
  test.setTimeout(85_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project, otherProject], users: [assignee] } = await workspace(request);
  const tag = randomUUID().slice(0, 8);
  const prefix = `CSV 범위 ${tag}`;
  const description = `CSV 제외 설명 ${tag}`;
  const created: Issue[] = [];
  let cycle: PlanningItem | undefined;
  let view: SavedView | undefined;

  async function createIssue(title: string, fields: Partial<Issue> = {}) {
    const response = await request.post('/api/issues', {
      data: { projectId: project.id, type: '작업', status: 'todo', title, description, ...fields },
    });
    expect(response.status(), await response.text()).toBe(201);
    const issue: Issue = await response.json();
    created.push(issue);
    return issue;
  }

  try {
    const cycleResponse = await request.post('/api/planning-items', {
      data: { projectId: project.id, kind: 'cycle', name: `${prefix} 1차` },
    });
    expect(cycleResponse.ok(), await cycleResponse.text()).toBe(true);
    cycle = await cycleResponse.json() as PlanningItem;
    const first = await createIssue(`=${prefix} 검토, "문장"\n추가 내용`, {
      priority: 'high', assigneeId: assignee.id, startDate: '2026-08-03', endDate: '2026-08-07', dueDate: '2026-08-06',
      labels: ['회의,검토', '한국어'], cycleId: cycle.id,
    });
    const second = await createIssue(`${prefix} 검토 둘`);
    const checkedThenHidden = await createIssue(`${prefix} 임시 선택`);
    const otherStatus = await createIssue(`${prefix} 검토 다른 상태`, { status: 'in_progress' });
    const otherQuery = await createIssue(`다른 검색 ${tag}`);
    const outside = await createIssue(`${prefix} 검토 다른 프로젝트`, { projectId: otherProject.id });
    const saved = await request.post('/api/views', { data: {
      projectId: project.id, name: prefix, layout: 'list', filters: { query: prefix, status: 'todo', assigneeId: 'all', type: 'all' },
    } });
    expect(saved.status(), await saved.text()).toBe(201);
    view = await saved.json() as SavedView;

    await page.goto(`/#/${project.id}/issues?savedView=${view.id}`);
    const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
    await expect(search).toHaveValue(prefix);
    await expect(page.getByRole('combobox', { name: '상태 필터', exact: true })).toHaveValue('todo');
    const visible = page.locator('.issue-table tbody tr[data-issue-id]');
    const rowIds = () => visible.evaluateAll(rows => rows.map(row => row.getAttribute('data-issue-id')));
    await expect.poll(rowIds).toEqual([first.id, second.id, checkedThenHidden.id]);
    const editOrder = page.getByRole('button', { name: '순서 편집', exact: true });
    await editOrder.click();
    const reorder = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/issue-order`)
      && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: `${second.key} 위로 이동`, exact: true }).click();
    expect((await reorder).ok()).toBe(true);
    await expect.poll(rowIds).toEqual([second.id, first.id, checkedThenHidden.id]);
    await editOrder.click();

    const prior = await workspace(request);
    const all = page.getByRole('button', { name: '현재 목록 CSV', exact: true });
    const selected = page.getByRole('button', { name: '선택 업무 CSV', exact: true });
    const allFilename = `teamspace-issues-${project.key}.csv`;
    const selectedFilename = `teamspace-issues-${project.key}-selected.csv`;
    await expect(selected).toHaveCount(0);
    const exported = await downloadCsv(page, all, allFilename);
    expect(exported.rows.map(row => row[0])).toEqual([second.key, first.key, checkedThenHidden.key]);
    const firstRow = exported.rows[1];
    expect(firstRow.slice(1, 10)).toEqual([
      project.name, `'${first.title}`, '작업', '할 일', '높음', assignee.name, first.startDate, first.endDate, first.dueDate,
    ]);
    expect(firstRow[10]).toContain('회의,검토');
    expect(firstRow[10]).toContain('한국어');
    expect(firstRow.slice(11)).toEqual([cycle.name, '', '']);
    const decoded = exported.bytes.toString('utf8');
    for (const omitted of [description, assignee.email, otherStatus.key, otherQuery.key, outside.key]) {
      expect(decoded).not.toContain(omitted);
    }

    await page.getByRole('button', { name: '일괄 편집', exact: true }).click();
    await expect(selected).toBeDisabled();
    const rowCheckbox = (issue: Issue) => page.getByRole('checkbox', { name: `${issue.key} 선택`, exact: true });
    await rowCheckbox(checkedThenHidden).check();
    await rowCheckbox(first).check();
    await search.fill(`${prefix} 검토`);
    await expect.poll(rowIds).toEqual([second.id, first.id]);
    await expect(rowCheckbox(checkedThenHidden)).toHaveCount(0);
    await expect(rowCheckbox(first)).toBeChecked();
    expect((await downloadCsv(page, selected, selectedFilename)).rows).toEqual([firstRow]);
    expect((await downloadCsv(page, all, allFilename)).rows).toEqual(exported.rows.slice(0, 2));
    await rowCheckbox(first).uncheck();
    await expect(selected).toBeDisabled();
    await search.fill(`${prefix} 결과 없음`);
    await expect(all).toBeDisabled();

    const after = await workspace(request);
    expect(after.issues).toEqual(prior.issues);
    expect(after.issueOrders).toEqual(prior.issueOrders);
    expect(after.savedViews).toEqual(prior.savedViews);
  } finally {
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of created) {
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId?: string };
        if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    if (cycle) await request.delete(`/api/planning-items/${cycle.id}?expectedVersion=${cycle.version}`);
  }
});
