import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

const dateAt = (offset: number) => { const date = new Date(); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const snapshot = async (request: APIRequestContext) => (await (await request.get('/api/workspace')).json()) as WorkspaceSnapshot;
async function createIssue(request: APIRequestContext, projectId: string, title: string) {
  const response = await request.post('/api/issues', { data: { projectId, title, startDate: dateAt(0), endDate: dateAt(4) } });
  expect(response.ok()).toBeTruthy();
  return await response.json() as Issue;
}

test('간트에서 날짜 검증 후 업무를 생성하고 날짜 없는 업무도 화면 이동 없이 추가한다', async ({ page, request }) => {
  const initial = await snapshot(request);
  const project = initial.projects[0];
  const created: Issue[] = [];
  const title = `간트 직접 추가 ${Date.now()}`;
  try {
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    const form = page.getByRole('form', { name: '간트에서 업무 만들기' });
    await form.getByLabel('추가할 업무 제목').fill(title);
    await form.getByLabel('추가할 업무 유형').selectOption('개선');
    await form.getByLabel('추가할 업무 담당자').selectOption(initial.users[1].id);
    await form.getByLabel('추가할 업무 시작일').fill(dateAt(3));
    await form.getByLabel('추가할 업무 종료일').fill(dateAt(1));
    await form.getByRole('button', { name: '간트에 추가', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('종료일은 시작일보다 빠를 수 없습니다');
    expect((await snapshot(request)).issues.some(issue => issue.title === title)).toBe(false);
    await expect(form.getByLabel('추가할 업무 제목')).toHaveValue(title);
    await form.getByLabel('추가할 업무 종료일').fill(dateAt(5));
    const response = page.waitForResponse(value => value.url().endsWith('/api/issues') && value.request().method() === 'POST');
    await form.getByRole('button', { name: '간트에 추가', exact: true }).click();
    const scheduled = await (await response).json() as Issue;
    created.push(scheduled);
    await expect(form).toHaveCount(0);
    await expect(page.locator('.issue-detail-panel')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '일정 · 간트', exact: true })).toBeVisible();
    const stored = (await snapshot(request)).issues.find(issue => issue.id === scheduled.id)!;
    expect({ type: stored.type, assignee: stored.assigneeId, start: stored.startDate, end: stored.endDate }).toEqual({ type: '개선', assignee: initial.users[1].id, start: dateAt(3), end: dateAt(5) });
    await expect(page.getByLabel(`${scheduled.key} 시작일`, { exact: true })).toHaveValue(dateAt(3));

    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    await form.getByLabel('추가할 업무 제목').fill(`${title} 미정`);
    const unscheduledResponse = page.waitForResponse(value => value.url().endsWith('/api/issues') && value.request().method() === 'POST');
    await form.getByRole('button', { name: '간트에 추가', exact: true }).click();
    const unscheduled = await (await unscheduledResponse).json() as Issue;
    created.push(unscheduled);
    expect(unscheduled.startDate).toBeNull(); expect(unscheduled.endDate).toBeNull();
    await expect(page.locator('.gantt-unscheduled-row').filter({ hasText: unscheduled.title })).toBeVisible();
    await expect(page.locator('.issue-detail-panel')).toHaveCount(0);
  } finally { for (const issue of created) await request.delete(`/api/issues/${issue.id}`); }
});

test('간트 막대 종료일 드래그와 시작일 방향키는 미리보기 후 적용되며 날짜 입력과 되돌리기도 같은 업무를 수정한다', async ({ page, request }) => {
  const initial = await snapshot(request);
  const issue = await createIssue(request, initial.projects[0].id, `간트 기간 조정 ${Date.now()}`);
  try {
    await page.goto(`/#/${issue.projectId}/gantt`);
    await page.getByLabel('간트 업무 검색').fill(issue.title);
    const handle = page.getByRole('button', { name: `${issue.key} 종료일 조정`, exact: true });
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox(); expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + 64, box!.y + box!.height / 2, { steps: 6 }); await page.mouse.up();
    const preview = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.locator('.gantt-new-dates')).toContainText(dateAt(6));
    expect((await snapshot(request)).issues.find(value => value.id === issue.id)?.endDate).toBe(dateAt(4));
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === issue.id)?.endDate).toBe(dateAt(6));
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === issue.id)?.endDate).toBe(dateAt(4));

    await page.getByRole('button', { name: `${issue.key} 시작일 조정`, exact: true }).press('ArrowRight');
    await expect(preview.locator('.gantt-new-dates')).toContainText(dateAt(1));
    expect((await snapshot(request)).issues.find(value => value.id === issue.id)?.startDate).toBe(dateAt(0));
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === issue.id)?.startDate).toBe(dateAt(1));

    await page.getByLabel(`${issue.key} 종료일`, { exact: true }).fill(dateAt(7));
    await page.getByLabel(`${issue.key} 종료일`, { exact: true }).press('Enter');
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === issue.id)?.endDate).toBe(dateAt(7));
    await expect(page.getByLabel(`${issue.key} 시작일`, { exact: true })).toHaveValue(dateAt(1));

    const bar = page.getByRole('button', { name: `${issue.key} 일정 이동`, exact: true });
    await bar.scrollIntoViewIfNeeded();
    const barBox = await bar.boundingBox(); expect(barBox).toBeTruthy();
    await page.mouse.move(barBox!.x + barBox!.width / 2, barBox!.y + barBox!.height / 2);
    await page.mouse.down(); await page.mouse.move(barBox!.x + barBox!.width / 2 + 32, barBox!.y + barBox!.height / 2, { steps: 4 }); await page.mouse.up();
    await expect(preview.locator('.gantt-new-dates')).toContainText(dateAt(2));
    await expect(preview.locator('.gantt-new-dates')).toContainText(dateAt(8));
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    await expect.poll(async () => (await snapshot(request)).issues.find(value => value.id === issue.id)?.startDate).toBe(dateAt(2));
    expect((await snapshot(request)).issues.find(value => value.id === issue.id)?.endDate).toBe(dateAt(8));
  } finally { await request.delete(`/api/issues/${issue.id}`); }
});

test('기간 조정 미리보기의 버전이 오래되면409로 거절하고 제안 날짜와 서버 변경을 모두 보존한다', async ({ page, request }) => {
  const initial = await snapshot(request);
  const issue = await createIssue(request, initial.projects[0].id, `간트 기간 충돌 ${Date.now()}`);
  try {
    await page.goto(`/#/${issue.projectId}/gantt`);
    await page.getByLabel('간트 업무 검색').fill(issue.title);
    await page.getByRole('button', { name: `${issue.key} 종료일 조정`, exact: true }).press('ArrowRight');
    const preview = page.getByRole('dialog', { name: '일정 변경 미리보기', exact: true });
    await expect(preview.locator('.gantt-new-dates')).toContainText(dateAt(5));
    const remote = await request.patch(`/api/issues/${issue.id}`, { data: { expectedVersion: issue.version, endDate: dateAt(9), description: '동시에 저장한 내용' } });
    expect(remote.ok()).toBeTruthy();
    const applyResponse = page.waitForResponse(value => value.url().endsWith('/api/schedule/apply') && value.request().method() === 'POST');
    await preview.getByRole('button', { name: '변경 적용', exact: true }).click();
    const response = await applyResponse;
    expect(response.status()).toBe(409);
    expect(response.request().postDataJSON().changes[0].expectedVersion).toBe(issue.version);
    await expect(preview.getByRole('alert')).toContainText('미리보기와 입력 내용은 유지됩니다');
    await expect(preview.locator('.gantt-new-dates')).toContainText(dateAt(5));
    const latest = (await snapshot(request)).issues.find(value => value.id === issue.id)!;
    expect(latest.endDate).toBe(dateAt(9)); expect(latest.description).toBe('동시에 저장한 내용');
    await preview.getByRole('button', { name: '취소', exact: true }).click();
    await page.reload();
    await expect(page.getByLabel(`${issue.key} 종료일`, { exact: true })).toHaveValue(dateAt(9));
  } finally { await request.delete(`/api/issues/${issue.id}`); }
});
