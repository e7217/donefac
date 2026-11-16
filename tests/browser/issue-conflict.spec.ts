import { test, expect } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

test('미저장 업무 편집은 외부 변경·댓글 새로고침에도 유지되며 이전 버전으로 충돌 검사된다', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const created = await (await request.post('/api/issues', { data: { projectId: snapshot.projects[0].id, title: `동시 편집 검사 ${Date.now()}`, description: '편집 시작 내용' } })).json() as Issue;
  try {
    await page.goto(`/#/${created.projectId}/issues?issue=${created.id}`);
    const panel = page.getByRole('dialog');
    const title = panel.getByLabel('제목', { exact: true });
    await expect(title).toHaveValue(created.title);
    await title.fill('내가 작성 중인 제목');

    const remote = await request.patch(`/api/issues/${created.id}`, { data: { expectedVersion: created.version, title: '다른 작업자가 저장한 제목', description: '다른 작업자가 저장한 설명' } });
    expect(remote.ok()).toBeTruthy();
    await panel.getByLabel('댓글 내용').fill('댓글 등록으로 새 작업공간 정보를 불러옵니다.');
    await panel.getByRole('button', { name: '댓글 등록', exact: true }).click();
    await expect(panel.getByText('댓글 등록으로 새 작업공간 정보를 불러옵니다.', { exact: true })).toBeVisible();
    await expect(title).toHaveValue('내가 작성 중인 제목');
    await expect(panel.getByLabel('설명', { exact: true })).toHaveValue('편집 시작 내용');
    await expect(panel.getByText('다른 변경사항이 있습니다', { exact: true })).toBeVisible();

    const saveResponse = page.waitForResponse(response => response.url().endsWith(`/api/issues/${created.id}`) && response.request().method() === 'PATCH');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const response = await saveResponse;
    expect(response.request().postDataJSON().expectedVersion).toBe(created.version);
    expect(response.status()).toBe(409);
    await expect(title).toHaveValue('내가 작성 중인 제목');
    const after = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(after.issues.find(issue => issue.id === created.id)?.description).toBe('다른 작업자가 저장한 설명');

    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: '최신 버전 불러오기', exact: true }).click();
    await expect(title).toHaveValue('다른 작업자가 저장한 제목');
    await expect(panel.getByLabel('설명', { exact: true })).toHaveValue('다른 작업자가 저장한 설명');
    await expect(panel.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();

    await title.fill('최신 버전 위에 새로 편집한 제목');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await expect(panel.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
    await expect.poll(async () => { const value = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot; return value.issues.find(issue => issue.id === created.id)?.title; }).toBe('최신 버전 위에 새로 편집한 제목');
  } finally { await request.delete(`/api/issues/${created.id}`); }
});

test('미저장 업무는 닫기와 다른 업무 이동을 취소할 수 있고 승인 뒤에는 확인이 중복되지 않는다', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const parent = await (await request.post('/api/issues', { data: { projectId: snapshot.projects[0].id, title: `이동 확인 부모 ${Date.now()}` } })).json() as Issue;
  let child: Issue | undefined;
  try {
    child = await (await request.post('/api/issues', { data: { projectId: parent.projectId, parentId: parent.id, title: `이동 확인 자식 ${Date.now()}` } })).json() as Issue;
    await page.goto(`/#/${parent.projectId}/issues?issue=${parent.id}`);
    const panel = page.getByRole('dialog');
    await panel.getByLabel('제목', { exact: true }).fill('보존되어야 하는 미저장 제목');
    page.once('dialog', dialog => dialog.dismiss());
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(panel.getByLabel('제목', { exact: true })).toHaveValue('보존되어야 하는 미저장 제목');

    page.once('dialog', dialog => dialog.dismiss());
    expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
    await expect(panel.getByLabel('제목', { exact: true })).toHaveValue('보존되어야 하는 미저장 제목');

    const childButton = panel.locator('.issue-related-row').filter({ hasText: child.title });
    page.once('dialog', dialog => dialog.dismiss());
    await childButton.click();
    await expect(panel.getByLabel('제목', { exact: true })).toHaveValue('보존되어야 하는 미저장 제목');

    let dialogCount = 0;
    const accept = async (dialog: import('@playwright/test').Dialog) => { dialogCount++; await dialog.accept(); };
    page.on('dialog', accept);
    await childButton.click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: child.title, exact: true })).toBeVisible();
    expect(dialogCount).toBe(1);
    page.off('dialog', accept);
    await page.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(page.locator('.issue-detail-panel')).toHaveCount(0);
  } finally { if (child) await request.delete(`/api/issues/${child.id}`); await request.delete(`/api/issues/${parent.id}`); }
});

test('저장 응답을 기다리는 동안 입력과 탐색을 잠그고 응답 후에는 다음 편집을 유지한다', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const issue = await (await request.post('/api/issues', { data: { projectId: snapshot.projects[0].id, title: `지연 저장 검사 ${Date.now()}` } })).json() as Issue;
  let releaseResponse: () => void = () => undefined;
  let reachedResponse: () => void = () => undefined;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  const intercepted = new Promise<void>(resolve => { reachedResponse = resolve; });
  try {
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog');
    const title = panel.getByLabel('제목', { exact: true });
    await expect(title).toHaveValue(issue.title);
    await page.route(`**/api/issues/${issue.id}`, async route => {
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      const response = await route.fetch();
      reachedResponse();
      await responseGate;
      await route.fulfill({ response });
    });
    await title.fill('저장 요청에 담긴 제목');
    await panel.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await intercepted;
    await expect(title).toBeDisabled();
    await expect(panel.getByLabel('설명', { exact: true })).toBeDisabled();
    await expect(panel.getByLabel('상태', { exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '업무 상세 닫기', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    await expect(title).toHaveValue('저장 요청에 담긴 제목');

    releaseResponse();
    await expect(title).toBeEnabled();
    await expect(title).toHaveValue('저장 요청에 담긴 제목');
    await title.fill('응답 이후 이어서 편집한 제목');
    await expect(title).toHaveValue('응답 이후 이어서 편집한 제목');
    await expect(panel.getByRole('button', { name: '변경사항 저장', exact: true })).toBeEnabled();
    const saved = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(saved.issues.find(value => value.id === issue.id)?.title).toBe('저장 요청에 담긴 제목');
  } finally { releaseResponse(); await page.unroute(`**/api/issues/${issue.id}`); await request.delete(`/api/issues/${issue.id}`); }
});
