import { test, expect, type APIRequestContext, type Dialog, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { CustomFieldDefinition, Issue, ProjectIssueSchema, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

const snapshot = async (request: APIRequestContext) => await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
const schema = async (request: APIRequestContext, projectId: string) => await (await request.get(`/api/projects/${projectId}/issue-schema`)).json() as ProjectIssueSchema;
async function restoreSchema(request: APIRequestContext, original: ProjectIssueSchema) { const current = await schema(request, original.projectId); expect((await request.patch(`/api/projects/${original.projectId}/issue-schema`, { data: { ...original, expectedVersion: current.version } })).ok()).toBeTruthy(); }
// Type/field and workflow editors live in the '업무 구성' settings section; hidden sections stay mounted.
const settingsSection = (page: Page, label: string) => page.getByRole('navigation', { name: '설정 섹션' }).getByRole('button', { name: label, exact: true });
async function decisions(page: Page, choices: boolean[], action: () => Promise<unknown>) { const messages: string[] = []; const handle = async (dialog: Dialog) => { const accepted = choices[messages.length] ?? false; messages.push(dialog.message()); if (accepted) await dialog.accept(); else await dialog.dismiss(); }; page.on('dialog', handle); try { await action(); } finally { page.off('dialog', handle); } expect(messages).toHaveLength(choices.length); return messages; }

test('유형·속성·선택 항목의 이름과 순서 및 보관을 관리하고 사용 중인 ID는 유지한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects.at(-1)!, original = await schema(request, project.id);
  const suffix = Date.now().toString(36), typeId = `qa_${suffix}`, memoId = `memo_${suffix}`, categoryId = `category_${suffix}`, firstOption = `first_${suffix}`, secondOption = `second_${suffix}`;
  const typeIndex = original.issueTypes.length + 1, memoIndex = original.fields.length + 1, categoryIndex = original.fields.length + 2;
  let created: Issue | null = null;
  try {
    await page.goto(`/#/${project.id}/settings?section=work`);
    const editor = page.getByRole('region', { name: '업무 유형·사용자 정의 속성 설정' });
    await expect(editor.getByRole('button', { name: '업무 유형 추가', exact: true })).toBeEnabled();
    await editor.getByRole('button', { name: '업무 유형 추가', exact: true }).click();
    await editor.getByLabel(`유형 ${typeIndex} 이름`, { exact: true }).fill(`검증 요청 ${suffix}`);
    await editor.getByLabel(`유형 ${typeIndex} ID`, { exact: true }).fill(original.issueTypes[0].id);
    await expect(editor.getByRole('alert')).toContainText('이미 사용한 유형 ID');
    await expect(editor.getByLabel(`유형 ${typeIndex} ID`, { exact: true })).not.toHaveAttribute('readonly');
    await editor.getByLabel(`유형 ${typeIndex} ID`, { exact: true }).fill(typeId);
    await editor.getByRole('button', { name: '유형·속성 저장', exact: true }).click();
    await expect(editor.getByLabel(`유형 ${typeIndex} 이름`, { exact: true })).toBeEnabled();
    await expect(editor.getByLabel(`유형 ${typeIndex} ID`, { exact: true })).toHaveAttribute('readonly');
    await editor.locator('.issue-schema-tabs button').filter({ hasText: '사용자 정의 속성' }).click();
    await editor.getByRole('button', { name: '속성 추가', exact: true }).click();
    await editor.getByLabel(`속성 ${memoIndex} 이름`, { exact: true }).fill('검토 메모');
    await editor.getByLabel(`속성 ${memoIndex} ID`, { exact: true }).fill(memoId);
    await editor.getByRole('button', { name: '속성 추가', exact: true }).click();
    await editor.getByLabel(`속성 ${categoryIndex} 이름`, { exact: true }).fill('처리 구분');
    await editor.getByLabel(`속성 ${categoryIndex} ID`, { exact: true }).fill(categoryId);
    await expect(editor.getByLabel(`속성 ${categoryIndex} 형식`, { exact: true }).locator('option')).toHaveCount(8);
    await editor.getByLabel(`속성 ${categoryIndex} 형식`, { exact: true }).selectOption('select');
    await editor.getByLabel(`속성 ${categoryIndex} 필수`, { exact: true }).check();
    await editor.locator(`summary[aria-label="속성 ${categoryIndex} 적용 유형"]`).click();
    await editor.getByLabel(`속성 ${categoryIndex} 적용 유형 · 검증 요청 ${suffix}`, { exact: true }).check();
    await editor.locator(`summary[aria-label="속성 ${categoryIndex} 적용 유형"]`).click();
    const category = editor.locator('.issue-schema-field').nth(categoryIndex - 1);
    await category.getByRole('button', { name: '선택 항목 추가', exact: true }).click();
    await editor.getByLabel(`속성 ${categoryIndex} 항목 1 이름`, { exact: true }).fill('분석'); await editor.getByLabel(`속성 ${categoryIndex} 항목 1 ID`, { exact: true }).fill(firstOption);
    await category.getByRole('button', { name: '선택 항목 추가', exact: true }).click();
    await editor.getByLabel(`속성 ${categoryIndex} 항목 2 이름`, { exact: true }).fill('실행'); await editor.getByLabel(`속성 ${categoryIndex} 항목 2 ID`, { exact: true }).fill(secondOption);
    await editor.getByRole('button', { name: '유형·속성 저장', exact: true }).click();
    await expect(editor.getByRole('button', { name: '유형·속성 저장', exact: true })).toBeDisabled(); await expect(editor.getByLabel(`속성 ${categoryIndex} 이름`, { exact: true })).toBeEnabled();
    const configured = await schema(request, project.id); expect(configured.fields.find(value => value.id === categoryId)).toMatchObject({ required: true, issueTypes: [typeId], kind: 'select' });
    const response = await request.post('/api/issues', { data: { projectId: project.id, title: `속성 연결 검사 ${suffix}`, type: typeId, customFields: { [categoryId]: firstOption, [memoId]: '기존 값 보존' } } }); expect(response.ok()).toBeTruthy(); created = await response.json() as Issue;
    await page.reload();
    await expect(editor.getByLabel(`유형 ${typeIndex} ID`, { exact: true })).toHaveAttribute('readonly');
    await expect(editor.getByRole('button', { name: `유형 ${typeIndex} 삭제`, exact: true })).toBeDisabled();
    await editor.getByLabel(`유형 ${typeIndex} 이름`, { exact: true }).fill(`이름이 바뀐 요청 ${suffix}`);
    await editor.getByRole('button', { name: `유형 ${typeIndex} 위로`, exact: true }).click();
    await editor.locator('.issue-schema-tabs button').filter({ hasText: '사용자 정의 속성' }).click();
    await editor.getByRole('button', { name: `속성 ${categoryIndex} 세부 설정`, exact: true }).click();
    await expect(editor.getByLabel(`속성 ${categoryIndex} ID`, { exact: true })).toHaveAttribute('readonly'); await expect(editor.getByLabel(`속성 ${categoryIndex} 형식`, { exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: `속성 ${categoryIndex} 삭제`, exact: true })).toBeDisabled(); await expect(editor.getByRole('button', { name: `속성 ${categoryIndex} 항목 1 삭제`, exact: true })).toBeDisabled();
    await expect(editor.getByLabel(`속성 ${categoryIndex} 항목 1 ID`, { exact: true })).toHaveAttribute('readonly');
    await editor.getByLabel(`속성 ${categoryIndex} 이름`, { exact: true }).fill('변경된 처리 구분');
    await editor.getByLabel(`속성 ${categoryIndex} 항목 1 이름`, { exact: true }).fill('분석 완료'); await editor.getByLabel(`속성 ${categoryIndex} 항목 1 보관`, { exact: true }).check();
    await editor.getByRole('button', { name: `속성 ${categoryIndex} 항목 2 위로`, exact: true }).click();
    await editor.getByRole('button', { name: `속성 ${categoryIndex} 위로`, exact: true }).click();
    await editor.getByRole('button', { name: '유형·속성 저장', exact: true }).click(); await expect(editor.getByRole('button', { name: '유형·속성 저장', exact: true })).toBeDisabled();
    const renamed = await schema(request, project.id), field = renamed.fields.find(value => value.id === categoryId)!;
    expect(renamed.issueTypes[typeIndex - 2].id).toBe(typeId); expect(renamed.fields[memoIndex - 1].id).toBe(categoryId); expect(field.options.map(value => value.id)).toEqual([secondOption, firstOption]); expect(field.options[1]).toMatchObject({ id: firstOption, name: '분석 완료', archived: true });
    expect((await snapshot(request)).issues.find(value => value.id === created!.id)?.customFields?.[categoryId]).toBe(firstOption);
    expect((await request.post('/api/issues', { data: { projectId: project.id, title: '보관 선택 항목 신규 사용 거절', type: typeId, customFields: { [categoryId]: firstOption } } })).status()).toBe(422);
    await editor.getByLabel(`속성 ${memoIndex} 보관`, { exact: true }).check();
    await editor.locator('.issue-schema-tabs button').filter({ hasText: '업무 유형' }).click(); await editor.getByLabel(`유형 ${typeIndex - 1} 보관`, { exact: true }).check();
    await editor.getByRole('button', { name: '유형·속성 저장', exact: true }).click(); await expect(editor.getByRole('button', { name: '유형·속성 저장', exact: true })).toBeDisabled();
    expect((await request.post('/api/issues', { data: { projectId: project.id, title: '보관 유형 신규 사용 거절', type: typeId } })).status()).toBe(422);
    const current = (await snapshot(request)).issues.find(value => value.id === created!.id)!;
    expect((await request.patch(`/api/issues/${current.id}`, { data: { expectedVersion: current.version, description: '보관된 기존 유형과 속성 값 유지' } })).ok()).toBeTruthy();
    await editor.locator('.issue-schema-tabs button').filter({ hasText: '사용자 정의 속성' }).click();
    mkdirSync('docs/screenshots', { recursive: true }); await editor.screenshot({ path: 'docs/screenshots/issue-schema.png' });
  } finally { if (created) await request.delete(`/api/issues/${created.id}`); await restoreSchema(request, original); }
});

test('유형·속성 초안은 외부 갱신·버전 충돌과 복합 탐색 취소에서 보존되고 저장 중에는 잠긴다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0], original = await schema(request, project.id), user = initial.users[0];
  let release: () => void = () => undefined;
  try {
    await page.goto(`/#/${project.id}/settings?section=work`);
    const editor = page.getByRole('region', { name: '업무 유형·사용자 정의 속성 설정' }), name = editor.getByLabel('유형 1 이름', { exact: true });
    await expect(name).toBeEnabled(); await name.fill('보존할 업무 유형 초안');
    const remote = await request.patch(`/api/projects/${project.id}/issue-schema`, { data: { ...original, expectedVersion: original.version, issueTypes: original.issueTypes.map((value, index) => index === 0 ? { ...value, name: '다른 작업자의 유형 이름' } : value) } }); expect(remote.ok()).toBeTruthy();
    await settingsSection(page, '일반').click();
    await page.locator('.team-row').filter({ hasText: user.name }).getByRole('button', { name: '이메일 변경', exact: true }).click();
    const emailDialog = page.getByRole('dialog', { name: '팀원 이메일 변경' });
    await emailDialog.getByLabel('새 이메일').fill(`schema-${Date.now()}@example.test`);
    await emailDialog.getByRole('button', { name: '이메일 저장' }).click();
    await expect(emailDialog).toHaveCount(0);
    await settingsSection(page, '업무 구성').click();
    await expect(editor.getByRole('alert')).toContainText('다른 작업자가 유형·속성 설정'); await expect(name).toHaveValue('보존할 업무 유형 초안');
    const rejected = page.waitForResponse(value => value.url().endsWith(`/projects/${project.id}/issue-schema`) && value.request().method() === 'PATCH');
    await editor.getByRole('button', { name: '유형·속성 저장', exact: true }).click(); expect((await rejected).status()).toBe(409); await expect(name).toHaveValue('보존할 업무 유형 초안');
    await decisions(page, [true], () => editor.getByRole('button', { name: '최신 유형·속성 불러오기', exact: true }).click()); await expect(name).toHaveValue('다른 작업자의 유형 이름'); await expect(name).toBeEnabled();
    let reached: () => void = () => undefined; const gate = new Promise<void>(resolve => { release = resolve; }), intercepted = new Promise<void>(resolve => { reached = resolve; });
    await page.route(`**/api/projects/${project.id}/issue-schema`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
    await name.fill('지연 응답으로 저장한 유형'); await editor.getByRole('button', { name: '유형·속성 저장', exact: true }).click(); await intercepted;
    await expect(name).toBeDisabled(); expect(await page.evaluate(() => window.dispatchEvent(new Event('donefac:navigate', { cancelable: true })))).toBe(false); release(); await expect(name).toBeEnabled(); await expect(editor.getByRole('button', { name: '유형·속성 저장', exact: true })).toBeDisabled();
    await name.fill('복합 탐색에서도 보존할 유형');
    const actor = page.getByLabel('작업자 선택', { exact: true }), previousActor = await actor.inputValue(), nextActor = initial.users.find(value => value.id !== previousActor)!;
    await decisions(page, [false], () => actor.selectOption(nextActor.id)); await expect(name).toHaveValue('복합 탐색에서도 보존할 유형');
    await settingsSection(page, '업무 달력').click();
    const calendarName = page.getByLabel('업무 달력 이름', { exact: true }); await calendarName.fill('함께 보존할 달력 초안');
    const url = page.url(); await decisions(page, [true, false], () => actor.selectOption(nextActor.id));
    await expect(actor).toHaveValue(previousActor); await expect(page).toHaveURL(url); await expect(calendarName).toHaveValue('함께 보존할 달력 초안');
    await settingsSection(page, '업무 구성').click(); await expect(name).toHaveValue('복합 탐색에서도 보존할 유형');
    await decisions(page, [true, true], () => actor.selectOption(nextActor.id)); await expect(actor).toHaveValue(nextActor.id); await expect(name).toHaveValue('지연 응답으로 저장한 유형');
    await settingsSection(page, '업무 달력').click(); await expect(calendarName).toHaveValue(initial.calendars!.find(value => value.projectId === project.id)!.name);
  } finally { release(); await page.unroute(`**/api/projects/${project.id}/issue-schema`); await request.patch(`/api/users/${user.id}`, { data: { email: user.email } }); await restoreSchema(request, original); }
});

test('사용자 정의 유형과 속성을 워크플로 전이 및 필수 규칙에 연결하고 이름 변경 후에도 ID로 유지한다', async ({ page, request }) => {
  const initial = await snapshot(request), project = initial.projects[0], original = await schema(request, project.id);
  const workflow = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
  const suffix = Date.now().toString(36), typeId = `gate_${suffix}`, fieldId = `evidence_${suffix}`, fieldName = `승인 근거 ${suffix}`, typeName = `승인 요청 ${suffix}`;
  const field: CustomFieldDefinition = { id: fieldId, name: fieldName, description: '', kind: 'text', required: false, issueTypes: [typeId], options: [], archived: false };
  let created: Issue | null = null;
  try {
    expect((await request.patch(`/api/projects/${project.id}/issue-schema`, { data: { ...original, expectedVersion: original.version, issueTypes: [...original.issueTypes, { id: typeId, name: typeName, color: '#507f9d', archived: false }], fields: [...original.fields, field] } })).ok()).toBeTruthy();
    await page.goto(`/#/${project.id}/settings?section=work`);
    const editor = page.getByRole('region', { name: '프로젝트 워크플로 설정' }); await expect(editor.getByLabel('상태 1 이름', { exact: true })).toBeEnabled();
    await editor.locator('.workflow-tabs button').filter({ hasText: '필수 속성' }).click(); await editor.getByRole('button', { name: '규칙 추가', exact: true }).click();
    const rule = workflow.fieldRules.length + 1;
    await editor.getByLabel(`규칙 ${rule} 업무 유형`, { exact: true }).selectOption(typeId); await editor.getByLabel(`규칙 ${rule} 상태`, { exact: true }).selectOption('todo');
    await editor.locator(`summary[aria-label="규칙 ${rule} 필수 속성"]`).click(); await editor.getByLabel(`규칙 ${rule} 필수 속성 · ${fieldName}`, { exact: true }).check(); await editor.locator(`summary[aria-label="규칙 ${rule} 필수 속성"]`).click();
    await editor.locator('.workflow-tabs button').filter({ hasText: '허용 전이' }).click();
    const edge = workflow.transitions.findIndex(value => value.from === 'review' && value.to === 'done') + 1; expect(edge).toBeGreaterThan(0);
    await editor.locator(`summary[aria-label="전이 ${edge} 업무 유형"]`).click(); await editor.getByLabel(`전이 ${edge} 업무 유형 · ${typeName}`, { exact: true }).check(); await editor.locator(`summary[aria-label="전이 ${edge} 업무 유형"]`).click();
    await editor.locator(`summary[aria-label="전이 ${edge} 필수 속성"]`).click(); await editor.getByLabel(`전이 ${edge} 필수 속성 · ${fieldName}`, { exact: true }).check(); await editor.locator(`summary[aria-label="전이 ${edge} 필수 속성"]`).click();
    await editor.getByRole('button', { name: '워크플로 저장', exact: true }).click(); await expect(editor.getByRole('button', { name: '워크플로 저장', exact: true })).toBeDisabled();
    expect((await request.post('/api/issues', { data: { projectId: project.id, title: '사용자 정의 생성 필수 검사', type: typeId } })).status()).toBe(422);
    const response = await request.post('/api/issues', { data: { projectId: project.id, title: `전이 검사 ${suffix}`, type: typeId, status: 'review' } }); expect(response.ok()).toBeTruthy(); created = await response.json() as Issue;
    expect((await request.patch(`/api/issues/${created.id}`, { data: { expectedVersion: created.version, status: 'done' } })).status()).toBe(422);
    expect((await request.patch(`/api/issues/${created.id}`, { data: { expectedVersion: created.version, status: 'done', customFields: { [fieldId]: '승인 문서 확인' } } })).ok()).toBeTruthy();
    const current = await schema(request, project.id), renamedType = `${typeName} 변경`, renamedField = `${fieldName} 변경`;
    expect((await request.patch(`/api/projects/${project.id}/issue-schema`, { data: { ...current, expectedVersion: current.version, issueTypes: current.issueTypes.map(value => value.id === typeId ? { ...value, name: renamedType } : value), fields: current.fields.map(value => value.id === fieldId ? { ...value, name: renamedField } : value) } })).ok()).toBeTruthy();
    await page.reload(); await editor.locator('.workflow-tabs button').filter({ hasText: '필수 속성' }).click();
    await expect(editor.getByLabel(`규칙 ${rule} 업무 유형`, { exact: true }).locator('option:checked')).toHaveText(renamedType); await expect(editor.locator(`summary[aria-label="규칙 ${rule} 필수 속성"]`)).toContainText(renamedField);
    const savedWorkflow = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
    expect(savedWorkflow.fieldRules[rule - 1].requiredFields).toContain(`custom:${fieldId}`); expect(savedWorkflow.transitions[edge - 1].issueTypes).toContain(typeId);
    const metadata = page.getByRole('region', { name: '업무 유형·사용자 정의 속성 설정' }); await metadata.locator('.issue-schema-tabs button').filter({ hasText: '사용자 정의 속성' }).click(); const fieldIndex = current.fields.findIndex(value => value.id === fieldId) + 1; await metadata.getByRole('button', { name: `속성 ${fieldIndex} 세부 설정`, exact: true }).click(); await expect(metadata.getByLabel(`속성 ${fieldIndex} 보관`, { exact: true })).toBeDisabled();
  } finally { if (created) await request.delete(`/api/issues/${created.id}`); const currentWorkflow = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow; expect((await request.patch(`/api/projects/${project.id}/workflow`, { data: { ...workflow, expectedVersion: currentWorkflow.version } })).ok()).toBeTruthy(); await restoreSchema(request, original); }
});
