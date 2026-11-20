import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AttachmentHead, DocPage, Issue, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, ProjectWorkflow, SourceReconciliationAudit, SourceReconciliationFileCheck, SourceReconciliationJiraStatusFindingsPage, SourceRecordArchive, SourceRecordPage, WorkspaceSnapshot } from '../../shared/types';

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

test('360px에서 Jira 변경을 검토하고 팀에서 편집한 제목을 유지하며 새 설명을 반영한다', async ({ page, request }) => {
  test.setTimeout(90_000);
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
  try {
    const original = await upload(request, `refresh-original-${id}.json`, jiraExport(originalTitle, originalDescription, '2020-01-02T00:00:00Z'), instance);
    staged.push(original);
    const initial = await importIntoProject(request, original, targetKey, `이전 이관 프로젝트 ${id}`);
    const [projectId] = initial.import.projectIds;
    const imported = (await (await request.get('/api/workspace')).json() as WorkspaceSnapshot).issues.find(issue => issue.projectId === projectId)!;
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
  } finally {
    for (const pkg of staged) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
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

test('360px에서 기존 Jira 업무에 새 댓글과 작업 시간 기록을 한 번씩 추가한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const id = suffix(), sourceKey = `JHR${id}`, targetKey = `THR${id}`, instance = `jira-history-${id}`;
  const teamTitle = `팀에서 편집한 업무 ${id}`, teamComment = 'Teamspace에서 남긴 댓글', teamWorklog = 'Teamspace에서 남긴 작업 시간';
  const originalComment = '처음 이관한 원본 댓글', newComment = '새로 내보낸 원본 댓글', rejectedComment = '같은 원본 ID로 변경한 댓글';
  const originalAuthor = { name: `history-worker-${id}`, displayName: `원본 작성자 ${id}` };
  const exportJira = (next: boolean) => Buffer.from(JSON.stringify({ issues: [{ id: '200', key: `${sourceKey}-1`, fields: {
    project: { id: '2040', key: sourceKey, name: `Jira 원본 프로젝트 ${id}` },
    summary: next ? '두 번째 Jira 원본 제목' : '처음 이관한 Jira 업무',
    created: '2021-01-01T00:00:00Z', updated: next ? '2021-01-04T00:00:00Z' : '2021-01-02T00:00:00Z',
    status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
    comment: { comments: [
      { id: '610', author: originalAuthor, created: '2021-01-02T00:00:00Z', body: next ? rejectedComment : originalComment },
      ...(next ? [{ id: '611', author: originalAuthor, created: '2021-01-04T00:00:00Z', body: newComment }] : []),
    ] },
    worklog: { worklogs: next ? [{ id: '710', author: originalAuthor, started: '2021-01-04T09:00:00+0900',
      timeSpentSeconds: 91, comment: '새 원본 작업 메모' }] : [] },
  } }] }));
  const staged: LegacyPackageSummary[] = [];
  try {
    const initial = await upload(request, `jira-history-original-${id}.json`, exportJira(false), instance);
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

    const next = await upload(request, `jira-history-next-${id}.json`, exportJira(true), instance);
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

test('360px에서 Confluence 문서 변경을 검토하고 팀의 제목과 새 본문을 함께 보존한다', async ({ page, request }) => {
  test.setTimeout(90_000);
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
  for (const status of [409, 408]) {
    await page.route(`**/api/migrations/previews/${ready.id}/apply`, route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: `합성 ${status} 응답` }) }));
    page.once('dialog', dialog => dialog.accept()); await applyButton.click();
    await expect(settings.getByRole('alert')).toContainText(`합성 ${status}`); await expect(keyInput).toHaveValue(key); await expect(applyButton).toBeEnabled();
    for (const code of ready.requiredAcknowledgements) await expect(settings.getByLabel(`이관 확인 ${code}`, { exact: true })).toBeChecked();
    await page.unroute(`**/api/migrations/previews/${ready.id}/apply`);
  }
  let release = () => {}, held = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { held = resolve; });
  await page.route(`**/api/migrations/previews/${ready.id}/apply`, async route => { const response = await route.fetch(); held(); await gate; await route.fulfill({ response }); });
  try {
    const applied = page.waitForResponse(value => value.url().endsWith(`/api/migrations/previews/${ready.id}/apply`) && value.status() < 400);
    page.once('dialog', dialog => dialog.accept()); await applyButton.click(); await received;
    await expect(keyInput).toBeDisabled(); const actor = await page.getByLabel('작업자 선택', { exact: true }).inputValue();
    await page.getByLabel('작업자 선택', { exact: true }).selectOption(workspace.users.find(user => user.id !== actor)!.id); await expect(page.getByLabel('작업자 선택', { exact: true })).toHaveValue(actor);
    expect(await page.evaluate(() => window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true })))).toBe(false);
    release(); const response = await applied; expect(response.ok()).toBe(true); const result = await response.json() as MigrationApplyResult;
    await expect(settings.getByLabel('이관 영수증 상세', { exact: true })).toBeVisible();
    await settings.getByLabel('이관 영수증 상세', { exact: true }).getByText('검토한 이관 진단', { exact: true }).click(); await expect(settings.getByLabel('이관 영수증 상세', { exact: true })).toContainText('CSV_HISTORY_NOT_PROVIDED');
    const current = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot, issue = current.issues.find(value => value.title === title)!;
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
  } finally { release(); await page.unroute(`**/api/migrations/previews/${ready.id}/apply`); await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`); }
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

test('360px 전체 이관 검증은 현재 필터와 별개로 모든 첨부 버전을 검사하고 누락 결과를 내려받는다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const unique = suffix(), space = `검증 공간 ${unique}`;
  const date = '<property name="creationDate">2020-01-02T00:00:00Z</property>';
  const owner = '<property name="containerContent" class="Page"><id name="id">100</id></property>';
  const xml = `<hibernate-generic>
    <object class="Space"><id name="id">42</id><property name="key">BA${unique}</property><property name="name">${space}</property></object>
    <object class="Page"><id name="id">100</id><property name="title">이관 검증 문서</property><property name="version">1</property><property name="space" class="Space"><id name="id">42</id></property>${date}</object>
    <object class="BodyContent"><id name="id">300</id><property name="body"><![CDATA[<p>검증 보고서에 복사하지 않을 원문</p>]]></property><property name="content" class="Page"><id name="id">100</id></property></object>
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
  try {
    const { settings } = await open(page, request);
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

    const reconciliation = await openReconciliation(settings);
    const kinds = reconciliation.getByLabel('대조 원본 종류', { exact: true });
    await kinds.selectOption('page');
    await expect(reconciliation.getByRole('list', { name: '이관 결과 대조 목록' }).getByRole('listitem')).toHaveCount(1);
    const run = reconciliation.getByRole('button', { name: '전체 이관 검증', exact: true });
    const audit = reconciliation.getByRole('region', { name: '전체 이관 검증', exact: true });
    const comparison = audit.getByRole('region', { name: '이관 당시 기록과 현재 비교', exact: true });
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
    expect(json).not.toContain('검증 보고서에 복사하지 않을 원문');
    await filter.selectOption('all');
    await expect(rows).toHaveCount(3);
  } finally { await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`); }
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

test('Jira 작업 시간을 검토해 이관하고 티켓과 기간 보고서에서 초 단위로 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const unique = suffix(), key = `TM${unique}`, filename = `worklog-${unique}.json`;
  const workDate = '2020-02-03', title = `이관 작업 시간 ${unique}`;
  const originalAuthor = { name: `worker-${unique}`, displayName: `원본 작업자 ${unique}` };
  const data = {
    issues: [{
      id:'1901', key:`${key}-1`, fields:{
        project:{id:'101',key,name:`원본 시간 프로젝트 ${unique}`},summary:title,
        issuetype:{id:'1',name:'Task'},status:{id:'1',name:'Open'},
        created:'2020-01-02T03:00:00Z',updated:'2020-02-03T18:00:00Z',
        worklog:{startAt:0,total:1,worklogs:[{
          id:'200',author:originalAuthor,started:`${workDate}T00:15:00.000+0900`,
          timeSpentSeconds:91,comment:'원래 작업 메모',
        }]},
      },
      changelog:{startAt:0,total:0,histories:[]},
    }],
  };
  const pkg = await upload(request, filename, Buffer.from(JSON.stringify(data)), `worklog-browser-${unique}`);
  try {
    const {settings} = await open(page, request);
    await selectPackage(settings, filename);
    const currentActor = await page.getByLabel('작업자 선택', {exact:true}).inputValue();
    await settings.getByText('사용자 매핑', {exact:true}).click();
    await settings.getByLabel(`사용자 매핑 ${originalAuthor.displayName}`, {exact:true}).selectOption(currentActor);
    const checked = await preview(page, settings);
    expect(checked.canApply, JSON.stringify(checked.notices)).toBe(true);
    expect(checked.counts.worklogs).toBe(1);
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
