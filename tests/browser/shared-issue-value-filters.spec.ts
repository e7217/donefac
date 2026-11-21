import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import type { DocPage, Issue, SavedView, WorkspaceSnapshot } from '../../shared/types';

test('360px 업무에서 저장한 우선순위·라벨 조건을 보드와 간트, 문서에서 함께 사용한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const suffix = randomUUID().slice(0, 8);
  const prefix = `업무 필터 ${suffix}`;
  const releaseLabel = `release-${suffix}`;
  const qaLabel = `qa-${suffix}`;
  const blockedLabel = `blocked-${suffix}`;
  const releaseLabels = [releaseLabel, qaLabel];
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = workspace.projects[0].id;
  const issues: Issue[] = [];
  let saved: SavedView | undefined;
  let document: DocPage | undefined;

  async function createIssue(title: string, priority: Issue['priority'], labels: string[]) {
    const response = await request.post('/api/issues', { data: {
      projectId, title: `${prefix} ${title}`, priority, labels, startDate: '2030-07-05', endDate: '2030-07-08',
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }

  try {
    const high = await createIssue('높음', 'high', releaseLabels);
    const urgent = await createIssue('긴급', 'urgent', releaseLabels);
    await createIssue('보통', 'medium', releaseLabels);
    const partial = await createIssue('라벨 일부', 'high', [releaseLabel]);
    const blocked = await createIssue('제외 라벨', 'high', [...releaseLabels, blockedLabel]);
    const unlabeled = await createIssue('라벨 없음', 'high', []);
    const similar = await createIssue('이름이 비슷한 라벨', 'high', [releaseLabel, `${qaLabel}-next`]);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/issues`);
    const search = page.getByRole('textbox', { name: '업무 검색', exact: true });
    await search.fill(prefix);
    const disclosure = page.getByRole('button', { name: '우선순위·라벨 필터', exact: true });
    const panel = page.getByRole('region', { name: '우선순위·라벨 필터', exact: true });
    const presence = panel.getByRole('combobox', { name: '라벨 유무', exact: true });
    const match = panel.getByRole('combobox', { name: '포함 조건', exact: true });
    const rows = page.locator('.issue-table tbody');

    async function expectList(expected: Issue[]) {
      for (const issue of issues) {
        const row = rows.getByText(issue.title, { exact: true });
        if (expected.includes(issue)) await expect(row).toBeVisible();
        else await expect(row).toHaveCount(0);
      }
    }

    async function applyFilters() {
      await panel.getByRole('button', { name: '적용', exact: true }).click();
      await expect(panel).toBeHidden();
    }

    async function addLabel(kind: '포함' | '제외', label: string) {
      await panel.getByRole('combobox', { name: `${kind} 라벨`, exact: true }).selectOption(label);
      await panel.getByRole('button', { name: `${kind} 라벨 추가`, exact: true }).click();
    }

    await disclosure.click();
    await panel.getByRole('checkbox', { name: '높음', exact: true }).check();
    await panel.getByRole('checkbox', { name: '긴급', exact: true }).check();
    await presence.selectOption('empty');
    await applyFilters();
    await expectList([unlabeled]);

    await disclosure.click();
    await presence.selectOption('');
    for (const label of releaseLabels) await addLabel('포함', label);
    await addLabel('제외', blockedLabel);
    await expect(match).toHaveValue('any');
    await applyFilters();
    await expectList([high, urgent, partial, similar]);

    await disclosure.click();
    await match.selectOption('all');
    await applyFilters();
    await expectList([high, urgent]);

    await page.getByRole('button', { name: '보드', exact: true }).click();
    const cards = page.locator('.issue-board-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.getByText(high.title, { exact: true })).toBeVisible();
    await expect(cards.getByText(urgent.title, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '현재 보기 저장', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '업무 보기 저장', exact: true });
    await dialog.getByRole('textbox', { name: '보기 이름', exact: true }).fill(`${prefix} 공유 보기`);
    const viewCreated = page.waitForResponse(response => response.url().endsWith('/api/views') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    const saveResponse = await viewCreated;
    expect(saveResponse.status(), await saveResponse.text()).toBe(201);
    saved = await saveResponse.json() as SavedView;
    expect(saved.layout).toBe('board');
    expect([...(saved.filters.priorities ?? [])].sort()).toEqual(['high', 'urgent']);
    expect([...(saved.filters.labels?.include ?? [])].sort()).toEqual([...releaseLabels].sort());
    expect(saved.filters.labels).toMatchObject({ match: 'all', exclude: [blockedLabel] });

    await page.goto(`/#/${projectId}/issues?savedView=${saved.id}`);
    await page.reload();
    await expect(page.getByRole('combobox', { name: '저장된 업무 보기', exact: true })).toHaveValue(saved.id);
    await expect(cards).toHaveCount(2);
    await expect(cards.getByText(high.title, { exact: true })).toBeVisible();
    await expect(cards.getByText(urgent.title, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${projectId}/gantt?savedView=${saved?.id}`);
    const gantt = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(gantt.locator('.gantt-row[data-issue-id]')).toHaveCount(2);
    for (const issue of [high, urgent]) await expect(gantt.locator(`.gantt-row[data-issue-id="${issue.id}"]`)).toBeVisible();
    const criteria = page.getByRole('list', { name: '간트에 적용된 우선순위·라벨 조건', exact: true });
    await expect(criteria).toContainText('우선순위 · 긴급, 높음');
    await expect(criteria).toContainText('라벨 모두');
    await expect(criteria).toContainText(releaseLabel);
    await expect(criteria).toContainText(qaLabel);
    await expect(criteria).toContainText(`라벨 제외 · ${blockedLabel}`);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '간트 HTML 내려받기', exact: true }).click(),
    ]);
    const report = await readFile(await download.path(), 'utf8');
    for (const label of await criteria.getByRole('listitem').allTextContents()) expect(report).toContain(label);
    for (const issue of issues) {
      if (issue === high || issue === urgent) expect(report).toContain(issue.title);
      else expect(report).not.toContain(issue.title);
    }

    const viewAttrs = { projectId, savedViewId: saved.id, label: saved.name };
    const createdDoc = await request.post('/api/documents', { data: { projectId, title: `${prefix} 회의록`, content: {
      type: 'doc', content: [{ type: 'issueList', attrs: viewAttrs }, { type: 'issueSummary', attrs: { ...viewAttrs, groupBy: 'priority' } }],
    } } });
    expect(createdDoc.status(), await createdDoc.text()).toBe(201);
    document = await createdDoc.json() as DocPage;
    await page.goto(`/#/${projectId}/documents`);
    await page.reload();
    await page.getByRole('button', { name: new RegExp(`${document.title} 초안$`) }).click();
    await expect(page.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(document.title);

    const issueList = page.getByRole('region', { name: '업무 목록', exact: true });
    const summary = page.getByRole('region', { name: '업무 현황', exact: true });
    const documentIssue = (issue: Issue) => issueList.getByRole('button', { name: `목록 업무 열기 ${issue.key} ${issue.title}`, exact: true });
    await expect(issueList.getByRole('button', { name: /^목록 업무 열기 / })).toHaveCount(2);
    await expect(documentIssue(high)).toBeVisible();
    await expect(documentIssue(urgent)).toBeVisible();
    await expect(summary.getByRole('button', { name: '높음 1개', exact: true })).toBeVisible();
    await expect(summary.getByRole('button', { name: '긴급 1개', exact: true })).toBeVisible();

    const changedPriority = await request.patch(`/api/issues/${urgent.id}`, { data: { expectedVersion: urgent.version, priority: 'low' } });
    expect(changedPriority.status(), await changedPriority.text()).toBe(200);
    const changedLabels = await request.patch(`/api/issues/${blocked.id}`, { data: { expectedVersion: blocked.version, labels: releaseLabels } });
    expect(changedLabels.status(), await changedLabels.text()).toBe(200);
    await page.getByRole('button', { name: '참조 새로고침', exact: true }).click();
    await expect(documentIssue(high)).toBeVisible();
    await expect(documentIssue(blocked)).toBeVisible();
    await expect(documentIssue(urgent)).toHaveCount(0);
    await expect(summary.getByRole('button', { name: '긴급 1개', exact: true })).toHaveCount(0);
    await summary.getByRole('button', { name: '높음 2개', exact: true }).click();
    await expect(summary.getByRole('button', { name: `현황 업무 열기 ${blocked.key} ${blocked.title}`, exact: true })).toBeVisible();
    const latest = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    expect(latest.documents.find(item => item.id === document?.id)?.version).toBe(document.version);
  } finally {
    if (document) {
      const deleted = await request.delete(`/api/documents/${document.id}`);
      if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json()).trashEntryId}`);
    }
    if (saved) await request.delete(`/api/views/${saved.id}?expectedVersion=${saved.version}`);
    for (const issue of issues) {
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) await request.delete(`/api/trash/${(await deleted.json()).trashEntryId}`);
    }
  }
});
