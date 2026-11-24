import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import type {
  Comment, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, WorkspaceSnapshot,
} from '../../shared/types';

async function json<T>(response: Pick<APIResponse, 'text' | 'status'>, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  return JSON.parse(body) as T;
}

test('360px에서 Jira 원본 댓글 주소로 빠른 검색과 전체 검색에서 정확한 댓글을 열고 새로고침 후 다시 찾는다', async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 360, height: 820 });
  const suffix = randomUUID().slice(0, 7).toUpperCase();
  const originalKey = `JQ${suffix}`;
  const sourceBase = `https://jira-${suffix.toLowerCase()}.search.invalid/team`;
  const sourceIssueUrl = `${sourceBase}/browse/${originalKey}-1`;
  const title = `원본 댓글 주소 검색 업무 ${suffix}`;
  const otherTitle = `다른 원본 Jira 업무 ${suffix}`;
  const firstBody = '첫 번째 Jira 원본 댓글';
  const secondBody = '두 번째 Jira 원본 댓글';
  const otherBody = '다른 업무의 Jira 원본 댓글';
  const author = { name: `comment-author-${suffix}`, displayName: `원본 작성자 ${suffix}` };
  const created = '2020-01-02T00:00:00Z';
  const { users: [actor] } = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const headers = { 'X-Actor-Id': actor.id };
  const sourceComment = (id: string, body: string) => ({ id, body, author, created });
  const sourceIssue = (id: string, number: number, summary: string, comments: ReturnType<typeof sourceComment>[]) => ({
    id, key: `${originalKey}-${number}`, self: `${sourceBase}/rest/api/2/issue/${id}`, fields: {
      project: { id: '4020', key: originalKey, name: `Jira 댓글 검색 ${suffix}` }, summary, created, updated: created,
      status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, comment: { comments },
    },
  });
  const jira = { issues: [
    sourceIssue('1200', 1, title, [sourceComment('701', firstBody), sourceComment('702', secondBody)]),
    sourceIssue('1201', 2, otherTitle, [sourceComment('703', otherBody)]),
  ] };
  const query = new URLSearchParams({ filename: `jira-comment-search-${suffix}.json`, product: 'jira', instanceKey: `comment-search-${suffix}` });
  const source = await json<LegacyPackageSummary>(await request.post(`/api/legacy-import/packages?${query}`, {
    headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: Buffer.from(JSON.stringify(jira)),
  }), 201);
  const issueIds: string[] = [];
  try {
    const { defaultConfiguration, identities } = await json<MigrationOptions>(await request.get(`/api/migrations/options?packageId=${source.id}`));
    const originAuthor = identities.find(identity => identity.sourceValue === author.name);
    if (!originAuthor) throw new Error('The synthetic Jira comment author was not staged.');
    const configuration = { ...defaultConfiguration,
      projects: defaultConfiguration.projects.map(project => ({ ...project, key: `TQ${suffix}` })),
      users: { ...defaultConfiguration.users, [originAuthor.id]: actor.id },
      sourceBaseUrls: { ...defaultConfiguration.sourceBaseUrls, [source.id]: sourceBase },
    };
    const preview = await json<MigrationPreview>(await request.post('/api/migrations/preview', { headers, data: { configuration } }), 201);
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    expect(preview.counts.comments).toBe(3);
    const { import: receipt } = await json<MigrationApplyResult>(await request.post(`/api/migrations/previews/${preview.id}/apply`, {
      headers, data: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    }), 201);
    const projectId = receipt.projectIds[0];
    const workspace = await json<WorkspaceSnapshot>(await request.get('/api/workspace'));
    const importedIssues = workspace.issues.filter(issue => issue.projectId === projectId);
    issueIds.push(...importedIssues.map(issue => issue.id));
    const issue = importedIssues.find(candidate => candidate.title === title);
    if (!issue || !importedIssues.some(candidate => candidate.title === otherTitle)) throw new Error('Two Jira issues were expected after import.');
    const comments = await json<Comment[]>(await request.get('/api/comments', { params: { resourceType: 'issue', resourceId: issue.id } }));
    const first = comments.find(comment => comment.body === firstBody);
    const second = comments.find(comment => comment.body === secondBody);
    if (!first || !second) throw new Error('Two Jira comments were expected on the target issue.');

    const outbound: string[] = [];
    await page.route(url => url.hostname.endsWith('.search.invalid'), async route => {
      outbound.push(route.request().url());
      await route.abort();
    });
    await page.addInitScript(id => localStorage.setItem('teamspace.actor', id), actor.id);
    await page.goto(`/#/${projectId}/issues`);
    const quick = page.getByRole('dialog', { name: '통합 검색', exact: true });
    const quickInput = quick.getByRole('textbox', { name: '통합 검색어', exact: true });
    const resultName = `${issue.key} ${title} 댓글 열기`;
    const openQuick = async (url: string) => {
      if (!await quick.isVisible()) await page.getByRole('button', { name: '통합 검색', exact: true }).click();
      await quickInput.fill(url);
    };
    const panel = page.getByRole('dialog', { name: title, exact: true });
    const resultRegion = page.getByRole('region', { name: '검색 결과', exact: true });
    const article = (comment: Comment) => panel.locator(`#issue-comment-${comment.id}`);
    const route = () => {
      const [path, query] = new URL(page.url()).hash.split('?');
      return { path, query: new URLSearchParams(query) };
    };
    const openNativeComment = async (id: string) => {
      const { path, query } = route();
      query.set('issueComment', id);
      await page.evaluate(hash => { location.hash = hash; }, `${path}?${query}`);
    };
    const assertFocus = async (comment: Comment, other: Comment) => {
      await expect.poll(() => [route().query.get('issue'), route().query.get('issueComment')]).toEqual([issue.id, comment.id]);
      await expect(article(comment)).toBeFocused({ timeout: 25_000 });
      await expect(article(comment)).toContainText(comment.body);
      await expect(article(other)).toBeVisible();
      await expect(article(other)).not.toBeFocused();
    };

    await openQuick(`${sourceIssueUrl}?focusedId=701#comment-701`);
    await expect(quick.getByText('Jira 댓글 주소', { exact: true })).toBeVisible();
    await quick.getByRole('button', { name: resultName, exact: true }).click();
    await assertFocus(first, second);
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(route().query.get('issueComment')).toBeNull();

    const tracking = 'synthetic-search-tracking-value';
    await openQuick(`${sourceIssueUrl}?tracking=${tracking}#comment-702`);
    await expect(quick.getByRole('button', { name: resultName, exact: true })).toBeVisible();
    await quick.getByRole('button', { name: '전체 검색 결과', exact: true }).click();
    const fullComment = resultRegion.getByRole('button', { name: resultName, exact: true });
    await expect(fullComment).toBeVisible();
    expect(route().path).toBe(`#/${projectId}/search`);
    const savedQuery = route().query.get('q');
    expect(savedQuery).toBeTruthy();
    const savedSource = new URL(savedQuery!);
    expect(`${savedSource.origin}${savedSource.pathname}`).toBe(sourceIssueUrl);
    expect(savedSource.searchParams.get('focusedCommentId') === '702' || savedSource.hash === '#comment-702').toBe(true);
    expect(savedSource.href).not.toContain(tracking);
    await fullComment.click();
    await assertFocus(second, first);
    expect(route().query.get('q')).toBe(savedQuery);
    await page.reload();
    await assertFocus(second, first);
    expect(route().query.get('q')).toBe(savedQuery);

    await openNativeComment(first.id);
    await assertFocus(first, second);
    await page.goBack();
    await assertFocus(second, first);

    const missing = randomUUID();
    const missingNotice = panel.getByText('댓글을 찾을 수 없습니다.', { exact: true });
    await openNativeComment(missing);
    await expect.poll(() => route().query.get('issueComment')).toBe(missing);
    await expect(missingNotice).toBeVisible();
    const commentsHeading = panel.locator('.issue-comments').getByRole('heading', { name: /^댓글\s+2$/u });
    await expect(commentsHeading).toBeFocused();
    await expect(commentsHeading).toHaveAccessibleDescription('댓글을 찾을 수 없습니다.');
    await page.goBack();
    await assertFocus(second, first);
    await expect(missingNotice).toHaveCount(0);
    expect(route().query.get('q')).toBe(savedQuery);
    await panel.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(fullComment).toBeVisible();
    expect(route().query.get('issueComment')).toBeNull();

    await openQuick(sourceIssueUrl);
    await expect(quick.getByText('Jira 원본 주소', { exact: true })).toBeVisible();
    await expect(quick.getByRole('button', { name: new RegExp(issue.key, 'u') })).toHaveCount(1);
    await openQuick(`${sourceIssueUrl}?focusedCommentId=703#comment-703`);
    await expect(quick.getByText('빠른 검색 결과가 없습니다.', { exact: true })).toBeVisible();
    await expect(quick.getByRole('button', { name: new RegExp(issue.key, 'u') })).toHaveCount(0);
    await quick.getByRole('button', { name: '전체 검색 결과', exact: true }).click();
    await expect(resultRegion.getByText('조건에 맞는 업무나 문서가 없습니다.', { exact: true })).toBeVisible();
    await expect(resultRegion.getByRole('button', { name: new RegExp(issue.key, 'u') })).toHaveCount(0);
    expect(outbound).toEqual([]);
  } finally {
    for (const id of issueIds) {
      const removed = await request.delete(`/api/issues/${id}`, { headers });
      if (!removed.ok()) continue;
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`, { headers });
    }
    await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`, { headers });
  }
});
