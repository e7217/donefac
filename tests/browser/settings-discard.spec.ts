import { test, expect, type Dialog, type Page } from '@playwright/test';
import type { ApiKeyCreated, ApiKeyRecord, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

async function decisions(page: Page, choices: boolean[], action: () => Promise<unknown>) {
  const messages: string[] = [];
  const handle = async (dialog: Dialog) => { const accepted = choices[messages.length] ?? false; messages.push(dialog.message()); if (accepted) await dialog.accept(); else await dialog.dismiss(); };
  page.on('dialog', handle);
  try { await action(); } finally { page.off('dialog', handle); }
  expect(messages).toHaveLength(choices.length);
  return messages;
}

test('워크플로와 달력을 함께 편집하면 뒤의 탐색 취소가 앞에서 동의한 초안도 보존한다', async ({ page, request }) => {
  const data = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot, project = data.projects[0];
  const workflow = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
  const originalCalendar = data.calendars!.find(value => value.projectId === project.id)!;
  await page.goto(`/#/${project.id}/settings`);
  const workflowEditor = page.getByRole('region', { name: '프로젝트 워크플로 설정' });
  const calendarEditor = page.getByRole('region', { name: '업무 달력 설정' });
  const stateName = workflowEditor.getByLabel('상태 1 이름', { exact: true }), calendarName = calendarEditor.getByLabel('업무 달력 이름', { exact: true });
  await expect(stateName).toBeEnabled(); await expect(calendarName).toBeEnabled();
  await stateName.fill('취소하면 보존할 워크플로'); await calendarName.fill('취소하면 보존할 달력');
  const currentUrl = page.url();
  const prompts = await decisions(page, [true, false], () => page.locator('.project-navigation').getByRole('button', { name: '간트 · 일정', exact: true }).click());
  expect(prompts.some(value => value.includes('워크플로'))).toBe(true); expect(prompts.some(value => value.includes('달력'))).toBe(true);
  await expect(page).toHaveURL(currentUrl);
  await expect(stateName).toHaveValue('취소하면 보존할 워크플로'); await expect(calendarName).toHaveValue('취소하면 보존할 달력');
  await expect(workflowEditor.getByRole('button', { name: '워크플로 저장', exact: true })).toBeEnabled(); await expect(calendarEditor.getByRole('button', { name: '업무 달력 저장', exact: true })).toBeEnabled();
  // Staying mounted also exercises the actual reset, rather than relying on an unmount.
  await decisions(page, [true, true], () => page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))));
  await expect(stateName).toHaveValue(workflow.statuses[0].label); await expect(calendarName).toHaveValue(originalCalendar.name);
  await expect(workflowEditor.getByRole('button', { name: '워크플로 저장', exact: true })).toBeDisabled(); await expect(calendarEditor.getByRole('button', { name: '업무 달력 저장', exact: true })).toBeDisabled();
  await page.locator('.project-navigation').getByRole('button', { name: '간트 · 일정', exact: true }).click();
  await page.getByRole('button', { name: '워크스페이스 설정', exact: true }).click();
  await expect(stateName).toHaveValue(workflow.statuses[0].label); await expect(calendarName).toHaveValue(originalCalendar.name);
});

test('한 번 표시하는 API 키와 달력은 두 확인 순서 모두에서 탐색 취소 시 함께 유지된다', async ({ page, request }) => {
  const data = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot, project = data.projects[0];
  const originalCalendar = data.calendars!.find(value => value.projectId === project.id)!;
  const [nextActor, owner] = data.users;
  let created: ApiKeyCreated | null = null;
  try {
    await page.goto(`/#/${project.id}/settings`);
    await expect(page.getByLabel('업무 달력 이름', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('API 키 이름', { exact: true })).toBeVisible();
    await expect(page.getByLabel('상태 1 이름', { exact: true })).toBeEnabled();
    // Warmed modules remount together, registering Calendar before API Keys.
    const actor = page.getByLabel('작업자 선택', { exact: true }); await actor.selectOption(owner.id);
    const calendar = page.getByRole('region', { name: '업무 달력 설정' }), calendarName = calendar.getByLabel('업무 달력 이름', { exact: true });
    await expect(calendarName).toBeEnabled(); await calendarName.fill('키와 함께 보존할 달력');
    await page.getByLabel('API 키 이름', { exact: true }).fill(`복합 탐색 합성 키 ${Date.now()}`);
    const issued = page.waitForResponse(value => value.url().endsWith('/api/api-keys') && value.request().method() === 'POST');
    await page.getByRole('button', { name: 'API 키 발급', exact: true }).click();
    created = await (await issued).json() as ApiKeyCreated;
    const secret = page.getByRole('dialog', { name: 'API 키를 복사해주세요', exact: true });
    await expect(secret.getByLabel('발급한 API 키', { exact: true })).toHaveValue(created.token);
    await expect(page.getByLabel('API 키 이름', { exact: true })).toBeEnabled();
    const currentUrl = page.url();
    const calendarFirst = await decisions(page, [true, false], () => actor.selectOption(nextActor.id));
    expect(calendarFirst[0]).toContain('달력'); expect(calendarFirst[1]).toContain('API 키');
    await expect(actor).toHaveValue(owner.id); await expect(page).toHaveURL(currentUrl);
    await expect(calendarName).toHaveValue('키와 함께 보존할 달력'); await expect(secret.getByLabel('발급한 API 키', { exact: true })).toHaveValue(created.token);

    // A local explicit reload is allowed immediately. Its workspace refresh moves
    // Calendar's listener after API Keys, exercising the reverse confirmation order.
    await decisions(page, [true], () => calendar.getByRole('button', { name: '최신 달력', exact: true }).dispatchEvent('click'));
    await expect(calendarName).toHaveValue(originalCalendar.name); await expect(calendarName).toBeEnabled();
    await calendarName.fill('반대 순서에서도 보존할 달력');
    const keyFirst = await decisions(page, [true, false], () => actor.selectOption(nextActor.id));
    expect(keyFirst[0]).toContain('API 키'); expect(keyFirst[1]).toContain('달력');
    await expect(actor).toHaveValue(owner.id); await expect(page).toHaveURL(currentUrl);
    await expect(secret.getByLabel('발급한 API 키', { exact: true })).toHaveValue(created.token); await expect(calendarName).toHaveValue('반대 순서에서도 보존할 달력');
    await decisions(page, [true, true], () => actor.selectOption(nextActor.id));
    await expect(actor).toHaveValue(nextActor.id); await expect(secret).toHaveCount(0); await expect(calendarName).toHaveValue(originalCalendar.name);
  } finally {
    if (created) { const keys = await (await request.get('/api/api-keys', { headers: { 'X-Actor-Id': owner.id } })).json() as ApiKeyRecord[]; const key = keys.find(value => value.id === created!.key.id); if (key && !key.revokedAt) expect((await request.post(`/api/api-keys/${key.id}/revoke`, { headers: { 'X-Actor-Id': owner.id }, data: { expectedVersion: key.version } })).status()).toBe(200); }
  }
});
