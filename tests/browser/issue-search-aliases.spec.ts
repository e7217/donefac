import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move';
import type {
  Issue, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, Project, WorkspaceSnapshot,
} from '../../shared/types';

async function json<T>(response: APIResponse, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(expected);
  return JSON.parse(body) as T;
}

test('360px 이전 번호로 Jira 이관 업무의 충돌을 구분하고 이동한 업무를 연다', async ({ page, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const currentKey = `KS${suffix}`;
  const snapshot = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const { projects: [destination] } = await snapshot();
  const packages: LegacyPackageSummary[] = [];
  const issueIds = new Set<string>();
  async function addIssue(projectId: string, title: string) {
    const row = await json<Issue>(await request.post('/api/issues', { data: { projectId, title } }), 201);
    issueIds.add(row.id);
    return row;
  }
  async function migrate(jiraKey: string, discriminator: string, title: string) {
    const csv = [
      'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type',
      `100,${jiraKey},${currentKey},${title},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task`,
    ].join('\r\n');
    const query = new URLSearchParams({ filename: `jira-${suffix}-${discriminator}.csv`, product: 'jira', instanceKey: `key-${suffix}-${discriminator}` });
    const pkg = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
      headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from(csv),
    }), 201);
    packages.push(pkg);
    const { defaultConfiguration } = await json<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${pkg.id}`));
    const configuration = { ...defaultConfiguration, projects: defaultConfiguration.projects.map(project => ({
      ...project, key: `${currentKey}${discriminator}`, name: `Jira 이관 ${discriminator} ${suffix}`,
    })) };
    const preview = await json<MigrationPreview>(await request.post('/api/migrations/preview', { data: { configuration } }), 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    const { import: { projectIds: [projectId] } } = await json<MigrationApplyResult>(await request.post(`/api/migrations/previews/${preview.id}/apply`, {
      data: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    }), 201);
    const { issues, projects } = await snapshot();
    const issue = issues.find(row => row.projectId === projectId && row.title === title)!;
    const project = projects.find(row => row.id === projectId)!;
    expect(issue).toBeDefined();
    expect(project).toBeDefined();
    issueIds.add(issue.id);
    return { issue, project };
  }

  try {
    const project = await json<Project>(await request.post('/api/projects', { data: { key: currentKey, name: `현행 업무 ${suffix}` } }), 201);
    const current = await addIssue(project.id, `현재 번호와 일치하는 업무 ${suffix}`);
    const first = await migrate(current.key, 'A', `첫 번째 Jira 원래 업무 ${suffix}`);
    const second = await migrate(current.key, 'B', `두 번째 Jira 원래 업무 ${suffix}`);
    const beforeMove = await addIssue(project.id, `프로젝트를 이동한 업무 ${suffix}`);
    const movePath = `/api/issues/${beforeMove.id}/project-move`;
    const move: IssueProjectMoveInput = { expectedVersion: beforeMove.version, projectId: destination.id, includeConnected: false, mappings: [] };
    const preview = await json<IssueProjectMovePreview>(await request.post(`${movePath}/preview`, { data: move }));
    expect(preview.token, JSON.stringify(preview.blockers)).toBeTruthy();
    const { issues: [moved] } = await json<IssueProjectMoveResult>(await request.post(`${movePath}/apply`, { data: { ...move, token: preview.token } }));

    await page.goto(`/#/${project.id}/issues`);
    const searchButton = page.getByRole('button', { name: '통합 검색', exact: true });
    const quick = page.getByRole('dialog', { name: '통합 검색', exact: true });
    const term = quick.getByRole('textbox', { name: '통합 검색어', exact: true });
    const quickRows = quick.locator('button.search-result-issue');
    await searchButton.click();
    const wideKey = [...current.key.toLowerCase()].map(char => String.fromCharCode(char.charCodeAt(0) + 0xfee0)).join('');
    await term.fill(wideKey);
    await expect(quickRows).toHaveCount(3);
    await expect(quickRows.first()).toContainText(current.title);
    for (const candidate of [first, second]) {
      const row = quickRows.filter({ hasText: candidate.issue.title });
      await expect(row).toContainText(candidate.issue.key);
      await expect(row).toContainText(candidate.project.name);
      await expect(row).toContainText(`Jira 원래 키 ${current.key}`);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await quick.getByRole('button', { name: '전체 검색 결과', exact: true }).click();
    const results = page.getByRole('region', { name: '검색 결과', exact: true });
    const rows = results.getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText(current.title);
    for (const candidate of [first, second]) {
      const row = rows.filter({ hasText: candidate.issue.title });
      await expect(row).toContainText(candidate.project.name);
      await expect(row).toContainText(`Jira 원래 키 ${current.key}`);
      await expect(row.getByRole('button', { name: `${candidate.issue.key} 업무 열기`, exact: true })).toBeVisible();
    }
    const form = page.getByRole('form', { name: '업무·문서 검색 조건', exact: true });
    await form.getByRole('combobox', { name: '검색 공간', exact: true }).selectOption(`project:${second.project.id}`);
    await form.getByRole('button', { name: '검색', exact: true }).click();
    await expect(rows).toHaveCount(1);
    await results.getByRole('button', { name: `${second.issue.key} 업무 열기`, exact: true }).click();
    const jiraDrawer = page.getByRole('dialog', { name: second.issue.title, exact: true });
    await expect(jiraDrawer.getByRole('list', { name: '이전 티켓 번호', exact: true })).toHaveText(`Jira 원래 키 ${current.key}`);
    await expect(jiraDrawer).toContainText(second.issue.key);
    await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('issue')).toBe(second.issue.id);
    await jiraDrawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    await searchButton.click();
    await term.fill(beforeMove.key);
    await expect(quickRows).toHaveCount(1);
    await expect(quickRows).toContainText(moved.key);
    await expect(quickRows).toContainText(destination.name);
    await expect(quickRows).toContainText(`이동 전 키 ${beforeMove.key}`);
    await quickRows.click();
    const movedDrawer = page.getByRole('dialog', { name: moved.title, exact: true });
    await expect(movedDrawer.getByRole('list', { name: '이전 티켓 번호', exact: true })).toHaveText(`이동 전 키 ${beforeMove.key}`);
    await expect(movedDrawer).toContainText(moved.key);
    await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('issue')).toBe(moved.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    for (const id of issueIds) {
      const removed = await request.delete(`/api/issues/${id}`);
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
    }
    for (const pkg of packages) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
});
