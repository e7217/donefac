import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { AttachmentHead, Issue, TrashPage, WorkspaceSnapshot } from '../../shared/types';

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

test('360px에서 댓글과 첨부 버전을 개별 복원하고 원래 업무에서 확인한다', async ({ page, playwright, baseURL }) => {
  const requests = await playwright.request.newContext({ baseURL });
  const title = `개별 휴지통 검증 ${randomUUID()}`;
  const body = '복원할 업무 댓글 본문';
  const originalBytes = Buffer.from('개별 휴지통 원본 바이트');
  const latestBytes = Buffer.from('개별 휴지통 새 버전 바이트');
  let issue: Issue | undefined;
  try {
    const workspace = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
    const creation = await requests.post('/api/issues', { data: { projectId: workspace.projects[0].id, title } });
    expect(creation.status(), await creation.text()).toBe(201);
    issue = await creation.json() as Issue;
    const upload = await requests.post(`/api/attachments?${new URLSearchParams({ resourceType: 'issue', resourceId: issue.id, filename: '원본 자료.txt' })}`, {
      headers: { 'Content-Type': 'application/octet-stream' }, data: originalBytes,
    });
    expect(upload.status(), await upload.text()).toBe(201);
    const original = await upload.json() as AttachmentHead;
    const filename = '갱신 자료.txt';
    const appended = await requests.post(`/api/attachments/${original.id}/versions?${new URLSearchParams({ expectedVersionId: original.id, filename })}`, {
      headers: { 'Content-Type': 'application/octet-stream' }, data: latestBytes,
    });
    expect(appended.status(), await appended.text()).toBe(201);
    const latest = await appended.json() as AttachmentHead;

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const panel = page.getByRole('dialog', { name: title, exact: true });
    const input = panel.getByRole('textbox', { name: '댓글 내용', exact: true });
    await input.fill(body);
    await panel.getByRole('button', { name: '댓글 등록', exact: true }).click();
    const article = panel.locator('article').filter({ hasText: body });
    const deleteComment = article.getByRole('button', { name: '댓글 삭제', exact: true });
    await expect(deleteComment).toBeVisible();
    await input.fill('휴지통으로 옮겨도 남을 댓글 초안');
    page.once('dialog', dialog => void dialog.dismiss());
    await deleteComment.click();
    await expect(article).toBeVisible();
    page.once('dialog', dialog => void dialog.accept());
    await deleteComment.click();
    await expect(article).toHaveCount(0);
    await expect(input).toHaveValue('휴지통으로 옮겨도 남을 댓글 초안');
    await input.fill('');

    page.once('dialog', dialog => void dialog.accept());
    await panel.getByRole('button', { name: `${filename} 삭제`, exact: true }).click();
    await expect(panel.getByRole('button', { name: `${filename} 삭제`, exact: true })).toHaveCount(0);
    expect((await requests.get(`/api/attachments/${latest.currentVersionId}/content`)).status()).toBe(404);
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
    await page.getByRole('button', { name: '휴지통', exact: true }).click();
    const category = page.getByRole('combobox', { name: '항목 종류', exact: true });
    async function restoreItem(type: 'comment' | 'attachment', label: string) {
      await category.selectOption(type);
      const row = page.getByRole('listitem').filter({ hasText: label });
      await expect(row).toContainText(title);
      const response = page.waitForResponse(value => value.request().method() === 'POST' && /\/api\/trash\/items\/[^/]+\/restore$/.test(new URL(value.url()).pathname));
      await row.getByRole('button', { name: '복원', exact: true }).click();
      expect((await response).status()).toBe(200);
      await expect(row).toHaveCount(0);
    }
    await restoreItem('comment', body);
    await restoreItem('attachment', filename);
    await page.getByRole('button', { name: '원래 업무 열기', exact: true }).click();
    await expect(article).toContainText(body);
    await expect(panel.getByRole('link', { name: `${filename} 다운로드`, exact: true })).toBeVisible();
    for (const [id, expected] of [[original.id, originalBytes], [latest.currentVersionId, latestBytes]] as const) {
      const result = await requests.get(`/api/attachments/${id}/content`);
      expect(result.status()).toBe(200);
      expect(await result.body()).toEqual(expected);
    }
  } finally {
    try {
      if (issue) {
        const removed = await requests.delete(`/api/issues/${issue.id}`);
        if (removed.ok()) {
          const { trashEntryId } = await removed.json() as { trashEntryId: string };
          expect((await requests.delete(`/api/trash/${trashEntryId}`)).ok()).toBe(true);
        } else expect(removed.status()).toBe(404);
      }
    } finally { await requests.dispose(); }
  }
});
