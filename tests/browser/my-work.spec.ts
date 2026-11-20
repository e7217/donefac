import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 }, timezoneId: 'Asia/Seoul' });

test('내 업무에서 프로젝트를 넘어 담당과 협력 업무의 기한을 확인하고 원래 티켓을 연다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const prefix = `내 업무 검사 ${randomUUID()}`;
  const response = await request.get('/api/workspace');
  expect(response.ok()).toBeTruthy();
  const { projects: [projectA, projectB], users: [actor, otherActor] } = await response.json() as WorkspaceSnapshot;
  expect(projectB).toBeDefined();
  expect(otherActor).toBeDefined();

  async function create(label: string, data: Partial<Issue>) {
    const created = await request.post('/api/issues', { data: { title: `${prefix} ${label}`, ...data } });
    expect(created.status()).toBe(201);
    return created.json() as Promise<Issue>;
  }

  const section = (name: string) => page.getByRole('region', { name, exact: true });
  const row = (issue: Issue) => page.getByRole('button', { name: new RegExp(`\\b${issue.key}\\b`) });

  try {
    const priorityDate = await create('별도 목표 마감일', {
      projectId: projectA.id, assigneeId: actor.id, collaboratorIds: [actor.id],
      status: 'in_progress', dueDate: '2026-07-16', endDate: '2026-07-22',
    });
    const older = await create('먼저 초과한 업무', {
      projectId: projectB.id, assigneeId: actor.id, dueDate: '2026-07-15',
    });
    const today = await create('계획 종료일이 오늘인 협력 업무', {
      projectId: projectB.id, assigneeId: otherActor.id, collaboratorIds: [actor.id],
      status: 'review', endDate: '2026-07-17',
    });
    const soon = await create('곧 마감할 업무', {
      projectId: projectA.id, assigneeId: actor.id, dueDate: '2026-07-23',
    });
    const later = await create('나중에 마감할 업무', {
      projectId: projectB.id, assigneeId: actor.id, dueDate: '2026-07-26',
    });
    const noDate = await create('기한이 없는 업무', {
      projectId: projectB.id, collaboratorIds: [actor.id],
    });
    const done = await create('기한을 지난 완료 업무', {
      projectId: projectA.id, assigneeId: actor.id, status: 'done', dueDate: '2026-07-15',
    });
    const cancelled = await create('취소한 협력 업무', {
      projectId: projectB.id, collaboratorIds: [actor.id], status: 'cancelled', dueDate: '2026-07-17',
    });
    const other = await create('다른 작업자의 업무', {
      projectId: projectA.id, assigneeId: otherActor.id, dueDate: '2026-07-17',
    });

    // Seoul is already on July 17 while UTC is on July 16.
    await page.clock.setFixedTime(new Date('2026-07-16T16:00:00Z'));
    await page.goto(`/#/${projectA.id}/mywork`);
    await expect(page.getByRole('heading', { name: '내 업무', exact: true })).toBeVisible({ timeout: 20_000 });
    const actorPicker = page.getByLabel('작업자 선택', { exact: true });
    await actorPicker.selectOption(actor.id);
    const project = page.getByRole('combobox', { name: '프로젝트', exact: true });
    const scope = page.getByRole('combobox', { name: '참여 범위', exact: true });
    const grouping = page.getByRole('combobox', { name: '묶는 기준', exact: true });
    const includeTerminal = page.getByRole('checkbox', { name: '완료·취소 포함', exact: true });
    const allProjects = await project.inputValue();

    const overdue = section('마감 초과');
    const overdueRows = overdue.getByRole('button').filter({ hasText: prefix });
    await expect(overdueRows).toHaveCount(2);
    await expect(overdueRows.nth(0)).toContainText(older.title);
    await expect(overdueRows.nth(1)).toContainText(priorityDate.title);
    await expect(row(priorityDate)).toContainText('목표 마감일');
    const bounds = await row(priorityDate).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await expect(row(priorityDate)).toContainText(projectA.name);
    await expect(row(priorityDate)).toContainText('진행 중');
    await expect(row(priorityDate)).toContainText('담당');
    await expect(section('오늘 마감').getByRole('button').filter({ hasText: today.title })).toBeVisible();
    await expect(row(today)).toContainText('계획 종료일');
    await expect(row(today)).toContainText(projectB.name);
    await expect(row(today)).toContainText('협력');
    await expect(section('7일 이내').getByRole('button').filter({ hasText: soon.title })).toBeVisible();
    await expect(section('이후').getByRole('button').filter({ hasText: later.title })).toBeVisible();
    await expect(section('기한 없음').getByRole('button').filter({ hasText: noDate.title })).toBeVisible();
    for (const hidden of [done, cancelled, other]) await expect(row(hidden)).toHaveCount(0);

    await includeTerminal.check();
    await expect(section('완료·취소').getByRole('button').filter({ hasText: prefix })).toHaveCount(2);
    await grouping.selectOption({ label: '상태 기준' });
    await expect(section('검토').getByRole('button').filter({ hasText: today.title })).toBeVisible();
    await expect(section('취소').getByRole('button').filter({ hasText: cancelled.title })).toBeVisible();
    await grouping.selectOption({ label: '마감 기준' });
    await includeTerminal.uncheck();

    await scope.selectOption({ label: '담당 업무' });
    await expect(row(priorityDate)).toHaveCount(1);
    await expect(row(today)).toHaveCount(0);
    await scope.selectOption({ label: '협력 업무' });
    await expect(row(priorityDate)).toHaveCount(0);
    await expect(row(today)).toBeVisible();
    await project.selectOption(projectB.id);
    await row(today).click();
    const dialog = page.getByRole('dialog', { name: today.title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === `#/${projectB.id}/mywork?issue=${today.id}`);
    await dialog.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(project).toHaveValue(projectB.id);
    await expect(scope.locator('option:checked')).toHaveText('협력 업무');
    await expect(row(today)).toBeVisible();

    await actorPicker.selectOption(otherActor.id);
    await expect(project).toHaveValue(allProjects);
    await expect(scope.locator('option:checked')).toHaveText('담당·협력 업무');
    await expect(row(other)).toBeVisible();
    await expect(row(today)).toBeVisible();
    await expect(row(priorityDate)).toHaveCount(0);
  } finally {
    const latest = await request.get('/api/workspace');
    if (latest.ok()) {
      const { issues } = await latest.json() as WorkspaceSnapshot;
      for (const issue of issues.filter(issue => issue.title.startsWith(prefix))) {
        const removed = await request.delete(`/api/issues/${issue.id}`);
        expect(removed.ok()).toBeTruthy();
      }
    }
  }
});
