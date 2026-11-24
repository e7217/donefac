import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { contentReferences } from '../../shared/document-nodes';
import { documentSectionHash } from '../../shared/document-sections';
import type { AttachmentHead, DocPage, Issue, LegacyPackageSummary, MigrationApplyResult, MigrationMappingFile, MigrationOptions, MigrationPreview, ProjectWorkflow, ResourceLink, SourceReconciliationAudit, SourceReconciliationAuthorFindingsPage, SourceReconciliationFileCheck, SourceReconciliationJiraStatusFindingsPage, SourceReconciliationResourceLinkFindingsPage, SourceRecordArchive, SourceRecordPage, WorkspaceSnapshot } from '../../shared/types';

const csv = (rows: string[][]) => Buffer.from(rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n'));
const suffix = () => randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase();
async function upload(request: APIRequestContext, filename: string, content: Buffer, instanceKey: string) { const response = await request.post(`/api/legacy-import/packages?${new URLSearchParams({ filename, instanceKey })}`, { headers: { 'Content-Type': 'application/octet-stream' }, data: content }); expect(response.status(), await response.text()).toBe(201); return await response.json() as LegacyPackageSummary; }
async function open(page: Page, request: APIRequestContext) {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  await page.goto(`/#/${workspace.projects[0].id}/settings`);
  const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
  await expect(settings).toBeVisible({ timeout: 30_000 });
  return { settings, workspace };
}
async function selectPackage(settings: Locator, filename: string) { await settings.getByLabel(`이관 패키지 ${filename}`, { exact: true }).check(); await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click(); await expect(settings.getByLabel('이관 원본 시간대', { exact: true })).toBeVisible(); }
async function openReconciliation(settings: Locator) {
  await settings.getByRole('button', { name:'이관 결과 대조',exact:true }).click();
  const panel = settings.getByRole('region', { name:'이관 결과 대조',exact:true });
  await expect(panel).toBeVisible();
  return panel;
}
async function preview(page: Page, settings: Locator) { const response = page.waitForResponse(value => value.url().endsWith('/api/migrations/preview') && value.request().method() === 'POST'); await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click(); const result = await response; expect(result.ok(), await result.text()).toBe(true); return await result.json() as MigrationPreview; }
async function acknowledge(settings: Locator, value: MigrationPreview) { for (const code of value.requiredAcknowledgements) await settings.getByLabel(`이관 확인 ${code}`, { exact: true }).check(); }
function jira(key: string, title: string) { return csv([['Issue key', 'Issue id', 'Project key', 'Project name', 'Summary', 'Description', 'Status', 'Issue Type', 'Created', 'Updated', 'Reporter', 'Comment'], [`${key}-1`, '100', key, `원본 프로젝트 ${key}`, title, 'h2. 원래 설명\n* 보존할 항목', 'Ready', 'Task', '2020-01-02T03:04:05Z', '2020-02-03T04:05:06Z', 'old-author', '2020-02-03T04:06:00Z;old-author;원래 댓글']]); }

async function importIntoProject(request: APIRequestContext, source: LegacyPackageSummary, key: string, name: string) {
  const optionResponse = await request.get(`/api/migrations/options?${new URLSearchParams({ packageId: source.id })}`);
  expect(optionResponse.ok(), await optionResponse.text()).toBe(true);
  const { defaultConfiguration } = await optionResponse.json() as MigrationOptions;
  const configuration = { ...defaultConfiguration, projects: defaultConfiguration.projects.map(project => ({ ...project, key, name })) };
  const previewResponse = await request.post('/api/migrations/preview', { data: { configuration } });
  expect(previewResponse.status(), await previewResponse.text()).toBe(201);
  const proposed = await previewResponse.json() as MigrationPreview;
  const applied = await request.post(`/api/migrations/previews/${proposed.id}/apply`, { data: {
    expectedVersion: proposed.version, acknowledgements: proposed.requiredAcknowledgements,
  } });
  expect(applied.status(), await applied.text()).toBe(201);
  return await applied.json() as MigrationApplyResult;
}

test('360px Jira 이관에서 초기 상태와 허용 전이를 검토해 새 프로젝트에서 사용한다', async ({ page, request }) => {
  test.setTimeout(95_000);
  const id = suffix(), sourceKey = `WF${id}`, targetKey = `WFN${id}`, filename = `workflow-${id}.csv`;
  const readyTitle = `검토가 필요한 원본 업무 ${id}`, doneTitle = `이전에 완료한 업무 ${id}`;
  const header = ['Issue key', 'Issue id', 'Project key', 'Project name', 'Summary', 'Status', 'Issue Type', 'Created', 'Updated'];
  const row = (number: number, title: string, status: string) => [
    `${sourceKey}-${number}`, String(100 + number), sourceKey, `원본 프로젝트 ${sourceKey}`, title,
    status, 'Task', '2020-01-02T03:04:05Z', '2020-02-03T04:05:06Z',
  ];
  const staged = await upload(request, filename, csv([header, row(1, readyTitle, 'Ready'), row(2, doneTitle, 'Done')]), `jira-workflow-${id}`);
  const createdIssueIds: string[] = [];
  try {
    await page.setViewportSize({ width: 360, height: 820 });
    const { settings } = await open(page, request);
    await selectPackage(settings, filename);
    await settings.getByLabel(`새 프로젝트 키 원본 프로젝트 ${sourceKey}`, { exact: true }).fill(targetKey);
    const mappingDetails = settings.getByText('Jira 워크플로 매핑', { exact: true });
    await mappingDetails.click();
    const flow = settings.getByRole('region', { name: `워크플로 매핑 ${targetKey}`, exact: true });
    const override = flow.getByLabel('허용 전이 직접 지정', { exact: true });
    await override.check();
    await flow.getByRole('button', { name: '상태 추가', exact: true }).click();
    await flow.getByLabel('추가 상태 이름', { exact: true }).fill('팀 승인');
    await flow.getByRole('combobox', { name: '추가 상태 분류', exact: true }).selectOption('review');
    const initial = flow.getByRole('combobox', { name: '초기 상태', exact: true });
    await initial.selectOption({ label: '팀 승인' });
    const from = flow.getByRole('combobox', { name: '전이 출발 상태', exact: true });
    await from.selectOption({ label: 'Ready' });
    await flow.getByLabel('전이 허용 팀 승인', { exact: true }).check();
    await expect(flow.getByLabel('전이 허용 Done', { exact: true })).not.toBeChecked();
    await from.selectOption({ label: '팀 승인' });
    await flow.getByLabel('전이 허용 Done', { exact: true }).check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    const downloaded = page.waitForEvent('download');
    await settings.getByRole('button', { name: '이관 매핑 JSON 내보내기', exact: true }).click();
    const bytes = await readFile(await (await downloaded).path());
    const mapping = JSON.parse(bytes.toString('utf8')) as MigrationMappingFile;
    const configured = mapping.configuration.jiraWorkflows?.[targetKey];
    expect(configured?.additionalStatuses).toEqual([{ id: 's_new_1', label: '팀 승인', category: 'review' }]);
    expect(configured?.initialStatusId).toBe('s_new_1');
    expect(configured?.transitions).toHaveLength(2);
    await override.uncheck();
    page.once('dialog', dialog => dialog.accept());
    await settings.getByLabel('이관 매핑 파일 불러오기', { exact: true }).setInputFiles({
      name: 'reviewed-workflow.json', mimeType: 'application/json', buffer: bytes,
    });
    await expect(settings.getByText('이관 매핑을 불러왔습니다. 적용 전 미리보기를 새로 만들어 주세요.', { exact: true })).toBeVisible();
    if (!await override.isVisible()) await mappingDetails.click();
    await expect(override).toBeChecked();
    await expect(initial).toHaveValue('s_new_1');

    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    const graph = plan.jiraWorkflows?.find(item => item.projectKey === targetKey);
    expect(graph).toBeTruthy();
    const byLabel = new Map(graph!.statuses.map(status => [status.label, status.id]));
    const readyState = byLabel.get('Ready')!, approvalState = byLabel.get('팀 승인')!, doneState = byLabel.get('Done')!;
    expect(graph!.initialStatusId).toBe(approvalState);
    expect(graph!.transitions).toHaveLength(2);
    expect(graph!.transitions).toEqual(expect.arrayContaining([{ from: readyState, to: approvalState }, { from: approvalState, to: doneState }]));
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const graphReview = review.getByRole('region', { name: '적용할 Jira 워크플로', exact: true });
    await expect(graphReview).toContainText('초기 상태 팀 승인');
    await expect(graphReview).toContainText('Ready → 팀 승인');
    await expect(graphReview).toContainText('팀 승인 → Done');
    await graphReview.getByText('적용 상태 3개', { exact: true }).click();
    await expect(graphReview.getByText('팀 승인 · 검토', { exact: true })).toBeVisible();
    const apply = review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true });
    await expect(apply).toBeDisabled();
    await acknowledge(review, plan);
    const applying = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await apply.click();
    const applied = await applying;
    expect(applied.status(), await applied.text()).toBe(201);
    const receipt = await applied.json() as MigrationApplyResult;
    expect(receipt.import.configuration.jiraWorkflows?.[targetKey]).toEqual(configured);
    const [projectId] = receipt.import.projectIds;
    const imported = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const originalReady = imported.issues.find(issue => issue.projectId === projectId && issue.title === readyTitle)!;
    const originalDone = imported.issues.find(issue => issue.projectId === projectId && issue.title === doneTitle)!;
    createdIssueIds.push(originalReady.id, originalDone.id);
    expect(originalReady?.status).toBe(readyState);
    expect(originalDone?.status).toBe(doneState);
    const nativeTitle = `새 업무 ${id}`;
    const created = await request.post('/api/issues', { data: { projectId, title: nativeTitle } });
    expect(created.status(), await created.text()).toBe(201);
    const nativeIssue = await created.json() as Issue;
    createdIssueIds.push(nativeIssue.id);
    expect(nativeIssue).toMatchObject({ status: approvalState });
    const forbidden = await request.patch(`/api/issues/${originalReady.id}`, {
      data: { expectedVersion: originalReady.version, status: doneState },
    });
    expect(forbidden.status(), await forbidden.text()).toBe(422);

    await expect(settings.getByRole('button', { name: '이관 원본·영수증 새로고침', exact: true })).toBeEnabled();
    await page.goto(`/#/${projectId}/issues`);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    const board = page.getByRole('region', { name: '업무 보드', exact: true });
    const approvalColumn = board.locator(`[data-status-id="${approvalState}"]`);
    await expect(approvalColumn).toContainText(nativeTitle);
    await board.getByRole('button', { name: `${originalReady.key} 상태 변경`, exact: true }).press('Enter');
    const statusDialog = page.getByRole('dialog', { name: '업무 상태 변경', exact: true });
    const destination = statusDialog.getByRole('combobox', { name: '변경할 상태', exact: true });
    await expect(destination).toBeFocused();
    await expect(destination.locator(`option[value="${doneState}"]`)).toHaveCount(0);
    await destination.selectOption(approvalState);
    const boardPatch = page.waitForResponse(response => response.url().endsWith(`/api/issues/${originalReady.id}`) && response.request().method() === 'PATCH');
    await statusDialog.getByRole('button', { name: '상태 변경 적용', exact: true }).click();
    expect(await (await boardPatch).json()).toMatchObject({ status: approvalState });
    await expect(statusDialog).toHaveCount(0);
    await expect(approvalColumn.getByRole('button', { name: `${originalReady.key} 상태 변경`, exact: true })).toBeFocused();
    await approvalColumn.locator(`.issue-board-card[data-issue-id="${originalReady.id}"]`).click();
    const detail = page.getByRole('dialog', { name: originalReady.title, exact: true });
    const state = detail.getByLabel('상태', { exact: true });
    const save = detail.getByRole('button', { name: '변경사항 저장', exact: true });
    await expect(state).toHaveValue(approvalState);
    await state.selectOption(doneState);
    const saving = page.waitForResponse(response => response.url().endsWith(`/api/issues/${originalReady.id}`) && response.request().method() === 'PATCH');
    await save.click();
    const changed = await saving;
    expect(changed.ok(), await changed.text()).toBe(true);
    expect(await changed.json()).toMatchObject({ status: doneState });
    await expect(save).toBeDisabled();
  } finally {
    for (const issueId of createdIssueIds) {
      const removed = await request.delete(`/api/issues/${issueId}`);
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`);
    }
    await request.delete(`/api/legacy-import/packages/${staged.id}?expectedVersion=${staged.version}`);
  }
});

test('360px Jira 이력 전이에서 선택한 방향만 기존 매핑에 추가하고 새 프로젝트에 적용한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), sourceKey = `OBS${id}`, targetKey = `WFO${id}`, otherKey = `ALT${id}`, filename = `observed-workflow-${id}.json`;
  const ready = { id: '11', name: 'Ready' }, done = { id: '12', name: 'Done' };
  const date = '2020-01-02T03:04:05Z', changedAt = '2020-01-03T03:04:05Z';
  const sourceIssue = (
    project: { id: string; key: string; name: string }, number: number, status: typeof ready, from?: typeof ready,
  ) => {
    const histories = from ? [{
      id: String(number + 1000), created: changedAt,
      items: [{ field: 'status', fieldId: 'status', fieldtype: 'jira', from: from.id, fromString: from.name, to: status.id, toString: status.name }],
    }] : [];
    return {
      id: String(number), key: `${project.key}-${number}`,
      fields: { project, summary: `상태 이력 업무 ${id} ${number}`, status, issuetype: { id: '3', name: 'Task' }, created: date, updated: changedAt },
      changelog: { startAt: 0, total: histories.length, histories },
    };
  };
  const source = { id: '10', key: sourceKey, name: `원본 전이 프로젝트 ${id}` };
  const other = { id: '20', key: otherKey, name: `별도 전이 프로젝트 ${id}` };
  const toReady = sourceIssue(source, 101, ready, done);
  const toDone = sourceIssue(source, 102, done, ready);
  const fixture = { issues: [toReady, toDone, sourceIssue(other, 201, ready, done), sourceIssue(other, 202, done)] };
  const staged = await upload(request, filename, Buffer.from(JSON.stringify(fixture)), `jira-observed-workflow-${id}`);
  try {
    const { settings } = await open(page, request);
    await selectPackage(settings, filename);
    await settings.getByLabel(`새 프로젝트 키 ${source.name}`, { exact: true }).fill(targetKey);
    await settings.getByText('Jira 워크플로 매핑', { exact: true }).click();
    const flow = settings.getByRole('region', { name: `워크플로 매핑 ${targetKey}`, exact: true });
    await flow.getByLabel('허용 전이 직접 지정', { exact: true }).check();
    await flow.getByRole('button', { name: '상태 추가', exact: true }).click();
    await flow.getByLabel('추가 상태 이름', { exact: true }).fill('팀 승인');
    await flow.getByRole('combobox', { name: '추가 상태 분류', exact: true }).selectOption('review');
    await flow.getByRole('combobox', { name: '초기 상태', exact: true }).selectOption({ label: '팀 승인' });
    const manualFrom = flow.getByRole('combobox', { name: '전이 출발 상태', exact: true });
    await manualFrom.selectOption({ label: 'Ready' });
    await flow.getByLabel('전이 허용 팀 승인', { exact: true }).check();

    const first = await preview(page, settings);
    expect(first.canApply, JSON.stringify(first.notices)).toBe(true);
    const proposed = first.jiraObservedWorkflows?.find(item => item.projectKey === targetKey);
    const readyId = proposed?.statuses.find(status => status.label === 'Ready')?.id;
    const doneId = proposed?.statuses.find(status => status.label === 'Done')?.id;
    expect(readyId).toBeTruthy();
    expect(doneId).toBeTruthy();
    expect(proposed?.transitions).toHaveLength(2);
    expect(proposed?.transitions).toEqual(expect.arrayContaining([
      { from: doneId, to: readyId, issueCount: 1 }, { from: readyId, to: doneId, issueCount: 1 },
    ]));
    expect(first.jiraObservedWorkflows?.find(item => item.projectKey === otherKey)?.transitions).toEqual([
      { from: doneId, to: readyId, issueCount: 1 },
    ]);

    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const suggestions = review.getByRole('region', { name: 'Jira 이력에서 확인한 전이', exact: true });
    const group = suggestions.getByRole('group', { name: `Jira 이력 전이 ${targetKey}`, exact: true });
    const otherGroup = suggestions.getByRole('group', { name: `Jira 이력 전이 ${otherKey}`, exact: true });
    const forward = group.getByRole('checkbox', { name: 'Done → Ready', exact: true });
    const reverse = group.getByRole('checkbox', { name: 'Ready → Done', exact: true });
    const add = suggestions.getByRole('button', { name: '선택한 전이를 매핑에 추가', exact: true });
    await expect(add).toBeDisabled();
    await expect(forward).not.toBeChecked();
    await expect(reverse).not.toBeChecked();
    await expect(group.getByText('업무 1개에서 확인', { exact: true })).toHaveCount(2);
    await acknowledge(review, first);
    const initialApply = review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true });
    await expect(initialApply).toBeEnabled();
    await forward.check();
    await expect(initialApply).toBeDisabled();
    await expect(review.getByRole('button', { name: '이관 사전 검토 JSON 내보내기', exact: true })).toBeDisabled();
    await forward.uncheck();
    await expect(initialApply).toBeEnabled();
    await forward.check();
    await expect(reverse).not.toBeChecked();
    await expect(otherGroup.getByRole('checkbox', { name: 'Done → Ready', exact: true })).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    const migrationWrites: string[] = [];
    const captureWrite = (event: import('@playwright/test').Request) => {
      const path = new URL(event.url()).pathname;
      if (event.method() === 'POST' && path.startsWith('/api/migrations/')) migrationWrites.push(path);
    };
    page.on('request', captureWrite);
    await add.click();
    await expect(review).toHaveCount(0);
    await expect(settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true })).toBeFocused();
    const beforeApply = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(beforeApply.projects.some(project => project.key === targetKey || project.key === otherKey)).toBe(false);
    expect(migrationWrites).toEqual([]);
    page.off('request', captureWrite);
    await expect(flow.getByLabel('전이 허용 팀 승인', { exact: true })).toBeChecked();
    await expect(flow.getByLabel('전이 허용 Done', { exact: true })).not.toBeChecked();
    await manualFrom.selectOption({ label: 'Done' });
    await expect(flow.getByLabel('전이 허용 Ready', { exact: true })).toBeChecked();

    const reviewed = await preview(page, settings);
    expect(reviewed.canApply, JSON.stringify(reviewed.notices)).toBe(true);
    expect(reviewed.id).not.toBe(first.id);
    const graph = reviewed.jiraWorkflows?.find(item => item.projectKey === targetKey);
    const approvalId = graph?.statuses.find(status => status.label === '팀 승인')?.id;
    expect(approvalId).toBeTruthy();
    const expectedTransitions = [{ from: readyId, to: approvalId }, { from: doneId, to: readyId }];
    expect(graph?.initialStatusId).toBe(approvalId);
    expect(graph?.transitions).toHaveLength(2);
    expect(graph?.transitions).toEqual(expect.arrayContaining(expectedTransitions));
    expect(reviewed.configuration.jiraWorkflows?.[otherKey]).toBeUndefined();
    const apply = review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true });
    await expect(apply).toBeDisabled();
    await acknowledge(review, reviewed);
    const applied = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${reviewed.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await apply.click();
    const response = await applied;
    expect(response.status(), await response.text()).toBe(201);
    const receipt = await response.json() as MigrationApplyResult;
    const afterApply = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const project = afterApply.projects.find(project => project.key === targetKey)!;
    expect(receipt.import.projectIds).toContain(project.id);
    const workflow = await (await request.get(`/api/projects/${project.id}/workflow`)).json() as ProjectWorkflow;
    expect(workflow.transitions.map(({ from, to }) => ({ from, to }))).toEqual(graph?.transitions);
    const fromDone = afterApply.issues.find(issue => issue.projectId === project.id && issue.title === toDone.fields.summary)!;
    expect(fromDone.status).toBe(doneId);
    const allowed = await request.patch(`/api/issues/${fromDone.id}`, { data: { expectedVersion: fromDone.version, status: readyId } });
    expect(allowed.ok(), await allowed.text()).toBe(true);
    const moved = await allowed.json() as Issue;
    expect(moved.status).toBe(readyId);
    const forbidden = await request.patch(`/api/issues/${moved.id}`, { data: { expectedVersion: moved.version, status: doneId } });
    expect(forbidden.status(), await forbidden.text()).toBe(422);
    const manual = await request.patch(`/api/issues/${moved.id}`, { data: { expectedVersion: moved.version, status: approvalId } });
    expect(manual.ok(), await manual.text()).toBe(true);
  } finally {
    await request.delete(`/api/legacy-import/packages/${staged.id}?expectedVersion=${staged.version}`);
  }
});

test('360px에서 같은 Jira 프로젝트의 새 업무를 기존 프로젝트에 추가하고 편집한 업무를 보존한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), sourceKey = `SRC${id}`, targetKey = `TGT${id}`, instance = `append-source-${id}`;
  const targetName = `기존 이관 프로젝트 ${id}`, oldTitle = `처음 받은 업무 ${id}`, newTitle = `새로 받은 업무 ${id}`;
  const staged: LegacyPackageSummary[] = [];
  const read = async <T,>(path: string): Promise<T> => {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as T;
  };
  try {
    const original = await upload(request, `original-${id}.csv`, jira(sourceKey, oldTitle), instance);
    staged.push(original);
    const initial = await importIntoProject(request, original, targetKey, targetName);
    const [projectId] = initial.import.projectIds;
    const initialWorkspace = await read<WorkspaceSnapshot>('/api/workspace');
    const prior = initialWorkspace.issues.find(issue => issue.projectId === projectId && issue.title === oldTitle)!;
    expect(prior).toBeTruthy();
    const savedResponse = await request.patch(`/api/issues/${prior.id}`, { data: { expectedVersion: prior.version, title: `Teamspace에서 편집한 내용 ${id}` } });
    expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
    const saved = await savedResponse.json() as Issue;

    const workflowPath = `/api/projects/${projectId}/workflow`;
    const workflow = await read<ProjectWorkflow>(workflowPath);
    const targetStatusId = 'local_review_queue';
    const updatedWorkflow = await request.patch(workflowPath, { data: {
      ...workflow, expectedVersion: workflow.version,
      statuses: [...workflow.statuses, { id: targetStatusId, label: '팀 확인 대기', category: 'todo', color: '#596d84' }],
    } });
    expect(updatedWorkflow.ok(), await updatedWorkflow.text()).toBe(true);

    const header = ['Issue key', 'Issue id', 'Project key', 'Project name', 'Summary', 'Description', 'Status', 'Issue Type', 'Created', 'Updated'];
    const data = (number: number, sourceId: string, title: string, status: string) => [
      `${sourceKey}-${number}`, sourceId, sourceKey, `원본 프로젝트 ${sourceKey}`, title, '', status, 'Task', '2020-01-02T03:04:05Z', '2020-02-03T04:05:06Z',
    ];
    const next = await upload(request, `append-${id}.csv`, csv([header, data(1, '100', `Jira에서 변경한 제목 ${id}`, 'Ready'), data(2, '101', newTitle, 'New from Jira')]), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    const mode = settings.getByRole('combobox', { name: '이관 방식', exact: true });
    await expect(mode).toHaveValue('new');
    const newProjectKey = settings.getByLabel(`새 프로젝트 키 원본 프로젝트 ${sourceKey}`, { exact: true });
    await newProjectKey.fill(`TMP${id}`);
    await mode.selectOption('append');
    const target = settings.getByRole('region', { name: '추가할 기존 프로젝트', exact: true });
    await expect(target).toContainText(`${targetKey} · ${targetName}`);
    await expect(target).toContainText(instance);
    await expect(newProjectKey).toHaveCount(0);
    const bounds = await target.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await settings.getByText('상태 매핑', { exact: true }).click();
    const mapping = settings.getByLabel('상태 매핑 New from Jira', { exact: true });
    await expect(mapping).toHaveValue('');
    await mapping.selectOption(targetStatusId);
    const beforeSwitch = await preview(page, settings);
    expect(beforeSwitch.canApply, JSON.stringify(beforeSwitch.notices)).toBe(true);
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await mode.selectOption('new');
    await expect(review).toHaveCount(0);
    await expect(newProjectKey).toHaveValue(`TMP${id}`);
    await mode.selectOption('append');
    await settings.getByText('상태 매핑', { exact: true }).click();
    await expect(mapping).toHaveValue(targetStatusId);
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendTo?.projectId).toBe(projectId);
    expect(plan.counts).toMatchObject({ projects: 0, issues: 1, retainedIssues: 1 });
    await expect(review.getByText('새로 추가할 업무 1', { exact: true })).toBeVisible();
    await expect(review.getByText('이미 이관한 업무 1', { exact: true })).toBeVisible();
    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const response = await applyResponse;
    expect(response.status(), await response.text()).toBe(201);
    const appended = await response.json() as MigrationApplyResult;
    expect(appended.import.projectIds).toEqual([projectId]);
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByText('원본 기록과 업무를 추가한 프로젝트', { exact: true })).toBeVisible();

    const after = await read<WorkspaceSnapshot>('/api/workspace');
    expect(after.projects).toEqual(initialWorkspace.projects);
    expect(after.issues.find(issue => issue.id === prior.id)).toEqual(saved);
    expect(after.issues.find(issue => issue.projectId === projectId && issue.title === newTitle)).toMatchObject({ status: targetStatusId, key: `${targetKey}-2` });
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 Jira 변경을 반영하고 다음 원본에서도 보존한 팀 편집을 검토한다', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), sourceKey = `REF${id}`, targetKey = `TGT${id}`, instance = `refresh-source-${id}`;
  const originalTitle = `이전 Jira 제목 ${id}`, localTitle = `Teamspace에서 작성한 제목 ${id}`, nextTitle = `새 Jira 제목 ${id}`;
  const originalDescription = '처음 이관한 Jira 설명', nextDescription = '다시 내보낸 Jira의 설명';
  const originalIssueKey = `${sourceKey}-1`;
  const jiraExport = (summary: string, description: string, updated: string) => Buffer.from(JSON.stringify({ issues: [{
    id: '30010', key: originalIssueKey, fields: {
      project: { id: '10100', key: sourceKey, name: `원본 프로젝트 ${sourceKey}` },
      summary, description, created: '2020-01-01T00:00:00Z', updated,
      status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
    },
  }] }));
  const staged: LegacyPackageSummary[] = [];
  let issueId: string | undefined;
  try {
    const original = await upload(request, `refresh-original-${id}.json`, jiraExport(originalTitle, originalDescription, '2020-01-02T00:00:00Z'), instance);
    staged.push(original);
    const initial = await importIntoProject(request, original, targetKey, `이전 이관 프로젝트 ${id}`);
    const [projectId] = initial.import.projectIds;
    const imported = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).issues.find(issue => issue.projectId === projectId)!;
    issueId = imported.id;
    expect(imported).toMatchObject({ title: originalTitle, description: originalDescription });
    const savedResponse = await request.patch(`/api/issues/${imported.id}`, { data: { expectedVersion: imported.version, title: localTitle } });
    expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
    const saved = await savedResponse.json() as Issue;

    const next = await upload(request, `refresh-next-${id}.json`, jiraExport(nextTitle, nextDescription, '2020-01-03T00:00:00Z'), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    const mode = settings.getByLabel('이관 방식', { exact: true });
    await mode.selectOption('append');
    const refresh = settings.getByRole('checkbox', { name: '기존 Jira 업무 변경분 반영', exact: true });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await expect(refresh).not.toBeChecked();
    const appendOnly = await preview(page, settings);
    expect(appendOnly.canApply).toBe(false);
    expect(appendOnly.configuration.appendTo?.refreshExisting).toBeUndefined();
    await expect(review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();
    await refresh.check();
    await expect(review).toHaveCount(0);
    await mode.selectOption('new');
    await expect(refresh).toHaveCount(0);
    await mode.selectOption('append');
    await expect(refresh).toBeChecked();

    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendTo?.refreshExisting).toBe(true);
    expect(plan.counts).toMatchObject({ issues: 0, updatedIssues: 1, updatedFields: 1, conflictingFields: 1 });
    const changes = review.getByRole('region', { name: '기존 Jira 업무 변경 검토', exact: true });
    await expect(changes.getByRole('heading', { name: `${imported.key} Jira ${originalIssueKey}`, exact: true })).toBeVisible();
    const title = changes.getByRole('listitem', { name: '제목', exact: true });
    await expect(title).toContainText('현재 값 유지');
    await expect(title).toContainText(localTitle);
    await expect(title).toContainText(nextTitle);
    const description = changes.getByRole('listitem', { name: '설명', exact: true });
    await expect(description).toContainText('Jira 값 반영');
    await expect(description).toContainText(originalDescription);
    await expect(description).toContainText(nextDescription);
    const bounds = await changes.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('기존 업무 1건 변경'); await dialog.accept(); });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applyResponse;
    expect(applied.status(), await applied.text()).toBe(201);
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByRole('heading', { name: '기존 프로젝트의 Jira 이관 결과', exact: true })).toBeVisible();
    await expect(receipt.getByText('변경 업무 1', { exact: true })).toBeVisible();
    await expect(receipt.getByText('현재 값을 유지할 기본 필드 1', { exact: true })).toBeVisible();
    const after = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).issues.filter(issue => issue.projectId === projectId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: imported.id, key: imported.key, version: saved.version + 1, title: localTitle, description: nextDescription });

    await selectPackage(settings, next.filename);
    await mode.selectOption('append');
    await refresh.check();
    const repeated = await preview(page, settings);
    expect(repeated.canApply).toBe(false);
    await expect(review.getByRole('heading', { name: '적용할 Jira 변경이 없습니다', exact: true })).toBeVisible();
    await expect(review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();

    const newer = await upload(request, `refresh-newer-${id}.json`, jiraExport(nextTitle, nextDescription, '2020-01-04T00:00:00Z'), instance);
    staged.push(newer);
    async function reviewNewerExport() {
      await open(page, request);
      await selectPackage(settings, newer.filename);
      await mode.selectOption('append');
      await refresh.check();
      return preview(page, settings);
    }

    await page.reload();
    const pendingTitle = await reviewNewerExport();
    expect(pendingTitle.counts).toMatchObject({ conflictingFields: 1, updatedFields: 0 });
    expect(pendingTitle.canApply).toBe(false);
    await expect(review.getByRole('heading', { name: '보존할 팀 편집이 있습니다', exact: true })).toBeVisible();
    await expect(title).toContainText('현재 값 유지');
    await expect(title).toContainText(localTitle);
    await expect(title).toContainText(nextTitle);
    await expect(description).toHaveCount(0);

    const discarding = page.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.accept();
      expect(message).toContain('이관 매핑과 검토 중인 미리보기');
    });
    await Promise.all([discarding, page.goto(`/#/${projectId}/issues?issue=${imported.id}`)]);
    const detail = page.getByRole('dialog', { name: localTitle, exact: true });
    await detail.getByRole('textbox', { name: '제목', exact: true }).fill(originalTitle);
    const saving = page.waitForResponse(response => response.url().endsWith(`/api/issues/${imported.id}`) && response.request().method() === 'PATCH');
    await detail.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    expect(await (await saving).json()).toMatchObject({ title: originalTitle, version: saved.version + 2 });
    await expect(page.getByRole('dialog', { name: originalTitle, exact: true })).toBeVisible();

    const resolved = await reviewNewerExport();
    expect(resolved.canApply, JSON.stringify(resolved.notices)).toBe(true);
    expect(resolved.counts).toMatchObject({ conflictingFields: 0, updatedFields: 1 });
    await expect(title).toContainText('Jira 값 반영');
    await expect(title).toContainText(originalTitle);
    await expect(title).toContainText(nextTitle);
    await expect(description).toHaveCount(0);
    await acknowledge(review, resolved);
    const finishing = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${resolved.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    expect((await finishing).status()).toBe(201);
    const final = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).issues.filter(issue => issue.projectId === projectId);
    expect(final).toMatchObject([{ id: imported.id, key: imported.key, version: saved.version + 3, title: nextTitle, description: nextDescription }]);
  } finally {
    if (issueId) {
      const removed = await request.delete(`/api/issues/${issueId}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 Jira 상위 업무 변경을 검토하고 팀이 옮긴 업무의 위치를 보존한다', async ({ page, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const token = suffix(), sourceKey = `JP${token}`, instance = `jira-parent-refresh-${token}`;
  const titles = ['기존 상위 업무', '새 상위 업무', '팀에서 선택한 상위 업무', '원본에서 옮긴 업무', '팀에서 옮긴 업무', '최상위로 옮긴 업무']
    .map(title => `${title} ${token}`);
  const row = (number: number, updatedDay: string, parent?: number | null) => ({
    id: String(100 + number), key: `${sourceKey}-${number}`, fields: {
      project: { id: '20', key: sourceKey, name: `원본 프로젝트 ${token}` }, summary: titles[number - 1],
      status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
      created: '2020-01-01T00:00:00Z', updated: `2020-01-${updatedDay}T00:00:00Z`,
      ...(parent === undefined ? {} : { parent: parent === null ? null : { id: String(100 + parent), key: `${sourceKey}-${parent}` } }),
    },
  });
  const stage = (name: string, issues: ReturnType<typeof row>[]) =>
    upload(request, `jira-parents-${name}-${token}.json`, Buffer.from(JSON.stringify({ issues })), instance);
  const staged: LegacyPackageSummary[] = [];
  let cleanupIssues: Issue[] = [];

  try {
    const original = await stage('original', [row(1, '02'), row(2, '02'), row(3, '02'), row(4, '02', 1), row(5, '02', 1), row(6, '02', 1)]);
    staged.push(original);
    const initial = await importIntoProject(request, original, `PAR${token}`, `Jira 업무 위치 검토 ${token}`);
    const [projectId] = initial.import.projectIds;
    const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const [firstParent, sourceParent, teamParent, reparented, conflicting, detached] = titles.map(title =>
      workspace.issues.find(issue => issue.projectId === projectId && issue.title === title)!);
    cleanupIssues = [reparented, conflicting, detached, firstParent, sourceParent, teamParent];
    const openIssue = async (issue: Issue) => {
      await page.goto(`/#/${projectId}/issues?issue=${issue.id}`);
      const detail = page.getByRole('dialog', { name: issue.title, exact: true });
      await expect(detail).toBeVisible();
      return detail;
    };
    const parentSelect = (detail: Locator) => detail.getByRole('combobox', { name: '상위 업무', exact: true });
    const teamEdited = await openIssue(conflicting);
    await expect(parentSelect(teamEdited)).toHaveValue(firstParent.id);
    await parentSelect(teamEdited).selectOption(teamParent.id);
    const saving = page.waitForResponse(response => response.url().endsWith(`/api/issues/${conflicting.id}`) && response.request().method() === 'PATCH');
    await teamEdited.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const saved = await saving;
    expect(saved.status(), await saved.text()).toBe(200);

    const incoming = await stage('next', [row(4, '03', 2), row(5, '03', 2), row(6, '03', null)]);
    staged.push(incoming);
    const { settings } = await open(page, request);
    await selectPackage(settings, incoming.filename);
    await settings.getByLabel('이관 방식', { exact: true }).selectOption('append');
    await settings.getByRole('checkbox', { name: '기존 Jira 업무 변경분 반영', exact: true }).check();
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.counts).toMatchObject({ issues: 0, updatedIssues: 2, updatedFields: 2, conflictingFields: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const changes = review.getByRole('region', { name: '기존 Jira 업무 변경 검토', exact: true });
    const location = (issue: Issue) => changes.getByRole('list', { name: `${issue.key} 필드 변경`, exact: true })
      .getByRole('listitem', { name: '상위 업무', exact: true });
    const label = (issue: Issue) => `${issue.key} · ${issue.title}`;
    await expect(location(reparented).locator('dd')).toHaveText([label(firstParent), label(sourceParent)]);
    await expect(location(reparented)).toContainText('Jira 값 반영');
    await expect(location(conflicting).locator('dd')).toHaveText([label(teamParent), label(sourceParent)]);
    await expect(location(conflicting)).toContainText('현재 값 유지');
    await expect(location(detached).locator('dd')).toHaveText([label(firstParent), '최상위 업무']);
    await expect(location(detached)).toContainText('Jira 값 반영');

    await acknowledge(review, plan);
    const applying = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applying;
    expect(applied.status(), await applied.text()).toBe(201);
    await expect(settings.getByRole('heading', { name: '기존 프로젝트의 Jira 이관 결과', exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: '이관 원본·영수증 새로고침', exact: true })).toBeEnabled();

    const moved = await openIssue(reparented);
    await expect(parentSelect(moved)).toHaveValue(sourceParent.id);
    await moved.getByRole('button', { name: `상위 업무 · ${sourceParent.key} ${sourceParent.title}`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: sourceParent.title, exact: true })).toBeVisible();
    await expect(parentSelect(await openIssue(conflicting))).toHaveValue(teamParent.id);
    await expect(parentSelect(await openIssue(detached))).toHaveValue('');
  } finally {
    for (const issue of cleanupIssues) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    for (const pack of staged) await request.delete(`/api/legacy-import/packages/${pack.id}?expectedVersion=${pack.version}`);
  }
});

test('360px에서 Jira Server Epic Link로 이관한 에픽과 하위 업무를 티켓과 간트에서 연다', async ({ page, request }) => {
  const token = suffix(), sourceKey = `JE${token}`;
  const epicTitle = `원본 에픽 ${token}`, storyTitle = `에픽에 속한 스토리 ${token}`, subtaskTitle = `스토리의 하위 업무 ${token}`;
  const epicField = 'customfield_10008';
  function issue(number: number, summary: string, type: string, hierarchy = {}) {
    return { id: String(100 + number), key: `${sourceKey}-${number}`, fields: {
      project: { id: '42', key: sourceKey, name: `Jira 에픽 프로젝트 ${token}` }, summary,
      status: { id: '1', name: 'Ready' }, issuetype: { id: String(10 + number), name: type, subtask: number === 3 },
      created: '2020-04-01T00:00:00Z', updated: '2020-04-02T00:00:00Z', ...hierarchy,
    } };
  }
  const pack = await upload(request, `jira-epic-link-${token}.json`, Buffer.from(JSON.stringify({
    names: { [epicField]: '에픽 연결' }, schema: { [epicField]: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
    issues: [issue(1, epicTitle, 'Epic'), issue(2, storyTitle, 'Story', { [epicField]: `${sourceKey}-1` }),
      issue(3, subtaskTitle, 'Sub-task', { parent: { id: '102', key: `${sourceKey}-2` } })],
  })), `jira-epic-link-${token}`);
  const cleanup: Issue[] = [];
  try {
    const { import: { projectIds: [projectId] } } = await importIntoProject(request, pack, `JEI${token}`, `이관한 에픽 계획 ${token}`);
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const byTitle = new Map(snapshot.issues.filter(item => item.projectId === projectId).map(item => [item.title, item]));
    const epic = byTitle.get(epicTitle), story = byTitle.get(storyTitle), subtask = byTitle.get(subtaskTitle);
    for (const title of [subtaskTitle, storyTitle, epicTitle]) {
      const issue = byTitle.get(title);
      if (issue) cleanup.push(issue);
    }
    if (!epic || !story || !subtask) throw new Error('이관한 Jira 업무를 찾을 수 없습니다.');

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/issues?issue=${subtask.id}`);
    const dialog = (title: string) => page.getByRole('dialog', { name: title, exact: true });
    const openParent = (child: Issue, parent: Issue) => dialog(child.title)
      .getByRole('button', { name: `상위 업무 · ${parent.key} ${parent.title}`, exact: true }).click();
    await openParent(subtask, story);
    await openParent(story, epic);
    await expect(dialog(epic.title)).toBeVisible();

    await page.goto(`/#/${projectId}/gantt`);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const row = (issue: Issue) => chart.locator(`.gantt-row[data-issue-id="${issue.id}"]`);
    await row(epic).getByRole('checkbox', { name: `${epic.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '하위 업무 일정 보기', exact: true }).press('Enter');
    await expect(page.getByRole('region', { name: '하위 업무 일정', exact: true })).toContainText('전체 2개');
    await expect(row(story).getByText('하위 1단계', { exact: true })).toBeVisible();
    await expect(row(subtask).getByText('하위 2단계', { exact: true })).toBeVisible();
  } finally {
    for (const issue of cleanup) {
      const removed = await request.delete(`/api/issues/${issue.id}`);
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
    }
    await request.delete(`/api/legacy-import/packages/${pack.id}?expectedVersion=${pack.version}`);
  }
});

test('360px에서 기존 Jira 사용자 정의 속성만 검토하고 팀에서 편집한 값을 유지한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), sourceKey = `JCF${id}`, targetKey = `TCF${id}`, instance = `jira-custom-fields-${id}`;
  const originalTitle = '처음 이관한 Jira 제목', updatedTitle = '새 내보내기의 Jira 제목';
  const remainingLabel = '남은 검토 건수', noteLabel = '검토 조건', referenceLabel = '기존 참고 사항';
  const localNote = 'Teamspace에서 편집한 조건', sourceNote = 'Jira 원본에서 변경한 조건';
  const issueSourceKey = `${sourceKey}-1`;
  const exportJira = (next: boolean) => Buffer.from(JSON.stringify({
    names: { customfield_100: next ? '새 원본의 남은 검토 건수' : remainingLabel, customfield_101: noteLabel, customfield_102: referenceLabel },
    schema: { customfield_100: { type: 'number' }, customfield_101: { type: 'string' }, customfield_102: { type: 'string' } },
    issues: [{ id: '100', key: issueSourceKey, fields: {
      project: { id: '2020', key: sourceKey, name: `원본 프로젝트 ${sourceKey}` }, summary: next ? updatedTitle : originalTitle,
      created: '2021-01-01T00:00:00Z', updated: next ? '2021-01-03T00:00:00Z' : '2021-01-02T00:00:00Z',
      status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
      customfield_100: next ? 0 : 5, customfield_101: next ? sourceNote : '첫 검토 조건', customfield_102: next ? null : '배포 예약',
    } }],
  }));
  const staged: LegacyPackageSummary[] = [];
  try {
    const initial = await upload(request, `jira-custom-original-${id}.json`, exportJira(false), instance);
    staged.push(initial);
    const { import: receipt } = await importIntoProject(request, initial, targetKey, `Jira 속성 이관 프로젝트 ${id}`);
    const [projectId] = receipt.projectIds;
    const initialWorkspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const original = initialWorkspace.issues.find(issue => issue.projectId === projectId)!;
    const schema = initialWorkspace.issueSchemas?.find(value => value.projectId === projectId);
    const remainingId = schema?.fields.find(field => field.name === remainingLabel)?.id;
    const noteId = schema?.fields.find(field => field.name === noteLabel)?.id;
    const referenceId = schema?.fields.find(field => field.name === referenceLabel)?.id;
    expect(remainingId && noteId && referenceId).toBeTruthy();
    expect(original.customFields).toMatchObject({ [remainingId!]: 5, [noteId!]: '첫 검토 조건', [referenceId!]: '배포 예약' });
    const editResponse = await request.patch(`/api/issues/${original.id}`, { data: {
      expectedVersion: original.version, customFields: { ...original.customFields, [noteId!]: localNote },
    } });
    expect(editResponse.ok(), await editResponse.text()).toBe(true);
    const edited = await editResponse.json() as Issue;

    const next = await upload(request, `jira-custom-next-${id}.json`, exportJira(true), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    const mode = settings.getByLabel('이관 방식', { exact: true });
    await mode.selectOption('append');
    const custom = settings.getByRole('checkbox', { name: '기존 Jira 업무의 사용자 정의 속성 변경분 반영', exact: true });
    const standard = settings.getByRole('checkbox', { name: '기존 Jira 업무 변경분 반영', exact: true });
    await expect(custom).not.toBeChecked();
    await expect(standard).not.toBeChecked();
    expect((await preview(page, settings)).canApply).toBe(false);
    await custom.check();
    await settings.getByText('사용자 정의 속성 매핑', { exact: true }).click();
    const mapping = settings.getByLabel('속성 매핑 새 원본의 남은 검토 건수', { exact: true });
    await mapping.selectOption(remainingId!);
    await mode.selectOption('new');
    await expect(custom).toHaveCount(0);
    await mode.selectOption('append');
    await expect(custom).toBeChecked();
    await expect(standard).not.toBeChecked();
    await settings.getByText('사용자 정의 속성 매핑', { exact: true }).click();
    await expect(mapping).toHaveValue(remainingId!);

    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendTo).toMatchObject({ projectId, refreshCustomFields: true });
    expect(plan.configuration.appendTo?.refreshExisting).toBeUndefined();
    expect(plan.counts).toMatchObject({ issues: 0, updatedIssues: 1, updatedCustomFields: 2, conflictingCustomFields: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await expect(review.getByText('사용자 정의 속성 반영 2', { exact: true })).toBeVisible();
    const changes = review.getByRole('region', { name: '기존 Jira 업무 변경 검토', exact: true });
    const numberChange = changes.getByRole('listitem', { name: remainingLabel, exact: true });
    await expect(numberChange.getByText('Jira 값 반영', { exact: true })).toBeVisible();
    await expect(numberChange.getByText('5', { exact: true })).toBeVisible();
    await expect(numberChange.getByText('0', { exact: true })).toBeVisible();
    const conflict = changes.getByRole('listitem', { name: noteLabel, exact: true });
    await expect(conflict).toContainText(localNote);
    await expect(conflict).toContainText(sourceNote);
    await expect(conflict).toContainText('현재 값 유지');
    const clear = changes.getByRole('listitem', { name: referenceLabel, exact: true });
    await expect(clear).toContainText('Jira 값 반영');
    await expect(clear.getByText('비어 있음', { exact: true })).toBeVisible();
    await expect(changes.getByRole('listitem', { name: '제목', exact: true })).toHaveCount(0);
    const bounds = await changes.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('사용자 정의 속성 2건 반영'); await dialog.accept(); });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applyResponse;
    expect(applied.status(), await applied.text()).toBe(201);
    const details = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(details.getByText('사용자 정의 속성 반영 2', { exact: true })).toBeVisible();
    await expect(details.getByText('현재 값을 유지할 사용자 정의 속성 1', { exact: true })).toBeVisible();
    const updated = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).issues.find(issue => issue.id === original.id)!;
    expect(updated).toMatchObject({ title: originalTitle, key: original.key, version: edited.version + 1 });
    expect(updated.customFields).toMatchObject({ [remainingId!]: 0, [noteId!]: localNote });
    expect(updated.customFields?.[referenceId!] ?? null).toBeNull();

    await selectPackage(settings, next.filename);
    await mode.selectOption('append');
    await custom.check();
    await settings.getByText('사용자 정의 속성 매핑', { exact: true }).click();
    await mapping.selectOption(remainingId!);
    expect((await preview(page, settings)).canApply).toBe(false);
    await expect(review.getByRole('heading', { name: '적용할 Jira 변경이 없습니다', exact: true })).toBeVisible();
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 별도 Jira REST 페이지로 기존 업무에 새 댓글과 작업 시간을 한 번씩 추가한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), sourceKey = `JHR${id}`, targetKey = `THR${id}`, instance = `jira-history-${id}`;
  const teamTitle = `팀에서 편집한 업무 ${id}`, teamComment = 'Teamspace에서 남긴 댓글', teamWorklog = 'Teamspace에서 남긴 작업 시간';
  const originalComment = '처음 이관한 원본 댓글', newComment = '새로 내보낸 원본 댓글', rejectedComment = '같은 원본 ID로 변경한 댓글';
  const originalAuthor = { name: `history-worker-${id}`, displayName: `원본 작성자 ${id}` };
  const sourceUrl = 'https://jira.example.test/company/rest/api/3/issue/200';
  const firstComment = { id: '610', author: originalAuthor, created: '2021-01-02T00:00:00Z', body: originalComment };
  const exportJira = (next: boolean) => ({ issues: [{ id: '200', key: `${sourceKey}-1`, self: sourceUrl, fields: {
    project: { id: '2040', key: sourceKey, name: `Jira 원본 프로젝트 ${id}` },
    summary: next ? '두 번째 Jira 원본 제목' : '처음 이관한 Jira 업무',
    created: '2021-01-01T00:00:00Z', updated: next ? '2021-01-04T00:00:00Z' : '2021-01-02T00:00:00Z',
    status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
    ...(next ? {} : { comment: { comments: [firstComment] } }),
  } }] });
  const staged: LegacyPackageSummary[] = [];
  try {
    const initial = await upload(request, `jira-history-original-${id}.json`, Buffer.from(JSON.stringify(exportJira(false))), instance);
    staged.push(initial);
    const { import: first } = await importIntoProject(request, initial, targetKey, `기존 Jira 이관 프로젝트 ${id}`);
    const [projectId] = first.projectIds;
    const initialWorkspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const imported = initialWorkspace.issues.find(issue => issue.projectId === projectId)!;
    const savedResponse = await request.patch(`/api/issues/${imported.id}`, { data: { expectedVersion: imported.version, title: teamTitle } });
    expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
    const saved = await savedResponse.json() as Issue;
    const commentResponse = await request.post('/api/comments', { data: { resourceType: 'issue', resourceId: saved.id, body: teamComment } });
    expect(commentResponse.status(), await commentResponse.text()).toBe(201);
    const worklogResponse = await request.post(`/api/issues/${saved.id}/worklogs`, { data: {
      requestId: randomUUID(), workDate: '2021-01-03', minutes: 1, note: teamWorklog,
    } });
    expect(worklogResponse.status(), await worklogResponse.text()).toBe(201);

    const pages = {
      'issue.json': exportJira(true),
      'comment.json': { startAt: 0, total: 2, comments: [
        { ...firstComment, self: `${sourceUrl}/comment/610`, body: rejectedComment },
        { id: '611', self: `${sourceUrl}/comment/611`, author: originalAuthor, created: '2021-01-04T00:00:00Z', body: newComment },
      ] },
      'worklog.json': { startAt: 0, total: 1, worklogs: [{ id: '710', self: `${sourceUrl}/worklog/710`, issueId: '200',
        author: originalAuthor, started: '2021-01-04T09:00:00+0900', timeSpentSeconds: 91, comment: '새 원본 작업 메모' }] },
    };
    const archive = zip(Object.entries(pages).map(([path, value]) => ({ path, bytes: Buffer.from(JSON.stringify(value)) })));
    const next = await upload(request, `jira-history-next-${id}.zip`, archive, instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    const mode = settings.getByLabel('이관 방식', { exact: true });
    await mode.selectOption('append');
    const history = settings.getByRole('checkbox', { name: '기존 Jira 업무에 댓글과 작업 시간 기록 추가', exact: true });
    const standard = settings.getByRole('checkbox', { name: '기존 Jira 업무 변경분 반영', exact: true });
    for (const option of [history, standard]) await expect(option).not.toBeChecked();
    expect((await preview(page, settings)).canApply).toBe(false);
    await history.check();
    await mode.selectOption('new');
    await mode.selectOption('append');
    await expect(history).toBeChecked();
    await expect(standard).not.toBeChecked();
    const unmapped = await preview(page, settings);
    expect(unmapped.canApply).toBe(false);
    expect(unmapped.counts).toMatchObject({ newJiraComments: 0, newJiraWorklogs: 0 });
    const currentActor = await page.getByLabel('작업자 선택', { exact: true }).inputValue();
    const mappedAuthor = initialWorkspace.users.find(user => user.id !== currentActor)!;
    expect(mappedAuthor).toBeTruthy();
    const mapAuthor = async () => {
      await settings.getByText('사용자 매핑', { exact: true }).click();
      await settings.getByLabel(`사용자 매핑 ${originalAuthor.displayName}`, { exact: true }).selectOption(mappedAuthor.id);
    };
    await mapAuthor();

    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendTo).toMatchObject({ projectId, refreshHistory: true });
    expect(plan.configuration.appendTo?.refreshExisting).toBeUndefined();
    expect(plan.counts).toMatchObject({ issues: 0, newJiraComments: 1, newJiraWorklogs: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const countLabels = ['기존 업무의 새 댓글 1', '기존 업무의 새 작업 시간 기록 1'];
    for (const label of countLabels) await expect(review.getByText(label, { exact: true })).toBeVisible();
    const bounds = await review.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('기존 업무에 새 댓글 1건 추가');
      expect(dialog.message()).toContain('기존 업무에 새 작업 시간 기록 1건 추가');
      await dialog.accept();
    });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applyResponse;
    expect(applied.status(), await applied.text()).toBe(201);
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByRole('heading', { name: '기존 프로젝트의 Jira 이관 결과', exact: true })).toBeVisible();
    for (const label of countLabels) await expect(receipt.getByText(label, { exact: true })).toBeVisible();
    const after = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(after.issues.filter(issue => issue.projectId === projectId)).toEqual([saved]);

    await selectPackage(settings, next.filename);
    await mode.selectOption('append');
    await history.check();
    await mapAuthor();
    const repeated = await preview(page, settings);
    expect(repeated.canApply, JSON.stringify(repeated.notices)).toBe(false);
    expect(repeated.counts).toMatchObject({ issues: 0, newJiraComments: 0, newJiraWorklogs: 0 });
    await expect(review.getByRole('heading', { name: '적용할 Jira 변경이 없습니다', exact: true })).toBeVisible();
    await expect(review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();

    page.once('dialog', dialog => dialog.accept());
    await page.goto(`/#/${projectId}/issues?issue=${saved.id}`);
    const drawer = page.getByRole('dialog', { name: teamTitle, exact: true });
    const comments = drawer.locator('.issue-comment p');
    await expect(comments).toHaveCount(3);
    for (const comment of [originalComment, teamComment, newComment]) await expect(comments.filter({ hasText: comment })).toHaveCount(1);
    await expect(comments.filter({ hasText: rejectedComment })).toHaveCount(0);
    await expect(drawer.locator('.issue-comment').filter({ hasText: newComment }).getByText(mappedAuthor.name, { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: '작업 시간', exact: true }).click();
    const worklogs = drawer.getByRole('region', { name: '업무 작업 기록', exact: true });
    await expect(worklogs.getByLabel('업무 총 작업 시간')).toHaveText('2분 31초');
    const worklogList = worklogs.getByLabel('작업 기록 목록', { exact: true });
    await expect(worklogList.getByText(teamWorklog, { exact: true })).toBeVisible();
    const originalWorklog = worklogList.getByRole('listitem').filter({ hasText: '새 원본 작업 메모' });
    await expect(originalWorklog.getByText(`${mappedAuthor.name} · Jira 이관`, { exact: true })).toBeVisible();
    await expect(worklogList.getByText('Jira 이관')).toHaveCount(1);
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 기존 Jira 업무에 새 원본 첨부파일을 추가하고 팀 버전과 정확한 바이트를 보존한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), sourceKey = `JFA${id}`, targetKey = `TFA${id}`, instance = `jira-attachment-append-${id}`;
  const teamTitle = `팀에서 편집한 첨부 업무 ${id}`, filename = `원본 자료 ${id}.bin`, teamFilename = `팀 편집 자료 ${id}.bin`;
  const originalBytes = Buffer.from([0, 18, 128, 255, 0, 73]), teamBytes = Buffer.from([9, 0, 148, 72, 255]);
  const newBytes = Buffer.from([44, 0, 190, 71, 9, 255]), timestamp = '2021-01-02T00:00:00Z';
  const attachment = (sourceId: number, bytes: Buffer) =>
    `<FileAttachment id="${sourceId}" issue="200" filename="${filename}" filesize="${bytes.length}" created="${timestamp}" version="1"/>`;
  const exportJira = (next: boolean) => zip([
    { path: 'entities.xml', bytes: Buffer.from(`<entity-engine-xml version="9.12">
      <Project id="2040" pkey="${sourceKey}" name="Jira 첨부 원본 ${id}"/>
      <Status id="1" pname="Ready"/><IssueType id="3" pname="Task"/>
      <Issue id="200" project="2040" number="1" summary="${next ? '나중 Jira 제목' : '처음 이관한 Jira 업무'}"
        status="1" issuetype="3" created="${timestamp}" updated="${next ? '2021-01-03T00:00:00Z' : timestamp}"/>
      ${attachment(700, originalBytes)}${next ? attachment(710, newBytes) : ''}
    </entity-engine-xml>`) },
    { path: `attachments/${sourceKey}/${sourceKey}-1/700`, bytes: originalBytes },
    ...(next ? [{ path: `attachments/${sourceKey}/${sourceKey}-1/710`, bytes: newBytes }] : []),
  ]);
  const staged: LegacyPackageSummary[] = [];
  try {
    const original = await upload(request, `jira-attachment-original-${id}.zip`, exportJira(false), instance);
    staged.push(original);
    const { import: first } = await importIntoProject(request, original, targetKey, `기존 Jira 이관 프로젝트 ${id}`);
    const [projectId] = first.projectIds;
    const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const imported = workspace.issues.find(issue => issue.projectId === projectId)!;
    expect(imported).toBeTruthy();
    const savedResponse = await request.patch(`/api/issues/${imported.id}`, { data: { expectedVersion: imported.version, title: teamTitle } });
    expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
    const saved = await savedResponse.json() as Issue;
    const files = async () => {
      const query = new URLSearchParams({ resourceType: 'issue', resourceId: saved.id });
      const response = await request.get(`/api/attachments?${query}`);
      expect(response.ok(), await response.text()).toBe(true);
      return await response.json() as AttachmentHead[];
    };
    const [anchor] = await files();
    expect(anchor).toMatchObject({ filename, versionCount: 1 });
    const versionQuery = new URLSearchParams({ expectedVersionId: anchor.currentVersionId, filename: teamFilename });
    const versionResponse = await request.post(`/api/attachments/${anchor.id}/versions?${versionQuery}`, {
      headers: { 'Content-Type': 'application/octet-stream' }, data: teamBytes,
    });
    expect(versionResponse.status(), await versionResponse.text()).toBe(201);
    const teamHead = await versionResponse.json() as AttachmentHead;

    const next = await upload(request, `jira-attachment-next-${id}.zip`, exportJira(true), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    const mode = settings.getByLabel('이관 방식', { exact: true });
    await mode.selectOption('append');
    const attachments = settings.getByRole('checkbox', { name: '기존 Jira 업무에 첨부파일 추가', exact: true });
    const standard = settings.getByRole('checkbox', { name: '기존 Jira 업무 변경분 반영', exact: true });
    const history = settings.getByRole('checkbox', { name: '기존 Jira 업무에 댓글과 작업 시간 기록 추가', exact: true });
    await expect(attachments).not.toBeChecked();
    expect((await preview(page, settings)).canApply).toBe(false);
    await attachments.check();
    await mode.selectOption('new');
    await mode.selectOption('append');
    await expect(attachments).toBeChecked();
    await expect(standard).not.toBeChecked();
    await expect(history).not.toBeChecked();
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendTo).toMatchObject({ projectId, refreshAttachments: true });
    expect(plan.counts).toMatchObject({ issues: 0, newJiraAttachments: 1, fileCopies: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const count = '기존 업무의 새 첨부파일 1';
    await expect(review.getByText(count, { exact: true })).toBeVisible();
    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('기존 업무에 새 첨부파일 1건 추가');
      await dialog.accept();
    });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applyResponse;
    expect(applied.status(), await applied.text()).toBe(201);
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByRole('heading', { name: '기존 프로젝트의 Jira 이관 결과', exact: true })).toBeVisible();
    await expect(receipt.getByText(count, { exact: true })).toBeVisible();
    const current = await files();
    expect(current).toHaveLength(2);
    expect(current.find(file => file.id === anchor.id)).toEqual(teamHead);
    const added = current.find(file => file.id !== anchor.id)!;
    expect(added).toMatchObject({ filename, versionCount: 1, sha256: createHash('sha256').update(newBytes).digest('hex') });
    const after = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(after.issues.filter(issue => issue.projectId === projectId)).toEqual([saved]);

    await selectPackage(settings, next.filename);
    await mode.selectOption('append');
    await attachments.check();
    const repeated = await preview(page, settings);
    expect(repeated.canApply, JSON.stringify(repeated.notices)).toBe(false);
    expect(repeated.counts).toMatchObject({ issues: 0, newJiraAttachments: 0, fileCopies: 0 });
    await expect(review.getByRole('heading', { name: '적용할 Jira 변경이 없습니다', exact: true })).toBeVisible();
    await expect(review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();

    page.once('dialog', dialog => dialog.accept());
    await page.goto(`/#/${projectId}/issues?issue=${saved.id}`);
    const drawer = page.getByRole('dialog', { name: teamTitle, exact: true });
    const panel = drawer.getByRole('region', { name: '첨부파일', exact: true });
    const download = async (link: Locator) => {
      const [file] = await Promise.all([page.waitForEvent('download'), link.click()]);
      return readFile((await file.path())!);
    };
    expect(await download(panel.getByRole('link', { name: `${filename} 다운로드`, exact: true }))).toEqual(newBytes);
    expect(await download(panel.getByRole('link', { name: `${teamFilename} 다운로드`, exact: true }))).toEqual(teamBytes);
    await panel.getByRole('button', { name: `${teamFilename} 버전`, exact: true }).click();
    const versions = panel.getByRole('region', { name: `${teamFilename} 보존 버전`, exact: true });
    const originalDownload = versions.getByRole('link', { name: `${teamFilename} 버전 1 다운로드`, exact: true });
    await expect(originalDownload.locator('..')).toContainText('이전 버전');
    expect(await download(originalDownload)).toEqual(originalBytes);
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 기존 Confluence 공간의 새 문서를 추가하고 편집한 부모 문서의 참조를 연다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), instance = `append-confluence-${id}`, spaceKey = `CF${id}`, space = `Confluence 원본 공간 ${id}`;
  const targetKey = `WIK${id}`, targetName = `기존 지식 프로젝트 ${id}`;
  const originalParentTitle = `원본 상위 문서 ${id}`, localParentTitle = `팀에서 편집한 상위 문서 ${id}`;
  const localParentBody = 'Teamspace에서만 편집한 상위 문서 본문', childTitle = `새 하위 페이지 ${id}`;
  const date = '<property name="creationDate">2020-01-02T00:00:00Z</property>';
  const pageRow = (sourceId: number, title: string, body: string, parentId?: number) => `
    <object class="Page"><id name="id">${sourceId}</id><property name="title">${title}</property><property name="space" class="Space"><id name="id">42</id></property>${date}
    ${parentId ? `<property name="parent" class="Page"><id name="id">${parentId}</id></property>` : ''}</object>
    <object class="BodyContent"><id name="id">${sourceId + 300}</id><property name="body"><![CDATA[${body}]]></property><property name="content" class="Page"><id name="id">${sourceId}</id></property></object>`;
  const exportSpace = (...rows: string[]) => zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${spaceKey}</property><property name="name">${space}</property></object>
    ${rows.join('\n')}
  </hibernate-generic>`) }]);
  const staged: LegacyPackageSummary[] = [];
  try {
    const original = await upload(request, `space-original-${id}.zip`, exportSpace(
      pageRow(100, originalParentTitle, '<p>처음 받은 상위 본문</p>'),
      pageRow(101, '이미 받은 문서', '<p>처음 받은 별도 문서</p>'),
    ), instance);
    staged.push(original);
    const first = await importIntoProject(request, original, targetKey, targetName);
    const [projectId] = first.import.projectIds;
    const initial = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const parent = initial.documents.find(document => document.projectId === projectId && document.title === originalParentTitle)!;
    expect(parent).toBeTruthy();
    const savedResponse = await request.patch(`/api/documents/${parent.id}`, { data: {
      expectedVersion: parent.version, title: localParentTitle,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: localParentBody }] }] },
    } });
    expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
    const saved = await savedResponse.json() as DocPage;

    const next = await upload(request, `space-next-${id}.zip`, exportSpace(
      pageRow(101, '원본에서 바꾼 제목', '<p>기존 페이지의 갱신 원본</p>'),
      pageRow(102, childTitle, `<p>신규 하위 문서 본문</p><ac:link><ri:page ri:space-key="${spaceKey}" ri:content-title="${originalParentTitle}" /></ac:link>`, 100),
    ), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    const mode = settings.getByLabel('이관 방식', { exact: true });
    const newProjectKey = settings.getByLabel(`새 프로젝트 키 ${space}`, { exact: true });
    await expect(mode).toHaveValue('new');
    await newProjectKey.fill(`TMP${id}`);
    await mode.selectOption({ label: '기존 프로젝트에 새 Confluence 문서 추가' });
    const target = settings.getByRole('region', { name: '추가할 기존 프로젝트', exact: true });
    await expect(target).toContainText(`${targetKey} · ${targetName}`);
    await expect(target).toContainText(`Confluence ${instance} · 원본 공간 ${spaceKey}`);
    await expect(settings.getByText('상태 매핑', { exact: true })).toHaveCount(0);
    await expect(settings.getByText('업무 유형 매핑', { exact: true })).toHaveCount(0);
    const bounds = await target.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    const firstReview = await preview(page, settings);
    expect(firstReview.canApply, JSON.stringify(firstReview.notices)).toBe(true);
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await mode.selectOption('new');
    await expect(review).toHaveCount(0);
    await expect(newProjectKey).toHaveValue(`TMP${id}`);
    await mode.selectOption('append-pages');
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendPagesTo).toEqual({ projectId });
    expect(plan.counts).toMatchObject({ projects: 0, documents: 1, retainedPages: 1 });
    await expect(review.getByText('새로 추가할 문서 1', { exact: true })).toBeVisible();
    await expect(review.getByText('이미 이관한 문서 1', { exact: true })).toBeVisible();
    const refreshed = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}`) && response.ok());
    await review.getByRole('button', { name: '검토 결과 다시 확인', exact: true }).click();
    await refreshed;
    await expect(review.getByText('새로 추가할 문서 1', { exact: true })).toBeVisible();
    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('검토한 Confluence 문서를');
      await dialog.accept();
    });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const response = await applyResponse;
    expect(response.status(), await response.text()).toBe(201);
    const appended = await response.json() as MigrationApplyResult;
    expect(appended.import.projectIds).toEqual([projectId]);
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByText('원본 기록과 문서를 추가한 프로젝트', { exact: true })).toBeVisible();
    await expect(receipt.getByText('새로 추가할 문서 1', { exact: true })).toBeVisible();

    const after = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(after.projects).toEqual(initial.projects);
    expect(after.documents.find(document => document.id === parent.id)).toEqual(saved);
    expect(after.documents.find(document => document.projectId === projectId && document.title === '원본에서 바꾼 제목')).toBeUndefined();
    const child = after.documents.find(document => document.projectId === projectId && document.title === childTitle)!;
    expect(child).toMatchObject({ parentId: parent.id });
    const reconciliation = await openReconciliation(settings);
    await reconciliation.getByRole('button', { name: `현재 문서 열기 ${childTitle}`, exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(childTitle);
    await page.getByRole('button', { name: `참조 문서 열기 ${localParentTitle}`, exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(localParentTitle);
    await expect(page.locator('.docs-prose')).toContainText(localParentBody);
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 이관한 Confluence 제목·페이지 ID·짧은 주소로 같은 Teamspace 문서를 연다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), spaceKey = `CFL${id}`, spaceName = `링크 이관 공간 ${id}`;
  const origin = 'https://confluence.example.test', base = `${origin}/wiki`;
  const sourceTitle = `본문 링크가 있는 문서 ${id}`, targetTitle = `팀 절차 안내 ${id}`;
  const targetBody = '이관 후 Teamspace에서 열리는 절차 본문';
  const titleLabel = '제목 경로로 절차 열기', idLabel = '페이지 ID로 절차 열기', missingLabel = '이관 대상이 없는 페이지';
  const tinyLabel = '짧은 주소로 절차 열기';
  const titlePath = `${base}/display/${spaceKey}/${encodeURIComponent(targetTitle).replaceAll('%20', '+')}`;
  const idPath = '/wiki/pages/viewpage.action?pageId=31002';
  const tinyPath = '/wiki/x/Gnk';
  const missingPath = '/wiki/pages/viewpage.action?pageId=31999';
  const sourceBody = [
    `<p><a href="${titlePath}">${titleLabel}</a></p>`,
    `<p><a href="${idPath}">${idLabel}</a></p>`,
    `<p><a href="${tinyPath}">${tinyLabel}</a></p>`,
    `<p><a href="${missingPath}">${missingLabel}</a></p>`,
  ].join('\n');
  const pageRow = (sourceId: number, title: string, body: string) => `
    <object class="Page"><id name="id">${sourceId}</id><property name="title">${title}</property>
      <property name="space" class="Space"><id name="id">42</id></property>
      <property name="creationDate">2020-01-02T00:00:00Z</property>
    </object>
    <object class="BodyContent"><id name="id">${sourceId + 300}</id><property name="body"><![CDATA[${body}]]></property>
      <property name="content" class="Page"><id name="id">${sourceId}</id></property>
    </object>`;
  const xml = `<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${spaceKey}</property><property name="name">${spaceName}</property></object>
    ${pageRow(31001, sourceTitle, sourceBody)}
    ${pageRow(31002, targetTitle, `<p>${targetBody}</p>`)}
  </hibernate-generic>`;
  const filename = `confluence-body-links-${id}.zip`;
  const pkg = await upload(request, filename, zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]), `confluence-body-links-${id}`);
  const originalRequests: string[] = [];
  const isOriginalRequest = (url: URL) => url.origin === origin || url.pathname.startsWith('/wiki/');
  let readerIssue: Issue | undefined;
  const importedDocuments: DocPage[] = [];

  await page.context().route(isOriginalRequest, async route => {
    originalRequests.push(route.request().url());
    await route.abort();
  });
  try {
    const { settings, workspace } = await open(page, request);
    await selectPackage(settings, filename);
    await settings.getByText('원본 주소와 제외 항목', { exact: true }).click();
    await settings.getByLabel(`원본 주소 ${filename}`, { exact: true }).fill(base);
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.sourceBaseUrls[pkg.id]).toBe(base);
    expect(plan.counts.documents).toBe(2);
    expect(plan.notices).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNRESOLVED_REFERENCE' })]));
    const sample = plan.samples.find(item => item.title === sourceTitle);
    for (const label of [titleLabel, idLabel, tinyLabel, missingLabel]) expect(sample?.plainText).toContain(label);

    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await expect(review.locator('.migration-notice').filter({ hasText: 'UNRESOLVED_REFERENCE' })).toBeVisible();
    await review.getByText('변환된 내용 견본', { exact: true }).click();
    await expect(review).toContainText(missingLabel);
    await acknowledge(review, plan);
    const applied = page.waitForResponse(value => value.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applyResponse = await applied;
    expect(applyResponse.status(), await applyResponse.text()).toBe(201);
    const { import: receipt } = await applyResponse.json() as MigrationApplyResult;
    const [projectId] = receipt.projectIds;
    await expect(settings.getByLabel('이관 영수증 상세', { exact: true })).toContainText('원본 기록과 생성 프로젝트');
    await expect(settings.getByText('실제 이관 적용 중…', { exact: true })).toHaveCount(0);
    const after = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    importedDocuments.push(...after.documents.filter(document => document.projectId === projectId));
    const source = importedDocuments.find(document => document.title === sourceTitle)!;
    const target = importedDocuments.find(document => document.title === targetTitle)!;
    expect(source).toBeTruthy();
    expect(target).toBeTruthy();
    expect(contentReferences(source.content)).toEqual([titleLabel, idLabel, tinyLabel].map(label => ({
      type: 'document', kind: 'reference', id: target.id, label,
    })));

    const issueProject = workspace.projects[0];
    const created = await request.post('/api/issues', { data: { projectId: issueProject.id, title: `이관 문서 읽기 ${id}` } });
    expect(created.status(), await created.text()).toBe(201);
    readerIssue = await created.json() as Issue;
    const linked = await request.post('/api/resource-links', { data: { issueId: readerIssue.id, documentId: source.id, kind: 'related' } });
    expect(linked.status(), await linked.text()).toBe(201);
    const readerPath = `/#/${issueProject.id}/issues?${new URLSearchParams({ issue: readerIssue.id, documentPreview: source.id })}`;
    await page.goto(`/#/${issueProject.id}/issues`);
    await page.reload();
    await page.getByRole('button', { name: new RegExp(readerIssue.title) }).click();
    await page.getByRole('dialog', { name: readerIssue.title, exact: true })
      .getByRole('button', { name: `${sourceTitle} 미리보기`, exact: true }).click();
    const reader = page.getByRole('dialog', { name: '연결 문서 미리보기', exact: true });
    for (const index of [0, 1, 2]) {
      if (index) await page.goto(readerPath);
      await expect(reader).toBeVisible();
      const body = reader.getByRole('region', { name: '미리보기 본문', exact: true });
      await expect(body.locator('[contenteditable="true"]')).toHaveCount(0);
      await expect(body).toContainText(missingLabel);
      await expect(body.getByRole('link', { name: new RegExp(missingLabel) })).toHaveCount(0);
      const references = body.getByRole('button', { name: `참조 문서 열기 ${targetTitle}`, exact: true });
      await expect(references).toHaveCount(3);
      await references.nth(index).click();
      await expect(page).toHaveURL(new RegExp(`/#/${projectId}/documents/${target.id}$`));
      await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(targetTitle);
      await expect(page.locator('.docs-prose')).toContainText(targetBody);
    }
    expect(originalRequests).toEqual([]);
    expect(page.context().pages()).toEqual([page]);
  } finally {
    await page.context().unroute(isOriginalRequest);
    if (readerIssue) await request.delete(`/api/issues/${readerIssue.id}`);
    for (const document of importedDocuments) await request.delete(`/api/documents/${document.id}`);
    await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px Jira 설명의 확인된 Confluence 문서·절 링크를 열고 티켓으로 돌아온다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), date = '2020-01-02T00:00:00Z';
  const jiraBase = 'https://jira.example.test/tracker';
  const homeBase = 'https://wiki.example.test/team/wiki';
  const peerBase = 'https://wiki.example.test/ops/wiki';
  const homeTitle = `팀 안내 ${id}`, peerTitle = `배포 지침 ${id}`, issueTitle = `문서 절을 참조하는 Jira 업무 ${id}`;
  const heading = '배포 확인', sectionBody = '확인한 환경에서 검증 결과를 기록합니다.';
  const introduction = '<p>배포를 시작하기 전에 원래 절차와 변경 내역을 확인합니다.</p>'.repeat(24);
  const homeHref = `${homeBase}/pages/viewpage.action?pageId=200`;
  const peerHref = `${peerBase}/pages/viewpage.action?pageId=200`;
  const peerSectionHref = `${peerHref}#${encodeURIComponent(heading.replaceAll(' ', ''))}`;
  const missingSectionHref = `${peerHref}#missing-section`;
  const commentHref = `${peerHref}&focusedCommentId=77#comment-77`;
  const links = [
    ['팀 문서 열기', homeHref],
    ['배포 확인 절 열기', peerSectionHref],
    ['확인되지 않은 절', missingSectionHref],
    ['원본의 특정 댓글', commentHref],
  ] as const;
  const wiki = (spaceKey: string, title: string, body: string) => zip([{
    path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
      <object class="Space"><id name="id">42</id><property name="key">${spaceKey}</property><property name="name">${spaceKey}</property></object>
      <object class="Page"><id name="id">200</id><property name="title">${title}</property><property name="version">1</property>
        <property name="space" class="Space"><id name="id">42</id></property><property name="creationDate">${date}</property>
        <property name="lastModificationDate">${date}</property></object>
      <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[${body}]]></property>
        <property name="content" class="Page"><id name="id">200</id></property><property name="bodyType">2</property></object>
    </hibernate-generic>`),
  }]);
  const sourceIssue = { issues: [{
    id: '100', key: `JS${id}-1`, self: `${jiraBase}/rest/api/2/issue/100`, fields: {
      project: { id: '10', key: `JS${id}`, name: `원본 Jira ${id}` }, summary: issueTitle,
      created: date, updated: date, status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
      description: { type: 'doc', version: 1, content: links.map(([text, href]) => ({
        type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
      })) },
    },
  }] };
  const staged: LegacyPackageSummary[] = [];
  const createdPaths: string[] = [];
  const originalRequests: string[] = [];
  const isOriginal = (url: URL) => url.hostname === 'jira.example.test' || url.hostname === 'wiki.example.test';
  await page.context().route(isOriginal, route => {
    originalRequests.push(route.request().url());
    return route.abort();
  });
  try {
    staged.push(await upload(request, `jira-section-${id}.json`, Buffer.from(JSON.stringify(sourceIssue)), `jira-section-${id}`));
    staged.push(await upload(request, `wiki-team-${id}.zip`, wiki(`WT${id}`, homeTitle,
      `<p><a href="${peerSectionHref}">다른 설치의 배포 확인 절</a></p>`), `wiki-team-${id}`));
    staged.push(await upload(request, `wiki-ops-${id}.zip`, wiki(`WO${id}`, peerTitle,
      `${introduction}<h2>${heading}</h2><p>${sectionBody}</p>`), `wiki-ops-${id}`));
    const query = new URLSearchParams(staged.map(pkg => ['packageId', pkg.id]));
    const options = await request.get(`/api/migrations/options?${query}`);
    expect(options.ok(), await options.text()).toBe(true);
    const { defaultConfiguration } = await options.json() as MigrationOptions;
    const configuration = {
      ...defaultConfiguration,
      sourceBaseUrls: { [staged[0].id]: jiraBase, [staged[1].id]: homeBase, [staged[2].id]: peerBase },
    };
    const proposed = await request.post('/api/migrations/preview', { data: { configuration } });
    expect(proposed.status(), await proposed.text()).toBe(201);
    const plan = await proposed.json() as MigrationPreview;
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.counts).toMatchObject({ issues: 1, documents: 2 });
    const applied = await request.post(`/api/migrations/previews/${plan.id}/apply`, { data: {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    } });
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: receipt } = await applied.json() as MigrationApplyResult;
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const issue = snapshot.issues.find(item => receipt.projectIds.includes(item.projectId) && item.title === issueTitle);
    const home = snapshot.documents.find(item => item.title === homeTitle);
    const peer = snapshot.documents.find(item => item.title === peerTitle);
    if (issue) createdPaths.push(`/api/issues/${issue.id}`);
    for (const document of [home, peer]) if (document) createdPaths.push(`/api/documents/${document.id}`);
    if (!issue || !home?.projectId || !peer?.projectId) throw new Error('합성 Jira 업무와 이관 문서를 찾을 수 없습니다.');
    const sectionId = peer.content.content?.find(node => node.type === 'heading')?.attrs?.sectionId;
    if (typeof sectionId !== 'string') throw new Error('이관된 제목에 절 ID가 없습니다.');
    expect(home.content.content?.[0]?.content?.[0]).toMatchObject({
      text: '다른 설치의 배포 확인 절',
      marks: [{ type: 'link', attrs: { href: documentSectionHash(peer.id, sectionId) } }],
    });

    const ticketHash = `#/${issue.projectId}/issues?issue=${issue.id}`;
    await page.goto(`/${ticketHash}`);
    const panel = page.getByRole('dialog', { name: issueTitle, exact: true });
    const description = panel.getByRole('region', { name: '설명 미리보기', exact: true });
    const link = (name: typeof links[number][0]) => description.getByRole('link', { name, exact: true });
    await expect(link('확인되지 않은 절')).toHaveAttribute('href', missingSectionHref);
    await expect(link('원본의 특정 댓글')).toHaveAttribute('href', commentHref);

    const title = panel.getByRole('textbox', { name: '제목', exact: true });
    await title.fill('저장하지 않은 Jira 티켓 제목');
    const prompt = page.waitForEvent('dialog');
    const stay = link('팀 문서 열기').click();
    const confirmation = await prompt;
    expect(confirmation.type()).toBe('confirm');
    await confirmation.dismiss();
    await stay;
    await expect(page).toHaveURL(url => url.hash === ticketHash);
    await expect(title).toHaveValue('저장하지 않은 Jira 티켓 제목');
    await title.fill(issueTitle);

    await link('팀 문서 열기').click();
    await expect(page).toHaveURL(url => url.hash === `#/${home.projectId}/documents/${home.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(homeTitle);
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === ticketHash);
    await expect(panel).toBeVisible();

    await link('배포 확인 절 열기').press('Enter');
    await expect(page).toHaveURL(url => url.hash === documentSectionHash(peer.id, sectionId, peer.projectId!));
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(peerTitle);
    const section = page.locator('.docs-prose').getByRole('heading', { name: heading, exact: true });
    await expect(section).toHaveAttribute('data-document-section-id', sectionId);
    await expect(section).toBeFocused();
    await expect(section).toBeInViewport();
    await expect(page.locator('.docs-prose')).toContainText(sectionBody);
    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === ticketHash);
    await expect(link('배포 확인 절 열기')).toBeVisible();
    expect(originalRequests).toEqual([]);
    expect(page.context().pages()).toEqual([page]);
  } finally {
    for (const path of createdPaths) {
      const removed = await request.delete(path);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId?: string };
        if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
    await page.context().unroute(isOriginal);
  }
});

test('360px 이관 영수증에서 업무·문서 연결의 정확한 누락을 확인한다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), jiraKey = `RA${id}`, wikiKey = `WA${id}`;
  const issueTitle = `연결을 대조할 원본 업무 ${id}`, docTitle = `연결을 대조할 원본 문서 ${id}`;
  const body = `<p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">${jiraKey}-1</ac:parameter></ac:structured-macro></p>`;
  const wiki = zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${wikiKey}</property><property name="name">${wikiKey}</property></object>
    <object class="Page"><id name="id">200</id><property name="title">${docTitle}</property><property name="version">1</property>
      <property name="space" class="Space"><id name="id">42</id></property><property name="creationDate">2020-01-02T00:00:00Z</property></object>
    <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[${body}]]></property>
      <property name="content" class="Page"><id name="id">200</id></property><property name="bodyType">2</property></object>
  </hibernate-generic>`) }]);
  const staged: LegacyPackageSummary[] = [];
  const createdPaths: string[] = [];
  try {
    staged.push(await upload(request, `jira-resource-audit-${id}.csv`, jira(jiraKey, issueTitle), `jira-resource-audit-${id}`));
    staged.push(await upload(request, `wiki-resource-audit-${id}.zip`, wiki, `wiki-resource-audit-${id}`));
    const query = new URLSearchParams(staged.map(pkg => ['packageId', pkg.id]));
    const options = await request.get(`/api/migrations/options?${query}`);
    expect(options.ok(), await options.text()).toBe(true);
    const { defaultConfiguration: configuration } = await options.json() as MigrationOptions;
    const proposed = await request.post('/api/migrations/preview', { data: { configuration } });
    expect(proposed.status(), await proposed.text()).toBe(201);
    const plan = await proposed.json() as MigrationPreview;
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.counts.resourceLinks).toBe(1);
    const applied = await request.post(`/api/migrations/previews/${plan.id}/apply`, { data: {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    } });
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: receipt } = await applied.json() as MigrationApplyResult;
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const issue = snapshot.issues.find(item => item.title === issueTitle);
    const document = snapshot.documents.find(item => item.title === docTitle);
    if (issue) createdPaths.push(`/api/issues/${issue.id}`);
    if (document) createdPaths.push(`/api/documents/${document.id}`);
    if (!issue || !document) throw new Error('이관한 합성 업무 또는 문서를 찾을 수 없습니다.');
    const link = snapshot.resourceLinks.find(item => item.issueId === issue.id && item.documentId === document.id);
    if (!link) throw new Error('이관한 업무·문서 연결을 찾을 수 없습니다.');
    expect(receipt.resourceLinkProof).toEqual([{ id: link.id, issueId: issue.id, documentId: document.id }]);

    await page.goto(`/#/${issue.projectId}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    const receipts = settings.getByRole('region', { name: '완료한 이관 영수증', exact: true });
    await receipts.getByRole('button').filter({ hasText: receipt.id }).click();
    const reconciliation = await openReconciliation(settings);
    const run = reconciliation.getByRole('button', { name: '전체 이관 검증', exact: true });
    const verification = reconciliation.getByRole('region', { name: '업무·문서 연결 검증', exact: true });
    const auditPath = `/api/source-imports/${receipt.id}/reconciliation/audit`;
    const findingsPath = `/api/source-imports/${receipt.id}/reconciliation/resource-link-findings`;
    const findingReads: string[] = [];
    page.on('request', sent => {
      if (new URL(sent.url()).pathname === findingsPath) findingReads.push(sent.method());
    });
    async function audit() {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === auditPath);
      await run.click();
      const response = await pending;
      expect(response.ok(), await response.text()).toBe(true);
      await expect(verification).toBeVisible();
      return response.json() as Promise<SourceReconciliationAudit>;
    }
    const initial = await audit();
    expect(initial.resourceLinkProjection).toMatchObject({ expected: 1, counts: { linked: 1, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 } });
    await expect(verification.getByText('일치', { exact: true })).toBeVisible();
    expect(findingReads).toEqual([]);

    expect((await request.delete(`/api/resource-links/${link.id}`)).ok()).toBe(true);
    const replacement = await request.post('/api/resource-links', { data: { issueId: issue.id, documentId: document.id, kind: link.kind } });
    expect(replacement.status(), await replacement.text()).toBe(201);
    expect((await replacement.json() as ResourceLink).id).not.toBe(link.id);
    const removed = await audit();
    expect(removed.resourceLinkProjection).toMatchObject({ expected: 1, counts: { linked: 0, trashed: 0, missing: 1, mismatch: 0, unavailable: 0 } });
    await expect(verification.getByText('검증 실패', { exact: true })).toBeVisible();
    await expect(verification.getByText('건수만 비교', { exact: true })).toHaveCount(0);
    const opener = verification.getByRole('button', { name: '연결 누락 1개 보기', exact: true });
    const findings = verification.getByRole('region', { name: '확인할 업무·문서 연결', exact: true });
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === findingsPath);
    await opener.click();
    const loaded = await pending;
    expect(loaded.ok(), await loaded.text()).toBe(true);
    expect(Object.fromEntries(new URL(loaded.url()).searchParams)).toEqual({
      expectedVersion: String(receipt.version), expectedSha256: removed.resourceLinkProjection?.sha256,
      finding: 'missing', offset: '0', limit: '20',
    });
    const pageOfFindings = await loaded.json() as SourceReconciliationResourceLinkFindingsPage;
    expect(pageOfFindings.rows).toEqual([{
      id: link.id, issueId: issue.id, documentId: document.id, issue: { id: issue.id, key: issue.key, title: issue.title },
      document: { id: document.id, title: document.title },
    }]);
    await expect(findings.getByRole('heading', { name: '확인할 업무·문서 연결', exact: true })).toBeFocused();
    const row = findings.getByRole('list', { name: '업무·문서 연결 목록', exact: true }).getByRole('listitem');
    await expect(row).toContainText(issueTitle);
    await expect(row).toContainText(docTitle);
    for (const expectedId of [link.id, issue.id, document.id]) await expect(row.getByText(expectedId, { exact: true })).toBeVisible();
    await findings.getByRole('button', { name: '연결 목록 닫기', exact: true }).click();
    await expect(opener).toBeFocused();
    expect(findingReads).toEqual(['GET']);
    expect(await page.evaluate(() => window.document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await opener.click();
    await row.getByRole('button', { name: `현재 문서 열기 ${docTitle}`, exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(docTitle);
  } finally {
    for (const path of createdPaths) {
      const removed = await request.delete(path);
      if (removed.ok()) {
        const { trashEntryId } = await removed.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 이관한 Confluence 담당 체크리스트를 편집하고 다시 연다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), spaceKey = `TSK${id}`, spaceName = `체크리스트 원본 공간 ${id}`, title = `배포 체크리스트 ${id}`;
  const user = 'release-operator', dueDate = '2026-12-07';
  const beforeList = '체크리스트에 앞서 환경을 확인합니다.', afterList = '완료한 뒤 변경 내역을 공유합니다.';
  const beforeUser = '담당', afterUser = '배포 설정 검토', afterDate = '까지 진행';
  const expectedTask = `${beforeUser} @${user} ${afterUser} ${dueDate} ${afterDate}`;
  const body = `<p>${beforeList}</p>
    <ac:task-list>
      <ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>
        <ac:task-body>${beforeUser} <ac:link><ri:user ri:username="${user}"/></ac:link> ${afterUser} <time datetime="${dueDate}"/> ${afterDate}</ac:task-body>
      </ac:task>
      <ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>배포 권한 확인</ac:task-body></ac:task>
    </ac:task-list>
    <p>${afterList}</p>`;
  const xml = `<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${spaceKey}</property><property name="name">${spaceName}</property></object>
    <object class="Page"><id name="id">31001</id><property name="title">${title}</property>
      <property name="space" class="Space"><id name="id">42</id></property>
      <property name="creationDate">2020-01-02T00:00:00Z</property>
    </object>
    <object class="BodyContent"><id name="id">31301</id><property name="body"><![CDATA[${body}]]></property>
      <property name="content" class="Page"><id name="id">31001</id></property><property name="bodyType">2</property>
    </object>
  </hibernate-generic>`;
  const filename = `confluence-checklist-${id}.zip`;
  const pkg = await upload(request, filename, zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]), `confluence-checklist-${id}`);
  let imported: DocPage | undefined;
  try {
    const { settings } = await open(page, request);
    await selectPackage(settings, filename);
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.counts.documents).toBe(1);
    const sample = plan.samples.find(item => item.title === title);
    for (const value of [beforeList, expectedTask, afterList]) expect(sample?.plainText).toContain(value);

    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await review.getByText('변환된 내용 견본', { exact: true }).click();
    await expect(review).toContainText(expectedTask);
    await acknowledge(review, plan);
    const applied = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applyResponse = await applied;
    expect(applyResponse.status(), await applyResponse.text()).toBe(201);
    const { import: receipt } = await applyResponse.json() as MigrationApplyResult;
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    imported = snapshot.documents.find(document => document.projectId === receipt.projectIds[0] && document.title === title);
    expect(imported).toBeTruthy();

    await expect(settings.getByLabel('이관 영수증 상세', { exact: true })).toContainText('원본 기록과 생성 프로젝트');
    const audit = await openReconciliation(settings);
    await audit.getByRole('button', { name: `현재 문서 열기 ${title}`, exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title);
    const editor = page.locator('.docs-prose[contenteditable="true"]');
    const tasks = editor.locator('ul[data-type="taskList"] > li');
    const assignedTask = tasks.filter({ hasText: afterUser });
    const pending = assignedTask.getByRole('checkbox');
    await expect(tasks).toHaveCount(2);
    await expect(assignedTask.locator('p')).toHaveText(expectedTask);
    await expect(assignedTask.getByRole('link')).toHaveCount(0);
    await expect(editor.locator(':scope > p')).toHaveText([beforeList, afterList]);
    await expect(pending).not.toBeChecked();
    await expect(tasks.filter({ hasText: '배포 권한 확인' }).getByRole('checkbox')).toBeChecked();

    await pending.check();
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/documents/${imported!.id}`) && response.request().method() === 'PATCH');
    const save = page.locator('.docs-save-button');
    await save.click();
    expect((await saved).ok()).toBe(true);
    await expect(save).toBeDisabled();
    await page.reload();
    await expect(pending).toBeChecked();
    await expect(assignedTask.locator('p')).toHaveText(expectedTask);
  } finally {
    if (imported) await request.delete(`/api/documents/${imported.id}`);
    await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 Confluence 문서 변경을 검토하고 팀의 제목과 새 본문을 함께 보존한다', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), instance = `refresh-confluence-${id}`, spaceKey = `CF${id}`;
  const originalTitle = `처음 이관한 문서 제목 ${id}`, localTitle = `팀에서 편집한 문서 제목 ${id}`, nextTitle = `새 Confluence 문서 제목 ${id}`;
  const originalBody = '이전에 이관한 Confluence 본문', nextBody = 'Confluence에서 추가한 문서 본문';
  const formatTitle = `서식 변경 대상 ${id}`, sameText = '서식만 바뀌는 문장';
  const pageRow = (sourceId: number, title: string, body: string, version: number) => `
    <object class="Page"><id name="id">${sourceId}</id><property name="title">${title}</property><property name="version">${version}</property>
      <property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-0${version + 1}T00:00:00Z</property>
      <property name="space" class="Space"><id name="id">42</id></property></object>
    <object class="BodyContent"><id name="id">${sourceId + 300}</id><property name="body"><![CDATA[${body}]]></property>
      <property name="content" class="Page"><id name="id">${sourceId}</id></property></object>`;
  const exportSpace = (title: string, body: string, formatBody: string, version: number) => zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${spaceKey}</property><property name="name">원본 문서 공간 ${id}</property></object>
    ${pageRow(100, title, body, version)}${pageRow(101, formatTitle, formatBody, version)}
  </hibernate-generic>`) }]);
  const staged: LegacyPackageSummary[] = [];
  try {
    const original = await upload(request, `page-refresh-original-${id}.zip`, exportSpace(originalTitle, `<p>${originalBody}</p>`, `<p>${sameText}</p>`, 1), instance);
    staged.push(original);
    const initial = await importIntoProject(request, original, `WIK${id}`, `기존 문서 프로젝트 ${id}`);
    const [projectId] = initial.import.projectIds;
    const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const imported = workspace.documents.find(document => document.projectId === projectId && document.title === originalTitle)!;
    expect(imported).toMatchObject({ plainText: originalBody });
    const savedResponse = await request.patch(`/api/documents/${imported.id}`, { data: { expectedVersion: imported.version, title: localTitle } });
    expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
    const saved = await savedResponse.json() as DocPage;

    const next = await upload(request, `page-refresh-next-${id}.zip`, exportSpace(nextTitle, `<p>${nextBody}</p>`, `<p><strong>${sameText}</strong></p>`, 2), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    const mode = settings.getByLabel('이관 방식', { exact: true });
    await mode.selectOption('append-pages');
    const refresh = settings.getByRole('checkbox', { name: '기존 Confluence 문서 변경분 반영', exact: true });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await expect(refresh).not.toBeChecked();
    const appendOnly = await preview(page, settings);
    expect(appendOnly.canApply).toBe(false);
    expect(appendOnly.configuration.appendPagesTo?.refreshExisting).toBeUndefined();
    await refresh.check();
    await expect(review).toHaveCount(0);
    await mode.selectOption('new');
    await expect(refresh).toHaveCount(0);
    await mode.selectOption('append-pages');
    await expect(refresh).toBeChecked();

    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendPagesTo).toEqual({ projectId, refreshExisting: true });
    expect(plan.counts).toMatchObject({ documents: 0, updatedDocuments: 2, updatedDocumentFields: 2, conflictingDocumentFields: 1 });
    const changes = review.getByRole('region', { name: '기존 Confluence 문서 변경 검토', exact: true });
    const edited = changes.getByRole('article', { name: localTitle, exact: true });
    const title = edited.getByRole('listitem', { name: '제목', exact: true });
    await expect(title).toContainText('현재 값 유지');
    await expect(title).toContainText(localTitle);
    await expect(title).toContainText(nextTitle);
    const body = edited.getByRole('listitem', { name: '본문', exact: true });
    await expect(body).toContainText('Confluence 값 반영');
    await expect(body).toContainText(originalBody);
    await expect(body).toContainText(nextBody);
    const formatted = changes.getByRole('article', { name: formatTitle, exact: true });
    await expect(formatted.getByRole('listitem', { name: '본문', exact: true })).toContainText('본문 서식 또는 구조가 변경되었습니다.');

    const bounds = await changes.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const originalButton = edited.getByRole('button', { name: 'Confluence 원본 보기', exact: true });
    await originalButton.click();
    const dialog = page.getByRole('dialog', { name: 'Confluence 변경 원본 기록', exact: true });
    await expect(dialog.getByLabel('원본 본문', { exact: true })).toHaveText(`<p>${nextBody}</p>`);
    await dialog.getByRole('button', { name: 'Confluence 원본 닫기', exact: true }).click();
    await expect(originalButton).toBeFocused();

    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('기존 문서 2건 변경'); await dialog.accept(); });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applyResponse;
    expect(applied.status(), await applied.text()).toBe(201);
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByRole('heading', { name: '기존 프로젝트의 Confluence 이관 결과', exact: true })).toBeVisible();
    await expect(receipt.getByText('변경 문서 2', { exact: true })).toBeVisible();
    await expect(receipt.getByText('현재 값을 유지할 필드 1', { exact: true })).toBeVisible();
    const after = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).documents.filter(document => document.projectId === projectId);
    expect(after).toHaveLength(2);
    expect(after.find(document => document.id === imported.id)).toMatchObject({ title: localTitle, plainText: nextBody, version: saved.version + 1 });
    expect(after.find(document => document.title === formatTitle)).toMatchObject({ content: { content: [{ content: [{ text: sameText, marks: [{ type: 'bold' }] }] }] } });

    await selectPackage(settings, next.filename);
    await mode.selectOption('append-pages');
    await refresh.check();
    expect((await preview(page, settings)).canApply).toBe(false);
    await expect(review.getByRole('heading', { name: '적용할 Confluence 변경이 없습니다', exact: true })).toBeVisible();
    await expect(review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();

    const newer = await upload(request, `page-refresh-newer-${id}.zip`, exportSpace(nextTitle, `<p>${nextBody}</p>`, `<p><strong>${sameText}</strong></p>`, 3), instance);
    staged.push(newer);
    await page.reload();
    await selectPackage(settings, newer.filename);
    await mode.selectOption('append-pages');
    await refresh.check();
    const pendingTitle = await preview(page, settings);
    expect(pendingTitle.canApply).toBe(false);
    expect(pendingTitle.counts).toMatchObject({ updatedDocumentFields: 0, conflictingDocumentFields: 1 });
    await expect(review.getByRole('heading', { name: '보존할 팀 편집이 있습니다', exact: true })).toBeVisible();
    await expect(title).toContainText('현재 값 유지');
    await expect(title).toContainText(localTitle);
    await expect(title).toContainText(nextTitle);
    await expect(body).toHaveCount(0);
    await expect(formatted).toHaveCount(0);
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 Confluence 상위 문서 변경을 검토하고 문서 트리에 반영한다', async ({ page, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const token = suffix(), instance = `refresh-confluence-parents-${token}`, spaceKey = `CF${token}`;
  const oldParent = `기존 상위 문서 ${token}`, newParent = `새 상위 문서 ${token}`, localParent = `팀의 상위 문서 ${token}`;
  const movingTitle = `원본에서 옮긴 문서 ${token}`, editedTitle = `팀에서 옮긴 문서 ${token}`;
  const topLevelTitle = `최상위로 옮긴 문서 ${token}`;
  const body = '배치가 바뀌는 문서의 저장 본문';
  const sourcePage = (id: number, title: string, version: number, parentId?: number | null) => `
    <object class="Page"><id name="id">${id}</id><property name="title">${title}</property><property name="version">${version}</property>
      <property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-0${version + 1}T00:00:00Z</property>
      <property name="space" class="Space"><id name="id">42</id></property>
      ${parentId === undefined ? '' : parentId === null ? '<property name="parent"/>' : `<property name="parent" class="Page"><id name="id">${parentId}</id></property>`}</object>
    <object class="BodyContent"><id name="id">${id + 300}</id><property name="body"><![CDATA[<p>${body}</p>]]></property>
      <property name="content" class="Page"><id name="id">${id}</id></property></object>`;
  const exportSpace = (...pages: string[]) => zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${spaceKey}</property><property name="name">원본 문서 공간 ${token}</property></object>
    ${pages.join('\n')}
  </hibernate-generic>`) }]);
  const snapshot = async () => await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const staged: LegacyPackageSummary[] = [];

  try {
    const original = await upload(request, `page-parents-original-${token}.zip`, exportSpace(
      sourcePage(100, oldParent, 1), sourcePage(101, newParent, 1), sourcePage(102, localParent, 1),
      sourcePage(200, movingTitle, 1, 100), sourcePage(201, editedTitle, 1, 100), sourcePage(202, topLevelTitle, 1, 100),
    ), instance);
    staged.push(original);
    const initial = await importIntoProject(request, original, `WIK${token}`, `이관 위치 검토 ${token}`);
    const [projectId] = initial.import.projectIds;
    const workspace = await snapshot();
    const imported = (title: string) => workspace.documents.find(document => document.projectId === projectId && document.title === title)!;
    const oldParentId = imported(oldParent).id, newParentId = imported(newParent).id, localParentId = imported(localParent).id;
    const moving = imported(movingTitle), edited = imported(editedTitle), topLevel = imported(topLevelTitle);
    expect(moving.parentId).toBe(oldParentId);
    expect(edited.parentId).toBe(oldParentId);
    expect(topLevel.parentId).toBe(oldParentId);

    const localEdit = await request.patch(`/api/documents/${edited.id}`, { data: { expectedVersion: edited.version, parentId: localParentId } });
    expect(localEdit.status(), await localEdit.text()).toBe(200);
    const savedLocal = await localEdit.json() as DocPage;
    expect(savedLocal.parentId).toBe(localParentId);

    const next = await upload(request, `page-parents-next-${token}.zip`, exportSpace(
      sourcePage(200, movingTitle, 2, 101), sourcePage(201, editedTitle, 2, 101), sourcePage(202, topLevelTitle, 2, null),
    ), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    await settings.getByLabel('이관 방식', { exact: true }).selectOption('append-pages');
    await settings.getByRole('checkbox', { name: '기존 Confluence 문서 변경분 반영', exact: true }).check();
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.counts).toMatchObject({ documents: 0, updatedDocuments: 2, updatedDocumentFields: 2, conflictingDocumentFields: 1 });

    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const changes = review.getByRole('region', { name: '기존 Confluence 문서 변경 검토', exact: true });
    const location = (title: string) => changes.getByRole('article', { name: title, exact: true }).getByRole('listitem', { name: '상위 문서', exact: true });
    const movingLocation = location(movingTitle), editedLocation = location(editedTitle), topLevelLocation = location(topLevelTitle);
    await expect(movingLocation).toContainText('Confluence 값 반영');
    await expect(movingLocation.locator('dl > div').filter({ hasText: '현재 위치' })).toContainText(oldParent);
    await expect(movingLocation.locator('dl > div').filter({ hasText: '이관 제안 위치' })).toContainText(newParent);
    await expect(editedLocation).toContainText('현재 값 유지');
    await expect(editedLocation.locator('dl > div').filter({ hasText: '현재 위치' })).toContainText(localParent);
    await expect(editedLocation.locator('dl > div').filter({ hasText: '이관 제안 위치' })).toContainText(newParent);
    await expect(topLevelLocation).toContainText('Confluence 값 반영');
    await expect(topLevelLocation.locator('dl > div').filter({ hasText: '이관 제안 위치' }).locator('dd')).toHaveText('최상위');
    const bounds = await changes.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await acknowledge(review, plan);
    const applied = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const response = await applied;
    expect(response.status(), await response.text()).toBe(201);
    await expect(settings.getByRole('heading', { name: '기존 프로젝트의 Confluence 이관 결과', exact: true })).toBeVisible();

    const after = await snapshot();
    expect(after.documents.find(document => document.id === moving.id)).toMatchObject({ parentId: newParentId, plainText: body, version: moving.version + 1 });
    expect(after.documents.find(document => document.id === edited.id)).toEqual(savedLocal);
    expect(after.documents.find(document => document.id === topLevel.id)).toMatchObject({ parentId: null, plainText: body, version: topLevel.version + 1 });

    await page.goto(`/#/${projectId}/documents/${moving.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(movingTitle);
    const tree = page.getByRole('complementary', { name: '문서 목록', exact: true });
    const branch = (title: string) => tree.locator('.docs-tree-row').filter({ has: page.getByText(title, { exact: true }) }).locator('..');
    await expect(branch(newParent).getByText(movingTitle, { exact: true })).toBeVisible();
    await expect(branch(oldParent).getByText(movingTitle, { exact: true })).toHaveCount(0);
    await expect(branch(localParent).getByText(editedTitle, { exact: true })).toBeVisible();
    await expect(tree.getByText(topLevelTitle, { exact: true })).toBeVisible();
    await expect(branch(oldParent).getByText(topLevelTitle, { exact: true })).toHaveCount(0);
  } finally {
    for (const pack of staged) await request.delete(`/api/legacy-import/packages/${pack.id}?expectedVersion=${pack.version}`);
  }
});

test('360px에서 Confluence 라벨의 추가와 삭제를 검토하고 팀에서 바꾼 라벨을 보존한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), instance = `confluence-label-refresh-${id}`, spaceKey = `CF${id}`;
  const changedTitle = `라벨 갱신 문서 ${id}`, editedTitle = `팀 라벨 문서 ${id}`, clearedTitle = `라벨 비우기 문서 ${id}`;
  const body = '라벨만 바뀌는 Confluence 원본 본문';
  const labelIds = { retired: 201, steady: 202, runbook: 203, 'old-topic': 204, 'new-topic': 205, 'clear-me': 206 };
  type Label = keyof typeof labelIds;
  type SourcePage = { id: number; title: string; version: number; labels: Label[] };
  const exportSpace = (pages: SourcePage[]) => zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">${spaceKey}</property><property name="name">라벨 변경 원본 공간 ${id}</property></object>
    ${pages.map(source => `<object class="Page"><id name="id">${source.id}</id><property name="title">${source.title}</property><property name="version">${source.version}</property>
      <property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-0${source.version + 1}T00:00:00Z</property>
      <property name="space" class="Space"><id name="id">42</id></property>
      <collection name="labels" class="java.util.Set">${source.labels.map(label => `<element class="Label"><id name="id">${labelIds[label]}</id></element>`).join('')}</collection>
      </object>
      <object class="BodyContent"><id name="id">${source.id + 300}</id><property name="body"><![CDATA[<p>${body}</p>]]></property>
      <property name="content" class="Page"><id name="id">${source.id}</id></property></object>`).join('')}
    ${[...new Set(pages.flatMap(source => source.labels))].map(label => `<object class="Label"><id name="id">${labelIds[label]}</id>
      <property name="name">${label}</property><property name="namespace">global</property></object>`).join('')}
  </hibernate-generic>`) }]);
  const documents = async (projectId: string) => {
    const response = await request.get('/api/workspace');
    expect(response.ok(), await response.text()).toBe(true);
    return new Map(((await response.json()) as WorkspaceSnapshot).documents.filter(document => document.projectId === projectId)
      .map(document => [document.title, document]));
  };
  const staged: LegacyPackageSummary[] = [];
  try {
    const original = await upload(request, `label-refresh-original-${id}.zip`, exportSpace([
      { id: 100, title: changedTitle, version: 1, labels: ['retired', 'steady'] },
      { id: 101, title: editedTitle, version: 1, labels: ['old-topic'] },
      { id: 102, title: clearedTitle, version: 1, labels: ['clear-me'] },
    ]), instance);
    staged.push(original);
    const initial = await importIntoProject(request, original, `WIK${id}`, `라벨 변경 프로젝트 ${id}`);
    const [projectId] = initial.import.projectIds;
    const before = await documents(projectId);
    expect(before.get(changedTitle)?.labels).toEqual(['retired', 'steady']);
    expect(before.get(editedTitle)?.labels).toEqual(['old-topic']);
    expect(before.get(clearedTitle)?.labels).toEqual(['clear-me']);
    const edited = before.get(editedTitle)!;
    const edit = await request.patch(`/api/documents/${edited.id}`, { data: { expectedVersion: edited.version, labels: ['team-topic'] } });
    expect(edit.status(), await edit.text()).toBe(200);
    const teamDocument = await edit.json() as DocPage;

    const next = await upload(request, `label-refresh-next-${id}.zip`, exportSpace([
      { id: 100, title: changedTitle, version: 2, labels: ['steady', 'runbook'] },
      { id: 101, title: editedTitle, version: 2, labels: ['new-topic'] },
      { id: 102, title: clearedTitle, version: 1, labels: [] },
    ]), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    await settings.getByLabel('이관 방식', { exact: true }).selectOption('append-pages');
    await settings.getByRole('checkbox', { name: '기존 Confluence 문서 변경분 반영', exact: true }).check();
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.counts).toMatchObject({ documents: 0, updatedDocuments: 2, updatedDocumentFields: 2, conflictingDocumentFields: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const changes = review.getByRole('region', { name: '기존 Confluence 문서 변경 검토', exact: true });
    const labels = (title: string) => changes.getByRole('article', { name: title, exact: true }).getByRole('listitem', { name: '라벨', exact: true });
    await expect(labels(changedTitle)).toContainText('Confluence 값 반영');
    await expect(labels(changedTitle).locator('dd').first()).toContainText('retired');
    await expect(labels(changedTitle).locator('dd').last()).toContainText('runbook');
    await expect(labels(changedTitle).locator('dd').last()).toContainText('steady');
    await expect(labels(changedTitle).locator('dd').last()).not.toContainText('retired');
    await expect(labels(editedTitle)).toContainText('현재 값 유지');
    await expect(labels(editedTitle).locator('dd').first()).toContainText('team-topic');
    await expect(labels(editedTitle).locator('dd').last()).toContainText('new-topic');
    await expect(labels(clearedTitle)).toContainText('반영할 라벨');
    await expect(labels(clearedTitle).locator('dd').last()).toHaveText('—');
    const bounds = await changes.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applyResponse;
    expect(applied.status(), await applied.text()).toBe(201);
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByText('변경 문서 2', { exact: true })).toBeVisible();
    await expect(settings.getByRole('status').filter({ hasText: '실제 이관 적용 중…' })).toHaveCount(0);
    const after = await documents(projectId);
    expect(after.get(changedTitle)).toMatchObject({ labels: ['runbook', 'steady'], plainText: body, version: before.get(changedTitle)!.version + 1 });
    expect(after.get(editedTitle)).toEqual(teamDocument);
    expect(after.get(clearedTitle)?.labels ?? []).toEqual([]);
    expect(after.get(clearedTitle)?.version).toBe(before.get(clearedTitle)!.version + 1);

    await page.goto(`/#/${projectId}/documents/${after.get(changedTitle)!.id}?label=runbook`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(changedTitle);
    await expect(page.getByRole('button', { name: '라벨 삭제: runbook', exact: true })).toBeVisible();
    const tree = page.getByRole('complementary', { name: '문서 목록' });
    await expect(tree.getByRole('combobox', { name: '문서 라벨 필터' })).toHaveValue('runbook');
    await expect(tree.locator('.docs-tree-link').filter({ hasText: changedTitle })).toBeVisible();
    await expect(tree.locator('.docs-tree-link').filter({ hasText: editedTitle })).toHaveCount(0);
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 기존 Confluence 문서에 첨부를 추가하고 새 버전과 고정된 이전 파일을 내려받는다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), instance = `confluence-attachment-append-${id}`, title = `첨부를 이관한 기존 문서 ${id}`;
  const teamProjectName = `첨부를 보존하는 프로젝트 ${id}`, seriesName = `자료-${id}.txt`, addedName = `새 자료-${id}.txt`;
  const oldBytes = Buffer.from('처음 이관한 원본 자료'), newBytes = Buffer.from('새로 반영한 원본 자료 v2'), addedBytes = Buffer.from('기존 문서에 처음 추가하는 파일');
  const pinnedText = '이관 당시 자료';
  const body = `<p><ac:link><ri:attachment ri:filename="${seriesName}"/><ac:plain-text-link-body>${pinnedText}</ac:plain-text-link-body></ac:link></p>`;
  const owner = '<property name="containerContent" class="Page"><id name="id">100</id></property>';
  const attachment = (sourceId: number, filename: string, version: number, related = '') => `<object class="Attachment">
    <id name="id">${sourceId}</id><property name="title">${filename}</property><property name="version">${version}</property>
    <property name="creationDate">2020-01-0${version + 1}T00:00:00Z</property>${owner}${related}</object>`;
  const exportSpace = (updated: boolean) => zip([
    { path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
      <object class="Space"><id name="id">42</id><property name="key">CA${id}</property><property name="name">첨부 원본 공간 ${id}</property></object>
      <object class="Page"><id name="id">100</id><property name="title">${title}</property><property name="version">1</property>
        <property name="creationDate">2020-01-01T00:00:00Z</property><property name="lastModificationDate">2020-01-02T00:00:00Z</property>
        <property name="space" class="Space"><id name="id">42</id></property></object>
      <object class="BodyContent"><id name="id">500</id><property name="body"><![CDATA[${body}]]></property>
        <property name="content" class="Page"><id name="id">100</id></property></object>
      ${updated ? [
        attachment(700, seriesName, 2, '<collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection>'),
        attachment(701, seriesName, 1, '<property name="originalVersion" class="Attachment"><id name="id">700</id></property>'),
        attachment(710, addedName, 1),
      ].join('') : attachment(700, seriesName, 1)}
    </hibernate-generic>`) },
    { path: 'attachments/100/700/1', bytes: oldBytes },
    ...(updated ? [{ path: 'attachments/100/700/2', bytes: newBytes }, { path: 'attachments/100/710/1', bytes: addedBytes }] : []),
  ]);
  const staged: LegacyPackageSummary[] = [];
  try {
    const original = await upload(request, `original-attachments-${id}.zip`, exportSpace(false), instance);
    staged.push(original);
    const originalImport = await importIntoProject(request, original, `CA${id}`, teamProjectName);
    const [projectId] = originalImport.import.projectIds;
    const before = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(doc => doc.projectId === projectId && doc.title === title)!;
    expect(before).toBeTruthy();
    const ownerQuery = new URLSearchParams({ resourceType: 'document', resourceId: before.id });
    const [anchor] = await (await request.get(`/api/attachments?${ownerQuery}`)).json() as AttachmentHead[];
    expect(anchor).toMatchObject({ filename: seriesName, versionCount: 1 });

    const next = await upload(request, `next-attachments-${id}.zip`, exportSpace(true), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    const mode = settings.getByLabel('이관 방식', { exact: true });
    await mode.selectOption('append-pages');
    const attachmentOption = settings.getByRole('checkbox', { name: '기존 Confluence 문서에 첨부와 버전 추가', exact: true });
    const documentOption = settings.getByRole('checkbox', { name: '기존 Confluence 문서 변경분 반영', exact: true });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await expect(attachmentOption).not.toBeChecked();
    const defaultReview = await preview(page, settings);
    expect(defaultReview.canApply).toBe(false);
    expect(defaultReview.configuration.appendPagesTo).toEqual({ projectId });
    await attachmentOption.check();
    await expect(review).toHaveCount(0);
    await documentOption.check();
    await mode.selectOption('new');
    await expect(attachmentOption).toHaveCount(0);
    await mode.selectOption('append-pages');
    await expect(attachmentOption).toBeChecked();
    await expect(documentOption).toBeChecked();
    await documentOption.uncheck();
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendPagesTo).toEqual({ projectId, refreshAttachments: true });
    expect(plan.counts).toMatchObject({ documents: 0, newConfluenceAttachments: 1, newConfluenceAttachmentVersions: 1 });
    await expect(review.getByText('기존 문서의 새 첨부 1', { exact: true })).toBeVisible();
    await expect(review.getByText('기존 첨부의 새 버전 1', { exact: true })).toBeVisible();
    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('기존 문서에 새 첨부 1건 추가');
      expect(dialog.message()).toContain('기존 첨부에 새 버전 1건 추가');
      await dialog.accept();
    });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applyResponse;
    expect(applied.status(), await applied.text()).toBe(201);
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByRole('heading', { name: '기존 프로젝트의 Confluence 이관 결과', exact: true })).toBeVisible();
    await expect(receipt.getByText('기존 문서의 새 첨부 1', { exact: true })).toBeVisible();
    await expect(receipt.getByText('기존 첨부의 새 버전 1', { exact: true })).toBeVisible();
    const current = await (await request.get(`/api/attachments?${ownerQuery}`)).json() as AttachmentHead[];
    const newHead = current.find(item => item.id === anchor.id);
    expect(newHead).toMatchObject({ filename: seriesName, versionCount: 2 });
    expect(newHead?.currentVersionId).not.toBe(anchor.id);
    expect((await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(doc => doc.id === before.id)).toEqual(before);

    await page.goto(`/#/${projectId}/documents/${before.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(title);
    const pinned = page.locator('.docs-prose').getByRole('link', { name: pinnedText, exact: true });
    await expect(pinned).toHaveAttribute('href', `/api/attachments/${anchor.id}/content`);
    await page.getByRole('button', { name: '파일 첨부', exact: true }).click();
    const attachmentPanel = page.getByRole('region', { name: '첨부파일', exact: true });
    await expect(attachmentPanel.getByRole('link', { name: addedName, exact: true })).toBeVisible();
    const download = async (link: Locator) => {
      const [file] = await Promise.all([page.waitForEvent('download'), link.click()]);
      return readFile((await file.path())!);
    };
    expect(await download(attachmentPanel.getByRole('link', { name: `${seriesName} 다운로드`, exact: true }))).toEqual(newBytes);
    await attachmentPanel.getByRole('button', { name: `${seriesName} 버전`, exact: true }).click();
    const versions = attachmentPanel.getByRole('region', { name: `${seriesName} 보존 버전`, exact: true });
    const prior = versions.getByRole('link', { name: `${seriesName} 버전 1 다운로드`, exact: true });
    const latest = versions.getByRole('link', { name: `${seriesName} 버전 2 다운로드`, exact: true });
    await expect(latest.locator('..')).toContainText('최신 버전');
    expect(await download(prior)).toEqual(oldBytes);
    expect(await download(latest)).toEqual(newBytes);

    await open(page, request);
    await selectPackage(settings, next.filename);
    await mode.selectOption('append-pages');
    await attachmentOption.check();
    expect((await preview(page, settings)).canApply).toBe(false);
    await expect(review.getByRole('heading', { name: '적용할 Confluence 변경이 없습니다', exact: true })).toBeVisible();
    await expect(review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px에서 기존 Confluence 문서의 댓글과 원본 이력만 추가하고 팀 버전과 구분한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), instance = `confluence-history-append-${id}`, title = `이력을 이관한 기존 문서 ${id}`;
  const historicalTitle = `과거 원본 제목 ${id}`, historicalBody = '과거 Confluence 원본 본문';
  const originalBody = '처음 이관한 Confluence 본문', teamTitle = `팀에서 바꾼 제목 ${id}`;
  const teamComment = '팀 문서에 먼저 작성한 댓글', sourceComment = '원본에서 뒤늦게 추가로 이관한 댓글';
  const prop = (name: string, value: string) => `<property name="${name}"><![CDATA[${value}]]></property>`;
  const ref = (name: string, kind: string, sourceId: string) => `<property name="${name}" class="${kind}"><id name="id">${sourceId}</id></property>`;
  const object = (kind: string, sourceId: string, fields: string) => `<object class="${kind}"><id name="${kind === 'ConfluenceUserImpl' ? 'key' : 'id'}">${sourceId}</id>${fields}</object>`;
  const dates = prop('creationDate', '2020-01-01T00:00:00Z') + prop('lastModificationDate', '2020-01-02T00:00:00Z');
  const space = ref('space', 'Space', '42'), author = ref('creator', 'ConfluenceUserImpl', 'old-user');
  const content = (id: string, kind: string, sourceId: string, body: string) => object('BodyContent', id, prop('body', `<p>${body}</p>`) + ref('content', kind, sourceId) + prop('bodyType', '2'));
  const exportSpace = (updated: boolean) => zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>
    ${object('Space', '42', prop('key', `CH${id}`) + prop('name', `이력 원본 공간 ${id}`))}
    ${object('ConfluenceUserImpl', 'old-user', prop('name', 'confluence-old-author'))}
    ${object('Page', '100', prop('title', updated ? 'Confluence 최신 제목' : title) + prop('version', updated ? '3' : '1') + space + author + dates)}
    ${content('200', 'Page', '100', updated ? 'Confluence 최신 본문' : originalBody)}
    ${updated ? object('Page', '101', prop('title', historicalTitle) + prop('version', '2') + prop('contentStatus', 'historical') + ref('originalVersion', 'Page', '100') + space + author + dates) : ''}
    ${updated ? content('201', 'Page', '101', historicalBody) : ''}
    ${updated ? object('Comment', '600', ref('containerContent', 'Page', '100') + author + dates) : ''}
    ${updated ? content('202', 'Comment', '600', sourceComment) : ''}
  </hibernate-generic>`) }]);
  const staged: LegacyPackageSummary[] = [];
  let pinHostId: string | undefined;
  try {
    const original = await upload(request, `original-history-${id}.zip`, exportSpace(false), instance);
    staged.push(original);
    const [projectId] = (await importIntoProject(request, original, `CH${id}`, `이력을 보존하는 프로젝트 ${id}`)).import.projectIds;
    const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const imported = workspace.documents.find(document => document.projectId === projectId && document.title === title)!;
    expect(imported).toMatchObject({ plainText: originalBody, version: 1 });
    const savedResponse = await request.patch(`/api/documents/${imported.id}`, { data: { title: teamTitle, expectedVersion: imported.version } });
    expect(savedResponse.status(), await savedResponse.text()).toBe(200);
    const saved = await savedResponse.json() as DocPage;
    expect(saved.version).toBe(2);
    const posted = await request.post('/api/comments', { data: { resourceType: 'document', resourceId: saved.id, body: teamComment } });
    expect(posted.status(), await posted.text()).toBe(201);
    const pinHostResponse = await request.post('/api/documents', { data: { projectId, title: `원본 버전을 포함하는 문서 ${id}` } });
    expect(pinHostResponse.status(), await pinHostResponse.text()).toBe(201);
    const pinHost = await pinHostResponse.json() as DocPage;
    pinHostId = pinHost.id;

    const next = await upload(request, `next-history-${id}.zip`, exportSpace(true), instance);
    staged.push(next);
    const { settings } = await open(page, request);
    await selectPackage(settings, next.filename);
    const mode = settings.getByLabel('이관 방식', { exact: true });
    await mode.selectOption('append-pages');
    const history = settings.getByRole('checkbox', { name: '기존 Confluence 문서에 댓글과 변경 이력 추가', exact: true });
    const document = settings.getByRole('checkbox', { name: '기존 Confluence 문서 변경분 반영', exact: true });
    const attachments = settings.getByRole('checkbox', { name: '기존 Confluence 문서에 첨부와 버전 추가', exact: true });
    for (const option of [history, document, attachments]) await expect(option).not.toBeChecked();
    expect((await preview(page, settings)).canApply).toBe(false);
    await history.check();
    await document.check();
    await attachments.check();
    await mode.selectOption('new');
    await mode.selectOption('append-pages');
    for (const option of [history, document, attachments]) await expect(option).toBeChecked();
    await document.uncheck();
    await attachments.uncheck();

    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.configuration.appendPagesTo).toEqual({ projectId, refreshHistory: true });
    expect(plan.counts).toMatchObject({ documents: 0, newConfluenceComments: 1, newConfluenceRevisions: 1 });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    for (const label of ['기존 문서의 새 댓글 1', '기존 문서의 새 원본 버전 1']) await expect(review.getByText(label, { exact: true })).toBeVisible();
    await acknowledge(review, plan);
    const applyResponse = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('기존 문서에 새 댓글 1건 추가');
      expect(dialog.message()).toContain('기존 문서에 새 원본 버전 1건 추가');
      await dialog.accept();
    });
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applyResponse;
    expect(applied.status(), await applied.text()).toBe(201);
    const receipt = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(receipt.getByRole('heading', { name: '기존 프로젝트의 Confluence 이관 결과', exact: true })).toBeVisible();
    for (const label of ['기존 문서의 새 댓글 1', '기존 문서의 새 원본 버전 1']) await expect(receipt.getByText(label, { exact: true })).toBeVisible();
    expect((await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).documents.find(value => value.id === saved.id)).toEqual(saved);

    await page.goto(`/#/${projectId}/documents/${saved.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(teamTitle);
    await expect(page.locator('.docs-prose')).toContainText(originalBody);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    await expect(page.locator('.docs-comment p').filter({ hasText: teamComment })).toHaveCount(1);
    await expect(page.locator('.docs-comment p').filter({ hasText: sourceComment })).toHaveCount(1);
    await page.getByRole('button', { name: '이력', exact: true }).click();
    const revisions = page.locator('.docs-revision');
    await expect(revisions).toHaveCount(3);
    await expect(revisions.first()).toContainText('버전 2');
    await expect(revisions.first().getByText('현재', { exact: true })).toBeVisible();
    const importedRevision = revisions.filter({ hasText: 'Confluence 원본 버전 2' });
    await expect(importedRevision.getByText('현재', { exact: true })).toHaveCount(0);
    await importedRevision.click();
    const detail = page.locator('.docs-history-preview');
    await expect(detail.getByText('Confluence 원본 버전 2', { exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: historicalTitle, exact: true })).toBeVisible();
    await expect(detail).toContainText(historicalBody);
    await detail.getByRole('button', { name: '이 버전과 현재 편집본 비교', exact: true }).click();
    const comparison = page.getByRole('dialog', { name: '문서 버전 비교', exact: true });
    await expect(comparison.getByLabel('비교 기준 버전', { exact: true }).locator('option:checked')).toHaveText(`Confluence 원본 버전 2 · ${historicalTitle}`);
    await expect(comparison.getByText('기준 · Confluence 원본 버전 2', { exact: false })).toBeVisible();
    await comparison.getByRole('button', { name: '문서 버전 비교 닫기', exact: true }).click();
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Confluence 원본 버전 2의 내용으로 복구');
      await dialog.dismiss();
    });
    await detail.getByRole('button', { name: '이 버전으로 복구', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(teamTitle);

    await page.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();
    await page.goto(`/#/${projectId}/documents/${pinHost.id}`);
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(pinHost.title);
    await page.getByRole('button', { name: '문서 버전 포함 삽입', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '문서 버전 포함 삽입', exact: true });
    await chooser.getByLabel('참조할 항목 검색', { exact: true }).fill(teamTitle);
    await chooser.getByRole('button').filter({ hasText: teamTitle }).click();
    await expect(chooser.getByRole('button', { name: '버전 2 포함', exact: true })).toBeVisible();
    const sourceOption = chooser.getByRole('button', { name: 'Confluence 원본 버전 2 포함', exact: true });
    const sourceLabel = sourceOption.getByText('Confluence 원본 버전 2', { exact: true });
    expect(await sourceLabel.evaluate(label => label.clientWidth >= label.scrollWidth)).toBe(true);
    await sourceOption.click();
    const pinned = page.getByRole('region', { name: `고정 포함 문서 ${historicalTitle}`, exact: true });
    await pinned.getByRole('button', { name: '고정 버전 내용 보기', exact: true }).click();
    await expect(pinned.getByText('Confluence 원본 버전 2', { exact: true })).toBeVisible();
    await expect(pinned).toContainText(historicalBody);
  } finally {
    if (pinHostId) await request.delete(`/api/documents/${pinHostId}`);
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px 이관 진단에서 해당 패키지의 원본을 확인하고 같은 미리보기로 돌아간다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), originalId = `동일/업무-${id}`, firstKey = `DIA${id}`, otherKey = `DIB${id}`;
  const firstTitle = `확인할 원본 ${id}`, otherTitle = `다른 패키지 원본 ${id}`;
  const rawBody = '<img src="/should-not-load.png"><script>원본 그대로</script>';
  const input = (key: string, title: string, body: string) => csv([
    ['Issue key', 'Issue id', 'Project key', 'Project name', 'Summary', 'Description', 'Status', 'Issue Type', 'Created', 'Updated', 'Reporter'],
    [`${key}-1`, originalId, key, `원본 프로젝트 ${key}`, title, body, 'Ready', 'Task', '확인할 날짜 문자열', '2020-02-03T04:05:06Z', 'diag-author'],
  ]);
  const staged: LegacyPackageSummary[] = [];
  try {
    const first = await upload(request, `first-${id}.csv`, input(firstKey, firstTitle, rawBody), `diagnostic-first-${id}`);
    staged.push(first);
    const other = await upload(request, `other-${id}.csv`, input(otherKey, otherTitle, '별도 원본 내용'), `diagnostic-other-${id}`);
    staged.push(other);
    const { settings } = await open(page, request);
    await settings.getByLabel(`이관 패키지 ${other.filename}`, { exact: true }).check();
    await selectPackage(settings, first.filename);
    const keyInput = settings.getByLabel(`새 프로젝트 키 원본 프로젝트 ${firstKey}`, { exact: true });
    const mappedKey = `REV${id}`;
    await keyInput.fill(mappedKey);
    const plan = await preview(page, settings);
    expect(plan.canApply).toBe(false);
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const reference = `${first.id}/issue:${originalId}`;
    const opener = review.locator('.migration-notice').filter({ hasText: 'DATE_UNRESOLVED' }).filter({ hasText: reference })
      .getByRole('button', { name: '원본 상세 보기', exact: true });
    await opener.scrollIntoViewIfNeeded();
    const initialPosition = await opener.boundingBox();
    expect(initialPosition).not.toBeNull();

    const originalPath = `/api/legacy-import/packages/${first.id}/records/${encodeURIComponent(`issue:${originalId}`)}`;
    await page.route(url => url.pathname === originalPath, route => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: '합성 원본 조회 오류' }),
    }), { times: 1 });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '이관 진단 원본 기록', exact: true });
    await expect(dialog.getByRole('alert')).toHaveText('합성 원본 조회 오류');
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === originalPath && response.ok());
    await dialog.getByRole('button', { name: '원본 다시 불러오기', exact: true }).click();
    await loaded;
    const detail = dialog.getByRole('region', { name: '원본 객체 상세', exact: true });
    await expect(dialog).toContainText(first.filename);
    await expect(detail.getByRole('heading', { name: firstTitle, exact: true })).toBeVisible();
    await expect(detail).toContainText(originalId);
    await expect(detail.getByLabel('원본 본문', { exact: true })).toHaveText(rawBody);
    await expect(detail.locator('script, img')).toHaveCount(0);
    const references = detail.getByText(/^원본 관계 \d+개$/);
    await references.click();
    await expect(detail.locator('details[open] pre')).toContainText(firstKey);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    const restoredPosition = await opener.boundingBox();
    expect(Math.abs(restoredPosition!.y - initialPosition!.y)).toBeLessThan(2);
    await expect(keyInput).toHaveValue(mappedKey);
    await expect(review).toContainText('적용을 막는 항목을 해결하세요');
    await expect(review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px 이관 원본 주소를 검토하고 영수증 집계와 저장된 연결을 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const unique = suffix();
  const originalKey = `ORI${unique}`, targetKey = `LNK${unique}`;
  const filename = `migration-origin-${unique}.csv`, title = `원본 연결 ${unique}`;
  const pkg = await upload(request, filename, jira(originalKey, title), `migration-origin-${unique}`);
  const base = `https://jira.example.test/${'team-context-'.repeat(12)}jira`;
  const sourceUrl = `${base}/browse/${originalKey}-1`;
  try {
    const { settings } = await open(page, request);
    await selectPackage(settings, filename);
    await settings.getByLabel(`새 프로젝트 키 원본 프로젝트 ${originalKey}`, { exact: true }).fill(targetKey);
    await settings.getByText('원본 주소와 제외 항목', { exact: true }).click();
    const baseInput = settings.getByLabel(`원본 주소 ${filename}`, { exact: true });
    await expect(baseInput).toHaveAttribute('placeholder', 'https://jira.example.test/jira');

    const invalid = `${base}?token=sample`;
    await baseInput.fill(invalid);
    const blocked = await preview(page, settings);
    expect(blocked.canApply).toBe(false);
    expect(blocked.configuration.sourceBaseUrls[pkg.id]).toBeNull();
    await expect(baseInput).toHaveValue(invalid);
    await expect(settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();

    await baseInput.fill(`${base}/`);
    const ready = await preview(page, settings);
    expect(ready.canApply, JSON.stringify(ready.notices)).toBe(true);
    expect(ready.samples.find(sample => sample.title === title)?.sourceUrl).toBe(sourceUrl);
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await expect(review.getByText('원본 링크 생성 1', { exact: true })).toBeVisible();
    await expect(review.getByText('원본 링크 미생성 0', { exact: true })).toBeVisible();
    await review.getByText('변환된 내용 견본', { exact: true }).click();
    const example = review.getByText(sourceUrl, { exact: true });
    await expect(example).toBeVisible();
    const exampleSize = await example.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(exampleSize.scrollWidth).toBeLessThanOrEqual(exampleSize.width);

    await acknowledge(settings, ready);
    const applied = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${ready.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const response = await applied;
    expect(response.ok(), await response.text()).toBe(true);
    const { import: receipt } = await response.json() as MigrationApplyResult;
    const receiptCounts = settings.getByRole('region', { name: '이관 당시 원본 링크 집계', exact: true });
    await expect(receiptCounts.getByText('원본 링크 생성 1', { exact: true })).toBeVisible();
    await expect(receiptCounts.getByText('원본 링크 미생성 0', { exact: true })).toBeVisible();
    await expect(settings.getByText('실제 이관 적용 중…', { exact: true })).toHaveCount(0);

    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const issue = snapshot.issues.find(item => item.projectId === receipt.projectIds[0] && item.title === title)!;
    expect(issue.key).toBe(`${targetKey}-1`);
    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const linkPanel = page.getByRole('dialog', { name: title, exact: true }).getByRole('region', { name: '기존 도구 연결', exact: true });
    const savedLink = linkPanel.getByRole('link', { name: '원본 열기', exact: true });
    await expect(savedLink).toHaveAttribute('href', sourceUrl);
    await expect(savedLink).toHaveAttribute('rel', 'noopener noreferrer');

    const outbound: string[] = [];
    await page.route('https://jira.example.test/**', async route => {
      outbound.push(route.request().url());
      await route.abort();
    });
    await page.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await page.getByRole('button', { name: '통합 검색', exact: true }).click();
    const quick = page.getByRole('dialog', { name: '통합 검색', exact: true });
    await quick.getByRole('textbox', { name: '통합 검색어', exact: true })
      .fill(`${base}/browse/${originalKey.toLowerCase()}-1?token=synthetic-jira-secret#private-section`);
    await expect(quick.getByText(title, { exact: true })).toBeVisible();
    await expect(quick.getByText('Jira 원본 주소', { exact: true })).toBeVisible();
    await quick.getByRole('button', { name: '전체 검색 결과', exact: true }).click();
    const result = page.getByRole('region', { name: '검색 결과', exact: true });
    await expect(page.getByRole('searchbox', { name: '검색어', exact: true })).toHaveValue(sourceUrl);
    const params = () => Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.split('?')[1]));
    await expect.poll(params).toEqual({ q: sourceUrl });
    await expect(result.getByText('Jira 원본 주소', { exact: true })).toBeVisible();
    await result.getByRole('button', { name: `${issue.key} 업무 열기`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
    expect(outbound).toEqual([]);
  } finally {
    await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('Jira 매핑·진단 검토 후 실제 이관하고 409·408·대기 중 탐색을 안전하게 처리한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const unique = suffix(), originalKey = `OLD${unique}`, key = `NEW${unique}`, filename = `migration-${unique}.csv`, title = `실제 이관 업무 ${unique}`;
  const pkg = await upload(request, filename, jira(originalKey, title), `migration-browser-${unique}`);
  const { settings, workspace } = await open(page, request);
  await selectPackage(settings, filename);
  const keyInput = settings.getByLabel(`새 프로젝트 키 원본 프로젝트 ${originalKey}`, { exact: true });
  await keyInput.fill(workspace.projects[0].key);
  const blocked = await preview(page, settings); expect(blocked.canApply).toBe(false); await expect(settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true })).toBeDisabled();
  await keyInput.fill(key); await expect(settings.getByRole('region', { name: '이관 적용 미리보기', exact: true })).toHaveCount(0);
  const ready = await preview(page, settings); expect(ready.canApply, JSON.stringify(ready.notices)).toBe(true); await acknowledge(settings, ready);
  const applyButton = settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }); await expect(applyButton).toBeEnabled();
  const applyPath = `/api/migrations/previews/${ready.id}/apply`;
  const applyRoute = `**${applyPath}`;
  async function expectInputsPreserved(status: number) {
    await expect(settings.getByRole('alert')).toContainText(`합성 ${status}`);
    await expect(keyInput).toHaveValue(key);
    await expect(applyButton).toBeEnabled();
    for (const code of ready.requiredAcknowledgements) await expect(settings.getByLabel(`이관 확인 ${code}`, { exact: true })).toBeChecked();
  }
  await page.route(applyRoute, route => route.fulfill({ status: 409, json: { error: '합성 409 응답' } }), { times: 1 });
  page.once('dialog', dialog => dialog.accept());
  await applyButton.click();
  await expectInputsPreserved(409);

  let release = () => {};
  let receive: (result: MigrationApplyResult) => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const committed = new Promise<MigrationApplyResult>(resolve => { receive = resolve; });
  await page.route(applyRoute, async route => {
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(201);
    receive(await response.json() as MigrationApplyResult);
    await gate;
    // The browser times out after the server has successfully committed the migration.
    await route.fulfill({ status: 408, json: { error: '합성 408 응답' } });
  }, { times: 1 });
  try {
    page.once('dialog', dialog => dialog.accept());
    await applyButton.click();
    const firstResult = await committed;
    expect(firstResult.duplicate).toBe(false);
    await expect(keyInput).toBeDisabled(); const actor = await page.getByLabel('작업자 선택', { exact: true }).inputValue();
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(workspace.users.find(user => user.id !== actor)!.id); await expect(page.getByLabel('작업자 선택', { exact: true })).toHaveValue(actor);
    expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
    release();
    await expectInputsPreserved(408);

    const replay = page.waitForResponse(value => new URL(value.url()).pathname === applyPath);
    page.once('dialog', dialog => dialog.accept());
    await applyButton.click();
    const response = await replay;
    expect(response.ok(), await response.text()).toBe(true);
    const result = await response.json() as MigrationApplyResult;
    expect(result.duplicate).toBe(true);
    expect(result.import.id).toBe(firstResult.import.id);
    const detail = settings.getByLabel('이관 영수증 상세', { exact: true });
    await expect(detail.getByRole('heading', { name: '원본 기록과 생성 프로젝트', exact: true })).toBeFocused();
    const followUp = detail.getByRole('region', { name: '이관 후속 확인', exact: true });
    const warningCodes = result.import.notices?.filter(notice => notice.severity === 'warning').map(notice => notice.code) ?? [];
    expect(warningCodes).toContain('SOURCE_CSV_HISTORY_NOT_PROVIDED');
    await expect(followUp.getByText(`경고 ${warningCodes.length}건`, { exact: true })).toBeVisible();
    await expect(followUp.getByText('제외한 원본 0건', { exact: true })).toBeVisible();
    await followUp.getByRole('button', { name: '적용 당시 경고 보기', exact: true }).click();
    await expect(detail.getByRole('heading', { name: '적용 당시 경고', exact: true })).toBeFocused();
    await expect(detail.getByText('경고 · SOURCE_CSV_HISTORY_NOT_PROVIDED', { exact: true })).toBeVisible();
    await expect(detail.locator('.migration-notice.is-info, .migration-notice.is-error')).toHaveCount(0);
    await detail.getByRole('button', { name: '전체 진단 보기', exact: true }).click();
    await expect(detail.getByRole('heading', { name: '적용 당시 진단', exact: true })).toBeFocused();

    const current = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const imported = current.issues.filter(value => value.title === title);
    expect(imported).toHaveLength(1);
    const issue = imported[0];
    expect(issue.projectId).toBe(result.import.projectIds[0]); expect(issue.createdAt).toBe('2020-01-02T03:04:05.000Z');
    const archives = await (await request.get(`/api/source-imports/${result.import.id}/records?kind=issue&limit=50`)).json() as SourceRecordPage;
    expect(archives.records).toHaveLength(1); expect(archives.records[0].record.sourceId).toBe('100');
    const origins = await (await request.get(`/api/resource-origins?resourceType=issue&resourceId=${issue.id}&limit=50`)).json() as SourceRecordPage; expect(origins.records.some(value => value.record.kind === 'issue')).toBe(true);
    const audit = await openReconciliation(settings);
    await audit.getByLabel('대조 상태', {exact:true}).selectOption('linked');
    await audit.getByLabel('대조 원본 종류', {exact:true}).selectOption('issue');
    const search = audit.getByLabel('대조 검색', {exact:true});
    const runSearch = audit.getByRole('button', {name:'대조 검색 실행',exact:true});
    await search.fill(`${originalKey}-999`);
    await runSearch.click();
    await expect(audit).toContainText('조건에 맞는 원본이 없습니다.');
    await search.fill(`${originalKey}-1`);
    await runSearch.click();
    const row = audit.getByRole('list', {name:'이관 결과 대조 목록',exact:true}).getByRole('listitem');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(title);
    await expect(row).toContainText(`${originalKey}-1`);
    await expect(row).toContainText('연결됨');
    const original = row.getByRole('button', {name:'보존 원본 열기',exact:true});
    await original.click();
    await expect(row.getByLabel('보존한 원본 본문', {exact:true})).toContainText('원래 설명');
    await row.getByRole('button', {name:'원본 이관 기록 상세 닫기',exact:true}).click();
    await expect(original).toBeFocused();
    await row.getByRole('button', {name:/현재 업무 열기/}).click();
    await page.getByRole('dialog').getByRole('button', { name: '원본 기록', exact: true }).click(); const originPanel = page.getByRole('region', { name: '원본 이관 기록', exact: true }); await expect(originPanel).toContainText('old-author');
    await originPanel.getByLabel('원본 이관 기록 종류', { exact: true }).selectOption('issue'); await originPanel.getByLabel('보존한 원본 기록 목록', { exact: true }).getByRole('button').first().click();
    await expect(originPanel.getByLabel('보존한 원본 본문', { exact: true })).toContainText('원래 설명');
  } finally { release(); await page.unroute(applyRoute); await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`); }
});

test('Confluence 문서·이력을 적용하고 원본 작성자와 긴 storage 원문의 전체 JSON을 보존한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const unique = suffix(), name = `원본 공간 ${unique}`, title = `보존 문서 ${unique}`, raw = ' \r\n<p>원래 <strong>서식</strong></p><ac:structured-macro ac:name="vendor-test"><ac:plain-text-body><![CDATA[안전한 원문]]></ac:plain-text-body></ac:structured-macro>' + '<p>긴 원문😀</p>'.repeat(2500) + '\r\n ', old = '<p>과거 문서</p>';
  const cd = (value: string) => `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`, prop = (key: string, value: string) => `<property name="${key}">${cd(value)}</property>`, ref = (key: string, type: string, id: string) => `<property name="${key}" class="${type}"><id name="id">${id}</id></property>`, obj = (type: string, id: string, body: string) => `<object class="${type}"><id name="${type === 'ConfluenceUserImpl' ? 'key' : 'id'}">${id}</id>${body}</object>`;
  const creator = ref('creator', 'ConfluenceUserImpl', 'old-user'), dates = prop('creationDate', '2019-01-02 03:04:05.000') + prop('lastModificationDate', '2020-01-02 03:04:05.000');
  const attachmentName = 'migration-notes.txt', bytes1 = Buffer.from('원본 첨부 첫 버전'), bytes2 = Buffer.from('원본 첨부 두 번째 버전');
  const xml = `<hibernate-generic>${obj('Space', '42', prop('key', `CF${unique}`) + prop('name', name))}${obj('ConfluenceUserImpl', 'old-user', prop('name', 'confluence-author'))}${obj('Page', '100', prop('title', title) + prop('version', '2') + ref('space', 'Space', '42') + creator + dates + '<collection name="historicalVersions"><element class="Page"><id name="id">101</id></element></collection>')}${obj('Page', '101', prop('title', '과거 제목') + prop('version', '1') + prop('contentStatus', 'historical') + ref('space', 'Space', '42') + ref('originalVersion', 'Page', '100') + creator + dates)}${obj('BodyContent', '200', prop('body', raw) + ref('content', 'Page', '100') + prop('bodyType', '2'))}${obj('BodyContent', '201', prop('body', old) + ref('content', 'Page', '101') + prop('bodyType', '2'))}${obj('Attachment', '700', prop('title', attachmentName) + prop('version', '2') + ref('containerContent', 'Page', '100') + creator + dates + '<collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection>')}${obj('Attachment', '701', prop('title', attachmentName) + prop('version', '1') + ref('containerContent', 'Page', '100') + ref('originalVersion', 'Attachment', '700') + creator + dates)}</hibernate-generic>`;
  const filename = `confluence-${unique}.zip`, pkg = await upload(request, filename, zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }, { path: 'attachments/100/700/1', bytes: bytes1 }, { path: 'attachments/100/700/2', bytes: bytes2 }]), `migration-confluence-${unique}`);
  try {
    const { settings } = await open(page, request); await selectPackage(settings, filename); await settings.getByLabel(`새 프로젝트 키 ${name}`, { exact: true }).fill(`CF${unique}`);
    const ready = await preview(page, settings); expect(ready.canApply, JSON.stringify(ready.notices)).toBe(true); await acknowledge(settings, ready);
    const applied = page.waitForResponse(value => value.url().endsWith(`/api/migrations/previews/${ready.id}/apply`)); page.once('dialog', dialog => dialog.accept()); await settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click(); const result = await (await applied).json() as MigrationApplyResult;
    const records = settings.getByRole('region', { name: '이관 영수증 원본 기록', exact: true }); await records.getByLabel('원본 이관 기록 종류', { exact: true }).selectOption('page'); await records.getByLabel('보존한 원본 기록 목록', { exact: true }).getByRole('button').filter({ hasText: title }).click();
    const detail = records.getByRole('region', { name: '보존한 원본 기록 상세', exact: true }); await expect(detail).toContainText('confluence-author'); await expect(detail).toContainText('부분 표시'); expect(await detail.getByLabel('보존한 원본 본문', { exact: true }).textContent()).toBe(raw.slice(0, 20000)); await expect(detail.locator('script, img')).toHaveCount(0);
    const downloadEvent = page.waitForEvent('download'); await detail.getByRole('button', { name: '원본 기록 전체 JSON 다운로드', exact: true }).click(); const download = await downloadEvent, path = await download.path(); expect(path).not.toBeNull(); const archive = JSON.parse(await readFile(path!, 'utf8')) as SourceRecordArchive; expect(archive.record.text).toBe(raw); expect(archive.sourceImportId).toBe(result.import.id); expect(archive.record.authorId).toBe('old-user');
    await records.getByLabel('원본 이관 기록 종류', { exact: true }).selectOption('revision'); await expect(records.getByLabel('보존한 원본 기록 목록', { exact: true })).toContainText('과거 제목');
    await settings.screenshot({ path: 'docs/screenshots/migration-apply.png' });
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot, document = snapshot.documents.find(value => value.title === title)!;
    await page.setViewportSize({width:360,height:820});
    const audit = await openReconciliation(settings);
    await audit.getByLabel('대조 원본 종류', {exact:true}).selectOption('attachment');
    const auditRows = audit.getByRole('list', {name:'이관 결과 대조 목록',exact:true}).getByRole('listitem');
    await expect(auditRows).toHaveCount(2);
    const contentHashes = new Set<string>();
    for (const row of await auditRows.all()) {
      await expect(row).toContainText(attachmentName);
      await expect(row).toContainText('연결됨');
      const checked = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/check-file'));
      await row.getByRole('button', {name:/첨부 파일 확인/}).click();
      const response = await checked;
      expect(response.ok(), await response.text()).toBe(true);
      const proof = await response.json() as SourceReconciliationFileCheck;
      expect(proof.status).toBe('verified');
      contentHashes.add(proof.sha256!);
      await expect(row).toContainText('SHA-256 일치');
    }
    expect(contentHashes).toEqual(new Set([bytes1,bytes2].map(bytes => createHash('sha256').update(bytes).digest('hex'))));
    await audit.getByLabel('대조 원본 종류', {exact:true}).selectOption('page');
    await expect(auditRows).toHaveCount(1);
    const legacyDraft = page.getByRole('region', { name:'기존 도구 원본 분석',exact:true }).getByLabel('원본 인스턴스 식별값', {exact:true});
    await legacyDraft.fill('대조 화면에서 이동을 취소한 초안');
    const openDocument = auditRows.getByRole('button', {name:/현재 문서 열기/});
    page.once('dialog', dialog => dialog.dismiss());
    await openDocument.click();
    await expect(legacyDraft).toHaveValue('대조 화면에서 이동을 취소한 초안');
    page.once('dialog', dialog => dialog.accept());
    await openDocument.click();
    await expect(page.getByRole('textbox', {name:'문서 제목',exact:true})).toHaveValue(document.title);
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button', { name: '파일 첨부', exact: true }).click();
    const attachmentPanel = page.getByRole('region', { name: '첨부파일', exact: true }); let versionRequests = 0; page.on('request', value => { if (value.url().endsWith('/versions')) versionRequests++; });
    await attachmentPanel.getByRole('button', { name: `${attachmentName} 버전`, exact: true }).click(); const versions = attachmentPanel.getByRole('region', { name: `${attachmentName} 보존 버전`, exact: true }); await expect(versions.getByRole('link', { name: /다운로드/ })).toHaveCount(2);
    for (const [label, bytes] of [['1', bytes1], ['2', bytes2]] as const) { const event = page.waitForEvent('download'); await versions.getByRole('link', { name: `${attachmentName} 버전 ${label} 다운로드`, exact: true }).click(); const file = await event, path = await file.path(); expect(await readFile(path!)).toEqual(bytes); }
    await attachmentPanel.getByRole('button', { name: `${attachmentName} 버전`, exact: true }).click(); await attachmentPanel.getByRole('button', { name: `${attachmentName} 버전`, exact: true }).click(); await expect(versions).toBeVisible(); expect(versionRequests).toBe(1);
    await attachmentPanel.getByLabel('첨부할 파일 선택', { exact: true }).setInputFiles({ name: 'standalone.txt', mimeType: 'text/plain', buffer: Buffer.from('이관 이후 일반 첨부') }); await expect(attachmentPanel.getByRole('link', { name: 'standalone.txt', exact: true })).toBeVisible(); await expect(attachmentPanel.getByRole('button', { name: 'standalone.txt 버전', exact: true })).toHaveCount(0);
  } finally { await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`); }
});

test('360px에서 이관 작성자 매핑과 대체 기록을 확인하고 보존 원본과 다시 대조한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const unique = suffix(), filename = `authors-${unique}.zip`, space = `작성자 검증 공간 ${unique}`;
  const sourceAuthor = 'private-source-author-mapped', fallbackAuthor = 'private-source-author-unmapped';
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const ref = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`;
  const object = (type: string, id: number | string, data: string) => `<object class="${type}"><id name="${type === 'ConfluenceUserImpl' ? 'key' : 'id'}">${id}</id>${data}</object>`;
  const createPage = (id: number, title: string, author?: string) => [
    object('Page', id, prop('title', title) + prop('version', '1') + ref('space', 'Space', '42') +
      prop('creationDate', '2020-01-02T00:00:00Z') + (author ? ref('creator', 'ConfluenceUserImpl', author) : '')),
    object('BodyContent', id + 1000, prop('body', '<![CDATA[<p>private-source-document-body</p>]]>') + ref('content', 'Page', String(id))),
  ].join('');
  const mappedTitle = `매핑한 작성자의 문서 ${unique}`, missingTitle = `작성자가 없는 원본 문서 ${unique}`;
  const xml = `<hibernate-generic>${object('Space', 42, prop('name', space) + prop('key', `AT${unique}`))}
    ${object('ConfluenceUserImpl', 'source-mapped', prop('name', sourceAuthor))}
    ${object('ConfluenceUserImpl', 'source-unmapped', prop('name', fallbackAuthor))}
    ${createPage(100, mappedTitle, 'source-mapped')}${createPage(101, missingTitle)}
    ${Array.from({ length: 21 }, (_, index) => createPage(200 + index, `대체 작성자 문서 ${unique}-${index}`, 'source-unmapped')).join('')}
  </hibernate-generic>`;
  const pkg = await upload(request, filename, zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]), `author-audit-${unique}`);
  const created: DocPage[] = [];
  try {
    const { settings, workspace } = await open(page, request);
    const actorId = await page.getByLabel('작업자 선택', { exact: true }).inputValue();
    const mappedUser = workspace.users.find(user => user.id !== actorId)!;
    const actor = workspace.users.find(user => user.id === actorId)!;
    expect(mappedUser).toBeTruthy();
    expect(actor).toBeTruthy();
    await selectPackage(settings, filename);
    const before = await preview(page, settings);
    expect(before.authorAttribution?.find(group => group.packageId === pkg.id)?.kinds).toMatchObject([
      { kind: 'document', counts: { 'unmapped-fallback': 22, 'missing-fallback': 1 } },
    ]);
    const guidance = settings.getByRole('region', { name: '작성자 매핑 미리보기', exact: true });
    const counts = guidance.getByLabel('문서 작성자 건수', { exact: true });
    await expect(counts.getByText('매핑 없음 · 이관 작업자로 기록', { exact: true }).locator('..').locator('dd')).toHaveText('22');

    await settings.getByText('사용자 매핑', { exact: true }).click();
    await settings.getByLabel(`사용자 매핑 ${sourceAuthor}`, { exact: true }).selectOption(mappedUser.id);
    await expect(guidance).toBeHidden();
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    await expect(guidance.getByText(filename, { exact: true })).toBeVisible();
    await expect(counts.getByText('팀원 매핑', { exact: true }).locator('..').locator('dd')).toHaveText('1');
    await expect(counts.getByText('매핑 없음 · 이관 작업자로 기록', { exact: true }).locator('..').locator('dd')).toHaveText('21');
    await expect(counts.getByText('원본 작성자 없음 · 이관 작업자로 기록', { exact: true }).locator('..').locator('dd')).toHaveText('1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    const download = page.waitForEvent('download');
    await settings.getByRole('button', { name: '이관 사전 검토 JSON 내보내기', exact: true }).click();
    const preflight = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    expect(preflight.status).toBe('review');
    expect(preflight.authorAttribution).toEqual([{ packageId: pkg.id, kinds: [{ kind: 'document',
      counts: { mapped: 1, 'unmapped-fallback': 21, 'missing-fallback': 1, retained: 0 } }] }]);
    expect(JSON.stringify(preflight)).not.toMatch(/private-source|authorId/);

    await acknowledge(settings, plan);
    const applied = page.waitForResponse(value => value.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const appliedResponse = await applied;
    expect(appliedResponse.status(), await appliedResponse.text()).toBe(201);
    const { import: receipt } = await appliedResponse.json() as MigrationApplyResult;
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    created.push(...snapshot.documents.filter(document => receipt.projectIds.includes(document.projectId ?? '')));
    expect(created.find(document => document.title === mappedTitle)?.authorId).toBe(mappedUser.id);
    const missing = created.find(document => document.title === missingTitle)!;
    expect(missing.authorId).toBe(actorId);

    const reconciliation = await openReconciliation(settings);
    const report = reconciliation.getByRole('region', { name: '이관 작성자 검증', exact: true });
    const coverage = () => page.waitForResponse(response => new URL(response.url()).pathname === `/api/source-imports/${receipt.id}/reconciliation/audit`);
    const details = () => page.waitForResponse(response => new URL(response.url()).pathname === `/api/source-imports/${receipt.id}/reconciliation/author-findings`);
    const firstAudit = coverage();
    await reconciliation.getByRole('button', { name: '전체 이관 검증', exact: true }).click();
    const auditResponse = await firstAudit;
    expect(auditResponse.ok(), await auditResponse.text()).toBe(true);
    const audit = await auditResponse.json() as SourceReconciliationAudit;
    const mapped = report.getByRole('button', { name: '문서 팀원 매핑 1건 보기', exact: true });
    const mappedDetails = details();
    await mapped.click();
    const pageResponse = await mappedDetails;
    expect(pageResponse.ok(), await pageResponse.text()).toBe(true);
    expect(new URL(pageResponse.url()).searchParams.get('expectedFingerprint')).toBe(audit.authorAttribution?.fingerprint);
    const mappedPage = await pageResponse.json() as SourceReconciliationAuthorFindingsPage;
    expect(mappedPage.rows).toMatchObject([{ sourceId: '100', expectedAuthorId: mappedUser.id, actualAuthorId: mappedUser.id }]);
    const list = report.getByRole('list', { name: '작성자 대조 원본 목록', exact: true });
    await expect(list).toContainText(`이관 시 작성자 ${mappedUser.name}`);
    const archiveButton = list.getByRole('button', { name: '작성자 원본 100 열기', exact: true });
    await archiveButton.click();
    const archive = list.getByRole('region', { name: '보존한 원본 기록 상세', exact: true });
    await expect(archive).toContainText(mappedTitle);
    await expect(archive.getByLabel('보존한 원본 본문', { exact: true })).toContainText('private-source-document-body');
    await report.getByRole('button', { name: '작성자 목록 닫기', exact: true }).click();
    await expect(mapped).toBeFocused();

    await report.getByRole('button', { name: '문서 매핑 없음 · 이관 작업자로 기록 21건 보기', exact: true }).click();
    await expect(list.getByRole('listitem')).toHaveCount(20);
    const next = details();
    await report.getByRole('button', { name: '작성자 목록 다음 페이지', exact: true }).click();
    const nextResponse = await next;
    expect(nextResponse.ok(), await nextResponse.text()).toBe(true);
    expect(new URL(nextResponse.url()).searchParams.get('offset')).toBe('20');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText(`현재 작성자 ${actor.name}`);
    await report.getByRole('button', { name: '작성자 목록 닫기', exact: true }).click();

    const deleted = await request.delete(`/api/documents/${missing.id}?expectedVersion=${missing.version}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
    const { trashEntryId } = await deleted.json();
    const purged = await request.delete(`/api/trash/${trashEntryId}`);
    expect(purged.ok(), await purged.text()).toBe(true);
    const stale = details();
    await report.getByRole('button', { name: '문서 원본 작성자 없음 · 이관 작업자로 기록 1건 보기', exact: true }).click();
    expect((await stale).status()).toBe(409);
    await expect(report.getByRole('alert')).toHaveText('작성자 대조 결과가 바뀌었습니다. 전체 이관 검증을 다시 실행해 주세요.');
    const refreshed = coverage();
    await report.getByRole('button', { name: '전체 이관 검증 다시 실행', exact: true }).click();
    expect((await refreshed).ok()).toBe(true);
    await expect(report.getByRole('button', { name: '문서 현재 대상 확인 불가 1건 보기', exact: true })).toBeVisible();
    await expect(report.getByRole('button', { name: '문서 원본 작성자 없음 · 이관 작업자로 기록 1건 보기', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await Promise.all(created.map(document => request.delete(`/api/documents/${document.id}`)));
    await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('360px 전체 이관 검증은 현재 필터와 별개로 모든 첨부 버전을 검사하고 누락 결과를 내려받는다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const unique = suffix(), space = `검증 공간 ${unique}`;
  const mainTitle = '이관 검증 문서', otherTitle = '다른 패키지의 검증 문서';
  const mainBody = '검증 보고서에 복사하지 않을 원문';
  const date = '<property name="creationDate">2020-01-02T00:00:00Z</property>';
  const owner = '<property name="containerContent" class="Page"><id name="id">100</id></property>';
  const xml = `<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">BA${unique}</property><property name="name">${space}</property></object>
    <object class="Page"><id name="id">100</id><property name="title">${mainTitle}</property><property name="version">1</property><property name="space" class="Space"><id name="id">42</id></property>${date}</object>
    <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>${mainBody}</p>]]></property><property name="content" class="Page"><id name="id">100</id></property></object>
    <object class="Attachment"><id name="id">700</id><property name="title">versioned.txt</property><property name="version">2</property>${owner}${date}<collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection></object>
    <object class="Attachment"><id name="id">701</id><property name="title">versioned.txt</property><property name="version">1</property>${owner}${date}<property name="originalVersion" class="Attachment"><id name="id">700</id></property></object>
    <object class="Attachment"><id name="id">702</id><property name="title">removed-after-import.txt</property><property name="version">1</property>${owner}${date}</object>
  </hibernate-generic>`;
  const first = Buffer.from('첫 바이너리'), latest = Buffer.from('최신 버전 파일'), removed = Buffer.from('이관 후 삭제할 파일');
  const filename = `receipt-${unique}.zip`;
  const pkg = await upload(request, filename, zip([
    { path: 'entities.xml', bytes: Buffer.from(xml) },
    { path: 'attachments/100/700/1', bytes: first },
    { path: 'attachments/100/700/2', bytes: latest },
    { path: 'attachments/100/702/1', bytes: removed },
  ]), `receipt-${unique}`);
  const otherName = `receipt-other-${unique}.zip`;
  const otherXml = `<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">BB${unique}</property><property name="name">별도 검증 공간 ${unique}</property></object>
    <object class="Page"><id name="id">100</id><property name="title">${otherTitle}</property><property name="version">1</property><property name="space" class="Space"><id name="id">42</id></property>${date}</object>
    <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>별도 패키지 원문</p>]]></property><property name="content" class="Page"><id name="id">100</id></property></object>
  </hibernate-generic>`;
  const otherPackage = await upload(request, otherName, zip([{ path: 'entities.xml', bytes: Buffer.from(otherXml) }]), `receipt-other-${unique}`);
  try {
    const { settings } = await open(page, request);
    await settings.getByLabel(`이관 패키지 ${otherName}`, { exact: true }).check();
    await selectPackage(settings, filename);
    const plan = await preview(page, settings);
    expect(plan.canApply, JSON.stringify(plan.notices)).toBe(true);
    expect(plan.counts.attachmentVersions).toBe(3);
    await acknowledge(settings, plan);
    const applied = page.waitForResponse(value => value.url().endsWith(`/api/migrations/previews/${plan.id}/apply`));
    page.once('dialog', dialog => dialog.accept());
    await settings.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const application = await applied;
    expect(application.ok(), await application.text()).toBe(true);
    const { import: receipt } = await application.json() as MigrationApplyResult;
    await expect(settings.getByLabel('이관 영수증 상세', { exact: true })
      .getByRole('heading', { name: '원본 기록과 생성 프로젝트', exact: true })).toBeFocused();

    const reconciliation = await openReconciliation(settings);
    const kinds = reconciliation.getByLabel('대조 원본 종류', { exact: true });
    const recordRows = reconciliation.getByRole('list', { name: '이관 결과 대조 목록', exact: true }).getByRole('listitem');
    await kinds.selectOption('page');
    await expect(recordRows).toHaveCount(2);
    const run = reconciliation.getByRole('button', { name: '전체 이관 검증', exact: true });
    const audit = reconciliation.getByRole('region', { name: '전체 이관 검증', exact: true });
    const comparison = audit.getByRole('region', { name: '이관 당시 기록과 현재 비교', exact: true });
    const coverage = audit.getByRole('region', { name: '이관 티켓·문서 대조', exact: true });
    const coveragePackages = coverage.getByRole('list', { name: '원본 패키지별 티켓·문서', exact: true }).getByRole('listitem');
    const primaryPackage = coveragePackages.filter({ has: page.getByText(filename, { exact: true }) });
    const output = audit.getByRole('button', { name: '검증 결과 JSON 내보내기', exact: true });
    const filter = audit.getByLabel('첨부 검증 상태', { exact: true });
    const rows = audit.getByRole('list', { name: '첨부 검증 목록', exact: true }).getByRole('listitem');
    async function checkAll() {
      const ready = page.waitForResponse(value => new URL(value.url()).pathname === `/api/source-imports/${receipt.id}/reconciliation/audit`);
      await run.click();
      const response = await ready;
      expect(response.ok(), await response.text()).toBe(true);
      expect(new URL(response.url()).searchParams.get('expectedVersion')).toBe(String(receipt.version));
      await expect(output).toBeVisible();
      return await response.json() as SourceReconciliationAudit;
    }

    const good = await checkAll();
    expect(good.jiraStatusHistory).toBeNull();
    expect(good.primaryRecords).toHaveLength(2);
    for (const packageId of [pkg.id, otherPackage.id]) {
      expect(good.primaryRecords.find(item => item.packageId === packageId)).toEqual({
        packageId, kind: 'page', counts: { linked: 1, trashed: 0, missing: 0, 'archive-only': 0, excluded: 0 },
        invalidTargets: 0, dispositionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }
    await expect(primaryPackage).toHaveCount(1);
    await expect(primaryPackage.getByText(filename, { exact: true })).toBeVisible();
    await expect(primaryPackage.getByText('Confluence 페이지 1개', { exact: true })).toBeVisible();
    await expect(primaryPackage.getByText('연결됨', { exact: true }).locator('..').locator('dd')).toHaveText('1');
    await expect(primaryPackage.getByText('확인 필요', { exact: true })).toHaveCount(0);
    await expect(audit.getByRole('region', { name: 'Jira 상태 변경 검증', exact: true })).toHaveCount(0);
    expect(good.attachmentCounts).toEqual({ verified: 3, missing: 0, corrupt: 0, unbound: 0, excluded: 0, unreadable: 0 });
    expect(new Set(good.attachments.map(row => row.sha256))).toEqual(new Set([first, latest, removed].map(bytes => createHash('sha256').update(bytes).digest('hex'))));
    expect(good.integrity.status).toBe('verified');
    await expect(comparison.getByText('보존 원본 검증값 일치', { exact: true })).toBeVisible();
    await expect(comparison.getByLabel('영수증 전체 건수 비교', { exact: true }).getByText('이관 당시 3개 · 현재 3개', { exact: true })).toBeVisible();
    await expect(filter).toHaveValue('all');
    await expect(rows).toHaveCount(3);
    const box = await audit.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(361);
    expect(await audit.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil(box!.width));

    const search = reconciliation.getByLabel('대조 검색', { exact: true });
    const status = reconciliation.getByLabel('대조 상태', { exact: true });
    const packages = reconciliation.getByLabel('대조 원본 패키지', { exact: true });
    await status.selectOption('excluded');
    await kinds.selectOption('attachment');
    await search.fill('다른 검색어');
    await reconciliation.getByRole('button', { name: '대조 검색 실행', exact: true }).click();
    await expect(reconciliation.getByText('조건에 맞는 원본이 없습니다.', { exact: true })).toBeVisible();
    const scopedPage = page.waitForResponse(value => {
      const url = new URL(value.url());
      return url.pathname === `/api/source-imports/${receipt.id}/reconciliation` && url.searchParams.get('packageId') === pkg.id;
    });
    await primaryPackage.getByRole('button', { name: '연결됨 1개 보기', exact: true }).click();
    const scoped = await scopedPage;
    expect(scoped.ok(), await scoped.text()).toBe(true);
    expect(Object.fromEntries(new URL(scoped.url()).searchParams)).toMatchObject({ packageId: pkg.id, kind: 'page', status: 'linked', offset: '0' });
    expect(new URL(scoped.url()).searchParams.has('q')).toBe(false);
    await expect(reconciliation.getByRole('heading', { name: '대조 원본 목록', exact: true })).toBeFocused();
    await expect(packages).toHaveValue(pkg.id);
    await expect(search).toHaveValue('');
    await expect(status).toHaveValue('linked');
    await expect(kinds).toHaveValue('page');
    await expect(reconciliation.getByLabel('선택한 패키지 원본 대조 건수', { exact: true })).toBeVisible();
    await expect(recordRows).toHaveCount(1);
    await expect(recordRows).toContainText(mainTitle);
    const original = recordRows.getByRole('button', { name: '보존 원본 열기', exact: true });
    await original.click();
    await expect(recordRows.getByLabel('보존한 원본 본문', { exact: true })).toContainText(mainBody);
    await recordRows.getByRole('button', { name: '원본 이관 기록 상세 닫기', exact: true }).click();
    await expect(original).toBeFocused();
    await packages.selectOption(otherPackage.id);
    await expect(recordRows).toHaveCount(1);
    await expect(recordRows).toContainText(otherTitle);
    await reconciliation.getByRole('button', { name: '패키지 필터 해제', exact: true }).click();
    await expect(packages).toHaveValue('');
    await expect(recordRows).toHaveCount(2);

    const target = good.attachments.find(row => row.sourceId === '702')!.fileId;
    expect(target).toBeTruthy();
    const deletion = await request.delete(`/api/attachments/${target}`);
    expect(deletion.ok(), await deletion.text()).toBe(true);
    const { trashItemId } = await deletion.json() as { trashItemId: string };
    const inTrash = await checkAll();
    expect(inTrash.attachmentCounts).toEqual(good.attachmentCounts);
    expect(inTrash.attachments.find(row => row.fileId === target)).toMatchObject({ recordStatus: 'trashed', status: 'verified' });
    const purge = await request.delete(`/api/trash/items/${trashItemId}`);
    expect(purge.ok(), await purge.text()).toBe(true);
    const mixed = await checkAll();
    expect(mixed.attachmentCounts).toEqual({ ...good.attachmentCounts, verified: 2, missing: 1 });
    await expect(filter).toHaveValue('findings');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('removed-after-import.txt');
    await expect(rows.first()).toContainText('파일 누락');
    await expect(rows.first()).toContainText(pkg.sha256);
    await expect(kinds).toHaveValue('page');

    const downloadEvent = page.waitForEvent('download');
    await output.click();
    const download = await downloadEvent;
    const path = await download.path();
    expect(path).not.toBeNull();
    const json = await readFile(path!, 'utf8');
    expect(JSON.parse(json)).toEqual(mixed);

    const auditPath = `/api/source-imports/${receipt.id}/reconciliation/audit`;
    const primary = good.primaryRecords.find(item => item.packageId === pkg.id)!;
    const archivedOnly: SourceReconciliationAudit = {
      ...good,
      primaryRecords: [{ ...primary, counts: { ...primary.counts, linked: 0, 'archive-only': 1 } }],
    };
    await page.route(url => url.pathname === auditPath, route => route.fulfill({ json: archivedOnly }), { times: 1 });
    await checkAll();
    await expect(primaryPackage.getByText('확인 필요', { exact: true })).toBeVisible();
    await expect(primaryPackage.getByText('원본 보관만', { exact: true }).locator('..').locator('dd')).toHaveText('1');

    const packageResult = good.integrity.packages.find(item => item.filename === filename)!;
    const records = { ...packageResult.records, observed: packageResult.records.observed - 1 };
    const boundAttachments = { ...packageResult.boundAttachments, observed: packageResult.boundAttachments.observed - 1 };
    // Exercise the result presentation for a missing source row while the surviving files all verify.
    const missingSource: SourceReconciliationAudit = {
      ...good,
      attachmentCounts: { ...good.attachmentCounts, verified: 2 },
      attachments: good.attachments.filter(row => row.sourceId !== '702'),
      integrity: { ...good.integrity, status: 'mismatch', records, boundAttachments, packages: [{
        ...packageResult, status: 'mismatch', records, boundAttachments,
        recordsSha256: { ...packageResult.recordsSha256, observed: '0'.repeat(64) },
      }] },
    };
    await page.route(url => url.pathname === auditPath, route => route.fulfill({ json: missingSource }), { times: 1 });
    await checkAll();
    const mismatch = comparison.getByRole('list', { name: '확인이 필요한 이관 패키지', exact: true });
    await expect(mismatch.getByText(filename, { exact: true })).toBeVisible();
    await expect(mismatch.getByText('원본 목록 검증값 불일치', { exact: true })).toBeVisible();
    await expect(mismatch.getByText('이관 당시 3개 · 현재 2개', { exact: true })).toBeVisible();
    await filter.selectOption('findings');
    await expect(rows).toHaveCount(0);
    await expect(mismatch.getByText(filename, { exact: true })).toBeVisible();

    const legacy: SourceReconciliationAudit = {
      ...good,
      integrity: { ...good.integrity, status: 'counts-only', packages: [{
        ...packageResult, status: 'unavailable', records: { ...packageResult.records, expected: null },
        boundAttachments: { ...packageResult.boundAttachments, expected: null },
        recordsSha256: { ...packageResult.recordsSha256, expected: null },
      }] },
    };
    await page.route(url => url.pathname === auditPath, route => route.fulfill({ json: legacy }), { times: 1 });
    await checkAll();
    await expect(comparison.getByText('건수만 비교', { exact: true })).toBeVisible();
    await expect(comparison.getByText('이 영수증에는 패키지별 검증값이 없습니다.', { exact: true })).toBeVisible();
    await expect(comparison.getByText('보존 원본 검증값 일치', { exact: true })).toHaveCount(0);
    expect(json).not.toContain(mainBody);
    await filter.selectOption('all');
    await expect(rows).toHaveCount(3);
  } finally {
    for (const item of [pkg, otherPackage]) await request.delete(`/api/legacy-import/packages/${item.id}?expectedVersion=${item.version}`);
  }
});

test('360px 이관 검증에서 Jira 변경과 표시 대상을 비교하고 원본을 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const unique = suffix(), filename = `jira-history-audit-${unique}.zip`;
  const sourceInstance = `jira-history-audit-${unique}`;
  const author = `보고서에 넣지 않는 작성자 ${unique}`;
  const state = `보고서에 넣지 않는 원본 상태 ${unique}`;
  const created = '2025-01-01T00:00:00Z';
  const additionalChanges = Array.from({ length: 20 }, (_, index) => {
    const group = 600 + index;
    return `<ChangeGroup id="${group}" issue="4403" created="18/Jan/25 10:20 AM"/>
      <ChangeItem id="${group + 1000}" group="${group}" field="status" fieldtype="jira" oldvalue="2" oldstring="In Progress" newvalue="1" newstring="Open"/>`;
  }).join('');
  const xml = `<entity-engine-xml version="9.12">
    <ApplicationUser id="10" userKey="actor-jira" lowerUserName="jira-user"/>
    <User id="11" userName="jira-user" displayName="${author}" active="1"/>
    <Project id="4100" pkey="JH${unique}" name="원본 상태 프로젝트"/>
    <Status id="1" pname="Open"/><Status id="2" pname="In Progress"/><IssueType id="3" pname="Task"/>
    <Issue id="4401" project="4100" number="1" summary="표시되는 변경의 업무" status="1" issuetype="3" created="${created}" updated="${created}"/>
    <Issue id="4402" project="4100" number="2" summary="휴지통으로 이동할 업무" status="1" issuetype="3" created="${created}" updated="${created}"/>
    <Issue id="4403" project="4100" number="3" summary="페이지 조회 중 이동할 업무" status="1" issuetype="3" created="${created}" updated="${created}"/>
    <ChangeGroup id="501" issue="4401" author="jira-user" created="2025-01-03T13:20:00Z"/>
    <ChangeGroup id="502" issue="4401" created="18/Jan/25 10:20 AM"/>
    <ChangeGroup id="503" issue="4402" author="jira-user" created="2025-01-03T13:20:00Z"/>
    <ChangeItem id="1501" group="501" field="status" fieldtype="jira" oldvalue="1" oldstring="${state}" newvalue="2" newstring="In Progress"/>
    <ChangeItem id="1502" group="502" field="status" fieldtype="jira" oldvalue="2" oldstring="In Progress" newvalue="1" newstring="Open"/>
    <ChangeItem id="1503" group="503" field="status" fieldtype="jira" oldvalue="1" oldstring="Open" newvalue="2" newstring="In Progress"/>
    ${additionalChanges}
  </entity-engine-xml>`;
  const pkg = await upload(request, filename, zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]), sourceInstance);
  try {
    const { import: receipt } = await importIntoProject(request, pkg, `HA${unique}`, '상태 변경 검증 프로젝트');
    const { settings, workspace } = await open(page, request);
    const issue = workspace.issues.find(item => item.projectId === receipt.projectIds[0] && item.title === '휴지통으로 이동할 업무')!;
    expect(issue).toBeTruthy();
    const deletion = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
    expect(deletion.ok(), await deletion.text()).toBe(true);
    const { trashEntryId } = await deletion.json() as { trashEntryId: string };

    await settings.getByRole('region', { name: '완료한 이관 영수증', exact: true }).getByRole('button', { name: new RegExp(filename) }).click();
    const reconciliation = await openReconciliation(settings);
    const kind = reconciliation.getByLabel('대조 원본 종류', { exact: true });
    const status = reconciliation.getByLabel('대조 상태', { exact: true });
    const search = reconciliation.getByRole('searchbox', { name: '대조 검색' });
    await kind.selectOption('issue');
    await status.selectOption('linked');
    await search.fill('필터에 걸리지 않는 변경');
    await reconciliation.getByRole('button', { name: '대조 검색 실행' }).click();
    await expect(reconciliation.getByText('조건에 맞는 원본이 없습니다.')).toBeVisible();

    const auditPath = `/api/source-imports/${receipt.id}/reconciliation/audit`;
    const findingsPath = `/api/source-imports/${receipt.id}/reconciliation/jira-status-findings`;
    const sourcePath = `/api/source-imports/${receipt.id}/records/`;
    const rawRequests: string[] = [];
    const findingRequests: URLSearchParams[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith(sourcePath)) rawRequests.push(url.pathname);
      if (url.pathname === findingsPath) findingRequests.push(url.searchParams);
    });
    const run = reconciliation.getByRole('button', { name: '전체 이관 검증', exact: true });
    const panel = reconciliation.getByRole('region', { name: 'Jira 상태 변경 검증', exact: true });
    const openFindings = panel.getByRole('button', { name: '확인할 Jira 변경 열기', exact: true });
    const findings = panel.getByRole('region', { name: '확인할 Jira 변경', exact: true });
    const findingType = findings.getByRole('combobox', { name: '확인할 Jira 변경 유형', exact: true });
    const rows = findings.getByRole('list', { name: 'Jira 변경 원본 목록', exact: true }).getByRole('listitem');
    async function inspect() {
      const ready = page.waitForResponse(value => new URL(value.url()).pathname === auditPath);
      await run.click();
      const response = await ready;
      expect(response.ok(), await response.text()).toBe(true);
      await expect(panel).toBeVisible();
      return await response.json() as SourceReconciliationAudit;
    }
    async function find(action: () => Promise<unknown>, expected = 200) {
      const ready = page.waitForResponse(value => new URL(value.url()).pathname === findingsPath);
      await action();
      const response = await ready;
      expect(response.status(), await response.text()).toBe(expected);
      return response;
    }

    const inspected = await inspect();
    expect(inspected.jiraStatusHistory).toMatchObject({
      sourceChanges: 23, projected: { count: 22 }, unavailable: 1, unresolvedTime: 21, unresolvedAuthor: 21,
    });
    const counts = panel.getByLabel('Jira 상태 변경 건수', { exact: true });
    await expect(counts.getByText('보존 원본의 변경', { exact: true }).locator('..').locator('dd')).toHaveText('23');
    await expect(counts.getByText('현재 업무에 표시', { exact: true }).locator('..').locator('dd')).toHaveText('22');
    await expect(counts.getByText('표시 대상 확인 필요', { exact: true }).locator('..').locator('dd')).toHaveText('1');
    await expect(panel).toContainText('시각 미확인 21개 · 작성자 미확인 21개');
    await expect(panel).not.toContainText(author);
    await expect(panel).not.toContainText(state);
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(361);
    expect(await panel.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil(box!.width));

    expect(findingRequests).toHaveLength(0);
    expect(rawRequests).toHaveLength(0);
    const unavailable = await (await find(() => openFindings.click())).json() as SourceReconciliationJiraStatusFindingsPage;
    await expect(findings.getByRole('heading', { name: '확인할 Jira 변경', exact: true })).toBeFocused();
    await expect(findingType).toHaveValue('unavailable');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(sourceInstance);
    await expect(rows.first()).toContainText('원본 업무 4402');
    await expect(rows.first()).toContainText('대상 업무가 휴지통에 있습니다.');
    await expect(kind).toHaveValue('issue');
    await expect(status).toHaveValue('linked');
    await expect(search).toHaveValue('필터에 걸리지 않는 변경');
    expect(rawRequests).toHaveLength(0);
    const openSource = findings.getByRole('button', { name: `Jira 변경 원본 ${sourceInstance} / 503 열기`, exact: true });
    await openSource.click();
    await expect(rows.first().getByRole('region', { name: '보존한 원본 기록 상세', exact: true })).toBeVisible();
    expect(rawRequests).toEqual([`${sourcePath}${unavailable.rows[0].sourceRecordId}`]);
    expect(await findings.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil((await findings.boundingBox())!.width));
    await rows.first().getByRole('button', { name: '원본 이관 기록 상세 닫기', exact: true }).click();
    await expect(openSource).toBeFocused();

    const first = await (await find(() => findingType.selectOption('unresolved-time'))).json() as SourceReconciliationJiraStatusFindingsPage;
    expect(first.total).toBe(21);
    await expect(rows).toHaveCount(20);
    const next = findings.getByRole('button', { name: 'Jira 변경 다음 페이지', exact: true });
    const previous = findings.getByRole('button', { name: 'Jira 변경 이전 페이지', exact: true });
    const second = await (await find(() => next.click())).json() as SourceReconciliationJiraStatusFindingsPage;
    await expect(rows).toHaveCount(1);
    expect(findingRequests.at(-1)?.get('expectedFingerprint')).toBe(first.fingerprint);
    expect(first.rows.map(row => row.sourceRecordId)).not.toContain(second.rows[0].sourceRecordId);
    await find(() => previous.click());
    await expect(rows).toHaveCount(20);

    const pageChangeIssue = workspace.issues.find(item => item.projectId === receipt.projectIds[0] && item.title === '페이지 조회 중 이동할 업무')!;
    const pageChangeDeletion = await request.delete(`/api/issues/${pageChangeIssue.id}?expectedVersion=${pageChangeIssue.version}`);
    expect(pageChangeDeletion.ok(), await pageChangeDeletion.text()).toBe(true);
    const { trashEntryId: pageChangeTrashId } = await pageChangeDeletion.json() as { trashEntryId: string };
    await find(() => next.click(), 409);
    await expect(findings.getByRole('alert')).toContainText('Jira 변경 목록이 바뀌었습니다.');
    await find(() => findings.getByRole('button', { name: '처음부터 다시 조회', exact: true }).click());
    expect(findingRequests.at(-1)?.has('expectedFingerprint')).toBe(false);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('원본 변경 502');
    await find(() => findingType.selectOption('unresolved-author'));
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('원본 변경 502');
    expect(rawRequests).toHaveLength(1);
    await findings.getByRole('button', { name: '확인 목록 닫기', exact: true }).click();
    await expect(openFindings).toBeFocused();

    const restoration = await request.post(`/api/trash/${trashEntryId}/restore`);
    expect(restoration.ok(), await restoration.text()).toBe(true);
    const pageChangeRestoration = await request.post(`/api/trash/${pageChangeTrashId}/restore`);
    expect(pageChangeRestoration.ok(), await pageChangeRestoration.text()).toBe(true);
    const restored = await inspect();
    expect(restored.integrity.status).toBe('verified');
    expect(restored.jiraStatusHistory).toMatchObject({
      sourceChanges: 23, projected: { count: 23 }, unavailable: 0, unresolvedTime: 21, unresolvedAuthor: 21,
    });
    await expect(panel.getByText('확인 필요', { exact: true })).toBeVisible();
    await find(() => openFindings.click());
    await expect(findingType).toHaveValue('unresolved-time');
    await find(() => findingType.selectOption('unavailable'));
    await expect(findings).toContainText('선택한 유형에 해당하는 원본 변경이 없습니다.');

    await page.route(url => url.pathname === auditPath, route => route.fulfill({ json: {
      ...inspected, integrity: { ...inspected.integrity, status: 'mismatch' },
    } }), { times: 1 });
    await inspect();
    await expect(panel.getByText('확인 필요', { exact: true })).toBeVisible();
    await expect(panel).toContainText('이관 당시 기록과 현재 비교 결과를 확인해 주세요.');

    await page.route(url => url.pathname === auditPath, route => route.fulfill({ json: {
      ...inspected, integrity: { ...inspected.integrity, status: 'counts-only' },
      jiraStatusHistory: {
        sourceChanges: 0, projected: { count: 0, sha256: createHash('sha256').digest('hex') },
        duplicate: 0, excluded: 0, restricted: 0, unavailable: 0, unresolvedTime: 0, unresolvedAuthor: 0,
      },
    } }), { times: 1 });
    await inspect();
    await expect(panel).toContainText('Jira 내보내기에 변경 이력이 포함되어 있는지 확인해 주세요.');
    await expect(openFindings).toHaveCount(0);
  } finally {
    await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});

test('매핑과 다른 설정이 함께 수정되면 한 탐색 거절이 모든 초안을 보존한다', async ({ page, request }) => {
  const unique = suffix(), filename = `migration-guard-${unique}.csv`, key = `GU${unique}`, pkg = await upload(request, filename, jira(key, `탐색 검증 ${unique}`), `migration-guard-${unique}`);
  try {
    const { settings, workspace } = await open(page, request); await selectPackage(settings, filename);
    const name = settings.getByLabel(`새 프로젝트 이름 원본 프로젝트 ${key}`, { exact: true }); await name.fill('내 이관 프로젝트 초안');
    const legacy = page.getByRole('region', { name: '기존 도구 원본 분석', exact: true }).getByLabel('원본 인스턴스 식별값', { exact: true }); await legacy.fill('다른 설정 카드의 초안');
    const actor = page.getByLabel('작업자 선택', { exact: true }), initial = await actor.inputValue(), target = workspace.users.find(user => user.id !== initial)!.id, url = page.url(); let count = 0;
    const cancelSecond = (dialog: import('@playwright/test').Dialog) => { count++; if (count === 1) void dialog.accept(); else void dialog.dismiss(); }; page.on('dialog', cancelSecond); await actor.selectOption(target); page.off('dialog', cancelSecond);
    await expect(actor).toHaveValue(initial); await expect(name).toHaveValue('내 이관 프로젝트 초안'); await expect(legacy).toHaveValue('다른 설정 카드의 초안'); expect(page.url()).toBe(url); expect(count).toBe(2);
    const acceptAll = (dialog: import('@playwright/test').Dialog) => void dialog.accept(); page.on('dialog', acceptAll); await actor.selectOption(target); page.off('dialog', acceptAll); await expect(actor).toHaveValue(target); await expect(settings.getByLabel('이관 매핑', { exact: true })).toHaveCount(0); await expect(legacy).toHaveValue('');
  } finally { await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`); }
});

test('별도 Jira REST 댓글과 작업 시간 페이지를 이관하고 티켓과 기간 보고서에서 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const unique = suffix(), key = `TM${unique}`, filename = `activity-${unique}.zip`;
  const workDate = '2020-02-03', title = `이관 작업 시간 ${unique}`;
  const sourceUrl = 'https://jira.example.test/company/rest/api/2/issue/1901';
  const originalAuthor = { name: `worker-${unique}`, displayName: `원본 작업자 ${unique}` };
  const originalComment = '별도 REST 페이지에 있던 댓글';
  const data = {
    issues: [{
      id:'1901', key:`${key}-1`, self: sourceUrl, fields:{
        project:{id:'101',key,name:`원본 시간 프로젝트 ${unique}`},summary:title,
        issuetype:{id:'1',name:'Task'},status:{id:'1',name:'Open'},
        created:'2020-01-02T03:00:00Z',updated:'2020-02-03T18:00:00Z',
      },
      changelog:{startAt:0,total:0,histories:[]},
    }],
  };
  const pages = {
    'comment-page.json': { startAt: 0, total: 1, comments: [{ id: '300', self: `${sourceUrl}/comment/300`, author: originalAuthor,
      created: '2020-02-03T01:00:00+0900', body: originalComment }] },
    'worklog-page.json': { startAt: 0, total: 1, worklogs: [{ id: '200', self: `${sourceUrl}/worklog/200`, issueId: '1901',
      author: originalAuthor, started: `${workDate}T00:15:00.000+0900`, timeSpentSeconds: 91, comment: '원래 작업 메모' }] },
    'search.json': data,
  };
  const archive = zip(Object.entries(pages).map(([path, value]) => ({ path, bytes: Buffer.from(JSON.stringify(value)) })));
  const pkg = await upload(request, filename, archive, `worklog-browser-${unique}`);
  try {
    const {settings} = await open(page, request);
    await selectPackage(settings, filename);
    const currentActor = await page.getByLabel('작업자 선택', {exact:true}).inputValue();
    await settings.getByText('사용자 매핑', {exact:true}).click();
    await settings.getByLabel(`사용자 매핑 ${originalAuthor.displayName}`, {exact:true}).selectOption(currentActor);
    const checked = await preview(page, settings);
    expect(checked.canApply, JSON.stringify(checked.notices)).toBe(true);
    expect(checked.counts).toMatchObject({ comments: 1, worklogs: 1 });
    const review = settings.getByRole('region', {name:'이관 적용 미리보기',exact:true});
    await expect(review).toContainText('적용할 작업 시간 1');
    await acknowledge(settings, checked);
    const response = page.waitForResponse(value => value.url().endsWith(`/api/migrations/previews/${checked.id}/apply`));
    page.once('dialog', dialog => void dialog.accept());
    await settings.getByRole('button', {name:'검토한 이관 실제 적용',exact:true}).click();
    const applied = await response;
    expect(applied.ok(), await applied.text()).toBe(true);
    await expect(settings.getByLabel('이관 영수증 상세', {exact:true})).toBeVisible();
    const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    const issue = workspace.issues.find(row => row.title === title)!;
    expect(issue).toBeTruthy();

    await page.goto(`/#/${issue.projectId}/issues?issue=${issue.id}`);
    const drawer = page.getByRole('dialog', {name:title,exact:true});
    await expect(drawer.locator('.issue-comment p').filter({ hasText: originalComment })).toHaveCount(1);
    await drawer.getByRole('button', {name:'작업 시간',exact:true}).click();
    const worklogs = drawer.getByRole('region', {name:'업무 작업 기록'});
    await expect(worklogs.getByLabel('업무 총 작업 시간')).toHaveText('1분 31초');
    await expect(worklogs.getByLabel('작업 기록 목록')).toContainText('Jira 이관');
    await expect(worklogs.getByLabel('작업 기록 목록')).toContainText(workDate);
    await worklogs.getByRole('button', {name:`${workDate} 작업 기록 수정`,exact:true}).click();
    await expect(worklogs).toContainText('이관 작업 시간은 1분 31초입니다');
    await worklogs.getByLabel('작업 기록 내용', {exact:true}).fill('이관 후 추가 메모');
    await worklogs.getByRole('button', {name:'기록 수정 저장',exact:true}).click();
    await expect(worklogs.getByLabel('작업 기록 목록')).toContainText('이관 후 추가 메모');
    await expect(worklogs.getByLabel('업무 총 작업 시간')).toHaveText('1분 31초');

    await drawer.getByRole('button', {name:'업무 상세 닫기'}).click();
    await page.getByRole('button', {name:'메뉴 열기',exact:true}).click();
    await page.getByRole('button', {name:'보고서',exact:true}).click();
    await page.getByRole('tab', {name:'작업 시간',exact:true}).click();
    await page.getByLabel('작업 시간 시작일', {exact:true}).fill(workDate);
    await page.getByLabel('작업 시간 종료일', {exact:true}).fill(workDate);
    await page.getByRole('button', {name:'작업 시간 조회',exact:true}).click();
    await expect(page.getByRole('region', {name:'업무별 작업 시간'})).toContainText('1분 31초');
  } finally {
    await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});
