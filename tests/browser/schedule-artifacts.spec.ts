import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
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
async function createIssue(f: ArtifactFixture, suffix: string) { const response = await f.request.post('/api/issues', { data: { projectId: f.workspace.projects[0].id, title: `${f.prefix} ${suffix}`, startDate: day(0), endDate: day(4) } }); expect(response.status()).toBe(201); return await response.json() as Issue; }
async function createMilestone(f: ArtifactFixture, suffix: string, issueIds: string[] = []) { const response = await f.request.post('/api/milestones', { data: { projectId: f.workspace.projects[0].id, title: `${f.prefix} ${suffix}`, date: day(5), issueIds } }); expect(response.status()).toBe(201); return await response.json() as Milestone; }

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

test('이정표 충돌과 탐색 취소는 입력을 보존하고 승인한 버리기는 남아있는 화면에서도 실제로 초기화한다', async ({ page, artifacts: f }) => {
  const project = f.workspace.projects[0], issue = await createIssue(f, '연결 상세'), milestone = await createMilestone(f, '편집 대상', [issue.id]);
  await page.goto(`/#/${project.id}/gantt`);
  const panel = page.getByRole('region', { name: '이정표와 일정 기준선', exact: true });
  await panel.locator('summary').click(); await panel.locator('.schedule-milestone-name').filter({ hasText: milestone.title }).click();
  const editor = panel.getByRole('form', { name: '이정표 편집', exact: true }), title = editor.getByLabel('이정표 제목', { exact: true });
  await title.fill(`${f.prefix} 보존할 입력`);
  expect((await f.request.patch(`/api/milestones/${milestone.id}`, { data: { expectedVersion: milestone.version, description: '외부 변경' } })).status()).toBe(200);
  const conflict = page.waitForResponse(value => value.url().endsWith(`/api/milestones/${milestone.id}`) && value.request().method() === 'PATCH');
  await editor.getByRole('button', { name: '이정표 저장', exact: true }).click(); expect((await conflict).status()).toBe(409);
  await expect(title).toHaveValue(`${f.prefix} 보존할 입력`);
  const issueOption = editor.locator('.schedule-milestone-issues label').filter({ hasText: issue.key });
  page.once('dialog', dialog => dialog.dismiss()); await issueOption.getByRole('button', { name: '상세', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(title).toHaveValue(`${f.prefix} 보존할 입력`);
  page.once('dialog', dialog => dialog.accept()); await issueOption.getByRole('button', { name: '상세', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await expect(editor).toHaveCount(0);
  await page.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
  await panel.locator('.schedule-milestone-name').filter({ hasText: milestone.title }).click();
  await expect(editor.getByLabel('이정표 설명', { exact: true })).toHaveValue('외부 변경');
  await title.fill(`${f.prefix} 작업자 임시 입력`);
  const actor = page.getByLabel('작업자 선택', { exact: true }), oldActor = await actor.inputValue(), nextActor = f.workspace.users.find(value => value.id !== oldActor)!;
  page.once('dialog', dialog => dialog.dismiss()); await actor.selectOption(nextActor.id); await expect(actor).toHaveValue(oldActor); await expect(title).toHaveValue(`${f.prefix} 작업자 임시 입력`);
  page.once('dialog', dialog => dialog.accept()); await actor.selectOption(nextActor.id); await expect(editor).toHaveCount(0);
  await panel.locator('summary').click(); await panel.locator('.schedule-milestone-name').filter({ hasText: milestone.title }).click();
  await expect(title).toHaveValue(milestone.title);
});
