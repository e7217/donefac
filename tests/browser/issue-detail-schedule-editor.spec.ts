import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { Issue, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot } from '../../shared/types';

const original = { startDate: '2027-03-10', endDate: '2027-03-12', dueDate: '2027-03-15' };
const edited = { startDate: '2027-03-09', endDate: '2027-03-16', dueDate: original.dueDate };
const previewPath = '/api/schedule/row-edit/preview';
const applyPath = '/api/schedule/row-edit/apply';
const undoPath = '/api/schedule/undo';
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });
const field = (within: Locator, name: string) => within.getByLabel(name, { exact: true });
const issuePath = (issue: Issue) => `/api/issues/${issue.id}`;

async function json<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, expected = 200) {
  expect(response.status(), await response.text()).toBe(expected);
  return await response.json() as T;
}

const workspace = async (request: APIRequestContext) => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
const waitPost = (page: Page, path: string) => page.waitForResponse(response =>
  new URL(response.url()).pathname === path && response.request().method() === 'POST');

async function createFixture(request: APIRequestContext) {
  const { projects: [project], users: [actor, peer] } = await workspace(request);
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 8);
  const created: Issue[] = [];
  async function issue(title: string, dates: Partial<typeof original>) {
    const saved = await json<Issue>(await request.post('/api/issues', {
      headers, data: { title: `${title} ${suffix}`, projectId: project.id, ...dates },
    }), 201);
    created.push(saved);
    return saved;
  }
  return {
    project, actor, peer, issue,
    async close() {
      for (const saved of created.reverse()) {
        const removed = await request.delete(issuePath(saved), { headers });
        if (!removed.ok()) continue;
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`, { headers });
      }
    },
  };
}

async function openBoardTicket(page: Page, anchor: Issue, related: Issue, actorId: string) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actorId);
  const query = new URLSearchParams({ boardQuery: anchor.title });
  await page.goto(`/#/${anchor.projectId}/teamboard?${query}`);
  const board = page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
  const opener = button(board, `${anchor.key} 업무 열기`);
  await expect(opener).toBeVisible({ timeout: 35_000 });
  await expect(button(board, `${related.key} 업무 열기`)).toHaveCount(0);
  await opener.click();
  const details = page.getByRole('dialog', { name: anchor.title, exact: true });
  await expect(details).toBeVisible();
  const scheduleButton = button(details, '일정과 연결 편집');
  const editor = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
  return { details, scheduleButton, editor, location: page.url() };
}

async function choosePredecessor(editor: Locator, related: Issue) {
  const change = editor.getByRole('group', { name: '연결 변경 1', exact: true });
  await field(change, '선후행 연결 작업').selectOption('add');
  await field(change, '연결할 업무 검색').fill(related.key);
  await button(change, `${related.key} · ${related.title}`).click();
  await field(change, '연결 유형').selectOption('SS');
  await field(change, '간격 (근무일)').fill('1');
  return change;
}

function confirmNext(page: Page, accept: boolean) {
  return page.waitForEvent('dialog').then(async dialog => {
    const message = dialog.message();
    if (accept) await dialog.accept();
    else await dialog.dismiss();
    return message;
  });
}

async function readSchedule(request: APIRequestContext, anchor: Issue) {
  const { issues, dependencies } = await workspace(request);
  return {
    issue: issues.find(item => item.id === anchor.id),
    links: dependencies.filter(link => link.predecessorId === anchor.id || link.successorId === anchor.id),
  };
}

test('360px 보드 티켓에서 작성 중인 날짜와 선행 연결을 함께 저장하고 다른 초안을 보존한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const fixture = await createFixture(request);
  try {
    const anchor = await fixture.issue('검토할 업무 일정', original);
    const related = await fixture.issue('보드 조건에 가려진 선행 업무', { startDate: '2027-03-05', endDate: '2027-03-08' });
    const { details, scheduleButton, editor, location } = await openBoardTicket(page, anchor, related, fixture.actor.id);
    const draftTitle = `${anchor.title} 초안`;
    const comment = '일정을 검토하는 동안 작성 중인 댓글';
    await field(details, '제목').fill(draftTitle);
    await field(details, '댓글 내용').fill(comment);
    await field(details, '시작일').fill(edited.startDate);
    await scheduleButton.click();
    await expect(editor).toBeVisible();
    await expect(field(editor, '시작일')).toHaveValue(edited.startDate);
    await expect(field(editor, '종료일')).toHaveValue(original.endDate);
    await field(editor, '종료일').fill(edited.endDate);
    const change = await choosePredecessor(editor, related);

    const keepDraft = confirmNext(page, false);
    await field(editor, '종료일').press('Escape');
    expect(await keepDraft).toContain('버리');
    await expect(editor).toBeVisible();
    await expect(field(editor, '종료일')).toHaveValue(edited.endDate);
    await expect(change.getByText(`${related.key} · ${related.title}`, { exact: true })).toBeVisible();
    expect(page.url()).toBe(location);

    const discardEditor = confirmNext(page, true);
    await button(editor, '닫기').click();
    expect(await discardEditor).toContain('버리');
    await expect(editor).toHaveCount(0);
    await expect(scheduleButton).toBeFocused();
    await expect(field(details, '시작일')).toHaveValue(edited.startDate);
    await expect(field(details, '종료일')).toHaveValue(original.endDate);
    await expect(field(details, '제목')).toHaveValue(draftTitle);
    await expect(field(details, '댓글 내용')).toHaveValue(comment);
    expect(await readSchedule(request, anchor)).toMatchObject({ issue: anchor, links: [] });

    await scheduleButton.click();
    await expect(field(editor, '시작일')).toHaveValue(edited.startDate);
    await field(editor, '종료일').fill(edited.endDate);
    await choosePredecessor(editor, related);
    const preview = waitPost(page, previewPath);
    await button(editor, '변경 미리보기').click();
    expect(await json<SchedulePastePreview>(await preview)).toMatchObject({
      errors: [],
      changes: [{ id: anchor.id, fromStart: original.startDate, toStart: edited.startDate, fromEnd: original.endDate, toEnd: edited.endDate }],
      dependencyChanges: [{ predecessorKey: related.key, successorKey: anchor.key, before: null, after: { type: 'SS', lagDays: 1 } }],
    });
    expect(await readSchedule(request, anchor)).toMatchObject({ issue: anchor, links: [] });

    const apply = waitPost(page, applyPath);
    await button(editor, '일정과 연결 적용').click();
    expect(await json<SchedulePasteApplyResult>(await apply)).toMatchObject({
      updated: [{ id: anchor.id, title: anchor.title, version: anchor.version + 1, ...edited }],
      dependencyChanges: 1,
    });
    await expect(editor).toHaveCount(0);
    await expect(scheduleButton).toBeFocused();
    expect(page.url()).toBe(location);
    await expect(field(details, '시작일')).toHaveValue(edited.startDate);
    await expect(field(details, '종료일')).toHaveValue(edited.endDate);
    await expect(field(details, '제목')).toHaveValue(draftTitle);
    await expect(field(details, '댓글 내용')).toHaveValue(comment);
    const dependencies = details.getByRole('region', { name: '업무 의존성', exact: true });
    await expect(dependencies.locator(`[data-related-schedule-issue="${related.id}"]`)).toContainText('선행');
    expect(await readSchedule(request, anchor)).toMatchObject({
      issue: { ...edited, title: anchor.title },
      links: [{ predecessorId: related.id, successorId: anchor.id, type: 'SS', lagDays: 1 }],
    });

    const titleSave = page.waitForResponse(response => new URL(response.url()).pathname === issuePath(anchor) && response.request().method() === 'PATCH');
    await button(details, '변경사항 저장').click();
    expect(await json<Issue>(await titleSave)).toMatchObject({ ...edited, title: draftTitle, version: anchor.version + 2 });
    const updatedDetails = page.getByRole('dialog', { name: draftTitle, exact: true });
    await expect(field(updatedDetails, '댓글 내용')).toHaveValue(comment);
  } finally {
    await fixture.close();
  }
});

test('티켓 상세 일정 미리보기 뒤 다른 작성자가 저장하면 날짜와 연결이 함께 보류된다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const fixture = await createFixture(request);
  try {
    const anchor = await fixture.issue('동시 일정 변경 기준 업무', original);
    const related = await fixture.issue('동시 일정 변경 선행 업무', { startDate: '2027-03-05', endDate: '2027-03-08' });
    const { details, scheduleButton, editor, location } = await openBoardTicket(page, anchor, related, fixture.actor.id);
    await field(details, '시작일').fill(edited.startDate);
    await field(details, '댓글 내용').fill('동시 저장을 검토하는 동안 작성 중');
    await scheduleButton.click();
    await field(editor, '종료일').fill(edited.endDate);
    const change = await choosePredecessor(editor, related);
    await button(editor, '변경 미리보기').click();
    await expect(button(editor, '일정과 연결 적용')).toBeEnabled();

    const remote = await json<Issue>(await request.patch(issuePath(anchor), {
      headers: { 'X-Actor-Id': fixture.peer.id },
      data: { expectedVersion: anchor.version, description: '다른 작업자가 먼저 저장한 설명' },
    }));
    const rejected = waitPost(page, applyPath);
    await button(editor, '일정과 연결 적용').click();
    expect((await rejected).status()).toBe(409);
    await expect(editor.getByRole('alert')).toContainText('날짜와 연결 입력을 유지했습니다');
    await expect(field(editor, '시작일')).toHaveValue(edited.startDate);
    await expect(field(editor, '종료일')).toHaveValue(edited.endDate);
    await expect(change.getByText(`${related.key} · ${related.title}`, { exact: true })).toBeVisible();
    await expect(button(editor, '일정과 연결 적용')).toBeDisabled();
    expect(await readSchedule(request, anchor)).toMatchObject({
      issue: { ...original, description: remote.description, version: remote.version },
      links: [],
    });

    const stay = confirmNext(page, false);
    await page.goBack();
    expect(await stay).toContain('버리');
    await expect.poll(() => page.url()).toBe(location);
    await expect(editor).toBeVisible();
    await expect(field(editor, '종료일')).toHaveValue(edited.endDate);

    const discardEditor = confirmNext(page, true);
    await button(editor, '닫기').click();
    expect(await discardEditor).toContain('버리');
    await expect(editor).toHaveCount(0);
    await expect(scheduleButton).toBeFocused();
    await expect(field(details, '시작일')).toHaveValue(edited.startDate);
    await expect(field(details, '종료일')).toHaveValue(original.endDate);
    await expect(field(details, '댓글 내용')).toHaveValue('동시 저장을 검토하는 동안 작성 중');
  } finally {
    await fixture.close();
  }
});

test('티켓 상세에서 일정과 연결을 되돌리며 이후 날짜·제목·댓글 초안을 보존한다', async ({ page, request }) => {
  test.setTimeout(80_000);
  const fixture = await createFixture(request);
  try {
    const anchor = await fixture.issue('되돌릴 일정 기준 업무', original);
    const related = await fixture.issue('되돌릴 선행 연결 업무', { startDate: '2027-03-05', endDate: '2027-03-08' });
    const { details, scheduleButton, editor, location } = await openBoardTicket(page, anchor, related, fixture.actor.id);
    await scheduleButton.click();
    await field(editor, '시작일').fill(edited.startDate);
    await field(editor, '종료일').fill(edited.endDate);
    await choosePredecessor(editor, related);
    await button(editor, '변경 미리보기').click();
    const applied = waitPost(page, applyPath);
    await button(editor, '일정과 연결 적용').click();
    const receipt = await json<SchedulePasteApplyResult>(await applied);
    await expect(editor).toHaveCount(0);
    await expect(field(details, '시작일')).toHaveValue(edited.startDate);
    await expect(field(details, '종료일')).toHaveValue(edited.endDate);
    const dependencies = details.getByRole('region', { name: '업무 의존성', exact: true });
    const predecessor = dependencies.locator(`[data-related-schedule-issue="${related.id}"]`);
    await expect(predecessor).toBeVisible();

    const draftStart = '2027-03-11';
    const draftTitle = `${anchor.title} 초안`;
    const draftComment = '일정을 되돌리기 전에 작성 중인 댓글';
    await field(details, '시작일').fill(draftStart);
    await field(details, '제목').fill(draftTitle);
    await field(details, '댓글 내용').fill(draftComment);
    const undoButton = button(details, '일정과 연결 되돌리기');
    const undone = waitPost(page, undoPath);
    await undoButton.click();
    const response = await undone;
    expect(response.request().postDataJSON()).toEqual({ undoId: receipt.undoId });
    expect(await json<Omit<SchedulePasteApplyResult, 'undoId'>>(response)).toMatchObject({
      updated: [{ ...original, id: anchor.id, title: anchor.title, version: anchor.version + 2 }],
      dependencyChanges: 1,
    });
    await expect(undoButton).toHaveCount(0);
    await expect(scheduleButton).toBeFocused();
    await expect(predecessor).toHaveCount(0);
    await expect(field(details, '시작일')).toHaveValue(draftStart);
    await expect(field(details, '종료일')).toHaveValue(original.endDate);
    await expect(field(details, '목표 마감일')).toHaveValue(original.dueDate);
    await expect(field(details, '제목')).toHaveValue(draftTitle);
    await expect(field(details, '댓글 내용')).toHaveValue(draftComment);
    await expect(button(details, '최신 버전 불러오기')).toHaveCount(0);
    expect(page.url()).toBe(location);
    expect(await readSchedule(request, anchor)).toMatchObject({
      issue: { ...original, title: anchor.title, version: anchor.version + 2 },
      links: [],
    });
  } finally {
    await fixture.close();
  }
});
