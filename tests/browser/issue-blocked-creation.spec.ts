import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { Issue, IssueBlockedCreationResult, IssueRelation, Project, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('360px에서 간트와 티켓 상세로 다른 프로젝트의 차단 업무를 만들고 저장 결과를 확인한다', async ({ page, request }) => {
  const { projects: [sourceProject], users: [actor] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const prefix = `프로젝트 간 차단 생성 ${suffix}`;
  const sourceTitle = `${prefix} 사전 승인`;
  const targetTitle = `${prefix} 배포 검증`;
  const secondTitle = `${prefix} 미정 후속 업무`;
  const targetProject = await json<Project>(await request.post('/api/projects', {
    headers, data: { key: `BC${suffix}`, name: `${prefix} 대상` },
  }), 201);
  const calendarPath = `/api/projects/${targetProject.id}/calendar`;
  const defaultCalendar = await json<WorkCalendar>(await request.get(calendarPath));
  const firstCalendar = await json<WorkCalendar>(await request.patch(calendarPath, {
    headers, data: { expectedVersion: defaultCalendar.version, exceptions: [{ date: '2030-01-14', isWorking: false, label: '대상 프로젝트 휴무' }] },
  }));
  const source = await json<Issue>(await request.post('/api/issues', {
    headers, data: { projectId: sourceProject.id, title: sourceTitle, startDate: '2030-01-07', endDate: '2030-01-11' },
  }), 201);
  const path = `/api/issues/${source.id}/blocked-issues`;
  const postResult = () => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');

  try {
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${sourceProject.id}/gantt?scope=team`);
    const projectFilter = page.getByRole('combobox', { name: '프로젝트 필터', exact: true });
    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await projectFilter.selectOption(sourceProject.id);
    await search.fill(sourceTitle);
    await page.getByRole('checkbox', { name: `${source.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '프로젝트 간 차단', exact: true }).click();
    const blockers = page.getByRole('region', { name: '프로젝트 간 차단', exact: true });
    const open = blockers.getByRole('button', { name: '새 차단 대상 업무', exact: true });
    const modal = page.getByRole('dialog', { name: '새 차단 대상 업무', exact: true });
    await open.click();
    await expect(modal).toContainText(source.key);
    await modal.getByRole('button', { name: '취소', exact: true }).click();
    await expect(open).toBeFocused();
    await open.click();
    const project = modal.getByRole('combobox', { name: '프로젝트', exact: true });
    const title = modal.getByRole('textbox', { name: '업무 제목', exact: true });
    const start = modal.getByLabel('시작일', { exact: true });
    const end = modal.getByLabel('종료일', { exact: true });
    const suggest = modal.getByRole('button', { name: '제안 시작일 적용', exact: true });
    const submit = modal.getByRole('button', { name: '업무 만들고 차단 관계 연결', exact: true });
    await expect(project).toHaveValue('');
    await expect(project.locator(`option[value="${sourceProject.id}"]`)).toHaveCount(0);
    await project.selectOption(targetProject.id);
    await title.fill(targetTitle);
    await expect(start).toHaveValue('');
    await suggest.click();
    await expect(start).toHaveValue('2030-01-15');
    await end.fill('2030-01-17');

    const updatedCalendar = await json<WorkCalendar>(await request.patch(calendarPath, {
      headers, data: { expectedVersion: firstCalendar.version, exceptions: [...firstCalendar.exceptions,
        { date: '2030-01-15', isWorking: false, label: '추가 휴무' }] },
    }));
    const rejected = postResult();
    await submit.click();
    expect((await rejected).status()).toBe(409);
    const confirm = modal.getByRole('button', { name: '최신 차단 기준 사용', exact: true });
    await expect(confirm).toBeVisible();
    await expect(title).toHaveValue(targetTitle);
    await expect(start).toHaveValue('2030-01-15');
    await confirm.click();
    await expect(start).toHaveValue('2030-01-15');
    await suggest.click();
    await expect(start).toHaveValue('2030-01-16');
    await expect(end).toHaveValue('2030-01-17');
    const bounds = (await modal.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);

    const attempts: Record<string, unknown>[] = [];
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      const saved = await route.fetch();
      expect(saved.status(), await saved.text()).toBe(201);
      await route.abort('failed');
    });
    await submit.click();
    const retry = modal.getByRole('button', { name: '업무 생성 결과 다시 확인', exact: true });
    await expect(retry).toBeVisible();
    const replay = postResult();
    await retry.click();
    const created = await json<IssueBlockedCreationResult>(await replay);
    await page.unroute(`**${path}`);
    expect(created.duplicate).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0].expectedTargetCalendarVersion).toBe(updatedCalendar.version);
    expect(created.issue).toMatchObject({ projectId: targetProject.id, title: targetTitle, startDate: '2030-01-16', endDate: '2030-01-17' });
    expect(created.relation).toMatchObject({ type: 'blocks', sourceIssueId: source.id, targetIssueId: created.issue.id });
    await expect(modal).toHaveCount(0);
    await expect(projectFilter).toHaveValue(sourceProject.id);
    await expect(search).toHaveValue(sourceTitle);
    await expect(blockers.getByRole('button', { name: `${created.issue.key} 업무 열기`, exact: true })).toBeVisible();

    await blockers.getByRole('button', { name: `${source.key} 업무 열기`, exact: true }).first().click();
    const details = page.getByRole('dialog', { name: sourceTitle, exact: true });
    const description = details.getByRole('textbox', { name: '설명', exact: true });
    const comment = details.getByRole('textbox', { name: '댓글 내용', exact: true });
    await description.fill('저장하지 않은 원인 업무 설명');
    await comment.fill('아직 게시하지 않은 댓글');
    const relations = details.getByRole('region', { name: '업무 관계', exact: true });
    await relations.getByRole('button', { name: '새 차단 대상 업무', exact: true }).click();
    await project.selectOption(targetProject.id);
    await title.fill(secondTitle);
    const next = postResult();
    await submit.click();
    const second = await json<IssueBlockedCreationResult>(await next, 201);
    expect(second.issue).toMatchObject({ projectId: targetProject.id, title: secondTitle, startDate: null, endDate: null });
    await expect(modal).toHaveCount(0);
    await expect(description).toHaveValue('저장하지 않은 원인 업무 설명');
    await expect(comment).toHaveValue('아직 게시하지 않은 댓글');
    await expect(relations).toContainText(second.issue.key);
    const saved = await json<IssueRelation[]>(await request.get(`/api/issues/${source.id}/relations`));
    expect(saved.map(item => item.targetIssueId).sort()).toEqual([created.issue.id, second.issue.id].sort());
  } finally {
    const snapshot = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    for (const issue of snapshot.issues.filter(item => item.title.startsWith(prefix))) {
      const deleted = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`, { headers });
      if (!deleted.ok()) continue;
      const { trashEntryId } = await deleted.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
});
