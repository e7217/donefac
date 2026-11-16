import { test, expect } from '@playwright/test';
import type { Issue, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

test('프로젝트에서 추가한 상태·전이·필수 속성이 간트 생성과 업무 보드·상세에 적용된다', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const project = snapshot.projects.at(-1)!;
  const original = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
  const suffix = Date.now().toString(36), stateId = `qa_${suffix}`, label = `품질 확인 ${suffix}`;
  let created: Issue | undefined;
  try {
    await page.goto(`/#/${project.id}/settings`);
    const settings = page.getByRole('region', { name: '프로젝트 워크플로 설정' });
    await expect(settings.getByRole('button', { name: '상태 추가', exact: true })).toBeEnabled();
    await settings.getByRole('button', { name: '상태 추가', exact: true }).click();
    const stateIndex = original.statuses.length + 1;
    await settings.getByLabel(`상태 ${stateIndex} 이름`, { exact: true }).fill(label);
    await settings.getByLabel(`상태 ${stateIndex} ID`, { exact: true }).fill(stateId);
    await settings.getByLabel(`상태 ${stateIndex} 분류`, { exact: true }).selectOption('review');
    await settings.getByLabel('새 업무의 기본 상태', { exact: true }).selectOption(stateId);
    await settings.locator('.workflow-tabs button').filter({ hasText: '허용 전이' }).click();
    await settings.getByRole('button', { name: '전이 추가', exact: true }).click();
    const edgeIndex = original.transitions.length + 1;
    await settings.getByLabel(`전이 ${edgeIndex} 출발 상태`, { exact: true }).selectOption(stateId);
    await settings.getByLabel(`전이 ${edgeIndex} 도착 상태`, { exact: true }).selectOption('done');
    await settings.locator(`summary[aria-label="전이 ${edgeIndex} 업무 유형"]`).click();
    await settings.getByLabel(`전이 ${edgeIndex} 업무 유형 · 버그`, { exact: true }).check();
    await settings.locator(`summary[aria-label="전이 ${edgeIndex} 필수 속성"]`).click();
    await settings.getByLabel(`전이 ${edgeIndex} 필수 속성 · 설명`, { exact: true }).check();
    await settings.locator('.workflow-tabs button').filter({ hasText: '필수 속성' }).click();
    await settings.getByRole('button', { name: '규칙 추가', exact: true }).click();
    const ruleIndex = original.fieldRules.length + 1;
    await settings.getByLabel(`규칙 ${ruleIndex} 업무 유형`, { exact: true }).selectOption('버그');
    await settings.getByLabel(`규칙 ${ruleIndex} 상태`, { exact: true }).selectOption(stateId);
    await settings.locator(`summary[aria-label="규칙 ${ruleIndex} 필수 속성"]`).click();
    await settings.getByLabel(`규칙 ${ruleIndex} 필수 속성 · 담당자`, { exact: true }).check();
    await settings.locator(`summary[aria-label="규칙 ${ruleIndex} 필수 속성"]`).click();
    const saveResponse = page.waitForResponse(response => response.url().endsWith(`/projects/${project.id}/workflow`) && response.request().method() === 'PATCH');
    await settings.getByRole('button', { name: '워크플로 저장', exact: true }).click();
    expect((await saveResponse).ok()).toBeTruthy();
    await expect(settings.getByRole('button', { name: '워크플로 저장', exact: true })).toBeDisabled();
    const saved = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
    expect(saved.initialStatusId).toBe(stateId);
    expect(saved.transitions.find(edge => edge.from === stateId)?.requiredFields).toEqual(['description']);

    await page.locator('.project-navigation button').filter({ hasText: '간트 · 일정' }).click();
    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    const form = page.getByRole('form', { name: '간트에서 업무 만들기' });
    await form.getByLabel('추가할 업무 제목').fill(`워크플로 브라우저 ${suffix}`);
    await form.getByLabel('추가할 업무 유형').selectOption('버그');
    await form.getByLabel('추가할 업무 담당자').selectOption(snapshot.users[0].id);
    const today = new Date().toISOString().slice(0, 10);
    await form.getByLabel('추가할 업무 시작일').fill(today);
    await form.getByLabel('추가할 업무 종료일').fill(today);
    const createResponse = page.waitForResponse(response => response.url().endsWith('/api/issues') && response.request().method() === 'POST');
    await form.getByRole('button', { name: '간트에 추가', exact: true }).click();
    created = await (await createResponse).json() as Issue;
    expect(created.status).toBe(stateId);
    await expect(page.locator(`[data-issue-id="${created.id}"] .gantt-task-range`)).toHaveCSS('--bar-color', '#588b9c');
    await page.locator('.project-navigation button').filter({ hasText: /^업무/ }).click();
    await page.getByRole('button', { name: '보드', exact: true }).click();
    await page.getByLabel('업무 검색', { exact: true }).fill(created.title);
    const column = page.locator('.issue-board-column').filter({ has: page.locator('.issue-board-heading strong').filter({ hasText: label }) });
    await expect(column.getByRole('button').filter({ hasText: created.title })).toBeVisible();
    await column.locator('.issue-board-card').click();
    const panel = page.getByRole('dialog');
    await expect(panel.getByLabel('상태', { exact: true })).toHaveValue(stateId);
    await expect(panel.getByLabel('상태', { exact: true }).locator('option[value="review"]')).toHaveCount(0);
    await panel.getByLabel('상태', { exact: true }).selectOption('done');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('설명');
    await panel.getByLabel('설명', { exact: true }).fill('검토 결과를 기록했습니다.');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await expect.poll(async () => { const value = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot; return value.issues.find(issue => issue.id === created!.id)?.status; }).toBe('done');
  } finally {
    if (created) await request.delete(`/api/issues/${created.id}`);
    const latest = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
    await request.patch(`/api/projects/${project.id}/workflow`, { data: { ...original, expectedVersion: latest.version } });
  }
});

test('워크플로 버전 충돌 시 작성 중인 설정을 보존하고 명시적으로 최신 설정을 불러온다', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const project = snapshot.projects[0];
  const original = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
  try {
    await page.goto(`/#/${project.id}/settings`);
    const settings = page.getByRole('region', { name: '프로젝트 워크플로 설정' });
    await expect(settings.getByLabel('상태 1 이름', { exact: true })).toBeEnabled();
    await settings.getByLabel('상태 1 이름', { exact: true }).fill('내가 작성 중인 설정');
    const changed = await request.patch(`/api/projects/${project.id}/workflow`, { data: { ...original, expectedVersion: original.version, statuses: original.statuses.map((status, index) => index === 0 ? { ...status, label: '다른 작업자의 설정' } : status) } });
    expect(changed.ok()).toBeTruthy();
    const response = page.waitForResponse(value => value.url().endsWith(`/projects/${project.id}/workflow`) && value.request().method() === 'PATCH');
    await settings.getByRole('button', { name: '워크플로 저장', exact: true }).click();
    expect((await response).status()).toBe(409);
    await expect(settings.getByRole('alert')).toContainText('입력한 설정은 유지됩니다');
    await expect(settings.getByLabel('상태 1 이름', { exact: true })).toHaveValue('내가 작성 중인 설정');
    page.once('dialog', dialog => dialog.accept());
    await settings.getByRole('button', { name: '최신 설정 불러오기', exact: true }).click();
    await expect(settings.getByLabel('상태 1 이름', { exact: true })).toHaveValue('다른 작업자의 설정');
    await expect(settings.getByRole('button', { name: '워크플로 저장', exact: true })).toBeDisabled();
  } finally { const latest = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow; await request.patch(`/api/projects/${project.id}/workflow`, { data: { ...original, expectedVersion: latest.version } }); }
});

test('작업공간 새로고침은 깨끗한 설정을 갱신하고 작성 중인 설정은 경고와 함께 유지한다', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const project = snapshot.projects[0], user = snapshot.users[0];
  const original = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
  try {
    await page.goto(`/#/${project.id}/settings`);
    const settings = page.getByRole('region', { name: '프로젝트 워크플로 설정' });
    const name = settings.getByLabel('상태 1 이름', { exact: true });
    await expect(name).toBeEnabled();
    const first = await request.patch(`/api/projects/${project.id}/workflow`, { data: { ...original, expectedVersion: original.version, statuses: original.statuses.map((status, index) => index === 0 ? { ...status, label: '새로고침으로 반영된 이름' } : status) } });
    expect(first.ok()).toBeTruthy();
    const updated = await first.json() as ProjectWorkflow;
    page.once('dialog', dialog => dialog.accept(`workflow-${Date.now()}@example.test`));
    await page.locator('.team-row').filter({ hasText: user.name }).getByRole('button', { name: '이메일 변경', exact: true }).click();
    await expect(name).toHaveValue('새로고침으로 반영된 이름');
    await name.fill('새로고침에도 유지할 작성 내용');
    const second = await request.patch(`/api/projects/${project.id}/workflow`, { data: { ...updated, expectedVersion: updated.version, statuses: updated.statuses.map((status, index) => index === 0 ? { ...status, label: '동시에 바뀐 서버 이름' } : status) } });
    expect(second.ok()).toBeTruthy();
    page.once('dialog', dialog => dialog.accept(user.email));
    await page.locator('.team-row').filter({ hasText: user.name }).getByRole('button', { name: '이메일 변경', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('서버 워크플로가 버전');
    await expect(name).toHaveValue('새로고침에도 유지할 작성 내용');
  } finally {
    await request.patch(`/api/users/${user.id}`, { data: { email: user.email } });
    const latest = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
    await request.patch(`/api/projects/${project.id}/workflow`, { data: { ...original, expectedVersion: latest.version } });
  }
});
