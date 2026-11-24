import { expect, type Locator, type Page } from '@playwright/test';
import type { SchedulePasteApplyResult, SchedulePastePreview, ScheduleRowEditInput } from '../../shared/types';

export const linkPreviewPath = '/api/schedule/row-edit/preview';
export const linkApplyPath = '/api/schedule/row-edit/apply';

export async function reviewGanttLink(page: Page, dialog: Locator) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === linkPreviewPath && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '연결 미리보기', exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(200);
  return { preview: await response.json() as SchedulePastePreview, input: response.request().postDataJSON() as ScheduleRowEditInput };
}

export async function applyGanttLink(page: Page, dialog: Locator) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === linkApplyPath && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '검토한 연결 적용', exact: true }).click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as SchedulePasteApplyResult;
}
