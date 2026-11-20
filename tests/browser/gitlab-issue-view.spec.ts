import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type { DocPage, GitlabSettings, Issue, Project, SavedView, WorkspaceSnapshot } from '../../shared/types';

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

test('360px 업무 목록과 보드의 GitLab 조건을 저장하고 간트에서 같은 업무를 확인한다', async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const name = `GitLab 상태 ${suffix}`;
  const baseUrl = 'https://gitlab.example.test';
  const projectUrl = `${baseUrl}/team/status-triage`;
  const secret = `synthetic-triage-${randomUUID()}`;
  const repositoryId = 42;
  const settingsPath = '/api/integrations/gitlab';
  const settings = async () => readJson<GitlabSettings>(await request.get(settingsPath));
  const snapshot = async () => readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const project = await readJson<Project>(await request.post('/api/projects', { data: {
    key: `GL${suffix}`, name,
  } }), 201);
  const issues: Issue[] = [];
  let savedView: SavedView | undefined;
  let document: DocPage | undefined;
  const workspaceStart = Date.now() - 60_000;
  const timestamp = (seconds: number) => new Date(workspaceStart + seconds * 1000).toISOString();
  const branch = (issue: Issue) => `feature/${issue.key}`;
  const send = async (objectKind: 'merge_request' | 'pipeline', attributes: object) =>
    readJson<{ duplicate: boolean; linked: number }>(await request.post(`${settingsPath}/webhook`, {
      data: {
        object_kind: objectKind,
        project: { id: repositoryId, web_url: projectUrl },
        object_attributes: attributes,
      },
      headers: { 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() },
    }));
  const pipeline = (issue: Issue, id: number, status: 'success' | 'failed' | 'running', at: number) =>
    send('pipeline', { id, status, ref: branch(issue), updated_at: timestamp(at) });

  try {
    const original = await settings();
    expect(original.baseUrl).toBe('');
    await readJson(await request.patch(settingsPath, { data: {
      expectedVersion: original.version, baseUrl, projectIds: [repositoryId], webhookSecret: secret,
    } }));
    for (const label of ['복구된 실행', '실패한 실행', '진행 중 실행', '연결 미정']) {
      issues.push(await readJson<Issue>(await request.post('/api/issues', { data: {
        projectId: project.id, title: `${name} ${label}`,
      } }), 201));
    }
    const [recovered, failed, running, unlinked] = issues;
    await expect(send('merge_request', {
      id: 701, iid: 7, action: 'open', state: 'opened', title: `${recovered.key} 검토`,
      source_branch: branch(recovered), url: `${projectUrl}/-/merge_requests/7`, updated_at: timestamp(1),
    })).resolves.toMatchObject({ duplicate: false, linked: 1 });
    await expect(pipeline(recovered, 802, 'success', 5)).resolves.toMatchObject({ duplicate: false, linked: 1 });
    // An older pipeline arrives late and finishes later than its replacement.
    await expect(pipeline(recovered, 801, 'failed', 6)).resolves.toMatchObject({ duplicate: false, linked: 1 });
    await expect(pipeline(failed, 803, 'failed', 7)).resolves.toMatchObject({ duplicate: false, linked: 1 });
    await expect(pipeline(running, 804, 'running', 8)).resolves.toMatchObject({ duplicate: false, linked: 1 });
    expect((await snapshot()).gitlabLinks.filter(link => link.issueId === recovered.id && link.kind === 'pipeline')
      .map(link => [link.iid, link.state]).sort()).toEqual([[801, 'failed'], [802, 'success']]);

    await page.setViewportSize({ width: 360, height: 820 });
    const issuesPath = `#/${project.id}/issues`;
    await page.goto(`/${issuesPath}`);
    const filter = page.getByRole('combobox', { name: 'GitLab 조건', exact: true });
    const list = (issue: Issue) => page.locator(`.issue-table tr[data-issue-id="${issue.id}"]`);
    const card = (issue: Issue) => page.locator(`.issue-board-card[data-issue-id="${issue.id}"]`);
    await expect(list(recovered)).toContainText('열린 MR 1개');
    await expect(list(recovered)).not.toContainText('실패한 파이프라인');
    await expect(list(failed)).toContainText('실패한 파이프라인 1개');
    await expect(list(running)).toContainText('진행 중인 파이프라인 1개');
    await expect(list(unlinked)).toBeVisible();

    for (const [condition, match] of [
      ['open_merge_request', recovered],
      ['running_pipeline', running],
      ['no_activity', unlinked],
    ] as const) {
      await filter.selectOption(condition);
      await expect(page.locator('.issue-table tr[data-issue-id]')).toHaveCount(1);
      await expect(list(match)).toBeVisible();
    }
    await filter.selectOption({ label: '실패한 파이프라인' });
    await expect(list(failed)).toBeVisible();
    await expect(list(recovered)).toHaveCount(0);
    await expect(list(running)).toHaveCount(0);
    await expect(list(unlinked)).toHaveCount(0);
    await page.getByRole('button', { name: '보드', exact: true }).click();
    await expect(card(failed)).toContainText('실패한 파이프라인 1개');
    await expect(card(recovered)).toHaveCount(0);
    await expect(card(running)).toHaveCount(0);
    await expect(card(unlinked)).toHaveCount(0);

    await page.getByRole('button', { name: '현재 보기 저장', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '업무 보기 저장', exact: true });
    await dialog.getByLabel('보기 이름', { exact: true }).fill(`${name} 공유 보기`);
    const saving = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/views' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    savedView = await readJson<SavedView>(await saving, 201);
    expect(savedView).toMatchObject({ layout: 'board', filters: { gitlab: 'failed_pipeline' } });
    const sharedIssuesPath = `${issuesPath}?savedView=${savedView.id}`;
    const sharedGanttPath = `#/${project.id}/gantt?savedView=${savedView.id}`;
    await expect(page).toHaveURL(url => url.hash === sharedIssuesPath);
    await page.reload();
    await expect(filter).toHaveValue('failed_pipeline');
    await expect(card(failed)).toBeVisible();
    await expect(card(recovered)).toHaveCount(0);

    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === sharedGanttPath);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const rows = chart.locator('.gantt-row[data-issue-id]');
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute('data-issue-id', failed.id);

    document = await readJson<DocPage>(await request.post('/api/documents', { data: {
      projectId: project.id, title: `${name} 검토 문서`, content: {
        type: 'doc', content: [{
          type: 'issueList', attrs: { projectId: project.id, savedViewId: savedView.id, label: savedView.name },
        }],
      },
    } }), 201);
    const reader = await page.context().newPage();
    await reader.setViewportSize({ width: 360, height: 820 });
    await reader.goto(`/#/${project.id}/documents/${document.id}`);
    const documentIssues = reader.getByRole('region', { name: '업무 목록', exact: true });
    await expect(documentIssues.locator('.doc-issue-list-row')).toHaveCount(1);
    await expect(documentIssues.getByRole('button', { name: `목록 업무 열기 ${failed.key} ${failed.title}`, exact: true })).toBeVisible();

    await expect(pipeline(failed, 805, 'success', 9)).resolves.toMatchObject({ duplicate: false, linked: 1 });
    await page.getByRole('button', { name: '업무 보기에서 열기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === sharedIssuesPath);
    await page.getByRole('button', { name: 'GitLab 활동 새로고침', exact: true }).click();
    await expect(page.locator('.issue-board-card')).toHaveCount(0);
    await expect(filter).toHaveValue('failed_pipeline');

    await page.getByRole('button', { name: '간트에서 열기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === sharedGanttPath);
    await page.reload();
    await expect(page.getByRole('combobox', { name: '간트 공유 보기', exact: true })).toHaveValue(savedView.id);
    await expect(rows).toHaveCount(0);
    await page.goto(`/${sharedIssuesPath}`);
    await expect(filter).toHaveValue('failed_pipeline');
    await expect(page.locator('.issue-board-card')).toHaveCount(0);
    await reader.reload();
    await expect(documentIssues).toContainText('조건에 맞는 업무가 없습니다.');
    await reader.close();
    expect((await snapshot()).issues.find(issue => issue.id === failed.id)).toMatchObject({ status: failed.status, version: failed.version });
  } finally {
    if (document) {
      const deleted = await request.delete(`/api/documents/${document.id}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    if (savedView) await request.delete(`/api/views/${savedView.id}?expectedVersion=${savedView.version}`);
    for (const issue of issues) {
      const deleted = await request.delete(`/api/issues/${issue.id}`);
      if (deleted.ok()) {
        const { trashEntryId } = await deleted.json() as { trashEntryId: string };
        await request.delete(`/api/trash/${trashEntryId}`);
      }
    }
    const current = await settings();
    if (current.baseUrl === baseUrl) {
      await readJson(await request.patch(settingsPath, { data: {
        expectedVersion: current.version, baseUrl: '', projectIds: [], token: '', webhookSecret: '', signingToken: '',
      } }));
    }
  }
});
