import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DocPage, DocumentPublicationView, RichContent, User, WorkspaceSnapshot } from '../../shared/types';

const body = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const viewport = { width: 360, height: 820 };
const dialogFor = (page: Page) => page.getByRole('dialog', { name: '문서 검토·발행', exact: true });
const inboxFor = (page: Page) => page.getByRole('button', { name: '검토함·발행본', exact: true });
const libraryFor = (page: Page) => page.getByRole('region', { name: '문서 검토·발행 목록' });

test('360px에서 여러 검토자가 최신 초안과 별개인 저장본에 판단을 남기고 모두 승인한 뒤 발행본을 연다', async ({ browser, page, request }) => {
  test.setTimeout(75_000);
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const [author, first, second] = workspace.users;
  const project = workspace.projects[0];
  const title = `합성 팀 검토 ${randomUUID().slice(0, 8)}`;
  const pinned = '여러 사람이 검토할 고정 원문';
  const draft = '검토 중에 저장한 다음 초안의 본문';
  const create = await request.post('/api/documents', { headers: { 'X-Actor-Id': author.id }, data: { projectId: project.id, title, content: body(pinned) } });
  expect(create.status(), await create.text()).toBe(201);
  const document = await create.json() as DocPage;
  const location = `/#/${project.id}/documents/${document.id}`;
  const endpoint = `/api/documents/${document.id}/publication`;
  const submission = (page: Page) => page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'POST');
  let firstPage: Page | undefined;

  async function openAssigned(target: Page, reviewer: User) {
    await target.getByLabel('작업자 선택', { exact: true }).selectOption(reviewer.id);
    await inboxFor(target).click();
    await libraryFor(target).getByRole('button', { name: `${title} 검토본 열기`, exact: true }).click();
    const dialog = dialogFor(target);
    const content = dialog.getByRole('region', { name: '검토 고정본 내용' });
    await expect(content).toContainText(pinned);
    await expect(content).not.toContainText(draft);
    return dialog;
  }

  try {
    await page.setViewportSize(viewport);
    await page.goto(location);
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(author.id);
    await page.getByRole('button', { name: '검토·발행', exact: true }).click();
    const authorDialog = dialogFor(page);
    const bounds = await authorDialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    await authorDialog.getByLabel('검토자', { exact: true }).selectOption(first.id);
    await authorDialog.getByRole('button', { name: '검토자 추가', exact: true }).click();
    const extra = authorDialog.getByLabel('추가 검토자 1', { exact: true });
    await expect(extra).toBeFocused();
    await expect(extra.locator(`option[value="${first.id}"]`)).toHaveJSProperty('disabled', true);
    await extra.selectOption(second.id);
    const requestedResponse = submission(page);
    await authorDialog.getByRole('button', { name: '검토 요청 보내기', exact: true }).click();
    const requested = await requestedResponse;
    expect(requested.status(), await requested.text()).toBe(200);
    const group = await requested.json() as DocumentPublicationView;
    expect(group.review!.reviewers).toEqual([first.id, second.id].map(reviewerId => ({ reviewerId, approval: null })));
    await expect(authorDialog.getByText('승인 0/2', { exact: true })).toBeVisible();
    await authorDialog.getByRole('button', { name: '검토·발행 닫기', exact: true }).click();

    const edited = await request.patch(`/api/documents/${document.id}`, { data: {
      expectedVersion: document.version, title: `${title} 별도 초안`, contentSchemaVersion: 4, content: body(draft),
    } });
    expect(edited.status(), await edited.text()).toBe(200);

    firstPage = await browser.newPage({ baseURL: new URL(page.url()).origin, viewport });
    await firstPage.goto(location);
    const firstDialog = await openAssigned(firstPage, first);
    const secondDialog = await openAssigned(page, second);
    const firstNote = '먼저 승인한 팀원의 메모';
    const secondNote = '다른 화면의 승인 뒤에도 유지할 메모';
    await firstDialog.getByLabel('검토 결과 메모', { exact: true }).fill(firstNote);
    const secondMemo = secondDialog.getByLabel('검토 결과 메모', { exact: true });
    await secondMemo.fill(secondNote);
    const firstResponse = submission(firstPage);
    await firstDialog.getByRole('button', { name: '승인', exact: true }).click();
    const partial = await firstResponse;
    expect(partial.status(), await partial.text()).toBe(200);
    const firstResult = await partial.json() as DocumentPublicationView;
    expect(firstResult.published).toBeNull();
    await expect(firstDialog.getByText('승인 1/2', { exact: true })).toBeVisible();
    await expect(firstDialog.getByRole('list', { name: '검토자별 상태', exact: true })).toContainText(firstNote);
    await expect(firstDialog.getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
    await firstDialog.getByRole('button', { name: '검토·발행 닫기', exact: true }).click();
    await inboxFor(firstPage).click();
    await expect(libraryFor(firstPage).getByRole('button', { name: `${title} 검토본 열기`, exact: true })).toHaveCount(0);

    const approve = secondDialog.getByRole('button', { name: '승인', exact: true });
    const conflictResponse = submission(page);
    await approve.click();
    const conflict = await conflictResponse;
    expect(conflict.status(), await conflict.text()).toBe(409);
    await expect(secondMemo).toHaveValue(secondNote);
    await expect(approve).toBeDisabled();
    await secondDialog.getByRole('button', { name: '검토·발행 최신 정보', exact: true }).click();
    await expect(secondDialog.getByRole('list', { name: '검토자별 상태', exact: true })).toContainText(firstNote);
    await expect(secondMemo).toHaveValue(secondNote);
    await expect(approve).toBeEnabled();

    const finalResponse = submission(page);
    await approve.click();
    const completed = await finalResponse;
    expect(completed.status(), await completed.text()).toBe(200);
    const released = await completed.json() as DocumentPublicationView;
    expect(released.review).toBeNull();
    expect(released.published).toMatchObject({ revisionId: group.review!.revisionId, publishedById: second.id, approvals: [
      { byId: first.id, note: firstNote }, { byId: second.id, note: secondNote },
    ] });
    const evidence = secondDialog.getByRole('list', { name: '승인 기록', exact: true });
    await expect(evidence).toContainText(firstNote);
    await expect(evidence).toContainText(secondNote);
    const frozen = secondDialog.getByRole('region', { name: '발행 고정본 내용' });
    await expect(frozen).toContainText(pinned);
    await expect(frozen).not.toContainText(draft);
    await secondDialog.getByRole('button', { name: '검토·발행 닫기', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(`${title} 별도 초안`);
  } finally {
    await firstPage?.close();
    await request.delete(`/api/documents/${document.id}`, { headers: { 'X-Actor-Id': author.id } });
  }
});
