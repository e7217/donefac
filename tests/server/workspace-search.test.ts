import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultIssueSchema } from '../../shared/issue-schema.js';
import type { DocPage, Issue, Project, WorkspaceSnapshot } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';
import { DEFAULT_WORKSPACE_SEARCH_FILTERS, normalizeWorkspaceSearchQuery, searchWorkspace, workspaceSearchLabels,
  WORKSPACE_SEARCH_QUERY_LIMIT, type WorkspaceSearchFilters, type WorkspaceSearchResult } from '../../shared/workspace-search.js';

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
