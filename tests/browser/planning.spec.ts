import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { Issue, PlanningItem, PlanningKind, WorkspaceSnapshot } from '../../shared/types';

const labels = { cycle: '사이클', module: '모듈', release: '릴리스' };
const dateAt = (offset: number) => { const date = new Date(); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const snapshot = async (request: APIRequestContext) => await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
async function plan(request: APIRequestContext, projectId: string, kind: PlanningKind, name: string) { const response = await request.post('/api/planning-items', { data: { projectId, kind, name } }); expect(response.ok()).toBeTruthy(); return await response.json() as PlanningItem; }
async function cleanPlan(request: APIRequestContext, id: string) { const response = await request.get(`/api/planning-items/${id}`); if (!response.ok()) return; const item = await response.json() as PlanningItem; await request.delete(`/api/planning-items/${id}?expectedVersion=${item.version}`); }

test('사이클·모듈·릴리스를 생성하고 책임자와 날짜 및 상태를 저장한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0];
  const created: PlanningItem[] = [];
  try {
    await page.goto(`/#/${project.id}/planning`);
    await expect(page.getByRole('heading', { name: '사이클 · 모듈 · 릴리스', exact: true })).toBeVisible();
    for (const kind of ['cycle', 'module', 'release'] as const) {
      await page.locator('.planning-kind-tabs button').filter({ hasText: labels[kind] }).click();
      await page.getByRole('button', { name: `${labels[kind]} 만들기`, exact: true }).first().click();
      const editor = page.getByRole('region', { name: `${labels[kind]} 상세` });
      const name = `${labels[kind]} 브라우저 검사 ${Date.now()}`;
      await editor.getByLabel('계획 이름', { exact: true }).fill(name);
      await editor.getByLabel('계획 설명', { exact: true }).fill('팀 목표와 범위를 검증하는 합성 계획');
      await editor.getByLabel('계획 상태', { exact: true }).selectOption('active');
      await editor.getByLabel('계획 책임자', { exact: true }).selectOption(initial.users[0].id);
      await editor.getByLabel('계획 시작일', { exact: true }).fill(dateAt(0));
      await editor.getByLabel('계획 종료일', { exact: true }).fill(dateAt(7));
      await editor.getByLabel('계획 목표일', { exact: true }).fill(dateAt(9));
      const response = page.waitForResponse(value => value.url().endsWith('/api/planning-items') && value.request().method() === 'POST');
      await editor.getByRole('button', { name: '계획 만들기', exact: true }).click();
      const item = await (await response).json() as PlanningItem; created.push(item);
      expect({ kind: item.kind, owner: item.ownerId, status: item.status, end: item.endDate }).toEqual({ kind, owner: initial.users[0].id, status: 'active', end: dateAt(7) });
      await expect(editor.getByLabel('계획 이름', { exact: true })).toBeEnabled();
      await editor.getByLabel('계획 이름', { exact: true }).fill(`${name} 수정`);
      await editor.getByRole('button', { name: '계획 저장', exact: true }).click();
      await expect.poll(async () => (await snapshot(request)).planningItems?.find(value => value.id === item.id)?.name).toBe(`${name} 수정`);
      await expect(editor.getByLabel('계획 이름', { exact: true })).toBeEnabled();
      await expect(editor.getByRole('button', { name: '계획 저장', exact: true })).toBeDisabled();
    }
  } finally { for (const item of created) await cleanPlan(request, item.id); }
});

test('업무 일괄 배정의 충돌은 전체 취소되고 선택은 유지되며 보관된 현재 연결도 보존된다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0];
  const item = await plan(request, project.id, 'cycle', `배정 검사 ${Date.now()}`);
  const issues: Issue[] = [];
  const prefix = `계획 배정 업무 ${Date.now()}`;
  try {
    for (let index = 0; index < 2; index++) { const response = await request.post('/api/issues', { data: { projectId: project.id, title: `${prefix}-${index}` } }); expect(response.ok()).toBeTruthy(); issues.push(await response.json() as Issue); }
    await page.goto(`/#/${project.id}/planning`);
    await page.locator('.planning-item-card').filter({ hasText: item.name }).click();
    const editor = page.getByRole('region', { name: '사이클 상세' });
    await editor.getByRole('button', { name: '업무 연결·해제', exact: true }).click();
    await editor.getByLabel('연결할 업무 검색', { exact: true }).fill(prefix);
    for (const issue of issues) await editor.getByRole('checkbox', { name: `${issue.key} 계획 연결`, exact: true }).check();
    expect((await request.patch(`/api/issues/${issues[1].id}`, { data: { expectedVersion: issues[1].version, description: '다른 작업자의 변경' } })).ok()).toBeTruthy();
    const conflictResponse = page.waitForResponse(value => value.url().endsWith(`/planning-items/${item.id}/issues`) && value.request().method() === 'POST');
    await editor.getByRole('button', { name: '연결 변경 적용', exact: true }).click();
    expect((await conflictResponse).status()).toBe(409);
    await expect(editor.getByRole('alert')).toContainText('선택한 변경은 유지됩니다');
    const unchanged = await snapshot(request); for (const issue of issues) expect(unchanged.issues.find(value => value.id === issue.id)?.cycleId ?? null).toBeNull();
    for (const issue of issues) await expect(editor.getByRole('checkbox', { name: `${issue.key} 계획 연결`, exact: true })).toBeChecked();
    await editor.getByRole('button', { name: '선택 초기화', exact: true }).click();
    for (const issue of issues) await editor.getByRole('checkbox', { name: `${issue.key} 계획 연결`, exact: true }).check();
    await editor.getByRole('button', { name: '연결 변경 적용', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.filter(value => issues.some(issue => issue.id === value.id) && value.cycleId === item.id).length).toBe(2);
    await expect(editor.getByRole('button', { name: '계획 삭제', exact: true })).toBeDisabled();
    let latest = await snapshot(request);
    for (let index = 0; index < issues.length; index++) { const current = latest.issues.find(value => value.id === issues[index].id)!; expect((await request.patch(`/api/issues/${current.id}`, { data: { expectedVersion: current.version, status: index === 0 ? 'done' : 'cancelled' } })).ok()).toBeTruthy(); }
    await page.reload(); await page.locator('.planning-item-card').filter({ hasText: item.name }).click();
    await expect(editor.locator('.planning-issue-summary strong')).toHaveText('100%');
    mkdirSync('docs/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/screenshots/planning.png', fullPage: true });
    await editor.getByRole('checkbox', { name: `${issues[0].key} 계획 연결`, exact: true }).uncheck();
    await editor.getByRole('button', { name: '연결 변경 적용', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === issues[0].id)?.cycleId ?? null).toBeNull();
    await editor.getByRole('button', { name: '보관 상태로 변경', exact: true }).click();
    await editor.getByRole('button', { name: '계획 저장', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).planningItems?.find(value => value.id === item.id)?.status).toBe('archived');
    await expect(editor.getByLabel('계획 상태', { exact: true })).toBeEnabled();
    await expect(editor.getByLabel('계획 상태', { exact: true })).toHaveValue('archived');
    await editor.locator('.planning-linked-issue').filter({ hasText: issues[1].title }).click();
    const panel = page.getByRole('dialog');
    await expect(panel.getByLabel('사이클', { exact: true })).toHaveValue(item.id);
    await expect(panel.getByLabel('사이클', { exact: true }).locator('option:checked')).toContainText('보관됨');
    await panel.getByLabel('설명', { exact: true }).fill('보관된 현재 연결은 유지합니다.');
    const saved = page.waitForResponse(value => value.url().endsWith(`/api/issues/${issues[1].id}`) && value.request().method() === 'PATCH');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(panel.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
    latest = await snapshot(request); expect(latest.issues.find(value => value.id === issues[1].id)?.cycleId).toBe(item.id);
    expect((await request.post('/api/issues', { data: { projectId: project.id, title: '보관 항목 신규 배정 거절', cycleId: item.id } })).status()).toBe(422);
  } finally { for (const issue of issues) await request.delete(`/api/issues/${issue.id}`); await cleanPlan(request, item.id); }
});

test('이름이 변경된 계획을 오래된 업무 편집이 덮어쓰지 않고 canonical ID로 유지한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0];
  const item = await plan(request, project.id, 'module', `원래 모듈 ${Date.now()}`);
  const issue = await (await request.post('/api/issues', { data: { projectId: project.id, title: `모듈 편집 충돌 ${Date.now()}`, moduleId: item.id } })).json() as Issue;
  try {
    await page.goto(`/#/${project.id}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog');
    await panel.getByLabel('설명', { exact: true }).fill('내가 작성 중인 설명');
    const renamed = `${item.name} 최신 이름`;
    expect((await request.patch(`/api/planning-items/${item.id}`, { data: { expectedVersion: item.version, name: renamed } })).ok()).toBeTruthy();
    await panel.getByLabel('댓글 내용').fill('최신 작업공간을 불러옵니다.'); await panel.getByRole('button', { name: '댓글 등록', exact: true }).click();
    await expect(panel.getByLabel('모듈', { exact: true }).locator('option:checked')).toHaveText(renamed);
    await expect(panel.getByLabel('설명', { exact: true })).toHaveValue('내가 작성 중인 설명');
    const response = page.waitForResponse(value => value.url().endsWith(`/api/issues/${issue.id}`) && value.request().method() === 'PATCH');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const result = await response; expect(result.status()).toBe(409); expect(result.request().postDataJSON().moduleId).toBe(item.id); expect(result.request().postDataJSON()).not.toHaveProperty('module');
    page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '최신 버전 불러오기', exact: true }).click();
    await expect(panel.getByLabel('설명', { exact: true })).toBeEnabled(); await panel.getByLabel('설명', { exact: true }).fill('최신 이름을 유지하는 저장'); await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === issue.id)?.description).toBe('최신 이름을 유지하는 저장');
    const stored = (await snapshot(request)).issues.find(value => value.id === issue.id)!; expect(stored.moduleId).toBe(item.id); expect(stored.module).toBe(renamed);
  } finally { await request.delete(`/api/issues/${issue.id}`); await cleanPlan(request, item.id); }
});

test('계획 편집은 검색과 탐색 취소 및 버전 충돌에서 유지되고 저장 중에는 잠긴다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0];
  const item = await plan(request, project.id, 'release', `릴리스 충돌 ${Date.now()}`);
  let release: () => void = () => undefined;
  try {
    await page.goto(`/#/${project.id}/planning`); await page.locator('.planning-kind-tabs button').filter({ hasText: '릴리스' }).click(); await page.locator('.planning-item-card').filter({ hasText: item.name }).click();
    const editor = page.getByRole('region', { name: '릴리스 상세' }), name = editor.getByLabel('계획 이름', { exact: true });
    await name.fill('보존할 릴리스 편집'); await page.getByLabel('계획 항목 검색').fill('검색 결과 없는 문자열'); await expect(name).toHaveValue('보존할 릴리스 편집');
    page.once('dialog', dialog => dialog.dismiss()); await page.locator('.planning-kind-tabs button').filter({ hasText: '사이클' }).click(); await expect(name).toHaveValue('보존할 릴리스 편집');
    expect((await request.patch(`/api/planning-items/${item.id}`, { data: { expectedVersion: item.version, description: '서버 변경' } })).ok()).toBeTruthy();
    const conflict = page.waitForResponse(value => value.url().endsWith(`/planning-items/${item.id}`) && value.request().method() === 'PATCH'); await editor.getByRole('button', { name: '계획 저장', exact: true }).click(); expect((await conflict).status()).toBe(409); await expect(name).toHaveValue('보존할 릴리스 편집');
    page.once('dialog', dialog => dialog.accept()); await editor.getByRole('button', { name: '최신 정보', exact: true }).click(); await expect(editor.getByLabel('계획 설명', { exact: true })).toHaveValue('서버 변경');
    let reached: () => void = () => undefined; const gate = new Promise<void>(resolve => { release = resolve; }); const intercepted = new Promise<void>(resolve => { reached = resolve; });
    await page.route(`**/api/planning-items/${item.id}`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
    await name.fill('지연 응답 저장'); await editor.getByRole('button', { name: '계획 저장', exact: true }).click(); await intercepted; await expect(name).toBeDisabled(); expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false); release(); await expect(name).toBeEnabled(); await expect(name).toHaveValue('지연 응답 저장');
    await name.fill('작업자 변경 전 임시 입력');
    const actor = page.getByLabel('작업자 선택', { exact: true });
    const previousActor = await actor.inputValue(), nextActor = initial.users.find(user => user.id !== previousActor)!;
    page.once('dialog', dialog => dialog.dismiss()); await actor.selectOption(nextActor.id); await expect(actor).toHaveValue(previousActor); await expect(name).toHaveValue('작업자 변경 전 임시 입력');
    page.once('dialog', dialog => dialog.accept()); await actor.selectOption(nextActor.id); await expect(name).toHaveValue('지연 응답 저장');
  } finally { release(); await page.unroute(`**/api/planning-items/${item.id}`); await cleanPlan(request, item.id); }
});

test('연결 업무 상세를 열 때 취소하면 계획 편집을 유지하고 버리면 실제로 초기화한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0];
  const item = await plan(request, project.id, 'cycle', `상세 탐색 검사 ${Date.now()}`);
  const response = await request.post('/api/issues', { data: { projectId: project.id, title: `계획 상세 탐색 업무 ${Date.now()}`, cycleId: item.id } });
  expect(response.ok()).toBeTruthy();
  const issue = await response.json() as Issue;
  try {
    await page.goto(`/#/${project.id}/planning`);
    await page.locator('.planning-item-card').filter({ hasText: item.name }).click();
    const editor = page.getByRole('region', { name: '사이클 상세' });
    const name = editor.getByLabel('계획 이름', { exact: true });
    const linkedIssue = editor.locator('.planning-linked-issue').filter({ hasText: issue.title });
    const checkbox = editor.getByRole('checkbox', { name: `${issue.key} 계획 연결`, exact: true });
    const savedName = `${item.name} 저장됨`;
    await name.fill(savedName);
    await editor.getByRole('button', { name: '계획 저장', exact: true }).click();
    await expect(editor.getByRole('button', { name: '계획 저장', exact: true })).toBeDisabled();
    await expect(name).toBeEnabled();

    await name.fill('취소하면 보존할 계획 이름');
    page.once('dialog', dialog => dialog.dismiss());
    await linkedIssue.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(name).toHaveValue('취소하면 보존할 계획 이름');
    page.once('dialog', dialog => dialog.accept());
    await linkedIssue.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(name).toHaveValue(savedName);
    await expect(editor.getByRole('button', { name: '계획 저장', exact: true })).toBeDisabled();

    await checkbox.uncheck();
    await expect(editor.getByRole('button', { name: '연결 변경 적용', exact: true })).toBeVisible();
    page.once('dialog', dialog => dialog.dismiss());
    await linkedIssue.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(checkbox).not.toBeChecked();
    await expect(editor.getByRole('button', { name: '연결 변경 적용', exact: true })).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await linkedIssue.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(name).toHaveValue(savedName);
    await expect(name).toBeEnabled();
    await expect(checkbox).toBeChecked();
    await expect(editor.getByRole('button', { name: '연결 변경 적용', exact: true })).toHaveCount(0);
    expect((await snapshot(request)).issues.find(value => value.id === issue.id)?.cycleId).toBe(item.id);
  } finally { await request.delete(`/api/issues/${issue.id}`); await cleanPlan(request, item.id); }
});
