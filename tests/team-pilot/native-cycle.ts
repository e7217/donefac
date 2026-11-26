import { expect, type APIResponse, type BrowserContext, type Page, type Response } from '@playwright/test';
import { calendarDate, calendarDay } from '../../shared/calendar';
import { cycleCompletionRecordHash } from '../../shared/cycle-completion-address';
import type { CycleCompletionPreview, CycleCompletionResult, Issue, PlanningItem, ProjectWorkflow } from '../../shared/types';

interface CycleFixture {
  projectId: string;
  ownerId: string;
  observerId: string;
  workingDate: string;
}

const timeout = 25_000;

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

function writeResponse(page: Page, pathname: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST', { timeout });
}

export async function verifyNativeCycle(writer: BrowserContext, reader: BrowserContext, origin: string, fixture: CycleFixture) {
  const { projectId, ownerId, observerId, workingDate } = fixture;
  expect(writer).not.toBe(reader);
  expect(ownerId).not.toBe(observerId);
  const workflow = await json<ProjectWorkflow>(await writer.request.get(`/api/projects/${projectId}/workflow`));
  const doneStatus = workflow.statuses.find(status => status.category === 'done');
  if (!doneStatus) throw new Error('The native project needs a completion status.');
  const headers = { Origin: origin, 'X-Actor-Id': ownerId };
  const day = calendarDay(workingDate);
  const createCycle = async (name: string, status: PlanningItem['status'], startDate: string, endDate: string) =>
    json<PlanningItem>(await writer.request.post('/api/planning-items', { headers, data: { projectId, name, kind: 'cycle', status, startDate, endDate } }), 201);
  const cycle = await createCycle('합성 장비 검증 사이클', 'active', calendarDate(day - 7), workingDate);
  const destination = await createCycle('합성 현장 인수인계 사이클', 'planned', calendarDate(day + 1), calendarDate(day + 7));
  const createIssue = async (title: string, status: string, assigneeId: string, startDate: string, endDate: string) =>
    json<Issue>(await writer.request.post('/api/issues', { headers, data: { projectId, cycleId: cycle.id, title, status, assigneeId, startDate, endDate } }), 201);
  const carry = await createIssue('현장 장비 배치표 후속 확인', workflow.initialStatusId, observerId, calendarDate(day + 1), calendarDate(day + 4));
  const done = await createIssue('측정 장비 기초 검증 완료', doneStatus.id, ownerId, workingDate, workingDate);

  const source = await writer.newPage();
  const observer = await reader.newPage();
  try {
    await source.goto(`/#/${projectId}/planning/${cycle.id}`, { waitUntil: 'domcontentloaded', timeout });
    await expect(source.getByLabel('작업자 선택', { exact: true })).toHaveValue(ownerId, { timeout });
    const editor = source.getByRole('region', { name: '사이클 상세', exact: true });
    await expect(editor.getByLabel('계획 상태', { exact: true })).toHaveValue('active', { timeout });
    await editor.getByRole('button', { name: '사이클 완료', exact: true }).click({ timeout });
    const dialog = source.getByRole('dialog', { name: '사이클 완료', exact: true });
    await dialog.getByRole('combobox', { name: '미완료 업무 이동 대상', exact: true }).selectOption({ label: `${destination.name} (계획)` }, { timeout });
    const completePath = `/api/planning-items/${cycle.id}/complete`;
    const [previewResponse] = await Promise.all([
      writeResponse(source, `${completePath}/preview`),
      dialog.getByRole('button', { name: '완료 미리보기', exact: true }).click({ timeout }),
    ]);
    const preview = await json<CycleCompletionPreview>(previewResponse);
    expect(previewResponse.request().postDataJSON()).toEqual({ expectedVersion: cycle.version, destinationId: destination.id });
    expect(preview.counts).toEqual({ carry: 1, done: 1, cancelled: 0, blocked: 0 });
    expect(preview.issues.map(issue => [issue.id, issue.disposition])).toEqual(expect.arrayContaining([[carry.id, 'carry'], [done.id, 'done']]));
    await expect(dialog.getByText(carry.title, { exact: true })).toBeVisible({ timeout });
    await expect(dialog.getByText(done.title, { exact: true })).toBeVisible({ timeout });

    const [applyResponse] = await Promise.all([
      writeResponse(source, completePath),
      dialog.getByRole('button', { name: '사이클 완료 적용', exact: true }).click({ timeout }),
    ]);
    const result = await json<CycleCompletionResult>(applyResponse);
    expect(await applyResponse.request().headerValue('origin')).toBe(origin);
    expect(await applyResponse.request().headerValue('x-actor-id')).toBe(ownerId);
    expect(applyResponse.request().postDataJSON()).toEqual({ previewId: preview.previewId });
    expect(result.cycle).toMatchObject({ id: cycle.id, status: 'completed', version: cycle.version + 1 });
    expect(result.destination?.id).toBe(destination.id);
    if (!result.recordId) throw new Error('Completing the native cycle did not create a record.');

    const retrospectivePath = `/api/projects/${projectId}/cycle-completion-records/${result.recordId}/retrospective`;
    await dialog.getByRole('button', { name: '완료 기록 보기', exact: true }).click({ timeout });
    const record = (page: Page) => page.getByRole('article', { name: '선택한 사이클 완료 기록', exact: true });
    const [created] = await Promise.all([
      writeResponse(source, retrospectivePath),
      record(source).getByRole('button', { name: '회고 문서 만들기', exact: true }).click({ timeout }),
    ]);
    const { id: documentId } = await json<{ id: string }>(created, 201);
    await expect(record(source).getByRole('button', { name: '회고 문서 열기', exact: true })).toBeVisible({ timeout });

    const recordHash = cycleCompletionRecordHash(projectId, result.recordId);
    await observer.goto(`/${recordHash}`, { waitUntil: 'domcontentloaded', timeout });
    await expect(observer.getByLabel('작업자 선택', { exact: true })).toHaveValue(observerId, { timeout });
    await expect(record(observer).getByText(destination.name, { exact: true })).toBeVisible({ timeout });
    await record(observer).getByRole('button', { name: '회고 문서 열기', exact: true }).click({ timeout });
    await expect(observer).toHaveURL(url => url.hash === `#/${projectId}/documents/${documentId}`, { timeout });
    await expect(observer.getByRole('heading', { name: '이월 업무 1건', exact: true })).toBeVisible({ timeout });
    await observer.getByRole('button', { name: `참조 업무 열기 ${carry.key} ${carry.title}`, exact: true }).click({ timeout });
    const ticket = observer.getByRole('dialog', { name: carry.title, exact: true });
    await expect(ticket.getByRole('combobox', { name: '담당자', exact: true })).toHaveValue(observerId, { timeout });
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click({ timeout });
    await observer.getByRole('link', { name: '원래 사이클 완료 기록 열기', exact: true }).click({ timeout });
    const carriedWork = record(observer).getByRole('region', { name: '이월 업무', exact: true });
    await carriedWork.getByRole('button', { name: `${carry.key} 간트에서 일정 열기`, exact: true }).click({ timeout });
    const chart = observer.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.getByLabel(`${carry.key} 시작일`, { exact: true })).toHaveValue(carry.startDate!, { timeout });
    await expect(chart.getByLabel(`${carry.key} 종료일`, { exact: true })).toHaveValue(carry.endDate!, { timeout });
    const ticketEvidence = ({ id, version, status, assigneeId, startDate, endDate }: Issue) => ({ id, version, status, assigneeId, startDate, endDate });
    return { cycleVersion: result.cycle.version, cycleId: cycle.id, destinationId: destination.id, recordId: result.recordId, documentId,
      ownerId, carry: ticketEvidence(carry), done: ticketEvidence(done) };
  } finally {
    await Promise.allSettled([source.close(), observer.close()]);
  }
}
