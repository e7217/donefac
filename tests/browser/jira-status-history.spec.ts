import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

test.use({ viewport: { width: 360, height: 820 }, timezoneId: 'UTC' });

test('Jira XML 상태 변경과 Teamspace 편집을 업무 이력에서 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const key = `JH${suffix}`;
  const title = `Jira 상태 이력 견본 ${suffix}`;
  const otherTitle = `상태 이력이 없는 업무 ${suffix}`;
  const originalAuthor = '원본 Jira 작성자';
  const rawSummary = '원본 제목 변경 문자열';
  const latestRawTime = '2020-01-04 10:00:00.000';
  const intermediateChanges = Array.from({ length: 49 }, (_, index) => {
    const id = 6010 + index;
    const time = new Date(Date.UTC(2020, 0, 3, 10, index)).toISOString();
    return `<ChangeGroup id="${id}" issue="300" created="${time}"/>
      <ChangeItem id="${id + 500}" group="${id}" field="status" fieldtype="jira"
        oldvalue="1" oldstring="검토 전" newvalue="2" newstring="검토 후"/>`;
  }).join('\n');
  const xml = `<entity-engine-xml>
    <Project id="20" pkey="${key}" name="Jira 상태 이력 ${suffix}"/>
    <ApplicationUser id="10" userKey="user-key-alice" lowerUserName="alice"/>
    <User id="11" userName="alice" lowerUserName="alice" displayName="${originalAuthor}"/>
    <Status id="1" pname="Ready"/>
    <Status id="2" pname="Done"/>
    <IssueType id="41" pname="Task"/>
    <Issue id="300" project="20" number="1" summary="${title}" status="1" issuetype="41"
      created="2020-01-01T00:00:00Z" updated="2020-01-04T10:00:00Z"/>
    <Issue id="301" project="20" number="2" summary="${otherTitle}" status="2" issuetype="41"
      created="2020-01-01T00:00:00Z" updated="2020-01-02T00:00:00Z"/>
    <ChangeGroup id="600" issue="300" author="alice" created="${latestRawTime}"/>
    <ChangeItem id="700" group="600" field="status" fieldtype="jira"
      oldvalue="1" oldstring="원래 검토 대기" newvalue="2" newstring="원래 검토 완료"/>
    <ChangeItem id="701" group="600" field="summary" fieldtype="jira"
      oldstring="${rawSummary}" newstring="${title}"/>
    ${intermediateChanges}
    <ChangeGroup id="650" issue="300" created="2020-01-02T10:00:00Z"/>
    <ChangeItem id="750" group="650" field="status" fieldtype="jira"
      oldvalue="1999" newvalue="1" newstring="원래 최초 대기"/>
  </entity-engine-xml>`;
  const upload = await request.post(`/api/legacy-import/packages?${new URLSearchParams({
    filename: `jira-status-history-${suffix}.zip`,
    product: 'jira',
    instanceKey: `synthetic-history-${suffix}`,
  })}`, {
    headers: { 'Content-Type': 'application/octet-stream' },
    data: zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]),
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const source = await upload.json() as LegacyPackageSummary;
  const importedIssueIds: string[] = [];

  try {
    const options = await request.get(`/api/migrations/options?${new URLSearchParams({ packageId: source.id })}`);
    expect(options.ok(), await options.text()).toBe(true);
    const { defaultConfiguration } = await options.json() as MigrationOptions;
    const proposed = await request.post('/api/migrations/preview', { data: { configuration: defaultConfiguration } });
    expect(proposed.status(), await proposed.text()).toBe(201);
    const preview = await proposed.json() as MigrationPreview;
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    const applied = await request.post(`/api/migrations/previews/${preview.id}/apply`, { data: {
      expectedVersion: preview.version,
      acknowledgements: preview.requiredAcknowledgements,
    } });
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: receipt } = await applied.json() as MigrationApplyResult;
    const [projectId] = receipt.projectIds;
    const workspaceResponse = await request.get('/api/workspace');
    expect(workspaceResponse.ok(), await workspaceResponse.text()).toBe(true);
    const workspace = await workspaceResponse.json() as WorkspaceSnapshot;
    const issues = workspace.issues.filter(issue => issue.projectId === projectId);
    importedIssueIds.push(...issues.map(issue => issue.id));
    const issue = issues.find(issue => issue.title === title);
    const other = issues.find(issue => issue.title === otherTitle);
    assert.ok(issue && other);

    const historyRequests: string[] = [];
    page.on('request', sent => {
      if (new URL(sent.url()).pathname === `/api/issues/${issue.id}/jira-status-history`) historyRequests.push(sent.url());
    });
    await page.goto(`/#/${projectId}/issues?issue=${issue.id}`);
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    const status = dialog.getByLabel('상태', { exact: true });
    await expect(status).toHaveValue(issue.status);
    await status.selectOption(other.status);
    const saving = page.waitForResponse(response =>
      response.url().endsWith(`/api/issues/${issue.id}`) && response.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const saved = await saving;
    expect(saved.ok(), await saved.text()).toBe(true);
    await expect(dialog.getByRole('button', { name: '변경사항 저장', exact: true })).toBeDisabled();
    expect(historyRequests).toHaveLength(0);

    await dialog.getByRole('button', { name: '변경 이력', exact: true }).click();
    const local = dialog.getByRole('region', { name: 'Teamspace 변경 이력', exact: true });
    await expect(local).toContainText(`${issue.key}:`);
    await expect(local).toContainText('status');
    const history = dialog.getByRole('region', { name: 'Jira 상태 변경 이력', exact: true });
    const entries = history.getByRole('list', { name: '이관한 상태 변경 목록', exact: true }).getByRole('listitem');
    await expect(entries).toHaveCount(50);
    await expect(entries.first()).toContainText('원래 검토 대기');
    await expect(entries.first()).toContainText('원래 검토 완료');
    await expect(entries.first()).toContainText(originalAuthor);
    await expect(entries.first().locator('time')).toHaveAttribute('datetime', '2020-01-04T10:00:00.000Z');
    await expect(history).not.toContainText(rawSummary);
    const panel = dialog.locator('.issue-panel-content');
    expect(await panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

    const openRaw = entries.first().getByRole('button', { name: '1번째 Jira 상태 변경 원본 기록', exact: true });
    await expect(openRaw).toHaveAttribute('aria-expanded', 'false');
    await openRaw.click();
    await expect(openRaw).toHaveAttribute('aria-expanded', 'true');
    const raw = entries.first().getByRole('region', { name: '보존한 원본 기록 상세', exact: true });
    await expect(raw.getByText('600', { exact: true })).toBeVisible();
    await expect(raw.getByText(latestRawTime, { exact: true })).toBeVisible();
    await raw.getByText('원본 메타데이터', { exact: true }).click();
    await expect(raw.getByText(rawSummary, { exact: false })).toBeVisible();
    await raw.getByRole('button', { name: '원본 이관 기록 상세 닫기', exact: true }).click();
    await expect(openRaw).toBeFocused();
    await expect(raw).toHaveCount(0);

    const next = history.getByRole('button', { name: 'Jira 상태 변경 다음 페이지', exact: true });
    const previous = history.getByRole('button', { name: 'Jira 상태 변경 이전 페이지', exact: true });
    await next.click();
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('상태 ID 1999');
    await expect(entries.first()).toContainText('원래 최초 대기');
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(entries).toHaveCount(50);

    await dialog.getByRole('button', { name: '원본 기록', exact: true }).click();
    const origin = dialog.getByRole('region', { name: '원본 이관 기록', exact: true });
    await origin.getByLabel('원본 이관 기록 종류', { exact: true }).selectOption('history');
    await expect(origin.getByRole('button').filter({ hasText: '원본 600 ·' })).toBeVisible();

    await page.goto(`/#/${projectId}/issues?issue=${other.id}`);
    const otherDialog = page.getByRole('dialog', { name: otherTitle, exact: true });
    const loadingOther = page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/issues/${other.id}/jira-status-history`);
    await otherDialog.getByRole('button', { name: '변경 이력', exact: true }).click();
    const loadedOther = await loadingOther;
    expect(loadedOther.ok(), await loadedOther.text()).toBe(true);
    await expect(otherDialog.getByRole('region', { name: 'Jira 상태 변경 이력', exact: true })).toHaveCount(0);
  } finally {
    for (const id of importedIssueIds) {
      const archived = await request.delete(`/api/issues/${id}`);
      if (archived.ok()) {
        const { trashEntryId } = await archived.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
  }
});
