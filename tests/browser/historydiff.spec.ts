import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { DocPage, DocRevision, Issue, RichContent, WorkspaceSnapshot } from '../../shared/types';

const body = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
interface Fixture { requests: APIRequestContext; projectId: string; prefix: string; document: (label: string, content: RichContent) => Promise<DocPage>; issue: (label: string) => Promise<Issue> }
const test = base.extend<{ fixture: Fixture }>({ fixture: [async ({ playwright, baseURL }, provide) => {
  const requests = await playwright.request.newContext({ baseURL }), prefix = `이력 비교 합성 ${randomUUID()}`;
  const documents: string[] = [], issues: string[] = [];
  try {
    const data = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot, projectId = data.projects[0].id;
    await provide({ requests, projectId, prefix,
      document: async (label, content) => { const response = await requests.post('/api/documents', { data: { projectId, title: `${prefix} ${label}`, content } }); expect(response.status()).toBe(201); const result = await response.json() as DocPage; documents.push(result.id); return result; },
      issue: async label => { const response = await requests.post('/api/issues', { data: { projectId, title: `${prefix} ${label}` } }); expect(response.status()).toBe(201); const result = await response.json() as Issue; issues.push(result.id); return result; },
    });
  } finally {
    try { const data = await (await requests.get('/api/workspace', { timeout: 5000 })).json() as WorkspaceSnapshot; const docIds = new Set([...documents.reverse(), ...data.documents.filter(value => value.title.startsWith(prefix)).map(value => value.id)]), issueIds = new Set([...issues, ...data.issues.filter(value => value.title.startsWith(prefix)).map(value => value.id)]); for (const id of docIds) { const response = await requests.delete(`/api/documents/${id}`, { timeout: 5000 }); expect([200, 404]).toContain(response.status()); } for (const id of issueIds) { const response = await requests.delete(`/api/issues/${id}`, { timeout: 5000 }); expect([200, 404]).toContain(response.status()); } }
    finally { await requests.dispose(); }
  }
}, { timeout: 30_000 }] });
async function open(page: Page, document: DocPage) { await page.goto(`/#/${document.projectId}/documents/${document.id}`); await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title); await expect(page.locator('.docs-prose')).toBeVisible(); await page.getByRole('button', { name: '이력', exact: true }).click(); }
async function revisions(requests: APIRequestContext, id: string) { return await (await requests.get(`/api/documents/${id}/revisions`)).json() as DocRevision[]; }

test('저장된 두 버전의 서식·표 속성·참조 대상 변경을 텍스트와 함께 나란히 또는 통합으로 비교한다', async ({ page, fixture }) => {
  const { requests } = fixture, issueA = await fixture.issue('이전 업무'), issueB = await fixture.issue('새 업무'), targetA = await fixture.document('이전 대상', body('이전 포함 내용')), targetB = await fixture.document('새 대상', body('새 포함 내용'));
  const content: RichContent = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '같은 본문 문장', marks: [{ type: 'bold' }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '같은 표 문장' }] }] }] }] },
    { type: 'issueReference', attrs: { issueId: issueA.id, label: '동일한 업무 표시' } },
    { type: 'documentReference', attrs: { documentId: targetA.id, label: '동일한 문서 표시' } },
    { type: 'documentInclude', attrs: { documentId: targetA.id, label: '동일한 포함 표시' } },
    { type: 'details', content: [{ type: 'detailsSummary', content: [{ type: 'text', text: '검토 항목' }] }, { type: 'detailsContent', content: [{ type: 'paragraph', content: [{ type: 'text', text: '검토 내용' }] }] }] },
  ] };
  const document = await fixture.document('버전 원본', content), formatted = structuredClone(content);
  formatted.content![0].content![0].marks = [{ type: 'italic' }]; formatted.content![1].content![0].content![0].attrs!.colspan = 2;
  const saved = await requests.patch(`/api/documents/${document.id}`, { data: { expectedVersion: document.version, content: formatted } }); expect(saved.status()).toBe(200); const version2 = await saved.json() as DocPage; expect(version2.plainText).toBe(document.plainText);
  const changed = structuredClone(formatted); changed.content![2].attrs!.issueId = issueB.id; changed.content![3].attrs!.documentId = targetB.id; changed.content![4].attrs!.documentId = targetB.id;
  const last = await requests.patch(`/api/documents/${document.id}`, { data: { expectedVersion: version2.version, title: `${fixture.prefix} 최신 제목`, content: changed } }); expect(last.status()).toBe(200); const version3 = await last.json() as DocPage;
  const savedVersions = await revisions(requests, document.id), v1 = savedVersions.find(value => value.version === 1)!, v2 = savedVersions.find(value => value.version === 2)!, v3 = savedVersions.find(value => value.version === 3)!;
  await open(page, version3); await expect(page.locator('.docs-revision')).toHaveCount(3); await page.getByRole('button', { name: '버전 비교', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '문서 버전 비교', exact: true }); await dialog.getByLabel('비교 기준 버전', { exact: true }).selectOption(v1.id); await dialog.getByLabel('비교 대상 버전', { exact: true }).selectOption(v2.id);
  await expect(dialog.locator('.document-diff-rows')).toHaveClass(/is-split/); await expect(dialog.locator('.document-diff-rows')).toContainText('서식: 굵게'); await expect(dialog.locator('.document-diff-rows')).toContainText('서식: 기울임'); await expect(dialog.locator('.document-diff-rows')).toContainText('가로 병합: 2칸'); await expect(dialog.locator('.document-diff-rows code')).toHaveCount(0);
  const oldFormat = dialog.locator('.document-diff-cell.is-delete').filter({ hasText: '서식: 굵게' });
  await oldFormat.locator('summary').click(); await expect(oldFormat.locator('code')).toContainText('bold'); await expect(oldFormat.locator('code')).toContainText('hasContent'); await oldFormat.locator('summary').click(); await expect(dialog.locator('.document-diff-summary')).not.toContainText('제목과 본문 구조가 같습니다');
  await dialog.getByLabel('비교 대상 버전', { exact: true }).selectOption(v3.id); await expect(dialog.locator('.document-diff-rows')).toContainText(issueA.id); await expect(dialog.locator('.document-diff-rows')).toContainText(issueB.id); await expect(dialog.locator('.document-diff-rows')).toContainText(targetA.id); await expect(dialog.locator('.document-diff-rows')).toContainText(targetB.id); await expect(dialog.locator('.document-diff-rows')).toContainText('참조 대상 ID:'); await expect(dialog.locator('.document-diff-rows')).toContainText('저장된 이름: 동일한 업무 표시');
  const newReference = dialog.locator('.document-diff-cell.is-insert').filter({ hasText: issueB.id });
  await newReference.locator('summary').click(); await expect(newReference.locator('code')).toContainText('issueId'); await expect(newReference.locator('code')).toContainText(issueB.id); await newReference.locator('summary').click(); await expect(newReference.locator('code')).toHaveCount(0);
  mkdirSync('docs/screenshots', { recursive: true }); await dialog.screenshot({ path: 'docs/screenshots/document-diff.png' });
  await dialog.getByRole('button', { name: '통합', exact: true }).click(); await expect(dialog.locator('.document-diff-rows')).toHaveClass(/is-unified/); await expect(dialog.locator('.document-diff-rows')).toContainText(targetB.id);
  await dialog.getByRole('button', { name: '문서 버전 비교 닫기', exact: true }).click();
  const unchanged = (await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(value => value.id === document.id)!; expect(unchanged.version).toBe(version3.version); expect(unchanged.content).toEqual(version3.content);
});

test('현재 미저장 제목·본문을 명시적으로 비교하고 복구의 초안·버전 충돌 보호를 유지한다', async ({ page, fixture }) => {
  const { requests } = fixture, document = await fixture.document('초안 원본', body('처음 저장한 본문'));
  const saved = await requests.patch(`/api/documents/${document.id}`, { data: { expectedVersion: document.version, title: `${fixture.prefix} 저장 버전2`, content: body('두 번째 저장한 본문') } }); expect(saved.status()).toBe(200); const version2 = await saved.json() as DocPage;
  await open(page, version2); await expect(page.locator('.docs-prose')).toHaveAttribute('contenteditable', 'true');
  const title = `${fixture.prefix} 현재 미저장 제목`; await page.getByRole('textbox', { name: '문서 제목', exact: true }).fill(title); await page.locator('.docs-prose').fill('아직 저장하지 않은 본문');
  await page.locator('.docs-revision').filter({ hasText: '버전 1' }).click(); await expect(page.getByRole('button', { name: '이 버전으로 복구', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '이 버전과 현재 미저장 초안 비교', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '문서 버전 비교', exact: true }); await expect(dialog.getByLabel('비교 대상 버전', { exact: true }).locator('option:checked')).toContainText('현재 미저장 초안'); await expect(dialog.locator('.document-diff-source-labels')).toContainText(title); await expect(dialog.locator('.document-diff-rows')).toContainText('아직 저장하지 않은 본문'); await expect(dialog.locator('.document-diff-rows')).toContainText('처음 저장한 본문');
  const storedBefore = (await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(value => value.id === document.id)!; expect(storedBefore.version).toBe(2); expect(storedBefore.title).toBe(version2.title);
  await dialog.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title); await expect(page.locator('.docs-prose')).toContainText('아직 저장하지 않은 본문');
  await page.locator('.docs-save-button').click(); await expect(page.locator('.docs-save-state')).toHaveText('저장됨'); await expect(page.getByRole('button', { name: '이 버전으로 복구', exact: true })).toBeEnabled();
  const afterSave = (await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(value => value.id === document.id)!;
  const remote = await requests.patch(`/api/documents/${document.id}`, { data: { expectedVersion: afterSave.version, title: `${fixture.prefix} 다른 작업자 저장`, content: body('다른 작업자의 본문') } }); expect(remote.status()).toBe(200); const version4 = await remote.json() as DocPage;
  page.once('dialog', value => value.accept()); const restoring = page.waitForResponse(value => value.url().endsWith(`/documents/${document.id}/restore`) && value.request().method() === 'POST'); await page.getByRole('button', { name: '이 버전으로 복구', exact: true }).click(); const rejected = await restoring; expect(rejected.status()).toBe(409); expect(rejected.request().postDataJSON().expectedVersion).toBe(afterSave.version);
  const preserved = (await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(value => value.id === document.id)!; expect(preserved.version).toBe(version4.version); expect(preserved.content).toEqual(version4.content);
  await page.reload(); await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(version4.title); await page.getByRole('button', { name: '이력', exact: true }).click(); await page.locator('.docs-revision').filter({ hasText: '버전 1' }).click();
  page.once('dialog', value => value.accept()); const accepted = page.waitForResponse(value => value.url().endsWith(`/documents/${document.id}/restore`) && value.request().method() === 'POST'); await page.getByRole('button', { name: '이 버전으로 복구', exact: true }).click(); expect((await accepted).status()).toBe(200); await expect(page.locator('.docs-prose')).toContainText('처음 저장한 본문');
});

test('긴 변경 없는 내용은 펼치기와 페이지 이동으로 끝까지 확인하고 렌더링 행 수를 제한한다', async ({ page, fixture }) => {
  const content: RichContent = { type: 'doc', content: Array.from({ length: 90 }, (_, index) => ({ type: 'paragraph', content: [{ type: 'text', text: `기준 문단 ${index}` }] })) };
  const document = await fixture.document('긴 이력', content), response = await fixture.requests.patch(`/api/documents/${document.id}`, { data: { expectedVersion: document.version, title: `${fixture.prefix} 제목만 변경` } }); expect(response.status()).toBe(200); const current = await response.json() as DocPage, versions = await revisions(fixture.requests, document.id), v1 = versions.find(value => value.version === 1)!;
  await open(page, current); await page.getByRole('button', { name: '버전 비교', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '문서 버전 비교', exact: true });
  await expect(dialog.getByRole('button', { name: /변경 없는 내용 .*개 펼치기/ })).toBeVisible(); expect(await dialog.locator('.document-diff-row').count()).toBeLessThanOrEqual(60);
  await dialog.getByRole('button', { name: /변경 없는 내용 .*개 펼치기/ }).click(); await expect(dialog.getByRole('button', { name: '문서 차이 다음 페이지', exact: true })).toBeEnabled(); expect(await dialog.locator('.document-diff-row').count()).toBeLessThanOrEqual(60);
  for (let pageIndex = 0; pageIndex < 10 && await dialog.getByRole('button', { name: '문서 차이 다음 페이지', exact: true }).isEnabled(); pageIndex++) { await dialog.getByRole('button', { name: '문서 차이 다음 페이지', exact: true }).click(); expect(await dialog.locator('.document-diff-row').count()).toBeLessThanOrEqual(60); }
  await expect(dialog.locator('.document-diff-rows')).toContainText('기준 문단 89'); await expect(dialog.getByRole('button', { name: '문서 차이 다음 페이지', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '변경 없는 내용 접기', exact: true }).click(); await expect(dialog.getByRole('button', { name: /변경 없는 내용 .*개 펼치기/ })).toBeVisible();
  await dialog.getByLabel('비교 대상 버전', { exact: true }).selectOption(v1.id); await expect(dialog.locator('.document-diff-summary')).toContainText('제목과 본문 구조가 같습니다');
});
