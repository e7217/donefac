import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { LegacyPackageSummary, MigrationApplyResult, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

function calendarDate(offset: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

test('Jira 날짜 선택 필드를 이관 전에 검토하고 간트의 업무 일정으로 연다', async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 360, height: 820 });

  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const key = `JDT${suffix}`;
  const projectName = `Jira 일정 견본 ${suffix}`;
  const title = `Jira 배포 계획 업무 ${suffix}`;
  const filename = `jira-dates-${suffix}.zip`;
  const start = calendarDate(1);
  const end = calendarDate(4);
  const baseline = calendarDate(-5);
  const picker = 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker';
  const xml = `<entity-engine-xml>
    <Project id="8900" pkey="${key}" name="${projectName}"/>
    <Status id="31" pname="Ready"/>
    <IssueType id="41" pname="Task"/>
    <CustomField id="89001" cfname="Start date" customfieldtypekey="${picker}"/>
    <CustomField id="89002" cfname="End date" customfieldtypekey="${picker}"/>
    <CustomField id="89003" cfname="Baseline start date" customfieldtypekey="${picker}"/>
    <Issue id="89100" project="8900" number="1" summary="${title}" status="31" issuetype="41"
      created="2020-01-01T00:00:00Z" updated="2020-01-02T00:00:00Z"/>
    <CustomFieldValue id="89201" issue="89100" customfield="89001" datevalue="${start} 00:00:00.0"/>
    <CustomFieldValue id="89202" issue="89100" customfield="89002" datevalue="${end} 00:00:00.0"/>
    <CustomFieldValue id="89203" issue="89100" customfield="89003" datevalue="${baseline} 00:00:00.0"/>
  </entity-engine-xml>`;
  const snapshot = async () => {
    const response = await request.get('/api/workspace');
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as WorkspaceSnapshot;
  };
  const original = await snapshot();
  const upload = await request.post(`/api/legacy-import/packages?${new URLSearchParams({
    filename, product: 'jira', instanceKey: `synthetic-schedule-${suffix}`,
  })}`, {
    headers: { 'Content-Type': 'application/octet-stream' },
    data: zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]),
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const source = await upload.json() as LegacyPackageSummary;
  let issueId: string | undefined;

  try {
    await page.goto(`/#/${original.projects[0].id}/settings?section=migration`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    await expect(settings).toBeVisible({ timeout: 30_000 });
    await settings.getByLabel(`이관 패키지 ${filename}`, { exact: true }).check();
    await settings.getByRole('button', { name: '선택 패키지 매핑 불러오기', exact: true }).click();
    await expect(settings.getByLabel('이관 원본 시간대', { exact: true })).toBeVisible();

    const proposed = page.waitForResponse(response =>
      response.url().endsWith('/api/migrations/preview') && response.request().method() === 'POST');
    await settings.getByRole('button', { name: '적용 전 미리보기 만들기', exact: true }).click();
    const previewResponse = await proposed;
    expect(previewResponse.status(), await previewResponse.text()).toBe(201);
    const preview = await previewResponse.json() as MigrationPreview;
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    expect(preview.samples.find(sample => sample.title === title)?.schedule).toEqual({ startDate: start, endDate: end });
    const review = settings.getByRole('region', { name: '이관 적용 미리보기', exact: true });
    await review.getByText('변환된 업무·문서', { exact: true }).click();
    await review.getByRole('button', { name: `변환 결과 보기 ${title}`, exact: true }).click();
    const sample = page.getByRole('dialog', { name: `변환 결과 · ${title}`, exact: true });
    await expect(sample).toBeVisible();
    await expect(sample).toContainText('일정');
    await expect(sample).toContainText(start);
    await expect(sample).toContainText(end);
    await expect(sample).not.toContainText(baseline);
    await sample.getByRole('button', { name: '닫기', exact: true }).click();

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
    const [projectId] = receipt.projectIds;
    const issue = (await snapshot()).issues.find(candidate => candidate.projectId === projectId && candidate.title === title);
    assert.ok(issue);
    issueId = issue.id;
    expect(issue).toMatchObject({ key: `${key}-1`, startDate: start, endDate: end, dueDate: null });

    const receiptLink = settings.getByRole('link', { name: `${projectName} 프로젝트 열기`, exact: true });
    await expect(receiptLink).toHaveAttribute('aria-disabled', 'false');
    await receiptLink.click();
    await expect(page).toHaveURL(url => url.hash === `#/${projectId}/overview`);
    await page.goto(`/#/${projectId}/gantt`);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const row = chart.locator(`[data-issue-id="${issue.id}"]`);
    await expect(row.getByLabel(`${issue.key} 시작일`, { exact: true })).toHaveValue(start);
    await expect(row.getByLabel(`${issue.key} 종료일`, { exact: true })).toHaveValue(end);
    const bar = row.getByRole('button', { name: `${issue.key} 일정 이동`, exact: true });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('title', new RegExp(`${start} ~ ${end}`));
  } finally {
    if (issueId) {
      const archived = await request.delete(`/api/issues/${issueId}`);
      if (archived.ok()) {
        const { trashEntryId } = await archived.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
  }
});
