import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Dialog } from '@playwright/test';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move';
import type { Issue, Milestone, ScheduleBaseline, WorkspaceSnapshot } from '../../shared/types';

interface ArtifactFixture { request: APIRequestContext; workspace: WorkspaceSnapshot; prefix: string }
const test = base.extend<{ artifacts: ArtifactFixture }>({
  artifacts: [async ({ playwright, baseURL }, provide) => {
    const request = await playwright.request.newContext({ baseURL }); const prefix = `일정 아티팩트 ${randomUUID()}`;
    try { const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot; await provide({ request, workspace, prefix }); }
    finally {
      try {
        const response = await request.get('/api/workspace', { timeout: 5000 });
        if (response.ok()) {
          const current = await response.json() as WorkspaceSnapshot;
          for (const item of current.baselines || []) if (item.name.startsWith(prefix)) await request.delete(`/api/baselines/${item.id}?expectedVersion=${item.version}`, { timeout: 5000 });
          for (const item of current.milestones || []) if (item.title.startsWith(prefix)) await request.delete(`/api/milestones/${item.id}?expectedVersion=${item.version}`, { timeout: 5000 });
          for (const item of current.issues) if (item.title.startsWith(prefix)) await request.delete(`/api/issues/${item.id}?expectedVersion=${item.version}`, { timeout: 5000 });
        }
      } finally { await request.dispose(); }
    }
  }, { timeout: 30_000 }],
});
const day = (offset: number) => { const date = new Date(); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const snapshot = async (f: ArtifactFixture) => await (await f.request.get('/api/workspace')).json() as WorkspaceSnapshot;
async function createIssue(f: ArtifactFixture, suffix: string, projectId = f.workspace.projects[0].id) { const response = await f.request.post('/api/issues', { data: { projectId, title: `${f.prefix} ${suffix}`, startDate: day(0), endDate: day(4) } }); expect(response.status()).toBe(201); return await response.json() as Issue; }
async function createMilestone(f: ArtifactFixture, suffix: string, issueIds: string[] = []) { const response = await f.request.post('/api/milestones', { data: { projectId: f.workspace.projects[0].id, title: `${f.prefix} ${suffix}`, date: day(5), issueIds } }); expect(response.status()).toBe(201); return await response.json() as Milestone; }

test('360px 간트 날짜 초안과 이정표 연결 편집을 유지하며 검색한 업무를 검토하고 각각 저장한다', async ({ page, artifacts: f }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const [project, previousProject] = f.workspace.projects;
  const anchor = await createIssue(f, '날짜 초안을 남길 기존 연결 업무');
  const milestone = await createMilestone(f, '업무를 더 연결할 이정표', [anchor.id]);
  const candidates: Issue[] = [];
  const candidateQuery = `${f.prefix} 페이지 검색 후보`;
  for (let index = 0; index < 21; index++) candidates.push(await createIssue(f, `페이지 검색 후보 ${index}`));
  const former = await createIssue(f, '이동 전 키로 연결할 업무', previousProject.id);
  const movePath = `/api/issues/${former.id}/project-move`;
  const input: IssueProjectMoveInput = { projectId: project.id, expectedVersion: former.version, includeConnected: false, mappings: [] };
  const proposed = await f.request.post(`${movePath}/preview`, { data: input });
  expect(proposed.ok(), await proposed.text()).toBe(true);
  const plan = await proposed.json() as IssueProjectMovePreview;
  expect(plan.token, JSON.stringify(plan.blockers)).toBeTruthy();
  const committed = await f.request.post(`${movePath}/apply`, { data: { ...input, token: plan.token } });
  expect(committed.ok(), await committed.text()).toBe(true);
  const { issues: [moved] } = await committed.json() as IssueProjectMoveResult;
  expect(moved).toMatchObject({ id: former.id, projectId: project.id });
  expect(moved.key).not.toBe(former.key);

  const ganttPath = `#/${project.id}/gantt`;
  const ganttSearch = f.prefix;
  await page.goto(`/${ganttPath}`);
  const chart = page.getByRole('region', { name: '간트 차트', exact: true });
  const chartSearch = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
  await chartSearch.fill(ganttSearch);
  const row = chart.locator(`[data-issue-id="${anchor.id}"]`);
  const end = row.getByLabel(`${anchor.key} 종료일`, { exact: true });
  const draftEnd = day(7);
  await end.fill(draftEnd);
  const writes: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (['PATCH', 'POST', 'DELETE'].includes(request.method()) && /^\/api\/(milestones|schedule|issues)(\/|$)/.test(path)) {
      writes.push(`${request.method()} ${path}`);
    }
  });
  const panel = page.getByRole('region', { name: '이정표와 일정 기준선', exact: true });
  await panel.locator('summary').click();
  await panel.locator('.schedule-milestone-name').filter({ hasText: milestone.title }).click();
  const editor = panel.getByRole('form', { name: '이정표 편집', exact: true });
  const title = editor.getByLabel('이정표 제목', { exact: true });
  const date = editor.getByLabel('이정표 날짜', { exact: true });
  const description = editor.getByLabel('이정표 설명', { exact: true });
  const newTitle = `${f.prefix} 이정표 편집 초안`;
  const newDate = day(8), newDescription = '연결할 업무의 상세를 확인하는 중';
  await title.fill(newTitle);
  await date.fill(newDate);
  await description.fill(newDescription);
  await expect(end).toHaveValue(draftEnd);

  const picker = editor.getByRole('region', { name: '이정표 연결 업무 선택', exact: true });
  const search = picker.getByRole('searchbox', { name: '이정표 연결 업무 검색', exact: true });
  const selectedOnly = picker.getByRole('checkbox', { name: '선택한 업무만', exact: true });
  const list = picker.getByRole('list', { name: '이정표 연결 후보', exact: true });
  const entries = list.locator('li[data-issue-id]');
  const candidate = (issue: Issue) => list.locator(`li[data-issue-id="${issue.id}"]`);
  const checkbox = (issue: Issue) => candidate(issue).getByRole('checkbox', { name: `${issue.key} 이정표 연결`, exact: true });
  await search.fill(candidateQuery);
  await expect(entries).toHaveCount(20);
  await picker.getByRole('button', { name: '이정표 연결 후보 다음 페이지', exact: true }).click();
  await expect(entries).toHaveCount(1);
  const pageTwoId = await entries.first().getAttribute('data-issue-id');
  const pageTwo = candidates.find(issue => issue.id === pageTwoId);
  expect(pageTwo).toBeTruthy();
  await checkbox(pageTwo!).check();

  const formerKeyQuery = [...former.key.toLowerCase()].map(char => String.fromCharCode(char.charCodeAt(0) + 0xfee0)).join('');
  await search.fill(formerKeyQuery);
  await expect(entries).toHaveCount(1);
  await expect(candidate(moved)).toContainText(moved.key);
  await expect(candidate(moved)).toContainText(`이동 전 키 ${former.key}`);
  await checkbox(moved).check();
  const detail = candidate(moved).getByRole('button', { name: `${moved.key} 상세`, exact: true });
  await detail.click();
  const ticket = page.getByRole('dialog', { name: moved.title, exact: true });
  await expect(ticket).toBeVisible();
  await expect(page).toHaveURL(url => {
    const [path, query] = url.hash.split('?');
    return path === ganttPath && new URLSearchParams(query).get('issue') === moved.id;
  });
  await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
  await expect(ticket).toHaveCount(0);
  await expect(detail).toBeFocused();
  await expect(search).toHaveValue(formerKeyQuery);
  await expect(checkbox(moved)).toBeChecked();
  await expect(title).toHaveValue(newTitle);
  await expect(date).toHaveValue(newDate);
  await expect(description).toHaveValue(newDescription);
  await expect(chartSearch).toHaveValue(ganttSearch);
  await expect(end).toHaveValue(draftEnd);
  expect(writes).toEqual([]);

  await selectedOnly.check();
  await search.fill('');
  await expect(entries).toHaveCount(3);
  const expectedIds = [anchor.id, pageTwo!.id, moved.id].sort();
  expect((await entries.evaluateAll(items => items.map(item => item.getAttribute('data-issue-id')))).sort()).toEqual(expectedIds);
  await expect(checkbox(anchor)).toBeChecked();
  await expect(checkbox(pageTwo!)).toBeChecked();
  await expect(checkbox(moved)).toBeChecked();

  const prompts: string[] = [];
  const declineAway = async (confirmation: Dialog) => {
    prompts.push(confirmation.message());
    if (prompts.length === 1) await confirmation.accept();
    else await confirmation.dismiss();
  };
  page.on('dialog', declineAway);
  try {
    await page.evaluate(hash => { location.hash = hash; }, `#/${project.id}/teamboard`);
    await expect.poll(() => prompts.length).toBe(2);
    await expect(page).toHaveURL(url => url.hash === ganttPath);
  } finally { page.off('dialog', declineAway); }
  expect(prompts).toEqual(expect.arrayContaining([expect.stringContaining('작성 중인 일정 정보'), expect.stringContaining('저장하지 않은 간트 입력')]));
  await expect(title).toHaveValue(newTitle);
  await expect(date).toHaveValue(newDate);
  await expect(description).toHaveValue(newDescription);
  await expect(selectedOnly).toBeChecked();
  await expect(checkbox(pageTwo!)).toBeChecked();
  await expect(checkbox(moved)).toBeChecked();
  await expect(end).toHaveValue(draftEnd);
  expect(writes).toEqual([]);
  const before = await snapshot(f);
  expect(before.issues.find(issue => issue.id === anchor.id)).toEqual(anchor);
  expect(before.milestones?.find(item => item.id === milestone.id)).toEqual(milestone);

  const milestonePath = `/api/milestones/${milestone.id}`;
  const nextMilestoneWrite = () => page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === milestonePath);
  const saveMilestone = editor.getByRole('button', { name: '이정표 저장', exact: true });
  const deletedCandidate = candidates.find(issue => issue.id !== pageTwo!.id)!;
  await selectedOnly.uncheck();
  await search.fill(deletedCandidate.key);
  await checkbox(deletedCandidate).check();
  await selectedOnly.check();
  await search.fill('');
  const peer = { 'X-Actor-Id': f.workspace.users[1].id };
  const deletion = await f.request.delete(`/api/issues/${deletedCandidate.id}?expectedVersion=${deletedCandidate.version}`, { headers: peer });
  expect(deletion.ok(), await deletion.text()).toBe(true);
  const { trashEntryId } = await deletion.json() as { trashEntryId: string };
  const rejecting = nextMilestoneWrite();
  await saveMilestone.click();
  const invalid = await rejecting;
  expect(invalid.status(), await invalid.text()).toBe(400);
  expect((invalid.request().postDataJSON() as Milestone).issueIds.sort()).toEqual([...expectedIds, deletedCandidate.id].sort());
  await expect(picker.getByText('현재 프로젝트에서 확인할 수 없는 선택 업무 1개', { exact: true })).toBeVisible();
  await picker.getByRole('button', { name: '연결할 수 없는 선택 해제', exact: true }).click();
  await expect(selectedOnly).toBeFocused();
  await expect(selectedOnly).toBeChecked();
  await expect(checkbox(anchor)).toBeChecked();
  await expect(checkbox(pageTwo!)).toBeChecked();
  await expect(checkbox(moved)).toBeChecked();
  await expect(title).toHaveValue(newTitle);
  await expect(date).toHaveValue(newDate);
  await expect(description).toHaveValue(newDescription);
  await expect(end).toHaveValue(draftEnd);
  expect((await snapshot(f)).milestones?.find(item => item.id === milestone.id)).toEqual(milestone);
  await f.request.delete(`/api/trash/${trashEntryId}`, { headers: peer });

  const updating = nextMilestoneWrite();
  await saveMilestone.click();
  const saved = await updating;
  expect(saved.ok(), await saved.text()).toBe(true);
  const sent = saved.request().postDataJSON() as Milestone & { expectedVersion: number };
  expect(sent).toMatchObject({ expectedVersion: milestone.version, title: newTitle, date: newDate, description: newDescription });
  expect(sent.issueIds.sort()).toEqual(expectedIds);
  await expect(editor).toHaveCount(0);
  await expect(end).toHaveValue(draftEnd);
  expect((await snapshot(f)).issues.find(issue => issue.id === anchor.id)).toEqual(anchor);
  expect(writes).toEqual([`PATCH ${milestonePath}`, `PATCH ${milestonePath}`]);

  const previewPath = '/api/schedule/manual-preview', applyPath = '/api/schedule/manual-apply';
  const preview = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === previewPath);
  const apply = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === applyPath);
  const saveRow = row.getByRole('button', { name: `${anchor.key} 날짜 저장`, exact: true });
  await saveRow.click();
  expect((await preview).request().postDataJSON()).toEqual({ changes: [{ id: anchor.id, expectedVersion: anchor.version, startDate: anchor.startDate, endDate: draftEnd }] });
  const applied = await apply;
  expect(applied.ok(), await applied.text()).toBe(true);
  await expect(saveRow).toHaveCount(0);
  const after = await snapshot(f);
  expect(after.issues.find(issue => issue.id === anchor.id)).toMatchObject({ endDate: draftEnd, version: anchor.version + 1 });
  const savedMilestone = after.milestones?.find(item => item.id === milestone.id);
  expect(savedMilestone).toMatchObject({ title: newTitle, date: newDate, description: newDescription, version: milestone.version + 1 });
  expect(savedMilestone?.issueIds.sort()).toEqual(expectedIds);
  expect(writes).toEqual([`PATCH ${milestonePath}`, `PATCH ${milestonePath}`, `POST ${previewPath}`, `POST ${applyPath}`]);
});

test('이정표를 만들고 불변 기준선을 저장해 현재 일정 차이와 삭제된 기록을 비교한다', async ({ page, artifacts: f }) => {
  const project = f.workspace.projects[0], issue = await createIssue(f, '출시 작업');
  await page.goto(`/#/${project.id}/gantt`);
  const panel = page.getByRole('region', { name: '이정표와 일정 기준선', exact: true });
  await panel.getByRole('button', { name: '이정표 만들기', exact: true }).click();
  const editor = panel.getByRole('form', { name: '이정표 편집', exact: true });
  await editor.getByLabel('이정표 제목', { exact: true }).fill(`${f.prefix} 출시 승인`);
  await editor.getByLabel('이정표 날짜', { exact: true }).fill(day(5));
  await editor.getByLabel('이정표 책임자', { exact: true }).selectOption(f.workspace.users[0].id);
  await editor.getByLabel('이정표 설명', { exact: true }).fill('문서와 검증을 마친 뒤 승인하는 합성 이정표');
  await editor.getByLabel(`${issue.key} 이정표 연결`, { exact: true }).check();
  const milestoneResponse = page.waitForResponse(value => value.url().endsWith('/api/milestones') && value.request().method() === 'POST');
  await editor.getByRole('button', { name: '이정표 저장', exact: true }).click();
  const milestone = await (await milestoneResponse).json() as Milestone;
  expect(milestone.issueIds).toEqual([issue.id]); expect(milestone.ownerId).toBe(f.workspace.users[0].id);
  await expect(editor).toHaveCount(0);
  await panel.getByRole('button', { name: '기준선 저장', exact: true }).click();
  const capture = panel.getByRole('form', { name: '일정 기준선 저장', exact: true });
  const name = `${f.prefix} 승인 기준선`;
  await capture.getByLabel('기준선 이름', { exact: true }).fill(name);
  await capture.getByLabel('기준선 설명', { exact: true }).fill('승인 시점의 날짜와 제목은 이후 변경과 관계없이 유지');
  const captureResponse = page.waitForResponse(value => value.url().endsWith('/api/baselines') && value.request().method() === 'POST');
  await capture.getByRole('button', { name: '기준선 확정 저장', exact: true }).click();
  const baseline = await (await captureResponse).json() as ScheduleBaseline;
  await expect(panel.getByLabel('비교 기준선', { exact: true })).toHaveValue(baseline.id);
  expect(baseline.issues.find(value => value.issueId === issue.id)?.endDate).toBe(issue.endDate);
  expect((await f.request.patch(`/api/issues/${issue.id}`, { data: { expectedVersion: issue.version, endDate: day(7) } })).status()).toBe(200);
  expect((await f.request.patch(`/api/milestones/${milestone.id}`, { data: { expectedVersion: milestone.version, date: day(8), status: 'reached' } })).status()).toBe(200);
  await page.reload(); await panel.getByLabel('비교 기준선', { exact: true }).selectOption(baseline.id);
  const row = page.locator(`.gantt-row[data-issue-id="${issue.id}"]`);
  await expect(row).toContainText('종료 +3일');
  await expect(row.getByRole('img', { name: `${issue.key} 기준선 ${issue.startDate} ~ ${issue.endDate}`, exact: true })).toBeAttached();
  await expect(page.locator(`[data-milestone-id="${milestone.id}"]`)).toContainText('기준선 대비 +3일');
  mkdirSync('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/schedule-planning.png', fullPage: true });
  let latest = await snapshot(f); const liveIssue = latest.issues.find(value => value.id === issue.id)!;
  expect((await f.request.delete(`/api/issues/${issue.id}?expectedVersion=${liveIssue.version}`)).status()).toBe(200);
  latest = await snapshot(f); const liveMilestone = latest.milestones!.find(value => value.id === milestone.id)!;
  expect(liveMilestone.issueIds).toEqual([]);
  expect((await f.request.delete(`/api/milestones/${milestone.id}?expectedVersion=${liveMilestone.version}`)).status()).toBe(200);
  await page.reload(); await panel.getByLabel('비교 기준선', { exact: true }).selectOption(baseline.id);
  await expect(page.locator(`[data-baseline-issue-id="${issue.id}"]`)).toContainText('삭제된 업무 기록');
  expect(await (await f.request.get(`/api/baselines/${baseline.id}`)).json()).toEqual(baseline);
  page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '선택한 기준선 삭제', exact: true }).click();
  await expect(panel.getByLabel('비교 기준선', { exact: true })).toHaveValue('');
});

test('기준선 충돌은 입력을 보존하고 명시적 최신 확인 후 저장하며 저장 중 탐색을 막는다', async ({ page, artifacts: f }) => {
  const project = f.workspace.projects[0], issue = await createIssue(f, '충돌 업무');
  await page.goto(`/#/${project.id}/gantt`);
  const panel = page.getByRole('region', { name: '이정표와 일정 기준선', exact: true });
  await panel.getByRole('button', { name: '기준선 저장', exact: true }).click();
  const form = panel.getByRole('form', { name: '일정 기준선 저장', exact: true }), name = `${f.prefix} 충돌 보존`;
  await form.getByLabel('기준선 이름', { exact: true }).fill(name);
  await form.getByLabel('기준선 설명', { exact: true }).fill('내가 작성한 설명');
  expect((await f.request.patch(`/api/issues/${issue.id}`, { data: { expectedVersion: issue.version, endDate: day(9) } })).status()).toBe(200);
  const response = page.waitForResponse(value => value.url().endsWith('/api/baselines') && value.request().method() === 'POST');
  await form.getByRole('button', { name: '기준선 확정 저장', exact: true }).click(); expect((await response).status()).toBe(409);
  await expect(panel.getByRole('alert')).toContainText('작성한 입력은 유지됩니다');
  await expect(form.getByLabel('기준선 이름', { exact: true })).toHaveValue(name);
  await expect(form.getByLabel('기준선 설명', { exact: true })).toHaveValue('내가 작성한 설명');
  await form.getByRole('button', { name: '최신 자료로 다시 확인', exact: true }).click();
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let report = () => {}; const held = new Promise<void>(resolve => { report = resolve; });
  await page.route('**/api/baselines', async route => { if (route.request().method() !== 'POST') return route.continue(); const reply = await route.fetch(); report(); await gate; await route.fulfill({ response: reply }); });
  try {
    await form.getByRole('button', { name: '기준선 확정 저장', exact: true }).click(); await held;
    await expect(form.getByLabel('기준선 이름', { exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
    release(); await expect(form).toHaveCount(0);
    const saved = (await snapshot(f)).baselines!.find(value => value.name === name)!;
    expect(saved.issues.find(value => value.issueId === issue.id)?.endDate).toBe(day(9));
  } finally { release(); }
});

test('이정표 충돌과 탐색 취소는 입력을 보존하고 이동 및 작업자 변경을 승인하면 초기화한다', async ({ page, artifacts: f }) => {
  const project = f.workspace.projects[0], issue = await createIssue(f, '연결 상세'), milestone = await createMilestone(f, '편집 대상', [issue.id]);
  const ganttPath = `#/${project.id}/gantt`, exitPath = `#/${project.id}/teamboard`;
  await page.goto(`/${ganttPath}`);
  const panel = page.getByRole('region', { name: '이정표와 일정 기준선', exact: true });
  await panel.locator('summary').click(); await panel.locator('.schedule-milestone-name').filter({ hasText: milestone.title }).click();
  const editor = panel.getByRole('form', { name: '이정표 편집', exact: true }), title = editor.getByLabel('이정표 제목', { exact: true });
  await title.fill(`${f.prefix} 보존할 입력`);
  expect((await f.request.patch(`/api/milestones/${milestone.id}`, { data: { expectedVersion: milestone.version, description: '외부 변경' } })).status()).toBe(200);
  const conflict = page.waitForResponse(value => value.url().endsWith(`/api/milestones/${milestone.id}`) && value.request().method() === 'PATCH');
  await editor.getByRole('button', { name: '이정표 저장', exact: true }).click(); expect((await conflict).status()).toBe(409);
  await expect(title).toHaveValue(`${f.prefix} 보존할 입력`);
  async function leave(accept: boolean) {
    const prompt = page.waitForEvent('dialog', { timeout: 5000 }).then(async confirmation => {
      expect(confirmation.message()).toContain('작성 중인 일정 정보');
      if (accept) await confirmation.accept();
      else await confirmation.dismiss();
    });
    await Promise.all([prompt, page.evaluate(hash => { location.hash = hash; }, exitPath)]);
  }
  await leave(false);
  await expect(page).toHaveURL(url => url.hash === ganttPath);
  await expect(title).toHaveValue(`${f.prefix} 보존할 입력`);
  await leave(true);
  await expect(page).toHaveURL(url => url.hash === exitPath);
  await expect(editor).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(url => url.hash === ganttPath);
  await panel.locator('summary').click();
  await panel.locator('.schedule-milestone-name').filter({ hasText: milestone.title }).click();
  await expect(editor.getByLabel('이정표 설명', { exact: true })).toHaveValue('외부 변경');
  await title.fill(`${f.prefix} 작업자 임시 입력`);
  const actor = page.getByLabel('작업자 선택', { exact: true }), oldActor = await actor.inputValue(), nextActor = f.workspace.users.find(value => value.id !== oldActor)!;
  page.once('dialog', dialog => dialog.dismiss()); await actor.selectOption(nextActor.id); await expect(actor).toHaveValue(oldActor); await expect(title).toHaveValue(`${f.prefix} 작업자 임시 입력`);
  page.once('dialog', dialog => dialog.accept()); await actor.selectOption(nextActor.id); await expect(editor).toHaveCount(0);
  await panel.locator('summary').click(); await panel.locator('.schedule-milestone-name').filter({ hasText: milestone.title }).click();
  await expect(title).toHaveValue(milestone.title);
});
