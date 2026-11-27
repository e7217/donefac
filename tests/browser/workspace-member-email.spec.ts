import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { User, UserEmailChangeResult, WorkspaceSnapshot } from '../../shared/types';

test('팀원 이메일 충돌에서 초안을 유지하고 응답이 끊기면 이후 변경을 덮어쓰지 않고 저장을 확인한다', async ({ page, request }) => {
  const initial = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [actor, peer] = initial.users;
  const suffix = randomUUID();
  const draft = `draft-${suffix}@example.test`;
  const concurrent = `concurrent-${suffix}@example.test`;
  const latest = `latest-${suffix}@example.test`;
  const path = `/api/users/${actor.id}`;
  const received: { body: string | null; actor: string | undefined }[] = [];
  let committed: UserEmailChangeResult | undefined;
  let rejectRefresh = false;
  await page.addInitScript(actorId => localStorage.setItem('donefac.actor', actorId), actor.id);
  await page.setViewportSize({ width: 360, height: 800 });
  try {
    await page.goto(`/#/${initial.projects[0].id}/settings`);
    const row = page.locator('.team-row').filter({ hasText: actor.name });
    const opener = row.getByRole('button', { name: '이메일 변경', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '팀원 이메일 변경' });
    const email = dialog.getByLabel('새 이메일');
    const save = dialog.getByRole('button', { name: '이메일 저장' });
    await expect(email).toBeFocused();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await email.fill(draft);
    page.once('dialog', async confirmation => {
      expect(confirmation.message()).toContain('입력한 이메일');
      await confirmation.dismiss();
    });
    await page.keyboard.press('Escape');
    await expect(email).toHaveValue(draft);

    const peerUpdate = await request.patch(path, { data: { email: concurrent }, headers: { 'X-Actor-Id': peer.id } });
    expect(peerUpdate.ok()).toBe(true);
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText('다른 작업자가 팀원 정보를 변경했습니다');
    await expect(dialog.getByText(concurrent, { exact: true })).toBeVisible();
    await expect(email).toHaveValue(draft);
    const review = dialog.getByRole('button', { name: '현재 팀원 정보 다시 확인' });
    await expect(review).toBeFocused();
    await review.press('Enter');
    await expect(email).toBeFocused();
    await expect(email).toHaveValue(draft);
    const reviewed = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(reviewed.users.find(user => user.id === actor.id)?.email).toBe(concurrent);

    await page.route('**/api/workspace', async route => {
      if (!rejectRefresh) return route.continue();
      rejectRefresh = false;
      await route.fulfill({ status: 503, json: { error: '합성 목록 응답 실패' } });
    });
    await page.route(`**${path}`, async route => {
      const sent = route.request();
      received.push({ body: sent.postData(), actor: (await sent.allHeaders())['x-actor-id'] });
      const result = await route.fetch();
      expect(result.ok()).toBe(true);
      if (!committed) {
        committed = await result.json() as UserEmailChangeResult;
        expect(committed).toMatchObject({ user: { id: actor.id, email: draft }, duplicate: false });
        await route.abort('failed');
        return;
      }
      expect(await result.json()).toMatchObject({ user: { id: actor.id, email: latest }, appliedVersion: committed.appliedVersion, duplicate: true });
      rejectRefresh = true;
      await route.fulfill({ response: result });
    });
    await save.click();
    const confirmResult = dialog.getByRole('button', { name: '변경 결과 다시 확인' });
    await expect(confirmResult).toBeFocused();
    await expect(email).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText('같은 요청으로 다시 확인');
    const newer = await request.patch(path, { data: { email: latest }, headers: { 'X-Actor-Id': peer.id } });
    expect((await newer.json() as User).email).toBe(latest);
    await confirmResult.press('Enter');
    const retryList = dialog.getByRole('button', { name: '팀원 목록 다시 불러오기' });
    await expect(retryList).toBeFocused();
    await expect(dialog.getByRole('alert')).toContainText('이메일 변경은 저장되었습니다');
    await retryList.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(row.getByText(latest, { exact: true })).toBeVisible();
    expect(received).toHaveLength(2);
    expect(received[0].actor).toBe(actor.id);
    expect(received[1]).toEqual(received[0]);
    const current = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const memberActivities = (snapshot: WorkspaceSnapshot) => snapshot.activities.filter(activity => activity.resourceType === 'user' && activity.resourceId === actor.id);
    const newActivities = memberActivities(current).filter(value => !memberActivities(initial).some(before => before.id === value.id));
    expect(newActivities.map(activity => activity.actorId).sort()).toEqual([actor.id, peer.id, peer.id].sort());
  } finally {
    await request.patch(path, { data: { email: actor.email } });
  }
});
