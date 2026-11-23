import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIResponse, type Response } from '@playwright/test';
import type { DocPage, Issue, Project, ProjectWorkflow, SavedView } from '../../shared/types';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

test('360px에서 여러 상태를 고른 공유 보기로 목록·보드·간트·문서를 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const name = `이번 주 진행 상태 ${suffix}`;
  const project = await json<Project>(await request.post('/api/projects', { data: { key: `MV${suffix}`, name } }), 201);
  const workflow = await json<ProjectWorkflow>(await request.get(`/api/projects/${project.id}/workflow`));
  const states = new Map(workflow.statuses.map(status => [status.id, status.label]));
  const chosen = ['in_progress', 'review'];
  const labels = chosen.map(id => states.get(id)!);
  expect(labels.every(Boolean)).toBe(true);
  const issues: Issue[] = [];
  let view: SavedView | undefined;
  let doc: DocPage | undefined;

  try {
    for (const status of [...chosen, 'todo', 'done']) {
      issues.push(await json<Issue>(await request.post('/api/issues', { data: {
        projectId: project.id, status, title: `${states.get(status)} 업무 ${suffix}`, startDate: '2026-12-01', endDate: '2026-12-03',
      } }), 201));
    }
    const [inProgress, review, waiting, done] = issues;
    const included = [inProgress, review];
    const excluded = [waiting, done];
    const issuePath = `#/${project.id}/issues`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/${issuePath}`);
    const chooser = page.getByRole('button', { name: '여러 상태 선택', exact: true });
    await chooser.click();
    const options = page.getByRole('group', { name: '선택할 상태', exact: true });
    for (const label of labels) await options.getByRole('checkbox', { name: label, exact: true }).check();
    await chooser.click();

    const list = page.locator('.issue-table');
    for (const issue of included) await expect(list.getByText(issue.title, { exact: true })).toBeVisible();
    for (const issue of excluded) await expect(list.getByText(issue.title, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    const cards = page.locator('.issue-board-card');
    await expect(cards).toHaveCount(2);
    for (const issue of included) await expect(cards.filter({ hasText: issue.title })).toBeVisible();

    await page.getByRole('button', { name: '현재 보기 저장', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '업무 보기 저장', exact: true });
    for (const label of labels) await expect(dialog).toContainText(label);
    await dialog.getByLabel('보기 이름', { exact: true }).fill(name);
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/views' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    view = await json<SavedView>(await saved, 201);
    expect(view).toMatchObject({ layout: 'board', filters: { status: 'all', statusIds: chosen } });
    const viewId = view.id;
    const picker = page.getByRole('combobox', { name: '저장된 업무 보기', exact: true });
    await expect(picker).toHaveValue(viewId);
    await page.reload();
    await expect(picker).toHaveValue(viewId);
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();

    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const rows = chart.locator('.gantt-row[data-issue-id]');
    await expect(rows).toHaveCount(2);
    for (const issue of included) await expect(chart.locator(`[data-issue-id="${issue.id}"]`)).toBeVisible();
    const summary = page.getByLabel('간트에 적용된 상태 조건', { exact: true });
    for (const label of labels) await expect(summary).toContainText(label);
    const [download] = await Promise.all([
      page.waitForEvent('download'), page.getByRole('button', { name: '간트 HTML 내려받기', exact: true }).click(),
    ]);
    const html = await readFile((await download.path())!, 'utf8');
    for (const label of labels) expect(html).toContain(label);
    expect(html).not.toContain(waiting.title);

    doc = await json<DocPage>(await request.post('/api/documents', { data: {
      projectId: project.id, title: `${name} 보고`, content: { type: 'doc', content: [
        { type: 'issueList', attrs: { projectId: project.id, savedViewId: viewId, label: name } },
      ] },
    } }), 201);
    await page.goto(`/#/${project.id}/documents/${doc.id}`);
    await page.reload();
    const block = page.getByRole('region', { name: '업무 목록', exact: true });
    for (const issue of included) await expect(block).toContainText(issue.title);
    for (const issue of excluded) await expect(block).not.toContainText(issue.title);
    await json<Issue>(await request.patch(`/api/issues/${waiting.id}`, { data: { expectedVersion: waiting.version, status: 'in_progress' } }));
    await page.getByRole('button', { name: '참조 새로고침', exact: true }).click();
    await expect(block).toContainText(waiting.title);
    await expect(block).not.toContainText(done.title);

    await page.goto(`/${issuePath}?savedView=${viewId}`);
    await expect(cards).toHaveCount(3);
    await page.getByRole('combobox', { name: '상태 필터', exact: true }).selectOption('all');
    await expect(cards).toHaveCount(4);
    await page.getByRole('button', { name: '보기 수정', exact: true }).click();
    const update = page.getByRole('dialog', { name: '저장된 보기 수정', exact: true });
    const patched = page.waitForResponse(response => new URL(response.url()).pathname === `/api/views/${viewId}` && response.request().method() === 'PATCH');
    await update.getByRole('button', { name: '저장', exact: true }).click();
    view = await json<SavedView>(await patched);
    expect(view.filters.status).toBe('all');
    expect(view.filters).not.toHaveProperty('statusIds');
    await page.reload();
    await expect(cards).toHaveCount(4);
  } finally {
    if (view) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    const targets = issues.map(issue => `/api/issues/${issue.id}`);
    if (doc) targets.push(`/api/documents/${doc.id}`);
    for (const path of targets) {
      const response = await request.delete(path);
      if (response.ok()) {
        const { trashEntryId } = await response.json() as { trashEntryId?: string };
        if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
  }
});
