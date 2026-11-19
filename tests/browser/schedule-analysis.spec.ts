import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Dependency, Issue, Project, WorkspaceSnapshot } from '../../shared/types';

function addDays(date: string, offset: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function nextMonday() {
  const today = new Date();
  return addDays(today.toISOString().slice(0, 10), (8 - today.getUTCDay()) % 7 || 7);
}

async function createIssue(request: APIRequestContext, projectId: string, title: string, startDate: string | null, endDate: string | null) {
  const response = await request.post('/api/issues', { data: { projectId, title, startDate, endDate } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as Issue;
}

async function savedIssues(request: APIRequestContext, projectId: string) {
  const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  return snapshot.issues.filter(issue => issue.projectId === projectId);
}

test('360px 간트에서 프로젝트 일정 여유와 주공정을 읽고 날짜를 저장하면 분석이 갱신된다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const key = `SLK${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const projectResponse = await request.post('/api/projects', { data: { key, name: `일정 여유 ${key}` } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = await projectResponse.json() as Project;
  const monday = nextMonday(), tuesday = addDays(monday, 1), wednesday = addDays(monday, 2);
  const thursday = addDays(monday, 3), friday = addDays(monday, 4);
  const issues: Issue[] = [];
  try {
    for (const [title, end] of [['배포 선행 작업', tuesday], ['배포 후속 작업', tuesday], ['독립 검토 업무', monday], ['종료 날짜 미정 업무', null]] as const) {
      issues.push(await createIssue(request, project.id, title, monday, end));
    }
    const [predecessor, successor, separate, incomplete] = issues;
    const linked = await request.post('/api/dependencies', { data: { predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 0 } });
    expect(linked.status(), await linked.text()).toBe(201);
    const link = await linked.json() as Dependency;
    const before = await savedIssues(request, project.id);
    const mutations: string[] = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/') && ['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method())) mutations.push(`${req.method()} ${path}`);
    });

    await page.goto(`/#/${project.id}/gantt`);
    const toggle = page.getByRole('button', { name: '일정 여유 분석', exact: true });
    const panel = page.getByRole('region', { name: '일정 여유 분석', exact: true });
    await expect(toggle).toBeVisible({ timeout: 24_000 });
    await expect(panel).toHaveCount(0);
    await toggle.click();
    await expect(panel).toBeVisible();
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);
    const finish = panel.getByText('예상 완료일', { exact: true }).locator('..').locator('time');
    const task = (id: string) => panel.locator(`[data-analysis-issue-id="${id}"]`);
    const bar = (issue: Issue) => page.getByRole('button', { name: `${issue.key} 일정 이동`, exact: true });
    const connector = page.locator(`path[data-dependency-id="${link.id}"]`);

    await expect(finish).toHaveAttribute('datetime', thursday);
    await expect(task(predecessor.id)).toContainText('여유 0근무일');
    await expect(task(successor.id)).toContainText('여유 0근무일');
    await expect(task(separate.id)).toContainText('여유 3근무일');
    await expect(panel.getByRole('status')).toContainText('분석할 수 있는 업무의 예상 완료일');
    await expect(panel.getByText('분석에서 제외된 업무', { exact: true })).toBeVisible();
    await expect(panel.getByText(incomplete.title, { exact: true })).toBeVisible();
    await expect(bar(predecessor)).toHaveAttribute('data-analysis-critical', 'true');
    await expect(bar(successor)).toHaveAttribute('data-analysis-critical', 'true');
    await expect(bar(separate)).not.toHaveAttribute('data-analysis-critical', 'true');
    await expect(connector).toHaveAttribute('data-analysis-critical', 'true');

    const search = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    await search.fill(separate.title);
    await expect(bar(predecessor)).toHaveCount(0);
    await expect(connector).toHaveCount(0);
    await expect(task(successor.id)).toContainText('여유 0근무일');
    await expect(finish).toHaveAttribute('datetime', thursday);
    await search.fill('');
    expect(await savedIssues(request, project.id)).toEqual(before);
    expect(mutations).toEqual([]);

    const endDate = page.getByLabel(`${successor.key} 종료일`, { exact: true });
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/apply' && response.request().method() === 'POST');
    await endDate.fill(wednesday);
    await endDate.press('Enter');
    const saved = await saving;
    expect(saved.ok(), await saved.text()).toBeTruthy();
    await expect(finish).toHaveAttribute('datetime', friday);
    await expect(task(separate.id)).toContainText('여유 4근무일');
    await expect(bar(successor)).toHaveAttribute('data-analysis-critical', 'true');

    await panel.getByRole('button', { name: '일정 여유 분석 닫기', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(bar(predecessor)).not.toHaveAttribute('data-analysis-critical', 'true');
    await expect(connector).not.toHaveAttribute('data-analysis-critical', 'true');
    expect(mutations).toEqual(['POST /api/schedule/apply']);
    const after = await savedIssues(request, project.id);
    expect(after.find(issue => issue.id === successor.id)).toMatchObject({ startDate: monday, endDate: wednesday, version: successor.version + 1 });
    expect(after.filter(issue => issue.id !== successor.id)).toEqual(before.filter(issue => issue.id !== successor.id));
  } finally {
    for (const issue of issues.reverse()) await request.delete(`/api/issues/${issue.id}`);
  }
});
