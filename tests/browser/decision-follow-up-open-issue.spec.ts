import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import type { DecisionFollowUpPage, DocPage, Issue, WorkspaceSnapshot } from '../../shared/types';

const reportPath = '/api/decision-follow-ups';
const workspacePath = '/api/workspace';

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function fixture(request: APIRequestContext) {
  const { projects: [home, project], users: [actor, peer] } = await json<WorkspaceSnapshot>(await request.get(workspacePath));
  const headers = { 'X-Actor-Id': actor.id };
  const prefix = `결정 업무 열기 ${randomUUID().slice(0, 8)}`;
  const excerpt = `${prefix} 리뷰에서 확정한 사내 검증 방식`;
  const created: { path: string; id: string }[] = [];
  async function create<T extends { id: string }>(path: string, data: object) {
    const value = await json<T>(await request.post(path, { headers, data }), 201);
    created.push({ path, id: value.id });
    return value;
  }
  async function close() {
    for (const { path, id } of created.reverse()) {
      const deleted = await request.delete(`${path}/${id}`, { headers });
      if (!deleted.ok()) continue;
      const { trashEntryId } = await deleted.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
  }
  try {
    const issue = await create<Issue>('/api/issues', {
      projectId: project.id, title: `${prefix} 검토할 업무`, description: '기존 설명', status: 'in_progress',
    });
    const document = await create<DocPage>('/api/documents', {
      projectId: home.id, title: `${prefix} 원문`,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: excerpt }] }] },
    });
    await json(await request.post(`/api/documents/${document.id}/decision-links`, { headers, data: {
      requestId: randomUUID(), expectedDocumentVersion: document.version, issueId: issue.id,
      sourceSelection: { from: 1, to: excerpt.length + 1, text: excerpt },
    } }), 201);
    return { actor, peer, issue, project, prefix, close,
      route: (q = prefix) => `#/${home.id}/reports/decision-follow-ups?${new URLSearchParams({ q, scope: 'team', decisionProject: project.id })}`,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function nextReport(page: Page, projectId: string, query: string) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === reportPath && url.searchParams.get('projectId') === projectId && url.searchParams.get('q') === query;
  }, { timeout: 25_000 });
}

async function openReport(page: Page, setup: Awaited<ReturnType<typeof fixture>>) {
  await page.setViewportSize({ width: 360, height: 820 });
  await page.addInitScript(actorId => localStorage.setItem('teamspace.actor', actorId), setup.actor.id);
  const initial = nextReport(page, setup.project.id, setup.prefix);
  await page.goto(`/${setup.route()}`);
  expect((await json<DecisionFollowUpPage>(await initial)).total).toBe(1);
  const report = page.getByRole('tabpanel', { name: '결정 후속 업무', exact: true });
  const opener = report.getByRole('button', { name: `${setup.issue.key} 업무 열기`, exact: true });
  await expect(opener).toBeVisible();
  return { report, opener };
}

test('360px 결정 후속 업무에서 보고서에 없는 최신 설명을 읽고 같은 조건에서 변경을 저장한다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const setup = await fixture(request);
  try {
    const { report, opener } = await openReport(page, setup);
    const description = '동료가 먼저 저장한 설명';
    const remote = await json<Issue>(await request.patch(`/api/issues/${setup.issue.id}`, {
      headers: { 'X-Actor-Id': setup.peer.id }, data: { expectedVersion: setup.issue.version, description },
    }));
    const refreshed = nextReport(page, setup.project.id, setup.prefix);
    await report.getByRole('button', { name: '결정 후속 업무 새로고침', exact: true }).click();
    expect((await json<DecisionFollowUpPage>(await refreshed)).items[0]?.issue).toMatchObject({
      id: remote.id, title: setup.issue.title, status: setup.issue.status,
    });
    await opener.click();
    const details = page.getByRole('dialog', { name: setup.issue.title, exact: true });
    const field = details.getByLabel('설명', { exact: true });
    await expect(field).toHaveValue(description);
    const edited = `${description}\n검토에서 확인한 후속 조치`;
    await field.fill(edited);
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${setup.issue.id}` && response.request().method() === 'PATCH');
    await details.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    const response = await saved;
    expect(response.request().postDataJSON().expectedVersion).toBe(remote.version);
    expect(await json<Issue>(response)).toMatchObject({ description: edited, version: remote.version + 1 });
    await details.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(details).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page).toHaveURL(url => url.hash === setup.route());
  } finally {
    await setup.close();
  }
});

test('결정 보고서 조건을 바꾸는 동안 늦게 도착한 업무 조회는 상세를 열지 않는다', async ({ page, request }) => {
  test.setTimeout(65_000);
  const setup = await fixture(request);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const { report, opener } = await openReport(page, setup);
    await page.route(url => url.pathname === workspacePath, async route => {
      try {
        const response = await route.fetch();
        if (!response.ok()) throw new Error(`Workspace read failed with ${response.status()}`);
        held.resolve();
        await release.promise;
        await route.fulfill({ response });
      } catch (error) {
        held.reject(error);
        await route.abort().catch(() => undefined);
      }
    }, { times: 1 });
    await opener.click();
    await held.promise;
    const changedQuery = `${setup.prefix} 다른 조건`;
    await report.getByLabel('결정 후속 업무 검색', { exact: true }).fill(changedQuery);
    const firstRead = nextReport(page, setup.project.id, changedQuery);
    await report.getByRole('button', { name: '조건 적용', exact: true }).click();
    expect((await json<DecisionFollowUpPage>(await firstRead)).total).toBe(0);
    const workspaceApplied = nextReport(page, setup.project.id, changedQuery);
    release.resolve();
    expect((await json<DecisionFollowUpPage>(await workspaceApplied)).total).toBe(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(url => url.hash === setup.route(changedQuery));
    await expect(report.getByText('조건에 맞는 결정 후속 업무가 없습니다.', { exact: true })).toBeVisible();
  } finally {
    release.resolve();
    await setup.close();
  }
});
