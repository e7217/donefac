import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createCalendarMath } from '../../shared/calendar';
import { reservationLocalDateTime } from '../../shared/time-reservations';
import type { Issue, IssueBulkEditPreview, ProjectWorkflow, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

function responseAt(page: Page, path: string, method: 'PATCH' | 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

test('360px에서 상태별 자동 목표 마감일을 저장하고 업무 상세와 일괄 미리보기에 반영한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const workspace = (await (await request.get('/api/workspace')).json()) as WorkspaceSnapshot;
  const project = workspace.projects.at(-1)!;
  const workflowPath = `/api/projects/${project.id}/workflow`;
  const original = (await (await request.get(workflowPath)).json()) as ProjectWorkflow;
  const calendar = (await (await request.get(`/api/projects/${project.id}/calendar`)).json()) as WorkCalendar;
  const target = original.statuses.find(status => status.id === 'in_progress')!;
  const days = 3;
  let created: Issue | undefined;
  let changedWorkflow = false;

  try {
    const title = `상태 자동 마감 ${randomUUID().slice(0, 8)}`;
    const made = await request.post('/api/issues', { data: { projectId: project.id, title, status: 'todo' } });
    expect(made.ok(), await made.text()).toBe(true);
    created = (await made.json()) as Issue;
    await page.goto(`/#/${project.id}/settings?section=work`);
    const settings = page.getByRole('region', { name: '프로젝트 워크플로 설정' });
    const setting = settings.getByLabel(`자동 목표 마감일 (근무일) ${target.label}`, { exact: true });
    const saveSetting = settings.getByRole('button', { name: '워크플로 저장', exact: true });
    await expect(setting).toBeEnabled();
    await setting.fill('0');
    await saveSetting.click();
    await expect(settings.getByRole('alert')).toContainText('1~3,650 사이의 정수');
    await setting.fill(String(days));
    const savedSetting = responseAt(page, workflowPath, 'PATCH');
    await saveSetting.click();
    const workflowResponse = await savedSetting;
    expect(workflowResponse.ok(), await workflowResponse.text()).toBe(true);
    changedWorkflow = true;
    expect(((await workflowResponse.json()) as ProjectWorkflow).statuses.find(status => status.id === target.id)?.defaultDueWorkdays).toBe(days);
    await expect(saveSetting).toBeDisabled();
    await page.reload();
    await expect(setting).toHaveValue(String(days));

    const issuePath = `/api/issues/${created.id}`;
    await page.goto(`/#/${project.id}/issues?issue=${created.id}`);
    const panel = page.getByRole('dialog');
    const date = panel.getByLabel('목표 마감일', { exact: true });
    const status = panel.getByLabel('상태', { exact: true });
    const saveIssue = panel.getByRole('button', { name: '변경사항 저장', exact: true });
    await expect(date).toHaveValue('');
    await status.selectOption(target.id);
    const enteredStatus = responseAt(page, issuePath, 'PATCH');
    await saveIssue.click();
    const entered = await enteredStatus;
    expect(entered.request().postDataJSON()).not.toHaveProperty('dueDate');
    expect(entered.ok(), await entered.text()).toBe(true);
    const updated: Issue = await entered.json();
    const expected = createCalendarMath(calendar).shift(reservationLocalDateTime(updated.updatedAt).slice(0, 10), days);
    expect(updated).toMatchObject({ status: target.id, dueDate: expected });
    await expect(date).toHaveValue(expected);

    await status.selectOption('todo');
    await date.fill('');
    const clearedDate = responseAt(page, issuePath, 'PATCH');
    await saveIssue.click();
    const cleared = await clearedDate;
    expect(cleared.request().postDataJSON()).toHaveProperty('dueDate', null);
    expect(cleared.ok(), await cleared.text()).toBe(true);
    expect(await cleared.json()).toMatchObject({ dueDate: null });
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    await page.getByRole('textbox', { name: '업무 검색', exact: true }).fill(title);
    await page.getByRole('button', { name: '일괄 편집', exact: true }).click();
    const editor = page.getByRole('region', { name: '업무 일괄 편집', exact: true });
    await page.getByRole('checkbox', { name: `${created.key} 선택`, exact: true }).check();
    await editor.getByRole('combobox', { name: '일괄 변경 상태', exact: true }).selectOption(target.id);
    await expect(editor.getByRole('combobox', { name: '일괄 변경 마감일', exact: true }).locator('option:checked'))
      .toHaveText('기존 날짜 또는 자동 지정');
    const reviewed = responseAt(page, `/api/projects/${project.id}/issues/bulk-preview`, 'POST');
    await editor.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const reviewResponse = await reviewed;
    expect(reviewResponse.ok(), await reviewResponse.text()).toBe(true);
    const preview: IssueBulkEditPreview = await reviewResponse.json();
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      before: { dueDate: null }, after: { dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    });
    await expect(editor.getByRole('region', { name: '일괄 변경 미리보기', exact: true }))
      .toContainText(`미지정 → ${preview.rows[0].after?.dueDate}`);
  } finally {
    if (created) {
      const archived = await request.delete(`/api/issues/${created.id}`);
      if (archived.ok()) await request.delete(`/api/trash/${(await archived.json()).trashEntryId}`);
    }
    if (changedWorkflow) {
      const latest = (await (await request.get(workflowPath)).json()) as ProjectWorkflow;
      await request.patch(workflowPath, { data: {
        ...original, expectedVersion: latest.version,
        statuses: original.statuses.map(status => ({ ...status, defaultDueWorkdays: status.defaultDueWorkdays ?? null })),
      } });
    }
  }
});
