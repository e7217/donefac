import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import type { DecisionFollowUpPage, DocPage, DocumentTreeMovePreview, Issue, WorkspaceSnapshot } from '../../shared/types';

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
    return { actor, peer, issue, home, project, document, excerpt, prefix, close,
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
  await page.addInitScript(actorId => localStorage.setItem('donefac.actor', actorId), setup.actor.id);
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

test('결정 후속 업무에서 다른 프로젝트로 이동한 현재 문서를 열고 고정 근거와 보고서 조건을 보존한다', async ({ page, context, request }) => {
  test.setTimeout(75_000);
  const setup = await fixture(request);
  try {
    const { report } = await openReport(page, setup);
    const oldPath = `#/${setup.home.id}/documents/${setup.document.id}`;
    const source = report.getByRole('link', { name: `현재 문서 열기 ${setup.document.title}`, exact: true });
    await expect(source).toHaveAttribute('href', oldPath);
    const newTab = context.waitForEvent('page');
    await source.click({ modifiers: ['ControlOrMeta'] });
    const reader = await newTab;
    try {
      await expect(reader).toHaveURL(url => url.hash === oldPath);
      await expect(reader.getByRole('textbox', { name: '문서 제목', exact: true })).toHaveValue(setup.document.title, { timeout: 20_000 });
      await expect(page).toHaveURL(url => url.hash === setup.route());
    } finally {
      await reader.close();
    }

    const headers = { 'X-Actor-Id': setup.peer.id };
    const path = `/api/documents/${setup.document.id}`;
    const revisedText = '이동 후 현재 회의록 본문';
    const revised = await json<DocPage>(await request.patch(path, { headers, data: {
      expectedVersion: setup.document.version, title: `${setup.prefix} 수정한 현재 문서`,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: revisedText }] }] },
    } }));
    const target = { projectId: setup.project.id, parentId: null };
    const { token } = await json<DocumentTreeMovePreview>(await request.post(`${path}/move-preview`, { headers, data: target }));
    await json<DocumentTreeMovePreview>(await request.post(`${path}/move`, { headers, data: { ...target, token } }));

    // The report still links to the previous location until the action refreshes the workspace.
    await expect(source).toHaveAttribute('href', oldPath);
    await source.press('Enter');
    const currentPath = `#/${setup.project.id}/documents/${setup.document.id}`;
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(page).toHaveURL(url => url.hash === currentPath);
    await expect(title).toHaveValue(revised.title);
    await expect(page.locator('.docs-prose')).toContainText(revisedText);
    await expect(page.locator('.docs-prose')).not.toContainText(setup.excerpt);

    const draft = `${revised.title} 작성 중`;
    await title.fill(draft);
    const confirmation = page.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await page.evaluate(() => history.back());
    expect(await confirmation).toContain('저장하지 않은 편집');
    await expect(page).toHaveURL(url => url.hash === currentPath);
    await expect(title).toHaveValue(draft);

    const returned = nextReport(page, setup.project.id, setup.prefix);
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => history.back());
    expect((await json<DecisionFollowUpPage>(await returned)).items[0]?.document).toMatchObject({ id: setup.document.id, projectId: setup.project.id, title: revised.title });
    await expect(page).toHaveURL(url => url.hash === setup.route());
    await expect(report.getByRole('link', { name: `현재 문서 열기 ${revised.title}`, exact: true })).toHaveAttribute('href', currentPath);
    await report.getByRole('button', { name: `${setup.issue.key} 결정 근거 열기`, exact: true }).click();
    await expect(report.locator('[data-document-excerpt-start]')).toHaveText(setup.excerpt);
    await expect(report.getByText(revisedText, { exact: true })).toHaveCount(0);
  } finally {
    await setup.close();
  }
});
