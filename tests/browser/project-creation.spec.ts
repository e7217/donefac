import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Project, WorkspaceSnapshot } from '../../shared/types';

test('360px에서 프로젝트를 한 번 만들고 응답과 목록 갱신이 끊겨도 같은 개요로 이동한다', async ({ page, request }) => {
  const before = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const name = `합성 새 프로젝트 ${randomUUID()}`;
  const key = `PJ${randomUUID().replaceAll('-', '').slice(0, 10)}`.toUpperCase();
  const actor = before.users[1].id;
  await page.addInitScript(actorId => localStorage.setItem('donefac.actor', actorId), actor);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/#/${before.projects[0].id}/overview`);
  await page.getByRole('button', { name: '메뉴 열기' }).click();
  await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 프로젝트' });
  const title = dialog.getByRole('textbox', { name: '프로젝트 이름' });
  const prefix = dialog.getByRole('textbox', { name: '티켓 접두어' });
  await expect(title).toBeFocused();
  await title.fill(name);
  await prefix.fill(before.projects[0].key);
  await dialog.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('이미 사용 중인 티켓 접두어');
  await expect(prefix).toBeEnabled();
  await expect(title).toHaveValue(name);
  await prefix.fill(key.toLowerCase());
  await expect(prefix).toHaveValue(key);
  const description = dialog.getByRole('textbox', { name: '프로젝트 소개' });
  await description.fill('새 프로젝트의 합성 설명');
  page.once('dialog', async confirmation => {
    expect(confirmation.message()).toContain('작성 중인 프로젝트 입력');
    await confirmation.dismiss();
  });
  await page.keyboard.press('Escape');
  await expect(description).toHaveValue('새 프로젝트의 합성 설명');

  const projectRequests: { body: string | null; actor: string | undefined }[] = [];
  let made: Project | undefined;
  let rejectRefresh = false;
  await page.route('**/api/workspace', async route => {
    if (!rejectRefresh) { await route.continue(); return; }
    rejectRefresh = false;
    await route.fulfill({ status: 503, json: { error: '합성 목록 응답 실패' } });
  });
  await page.route('**/api/projects', async route => {
    const sent = route.request();
    projectRequests.push({ body: sent.postData(), actor: (await sent.allHeaders())['x-actor-id'] });
    const result = await route.fetch();
    if (!made) {
      expect(result.status()).toBe(201);
      made = await result.json() as Project;
      await route.abort('failed');
      return;
    }
    expect(result.status()).toBe(200);
    expect(await result.json()).toEqual(made);
    rejectRefresh = true;
    await route.fulfill({ response: result });
  });

  await dialog.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
  const confirmResult = dialog.getByRole('button', { name: '생성 결과 다시 확인' });
  await expect(confirmResult).toBeFocused();
  await expect(prefix).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('같은 요청으로 다시 확인');
  await confirmResult.press('Enter');
  const openProject = dialog.getByRole('button', { name: '저장한 프로젝트 열기' });
  await expect(openProject).toBeFocused();
  await expect(dialog.getByRole('alert')).toContainText('프로젝트는 저장되었습니다');
  await openProject.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name, exact: true })).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/#/${made!.id}/overview$`));
  expect(projectRequests).toHaveLength(2);
  expect(projectRequests[1]).toEqual(projectRequests[0]);
  expect(projectRequests[0]).toMatchObject({ actor });
  const current = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  expect(current.projects.filter(project => project.key === key)).toEqual([made]);
  expect(current.activities.filter(activity => activity.resourceId === made!.id)).toMatchObject([{ actorId: actor, action: '프로젝트 생성' }]);
  expect(current.issues.filter(issue => issue.projectId === made!.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
