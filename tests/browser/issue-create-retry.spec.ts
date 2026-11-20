import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

const createPath = '**/api/issues';
const workspacePath = '**/api/workspace';

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok()).toBe(true);
  return response.json();
}

async function openCreation(page: Page, projectId: string, board = false) {
  await page.goto(`/#/${projectId}/issues`);
  if (board) await page.getByRole('button', { name: '보드', exact: true }).click();
  await page.getByRole('button', { name: '업무 만들기', exact: true }).first().click();
  const modal = page.getByRole('dialog', { name: '새 업무 만들기', exact: true });
  await expect(modal.getByLabel('업무 제목', { exact: true })).toBeFocused();
  return modal;
}

async function removeTestIssues(request: APIRequestContext, projectId: string, title: string) {
  const snapshot = await workspace(request);
  for (const issue of snapshot.issues.filter(value => value.projectId === projectId && value.title === title)) {
    const removed = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`);
    }
  }
}

test('360px 업무 목록에서 생성 응답 유실과 접속 오류 뒤 같은 요청으로 티켓을 한 번 생성한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [project] } = await workspace(request);
  const title = `생성 응답 복구 ${randomUUID().slice(0, 8)}`;
  const startsOn = '2026-11-23';
  const endsOn = '2026-11-25';
  const attempts: { body: string | null; actorId: string | undefined }[] = [];
  let committed: Issue | undefined;

  try {
    const modal = await openCreation(page, project.id);
    const titleInput = modal.getByLabel('업무 제목', { exact: true });
    await titleInput.fill(title);
    await modal.getByLabel('시작일', { exact: true }).fill(startsOn);
    await modal.getByLabel('종료일', { exact: true }).fill(endsOn);
    await page.route(createPath, async route => {
      const sent = route.request();
      if (sent.method() !== 'POST') return route.continue();
      attempts.push({ body: sent.postData(), actorId: sent.headers()['x-actor-id'] });
      if (attempts.length === 1) {
        const response = await route.fetch();
        expect(response.status(), await response.text()).toBe(201);
        committed = await response.json() as Issue;
        await route.abort('failed');
      } else if (attempts.length === 2) {
        await route.fulfill({ status: 401, json: { error: '팀 접속 세션이 필요합니다.' } });
      } else {
        await route.continue();
      }
    });
    await modal.getByRole('button', { name: '업무 만들기', exact: true }).click();
    const retry = modal.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(modal.getByRole('alert')).toContainText('같은 요청');
    await expect(retry).toBeFocused();
    await expect(titleInput).toHaveValue(title);
    await expect(titleInput).toBeDisabled();
    await expect(modal.getByLabel('시작일', { exact: true })).toHaveValue(startsOn);

    await retry.click();
    await expect(modal.getByRole('alert')).toContainText('팀 접속을 확인한 뒤');
    await expect(retry).toBeFocused();
    await expect(titleInput).toBeDisabled();

    page.once('dialog', dialog => dialog.dismiss());
    await modal.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(modal).toBeVisible();

    const received = page.waitForResponse(response => response.url().endsWith('/api/issues') && response.request().method() === 'POST');
    await retry.click();
    const replay = await received;
    expect(replay.status(), await replay.text()).toBe(200);
    const issue = await replay.json() as Issue;
    expect(issue).toEqual(committed);
    expect(issue).toMatchObject({ projectId: project.id, title, startDate: startsOn, endDate: endsOn });
    expect(attempts).toHaveLength(3);
    expect(attempts).toEqual([attempts[0], attempts[0], attempts[0]]);
    expect(attempts[0].actorId).toBeTruthy();
    expect(JSON.parse(attempts[0].body!).requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
    const snapshot = await workspace(request);
    expect(snapshot.issues.filter(value => value.projectId === project.id && value.title === title)).toEqual([issue]);
    expect(snapshot.activities.filter(value => value.resourceId === issue.id && value.action === '티켓 생성')).toHaveLength(1);
  } finally {
    await removeTestIssues(request, project.id, title);
  }
});

test('업무 보드에서 유효성 오류를 고치고 목록 갱신 실패 뒤 같은 저장을 확인한다', async ({ page, request }) => {
  const { projects: [project] } = await workspace(request);
  const title = `보드 생성 확인 ${randomUUID().slice(0, 8)}`;
  const attempts: { requestId: string; endDate: string | null }[] = [];
  let created = false;
  let failedRefresh = 0;

  try {
    const modal = await openCreation(page, project.id, true);
    const titleInput = modal.getByLabel('업무 제목', { exact: true });
    const endDate = modal.getByLabel('종료일', { exact: true });
    await titleInput.fill(title);
    await modal.getByLabel('시작일', { exact: true }).fill('2026-11-23');
    await endDate.fill('2026-11-20');
    await page.route(createPath, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe([400, 201, 200][attempts.length - 1]);
      if (response.status() === 201) created = true;
      await route.fulfill({ response });
    });
    await page.route(workspacePath, async route => {
      if (created && !failedRefresh) {
        failedRefresh++;
        await route.abort('failed');
      } else await route.continue();
    });

    const create = modal.getByRole('button', { name: '업무 만들기', exact: true });
    await create.click();
    await expect(modal.getByRole('alert')).toContainText('종료일은 시작일보다 빠를 수 없습니다.');
    await expect(endDate).toBeEnabled();
    await expect(titleInput).toHaveValue(title);
    await endDate.fill('2026-11-25');
    await create.click();
    await expect(modal.getByRole('alert')).toContainText('업무를 만들었습니다. 목록을 다시 불러와');
    const retry = modal.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(retry).toBeFocused();
    await expect(endDate).toBeDisabled();
    await retry.click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();

    expect(failedRefresh).toBe(1);
    expect(attempts).toHaveLength(3);
    expect(attempts.map(value => value.endDate)).toEqual(['2026-11-20', '2026-11-25', '2026-11-25']);
    expect(attempts[1].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[2]).toEqual(attempts[1]);
    const snapshot = await workspace(request);
    const tickets = snapshot.issues.filter(value => value.projectId === project.id && value.title === title);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ startDate: '2026-11-23', endDate: '2026-11-25' });
    expect(snapshot.activities.filter(value => value.resourceId === tickets[0].id && value.action === '티켓 생성')).toHaveLength(1);
  } finally {
    await removeTestIssues(request, project.id, title);
  }
});

test('생성 뒤 목록을 불러오지 못한 티켓이 다른 작업에서 삭제되면 결과를 다시 열지 않는다', async ({ page, request }) => {
  const { projects: [project] } = await workspace(request);
  const title = `삭제된 생성 결과 ${randomUUID().slice(0, 8)}`;
  let created: Issue | undefined;
  let archivedId: string | undefined;
  let dropRefresh = false;

  try {
    const modal = await openCreation(page, project.id);
    const titleInput = modal.getByLabel('업무 제목', { exact: true });
    await titleInput.fill(title);
    await page.route(createPath, async route => {
      if (route.request().method() !== 'POST' || created) return route.continue();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      created = await response.json() as Issue;
      dropRefresh = true;
      await route.fulfill({ response });
    });
    await page.route(workspacePath, async route => {
      if (!dropRefresh) return route.continue();
      dropRefresh = false;
      await route.abort('failed');
    });

    const create = modal.getByRole('button', { name: '업무 만들기', exact: true });
    await create.click();
    await expect(modal.getByRole('alert')).toContainText('업무를 만들었습니다. 목록을 다시 불러와');
    expect(created).toBeDefined();
    const deleted = await request.delete(`/api/issues/${created!.id}?expectedVersion=${created!.version}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
    archivedId = ((await deleted.json()) as { trashEntryId: string }).trashEntryId;

    const received = page.waitForResponse(response => response.url().endsWith('/api/issues') && response.request().method() === 'POST');
    await modal.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true }).click();
    const response = await received;
    expect(response.status(), await response.text()).toBe(409);
    expect(await response.json()).toMatchObject({ details: { reason: 'result_unavailable' } });
    await expect(modal.getByRole('alert')).toContainText('업무 목록과 휴지통');
    await expect(titleInput).toHaveValue(title);
    await expect(titleInput).toBeDisabled();
    await expect(create).toBeDisabled();
    await expect(modal.getByRole('button', { name: '닫기', exact: true })).toBeFocused();
    await expect(page.getByRole('dialog', { name: title, exact: true })).toHaveCount(0);
    await expect(page.getByText('새 업무를 만들었습니다.', { exact: true })).toHaveCount(0);

    const reloaded = page.waitForResponse(result => result.url().endsWith('/api/workspace') && result.request().method() === 'GET');
    page.once('dialog', dialog => dialog.accept());
    expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(true);
    expect((await reloaded).ok()).toBe(true);
    await expect(modal).toHaveCount(0);
    const snapshot = await workspace(request);
    expect(snapshot.issues.some(value => value.projectId === project.id && value.title === title)).toBe(false);
    expect(snapshot.activities.filter(value => value.resourceId === created!.id && value.action === '티켓 생성')).toHaveLength(1);
  } finally {
    if (archivedId) await request.delete(`/api/trash/${archivedId}`);
    await removeTestIssues(request, project.id, title);
  }
});
