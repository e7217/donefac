import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Response } from '@playwright/test';
import type { IssueFieldBreakdown, JiraSavedViewPreview, LegacyPackageSummary, MigrationApplyResult, MigrationPreview, SavedView, SourceRecordArchive, SourceRecordPage, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}

test('360px Jira 컴포넌트 이관에서 여러 멤버십을 보존하고 업무 필터와 집계에서 사용한다', async ({ page, request }) => {
  test.setTimeout(110_000);
  await page.setViewportSize({ width: 360, height: 820 });

  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const projectKey = `JCP${suffix}`, otherKey = `JCQ${suffix}`;
  const projectName = `Jira 컴포넌트 견본 ${suffix}`, otherName = `다른 원본 프로젝트 ${suffix}`;
  const filename = `jira-components-${suffix}.zip`;
  const fieldName = 'Jira 컴포넌트';
  const searchComponent = '검색', storageComponent = '저장', foreignComponent = '다른 프로젝트 전용';
  const bothTitle = `검색과 저장 업무 ${suffix}`, storageTitle = `저장 전용 업무 ${suffix}`, emptyTitle = `컴포넌트 없는 업무 ${suffix}`;
  const foreignTitle = `다른 프로젝트 업무 ${suffix}`;
  const issue = (id: number, projectId: number, number: number, title: string) => `<Issue id="${id}" project="${projectId}" number="${number}" summary="${title}" status="31" issuetype="41"
    created="2020-01-01T00:00:00Z" updated="2020-01-02T00:00:00Z"/>`;
  const component = (id: number, projectId: number, name: string) => `<Component id="${id}" project="${projectId}" cname="${name}" archived="false"/>`;
  const association = (issueId: number, componentId: number) => `<NodeAssociation sourceNodeId="${issueId}" sourceNodeEntity="Issue"
    sinkNodeId="${componentId}" sinkNodeEntity="Component" associationType="IssueComponent"/>`;
  const xml = `<entity-engine-xml>
    <Project id="7100" pkey="${projectKey}" name="${projectName}"/>
    <Project id="7200" pkey="${otherKey}" name="${otherName}"/>
    <Status id="31" pname="Ready"/>
    <IssueType id="41" pname="Task"/>
    ${component(7111, 7100, searchComponent)}
    ${component(7112, 7100, storageComponent)}
    ${component(7211, 7200, searchComponent)}
    ${component(7212, 7200, foreignComponent)}
    ${issue(7101, 7100, 1, bothTitle)}
    ${issue(7102, 7100, 2, storageTitle)}
    ${issue(7103, 7100, 3, emptyTitle)}
    ${issue(7201, 7200, 1, foreignTitle)}
    ${association(7101, 7111)}
    ${association(7101, 7112)}
    ${association(7102, 7112)}
    ${association(7201, 7211)}
    ${association(7201, 7212)}
  </entity-engine-xml>`;
  const snapshot = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [homeProject] } = await snapshot();
  let source: LegacyPackageSummary | undefined;
  let importedProjects: string[] = [];
  let savedView: SavedView | undefined;

  try {
    await page.goto(`/#/${homeProject.id}/settings?section=migration`);
    const analysis = page.getByRole('form', { name: '원본 파일 분석', exact: true });
    await analysis.getByLabel('Jira·Confluence 원본 파일', { exact: true }).setInputFiles({
      name: filename, mimeType: 'application/zip', buffer: zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]),
    });
    await analysis.getByLabel('원본 인스턴스 식별값', { exact: true }).fill(`synthetic-components-${suffix}`);
    await analysis.getByLabel('원본 도구', { exact: true }).selectOption('jira');
    const uploading = page.waitForResponse(response => new URL(response.url()).pathname === '/api/legacy-import/packages' && response.request().method() === 'POST');
    await analysis.getByRole('button', { name: '원본 분석 시작', exact: true }).click();
    source = await json<LegacyPackageSummary>(await uploading, 201);
    expect(source.errors).toBe(0);

    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await settings.getByLabel(`이관 패키지 ${filename}`, { exact: true }).check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    await settings.getByText('사용자 정의 속성 매핑', { exact: true }).click();
    const mapping = settings.getByRole('combobox', { name: `속성 매핑 ${fieldName}`, exact: true });
    await expect(mapping).toHaveValue('multi_select');

    const proposed = page.waitForResponse(response => response.url().endsWith('/api/migrations/preview') && response.request().method() === 'POST');
    await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
    const preview = await json<MigrationPreview>(await proposed, 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    expect(preview.counts.issues).toBe(4);
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    for (const code of preview.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const applying = page.waitForResponse(response => response.url().endsWith(`/api/migrations/previews/${preview.id}/apply`) && response.request().method() === 'POST');
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const { import: receipt } = await json<MigrationApplyResult>(await applying, 201);
    importedProjects = receipt.projectIds;

    const current = await snapshot();
    const project = current.projects.find(project => project.key === projectKey);
    const otherProject = current.projects.find(project => project.key === otherKey);
    assert.ok(project && otherProject);
    expect(importedProjects).toEqual(expect.arrayContaining([project.id, otherProject.id]));
    const field = current.issueSchemas?.find(schema => schema.projectId === project.id)?.fields.find(field => field.name === fieldName);
    const otherField = current.issueSchemas?.find(schema => schema.projectId === otherProject.id)?.fields.find(field => field.name === fieldName);
    assert.ok(field && otherField);
    expect(field.kind).toBe('multi_select');
    expect(otherField.kind).toBe('multi_select');
    expect(field.options.map(option => option.name).sort()).toEqual([searchComponent, storageComponent].sort());
    expect(otherField.options.map(option => option.name).sort()).toEqual([foreignComponent, searchComponent].sort());
    const searchId = field.options.find(option => option.name === searchComponent)!.id;
    const storageId = field.options.find(option => option.name === storageComponent)!.id;
    expect(otherField.options.find(option => option.name === searchComponent)?.id).not.toBe(searchId);
    const both = current.issues.find(issue => issue.key === `${projectKey}-1`);
    const storageOnly = current.issues.find(issue => issue.key === `${projectKey}-2`);
    assert.ok(both && storageOnly);
    expect(both.customFields?.[field.id]).toEqual(expect.arrayContaining([searchId, storageId]));
    expect(both.customFields?.[field.id]).toHaveLength(2);
    expect(storageOnly.customFields?.[field.id]).toEqual([storageId]);

    const archivePath = `/api/source-imports/${receipt.id}/records`;
    const archivePage = await json<SourceRecordPage>(await request.get(`${archivePath}?kind=relation`));
    const preserved = archivePage.records.find(entry => entry.record.sourceId === 'association:7101:Component:7111:IssueComponent');
    assert.ok(preserved);
    const archive = await json<SourceRecordArchive>(await request.get(`${archivePath}/${encodeURIComponent(preserved.id)}`));
    expect(archive.record).toMatchObject({ kind: 'relation', metadata: { associationType: 'IssueComponent', sinkNodeEntity: 'Component' } });
    expect(archive.record.references).toContainEqual({ kind: 'issue', sourceId: '7101', relation: 'source' });

    await settings.getByRole('link', { name: `${projectName} 프로젝트 열기`, exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === `#/${project.id}/overview`);
    await page.goto(`/#/${project.id}/issues?issue=${both.id}`);
    const drawer = page.getByRole('dialog', { name: bothTitle, exact: true });
    const input = drawer.getByRole('region', { name: '사용자 정의 속성', exact: true }).getByLabel(fieldName, { exact: true });
    await expect(input).toBeVisible();
    expect((await input.locator('option:checked').allTextContents()).sort()).toEqual([searchComponent, storageComponent].sort());
    await drawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    const filters = page.getByRole('region', { name: '사용자 정의 필드 필터', exact: true });
    const edit = filters.getByRole('button', { name: '사용자 정의 필드 필터 편집', exact: true });
    const filter = filters.getByRole('form', { name: '사용자 정의 필드 필터 편집기', exact: true });
    const fields = filter.getByLabel('필터 조건 1 필드', { exact: true });
    const value = filter.getByLabel('필터 조건 1 값', { exact: true });
    const applyFilter = filter.getByRole('button', { name: '필드 필터 적용', exact: true });
    const list = page.getByRole('region', { name: '업무 목록', exact: true });
    await edit.click();
    await filter.getByRole('button', { name: '필드 필터 조건 추가', exact: true }).click();
    await fields.selectOption(field.id);
    await filter.getByLabel('필터 조건 1 비교', { exact: true }).selectOption('includes');
    await value.selectOption(searchId);
    await applyFilter.click();
    await expect(list.getByText(bothTitle, { exact: true })).toBeVisible();
    await expect(list.getByText(storageTitle, { exact: true })).toHaveCount(0);
    await expect(list.getByText(emptyTitle, { exact: true })).toHaveCount(0);

    await edit.click();
    await value.selectOption(storageId);
    await applyFilter.click();
    await expect(list.getByText(bothTitle, { exact: true })).toBeVisible();
    await expect(list.getByText(storageTitle, { exact: true })).toBeVisible();
    await expect(list.getByText(emptyTitle, { exact: true })).toHaveCount(0);

    const byName = await json<JiraSavedViewPreview>(await request.post('/api/views/jira/preview', {
      data: { projectId: project.id, jql: `component = "${searchComponent}"` },
    }));
    expect(byName.issues.map(issue => issue.id)).toEqual([both.id]);
    await json(await request.post('/api/views/jira/preview', {
      data: { projectId: project.id, jql: 'component = 7211' },
    }), 400);

    await page.getByRole('button', { name: 'Jira 필터 옮기기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Jira 필터 옮기기', exact: true });
    await dialog.getByLabel('Jira 검색식 (JQL)', { exact: true }).fill(`project = ${projectKey} AND component = 7111`);
    const previewing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/views/jira/preview');
    await dialog.getByRole('button', { name: '조건 미리보기', exact: true }).click();
    const componentPreview = await json<JiraSavedViewPreview>(await previewing);
    expect(componentPreview.issues.map(issue => issue.id)).toEqual([both.id]);
    expect(componentPreview.filters.fieldFilter?.rules).toEqual([{ fieldId: field.id, operator: 'includes', value: searchId }]);
    await expect(dialog.getByRole('list', { name: '적용할 검색 조건' })).toContainText(searchComponent);
    await dialog.getByLabel('보기 이름', { exact: true }).fill(`검색 컴포넌트 ${suffix}`);
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/views/jira/import');
    await dialog.getByRole('button', { name: '공유 보기 저장', exact: true }).click();
    savedView = await json<SavedView>(await saving, 201);
    await expect(page.getByLabel('저장된 업무 보기', { exact: true })).toHaveValue(savedView.id);
    await expect(list.getByText(storageTitle, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.locator(`[data-issue-id="${both.id}"]`)).toBeVisible();
    await expect(chart.locator(`[data-issue-id="${storageOnly.id}"]`)).toHaveCount(0);
    await page.reload();
    await expect(chart.locator(`[data-issue-id="${both.id}"]`)).toBeVisible();

    await page.goto(`/#/${project.id}/reports`);
    await page.getByRole('tab', { name: '필드 집계', exact: true }).click();
    const query = page.getByRole('form', { name: '필드 집계 조회 조건', exact: true });
    await query.getByLabel('집계 기준', { exact: true }).selectOption('custom');
    await query.getByLabel('집계할 사용자 정의 필드', { exact: true }).selectOption(field.id);
    const grouping = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/field-breakdown`));
    await query.getByRole('button', { name: '필드 집계 조회', exact: true }).click();
    const summary = await json<IssueFieldBreakdown>(await grouping);
    expect(summary).toMatchObject({ totalIssues: 3, populatedIssues: 2, missingIssues: 1 });
    expect(summary.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: searchComponent, count: 1 }),
      expect.objectContaining({ label: storageComponent, count: 2 }),
      expect.objectContaining({ kind: 'missing', count: 1 }),
    ]));
    await page.getByRole('button', { name: `그룹 ${storageComponent} 업무 보기`, exact: true }).click();
    const drilldown = page.getByRole('region', { name: '필드 집계 그룹 업무', exact: true });
    await expect(drilldown.getByRole('button', { name: `${both.key} ${bothTitle}`, exact: true })).toBeVisible();
    await expect(drilldown.getByRole('button', { name: `${storageOnly.key} ${storageTitle}`, exact: true })).toBeVisible();
    await expect(drilldown.getByText(emptyTitle, { exact: false })).toHaveCount(0);
  } finally {
    if (savedView) await request.delete(`/api/views/${savedView.id}?expectedVersion=${savedView.version}`);
    if (importedProjects.length) {
      const current = await snapshot();
      for (const issue of current.issues.filter(issue => importedProjects.includes(issue.projectId))) {
        const removed = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
        if (removed.ok()) {
          const { trashEntryId } = await removed.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`);
        }
      }
    }
    if (source) await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
  }
});
