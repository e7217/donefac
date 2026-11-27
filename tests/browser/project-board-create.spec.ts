import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { Issue, Project, ProjectWorkflow, WorkspaceSnapshot } from '../../shared/types';

test.use({ hasTouch: true, viewport: { width: 360, height: 820 } });

async function read<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

test('보드 칸에서 해당 상태와 담당자를 기본값으로 새 업무를 만든다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const { users: [actor, assignee] } = await read<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const tag = randomUUID().slice(0, 7);
  const project = await read<Project>(await request.post('/api/projects', {
    headers, data: { key: `B${tag.toUpperCase()}`, name: `업무 보드 ${tag}` },
  }), 201);
  const workflow = await read<ProjectWorkflow>(await request.get(`/api/projects/${project.id}/workflow`, { headers }));
  const status = workflow.statuses.find(value => value.id === 'in_progress')!;
  const issues: Issue[] = [];

  try {
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/issues`);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    const board = page.getByRole('region', { name: '업무 보드', exact: true });
    const standardCreate = board.getByRole('button', { name: `${status.label} 업무 추가`, exact: true });
    await standardCreate.click();
    const form = page.getByRole('dialog', { name: '새 업무 만들기', exact: true });
    await expect(form.getByRole('combobox', { name: '새 업무 상태', exact: true })).toHaveValue(status.id);
    await expect(form.getByRole('combobox', { name: '담당자', exact: true })).toHaveValue('');
    await form.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(standardCreate).toBeFocused();

    await page.getByRole('combobox', { name: '보드 그룹', exact: true }).selectOption('assignee');
    await page.getByRole('checkbox', { name: '빈 담당자 그룹 표시', exact: true }).check();
    const lane = page.locator(`[data-board-assignee-id="${assignee.id}"]`);
    const cell = lane.locator(`[data-status-id="${status.id}"]`);
    const laneCreate = cell.getByRole('button', { name: `${assignee.name} · ${status.label} 업무 추가`, exact: true });
    await laneCreate.click();
    await expect(form.getByRole('combobox', { name: '새 업무 상태', exact: true })).toHaveValue(status.id);
    await expect(form.getByRole('combobox', { name: '담당자', exact: true })).toHaveValue(assignee.id);
    await expect(form.getByRole('combobox', { name: '프로젝트', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    await expect(laneCreate).toBeFocused();
    await laneCreate.click();
    const title = `보드에서 만든 업무 ${tag}`;
    await form.getByRole('textbox', { name: '업무 제목', exact: true }).fill(title);
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/issues' && response.request().method() === 'POST');
    await form.getByRole('button', { name: '업무 만들기', exact: true }).click();
    const issue = await read<Issue>(await created, 201);
    issues.push(issue);
    expect(issue).toMatchObject({ title, projectId: project.id, status: status.id, assigneeId: assignee.id });
    const details = page.getByRole('dialog', { name: title, exact: true });
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(cell.locator(`.issue-board-card[data-issue-id="${issue.id}"]`)).toBeVisible();

    await page.locator('.issue-heading-actions').getByRole('button', { name: '업무 만들기', exact: true }).click();
    await expect(form.getByRole('combobox', { name: '새 업무 상태', exact: true })).toHaveValue(workflow.initialStatusId);
    await expect(form.getByRole('combobox', { name: '담당자', exact: true })).toHaveValue('');
    await expect(form.getByRole('combobox', { name: '프로젝트', exact: true })).toBeEnabled();
  } finally {
    for (const issue of issues) {
      const deleted = await request.delete(`/api/issues/${issue.id}`, { headers });
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    }
    await request.delete(`/api/projects/${project.id}`, { headers });
  }
});
