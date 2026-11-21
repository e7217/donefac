import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { DocPage, Favorite, Issue, WorkspaceSnapshot } from '../../shared/types';

async function readJson<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

async function removeFixture(request: APIRequestContext, path: string) {
  const { trashEntryId } = await readJson<{ trashEntryId: string }>(await request.delete(path));
  expect((await request.delete(`/api/trash/${trashEntryId}`)).ok()).toBe(true);
}

test('360px에서 프로젝트를 넘나드는 개인 즐겨찾기를 열고 작업자별로 유지한다', async ({ page, request }) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { projects: [documentProject, issueProject], users: [actor, otherActor] } =
    await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const prefix = `즐겨찾기 ${randomUUID().slice(0, 8)}`;
  const issue = await readJson<Issue>(await request.post('/api/issues', {
    data: { projectId: issueProject.id, title: `${prefix} 업무` },
  }), 201);
  let document: DocPage | undefined;
  const release = Promise.withResolvers<void>();

  try {
    document = await readJson<DocPage>(await request.post('/api/documents', {
      data: { projectId: documentProject.id, title: `${prefix} 문서` },
    }), 201);
    const actors = page.getByLabel('작업자 선택', { exact: true });
    const ticket = page.getByRole('dialog', { name: issue.title, exact: true });
    await page.goto(`/#/${issueProject.id}/issues?issue=${issue.id}`);
    await expect(actors).toHaveValue(actor.id);
    await ticket.getByRole('button', { name: '즐겨찾기 추가', exact: true }).click();
    await expect(ticket.getByRole('button', { name: '즐겨찾기 해제', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await page.goto(`/#/${documentProject.id}/documents/${document.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);
    await page.getByRole('button', { name: '즐겨찾기 추가', exact: true }).click();
    await expect(page.getByRole('button', { name: '즐겨찾기 해제', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
    await page.getByRole('button', { name: '즐겨찾기', exact: true }).click();
    const favoriteHash = `#/${documentProject.id}/favorites`;
    await expect(page).toHaveURL(url => url.hash === favoriteHash);
    await expect(page.getByRole('heading', { name: '즐겨찾기', exact: true })).toBeVisible();
    const issueGroup = page.getByRole('region', { name: '즐겨찾는 업무', exact: true });
    const documentGroup = page.getByRole('region', { name: '즐겨찾는 문서', exact: true });
    const openIssue = issueGroup.getByRole('button', { name: `${issue.key} 업무 열기`, exact: true });
    const openDocument = documentGroup.getByRole('button', { name: `${document.title} 문서 열기`, exact: true });
    await expect(openIssue).toContainText(issueProject.name);
    await expect(openDocument).toContainText(documentProject.name);
    for (const row of [openIssue, openDocument]) {
      const bounds = await row.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    }

    await openIssue.click();
    await expect(ticket).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === `${favoriteHash}?issue=${issue.id}`);
    await expect(ticket.getByRole('button', { name: '즐겨찾기 해제', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(ticket).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === favoriteHash);
    await expect(openIssue).toBeFocused();
    await openDocument.click();
    await expect(page).toHaveURL(url => url.hash === `#/${documentProject.id}/documents/${document?.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === favoriteHash);
    await expect(openIssue).toBeVisible();
    await expect(openDocument).toBeVisible();

    const empty = page.getByText('업무나 문서에서 별표를 눌러 즐겨찾기에 추가하세요.', { exact: true });
    await actors.selectOption(otherActor.id);
    await expect(empty).toBeVisible();
    await expect(openIssue).toHaveCount(0);
    await expect(openDocument).toHaveCount(0);

    const previousFavorites = await readJson<Favorite[]>(await request.get('/api/favorites', { headers: { 'X-Actor-Id': actor.id } }));
    expect(previousFavorites).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: 'issue', resourceId: issue.id }),
      expect.objectContaining({ resourceType: 'document', resourceId: document.id }),
    ]));
    const held = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let intercepted = false;
    await page.route('**/api/favorites', async route => {
      const sent = route.request();
      if (intercepted || sent.method() !== 'GET' || sent.headers()['x-actor-id'] !== actor.id) return route.continue();
      intercepted = true;
      held.resolve();
      await release.promise;
      try { await route.fulfill({ json: previousFavorites }); }
      catch { /* Changing actor may abort the held request. */ }
      finally { finished.resolve(); }
    });

    await actors.selectOption(actor.id);
    await held.promise;
    await actors.selectOption(otherActor.id);
    await expect(empty).toBeVisible();
    release.resolve();
    await finished.promise;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(empty).toBeVisible();
    await expect(openIssue).toHaveCount(0);
    await expect(openDocument).toHaveCount(0);

    await actors.selectOption(actor.id);
    await expect(openIssue).toBeVisible();
    await expect(openDocument).toBeVisible();
    await page.reload();
    await expect(actors).toHaveValue(actor.id);
    await expect(openIssue).toBeVisible();
    await expect(openDocument).toBeVisible();

    await issueGroup.getByRole('button', { name: `${issue.key} 즐겨찾기 해제`, exact: true }).click();
    await expect(openIssue).toHaveCount(0);
    await documentGroup.getByRole('button', { name: `${document.title} 즐겨찾기 해제`, exact: true }).click();
    await expect(empty).toBeVisible();
    await page.reload();
    await expect(empty).toBeVisible();
  } finally {
    release.resolve();
    await removeFixture(request, `/api/issues/${issue.id}`);
    if (document) await removeFixture(request, `/api/documents/${document.id}`);
  }
});
