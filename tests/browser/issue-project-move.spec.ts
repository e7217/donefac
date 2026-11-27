import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move';
import type { Comment, Dependency, DocPage, GitlabSettings, Issue, IssueWorklogPage, LegacyPackageSummary, MigrationApplyResult,
  MigrationOptions, MigrationPreview, ResourceLink, WorklogEntry, WorkspaceSnapshot } from '../../shared/types';

const gitlabPath = '/api/integrations/gitlab';
const button = (within: Locator | Page, name: string) => within.getByRole('button', { name, exact: true });

async function json<T>(response: APIResponse | Response, status?: number): Promise<T> {
  if (status === undefined) expect(response.ok(), await response.text()).toBeTruthy();
  else expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

test('360px에서 연결된 업무를 검토해 프로젝트를 옮기고 기존 주소와 연결을 유지한다', async ({ page, request }) => {
  test.setTimeout(100_000);
  const readWorkspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'), 200);
  const { projects: [source, target], users: [actor, peer] } = await readWorkspace();
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `업무 프로젝트 이동 ${randomUUID().slice(0, 8)}`;
  const start = '2031-11-05', end = '2031-11-06';
  const created: Issue[] = [];
  let document: DocPage | undefined;
  const initialSettings = await json<GitlabSettings>(await request.get(gitlabPath), 200);
  expect(initialSettings.baseUrl).toBe('');
  const gitlab = 'https://gitlab.example.test';
  const secret = `synthetic-project-move-${randomUUID()}`;
  const create = async (title: string, from: string, through: string, parentId: string | null = null) => {
    const issue = await json<Issue>(await request.post('/api/issues', {
      headers, data: { projectId: source.id, title: `${prefix} ${title}`, startDate: from, endDate: through, parentId },
    }), 201);
    created.push(issue);
    return issue;
  };
  const purge = async (path: string) => {
    const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(path, { headers }), 200);
    expect((await request.delete(`/api/trash/${trashEntryId}`, { headers })).ok()).toBeTruthy();
  };
  try {
    const predecessor = await create('선행 업무', '2031-11-03', '2031-11-04');
    const root = await create('기준 업무', start, end);
    const child = await create('하위 업무', '2031-11-07', '2031-11-07', root.id);
    const dependency = await json<Dependency>(await request.post('/api/dependencies', { headers, data: {
      predecessorId: predecessor.id, successorId: root.id, type: 'FS', lagDays: 0,
    } }), 201);
    document = await json<DocPage>(await request.post('/api/documents', { headers, data: {
      projectId: source.id, title: `${prefix} 연결 문서`, content: { type: 'doc', content: [
        { type: 'issueReference', attrs: { issueId: root.id, label: `${root.key} ${root.title}` } },
      ] },
    } }), 201);
    const resourceLink = await json<ResourceLink>(await request.post('/api/resource-links', { headers, data: {
      issueId: root.id, documentId: document.id,
    } }), 201);
    const commentPath = `/api/comments?resourceType=issue&resourceId=${root.id}`;
    const comment = await json<Comment>(await request.post('/api/comments', { headers, data: {
      resourceType: 'issue', resourceId: root.id, body: `${prefix} 보존할 댓글`,
    } }), 201);
    await json<GitlabSettings>(await request.patch(gitlabPath, { headers, data: {
      expectedVersion: initialSettings.version, baseUrl: gitlab, projectIds: [42], webhookSecret: secret,
    } }), 200);
    const webhook = await request.post(`${gitlabPath}/webhook`, { headers: { 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() }, data: {
      object_kind: 'merge_request', project: { id: 42 }, object_attributes: {
        id: 50320, iid: 50320, action: 'open', state: 'opened', title: `${root.key} 프로젝트 이동 전 MR`,
        source_branch: `feature/${root.key}`, url: `${gitlab}/team/project/-/merge_requests/50320`, updated_at: new Date().toISOString(),
      },
    } });
    expect(await json<{ linked: number }>(webhook, 200)).toMatchObject({ linked: 1 });
    const mr = (await readWorkspace()).gitlabLinks.find(link => link.issueId === root.id)!;
    expect(mr).toMatchObject({ iid: 50320, state: 'opened' });

    const oldHash = `#/${source.id}/issues?issue=${root.id}`;
    const newHash = `#/${target.id}/issues?issue=${root.id}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/${oldHash}`);
    const panel = page.getByRole('dialog', { name: root.title, exact: true });
    await button(panel, '프로젝트 이동').click();
    const move = page.getByRole('dialog', { name: '프로젝트 이동', exact: true });
    await expect(move).toBeVisible();
    const bounds = await move.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const project = move.getByRole('combobox', { name: '대상 프로젝트', exact: true });
    const connected = move.getByRole('checkbox', { name: '연결된 업무 함께 이동', exact: true });
    const previewPath = `/api/issues/${root.id}/project-move/preview`;
    const applyPath = `/api/issues/${root.id}/project-move/apply`;
    const posted = (path: string) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    async function preview() {
      const response = posted(previewPath);
      await button(move, '이동 미리보기').click();
      return json<IssueProjectMovePreview>(await response, 200);
    }
    async function confirmMove() {
      await button(move, '이동 적용').click();
      await button(move, '이동 확정').click();
    }

    await project.selectOption(target.id);
    const blocked = await preview();
    expect(blocked.token).toBeNull();
    expect(blocked.blockers.length).toBeGreaterThan(0);
    await expect(button(move, '이동 적용')).toBeDisabled();
    await connected.check();
    const grouped = await preview();
    expect(grouped.blockers).toEqual([]);
    expect(grouped.issues.map(issue => issue.id).sort()).toEqual([predecessor.id, root.id, child.id].sort());
    const list = move.getByRole('region', { name: '이동 대상 업무', exact: true });
    const rootRow = list.locator(`[data-move-issue-id="${root.id}"]`);
    const mappedStatus = rootRow.getByRole('combobox', { name: `${root.key} 대상 상태`, exact: true });
    await mappedStatus.selectOption('review');
    const first = await preview();
    expect(first.issues.find(issue => issue.id === root.id)?.mapping.status).toBe('review');
    expect(first.token).toBeTruthy();

    const changed = await json<Issue>(await request.patch(`/api/issues/${child.id}`, {
      headers: { 'X-Actor-Id': peer.id }, data: { expectedVersion: child.version, title: `${child.title} 갱신됨` },
    }), 200);
    const rejection = posted(applyPath);
    await confirmMove();
    expect((await rejection).status()).toBe(409);
    await expect(move.getByRole('alert')).toBeVisible();
    await expect(project).toHaveValue(target.id);
    await expect(connected).toBeChecked();
    expect((await readWorkspace()).issues.find(issue => issue.id === root.id)).toEqual(root);
    const fresh = await preview();
    expect(fresh.token).toBeTruthy();
    expect(fresh.token).not.toBe(first.token);
    expect(fresh.issues.find(issue => issue.id === child.id)).toMatchObject({ title: changed.title, version: changed.version });
    expect(fresh.issues.find(issue => issue.id === root.id)?.mapping.status).toBe('review');

    let applied: IssueProjectMoveResult | undefined;
    const attempts: unknown[] = [];
    page.on('request', sent => { if (new URL(sent.url()).pathname === applyPath && sent.method() === 'POST') attempts.push(sent.postDataJSON()); });
    await page.route(url => url.pathname === applyPath, async intercepted => {
      applied = await json<IssueProjectMoveResult>(await intercepted.fetch());
      await intercepted.abort('failed');
    }, { times: 1 });
    await confirmMove();
    const retry = button(move, '같은 요청 다시 확인');
    await expect(retry).toBeVisible();
    expect(applied?.duplicate).toBe(false);
    const resumed = posted(applyPath);
    await retry.click();
    const replayed = await json<IssueProjectMoveResult>(await resumed);
    expect(replayed).toEqual({ ...applied, duplicate: true });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(move.getByRole('heading', { name: '프로젝트 이동 완료', exact: true })).toBeVisible();

    const moved = replayed.issues.find(issue => issue.id === root.id)!;
    const movedChild = replayed.issues.find(issue => issue.id === child.id)!;
    expect(moved).toMatchObject({ id: root.id, projectId: target.id, key: fresh.issues.find(issue => issue.id === root.id)?.targetKey,
      version: root.version + 1, status: 'review', startDate: start, endDate: end });
    expect(movedChild).toMatchObject({ parentId: root.id, projectId: target.id, title: changed.title, version: changed.version + 1 });
    expect(replayed.issues.map(issue => issue.id).sort()).toEqual([predecessor.id, root.id, child.id].sort());
    const persisted = await readWorkspace();
    for (const issue of replayed.issues) expect(persisted.issues.find(value => value.id === issue.id)).toEqual(issue);
    expect(persisted.dependencies.find(link => link.id === dependency.id)).toEqual(dependency);
    expect(persisted.resourceLinks.find(link => link.id === resourceLink.id)).toEqual(resourceLink);
    expect(persisted.gitlabLinks.find(link => link.id === mr.id)).toEqual(mr);
    expect(persisted.documents.find(value => value.id === document!.id)).toEqual(document);
    expect(await json<Comment[]>(await request.get(commentPath), 200)).toEqual([comment]);

    await button(move, '프로젝트 이동 닫기').click();
    await expect(move).toHaveCount(0);
    await expect(panel.locator('.issue-panel-breadcrumb')).toContainText(moved.key);
    await expect(button(panel, '프로젝트 이동')).toBeFocused();
    await page.goto(`/${oldHash}`);
    await expect(page).toHaveURL(url => url.hash === newHash);
    await expect(panel.locator('.issue-panel-breadcrumb')).toContainText(target.name);
    await expect(panel.locator('.gitlab-activity-row[data-gitlab-kind="merge_request"]')).toContainText(`${root.key} 프로젝트 이동 전 MR`);

    await page.goto(`/#/${source.id}/gantt?focusIssue=${root.id}`);
    await expect(page).toHaveURL(url => url.hash === `#/${target.id}/gantt?focusIssue=${root.id}`);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    await expect(chart.locator(`[data-issue-id="${root.id}"]`)).toHaveAttribute('data-focused-issue', 'true');
    await expect(chart.getByLabel(`${moved.key} 시작일`, { exact: true })).toHaveValue(start);
    await expect(chart.locator(`[data-dependency-id="${dependency.id}"]`)).toHaveCount(1);

    const documentHash = `#/${source.id}/documents/${document.id}`;
    await page.goto(`/${documentHash}`);
    await button(page, `참조 업무 열기 ${moved.key} ${moved.title}`).click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.issue-panel-breadcrumb')).toContainText(moved.key);
    await expect(panel.getByText(comment.body, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(url => url.hash === `${documentHash}?issue=${root.id}`);
  } finally {
    if (document) await purge(`/api/documents/${document.id}`);
    for (const issue of created.reverse()) await purge(`/api/issues/${issue.id}`);
    const active = await json<GitlabSettings>(await request.get(gitlabPath), 200);
    if (active.baseUrl === gitlab) await json<GitlabSettings>(await request.patch(gitlabPath, { headers, data: {
      expectedVersion: active.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
    } }), 200);
  }
});

test('360px에서 작업 기록이 있는 업무를 옮기고 대상 프로젝트 보고서에서 다시 연다', async ({ page, request }) => {
  const { projects: [source, target], users: [actor] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'), 200);
  const headers = { 'X-Actor-Id': actor.id };
  const issue = await json<Issue>(await request.post('/api/issues', {
    headers, data: { projectId: source.id, title: `작업 기록이 있는 이동 업무 ${randomUUID().slice(0, 8)}` },
  }), 201);
  const worklogsPath = `/api/issues/${issue.id}/worklogs`;
  const workDate = '2031-11-10';
  const note = '이동 뒤에도 보존할 작업 기록';
  let log: WorklogEntry | undefined;
  try {
    log = await json<WorklogEntry>(await request.post(worklogsPath, {
      headers, data: { requestId: randomUUID(), workDate, minutes: 75, note },
    }), 201);
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${source.id}/issues?issue=${issue.id}`);
    const issuePanel = page.getByRole('dialog', { name: issue.title, exact: true });
    await button(issuePanel, '작업 시간').click();
    const worklogs = issuePanel.getByRole('region', { name: '업무 작업 기록', exact: true });
    const draft = worklogs.getByLabel('작업 기록 내용', { exact: true });
    await expect(worklogs.getByLabel('업무 총 작업 시간')).toHaveText('1시간 15분');
    await draft.fill('저장하지 않은 작업 기록');

    const move = page.getByRole('dialog', { name: '프로젝트 이동', exact: true });
    async function openPreview() {
      await button(issuePanel, '프로젝트 이동').click();
      await move.getByRole('combobox', { name: '대상 프로젝트', exact: true }).selectOption(target.id);
      const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/issues/${issue.id}/project-move/preview`);
      await button(move, '이동 미리보기').click();
      return json<IssueProjectMovePreview>(await response, 200);
    }

    await openPreview();
    await expect(button(move, '이동 적용')).toBeDisabled();
    await expect(move.getByText(/저장하지 않은 업무 변경사항/u)).toBeVisible();
    page.once('dialog', dialog => void dialog.accept());
    await button(move, '프로젝트 이동 닫기').click();
    await expect(draft).toHaveValue('저장하지 않은 작업 기록');
    page.once('dialog', dialog => void dialog.accept());
    await button(worklogs, '입력 초기화').click();
    await expect(draft).toHaveValue('');

    const preview = await openPreview();
    expect(preview.token).toBeTruthy();
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: 'worklogs_transferred', issueId: issue.id }));
    const notice = move.getByRole('region', { name: '이동 시 바뀌는 항목', exact: true });
    await expect(notice).toContainText('작업 시간');
    await expect(notice).toContainText('대상 프로젝트');
    await button(move, '이동 적용').click();
    await button(move, '이동 확정').click();
    await expect(move.getByRole('heading', { name: '프로젝트 이동 완료', exact: true })).toBeVisible();
    const movedKey = preview.issues[0].targetKey;
    await button(move, '이동한 업무 보기').click();
    await expect(issuePanel.locator('.issue-panel-breadcrumb')).toContainText(movedKey);
    await expect(worklogs.getByText(note, { exact: true })).toBeVisible();
    await expect(worklogs.getByLabel('업무 총 작업 시간')).toHaveText('1시간 15분');
    const movedLogs = await json<IssueWorklogPage>(await request.get(worklogsPath, { headers }), 200);
    expect(movedLogs.entries).toEqual([{ ...log, projectId: target.id, issueKey: movedKey }]);

    await page.setViewportSize({ width: 1440, height: 1000 });
    async function report(projectId: string) {
      await page.goto(`/#/${projectId}/reports`);
      await page.getByRole('tab', { name: '작업 시간', exact: true }).click();
      await page.getByLabel('작업 시간 시작일', { exact: true }).fill(workDate);
      await page.getByLabel('작업 시간 종료일', { exact: true }).fill(workDate);
      const response = page.waitForResponse(result => {
        const url = new URL(result.url());
        return url.pathname === `/api/projects/${projectId}/worklog-report` && url.searchParams.get('startDate') === workDate;
      });
      await button(page, '작업 시간 조회').click();
      expect((await response).status()).toBe(200);
      await expect(page.locator('.worklog-report-result-heading')).toContainText(workDate);
      return page.getByRole('region', { name: '업무별 작업 시간', exact: true });
    }
    const sourceReport = await report(source.id);
    await expect(sourceReport.getByText(issue.title, { exact: true })).toHaveCount(0);
    const targetReport = await report(target.id);
    const movedLink = button(targetReport, `${movedKey} ${issue.title} 업무 열기`);
    await expect(targetReport.getByRole('row').filter({ hasText: issue.title })).toContainText('1시간 15분');
    await movedLink.click();
    await expect(issuePanel.locator('.issue-panel-breadcrumb')).toContainText(movedKey);
    await button(issuePanel, '작업 시간').click();
    await expect(worklogs.getByText(note, { exact: true })).toBeVisible();
  } finally {
    const response = await request.get(worklogsPath, { headers });
    if (response.ok()) {
      const { entries } = await response.json() as IssueWorklogPage;
      const current = entries.find(entry => entry.id === log?.id);
      if (current) expect((await request.delete(`${worklogsPath}/${current.id}`, {
        headers, data: { expectedVersion: current.version },
      })).ok()).toBeTruthy();
    }
    const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(`/api/issues/${issue.id}`, { headers }), 200);
    expect((await request.delete(`/api/trash/${trashEntryId}`, { headers })).ok()).toBeTruthy();
  }
});

test('360px에서 Jira 이관 업무를 다른 프로젝트로 이동하고 원본 링크를 다시 확인한다', async ({ page, request }) => {
  const readWorkspace = async () => json<WorkspaceSnapshot>(await request.get('/api/workspace'), 200);
  const { projects: [target], users: [actor] } = await readWorkspace();
  const headers = { 'X-Actor-Id': actor.id };
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const originalProjectKey = `J${suffix}`, originalKey = `${originalProjectKey}-1`;
  const title = `프로젝트를 옮길 Jira 이관 업무 ${suffix}`;
  const sourceBase = 'https://jira-move.example.invalid/jira';
  const sourceUrl = `${sourceBase}/browse/${originalKey}`;
  const csv = [
    'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type',
    `100,${originalKey},${originalProjectKey},${title},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task`,
  ].join('\r\n');
  const params = new URLSearchParams({ filename: `jira-move-${suffix}.csv`, product: 'jira', instanceKey: `jira-move-${suffix}` });
  const staged = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${params}`, {
    headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: csv,
  }), 201);
  let issue: Issue | undefined;
  try {
    const { defaultConfiguration } = await json<MigrationOptions>(await request.get('/api/migrations/options', {
      headers, params: { packageId: staged.id },
    }), 200);
    const migration = await json<MigrationPreview>(await request.post('/api/migrations/preview', { headers, data: { configuration: {
      ...defaultConfiguration, sourceBaseUrls: { ...defaultConfiguration.sourceBaseUrls, [staged.id]: sourceBase },
    } } }), 201);
    expect(migration.canApply, JSON.stringify(migration.notices)).toBe(true);
    const { import: receipt } = await json<MigrationApplyResult>(
      await request.post(`/api/migrations/previews/${migration.id}/apply`, {
        headers, data: { expectedVersion: migration.version, acknowledgements: migration.requiredAcknowledgements },
      }), 201);
    issue = (await readWorkspace()).issues.find(value => value.projectId === receipt.projectIds[0] && value.title === title);
    if (!issue) throw new Error('The Jira migration test issue was not imported.');

    const id = issue.id;
    const originalHash = `#/${issue.projectId}/issues?issue=${id}`;
    const targetHash = `#/${target.id}/issues?issue=${id}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await page.addInitScript(actorId => localStorage.setItem('donefac.actor', actorId), actor.id);
    await page.goto(`/${originalHash}`);
    const panel = page.getByRole('dialog', { name: title, exact: true });
    const originalLink = panel.getByRole('region', { name: '기존 도구 연결', exact: true })
      .getByRole('link', { name: '원본 열기', exact: true });
    await expect(originalLink).toHaveAttribute('href', sourceUrl);

    await button(panel, '프로젝트 이동').click();
    const move = page.getByRole('dialog', { name: '프로젝트 이동', exact: true });
    await move.getByRole('combobox', { name: '대상 프로젝트', exact: true }).selectOption(target.id);
    const posted = (operation: 'preview' | 'apply') => page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/issues/${id}/project-move/${operation}` && response.request().method() === 'POST');
    async function preview() {
      const response = posted('preview');
      await button(move, '이동 미리보기').click();
      return json<IssueProjectMovePreview>(await response, 200);
    }
    await preview();
    const row = move.locator(`[data-move-issue-id="${id}"]`);
    await row.getByRole('combobox', { name: `${issue.key} 대상 유형`, exact: true }).selectOption('작업');
    await row.getByRole('combobox', { name: `${issue.key} 대상 상태`, exact: true }).selectOption('todo');
    const ready = await preview();
    expect(ready.token).toBeTruthy();
    expect(ready.blockers).toEqual([]);
    expect(ready.warnings).toContainEqual(expect.objectContaining({ code: 'jira_origin_preserved', issueId: id }));
    await expect(move.getByRole('region', { name: '이동 시 바뀌는 항목', exact: true })).toContainText('Jira 원본 링크와 이관 기록을 유지합니다.');
    await button(move, '이동 적용').click();
    const applied = posted('apply');
    await button(move, '이동 확정').click();
    const { issues: [moved] } = await json<IssueProjectMoveResult>(await applied, 200);
    expect(moved).toMatchObject({ id, projectId: target.id, key: ready.issues[0].targetKey, type: '작업', status: 'todo' });
    await expect(move.getByRole('heading', { name: '프로젝트 이동 완료', exact: true })).toBeVisible();
    await button(move, '이동한 업무 보기').click();
    await expect(panel.locator('.issue-panel-breadcrumb')).toContainText(moved.key);
    await page.goto(`/${originalHash}`);
    await expect(page).toHaveURL(url => url.hash === targetHash);
    await expect(panel.locator('.issue-panel-breadcrumb')).toContainText(target.name);
    await expect(originalLink).toHaveAttribute('href', sourceUrl);
  } finally {
    if (issue) {
      const { trashEntryId } = await json<{ trashEntryId: string }>(await request.delete(`/api/issues/${issue.id}`, { headers }), 200);
      expect((await request.delete(`/api/trash/${trashEntryId}`, { headers })).ok()).toBeTruthy();
    }
    await request.delete(`/api/legacy-import/packages/${staged.id}?expectedVersion=${staged.version}`, { headers });
  }
});
