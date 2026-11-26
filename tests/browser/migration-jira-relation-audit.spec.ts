import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type {
  LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, SourceRecordArchive, SourceRecordPage,
  SourceReconciliationAudit, SourceReconciliationJiraRelationFindingsPage, WorkspaceSnapshot,
} from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

async function readJson<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

test('360px Jira 업무 관계를 검증하고 누락 및 불일치의 보존 원본을 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const token = randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase();
  const sourceInstance = `jira-relation-audit-${token}`;
  const filename = `${sourceInstance}.zip`;
  const created = '2025-01-01T00:00:00Z';
  const trashTitle = '휴지통에 옮길 연결 업무';
  const xml = `<entity-engine-xml version="9.12">
    <Project id="4100" pkey="RA${token}" name="Jira 관계 대조 원본 ${token}"/>
    <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>
    <Issue id="4401" project="4100" number="1" summary="기준 업무" status="1" issuetype="3" created="${created}" updated="${created}"/>
    <Issue id="4402" project="4100" number="2" summary="${trashTitle}" status="1" issuetype="3" created="${created}" updated="${created}"/>
    <Issue id="4403" project="4100" number="3" summary="두 번째 연결 업무" status="1" issuetype="3" created="${created}" updated="${created}"/>
    <IssueLinkType id="10000" linkname="Blocks" inward="is blocked by" outward="blocks"/>
    <IssueLink id="501" linktype="10000" source="4401" destination="4402"/>
    <IssueLink id="502" linktype="10000" source="4401" destination="4403"/>
  </entity-engine-xml>`;
  const pkg = await readJson<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${new URLSearchParams({ filename, instanceKey: sourceInstance })}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]),
  }), 201);
  let trashEntryId: string | undefined;

  try {
    const { defaultConfiguration: configuration } = await readJson<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${pkg.id}`));
    const plan = await readJson<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
    expect(plan.canApply, JSON.stringify(plan.notices.filter(notice => notice.severity === 'error'))).toBe(true);
    expect(plan.counts.issueRelations).toBe(2);
    const { import: receipt } = await readJson<MigrationApplyResult>(await request.post(`/api/migrations/previews/${plan.id}/apply`, {
      data: { expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements },
    }), 201);
    const [projectId] = receipt.projectIds;
    const workspace = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const issue = workspace.issues.find(candidate => candidate.projectId === projectId && candidate.title === trashTitle)!;
    expect(issue).toBeTruthy();
    const receiptPath = `/api/source-imports/${receipt.id}`;
    const auditPath = `${receiptPath}/reconciliation/audit`;
    const findingPath = `${receiptPath}/reconciliation/jira-relation-findings`;
    const recordPath = `${receiptPath}/records/`;
    const { records } = await readJson<SourceRecordPage>(await request.get(`${receiptPath}/records?kind=relation`));
    expect(records.map(archive => archive.record.sourceId).sort()).toEqual(['501', '502']);
    expect(records.every(archive => archive.jiraRelationId && archive.source.instanceKey === sourceInstance)).toBe(true);
    const archiveReads: string[] = [];
    const findingReads: string[] = [];
    const writes: string[] = [];
    page.on('request', value => {
      const url = new URL(value.url());
      const method = value.method();
      if (url.pathname.startsWith(recordPath)) archiveReads.push(`${method} ${url.pathname}`);
      if (url.pathname === findingPath) findingReads.push(`${method} ${url.pathname}${url.search}`);
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) writes.push(`${method} ${url.pathname}`);
    });

    await page.goto(`/#/${projectId}/settings?section=migration`);
    const settings = page.getByRole('region', { name: '실제 데이터 이관', exact: true });
    const receipts = settings.getByRole('region', { name: '완료한 이관 영수증', exact: true });
    await receipts.getByRole('button').filter({ hasText: receipt.id }).click();
    await settings.getByRole('button', { name: '이관 결과 대조', exact: true }).click();
    const reconciliation = settings.getByRole('region', { name: '이관 결과 대조', exact: true });
    const search = reconciliation.getByRole('searchbox', { name: '대조 검색', exact: true });
    await search.fill('기존 대조 검색 조건');
    await reconciliation.getByRole('button', { name: '대조 검색 실행', exact: true }).click();
    await expect(reconciliation.getByText('조건에 맞는 원본이 없습니다.')).toBeVisible();
    const run = reconciliation.getByRole('button', { name: '전체 이관 검증', exact: true });
    const relations = reconciliation.getByRole('region', { name: 'Jira 업무 관계 검증', exact: true });
    const count = (name: string) => relations.getByText(name, { exact: true }).locator('..').locator('dd');
    async function audit() {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === auditPath);
      await run.click();
      const response = await pending;
      expect(response.ok(), await response.text()).toBe(true);
      await expect(relations).toBeVisible();
      return response.json() as Promise<SourceReconciliationAudit>;
    }

    const linked = await audit();
    expect(linked.jiraRelationProjection).toMatchObject({ version: 1, expected: 2,
      counts: { linked: 2, trashed: 0, missing: 0, mismatch: 0, unavailable: 0 } });
    await expect(count('현재 연결')).toHaveText('2');
    await expect(count('휴지통 보관')).toHaveText('0');

    ({ trashEntryId } = await readJson<{ trashEntryId: string }>(await request.delete(`/api/issues/${issue.id}?expectedVersion=${issue.version}`)));
    const trashed = await audit();
    expect(trashed.jiraRelationProjection).toMatchObject({ expected: 2,
      counts: { linked: 1, trashed: 1, missing: 0, mismatch: 0, unavailable: 0 } });
    expect(trashed.jiraRelationProjection?.sha256).not.toBe(linked.jiraRelationProjection?.sha256);
    await expect(count('현재 연결')).toHaveText('1');
    await expect(count('휴지통 보관')).toHaveText('1');
    await expect(relations.getByText('확인 필요', { exact: true })).toBeVisible();
    await expect(relations.getByText('검증 실패', { exact: true })).toHaveCount(0);

    const restoredIssue = await request.post(`/api/trash/${trashEntryId}/restore`);
    expect(restoredIssue.ok(), await restoredIssue.text()).toBe(true);
    trashEntryId = undefined;
    const restored = await audit();
    expect(restored.jiraRelationProjection?.counts).toEqual(linked.jiraRelationProjection?.counts);
    await expect(count('현재 연결')).toHaveText('2');
    await expect(count('휴지통 보관')).toHaveText('0');
    expect(findingReads).toEqual([]);
    expect(archiveReads).toEqual([]);

    const sha256 = createHash('sha256').update('synthetic relation findings').digest('hex');
    const findings = [
      { finding: 'missing', label: '관계 누락', sourceId: '501', targetIssueId: '4402' },
      { finding: 'mismatch', label: '원본과 불일치', sourceId: '502', targetIssueId: '4403' },
    ] as const;
    await page.route(url => url.pathname === auditPath, route => route.fulfill({ json: {
      ...restored, jiraRelationProjection: { version: 1, expected: 2, sha256,
        counts: { linked: 0, trashed: 0, missing: 1, mismatch: 1, unavailable: 0 } },
    } }), { times: 1 });
    await page.route(url => url.pathname === findingPath, route => {
      const finding = new URL(route.request().url()).searchParams.get('finding');
      const fixture = findings.find(value => value.finding === finding);
      if (!fixture) return route.continue();
      const { id: sourceRecordId } = records.find(archive => archive.record.sourceId === fixture.sourceId)!;
      const response: SourceReconciliationJiraRelationFindingsPage = {
        importId: receipt.id, receiptVersion: receipt.version, finding: fixture.finding, sha256,
        total: 1, offset: 0, limit: 20, rows: [{ sourceRecordId, sourceId: fixture.sourceId, sourceInstance }],
      };
      return route.fulfill({ json: response });
    });

    await audit();
    await expect(relations.getByText('검증 실패', { exact: true })).toBeVisible();
    const relationFindings = relations.getByRole('region', { name: '확인할 Jira 관계', exact: true });
    const list = relationFindings.getByRole('list', { name: 'Jira 관계 원본 목록', exact: true });
    for (const fixture of findings) {
      const opener = relations.getByRole('button', { name: `${fixture.label} 1개 보기`, exact: true });
      const findingResponse = page.waitForResponse(response => new URL(response.url()).pathname === findingPath);
      await opener.click();
      const loaded = await findingResponse;
      expect(loaded.ok(), await loaded.text()).toBe(true);
      const query = new URL(loaded.url()).searchParams;
      expect(Object.fromEntries(query)).toEqual({ expectedVersion: String(receipt.version), expectedSha256: sha256,
        finding: fixture.finding, offset: '0', limit: '20' });
      await expect(relationFindings.getByRole('heading', { name: '확인할 Jira 관계', exact: true })).toBeFocused();
      const rows = list.getByRole('listitem');
      await expect(rows).toHaveCount(1);
      const show = rows.getByRole('button', { name: `Jira 관계 원본 ${sourceInstance} / ${fixture.sourceId} 열기`, exact: true });
      const pending = page.waitForResponse(response => new URL(response.url()).pathname.startsWith(recordPath));
      await show.click();
      const response = await pending;
      expect(response.ok(), await response.text()).toBe(true);
      const archive = await response.json() as SourceRecordArchive;
      const expected = records.find(value => value.record.sourceId === fixture.sourceId)!;
      expect(new URL(response.url()).pathname).toBe(`${recordPath}${expected.id}`);
      expect(archive).toMatchObject({ id: expected.id, sourceImportId: receipt.id, packageSha256: pkg.sha256,
        source: { instanceKey: sourceInstance }, record: { sourceId: fixture.sourceId, kind: 'relation' } });
      const detail = rows.getByRole('region', { name: '보존한 원본 기록 상세', exact: true });
      await expect(detail.getByText(pkg.sha256, { exact: true })).toBeVisible();
      await expect(detail.getByText(fixture.sourceId, { exact: true })).toBeVisible();
      await detail.getByText('원본 관계', { exact: true }).click();
      await expect(detail.locator('details[open] pre')).toContainText(fixture.targetIssueId);
      const bounds = await relationFindings.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(361);
      expect(await relationFindings.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil(bounds!.width));
      await detail.getByRole('button', { name: '원본 이관 기록 상세 닫기', exact: true }).click();
      await expect(show).toBeFocused();
      await relationFindings.getByRole('button', { name: '관계 목록 닫기', exact: true }).click();
      await expect(opener).toBeFocused();
      await expect(search).toHaveValue('기존 대조 검색 조건');
    }
    expect(findingReads).toHaveLength(2);
    expect(findingReads.every(value => value.startsWith(`GET ${findingPath}?`))).toBe(true);
    expect(archiveReads).toEqual(findings.map(fixture => `GET ${recordPath}${records.find(archive => archive.record.sourceId === fixture.sourceId)!.id}`));
    expect(writes).toEqual([]);
  } finally {
    if (trashEntryId) await request.post(`/api/trash/${trashEntryId}/restore`);
    await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});
