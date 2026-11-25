import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { AutomaticSchedulePreview, Issue, Milestone, ScheduleBaseline, SchedulePreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';
import { applyGanttLink, reviewGanttLink } from './gantt-link-review';

const snapshot = async (request: APIRequestContext) => await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
const addDays = (date: string, amount: number) => new Date(Date.parse(`${date}T00:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
const nextMonday = () => { const today = new Date().toISOString().slice(0, 10); return addDays(today, (1 - new Date(`${today}T00:00:00Z`).getUTCDay() + 7) % 7 + 7); };
async function issue(request: APIRequestContext, projectId: string, title: string, startDate: string | null, endDate: string | null) { const response = await request.post('/api/issues', { data: { projectId, title, startDate, endDate } }); expect(response.ok()).toBeTruthy(); return await response.json() as Issue; }
async function capture(request: APIRequestContext, projectId: string, name: string) { const data = await snapshot(request); const response = await request.post('/api/baselines', { data: { projectId, name, expectedIssueVersions: Object.fromEntries(data.issues.filter(value => value.projectId === projectId).map(value => [value.id, value.version])), expectedMilestoneVersions: Object.fromEntries((data.milestones || []).filter(value => value.projectId === projectId).map(value => [value.id, value.version])), expectedCalendarVersion: data.calendars!.find(value => value.projectId === projectId)!.version } }); expect(response.ok()).toBeTruthy(); return await response.json() as ScheduleBaseline; }
async function cleanup(request: APIRequestContext, issues: string[], milestones: string[] = [], baselines: string[] = []) { for (const id of issues) await request.delete(`/api/issues/${id}`); const data = await snapshot(request); for (const id of milestones) { const item = data.milestones?.find(value => value.id === id); if (item) await request.delete(`/api/milestones/${id}?expectedVersion=${item.version}`); } for (const id of baselines) { const item = data.baselines?.find(value => value.id === id); if (item) await request.delete(`/api/baselines/${id}?expectedVersion=${item.version}`); } }

test('360px 간트에서 업무 연결 유형과 음수 간격을 수정하고 종료 조건의 일정을 검토해 적용한다', async ({page,request}) => {
  const data = await snapshot(request), project = data.projects[0], monday = nextMonday();
  const tuesday = addDays(monday,1), wednesday = addDays(monday,2), thursday = addDays(monday,3);
  const prefix = `간트 연결 경계 ${Date.now()}`;
  const predecessor = await issue(request,project.id,`${prefix} 선행`,monday,thursday);
  const successor = await issue(request,project.id,`${prefix} 후행`,monday,tuesday);
  try {
    await page.setViewportSize({width:360,height:820});
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색').fill(prefix);
    const connectionList = page.getByRole('region',{name:'업무 연결 목록',exact:true});
    await connectionList.getByRole('button',{name:'연결 추가',exact:true}).click();
    const create = page.getByRole('dialog',{name:'선행·후행 업무 연결',exact:true});
    await create.getByLabel('선행 업무',{exact:true}).selectOption(predecessor.id);
    await create.getByLabel('후행 업무',{exact:true}).selectOption(successor.id);
    await create.getByLabel('연결 유형',{exact:true}).selectOption('SS');
    await create.getByLabel('추가 간격 근무일',{exact:true}).fill('1');
    const creation = await reviewGanttLink(page, create);
    expect(creation.input.dependency).toMatchObject({ action:'add',type:'SS',lagDays:1 });
    expect(creation.preview.dependencyChanges).toMatchObject([{ predecessorKey:predecessor.key,successorKey:successor.key,
      before:null,after:{type:'SS',lagDays:1} }]);
    expect(await applyGanttLink(page, create)).toMatchObject({ dependencyChanges:1,updated:[] });
    await expect(create).toHaveCount(0);
    const dependency = (await snapshot(request)).dependencies.find(value => value.predecessorId===predecessor.id && value.successorId===successor.id)!;
    expect(dependency).toMatchObject({type:'SS',lagDays:1});
    const path = page.locator(`[data-dependency-id="${dependency.id}"]`);
    await expect(path).toHaveAttribute('data-dependency-type','SS');
    await expect(path).toHaveAttribute('data-predecessor-anchor','startDate');
    await expect(path).toHaveAttribute('data-successor-anchor','startDate');

    await connectionList.getByRole('button',{name:`${predecessor.key}와 ${successor.key} 연결 수정`,exact:true}).click();
    const edit = page.getByRole('dialog',{name:'업무 연결 수정',exact:true});
    await expect(edit.getByLabel('연결 유형',{exact:true})).toHaveValue('SS');
    await edit.getByLabel('연결 유형',{exact:true}).selectOption('FF');
    await edit.getByLabel('추가 간격 근무일',{exact:true}).fill('-1');
    const update = await reviewGanttLink(page, edit);
    expect(update.input.dependency).toMatchObject({ action:'update',id:dependency.id,expectedVersion:dependency.version??1,type:'FF',lagDays:-1 });
    expect(update.preview.dependencyChanges).toMatchObject([{ before:{type:'SS',lagDays:1},after:{type:'FF',lagDays:-1} }]);
    expect(await applyGanttLink(page, edit)).toMatchObject({ dependencyChanges:1,updated:[] });
    await expect(edit).toHaveCount(0);
    expect((await snapshot(request)).dependencies.find(value=>value.id===dependency.id)).toMatchObject({type:'FF',lagDays:-1});
    await expect(connectionList).toContainText('-1근무일');
    await expect(path).toHaveAttribute('data-dependency-type','FF');
    await expect(path).toHaveAttribute('data-predecessor-anchor','endDate');
    await expect(path).toHaveAttribute('data-successor-anchor','endDate');
    expect((await snapshot(request)).issues.find(value=>value.id===successor.id)?.endDate).toBe(tuesday);

    await page.getByRole('checkbox',{name:`${successor.key} 선택`,exact:true}).check();
    await page.getByRole('button',{name:'자동 일정',exact:true}).click();
    const proposal = page.getByRole('dialog',{name:'자동 일정 제안',exact:true});
    await proposal.getByRole('button',{name:'자동 일정 미리보기',exact:true}).click();
    await expect(proposal.locator('.automatic-new-dates')).toContainText(wednesday);
    expect((await snapshot(request)).issues.find(value=>value.id===successor.id)?.endDate).toBe(tuesday);
    await proposal.getByRole('button',{name:'자동 일정 적용',exact:true}).click();
    await expect(proposal).toHaveCount(0);
    await expect.poll(async () => (await snapshot(request)).issues.find(value=>value.id===successor.id)?.endDate).toBe(wednesday);
    const current = (await snapshot(request)).issues.find(value=>value.id===successor.id);
    expect(current?.startDate).toBe(tuesday);
    await page.getByRole('button',{name:'되돌리기',exact:true}).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value=>value.id===successor.id)?.startDate).toBe(monday);
  } finally { await cleanup(request,[successor.id,predecessor.id]); }
});

test('업무 달력의 날짜 예외를 저장하고 근무일 이동은 달력 변경 충돌을 보존한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0], original = initial.calendars!.find(value => value.projectId === project.id)!;
  const monday = nextMonday(), friday = addDays(monday, -3), saturday = addDays(monday, -2), tuesday = addDays(monday, 1);
  const item = await issue(request, project.id, `달력 이동 ${Date.now()}`, friday, friday);
  try {
    await page.goto(`/#/${project.id}/settings`);
    const editor = page.getByRole('region', { name: '업무 달력 설정' });
    await editor.getByLabel('업무 달력 이름', { exact: true }).fill('보존할 달력 입력');
    expect((await request.patch(`/api/projects/${project.id}/calendar`, { data: { ...original, expectedVersion: original.version, name: '다른 작업자의 달력' } })).ok()).toBeTruthy();
    const conflict = page.waitForResponse(value => value.url().endsWith(`/projects/${project.id}/calendar`) && value.request().method() === 'PATCH');
    await editor.getByRole('button', { name: '업무 달력 저장', exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(editor.getByLabel('업무 달력 이름', { exact: true })).toHaveValue('보존할 달력 입력');
    page.once('dialog', dialog => dialog.accept());
    await editor.getByRole('button', { name: '최신 달력', exact: true }).click();
    await expect(editor.getByLabel('업무 달력 이름', { exact: true })).toHaveValue('다른 작업자의 달력');
    await expect(editor.getByLabel('업무 달력 이름', { exact: true })).toBeEnabled();
    for (const weekday of ['월요일', '화요일', '수요일', '목요일', '금요일']) await editor.getByRole('checkbox', { name: `${weekday} 근무`, exact: true }).check();
    for (const weekday of ['일요일', '토요일']) await editor.getByRole('checkbox', { name: `${weekday} 근무`, exact: true }).uncheck();
    await editor.getByRole('button', { name: '예외 날짜 추가', exact: true }).click();
    await editor.getByLabel('예외 1 날짜', { exact: true }).fill(monday);
    await editor.getByLabel('예외 1 설명', { exact: true }).fill('팀 휴무');
    await editor.getByRole('button', { name: '예외 날짜 추가', exact: true }).click();
    await editor.getByLabel('예외 2 날짜', { exact: true }).fill(saturday);
    await editor.getByLabel('예외 2 근무 여부', { exact: true }).selectOption('true');
    await editor.getByLabel('예외 2 설명', { exact: true }).fill('대체 근무');
    await editor.getByRole('button', { name: '업무 달력 저장', exact: true }).click();
    await expect(editor.getByRole('button', { name: '업무 달력 저장', exact: true })).toBeDisabled();
    await expect(editor.getByLabel('업무 달력 이름', { exact: true })).toBeEnabled();
    const calendar = (await snapshot(request)).calendars!.find(value => value.projectId === project.id)!;
    expect(calendar.exceptions).toEqual(expect.arrayContaining([{ date: monday, isWorking: false, label: '팀 휴무' }, { date: saturday, isWorking: true, label: '대체 근무' }]));

    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색').fill(item.title);
    await expect(page.locator(`.gantt-days > span[data-date="${monday}"]`)).toHaveClass(/weekend/);
    await expect(page.locator(`.gantt-days > span[data-date="${saturday}"]`)).not.toHaveClass(/weekend/);
    await page.getByRole('checkbox', { name: `${item.key} 선택`, exact: true }).check();
    await page.locator('.gantt-toolbar').getByRole('button', { name: /일정 이동$/ }).click();
    await page.getByLabel('이동 일수', { exact: true }).fill('2');
    const previewResponse = page.waitForResponse(value => value.url().endsWith('/api/schedule/manual-preview') && value.request().method() === 'POST');
    await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const reviewed = await previewResponse;
    expect(reviewed.ok(), await reviewed.text()).toBeTruthy();
    expect(reviewed.request().postDataJSON()).toEqual({ issueIds: [item.id], days: 2, workingDays: true,
      expectedProjects: [{ id: item.id, projectId: item.projectId }] });
    const proposal = await reviewed.json() as SchedulePreview;
    expect(proposal.previewId).toBeTruthy();
    const preview = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    await expect(preview.locator('.gantt-new-dates')).toContainText(tuesday);
    expect((await request.patch(`/api/projects/${project.id}/calendar`, { data: { ...calendar, expectedVersion: calendar.version, exceptions: [...calendar.exceptions, { date: tuesday, isWorking: false, label: '추가 휴무' }] } })).ok()).toBeTruthy();
    const apply = page.waitForResponse(value => value.url().endsWith('/api/schedule/manual-apply') && value.request().method() === 'POST');
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    const rejected = await apply;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().postDataJSON()).toEqual({ previewId: proposal.previewId });
    await expect(preview.getByRole('alert')).toBeVisible();
    await expect(preview.locator('.gantt-new-dates')).toContainText(tuesday);
    expect((await snapshot(request)).issues.find(value => value.id === item.id)?.startDate).toBe(friday);
    await preview.getByRole('button', { name: '취소', exact: true }).click();
    await page.locator('.gantt-toolbar').getByRole('button', { name: /일정 이동$/ }).click();
    await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    await expect(preview.locator('.gantt-new-dates')).toContainText(addDays(tuesday, 1));
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === item.id)?.startDate).toBe(addDays(tuesday, 1));
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === item.id)?.startDate).toBe(friday);
  } finally { await cleanup(request, [item.id]); const latest = await (await request.get(`/api/projects/${project.id}/calendar`)).json() as WorkCalendar; await request.patch(`/api/projects/${project.id}/calendar`, { data: { ...original, expectedVersion: latest.version } }); }
});

test('선후행 자동 제안은 적용 전 날짜를 보존하고 기준선·이정표·되돌리기를 함께 표시한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0], monday = nextMonday(), prefix = `자동 계획 ${Date.now()}`;
  const first = await issue(request, project.id, `${prefix} 설계`, monday, addDays(monday, 1));
  const second = await issue(request, project.id, `${prefix} 구현`, monday, addDays(monday, 1));
  const milestones: string[] = [], baselines: string[] = [];
  try {
    expect((await request.post('/api/dependencies', { data: { predecessorId: first.id, successorId: second.id, lagDays: 0 } })).ok()).toBeTruthy();
    expect((await snapshot(request)).issues.find(value => value.id === second.id)?.startDate).toBe(monday);
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색').fill(prefix);
    await page.getByRole('button', { name: '이정표 만들기', exact: true }).click();
    const milestoneForm = page.getByRole('form', { name: '이정표 편집', exact: true });
    await milestoneForm.getByLabel('이정표 제목', { exact: true }).fill(`${prefix} 출시 검토`);
    await milestoneForm.getByLabel('이정표 날짜', { exact: true }).fill(addDays(monday, 4));
    await milestoneForm.getByLabel('이정표 책임자', { exact: true }).selectOption(initial.users[0].id);
    await milestoneForm.getByRole('checkbox', { name: `${second.key} 이정표 연결`, exact: true }).check();
    const milestoneSaved = page.waitForResponse(value => value.url().endsWith('/api/milestones') && value.request().method() === 'POST');
    await milestoneForm.getByRole('button', { name: '이정표 저장', exact: true }).click();
    const milestone = await (await milestoneSaved).json() as Milestone; milestones.push(milestone.id);
    await expect(milestoneForm).toHaveCount(0);
    await page.getByRole('button', { name: '기준선 저장', exact: true }).click();
    const baselineForm = page.getByRole('form', { name: '일정 기준선 저장', exact: true });
    await baselineForm.getByLabel('기준선 이름', { exact: true }).fill(`${prefix} 착수 계획`);
    const baselineSaved = page.waitForResponse(value => value.url().endsWith('/api/baselines') && value.request().method() === 'POST');
    await baselineForm.getByRole('button', { name: '기준선 확정 저장', exact: true }).click();
    const baseline = await (await baselineSaved).json() as ScheduleBaseline; baselines.push(baseline.id);
    await expect(page.getByLabel('비교 기준선', { exact: true })).toHaveValue(baseline.id);
    for (const item of [first, second]) await page.getByRole('checkbox', { name: `${item.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '자동 일정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '자동 일정 제안', exact: true });
    await dialog.getByRole('button', { name: '자동 일정 미리보기', exact: true }).click();
    await expect(dialog.locator('.automatic-new-dates')).toContainText(addDays(monday, 2));
    expect((await snapshot(request)).issues.find(value => value.id === second.id)?.startDate).toBe(monday);
    await dialog.getByRole('button', { name: '자동 일정 적용', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === second.id)?.endDate).toBe(addDays(monday, 3));
    const row = page.locator(`[data-issue-id="${second.id}"]`);
    await expect(row.locator('.gantt-baseline-delta')).toHaveText('종료 +2일 · 달력일');
    await expect(row.getByRole('img', { name: `${second.key} 기준선 ${monday} ~ ${addDays(monday, 1)}`, exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: `${milestone.title} 마일스톤 ${milestone.date}`, exact: true })).toBeVisible();
    await page.locator('.gantt-zoom').getByRole('button', { name: '주', exact: true }).click();
    mkdirSync('docs/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/screenshots/gantt-advanced.png', fullPage: true });
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === second.id)?.endDate).toBe(addDays(monday, 1));
    const savedBaseline = await (await request.get(`/api/baselines/${baseline.id}`)).json() as ScheduleBaseline;
    expect(savedBaseline.issues.find(value => value.issueId === second.id)?.endDate).toBe(addDays(monday, 1));
  } finally { await cleanup(request, [first.id, second.id], milestones, baselines); }
});

test('삭제된 기준선 기록과 먼 날짜는 보존하며 표시 날짜 수는 180일로 제한한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0], prefix = `범위 기록 ${Date.now()}`;
  const item = await issue(request, project.id, `${prefix} 과거 업무`, '1900-01-01', '1900-01-02');
  const response = await request.post('/api/milestones', { data: { projectId: project.id, title: `${prefix} 미래 이정표`, date: '2099-12-31' } }); expect(response.ok()).toBeTruthy();
  const milestone = await response.json() as Milestone;
  let baseline: ScheduleBaseline | null = null;
  try {
    baseline = await capture(request, project.id, `${prefix} 기준선`);
    expect((await request.delete(`/api/issues/${item.id}`)).ok()).toBeTruthy();
    expect((await request.delete(`/api/milestones/${milestone.id}?expectedVersion=${milestone.version}`)).ok()).toBeTruthy();
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색').fill(prefix);
    await page.getByLabel('비교 기준선', { exact: true }).selectOption(baseline.id);
    const history = page.locator(`[data-baseline-issue-id="${item.id}"]`);
    await expect(history).toContainText(item.title);
    await expect(history).toContainText('삭제된 업무 기록');
    expect(await page.locator('.gantt-days > span').count()).toBeLessThanOrEqual(180);
    await history.getByRole('button', { name: '1900-01-01', exact: true }).click();
    await expect(history.getByRole('img', { name: `${item.key} 삭제된 업무 기준선 1900-01-01 ~ 1900-01-02`, exact: true })).toBeVisible();
    const milestoneHistory = page.locator('.gantt-history-row').filter({ hasText: milestone.title });
    await expect(milestoneHistory).toContainText('삭제된 마일스톤 기록');
    await milestoneHistory.getByRole('button', { name: '2099-12-31', exact: true }).click();
    await expect(milestoneHistory.getByRole('img', { name: `${milestone.title} 삭제된 마일스톤 기준선 2099-12-31`, exact: true })).toBeVisible();
    expect(await page.locator('.gantt-days > span').count()).toBeLessThanOrEqual(180);
    await page.locator('.gantt-baseline-records summary').click();
    await expect(page.locator('.gantt-baseline-records')).toContainText(item.title);
  } finally { await cleanup(request, [item.id], [milestone.id], baseline ? [baseline.id] : []); }
});

test('자동 일정의 차단 진단과 오래된 제안은 적용하지 않고 입력과 미리보기를 유지한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0], monday = nextMonday(), prefix = `자동 충돌 ${Date.now()}`;
  const undated = await issue(request, project.id, `${prefix} 미정`, null, null), partial = await issue(request, project.id, `${prefix} 부분`, monday, null);
  try {
    await page.goto(`/#/${project.id}/gantt`); await page.getByLabel('간트 업무 검색').fill(prefix);
    for (const item of [undated, partial]) await page.getByRole('checkbox', { name: `${item.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '자동 일정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '자동 일정 제안', exact: true });
    await dialog.getByRole('button', { name: '자동 일정 미리보기', exact: true }).click();
    await expect(dialog.locator('.automatic-blocking')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '자동 일정 적용', exact: true })).toBeDisabled();
    const actor = page.getByLabel('작업자 선택', { exact: true }), previousActor = await actor.inputValue(), nextActor = initial.users.find(value => value.id !== previousActor)!;
    page.once('dialog', value => value.dismiss()); await actor.selectOption(nextActor.id); await expect(actor).toHaveValue(previousActor); await expect(dialog.locator('.automatic-blocking')).toBeVisible();
    page.once('dialog', value => value.accept()); await actor.selectOption(nextActor.id); await expect(dialog).toHaveCount(0);
    await page.getByLabel('간트 업무 검색').fill(prefix);
    await page.getByRole('checkbox', { name: `${undated.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '자동 일정', exact: true }).click();
    await dialog.getByRole('checkbox', { name: '날짜가 없는 업무에 명시한 기간 사용', exact: true }).check();
    await dialog.getByLabel('자동 일정 기준 시작일', { exact: true }).fill(monday);
    await dialog.getByLabel('자동 일정 기본 기간', { exact: true }).fill('3');
    const proposed = page.waitForResponse(value => value.url().endsWith('/schedule/auto-preview') && value.request().method() === 'POST');
    await dialog.getByRole('button', { name: '자동 일정 미리보기', exact: true }).click();
    const proposal = await (await proposed).json() as AutomaticSchedulePreview;
    await expect(dialog.locator('.automatic-new-dates')).toContainText(addDays(monday, 2));
    expect((await request.patch(`/api/issues/${undated.id}`, { data: { expectedVersion: undated.version, description: '다른 작업자의 변경' } })).ok()).toBeTruthy();
    const apply = page.waitForResponse(value => value.url().endsWith('/schedule/auto-apply') && value.request().method() === 'POST');
    await dialog.getByRole('button', { name: '자동 일정 적용', exact: true }).click();
    const rejected = await apply; expect(rejected.status()).toBe(409); expect(rejected.request().postDataJSON()).toEqual({ previewId: proposal.previewId });
    await expect(dialog.getByRole('alert')).toContainText('입력과 제안을 유지했습니다');
    await expect(dialog.locator('.automatic-new-dates')).toContainText(addDays(monday, 2));
    expect((await snapshot(request)).issues.find(value => value.id === undated.id)?.startDate).toBeNull();
    await dialog.getByRole('button', { name: '조건 다시 입력', exact: true }).click();
    await expect(dialog.getByLabel('자동 일정 기준 시작일', { exact: true })).toHaveValue(monday);
    await dialog.getByRole('button', { name: '자동 일정 미리보기', exact: true }).click();
    await dialog.getByRole('button', { name: '자동 일정 적용', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === undated.id)?.endDate).toBe(addDays(monday, 2));
  } finally { await cleanup(request, [undated.id, partial.id]); }
});

test('간트 초안의 작업자 탐색을 보호하고 외부 갱신 후 날짜 저장은 원래 버전으로 충돌한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0], monday = nextMonday(), prefix = `날짜 초안 ${Date.now()}`;
  const first = await issue(request, project.id, `${prefix} 첫 업무`, monday, addDays(monday, 1)), second = await issue(request, project.id, `${prefix} 새로고침 업무`, monday, addDays(monday, 1));
  try {
    await page.goto(`/#/${project.id}/gantt`); await page.getByLabel('간트 업무 검색').fill(prefix);
    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    const create = page.getByRole('form', { name: '간트에서 업무 만들기' }); await create.getByLabel('추가할 업무 제목').fill('보존할 간트 초안');
    const actor = page.getByLabel('작업자 선택', { exact: true }), previousActor = await actor.inputValue(), nextActor = initial.users.find(value => value.id !== previousActor)!;
    page.once('dialog', value => value.dismiss()); await actor.selectOption(nextActor.id); await expect(create.getByLabel('추가할 업무 제목')).toHaveValue('보존할 간트 초안');
    page.once('dialog', value => value.accept()); await actor.selectOption(nextActor.id); await expect(create).toHaveCount(0);
    await page.getByLabel('간트 업무 검색').fill(prefix);
    await page.getByLabel(`${second.key} 종료일`, { exact: true }).fill(addDays(monday, 4)); await page.getByLabel(`${second.key} 종료일`, { exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: '되돌리기', exact: true })).toBeEnabled();
    const end = page.getByLabel(`${first.key} 종료일`, { exact: true }); await end.fill(addDays(monday, 3));
    expect((await request.patch(`/api/issues/${first.id}`, { data: { expectedVersion: first.version, description: '새로고침에서 보이는 다른 변경' } })).ok()).toBeTruthy();
    // Dispatch without focus to refresh the workspace while the date draft remains active.
    await page.getByRole('button', { name: '되돌리기', exact: true }).dispatchEvent('click');
    await expect(end).toBeEnabled(); await expect(end).toHaveValue(addDays(monday, 3)); await expect(end).toHaveAttribute('aria-invalid', 'true');
    const rejected = page.waitForResponse(value => value.url().endsWith('/api/schedule/manual-preview') && value.request().method() === 'POST');
    await end.press('Enter'); const result = await rejected; expect(result.status()).toBe(409); expect(result.request().postDataJSON().changes[0].expectedVersion).toBe(first.version);
    const conflict = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    await expect(conflict).toBeVisible();
    await expect(conflict.getByRole('button', { name: '변경 적용', exact: true })).toBeDisabled();
    await expect(end).toBeDisabled();
    await conflict.getByRole('button', { name: '취소', exact: true }).click();
    await expect(conflict).toHaveCount(0);
    await expect(end).toHaveValue(addDays(monday, 3)); await expect(end).toBeEnabled();
    await end.press('Escape'); await expect(end).toHaveValue(addDays(monday, 1)); await expect(end).not.toHaveAttribute('aria-invalid', 'true');
    expect((await snapshot(request)).issues.find(value => value.id === first.id)?.description).toBe('새로고침에서 보이는 다른 변경');
  } finally { await cleanup(request, [first.id, second.id]); }
});

test('자동 일정 응답이 유실되면 같은 제안의 저장 결과와 되돌리기를 확인한다', async ({ page, request }) => {
  const { projects: [project] } = await snapshot(request);
  const monday = nextMonday(), title = `자동 일정 결과 확인 ${Date.now()}`;
  const pending = await issue(request, project.id, title, null, null);
  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색').fill(title);
    await page.getByRole('checkbox', { name: `${pending.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '자동 일정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '자동 일정 제안', exact: true });
    await dialog.getByRole('checkbox', { name: '날짜가 없는 업무에 명시한 기간 사용', exact: true }).check();
    const anchor = dialog.getByLabel('자동 일정 기준 시작일', { exact: true });
    const duration = dialog.getByLabel('자동 일정 기본 기간', { exact: true });
    await anchor.fill(monday);
    await duration.fill('3');
    const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/schedule/auto-preview'));
    await dialog.getByRole('button', { name: '자동 일정 미리보기', exact: true }).click();
    const proposal = await (await previewResponse).json() as AutomaticSchedulePreview;
    expect(proposal.changes).toMatchObject([{ id: pending.id, toStart: monday, toEnd: addDays(monday, 2) }]);

    const attempts: unknown[] = [];
    let undoId: string | undefined;
    await page.route('**/api/schedule/auto-apply', async route => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 2) {
        const applied = await route.fetch();
        expect(applied.ok(), await applied.text()).toBeTruthy();
        undoId = (await applied.json() as { undoId: string }).undoId;
      }
      await route.abort('connectionreset');
    });
    const apply = dialog.getByRole('button', { name: '자동 일정 적용', exact: true });
    const recover = dialog.getByRole('button', { name: '적용 결과 다시 확인', exact: true });
    const resultPath = `/api/schedule/auto-result/${encodeURIComponent(proposal.previewId)}`;
    const row = async () => (await snapshot(request)).issues.find(value => value.id === pending.id);
    async function confirmResult() {
      const response = page.waitForResponse(value => new URL(value.url()).pathname === resultPath && value.request().method() === 'GET');
      await recover.click();
      const result = await response;
      expect(result.ok(), await result.text()).toBeTruthy();
      return result.json();
    }

    await apply.click();
    await expect(recover).toBeVisible();
    await expect(dialog.getByRole('button', { name: '조건 다시 입력', exact: true })).toBeDisabled();
    await expect(anchor).toHaveValue(monday);
    await expect(duration).toHaveValue('3');
    await expect(dialog).toContainText('선택한 업무 1개');
    expect(await confirmResult()).toEqual({ applied: false });
    await expect(dialog.getByRole('status')).toContainText('같은 제안을 다시 적용할 수 있습니다');
    expect(await row()).toMatchObject({ startDate: null, endDate: null, version: pending.version });

    await apply.click();
    await expect(recover).toBeVisible();
    expect(await row()).toMatchObject({ startDate: monday, endDate: addDays(monday, 2), version: pending.version + 1 });
    await page.route('**/api/workspace', route => route.fulfill({ status: 503, json: { error: 'Synthetic reload failure' } }), { times: 1 });
    expect(await confirmResult()).toMatchObject({ undoId, updated: [{ id: pending.id, version: pending.version + 1 }] });
    expect(undoId).toBeTruthy();
    await expect(dialog.getByRole('alert')).toContainText('자동 일정을 저장했습니다');
    await dialog.getByRole('button', { name: '간트 다시 불러오기', exact: true }).click();
    expect(attempts).toEqual([{ previewId: proposal.previewId }, { previewId: proposal.previewId }]);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel(`${pending.key} 종료일`, { exact: true })).toHaveValue(addDays(monday, 2));

    const undoRequest = page.waitForRequest(value => new URL(value.url()).pathname === '/api/schedule/undo' && value.method() === 'POST');
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    expect((await undoRequest).postDataJSON()).toEqual({ undoId });
    await expect(page.getByLabel(`${pending.key} 종료일`, { exact: true })).toHaveValue('');
    expect(await row()).toMatchObject({ startDate: null, endDate: null, version: pending.version + 2 });
  } finally { await cleanup(request, [pending.id]); }
});
