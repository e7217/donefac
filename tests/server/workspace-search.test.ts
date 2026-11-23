import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import { Store } from '../../server/store.js';
import { defaultIssueSchema } from '../../shared/issue-schema.js';
import type { DocPage, GitlabLink, Issue, Project, WorkspaceSnapshot } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';
import { DEFAULT_WORKSPACE_SEARCH_FILTERS, normalizeWorkspaceSearchInput, normalizeWorkspaceSearchQuery, searchQuickIssues, searchWorkspace, workspaceSearchLabels,
  workspaceAtlassianSearchAddress, WORKSPACE_SEARCH_QUERY_LIMIT, type WorkspaceSearchFilters, type WorkspaceSearchResult } from '../../shared/workspace-search.js';

const now = '2026-11-21T00:00:00.000Z';
const firstProject: Project = { id: 'one', name: '연구실', key: 'LAB', description: '', color: '#333333', createdAt: now };
const secondProject: Project = { ...firstProject, id: 'two', key: 'OPS', name: '운영실' };

function issue(id: string, title: string, values: Partial<Issue> = {}): Issue {
  return { id, title, key: `LAB-${id}`, projectId: firstProject.id, description: '', type: '작업', status: 'todo', priority: 'medium',
    assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null,
    estimate: null, cycle: null, module: null, release: null, version: 1, createdAt: now, updatedAt: now, completedAt: null, ...values };
}

function doc(id: string, title: string, values: Partial<DocPage> = {}): DocPage {
  return { id, title, projectId: firstProject.id, parentId: null, plainText: '', content: { type: 'doc', content: [] },
    authorId: 'test-user', createdAt: now, updatedAt: now, status: 'draft', version: 1, icon: '📄', ...values };
}

function snapshot(issues: Issue[] = [], documents: DocPage[] = []): WorkspaceSnapshot {
  return { issues, documents, projects: [firstProject, secondProject], users: [], dependencies: [], resourceLinks: [], activities: [], gitlabLinks: [] };
}

function filters(overrides: Partial<WorkspaceSearchFilters>): WorkspaceSearchFilters {
  return { ...DEFAULT_WORKSPACE_SEARCH_FILTERS, ...overrides };
}

function ids(items: WorkspaceSearchResult[]): string[] {
  return items.map(item => item.kind === 'issue' ? item.issue.id : item.document.id);
}

const gitlabOrigin = 'https://gitlab.search.invalid:8443';
const gitlabRepository = `${gitlabOrigin}/scm/group/Sub/repo`;
const mergeRequestUrl = `${gitlabRepository}/-/merge_requests/91`;
const branchName = 'feature/QA';
const branchUrl = `${gitlabRepository}/-/tree/${encodeURIComponent(branchName)}`;
const commitSha = 'abc123def0'.repeat(4);

function gitlabLink(issueId: string, kind: GitlabLink['kind'], webUrl: string, fields: Partial<GitlabLink> = {}): GitlabLink {
  return { id: `${issueId}:${kind}:${webUrl}`, issueId, projectId: 5, iid: 91, kind, webUrl,
    title: '합성 개발 활동', state: 'active', updatedAt: now, ...fields };
}

test('workspace original-address searches only linked local targets and preserves filters and safe sharing', () => {
  const url = 'https://wiki.search.invalid/wiki/pages/viewpage.action?pageId=90071992547409931234';
  const input = `${url}&private_token=synthetic-secret#section`;
  const data = snapshot([issue('linked-ticket', '원본에 연결한 업무'), issue('body-ticket', '본문 주소 업무', { description: url })], [
    doc('linked-doc', '이관 문서', { projectId: secondProject.id, labels: ['정책'] }),
    doc('body-doc', '본문 주소 문서', { plainText: url }),
  ]);
  const matches = { issueIds: new Set(['linked-ticket', 'inactive-ticket']), documentIds: new Set(['linked-doc', 'inactive-doc']) };
  assert.equal(normalizeWorkspaceSearchInput(input), url);
  assert.equal(workspaceAtlassianSearchAddress(input)?.product, 'confluence');
  assert.deepEqual(ids(searchWorkspace(data, filters({ query: input }), matches).items).sort(), ['linked-doc', 'linked-ticket']);
  assert.deepEqual(ids(searchWorkspace(data, filters({ query: input, scope: `project:${secondProject.id}`, label: '정책' }), matches).items), ['linked-doc']);
  assert.equal(searchWorkspace(data, filters({ query: input, scope: `project:${firstProject.id}`, kind: 'document' }), matches).total, 0);
  assert.equal(searchWorkspace(data, filters({ query: input })).total, 0);
  assert.deepEqual(searchQuickIssues(data, input, matches).map(row => row.issue.id), ['linked-ticket']);
  assert.deepEqual(searchQuickIssues(data, input), []);
  assert.equal(normalizeWorkspaceSearchInput('https://reviewer:synthetic-secret@jira.search.invalid/jira/browse/TEAM-1'), '');
  assert.equal(normalizeWorkspaceSearchInput('https://wiki.search.invalid/wiki/spaces/TEAM/pages/123?pageId=124'), '');
  const overlappingGitlabUrl = `${gitlabRepository}/-/tree/browse/TEAM-1`;
  assert.equal(workspaceAtlassianSearchAddress(overlappingGitlabUrl), null);
  assert.equal(normalizeWorkspaceSearchInput(overlappingGitlabUrl), `${gitlabRepository}/-/tree/browse%2FTEAM-1`);
});

test('GitLab URL lookup matches the exact local object for all active linked tickets', () => {
  const data = snapshot([issue('one', '첫 번째 검토'), issue('two', '두 번째 검토', { projectId: secondProject.id }),
    issue('other', '다른 저장소 검토'), issue('branch', '브랜치 업무'), issue('commit', '커밋 업무'), issue('pipeline', '파이프라인 업무')]);
  const commitUrl = `${gitlabRepository}/-/commit/${commitSha}`;
  const pipelineUrl = `${gitlabRepository}/-/pipelines/919`;
  data.gitlabLinks = [gitlabLink('one', 'merge_request', mergeRequestUrl), gitlabLink('two', 'merge_request', mergeRequestUrl),
    gitlabLink('one', 'merge_request', mergeRequestUrl, { id: 'duplicate-local-observation' }),
    gitlabLink('archived', 'merge_request', mergeRequestUrl),
    gitlabLink('other', 'merge_request', `${gitlabOrigin}/scm/group/Sub/other/-/merge_requests/91`, { projectId: 9 }),
    gitlabLink('branch', 'branch', branchUrl, { iid: 0, sourceBranch: branchName }),
    gitlabLink('commit', 'commit', commitUrl, { iid: 0, sourceSha: commitSha }),
    gitlabLink('pipeline', 'pipeline', pipelineUrl, { iid: 919 })];
  const original = structuredClone(data);
  const supplied = new URL(mergeRequestUrl);
  supplied.username = 'reviewer';
  supplied.password = 'synthetic-secret';
  supplied.search = '?private_token=synthetic-query-secret';
  supplied.hash = '#note_240';
  const byInput = [
    [supplied.href, ['one', 'two'], 'GitLab MR '],
    [`${gitlabRepository}/-/tree/${branchName}?ref_type=heads#L1`, ['branch'], 'GitLab 브랜치 '],
    [branchUrl, ['branch'], 'GitLab 브랜치 '],
    [commitUrl, ['commit'], 'GitLab 커밋 '],
    [pipelineUrl, ['pipeline'], 'GitLab 파이프라인 '],
  ] as const;
  for (const [query, expected, label] of byInput) {
    const full = searchWorkspace(data, filters({ query }));
    assert.deepEqual(ids(full.items).sort(), [...expected].sort(), query);
    const quick = searchQuickIssues(data, query);
    assert.deepEqual(quick.map(row => row.issue.id).sort(), [...expected].sort(), query);
    for (const item of [...full.items, ...quick]) {
      const evidence = 'matchedGitlab' in item ? item.matchedGitlab : undefined;
      assert.ok(evidence, query);
      assert.ok(evidence.startsWith(label), query);
      assert.doesNotMatch(evidence, /synthetic-secret|synthetic-query-secret|note_240/u);
    }
  }
  assert.equal(normalizeWorkspaceSearchInput(supplied.href), mergeRequestUrl);
  const otherPage = `${gitlabRepository}/-/issues/91`;
  assert.equal(normalizeWorkspaceSearchInput(
    `${otherPage.replace('https://', 'https://reviewer:synthetic-secret@')}?search=sample text#note_240`,
  ), otherPage);
  const invalidPath = mergeRequestUrl.replace('/Sub/', '/Other/%2e%2e/Sub/');
  const sharedInvalidPath = normalizeWorkspaceSearchInput(`${invalidPath}?token=synthetic#note_240`);
  assert.equal(sharedInvalidPath, invalidPath);
  assert.equal(searchWorkspace(data, filters({ query: sharedInvalidPath })).total, 0);
  assert.deepEqual(searchQuickIssues(data, sharedInvalidPath), []);
  assert.deepEqual(ids(searchWorkspace(data, filters({ query: supplied.href, scope: `project:${secondProject.id}` })).items), ['two']);
  assert.equal(searchWorkspace(data, filters({ query: supplied.href, kind: 'document' })).total, 0);
  assert.deepEqual(ids(searchWorkspace(data, filters({ query: `${gitlabOrigin}/scm/group/Sub/other/-/merge_requests/91` })).items), ['other']);
  for (const query of [mergeRequestUrl.replace(':8443', ''), mergeRequestUrl.replace('https:', 'http:'),
    mergeRequestUrl.replace('gitlab.search.invalid', 'elsewhere.search.invalid'), mergeRequestUrl.replace('/scm/', '/other-install/'),
    mergeRequestUrl.replace('/Sub/', '/sub/'), mergeRequestUrl.replace('/91', '/910'), `${gitlabRepository}/-/tree/feature/qa`]) {
    assert.equal(searchWorkspace(data, filters({ query })).total, 0, query);
    assert.deepEqual(searchQuickIssues(data, query), [], query);
  }
  assert.deepEqual(data, original);
});

test('GitLab exact references use scoped, case-sensitive names and follow current and Jira ticket keys', () => {
  const data = snapshot([
    issue('key', '현재 키 업무', { key: 'LAB-91' }), issue('previous', '원래 키 업무'), issue('development', '개발 업무'),
    issue('related', '연관 업무'), issue('deleted', '삭제된 브랜치 업무'), issue('text', '기존 키워드 업무', { description: 'LAB-91' }),
    issue('fork', '포크에서 검토할 업무'),
  ]);
  data.issueAliases = { previous: [{ source: 'jira', key: 'LAB-91' }] };
  data.gitlabLinks = [
    gitlabLink('development', 'merge_request', mergeRequestUrl, { sourceBranch: branchName }),
    gitlabLink('development', 'branch', branchUrl, { iid: 0, sourceBranch: branchName }),
    gitlabLink('related', 'branch', `${gitlabRepository}/-/tree/LAB-91`, { iid: 0, sourceBranch: 'LAB-91' }),
    gitlabLink('deleted', 'branch', `${gitlabRepository}/-/tree/deleted-branch`, { iid: 0, sourceBranch: 'deleted-branch', state: 'deleted' }),
    gitlabLink('fork', 'merge_request', `${gitlabRepository}/-/merge_requests/92`, { iid: 92, sourceBranch: 'fork/topic' }),
  ];
  for (const [query, expected] of [['scm/group/Sub/repo!91', ['development']], [branchName, ['development']],
    [`refs/heads/${branchName}`, ['development']], ['fork/topic', ['fork']],
    ['LAB-91', ['key', 'previous', 'related', 'text']]] as const) {
    assert.deepEqual(ids(searchWorkspace(data, filters({ query })).items), expected, query);
    assert.deepEqual(searchQuickIssues(data, query).map(value => value.issue.id), expected, query);
  }
  for (const query of ['!91', 'group/Sub/repo!91', 'scm/group/sub/repo!91', 'scm/group/Sub/repo!910',
    'feature/qa', 'feature/', 'deleted-branch', `${gitlabRepository}/-/tree/deleted-branch`, `${gitlabRepository}/-/tree/fork/topic`]) {
    assert.equal(searchWorkspace(data, filters({ query })).total, 0, query);
    assert.deepEqual(searchQuickIssues(data, query), [], query);
  }
});

test('stored GitLab URLs through the 4,000-character link limit remain intact for exact lookup', () => {
  const prefix = `${gitlabOrigin}/scm/${`${'subgroup'.repeat(10)}/`.repeat(45)}`;
  const suffix = '/-/merge_requests/91';
  const url = `${prefix}${'r'.repeat(4000 - prefix.length - suffix.length)}${suffix}`;
  assert.equal(url.length, 4_000);
  const data = snapshot([issue('long-url', '중첩 저장소에 있는 업무'),
    issue('different-repo', '다른 중첩 저장소의 업무', { description: `${prefix}different${suffix}` })]);
  data.gitlabLinks = [gitlabLink('long-url', 'merge_request', url)];
  const query = `${url}?search=${'e'.repeat(4096)}#notes`;
  assert.equal(normalizeWorkspaceSearchInput(query), url);
  assert.deepEqual(ids(searchWorkspace(data, filters({ query })).items), ['long-url']);
  assert.deepEqual(searchQuickIssues(data, query).map(value => value.issue.id), ['long-url']);
  assert.equal(searchWorkspace(data, filters({ query: url.slice(0, -1) })).total, 0);
});

test('HTTP search resolves stored GitLab activity with its existing response shape and ordinary text limit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-gitlab-search-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const opened = await fetch(`${base}/issues`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-neo', title: '합성 검색 업무' }),
  });
  assert.equal(opened.status, 201);
  const linked = await opened.json() as Issue;
  const local = new Store(directory);
  const url = `${gitlabOrigin}/scm/${'division/'.repeat(60)}group/repo/-/merge_requests/91`;
  assert.ok(url.length > 500);
  try {
    local.put('gitlab_links', gitlabLink(linked.id, 'merge_request', url));
  } finally { local.db.close(); }

  const search = (q: string) => fetch(`${base}/search?${new URLSearchParams({ q })}`);
  const matched = await search(`${url}?private_token=synthetic#note_300`);
  assert.equal(matched.status, 200);
  assert.deepEqual(await matched.json(), { issues: [linked], documents: [] });
  assert.deepEqual(await (await search(`${gitlabRepository}/-/merge_requests/91`)).json(), { issues: [], documents: [] });
  assert.equal((await search('x'.repeat(500))).status, 200);
  assert.equal((await search('x'.repeat(501))).status, 400);
  const deleted = await fetch(`${base}/issues/${linked.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await (await search(url)).json(), { issues: [], documents: [] });
});

test('workspace search ranks exact ticket keys then title, label, and body matches across result kinds', () => {
  const data = snapshot([
    issue('exact-key', '제목과 무관', { key: 'LAB-12' }),
    issue('exact-issue-title', 'Lab-12'),
    issue('partial-title', '요청 LAB-12 검토'),
  ], [
    doc('body-only', '가나다', { plainText: '참고 본문에는 LAB-12가 있습니다.' }),
    doc('exact-document-title', 'LAB-12'),
    doc('label-only', '다음 항목', { labels: ['lab-12 자료'] }),
  ]);
  const result = searchWorkspace(data, filters({ query: '  Ｌａｂ－１２\t' }));
  assert.deepEqual(ids(result.items), ['exact-key', 'exact-issue-title', 'exact-document-title', 'partial-title', 'label-only', 'body-only']);
  assert.equal(result.total, 6);
  assert.equal(result.items.at(-1)?.excerpt, '참고 본문에는 LAB-12가 있습니다.');
  assert.deepEqual(ids(searchWorkspace(data, filters({ query: 'LAB-12', kind: 'document' })).items),
    ['exact-document-title', 'label-only', 'body-only']);
});

test('workspace search matches normalized issue metadata and document plain text without modifying the snapshot', () => {
  const data = snapshot([issue('6', '등록 자료', { module: '안전 설계', customFields: { origin: 'green' } })],
    [doc('korean-body', '새 문서', { plainText: '안내용 본문\n　한글 입력' })]);
  data.issueSchemas = [{ ...defaultIssueSchema(firstProject.id), fields: [{ id: 'origin', name: '출처', kind: 'select',
    archived: false, required: false, description: '', issueTypes: [], options: [{ id: 'green', name: '검토 승인', archived: false }] }] }];
  const workflow = defaultWorkflow(firstProject.id);
  data.workflows = [{ ...workflow, statuses: workflow.statuses.map(status => status.id === 'todo' ? { ...status, label: '접수 완료' } : status) }];
  const original = structuredClone(data);
  for (const query of ['연구실', '안전 설계', '검토 승인', 'GREEN', '접수 완료']) {
    assert.ok(ids(searchWorkspace(data, filters({ query })).items).includes('6'));
  }
  const matching = searchWorkspace(data, filters({ query: '본문  한글' }));
  assert.deepEqual(ids(matching.items), ['korean-body']);
  assert.equal(matching.items[0].excerpt, '안내용 본문 한글 입력');
  assert.deepEqual(data, original);
});

test('workspace label browsing uses active documents, exact canonical labels, and chosen spaces', () => {
  const data = snapshot([issue('9', '문서 조회', { labels: ['Café'] })], [
    doc('common', '공통 문서 조회', { projectId: null, labels: ['Cafe\u0301', '별도'] }),
    doc('project-one', '프로젝트 문서 조회', { labels: ['CAFÉ'] }),
    doc('project-one-partial', '다른 문서 조회', { labels: ['Café 검토'] }),
    doc('project-two', '운영 문서 조회', { projectId: secondProject.id, labels: ['카드'] }),
  ]);
  assert.deepEqual(new Set(workspaceSearchLabels(data, 'common')), new Set([{ key: 'café', name: 'Café' }, { key: '별도', name: '별도' }]));
  assert.deepEqual(workspaceSearchLabels(data, 'project:two'), [{ key: '카드', name: '카드' }]);
  assert.equal(workspaceSearchLabels(data, '').filter(item => item.key === 'café').length, 1);
  assert.deepEqual(new Set(ids(searchWorkspace(data, filters({ label: 'CAFE\u0301' })).items)), new Set(['common', 'project-one']));
  assert.deepEqual(ids(searchWorkspace(data, filters({ query: '문서 조회', scope: 'common' })).items), ['common']);
  assert.deepEqual(ids(searchWorkspace(data, filters({ query: '문서 조회', scope: 'project:two' })).items), ['project-two']);
  assert.deepEqual(searchWorkspace(data, filters({ label: 'café\n' })), { items: [], total: 0, page: 1, pageCount: 1 });
  assert.deepEqual(searchWorkspace(data, filters({ query: '문서 조회', scope: 'project:missing' })).items, []);
  assert.deepEqual(searchWorkspace(data, filters({ page: 10 })), { items: [], total: 0, page: 1, pageCount: 1 });
});

test('workspace search paginates duplicate titles stably and gets safe ancestor titles for the visible results', () => {
  const copies = Array.from({ length: 23 }, (_, index) => doc(`copy${index + 1}`, '같은 제목'));
  const root = doc('root', '원래 상위 문서');
  const parent = doc('parent', '직접 상위 문서', { parentId: root.id });
  copies[20].parentId = parent.id;
  copies[21].parentId = copies[21].id;
  copies[22].parentId = 'missing-parent';
  const data = snapshot([], [parent, ...copies.toReversed(), root]);
  const result = searchWorkspace(data, filters({ query: '같은 제목', page: 99 }));
  assert.deepEqual([result.total, result.page, result.pageCount], [23, 2, 2]);
  assert.deepEqual(ids(result.items), ['copy21', 'copy22', 'copy23']);
  assert.deepEqual(result.items.map(item => item.kind === 'document' ? item.parentTitles : undefined),
    [['원래 상위 문서', '직접 상위 문서'], [], []]);
  assert.deepEqual(searchWorkspace({ ...data, documents: data.documents.toReversed() }, filters({ query: '같은 제목', page: 2 })), result);
  assert.equal(searchWorkspace(data, filters({ query: '같은 제목', page: 0 })).items.length, 20);
});

test('workspace search returns bounded Unicode-safe leading or matching excerpts', () => {
  const body = `${'İ로 시작 😀 '.repeat(100)}\u0000줄바꿈\n   검색할 문구 ${'꼬리😀'.repeat(100)}`;
  const data = snapshot([issue('unicode', '중간 문구 검색', { description: body })]);
  const result = searchWorkspace(data, filters({ query: '검색할 문구' }));
  const excerpt = result.items[0].excerpt!;
  assert.match(excerpt, /줄바꿈 검색할 문구/u);
  assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…') && excerpt.length <= 160 && excerpt.isWellFormed());
  assert.ok(!/[\p{Cc}\n]/u.test(excerpt));
  assert.equal(normalizeWorkspaceSearchQuery('  ＬＡＢ\n－１２\u0000  '), 'LAB -12');
  const capped = normalizeWorkspaceSearchQuery(`${'x'.repeat(WORKSPACE_SEARCH_QUERY_LIMIT - 1)}😀 뒤`);
  assert.equal(capped, 'x'.repeat(WORKSPACE_SEARCH_QUERY_LIMIT - 1));
  assert.ok(capped.isWellFormed());
});
