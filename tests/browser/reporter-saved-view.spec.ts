import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { DocPage, Issue, IssueFieldBreakdown, SavedView, WorkspaceSnapshot } from '../../shared/types';

test('360px에서 요청자와 상태를 팀 보기에 저장해 목록·보드·간트와 문서에서 적용한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const workspaceResponse = await request.get('/api/workspace');
  expect(workspaceResponse.ok(), await workspaceResponse.text()).toBe(true);
  const { projects: [project, otherProject], users: [reporter, teammate], issues: originalIssues } =
    await workspaceResponse.json() as WorkspaceSnapshot;
  const historical = originalIssues.find(issue => issue.projectId === project.id && !Object.hasOwn(issue, 'reporterId'));
  if (!historical) throw new Error('요청자 기록이 없는 초기 합성 업무가 필요합니다.');
  const prefix = `요청자 공유 보기 ${randomUUID().slice(0, 8)}`;
  const issues: Issue[] = [];
  let saved: SavedView | undefined;
  let doc: DocPage | undefined;

  async function createIssue(label: string, fields: Partial<Issue> = {}, actorId = reporter.id) {
    const response = await request.post('/api/issues', {
      headers: { 'X-Actor-Id': actorId },
      data: { projectId: project.id, title: `${prefix} ${label}`, status: 'todo', startDate: '2030-02-11', endDate: '2030-02-15', ...fields },
    });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }

  try {
    const byDefault = await createIssue('기본 요청', { assigneeId: teammate.id });
    const explicit = await createIssue('대리 등록', { reporterId: reporter.id, assigneeId: teammate.id }, teammate.id);
    const teammateIssue = await createIssue('다른 요청자', { reporterId: teammate.id, assigneeId: reporter.id }, teammate.id);
    const inProgress = await createIssue('다른 상태', { reporterId: reporter.id, status: 'in_progress' });
    const unassigned = await createIssue(`미지정 ${historical.title}`, { reporterId: null, assigneeId: reporter.id });
    const foreign = await createIssue('다른 프로젝트', { projectId: otherProject.id, reporterId: reporter.id });
    expect(byDefault).toMatchObject({ reporterId: reporter.id, assigneeId: teammate.id });
    expect(explicit).toMatchObject({ reporterId: reporter.id, assigneeId: teammate.id });
    const matching = [byDefault, explicit];
    const nonmatching = [teammateIssue, inProgress, unassigned, foreign];

    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), reporter.id);
    await page.setViewportSize({ width: 360, height: 820 });
    const path = `/#/${project.id}/issues`;
    await page.goto(path);
    const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
    const filter = page.getByRole('combobox', { name: '요청자 필터', exact: true });
    const status = page.getByRole('combobox', { name: '상태 필터', exact: true });
    const list = page.locator('.issue-table tbody');
    const row = (issue: Issue) => list.locator(`tr[data-issue-id="${issue.id}"]`);
    const cards = page.locator('.issue-board-card');
    const picker = page.getByRole('combobox', { name: '저장된 업무 보기', exact: true });
    const reporterLabel = `요청자 · ${reporter.name}`;
    await expect(filter.locator('option:checked')).toHaveText('전체 요청자');

    await search.fill(historical.title);
    await filter.selectOption({ label: '기록 없음' });
    await expect(row(historical)).toBeVisible();
    await expect(row(unassigned)).toHaveCount(0);
    await filter.selectOption({ label: '미지정' });
    await expect(row(unassigned)).toBeVisible();
    await expect(row(historical)).toHaveCount(0);
    await filter.selectOption({ label: '전체 요청자' });
    await expect(row(historical)).toBeVisible();
    await expect(row(unassigned)).toBeVisible();

    await search.fill(prefix);
    await filter.selectOption(`member:${reporter.id}`);
    await status.selectOption('todo');
    await expect(list.locator('tr[data-issue-id]')).toHaveCount(2);
    for (const issue of matching) await expect(row(issue)).toBeVisible();
    for (const issue of nonmatching) await expect(row(issue)).toHaveCount(0);
    await page.getByRole('button', { name: '일괄 편집', exact: true }).click();
    await expect(list.getByRole('checkbox')).toHaveCount(2);
    const selectedIssue = list.getByRole('checkbox', { name: `${explicit.key} 선택`, exact: true });
    await selectedIssue.check();
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '선택 업무 CSV', exact: true }).click(),
    ]);
    const selected = await readFile(await csv.path(), 'utf8');
    expect(selected).toContain(explicit.title);
    for (const issue of [byDefault, ...nonmatching]) expect(selected).not.toContain(issue.title);
    await selectedIssue.uncheck();
    await page.getByRole('button', { name: '일괄 편집 닫기', exact: true }).click();

    await page.getByRole('button', { name: '보드', exact: true }).click();
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: '현재 보기 저장', exact: true }).click();
    const create = page.getByRole('dialog', { name: '업무 보기 저장', exact: true });
    await expect(create.getByText(reporterLabel, { exact: true })).toBeVisible();
    await create.getByRole('textbox', { name: '보기 이름', exact: true }).fill(prefix);
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/views' && response.request().method() === 'POST');
    await create.getByRole('button', { name: '저장', exact: true }).click();
    const savedResponse = await saving;
    expect(savedResponse.status(), await savedResponse.text()).toBe(201);
    saved = await savedResponse.json() as SavedView;
    expect(saved).toMatchObject({ layout: 'board', projectId: project.id, filters: { query: prefix, status: 'todo', reporter: { kind: 'member', memberId: reporter.id } } });

    const savedPath = `${path}?savedView=${saved.id}`;
    await page.goto(savedPath);
    const actor = page.getByRole('combobox', { name: '작업자 선택', exact: true });
    await actor.selectOption(teammate.id);
    await expect(actor).toHaveValue(teammate.id);
    await expect(picker).toHaveValue(saved.id);
    await expect(filter).toHaveValue(`member:${reporter.id}`);
    await expect(status).toHaveValue('todo');
    await expect(cards).toHaveCount(2);
    for (const issue of matching) await expect(cards.getByText(issue.title, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '목록', exact: true }).click();
    await expect(list.locator('tr[data-issue-id]')).toHaveCount(2);
    await page.getByRole('button', { name: '보드', exact: true }).click();

    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '간트 공유 보기', exact: true })).toHaveValue(saved.id);
    const gantt = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(gantt.locator('.gantt-row[data-issue-id]')).toHaveCount(2);
    for (const issue of matching) await expect(gantt.locator(`.gantt-row[data-issue-id="${issue.id}"]`)).toBeVisible();
    await expect(page.getByRole('list', { name: '간트에 적용된 요청자 조건', exact: true })).toContainText(reporterLabel);
    const [html] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '간트 HTML 내려받기', exact: true }).click(),
    ]);
    const ganttReport = await readFile(await html.path(), 'utf8');
    expect(ganttReport).toContain(reporterLabel);
    for (const issue of matching) expect(ganttReport).toContain(issue.title);
    for (const issue of nonmatching) expect(ganttReport).not.toContain(issue.title);

    const attrs = { projectId: project.id, savedViewId: saved.id, label: saved.name };
    const createdDocResponse = await request.post('/api/documents', { data: {
      projectId: project.id, title: `${prefix} 문서`,
      content: { type: 'doc', content: [{ type: 'issueList', attrs }] },
    } });
    expect(createdDocResponse.status(), await createdDocResponse.text()).toBe(201);
    doc = await createdDocResponse.json() as DocPage;
    await page.goto(`/#/${project.id}/documents`);
    await page.reload();
    await page.getByRole('button', { name: new RegExp(`${doc.title} 초안$`, 'u') }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(doc.title);
    const documentList = page.getByRole('region', { name: '업무 목록', exact: true });
    await expect(documentList.getByRole('button', { name: /^목록 업무 열기 / })).toHaveCount(2);
    for (const issue of matching) {
      await expect(documentList.getByRole('button', { name: `목록 업무 열기 ${issue.key} ${issue.title}`, exact: true })).toBeVisible();
    }

    await page.goto(savedPath);
    await expect(filter).toHaveValue(`member:${reporter.id}`);
    await page.getByRole('button', { name: '필드 집계에서 열기', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '필드 집계 저장된 보기', exact: true })).toHaveValue(saved.id);
    await page.getByRole('combobox', { name: '집계 기준', exact: true }).selectOption('status');
    await page.getByRole('combobox', { name: '비교 기준', exact: true }).selectOption('reporter');
    const loadingReport = page.waitForResponse(response => new URL(response.url()).pathname ===
      `/api/projects/${project.id}/field-breakdown` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '필드 집계 조회', exact: true }).click();
    const loadedReport = await loadingReport;
    expect(loadedReport.ok(), await loadedReport.text()).toBe(true);
    const report = await loadedReport.json() as IssueFieldBreakdown;
    expect(report).toMatchObject({ savedView: { id: saved.id }, totalIssues: 2 });
    expect(report.comparison?.columns.map(({ label, count }) => [label, count])).toEqual([[reporter.name, 2]]);
    await expect(page.getByRole('columnheader', { name: reporter.name, exact: true })).toBeVisible();

    await page.goto(savedPath);
    await expect(filter).toHaveValue(`member:${reporter.id}`);
    await filter.selectOption({ label: '전체 요청자' });
    await page.getByRole('button', { name: '보기 수정', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '저장된 보기 수정', exact: true });
    const updating = page.waitForResponse(response => new URL(response.url()).pathname === `/api/views/${saved?.id}` && response.request().method() === 'PATCH');
    await edit.getByRole('button', { name: '저장', exact: true }).click();
    const updated = await updating;
    expect(updated.ok(), await updated.text()).toBe(true);
    saved = await updated.json() as SavedView;
    expect(saved.filters.reporter).toBeUndefined();
    await page.reload();
    await expect(picker).toHaveValue(saved.id);
    await expect(filter.locator('option:checked')).toHaveText('전체 요청자');
    await expect(status).toHaveValue('todo');
    await expect(cards).toHaveCount(4);
    for (const issue of [...matching, unassigned, teammateIssue]) await expect(cards.getByText(issue.title, { exact: true })).toBeVisible();
  } finally {
    if (doc) {
      const deleted = await request.delete(`/api/documents/${doc.id}`);
      if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json()).trashEntryId}`);
    }
    if (saved) {
      const views = await (await request.get(`/api/views?projectId=${project.id}`)).json() as SavedView[];
      const latest = views.find(view => view.id === saved?.id);
      if (latest) await request.delete(`/api/views/${latest.id}?expectedVersion=${latest.version}`);
    }
    for (const issue of issues.reverse()) {
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json()).trashEntryId}`);
    }
  }
});
