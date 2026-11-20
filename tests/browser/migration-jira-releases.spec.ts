import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { LegacyPackageSummary, MigrationApplyResult, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

function dateAt(offset: number) {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

test('Jira의 대표 릴리스를 검토해 이관하고 계획에서 연결 업무를 간트로 연다', async ({ page, request }) => {
  test.setTimeout(110_000);
  await page.setViewportSize({ width: 360, height: 820 });

  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const projectKey = `JRL${suffix}`;
  const projectName = `Jira 릴리스 견본 ${suffix}`;
  const filename = `jira-releases-${suffix}.zip`;
  const firstRelease = `상반기 릴리스 ${suffix}`;
  const chosenRelease = `후속 릴리스 ${suffix}`;
  const end = dateAt(5);
  const singleTitle = `수정 버전 한 개 업무 ${suffix}`;
  const multipleTitle = `수정 버전 두 개 업무 ${suffix}`;
  const affectedTitle = `영향 버전만 있는 업무 ${suffix}`;
  const affectedRelease = `이전 문제 발견 릴리스 ${suffix}`;
  const issue = (id: number, number: number, title: string) => `<Issue id="${id}" project="9200" number="${number}" summary="${title}" status="31" issuetype="41"
    created="2020-01-01T00:00:00Z" updated="2020-01-02T00:00:00Z"/>`;
  const association = (id: number, versionId: number, type = 'IssueFixVersion') => `<NodeAssociation sourceNodeId="${id}" sourceNodeEntity="Issue"
    sinkNodeId="${versionId}" sinkNodeEntity="Version" associationType="${type}"/>`;
  const xml = `<entity-engine-xml>
    <Project id="9200" pkey="${projectKey}" name="${projectName}"/>
    <Status id="31" pname="Ready"/>
    <IssueType id="41" pname="Task"/>
    <Version id="9201" project="9200" vname="${firstRelease}" released="false"/>
    <Version id="9202" project="9200" vname="${chosenRelease}" releasedate="${end} 00:00:00.0" released="true"/>
    <Version id="9203" project="9200" vname="${affectedRelease}" released="false"/>
    ${issue(9291, 1, singleTitle)}
    ${issue(9292, 2, multipleTitle)}
    ${issue(9293, 3, affectedTitle)}
    ${association(9291, 9202)}
    ${association(9292, 9201)}
    ${association(9292, 9202)}
    ${association(9293, 9203, 'IssueVersion')}
  </entity-engine-xml>`;
  const snapshot = async () => {
    const response = await request.get('/api/workspace');
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as WorkspaceSnapshot;
  };
  const original = await snapshot();
  const upload = await request.post(`/api/legacy-import/packages?${new URLSearchParams({
    filename, product: 'jira', instanceKey: `synthetic-releases-${suffix}`,
  })}`, {
    headers: { 'Content-Type': 'application/octet-stream' },
    data: zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]),
  });
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

    async function preview() {
      const proposed = page.waitForResponse(response =>
        response.url().endsWith('/api/migrations/preview') && response.request().method() === 'POST');
      await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
      const response = await proposed;
      expect(response.status(), await response.text()).toBe(201);
      return await response.json() as MigrationPreview;
    }
    const initial = await preview();
    expect(initial.canApply, JSON.stringify(initial.notices)).toBe(true);
    expect(initial.counts.jiraReleaseLinks).toBe(1);
    expect(initial.counts.jiraReleaseUnassigned).toBe(1);
    expect(initial.jiraReleaseChoices).toHaveLength(1);
    const choice = initial.jiraReleaseChoices![0];
    expect(choice).toMatchObject({ sourceKey: `${projectKey}-2`, title: multipleTitle, selected: null });
    expect(choice.candidates.map(candidate => candidate.name).sort()).toEqual([firstRelease, chosenRelease].sort());
    const chosenSourceId = choice.candidates.find(candidate => candidate.name === chosenRelease)!.sourceId;
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    const releaseReview = review.getByRole('group', { name: 'Jira 대표 릴리스 선택', exact: true });
    const representative = releaseReview.getByRole('combobox', { name: `대표 릴리스 ${projectKey}-2`, exact: true });
    await expect(representative.getByRole('option', { name: firstRelease, exact: true })).toBeAttached();
    await expect(representative.getByRole('option', { name: chosenRelease, exact: true })).toBeAttached();
    await expect(representative.getByRole('option', { name: '연결하지 않음', exact: true })).toBeAttached();
    await expect(representative.getByRole('option', { name: affectedRelease, exact: true })).toHaveCount(0);
    await expect(review.getByRole('combobox', { name: `대표 릴리스 ${projectKey}-1`, exact: true })).toHaveCount(0);
    for (const code of initial.requiredAcknowledgements) await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    const applyButton = review.getByRole('button', { name: '검토한 이관 실제 적용', exact: true });
    await expect(applyButton).toBeEnabled();
    await representative.selectOption({ label: chosenRelease });
    await expect(applyButton).toBeDisabled();
    await releaseReview.getByRole('button', { name: '선택한 릴리스로 다시 검토', exact: true }).click();
    await expect(review).toHaveCount(0);

    const selected = await preview();
    expect(selected.id).not.toBe(initial.id);
    expect(selected.canApply, JSON.stringify(selected.notices)).toBe(true);
    expect(selected.counts.jiraReleaseLinks).toBe(2);
    expect(selected.counts.jiraReleaseUnassigned ?? 0).toBe(0);
    expect(selected.configuration.jiraReleaseSelections).toMatchObject({ [choice.recordId]: chosenSourceId });
    await expect(representative).toHaveValue(chosenSourceId);
    for (const code of selected.requiredAcknowledgements) {
      await review.getByLabel(`이관 확인 ${code}`, { exact: true }).check();
    }
    const applying = page.waitForResponse(response =>
      response.url().endsWith(`/api/migrations/previews/${selected.id}/apply`) && response.request().method() === 'POST');
    page.once('dialog', dialog => dialog.accept());
    await applyButton.click();
    const applied = await applying;
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: receipt } = await applied.json() as MigrationApplyResult;
    [projectId] = receipt.projectIds;

    const workspace = await snapshot();
    const release = workspace.planningItems?.find(item => item.projectId === projectId && item.name === chosenRelease);
    expect(release).toBeDefined();
    expect(release).toMatchObject({ kind: 'release', status: 'completed', targetDate: end });
    const issues = workspace.issues.filter(item => item.projectId === projectId);
    expect(issues.filter(item => item.releaseId === release!.id).map(item => item.title).sort()).toEqual([singleTitle, multipleTitle].sort());
    expect(issues.find(item => item.title === affectedTitle)?.releaseId).toBeNull();

    const receiptLink = settings.getByRole('link', { name: `${projectName} 프로젝트 열기`, exact: true });
    await expect(receiptLink).toHaveAttribute('aria-disabled', 'false');
    await receiptLink.click();
    await expect(page).toHaveURL(url => url.hash === `#/${projectId}/overview`);
    await page.goto(`/#/${projectId}/planning/${release!.id}`);
    const planning = page.getByRole('region', { name: '릴리스 상세', exact: true });
    await expect(planning.getByLabel('계획 이름', { exact: true })).toHaveValue(chosenRelease);
    await expect(planning.getByLabel('계획 목표일', { exact: true })).toHaveValue(end);
    await expect(planning.getByRole('button').filter({ hasText: singleTitle })).toBeVisible();
    await expect(planning.getByRole('button').filter({ hasText: multipleTitle })).toBeVisible();
    await expect(planning.getByRole('button').filter({ hasText: affectedTitle })).toHaveCount(0);
    await page.getByRole('link', { name: '간트에서 열기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === `#/${projectId}/gantt/${release!.id}`);
    const ganttPlan = page.getByRole('region', { name: '간트 계획 일정', exact: true });
    await expect(ganttPlan.getByRole('button', { name: `릴리스 ${chosenRelease} 간트 선택`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('checkbox', { name: '연결된 업무만', exact: true }).check();
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const rows = chart.locator('.gantt-row[data-issue-id]');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: singleTitle })).toBeVisible();
    await expect(rows.filter({ hasText: multipleTitle })).toBeVisible();
    await expect(chart.getByRole('img', { name: `${chosenRelease} 계획 목표일 ${end}`, exact: true })).toBeVisible();
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
