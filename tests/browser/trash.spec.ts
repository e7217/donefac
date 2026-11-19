import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Issue, TrashPage, WorkspaceSnapshot } from '../../shared/types';

test('360px에서 업무를 휴지통으로 옮기고, 복원한 원래 업무를 열고, 영구 삭제를 확인한다', async ({ page, playwright, baseURL }) => {
  const requests = await playwright.request.newContext({ baseURL });
  const title = `휴지통 흐름 검증 ${randomUUID()}`;
  let issue: Issue | undefined;
  try {
    const snapshot = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    const response = await requests.post('/api/issues', { data: { projectId: snapshot.projects[0].id, title, description: '복원한 원래 설명' } });
    expect(response.status(), await response.text()).toBe(201);
    issue = await response.json() as Issue;
    const { id, projectId } = issue;

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/issues?issue=${id}`);
    const panel = page.getByRole('dialog', { name: title, exact: true });
    const issueTitle = panel.getByRole('textbox', { name: '제목', exact: true });
    const deleteButton = panel.getByRole('button', { name: '업무 삭제', exact: true });
    const confirmArchive = panel.getByRole('button', { name: '휴지통으로 이동', exact: true });
    await expect(issueTitle).toHaveValue(title);
    await issueTitle.fill('취소하면 유지되는 업무 제목 초안');
    await deleteButton.click();
    await panel.getByRole('button', { name: '취소', exact: true }).click();
    await expect(issueTitle).toHaveValue('취소하면 유지되는 업무 제목 초안');
    await issueTitle.fill(title);

    async function archive() {
      await deleteButton.click();
      const pending = page.waitForResponse(result => result.request().method() === 'DELETE' && new URL(result.url()).pathname === `/api/issues/${id}`);
      await confirmArchive.click();
      const archived = await pending;
      expect(archived.status(), await archived.text()).toBe(200);
      await expect(panel).toHaveCount(0);
    }

    const openTrash = async () => {
      await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
      await page.getByRole('button', { name: '휴지통', exact: true }).click();
      await expect(page.getByRole('heading', { name: '휴지통', exact: true })).toBeVisible();
    };
    const row = page.getByRole('listitem').filter({ hasText: title });
    await archive();
    const current = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(current.issues.find(value => value.id === id)).toBeUndefined();
    await openTrash();
    await expect(row).toContainText(issue.key);
    const bounds = await row.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    const restorePending = page.waitForResponse(result => result.request().method() === 'POST' && /\/api\/trash\/[^/]+\/restore$/.test(new URL(result.url()).pathname));
    await row.getByRole('button', { name: '복원', exact: true }).click();
    expect((await restorePending).status()).toBe(200);
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: '복원한 업무 열기', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: '설명', exact: true })).toHaveValue('복원한 원래 설명');
    expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('issue')).toBe(id);

    await archive();
    // Opening from trash can keep the workspace route underneath the issue drawer.
    if (!(await page.getByRole('heading', { name: '휴지통', exact: true }).isVisible())) await openTrash();
    await expect(row).toBeVisible();
    const purge = row.getByRole('button', { name: '영구 삭제', exact: true });
    page.once('dialog', dialog => dialog.dismiss());
    await purge.click();
    await expect(row).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    const purgePending = page.waitForResponse(result => result.request().method() === 'DELETE' && /\/api\/trash\/[^/]+$/.test(new URL(result.url()).pathname));
    await purge.click();
    expect((await purgePending).status()).toBe(200);
    await expect(row).toHaveCount(0);
  } finally {
    try {
      if (issue) {
        const response = await requests.delete(`/api/issues/${issue.id}`);
        expect([200, 404]).toContain(response.status());
        const result = await requests.get(`/api/trash?scope=project&projectId=${issue.projectId}&resourceType=issue`);
        const listing = await result.json() as TrashPage;
        const entry = listing.items?.find(value => value.resourceId === issue!.id);
        if (entry) expect((await requests.delete(`/api/trash/${entry.id}`)).status()).toBe(200);
      }
    } finally { await requests.dispose(); }
  }
});
