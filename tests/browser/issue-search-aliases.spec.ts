import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { contentReferences } from '../../shared/document-nodes';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move';
import type {
  Dependency, DocPage, Issue, IssueRelation, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, Project,
  SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot,
} from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'status' | 'text'>, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(expected);
  return JSON.parse(body) as T;
}

function aliasFixture(request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const currentKey = `KS${suffix}`;
  const snapshot = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'));
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

  async function close() {
    for (const id of issueIds) {
      const removed = await request.delete(`/api/issues/${id}`);
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
    }
    for (const pkg of packages) await request.delete(`/api/legacy-import/packages/${pkg.id}?expectedVersion=${pkg.version}`);
  }
  return { suffix, currentKey, snapshot, addIssue, migrate, close };
}

test('360px 문서 연결과 본문 참조, 티켓 관계에서 이전 키가 가리키는 현재 업무를 선택한다', async ({ page, request }) => {
  test.setTimeout(110_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { suffix, currentKey, snapshot, addIssue, migrate, close } = aliasFixture(request);
  const { projects: [destination] } = await snapshot();
  let document: DocPage | undefined;

  try {
    const project = await json<Project>(await request.post('/api/projects', { data: { key: currentKey, name: `현행 연결 업무 ${suffix}` } }), 201);
    const current = await addIssue(project.id, `현재 키인 업무 ${suffix}`);
    const first = await migrate(current.key, 'A', `첫 Jira의 원본 업무 ${suffix}`);
    const second = await migrate(current.key, 'B', `둘째 Jira의 원본 업무 ${suffix}`);
    const beforeMove = await addIssue(project.id, `다른 프로젝트로 이동한 업무 ${suffix}`);
    const movePath = `/api/issues/${beforeMove.id}/project-move`;
    const move: IssueProjectMoveInput = { expectedVersion: beforeMove.version, projectId: destination.id, includeConnected: false, mappings: [] };
    const reviewed = await json<IssueProjectMovePreview>(await request.post(`${movePath}/preview`, { data: move }));
    expect(reviewed.token, JSON.stringify(reviewed.blockers)).toBeTruthy();
    const { issues: [moved] } = await json<IssueProjectMoveResult>(await request.post(`${movePath}/apply`, { data: { ...move, token: reviewed.token } }));
    expect(moved.key).not.toBe(beforeMove.key);
    const anchor = await addIssue(project.id, `관계를 편집할 업무 ${suffix}`);
    const jiraAlias = `Jira 원래 키 ${current.key}`;
    const moveAlias = `이동 전 키 ${beforeMove.key}`;
    const oldKeyQuery = [...current.key.toLowerCase()].map(char => String.fromCharCode(char.charCodeAt(0) + 0xfee0)).join('');
    const movedQuery = beforeMove.key.toLowerCase();
    const directLinkPath = '/api/resource-links';

    document = await json<DocPage>(await request.post('/api/documents', { data: {
      projectId: destination.id, title: `업무 연결을 검토하는 문서 ${suffix}`, content: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '보존할 문서 본문' }] },
      ] },
    } }), 201);
    const documentId = document.id;
    await page.goto(`/#/${destination.id}/documents/${documentId}`);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(title).toHaveValue(document.title);
    const draftTitle = `저장 전 문서 제목 ${suffix}`;
    const draftBody = `저장 전 본문 ${suffix}`;
    const prose = page.locator('.docs-prose');
    await title.fill(draftTitle);
    await prose.locator('p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(` ${draftBody}`);
    await page.getByRole('button', { name: '정보 패널 열기', exact: true }).click();
    const aside = page.getByLabel('문서 상세 정보', { exact: true });
    await aside.getByRole('button', { name: '연결', exact: true }).click();
    const documentPicker = aside.getByRole('region', { name: '연결할 업무 선택', exact: true });
    const documentSearch = documentPicker.getByRole('searchbox', { name: '연결할 업무 검색', exact: true });
    const documentResults = documentPicker.getByRole('list', { name: '업무 검색 결과', exact: true }).getByRole('button');
    await documentSearch.fill(movedQuery);
    await expect(documentResults).toHaveCount(1);
    await expect(documentResults.first()).toContainText(moved.key);
    await expect(documentResults.first()).toContainText(destination.name);
    await expect(documentResults.first()).toContainText(moveAlias);
    await documentSearch.fill(oldKeyQuery);
    await expect(documentResults).toHaveCount(3);
    await expect(documentResults.first()).toContainText(current.title);
    for (const candidate of [first, second]) {
      const result = documentResults.filter({ hasText: candidate.issue.title });
      await expect(result).toContainText(candidate.issue.key);
      await expect(result).toContainText(candidate.project.name);
      await expect(result).toContainText(jiraAlias);
    }
    const directCandidate = documentResults.filter({ hasText: second.issue.title });
    await directCandidate.click();
    await expect(directCandidate).toHaveAttribute('aria-pressed', 'true');
    const linking = page.waitForResponse(response => new URL(response.url()).pathname === directLinkPath && response.request().method() === 'POST');
    await documentPicker.getByRole('button', { name: '업무 연결', exact: true }).click();
    const linked = await linking;
    expect(linked.request().postDataJSON()).toMatchObject({ documentId, issueId: second.issue.id });
    expect(linked.ok(), await linked.text()).toBe(true);
    await expect(aside.locator('.docs-linked-issue').filter({ hasText: second.issue.key })).toHaveCount(1);
    await expect(directCandidate).toHaveCount(0);
    await expect(title).toHaveValue(draftTitle);
    await expect(prose).toContainText(draftBody);
    const afterLink = await snapshot();
    expect(afterLink.documents.find(value => value.id === documentId)).toEqual(document);
    expect(afterLink.resourceLinks.filter(link => link.documentId === documentId)).toEqual([
      expect.objectContaining({ issueId: second.issue.id, documentId }),
    ]);
    await aside.getByRole('button', { name: '문서 정보 패널 닫기', exact: true }).click();

    const inlineOpen = page.getByRole('button', { name: '업무 참조 삽입', exact: true });
    const chooser = page.getByRole('dialog', { name: '업무 참조 삽입', exact: true });
    const inlineRows = chooser.locator('.doc-reference-results button');
    for (const [candidate, query, alias, count] of [
      [first, oldKeyQuery, jiraAlias, 3], [{ issue: moved, project: destination }, movedQuery, moveAlias, 1],
    ] as const) {
      await prose.locator('p').last().click();
      await page.keyboard.press('Control+End');
      await inlineOpen.click();
      await chooser.getByRole('textbox', { name: '참조할 항목 검색', exact: true }).fill(query);
      await expect(inlineRows).toHaveCount(count);
      if (count === 3) await expect(inlineRows.first()).toContainText(current.title);
      const result = inlineRows.filter({ hasText: candidate.issue.title });
      await expect(result).toContainText(candidate.issue.key);
      await expect(result).toContainText(candidate.project.name);
      await expect(result).toContainText(alias);
      await result.click();
      await expect(chooser).toHaveCount(0);
      await expect(prose.locator('.doc-reference-card.issue').filter({ hasText: candidate.issue.title })).toContainText(candidate.issue.key);
    }
    await expect(title).toHaveValue(draftTitle);
    await expect(prose).toContainText(draftBody);
    await page.locator('.docs-save-button').click();
    await expect(page.locator('.docs-save-state')).toHaveText('저장됨');
    const savedDoc = (await snapshot()).documents.find(value => value.id === documentId)!;
    expect(savedDoc.title).toBe(draftTitle);
    expect(savedDoc.plainText).toContain(draftBody);
    expect(contentReferences(savedDoc.content).map(reference => reference.id).sort()).toEqual([first.issue.id, moved.id].sort());

    await page.goto(`/#/${anchor.projectId}/issues?issue=${anchor.id}`);
    const ticket = page.getByRole('dialog', { name: anchor.title, exact: true });
    const draftTicketTitle = '관계 검토 중 보존할 티켓 제목';
    const draftComment = '관계 검토 중 보존할 댓글';
    const ticketTitle = ticket.getByRole('textbox', { name: '제목', exact: true });
    const comment = ticket.getByRole('textbox', { name: '댓글 내용', exact: true });
    await ticketTitle.fill(draftTicketTitle);
    await comment.fill(draftComment);
    const relations = ticket.getByRole('region', { name: '업무 관계', exact: true });
    const addRelation = relations.getByRole('button', { name: '업무 관계 추가', exact: true });
    const form = relations.getByRole('form', { name: '업무 관계 추가', exact: true });
    const relationSearch = form.getByRole('searchbox', { name: '연결할 업무 검색', exact: true });
    const select = form.getByRole('combobox', { name: '연결할 업무', exact: true });
    const options = select.locator('option:not([value=""])');
    const option = (id: string) => select.locator(`option[value="${id}"]`);
    const relationPath = `/api/issues/${anchor.id}/relations`;
    const relationIds: string[] = [];
    for (const [candidate, query, alias] of [
      [second, oldKeyQuery, jiraAlias], [{ issue: moved, project: destination }, movedQuery, moveAlias],
    ] as const) {
      await addRelation.click();
      await relationSearch.fill(query);
      if (candidate.issue.id === second.issue.id) {
        await expect(option(current.id)).toHaveCount(1);
        await expect(option(first.issue.id)).toContainText(jiraAlias);
        await expect(options.first()).toHaveAttribute('value', current.id);
        await relationSearch.fill(`${query} ${second.project.key}`);
        await expect(option(current.id)).toHaveCount(0);
        await expect(option(first.issue.id)).toHaveCount(0);
      }
      const choice = option(candidate.issue.id);
      await expect(choice).toContainText(candidate.issue.key);
      await expect(choice).toContainText(candidate.project.name);
      await expect(choice).toContainText(alias);
      await expect(form.getByRole('button', { name: '관계 저장', exact: true })).toBeDisabled();
      await select.selectOption(candidate.issue.id);
      await form.getByRole('combobox', { name: '업무 관계 유형', exact: true }).selectOption('blocks');
      const writing = page.waitForResponse(response => new URL(response.url()).pathname === relationPath && response.request().method() === 'POST');
      await form.getByRole('button', { name: '관계 저장', exact: true }).click();
      const response = await writing;
      expect(response.request().postDataJSON()).toMatchObject({ otherIssueId: candidate.issue.id });
      const relation = await json<IssueRelation>(response, 201);
      expect(relation).toMatchObject({ sourceIssueId: anchor.id, targetIssueId: candidate.issue.id, type: 'blocks' });
      relationIds.push(relation.id);
      await expect(form).toHaveCount(0);
      await expect(addRelation).toBeFocused();
      await expect(ticketTitle).toHaveValue(draftTicketTitle);
      await expect(comment).toHaveValue(draftComment);
    }
    const openDuplicate = relations.getByRole('button', { name: '중복으로 닫기', exact: true });
    await openDuplicate.click();
    const duplicate = relations.getByRole('form', { name: '중복으로 닫기', exact: true });
    const originalSearch = duplicate.getByRole('searchbox', { name: '원본 업무 검색', exact: true });
    const originalSelect = duplicate.getByRole('combobox', { name: '원본 업무', exact: true });
    await originalSearch.fill(`${oldKeyQuery} ${first.project.key}`);
    const original = originalSelect.locator(`option[value="${first.issue.id}"]`);
    await expect(original).toContainText(first.issue.key);
    await expect(original).toContainText(jiraAlias);
    await originalSelect.selectOption(first.issue.id);
    await duplicate.getByRole('button', { name: '취소', exact: true }).click();
    await expect(duplicate).toHaveCount(0);
    await expect(openDuplicate).toBeFocused();
    await expect(ticketTitle).toHaveValue(draftTicketTitle);
    await expect(comment).toHaveValue(draftComment);
    expect((await json<IssueRelation[]>(await request.get(relationPath))).map(relation => relation.id).sort()).toEqual(relationIds.sort());
    expect((await snapshot()).issues.find(issue => issue.id === anchor.id)).toEqual(anchor);
  } finally {
    if (document) {
      const removed = await request.delete(`/api/documents/${document.id}`);
      if (removed.ok()) await request.delete(`/api/trash/${(await removed.json() as { trashEntryId: string }).trashEntryId}`);
    }
    await close();
  }
});

test('360px 검색과 간트에서 이전 번호의 충돌을 구분하고 현재 업무를 열거나 연결한다', async ({ page, request }) => {
  test.setTimeout(95_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { suffix, currentKey, snapshot, addIssue, migrate, close } = aliasFixture(request);
  const { projects: [destination] } = await snapshot();

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
    const ganttFixtureTitle = `간트 연결 검증 ${suffix}`;
    const anchor = await addIssue(first.project.id, `${ganttFixtureTitle} 시작 업무`);
    const bulkTarget = await addIssue(first.project.id, `${ganttFixtureTitle} 일괄 연결 업무`);
    const movedTarget = await addIssue(destination.id, `${ganttFixtureTitle} 이동 업무 연결`);

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
    await movedDrawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();

    const jiraAliasLabel = `Jira 원래 키 ${current.key}`;
    const ganttSearch = page.getByRole('textbox', { name: '간트 업무 검색', exact: true });
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const chartRows = chart.locator('.gantt-row[data-issue-id]');
    const chartRow = (issue: Issue) => chart.locator(`.gantt-row[data-issue-id="${issue.id}"]`);
    const chartSelect = (issue: Issue) => chartRow(issue).getByRole('checkbox', { name: `${issue.key} 선택`, exact: true });

    await page.goto(`/#/${project.id}/teamboard`);
    await page.getByRole('searchbox', { name: '보드 업무 검색', exact: true }).fill(wideKey);
    const board = page.getByRole('region', { name: '전체 프로젝트 보드', exact: true });
    await expect(board.locator('[data-issue-id]')).toHaveCount(3);
    for (const issue of [current, first.issue, second.issue]) await expect(board.locator(`[data-issue-id="${issue.id}"]`)).toBeVisible();
    await page.getByRole('button', { name: '현재 조건으로 간트 열기', exact: true }).click();
    await expect(ganttSearch).toHaveValue(wideKey);
    await expect(chartRows).toHaveCount(3);
    await expect(chartRow(current)).toContainText(current.title);
    for (const candidate of [first, second]) {
      await expect(chartRow(candidate.issue)).toContainText(candidate.issue.key);
      await expect(chartRow(candidate.issue)).toContainText(candidate.issue.title);
      await expect(chartRow(candidate.issue)).toContainText(jiraAliasLabel);
    }
    await chartRow(first.issue).locator('.gantt-issue-name').click();
    const chartDrawer = page.getByRole('dialog', { name: first.issue.title, exact: true });
    await expect(chartDrawer).toBeVisible();
    await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('issue')).toBe(first.issue.id);
    await chartDrawer.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await ganttSearch.fill(beforeMove.key.toLowerCase());
    await expect(chartRows).toHaveCount(1);
    const moveAliasLabel = `이동 전 키 ${beforeMove.key}`;
    await expect(chartRow(moved)).toContainText(moveAliasLabel);
    await expect(chartRow(moved)).toContainText(moved.key);

    await ganttSearch.fill(movedTarget.title);
    await chartRow(movedTarget).getByRole('button', { name: `${movedTarget.key} 일정과 연결 편집`, exact: true }).click();
    const rowEdit = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    const rowLink = rowEdit.getByRole('group', { name: '연결 변경 1', exact: true });
    await rowLink.getByLabel('선후행 연결 작업', { exact: true }).selectOption('add');
    await rowLink.getByRole('textbox', { name: '연결할 업무 검색', exact: true }).fill(beforeMove.key.toLowerCase());
    const movedChoice = rowLink.getByRole('list', { name: '연결할 업무 검색 결과', exact: true }).getByRole('button');
    await expect(movedChoice).toHaveCount(1);
    await expect(movedChoice).toContainText(moveAliasLabel);
    await expect(movedChoice).toContainText(`${moved.key} · ${moved.title}`);
    await movedChoice.click();
    const rowPreviewing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/row-edit/preview' && response.request().method() === 'POST');
    await rowEdit.getByRole('button', { name: '변경 미리보기', exact: true }).click();
    const rowPreview = await rowPreviewing;
    expect(rowPreview.status(), await rowPreview.text()).toBe(200);
    expect(rowPreview.request().postDataJSON()).toMatchObject({
      projectId: destination.id, issue: { id: movedTarget.id },
      dependency: { action: 'add', relatedIssue: { id: moved.id, expectedVersion: moved.version } },
    });
    page.once('dialog', confirmation => confirmation.accept());
    await rowEdit.getByRole('button', { name: '일정과 연결 편집 닫기', exact: true }).click();
    await expect(rowEdit).toHaveCount(0);

    await page.goto(`/#/${first.project.id}/gantt`);
    await ganttSearch.fill(wideKey);
    await expect(chartRows).toHaveCount(1);
    await expect(chartRow(first.issue)).toContainText(jiraAliasLabel);
    await ganttSearch.fill(ganttFixtureTitle);
    await chartSelect(anchor).check();
    await expect(chartRow(first.issue)).toHaveCount(0);
    await page.getByRole('button', { name: '선택 업무에서 연결', exact: true }).click();
    const link = page.getByRole('dialog', { name: '선행·후행 업무 연결', exact: true });
    await link.getByRole('searchbox', { name: '연결할 업무 검색', exact: true }).fill(wideKey);
    const candidate = link.getByRole('combobox', { name: '연결할 업무', exact: true });
    const options = candidate.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(1)).toHaveJSProperty('value', first.issue.id);
    await expect(options.nth(1)).toContainText(first.issue.key);
    await expect(options.nth(1)).toContainText(first.issue.title);
    await expect(options.nth(1)).toContainText(jiraAliasLabel);
    await expect(candidate).toHaveValue('');
    await candidate.selectOption(first.issue.id);
    const creating = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dependencies' && response.request().method() === 'POST');
    await link.getByRole('button', { name: '업무 연결', exact: true }).click();
    const created = await creating;
    expect(created.request().postDataJSON()).toMatchObject({ predecessorId: anchor.id, successorId: first.issue.id });
    expect(created.status(), await created.text()).toBe(201);
    expect(await created.json() as Dependency).toMatchObject({ predecessorId: anchor.id, successorId: first.issue.id });
    await expect(link).toHaveCount(0);

    await chartSelect(anchor).check();
    await chartSelect(bulkTarget).check();
    await page.getByRole('button', { name: '선후행 일괄 연결', exact: true }).click();
    const bulk = page.getByRole('dialog', { name: '선후행 연결 일괄 추가', exact: true });
    await bulk.getByLabel('기준 업무 검색', { exact: true }).fill(wideKey);
    const choices = bulk.getByRole('list', { name: '기준 업무 검색 결과', exact: true }).getByRole('listitem');
    await expect(choices).toHaveCount(1);
    await expect(choices.first()).toContainText(first.issue.key);
    await expect(choices.first()).toContainText(first.issue.title);
    await expect(choices.first()).toContainText(jiraAliasLabel);
    await choices.first().getByRole('button').click();
    await bulk.getByLabel('기준 업무 방향', { exact: true }).selectOption('successor');
    const previewing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/bulk-links/preview' && response.request().method() === 'POST');
    await bulk.getByRole('button', { name: '연결 미리보기', exact: true }).click();
    const bulkPreviewResponse = await previewing;
    expect(bulkPreviewResponse.request().postDataJSON()).toMatchObject({ anchor: { id: first.issue.id }, direction: 'successor' });
    expect(bulkPreviewResponse.status(), await bulkPreviewResponse.text()).toBe(200);
    expect(await bulkPreviewResponse.json() as SchedulePastePreview).toMatchObject({
      errors: [], retainedDependencies: [expect.objectContaining({ predecessorKey: anchor.key, successorKey: first.issue.key })],
      dependencyChanges: [expect.objectContaining({ predecessorKey: bulkTarget.key, successorKey: first.issue.key })],
    });
  } finally {
    await close();
  }
});

test('360px 간트 붙여넣기에서 Jira 이전 키로 날짜와 연결을 검토하고 같은 키의 대상이 바뀌면 적용을 막는다', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const { suffix, currentKey, snapshot, addIssue, migrate, close } = aliasFixture(request);
  let nativeTrashId: string | undefined;
  try {
    const project = await json<Project>(await request.post('/api/projects', { data: { key: currentKey, name: `간트 현행 키 ${suffix}` } }), 201);
    const current = await addIssue(project.id, `현재 키의 업무 ${suffix}`);
    const first = await migrate(current.key, 'A', `붙여넣기 Jira 이전 업무 A ${suffix}`);
    const second = await migrate(current.key, 'B', `붙여넣기 Jira 이전 업무 B ${suffix}`);
    const successor = await addIssue(first.project.id, `붙여넣기 연결 대상 ${suffix}`);
    const opener = page.getByRole('button', { name: '일정 붙여넣기', exact: true });
    const dialog = page.getByRole('dialog', { name: '일정 붙여넣기', exact: true });
    const input = dialog.getByRole('textbox', { name: '붙여넣을 일정표' });
    const apply = dialog.getByRole('button', { name: '검토한 일정 적용', exact: true });
    const mappings = dialog.getByRole('region', { name: '이전 업무 키 확인', exact: true });
    const nextPost = (path: string) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    async function review(projectId: string | null, text: string) {
      await input.fill(text);
      const pending = nextPost('/api/schedule/paste-preview');
      await dialog.getByRole('button', { name: '붙여넣기 미리보기', exact: true }).click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual({ projectId, text });
      return json<SchedulePastePreview>(response);
    }

    const header = '업무 키\t시작일\t종료일\t선행 업무';
    const start = '2031-11-03', end = '2031-11-04';
    const dateRow = `${current.key.toLowerCase()}\t${start}\t${end}\t`;
    const dateAndLink = `${header}\n${dateRow}\n${successor.key}\t\t\t${current.key}`;
    const dateOnly = `${header}\n${dateRow}`;
    await page.goto(`/#/${first.project.id}/gantt`);
    await opener.click();
    const scoped = await review(first.project.id, dateAndLink);
    expect(scoped).toMatchObject({ errors: [], previewId: expect.any(String),
      changes: [expect.objectContaining({ id: first.issue.id, key: first.issue.key, toStart: start, toEnd: end })],
      dependencyChanges: [expect.objectContaining({ predecessorKey: first.issue.key, successorKey: successor.key })],
      keyMappings: [{ inputKey: current.key, issueId: first.issue.id, key: first.issue.key, title: first.issue.title,
        projectId: first.project.id, source: 'jira' }],
    });
    await expect(mappings).toContainText(`Jira 원래 키 ${current.key}`);
    await expect(mappings).toContainText(first.issue.key);
    await expect(mappings).toContainText(first.issue.title);
    await expect(mappings).toContainText(`${first.project.key} · ${first.project.name}`);
    await expect(dialog.getByRole('table', { name: '붙여넣기 일정 변경 목록', exact: true })).toContainText(first.issue.key);
    const links = dialog.getByRole('table', { name: '붙여넣기 업무 연결 변경 목록', exact: true });
    await expect(links).toContainText(first.issue.key);
    await expect(links).toContainText(successor.key);

    const applying = nextPost('/api/schedule/paste-apply');
    await apply.click();
    const result = await json<SchedulePasteApplyResult>(await applying);
    expect(result).toMatchObject({ dependencyChanges: 1, updated: [expect.objectContaining({ id: first.issue.id, startDate: start, endDate: end })] });
    await expect(dialog).toHaveCount(0);
    const state = await snapshot();
    expect(state.issues.filter(issue => issue.id === current.id || issue.id === second.issue.id)).toEqual(expect.arrayContaining([current, second.issue]));
    expect(state.dependencies.filter(link => link.successorId === successor.id)).toEqual([
      expect.objectContaining({ predecessorId: first.issue.id, successorId: successor.id, type: 'FS', lagDays: 0 }),
    ]);
    const undoing = nextPost('/api/schedule/undo');
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    const undone = await undoing;
    expect(undone.request().postDataJSON()).toEqual({ undoId: result.undoId });
    expect(await json<SchedulePasteApplyResult>(undone)).toMatchObject({ dependencyChanges: 1,
      updated: [expect.objectContaining({ id: first.issue.id, startDate: first.issue.startDate, endDate: first.issue.endDate })],
    });
    expect((await snapshot()).dependencies.filter(link => link.successorId === successor.id)).toEqual([]);

    await page.goto(`/#/${project.id}/gantt?scope=team`);
    await opener.click();
    const exact = await review(null, dateOnly);
    expect(exact).toMatchObject({ errors: [], previewId: expect.any(String),
      changes: [expect.objectContaining({ id: current.id, key: current.key })],
      keyMappings: [{ inputKey: current.key, issueId: current.id, key: current.key, title: current.title,
        projectId: project.id, source: 'current', currentKeyConflict: true }],
    });
    await expect(mappings).toContainText(`입력한 키 ${current.key}`);
    await expect(mappings).toContainText('현재 키 우선');
    await expect(mappings).toContainText(current.title);
    await expect(mappings).toContainText('입력한 키와 같은 이전 업무 키가 있습니다.');
    await expect(apply).toBeEnabled();

    ({ trashEntryId: nativeTrashId } = await json<{ trashEntryId: string }>(await request.delete(`/api/issues/${current.id}`)));
    const staleApply = nextPost('/api/schedule/paste-apply');
    await apply.click();
    const rejected = await staleApply;
    expect(rejected.request().postDataJSON()).toEqual({ previewId: exact.previewId });
    expect(rejected.status()).toBe(409);
    await expect(apply).toBeDisabled();
    await expect(input).toHaveValue(dateOnly);
    const ambiguous = await review(null, dateOnly);
    expect(ambiguous).toMatchObject({ previewId: null, changes: [],
      errors: [expect.objectContaining({ key: current.key, line: 2, message: expect.stringMatching(/중복|두 개|여러/) })],
    });
    await expect(dialog.getByRole('region', { name: '일정 붙여넣기 오류', exact: true })).toContainText(current.key);
    await expect(apply).toBeDisabled();
    const afterwards = await snapshot();
    expect(afterwards.issues.find(issue => issue.id === first.issue.id)).toMatchObject({ startDate: first.issue.startDate, endDate: first.issue.endDate });
    expect(afterwards.issues.find(issue => issue.id === second.issue.id)).toEqual(second.issue);
    expect(afterwards.dependencies.filter(link => link.successorId === successor.id)).toEqual([]);
    const restored = await request.post(`/api/trash/${nativeTrashId}/restore`);
    expect(restored.status(), await restored.text()).toBe(200);
    nativeTrashId = undefined;
  } finally {
    if (nativeTrashId) {
      const restored = await request.post(`/api/trash/${nativeTrashId}/restore`);
      if (!restored.ok()) await request.delete(`/api/trash/${nativeTrashId}`);
    }
    await close();
  }
});
