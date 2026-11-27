import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import type { CustomFieldDefinition, Issue, Project, ProjectIssueSchema, ProjectWorkflow, SavedView, WorkspaceSnapshot } from '../../shared/types';

type Fixture = { request: APIRequestContext; project: Project; workspace: WorkspaceSnapshot; schema: ProjectIssueSchema; prefix: string };
const fields = (): CustomFieldDefinition[] => [
  { id: 'customer', name: '고객', kind: 'text' },
  { id: 'severity', name: '중요도', kind: 'select', options: [{ id: 'normal', name: '일반', archived: false }, { id: 'premium', name: '프리미엄', archived: false }] },
  { id: 'budget', name: '예산', kind: 'number' },
  { id: 'review_date', name: '검토일', kind: 'date' },
  { id: 'approved', name: '승인 여부', kind: 'checkbox' },
  { id: 'reviewer', name: '검토자', kind: 'user' },
  { id: 'reference', name: '참고 주소', kind: 'url' },
  { id: 'regions', name: '적용 영역', kind: 'multi_select', options: [{ id: 'edge', name: '엣지', archived: false }, { id: 'cloud', name: '클라우드', archived: false }] },
  { id: 'scope_notes', name: '사고 맥락', kind: 'text', issueTypes: ['incident'] },
].map(value => ({ description: '', required: false, issueTypes: [], options: [], archived: false, ...value })) as CustomFieldDefinition[];
const test = base.extend<{ custom: Fixture }>({
  custom: [async ({ playwright, baseURL }, provide) => {
    const request = await playwright.request.newContext({ baseURL }); const suffix = randomUUID().replaceAll('-', '').slice(0, 8), prefix = `속성 검증 ${suffix}`;
    let project: Project | null = null;
    try {
      const response = await request.post('/api/projects', { data: { key: `CF${suffix}`.toUpperCase(), name: prefix, description: '사용자 정의 속성의 합성 브라우저 프로젝트', color: '#578ca9' } }); expect(response.status()).toBe(201); project = await response.json() as Project;
      const initial = await (await request.get(`/api/projects/${project.id}/issue-schema`)).json() as ProjectIssueSchema;
      const saved = await request.patch(`/api/projects/${project.id}/issue-schema`, { data: { ...initial, expectedVersion: initial.version, issueTypes: [...initial.issueTypes, { id: 'incident', name: '운영 사고', color: '#c67741', archived: false }, { id: 'service_request', name: '서비스 요청', color: '#578ca9', archived: false }], fields: fields() } }); expect(saved.status()).toBe(200);
      const schema = await saved.json() as ProjectIssueSchema, workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
      await provide({ request, project, workspace, schema, prefix });
    } finally {
      try {
        if (project) { const response = await request.get('/api/workspace', { timeout: 5000 }); if (response.ok()) { const data = await response.json() as WorkspaceSnapshot; for (const item of data.issues.filter(issue => issue.projectId === project!.id)) await request.delete(`/api/issues/${item.id}?expectedVersion=${item.version}`, { timeout: 5000 }); for (const view of data.savedViews || []) if (view.projectId === project.id) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`, { timeout: 5000 }); } }
      } finally { await request.dispose(); }
    }
  }, { timeout: 30_000 }],
});
async function snapshot(f: Fixture) { return await (await f.request.get('/api/workspace')).json() as WorkspaceSnapshot; }
async function updateSchema(f: Fixture, change: (schema: ProjectIssueSchema) => ProjectIssueSchema) { const old = await (await f.request.get(`/api/projects/${f.project.id}/issue-schema`)).json() as ProjectIssueSchema; const response = await f.request.patch(`/api/projects/${f.project.id}/issue-schema`, { data: { ...change(structuredClone(old)), expectedVersion: old.version } }); expect(response.status()).toBe(200); return await response.json() as ProjectIssueSchema; }
async function issue(f: Fixture, customFields: Issue['customFields'] = {}) { const response = await f.request.post('/api/issues', { data: { projectId: f.project.id, title: `${f.prefix} 저장된 업무`, type: 'incident', customFields } }); expect(response.status()).toBe(201); return await response.json() as Issue; }

test('여덟 가지 속성을 실제 타입으로 저장하고 이름 변경 뒤 검색·보드·저장된 유형 필터가 같은 ID를 사용한다', async ({ page, custom: f }) => {
  await page.goto(`/#/${f.project.id}/issues`); await page.getByRole('button', { name: '업무 만들기', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: '새 업무 만들기', exact: true });
  await modal.getByLabel('업무 제목', { exact: true }).fill(`${f.prefix} 고객 요청`);
  await modal.getByLabel('유형', { exact: true }).selectOption('incident');
  await modal.getByLabel('고객', { exact: true }).fill('한빛 연구팀'); await modal.getByLabel('중요도', { exact: true }).selectOption('premium');
  await modal.getByLabel('예산', { exact: true }).fill('0'); await modal.getByLabel('검토일', { exact: true }).fill('2026-12-03');
  await modal.getByLabel('승인 여부', { exact: true }).selectOption('false'); await modal.getByLabel('검토자', { exact: true }).selectOption(f.workspace.users[0].id);
  await modal.getByLabel('참고 주소', { exact: true }).fill('https://example.test/review'); await modal.getByLabel('적용 영역', { exact: true }).selectOption(['edge', 'cloud']);
  let releaseCreate = () => {}; const createGate = new Promise<void>(resolve => { releaseCreate = resolve; }); let reportCreate = () => {}; const createHeld = new Promise<void>(resolve => { reportCreate = resolve; });
  await page.route('**/api/issues', async route => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); reportCreate(); await createGate; await route.fulfill({ response }); });
  const created = page.waitForResponse(response => response.url().endsWith('/api/issues') && response.request().method() === 'POST');
  let record: Issue;
  try { await modal.getByRole('button', { name: '업무 만들기', exact: true }).click(); await createHeld; await expect(modal.getByLabel('고객', { exact: true })).toBeDisabled(); expect(await page.evaluate(() => window.dispatchEvent(new Event('donefac:navigate', { cancelable: true })))).toBe(false); releaseCreate(); record = await (await created).json() as Issue; }
  finally { releaseCreate(); await page.unroute('**/api/issues'); }
  expect(record.customFields).toEqual({ customer: '한빛 연구팀', severity: 'premium', budget: 0, review_date: '2026-12-03', approved: false, reviewer: f.workspace.users[0].id, reference: 'https://example.test/review', regions: ['edge', 'cloud'] });
  const panel = page.getByRole('dialog'); await expect(panel.getByLabel('예산', { exact: true })).toHaveValue('0'); await expect(panel.getByLabel('승인 여부', { exact: true })).toHaveValue('false');
  await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
  await page.getByLabel('유형 필터', { exact: true }).selectOption('incident');
  await page.getByRole('button', { name: '현재 보기 저장', exact: true }).click(); const save = page.getByRole('dialog', { name: '업무 보기 저장', exact: true }); await save.getByLabel('보기 이름', { exact: true }).fill(`${f.prefix} 운영 사고`);
  const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/views') && response.request().method() === 'POST'); await save.getByRole('button', { name: '저장', exact: true }).click(); const view = await (await savedResponse).json() as SavedView; expect(view.filters.type).toBe('incident');
  await updateSchema(f, schema => ({ ...schema, issueTypes: schema.issueTypes.map(type => type.id === 'incident' ? { ...type, name: '장애 분석' } : type), fields: schema.fields.map(field => field.id === 'customer' ? { ...field, name: '고객 조직' } : field.id === 'severity' ? { ...field, options: field.options.map(option => option.id === 'premium' ? { ...option, name: '중요 고객' } : option) } : field) }));
  await page.reload(); await page.getByLabel('저장된 업무 보기', { exact: true }).selectOption(view.id); await expect(page.getByLabel('유형 필터', { exact: true })).toHaveValue('incident'); await expect(page.getByLabel('유형 필터', { exact: true }).locator('option:checked')).toHaveText('장애 분석');
  await page.getByRole('button', { name: '통합 검색', exact: true }).click(); const search = page.getByRole('dialog', { name: '통합 검색', exact: true }); await search.getByRole('textbox').fill('중요 고객'); await expect(search.locator('.search-result').filter({ hasText: record.title })).toBeVisible(); await page.keyboard.press('Escape');
  await page.getByLabel('업무 검색', { exact: true }).fill('중요 고객'); const row = page.locator('.issue-table tr').filter({ hasText: record.title }); await expect(row).toContainText('고객 조직'); await expect(row).toContainText('한빛 연구팀'); await expect(row).toContainText('중요 고객');
  await page.getByRole('button', { name: '보드', exact: true }).click(); const card = page.locator('.issue-board-card').filter({ hasText: record.title }); await expect(card).toContainText('장애 분석'); await expect(card).toContainText('중요 고객');
  mkdirSync('docs/screenshots', { recursive: true }); await page.screenshot({ path: 'docs/screenshots/custom-fields.png', fullPage: true });
  await card.click(); await expect(page.getByRole('dialog').getByLabel('중요도', { exact: true })).toHaveValue('premium'); await expect(page.getByRole('dialog').getByLabel('고객 조직', { exact: true })).toHaveValue('한빛 연구팀');
});

test('유형 전환과 속성·옵션 보관 뒤에도 기존 값을 보존하고 명시적으로 지울 수 있다', async ({ page, custom: f }) => {
  const record = await issue(f, { customer: '기존 고객', severity: 'premium', scope_notes: '원래 유형의 맥락' });
  await page.goto(`/#/${f.project.id}/issues?issue=${record.id}`); const panel = page.getByRole('dialog');
  await panel.getByLabel('유형', { exact: true }).selectOption('service_request'); await expect(panel.getByLabel('사고 맥락 기존 값', { exact: true })).toHaveText('원래 유형의 맥락'); await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await expect(panel.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled(); expect((await snapshot(f)).issues.find(value => value.id === record.id)?.customFields?.scope_notes).toBe('원래 유형의 맥락');
  await updateSchema(f, schema => ({ ...schema, issueTypes: schema.issueTypes.map(type => ['incident', 'service_request'].includes(type.id) ? { ...type, archived: true } : type), fields: schema.fields.map(field => field.id === 'customer' ? { ...field, archived: true } : field.id === 'severity' ? { ...field, options: field.options.map(option => option.id === 'premium' ? { ...option, archived: true } : option) } : field) }));
  await page.reload(); await expect(panel.getByLabel('고객 기존 값', { exact: true })).toHaveText('기존 고객'); await expect(panel.getByLabel('중요도', { exact: true })).toHaveValue('premium'); await expect(panel.getByLabel('중요도', { exact: true }).locator('option[value="premium"]')).toBeDisabled();
  await panel.getByLabel('설명', { exact: true }).fill('보관된 기존 값 유지'); await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click(); await expect(panel.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
  let latest = (await snapshot(f)).issues.find(value => value.id === record.id)!; expect(latest.customFields).toEqual(record.customFields);
  await panel.getByRole('button', { name: '고객 값 지우기', exact: true }).click(); await panel.getByRole('button', { name: '사고 맥락 값 지우기', exact: true }).click(); await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click(); await expect(panel.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
  latest = (await snapshot(f)).issues.find(value => value.id === record.id)!; expect(latest.customFields?.customer ?? null).toBeNull(); expect(latest.customFields?.scope_notes ?? null).toBeNull(); expect(latest.customFields?.severity).toBe('premium');
  await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click(); await page.getByRole('button', { name: '업무 만들기', exact: true }).first().click(); const modal = page.getByRole('dialog', { name: '새 업무 만들기', exact: true }); await expect(modal.getByLabel('유형', { exact: true }).locator('option[value="incident"]')).toHaveCount(0); await expect(modal.getByLabel('유형', { exact: true }).locator('option[value="service_request"]')).toHaveCount(0); await expect(modal.getByLabel('고객', { exact: true })).toHaveCount(0); await expect(modal.getByLabel('중요도', { exact: true }).locator('option[value="premium"]')).toHaveCount(0);
});

test('동적 필수 속성 안내와 서버 검증을 적용하고 충돌·지연 저장에서 사용자 값을 유지한다', async ({ page, custom: f }) => {
  const record = await issue(f, { budget: 0, approved: false }); const workflow = await (await f.request.get(`/api/projects/${f.project.id}/workflow`)).json() as ProjectWorkflow;
  expect((await f.request.patch(`/api/projects/${f.project.id}/workflow`, { data: { ...workflow, expectedVersion: workflow.version, fieldRules: [{ issueType: 'incident', statusId: 'review', requiredFields: ['custom:customer'] }] } })).status()).toBe(200);
  await page.goto(`/#/${f.project.id}/issues?issue=${record.id}`); const panel = page.getByRole('dialog'); await panel.getByLabel('상태', { exact: true }).selectOption('review'); await expect(panel).toContainText('필수 속성: 고객');
  await panel.locator('form.issue-detail-form').evaluate(form => { (form as HTMLFormElement).noValidate = true; });
  const rejected = page.waitForResponse(response => response.url().endsWith(`/api/issues/${record.id}`) && response.request().method() === 'PATCH'); await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click(); expect((await rejected).status()).toBe(422); await expect(panel.getByRole('alert')).toContainText('고객');
  await panel.getByLabel('고객', { exact: true }).fill('충돌에서도 유지할 고객'); expect((await f.request.patch(`/api/issues/${record.id}`, { data: { expectedVersion: record.version, description: '다른 작업자의 설명' } })).status()).toBe(200);
  const conflict = page.waitForResponse(response => response.url().endsWith(`/api/issues/${record.id}`) && response.request().method() === 'PATCH'); await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click(); expect((await conflict).status()).toBe(409); await expect(panel.getByLabel('고객', { exact: true })).toHaveValue('충돌에서도 유지할 고객'); await expect(panel.getByLabel('예산', { exact: true })).toHaveValue('0'); await expect(panel.getByLabel('승인 여부', { exact: true })).toHaveValue('false');
  page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '최신 버전 불러오기', exact: true }).click(); await panel.getByLabel('고객', { exact: true }).fill('최신 기반 고객');
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); let report = () => {}; const held = new Promise<void>(resolve => { report = resolve; });
  await page.route(`**/api/issues/${record.id}`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); report(); await gate; await route.fulfill({ response }); });
  try { await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click(); await held; await expect(panel.getByLabel('고객', { exact: true })).toBeDisabled(); expect(await page.evaluate(() => window.dispatchEvent(new Event('donefac:navigate', { cancelable: true })))).toBe(false); release(); await expect(panel.getByLabel('고객', { exact: true })).toBeEnabled(); expect((await snapshot(f)).issues.find(value => value.id === record.id)?.customFields?.customer).toBe('최신 기반 고객'); } finally { release(); }
});

test('간트 생성에서도 동적 유형·속성을 저장하고 유형 전환 및 새 업무 탐색 취소에서 입력을 보존한다', async ({ page, custom: f }) => {
  await page.goto(`/#/${f.project.id}/gantt`); await page.getByRole('button', { name: '업무 추가', exact: true }).click(); const form = page.getByRole('form', { name: '간트에서 업무 만들기', exact: true });
  await form.getByLabel('추가할 업무 제목', { exact: true }).fill(`${f.prefix} 간트 업무`); await form.getByLabel('추가할 업무 유형', { exact: true }).selectOption('incident'); await form.getByLabel('추가할 업무 고객', { exact: true }).fill('간트 고객'); await form.getByLabel('추가할 업무 사고 맥락', { exact: true }).fill('유형을 왕복해도 보존'); await form.getByLabel('추가할 업무 예산', { exact: true }).fill('0'); await form.getByLabel('추가할 업무 승인 여부', { exact: true }).selectOption('false');
  await form.getByLabel('추가할 업무 유형', { exact: true }).selectOption('service_request'); await expect(form.getByLabel('추가할 업무 사고 맥락 기존 값', { exact: true })).toHaveText('유형을 왕복해도 보존'); await form.getByLabel('추가할 업무 유형', { exact: true }).selectOption('incident'); await expect(form.getByLabel('추가할 업무 사고 맥락', { exact: true })).toHaveValue('유형을 왕복해도 보존');
  page.once('dialog', dialog => dialog.dismiss()); await form.getByRole('button', { name: '취소', exact: true }).click(); await expect(form.getByLabel('추가할 업무 고객', { exact: true })).toHaveValue('간트 고객');
  await page.evaluate(() => { window.addEventListener('donefac:navigate', event => event.preventDefault(), { once: true }); }); page.once('dialog', dialog => dialog.accept()); await form.getByRole('button', { name: '취소', exact: true }).click(); await expect(form.getByLabel('추가할 업무 고객', { exact: true })).toHaveValue('간트 고객');
  const created = page.waitForResponse(response => response.url().endsWith('/api/issues') && response.request().method() === 'POST'); await form.getByRole('button', { name: '간트에 추가', exact: true }).click(); const record = await (await created).json() as Issue; expect(record.type).toBe('incident'); expect(record.customFields).toMatchObject({ customer: '간트 고객', scope_notes: '유형을 왕복해도 보존', budget: 0, approved: false }); await expect(form).toHaveCount(0);
  await page.goto(`/#/${f.project.id}/issues`); await page.getByRole('button', { name: '업무 만들기', exact: true }).first().click(); const modal = page.getByRole('dialog', { name: '새 업무 만들기', exact: true }); await modal.getByLabel('업무 제목', { exact: true }).fill('새 업무의 미저장 초안'); await modal.getByLabel('고객', { exact: true }).fill('탐색 보호 고객');
  page.once('dialog', dialog => dialog.dismiss()); expect(await page.evaluate(() => window.dispatchEvent(new Event('donefac:navigate', { cancelable: true })))).toBe(false); await expect(modal.getByLabel('고객', { exact: true })).toHaveValue('탐색 보호 고객');
  await page.evaluate(() => { window.addEventListener('donefac:navigate', event => event.preventDefault(), { once: true }); }); page.once('dialog', dialog => dialog.accept()); expect(await page.evaluate(() => window.dispatchEvent(new Event('donefac:navigate', { cancelable: true })))).toBe(false); await expect(modal.getByLabel('고객', { exact: true })).toHaveValue('탐색 보호 고객');
  page.once('dialog', dialog => dialog.accept()); await modal.getByRole('button', { name: '취소', exact: true }).click(); await expect(modal).toHaveCount(0);
});
