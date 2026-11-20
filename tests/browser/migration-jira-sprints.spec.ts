import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  LegacyPackageSummary, MigrationApplyResult, MigrationPreview, WorkspaceSnapshot,
} from '../../shared/types';

function dateAt(offset: number) {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

test('Jira 스프린트 이관은 현재 사이클과 과거 이력을 보존하고 간트에서 연결 업무를 연다', async ({ page, request }) => {
  test.setTimeout(110_000);
  await page.setViewportSize({ width: 360, height: 820 });

  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const projectKey = `JSP${suffix}`;
  const projectName = `Jira 스프린트 견본 ${suffix}`;
  const filename = `jira-sprints-${suffix}.json`;
  const activeName = `진행 중 스프린트 ${suffix}`;
  const anotherActiveName = `병행 스프린트 ${suffix}`;
  const closedName = `지난 스프린트 ${suffix}`;
  const assignedTitle = `현재와 과거 스프린트가 있는 업무 ${suffix}`;
  const historicalTitle = `과거 스프린트만 있는 업무 ${suffix}`;
  const ambiguousTitle = `사이클과 릴리스를 함께 검토할 업무 ${suffix}`;
  const releaseName = `대표 릴리스 견본 ${suffix}`;
  const sprintField = 'customfield_501';
  const sprint = (id: number, name: string, state: 'active' | 'closed', start: number, end: number) => ({
    id, name, state, originBoardId: 9310, startDate: `${dateAt(start)}T12:00:00.000Z`,
    endDate: `${dateAt(end)}T12:00:00.000Z`,
  });
  const active = sprint(9301, activeName, 'active', 1, 6);
  const anotherActive = sprint(9303, anotherActiveName, 'active', 2, 7);
  const closed = { ...sprint(9302, closedName, 'closed', -12, -7), completeDate: `${dateAt(-8)}T12:00:00.000Z` };
  const issue = (id: number, number: number, title: string, planningFields: Record<string, unknown>) => ({
    id: String(id), key: `${projectKey}-${number}`,
    fields: {
      summary: title, project: { id: '9300', key: projectKey, name: projectName },
      status: { id: '31', name: 'Ready' }, issuetype: { id: '41', name: 'Task' },
      created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z',
      ...planningFields,
    },
  });
  const bytes = Buffer.from(JSON.stringify({
    names: { [sprintField]: 'Sprint' },
    schema: { [sprintField]: { type: 'array', items: 'sprint', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
    issues: [
      issue(9391, 1, assignedTitle, { sprint: active, closedSprints: [closed] }),
      issue(9392, 2, historicalTitle, { sprint: null, closedSprints: [closed] }),
      issue(9393, 3, ambiguousTitle, {
        [sprintField]: [active, anotherActive, closed],
        fixVersions: [
          { id: '9341', projectId: 9300, name: releaseName, archived: false, released: false },
          { id: '9342', projectId: 9300, name: `다른 릴리스 견본 ${suffix}`, archived: false, released: false },
        ],
      }),
    ],
  }));
  const snapshot = async () => {
    const response = await request.get('/api/workspace');
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as WorkspaceSnapshot;
  };
  const original = await snapshot();
  const upload = await request.post(`/api/legacy-import/packages?${new URLSearchParams({
    filename, product: 'jira', instanceKey: `synthetic-sprints-${suffix}`,
  })}`, { headers: { 'Content-Type': 'application/octet-stream' }, data: bytes });
  expect(upload.status(), await upload.text()).toBe(201);
  const source = await upload.json() as LegacyPackageSummary;
  let projectId: string | undefined;

  try {
    await page.goto(`/#/${original.projects[0].id}/settings`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await expect(settings).toBeVisible({ timeout: 30_000 });
    await settings.getByLabel(`이관 패키지 ${filename}`, { exact: true }).check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    await expect(settings.getByLabel('이관 원본 시간대', { exact: true })).toBeVisible();
    async function makePreview() {
      const previewing = page.waitForResponse(response =>
        response.url().endsWith('/api/migrations/preview') && response.request().method() === 'POST');
      await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
      const previewResponse = await previewing;
      expect(previewResponse.status(), await previewResponse.text()).toBe(201);
      const preview = await previewResponse.json() as MigrationPreview;
      expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
      return preview;
    }
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const firstPreview = await makePreview();
    expect(firstPreview.counts).toMatchObject({ jiraSprints: 3, jiraSprintLinks: 1, jiraSprintHistoryOnly: 1, jiraSprintUnassigned: 1 });
    const ambiguousKey = `${projectKey}-3`;
    const sprintChoice = firstPreview.jiraSprintChoices?.find(choice => choice.sourceKey === ambiguousKey);
    const releaseChoice = firstPreview.jiraReleaseChoices?.find(choice => choice.sourceKey === ambiguousKey);
    expect(sprintChoice?.candidates.map(candidate => candidate.name).sort()).toEqual([activeName, anotherActiveName].sort());
    expect(releaseChoice?.candidates).toContainEqual({ sourceId: '9341', name: releaseName });

    const applyButton = review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true });
    for (const code of firstPreview.requiredAcknowledgements) {
      await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    }
    await expect(applyButton).toBeEnabled();
    const sprintReview = review.getByRole('group', { name: 'Jira 대표 사이클 선택', exact: true });
    const cycleSelect = sprintReview.getByRole('combobox', { name: `대표 사이클 ${ambiguousKey}`, exact: true });
    const releaseReview = review.getByRole('group', { name: 'Jira 대표 릴리스 선택', exact: true });
    const releaseSelect = releaseReview.getByRole('combobox', { name: `대표 릴리스 ${ambiguousKey}`, exact: true });
    await cycleSelect.selectOption({ label: activeName });
    await expect(applyButton).toBeDisabled();
    await expect(sprintReview.getByRole('button', { name: '선택한 사이클로 다시 검토', exact: true })).toBeEnabled();
    await releaseSelect.selectOption({ label: releaseName });
    await expect(cycleSelect).toHaveValue('9301');
    await review.getByRole('button', { name: '선택한 사이클·릴리스로 다시 검토', exact: true }).click();
    await expect(review).toHaveCount(0);
    const preview = await makePreview();
    expect(preview.id).not.toBe(firstPreview.id);
    expect(preview.configuration.jiraSprintSelections).toMatchObject({ [sprintChoice!.recordId]: '9301' });
    expect(preview.configuration.jiraReleaseSelections).toMatchObject({ [releaseChoice!.recordId]: '9341' });
    expect(preview.counts).toMatchObject({ jiraSprintLinks: 2, jiraSprintHistoryOnly: 1, jiraReleaseLinks: 1 });
    expect(preview.counts.jiraSprintUnassigned ?? 0).toBe(0);
    await expect(cycleSelect).toHaveValue('9301');
    await expect(releaseSelect).toHaveValue('9341');
    for (const code of preview.requiredAcknowledgements) {
      await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    }
    const applying = page.waitForResponse(response =>
      response.url().endsWith(`/api/migrations/previews/${preview.id}/apply`) && response.request().method() === 'POST');
    page.once('dialog', dialog => dialog.accept());
    await review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true }).click();
    const applied = await applying;
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: receipt } = await applied.json() as MigrationApplyResult;
    [projectId] = receipt.projectIds;

    const workspace = await snapshot();
    const cycles = workspace.planningItems?.filter(item => item.projectId === projectId && item.kind === 'cycle');
    expect(cycles).toHaveLength(3);
    const current = cycles!.find(item => item.name === activeName);
    const previous = cycles!.find(item => item.name === closedName);
    const start = active.startDate.slice(0, 10), end = active.endDate.slice(0, 10);
    expect(current).toMatchObject({ kind: 'cycle', status: 'active', startDate: start, endDate: end });
    expect(previous).toMatchObject({ kind: 'cycle', status: 'completed', startDate: closed.startDate.slice(0, 10) });
    const issues = workspace.issues.filter(item => item.projectId === projectId);
    expect(issues.find(item => item.title === assignedTitle)?.cycleId).toBe(current!.id);
    expect(issues.find(item => item.title === historicalTitle)?.cycleId).toBeNull();
    const release = workspace.planningItems?.find(item => item.projectId === projectId && item.name === releaseName);
    expect(release).toMatchObject({ kind: 'release' });
    expect(issues.find(item => item.title === ambiguousTitle)).toMatchObject({ cycleId: current!.id, releaseId: release!.id });

    const receiptDetail = settings.getByLabel('이관 영수증 상세', { exact: true });
    const origins = receiptDetail.getByRole('region', { name: '이관 영수증 원본 기록', exact: true });
    await origins.getByLabel('원본 이관 기록 종류', { exact: true }).selectOption('issue');
    await origins.getByRole('button').filter({ hasText: assignedTitle }).click();
    const archive = origins.getByRole('region', { name: '보존한 원본 기록 상세', exact: true });
    const metadata = archive.locator('details').filter({ hasText: '원본 메타데이터' });
    await metadata.locator('summary').click();
    const record = JSON.parse(await metadata.locator('pre').innerText());
    expect(record.jiraSprintIds.map(String).sort()).toEqual(['9301', '9302']);
    expect(record.jiraCurrentSprintIds.map(String)).toEqual(['9301']);

    const receiptLink = receiptDetail.getByRole('link', { name: `${projectName} 프로젝트 열기`, exact: true });
    await expect(receiptLink).toHaveAttribute('aria-disabled', 'false');
    await receiptLink.click();
    await expect(page).toHaveURL(url => url.hash === `#/${projectId}/overview`);
    await page.goto(`/#/${projectId}/planning/${current!.id}`);
    const planning = page.getByRole('region', { name: '사이클 상세', exact: true });
    await expect(planning.getByLabel('계획 이름', { exact: true })).toHaveValue(activeName);
    await expect(planning.getByLabel('계획 시작일', { exact: true })).toHaveValue(start);
    await expect(planning.getByLabel('계획 종료일', { exact: true })).toHaveValue(end);
    await expect(planning.getByRole('button').filter({ hasText: assignedTitle })).toBeVisible();
    await expect(planning.getByRole('button').filter({ hasText: ambiguousTitle })).toBeVisible();
    await expect(planning.getByRole('button').filter({ hasText: historicalTitle })).toHaveCount(0);
    await page.getByRole('link', { name: '간트에서 열기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === `#/${projectId}/gantt/${current!.id}`);
    const ganttPlan = page.getByRole('region', { name: '간트 계획 일정', exact: true });
    await expect(ganttPlan.getByRole('button', { name: `사이클 ${activeName} 간트 선택`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('checkbox', { name: '연결된 업무만', exact: true }).check();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const rows = chart.locator('.gantt-row[data-issue-id]');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: assignedTitle })).toBeVisible();
    await expect(rows.filter({ hasText: ambiguousTitle })).toBeVisible();
    await expect(chart.getByRole('img', { name: `${activeName} 계획 기간 ${start} ~ ${end}`, exact: true })).toBeVisible();
  } finally {
    if (projectId) {
      const workspace = await snapshot();
      for (const issue of workspace.issues.filter(item => item.projectId === projectId)) {
        const archived = await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`);
        if (archived.ok()) {
          const { trashEntryId } = await archived.json() as { trashEntryId: string };
          await request.delete(`/api/trash/${trashEntryId}`);
        }
      }
      for (const item of workspace.planningItems?.filter(item => item.projectId === projectId) ?? []) {
        await request.delete(`/api/planning-items/${item.id}?expectedVersion=${item.version}`);
      }
    }
    await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
  }
});
