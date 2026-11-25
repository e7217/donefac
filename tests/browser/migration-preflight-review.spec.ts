import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { LegacyPackageDetail, LegacyPackageSummary, LegacyRecord, MigrationOptions, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';

async function readApi<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

async function createPreview(page: Page, settings: Locator): Promise<MigrationPreview> {
  const preview = page.waitForResponse(response => response.url().endsWith('/api/migrations/preview') && response.request().method() === 'POST');
  await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
  const response = await preview;
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as MigrationPreview;
}

async function downloadReport(page: Page, review: Locator, previewId: string): Promise<string> {
  const downloadPromise = page.waitForEvent('download');
  await review.getByRole('button', { name: '이관 사전 검토 JSON 내보내기', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`migration-preflight-${previewId}.json`);
  return await readFile(await download.path(), 'utf8');
}

test('360px에서 제한된 Jira 원본의 검토 보고서를 저장하고 그 항목만 제외한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const filename = `internal-review-${suffix}.json`;
  const instanceKey = `origin-review-${suffix}`;
  const project = { id: '10100', key: `PRE${suffix}`, name: `내부 Jira 프로젝트 ${suffix}` };
  const sourceId = `restricted-source-${suffix}`;
  const title = `권한을 제한한 업무 ${suffix}`;
  const description = `비공개 Jira 본문 ${suffix}`;
  const reporter = { name: `private-user-${suffix}`, displayName: `원본 작성자 ${suffix}`, emailAddress: `private-${suffix}@example.test` };
  const workspace = await readApi<WorkspaceSnapshot>(request, '/api/workspace');
  const fields = {
    project, reporter, created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z',
    status: { id: '1', name: 'Ready' }, issuetype: { id: '3', name: 'Task' },
  };
  const changelog = { total: 0, histories: [] };
  const archive = Buffer.from(JSON.stringify({ issues: [
    { id: '10001', key: `${project.key}-1`, changelog, fields: { ...fields, summary: `이관할 업무 ${suffix}` } },
    { id: sourceId, key: `${project.key}-2`, changelog, fields: {
      ...fields, summary: title, description, security: { id: '7', name: `내부 공개 범위 ${suffix}` },
    } },
  ] }));
  const uploaded = await request.post(`/api/legacy-import/packages?${new URLSearchParams({ filename, instanceKey })}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: archive,
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const source = await uploaded.json() as LegacyPackageSummary;
  const packagePath = `/api/legacy-import/packages/${source.id}`;
  const recordPath = `${packagePath}/records/${encodeURIComponent(`issue:${sourceId}`)}`;
  const qualifiedId = `${source.id}/issue:${sourceId}`;

  try {
    const original = await readApi<LegacyRecord>(request, recordPath);
    const originalPackage = await readApi<LegacyPackageDetail>(request, packagePath);
    expect(original).toMatchObject({ title, text: description });
    await page.goto(`/#/${workspace.projects[0].id}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await expect(settings).toBeVisible({ timeout: 30_000 });
    await settings.getByLabel(`이관 패키지 ${filename}`, { exact: true }).check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();

    const blocked = await createPreview(page, settings);
    expect(blocked.canApply).toBe(false);
    expect(blocked.configuration.excludedRecords).toEqual([]);
    expect(blocked.notices).toContainEqual(expect.objectContaining({ severity: 'error', code: 'RESTRICTED_CONTENT', recordId: qualifiedId }));
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const apply = review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true });
    await expect(apply).toBeDisabled();

    const originalButton = review.getByRole('button', { name: '원본 상세 보기', exact: true });
    await originalButton.click();
    const originalDialog = page.getByRole('dialog', { name: '이관 진단 원본 기록', exact: true });
    await expect(originalDialog).toContainText(title);
    await expect(originalDialog).toContainText(description);
    await originalDialog.getByRole('button', { name: '이관 진단 원본 닫기', exact: true }).click();
    await expect(originalButton).toBeFocused();

    const exported = await downloadReport(page, review, blocked.id);
    expect(JSON.parse(exported)).toMatchObject({
      format: 'teamspace-migration-preflight', version: 1, status: 'blocked', mode: 'new',
      preview: { id: blocked.id, canApply: false },
      packages: [{ id: source.id, product: 'jira', format: 'jira-json', sha256: source.sha256 }],
      diagnostics: expect.arrayContaining([{ severity: 'error', code: 'RESTRICTED_CONTENT', count: 1 }]),
      mapping: { explicitExclusions: 0 },
    });
    for (const value of [filename, instanceKey, project.name, project.key, sourceId, title, description, reporter.name, reporter.displayName, reporter.emailAddress]) {
      expect(exported).not.toContain(value);
    }

    const exclusion = review.getByRole('checkbox', { name: `이관에서 제외할 원본으로 선택 ${qualifiedId}`, exact: true });
    const stageExclusion = review.getByRole('button', { name: '선택한 원본 제외로 지정', exact: true });
    await expect(review.getByRole('checkbox', { name: /^이관에서 제외할 원본으로 선택/ })).toHaveCount(1);
    await expect(stageExclusion).toBeDisabled();
    await exclusion.check();
    await expect(apply).toBeDisabled();
    await stageExclusion.click();
    await expect(review).toHaveCount(0);
    await expect(settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true })).toBeFocused();

    const next = await createPreview(page, settings);
    expect(next.id).not.toBe(blocked.id);
    expect(next.configuration.excludedRecords).toEqual([qualifiedId]);
    expect(next.canApply, JSON.stringify(next.notices)).toBe(true);
    expect(next.counts).toMatchObject({ issues: 1, excludedRecords: 1 });
    expect(next.notices).not.toContainEqual(expect.objectContaining({ code: 'RESTRICTED_CONTENT' }));
    expect(next.requiredAcknowledgements).toContain('PROJECT_ACCESS_NOT_REPRODUCED');
    await expect(review.locator('.migration-counts')).toContainText('직접 제외한 원본 1');
    await expect(apply).toBeDisabled();
    expect(JSON.parse(await downloadReport(page, review, next.id))).toMatchObject({
      status: 'review', preview: { id: next.id, canApply: true }, mapping: { explicitExclusions: 1 },
      requiredAcknowledgements: expect.arrayContaining(['PROJECT_ACCESS_NOT_REPRODUCED']),
    });

    expect(await readApi<LegacyRecord>(request, recordPath)).toEqual(original);
    expect(await readApi<LegacyPackageDetail>(request, packagePath)).toEqual(originalPackage);
    const after = await readApi<WorkspaceSnapshot>(request, '/api/workspace');
    expect(after.projects).toEqual(workspace.projects);
    expect(after.issues).toEqual(workspace.issues);
  } finally {
    const deleted = await request.delete(`${packagePath}?expectedVersion=${source.version}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});

test('Jira 원본 분류를 상태 매핑에 표시하고 충돌한 상태는 직접 선택해 검토한다', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const filename = `status-review-${suffix}.json`;
  const project = { id: '10101', key: `CAT${suffix}`, name: `Jira 상태 분류 ${suffix}` };
  const statuses = [
    { id: '1001', name: 'Shipped', statusCategory: { id: 3, key: 'done' } },
    { id: '1002', name: 'Open for QA', statusCategory: { id: 4, key: 'indeterminate' } },
    { id: '1003', name: 'Waiting for handoff', statusCategory: { id: 2, key: 'new' } },
    { id: '1003', name: 'Waiting for handoff', statusCategory: { id: 3, key: 'done' } },
  ];
  const archive = Buffer.from(JSON.stringify({ issues: statuses.map((status, index) => ({
    id: String(10101 + index), key: `${project.key}-${index + 1}`, fields: {
      project, status, summary: `${status.name} ${index + 1}`, issuetype: { id: '3', name: 'Task' },
      created: '2025-10-01T00:00:00Z', updated: '2025-10-03T00:00:00Z',
    },
  })) }));
  const params = new URLSearchParams({ product: 'jira', filename, instanceKey: `status-review-${suffix}` });
  const upload = await request.post(`/api/legacy-import/packages?${params}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: archive,
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const source = await upload.json() as LegacyPackageSummary;
  try {
    const { projects: [current] } = await readApi<WorkspaceSnapshot>(request, '/api/workspace');
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${current.id}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await settings.getByLabel(`이관 패키지 ${filename}`, { exact: true }).check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    await settings.locator('summary').filter({ hasText: /^상태 매핑$/u }).click();
    const status = (name: string) => settings.getByRole('combobox', { name: `상태 매핑 ${name}`, exact: true });
    await expect(status('Shipped')).toHaveValue('done');
    await expect(status('Open for QA')).toHaveValue('in_progress');
    const disputed = status('Waiting for handoff');
    await expect(disputed.locator('option:checked')).toHaveText('분류 선택');
    const blocked = await createPreview(page, settings);
    expect(blocked.canApply).toBe(false);
    expect(blocked.notices).toContainEqual(expect.objectContaining({ code: 'JIRA_STATUS_CATEGORY_CONFLICT', severity: 'error' }));

    await disputed.selectOption('todo');
    const reviewed = await createPreview(page, settings);
    expect(reviewed.canApply, JSON.stringify(reviewed.notices)).toBe(true);
    expect(reviewed.requiredAcknowledgements).toContain('JIRA_STATUS_CATEGORY_CONFLICT');
    const options = await readApi<MigrationOptions>(request, `/api/migrations/options?packageId=${source.id}`);
    expect(Object.fromEntries(options.statuses.map(({ id, label }) => [label, reviewed.configuration.statuses[id]]))).toEqual({
      Shipped: 'done', 'Open for QA': 'in_progress', 'Waiting for handoff': 'todo',
    });
  } finally {
    const deleted = await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});
