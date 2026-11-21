import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move';
import type { Comment, Dependency, DocPage, GitlabSettings, Issue, ResourceLink, WorkspaceSnapshot } from '../../shared/types';

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
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
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
