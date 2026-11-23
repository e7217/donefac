import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertLegacyContent } from '../../server/migration-content.js';
import { record } from '../../server/legacy-import-model.js';
import { buildMigrationOptions, buildMigrationPlan } from '../../server/migration-planner.js';
import type { MigrationPackage, MigrationPlanningInput } from '../../server/migration-contracts.js';
import { MAX_DOCUMENT_PROPERTY_BLOCKS, MAX_DOCUMENT_PROPERTY_REPORT_LIMIT } from '../../shared/document-properties.js';
import type { LegacyRecord, User } from '../../shared/types.js';

const now = '2026-11-23T02:00:00Z';
const actor: User = { id: 'test-user', name: '합성 작업자', email: 'fake@example.test', color: '#446688' };
const page = (id: string, text: string, containerId = '42') => record('page', id, {
  title: `문서 ${id}`, containerId, createdAt: now, updatedAt: now, text, textFormat: 'confluence-storage',
  metadata: { sourceClass: 'Page', version: '2', bodyPresent: true },
});
const parameter = (name: string, value: string) => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;
const macro = (name: string, children: string) => `<ac:structured-macro ac:name="${name}">${children}</ac:structured-macro>`;
const properties = (table: string, params = '') => macro('details', `${params}<ac:rich-text-body>${table}</ac:rich-text-body>`);
const report = (params: Record<string, string>, name = 'detailssummary') => macro(name,
  Object.entries(params).map(([key, value]) => parameter(key, value)).join(''));
const vertical = '<table class="wrapped"><colgroup><col/><col/></colgroup><tbody><tr><th>담당</th><td>품질 팀</td></tr></tbody></table>';
const withoutReferences = { resolveReference: () => null };

test('Confluence property tables preserve vertical and horizontal values, dates and hidden groups alongside disclosures', () => {
  const status = macro('status', parameter('title', '현장 검토') + parameter('colour', 'Yellow'));
  const horizontal = `<table><thead><tr><th>단계</th><th><p>기한</p></th><th>제외</th></tr></thead><tbody><tr><td><p>${status}</p></td><td><time datetime="2026-12-02"/></td><td><p><br/></p></td></tr></tbody></table>`;
  const legacy = '<table><tbody><tr><td colspan="1" style="text-align: left;">결정</td><td>진행</td></tr></tbody></table>';
  const disclosure = macro('details', parameter('title', '작업 설명') + '<ac:rich-text-body><p>상세</p></ac:rich-text-body>');
  const result = convertLegacyContent(page('1', properties(vertical, parameter('id', '검토 유형') + parameter('hidden', 'true')) +
    properties(horizontal) + properties(legacy) + disclosure + macro('expand', '<ac:rich-text-body><p>또 다른 접기</p></ac:rich-text-body>')), withoutReferences);
  assert.deepEqual(result.diagnostics.map(item => item.code), ['DOCUMENT_PROPERTIES_STATUS_PRESENTATION_CHANGED']);
  assert.deepEqual(result.content.content?.map(node => [node.type, { ...node.attrs }]), [
    ['documentProperties', { group: '검토 유형', hidden: true, entries: [{ name: '담당', value: '품질 팀' }] }],
    ['documentProperties', { group: '', hidden: false, entries: [{ name: '단계', value: '현장 검토' }, { name: '기한', value: '2026-12-02' }, { name: '제외', value: '' }] }],
    ['documentProperties', { group: '', hidden: false, entries: [{ name: '결정', value: '진행' }] }],
    ['details', {}], ['details', {}],
  ]);
  assert.equal(result.content.content?.[3].content?.[0].content?.[0].text, '작업 설명');
});

test('property reports keep exact filters and columns with only proven scope and bound the total projected macros', () => {
  const ordered = report({ cql: 'space = DEV AND type = page AND label IN (Release, "test-run") ORDER BY title DESC',
    id: '주간', headings: '담당, "기한, 조정", "검토 ""상태"""', pageSize: '50' });
  const legacy = report({ label: 'Release', id: '주간', sortBy: 'Modified' }, 'page-properties-report');
  const scopes: (string | null)[] = [];
  const result = convertLegacyContent(page('1', ordered + legacy + properties(vertical).repeat(MAX_DOCUMENT_PROPERTY_BLOCKS)), {
    ...withoutReferences, resolveChildListSpaceProject: space => { scopes.push(space); return space === 'DEV' ? 'development' : 'home'; },
  });
  const children = result.content.content!;
  assert.deepEqual(scopes, ['DEV', null]);
  assert.deepEqual(result.diagnostics.map(item => item.code), ['DOCUMENT_PROPERTY_REPORT_PAGINATION_CHANGED', 'DOCUMENT_PROPERTY_BLOCK_LIMIT']);
  assert.deepEqual({ ...children[0].attrs }, { projectId: 'development', group: '주간', labels: ['Release', 'test-run'], match: 'any',
    columns: ['담당', '기한, 조정', '검토 "상태"'], sort: 'title', descending: true, limit: MAX_DOCUMENT_PROPERTY_REPORT_LIMIT, title: '' });
  assert.deepEqual({ ...children[1].attrs }, { projectId: 'home', group: '주간', labels: ['Release'], match: 'all',
    columns: [], sort: 'updated', descending: true, limit: MAX_DOCUMENT_PROPERTY_REPORT_LIMIT, title: '' });
  assert.equal(children.filter(child => child.type === 'documentProperties' || child.type === 'documentPropertyReport').length, MAX_DOCUMENT_PROPERTY_BLOCKS);
  assert.ok(children.slice(MAX_DOCUMENT_PROPERTY_BLOCKS).every(child => child.type === 'codeBlock' && child.content?.[0].text?.includes('ac:name="details"')));
});

test('unrepresentable Confluence table values, layouts or report filters retain inert macro XML', () => {
  const cases = [
    [properties('<table><tr><td>요구 근거</td><td><a href="https://example.test/work">업무</a></td></tr></table>'), 'DOCUMENT_PROPERTIES_VALUES_UNSUPPORTED'],
    [properties('<table><tr><td style="background-color: red">상태</td><td>미완료</td></tr></table>'), 'DOCUMENT_PROPERTIES_TABLE_UNSUPPORTED'],
    [properties('<table><tr><th>확인</th><td>1</td></tr><tr><th>확인</th><td>2</td></tr></table>'), 'DOCUMENT_PROPERTIES_VALUES_UNSUPPORTED'],
    [properties(vertical, parameter('id', 'first') + parameter('id', 'second')), 'DOCUMENT_PROPERTIES_PARAMETERS_UNSUPPORTED'],
    [properties(vertical, parameter('hidden', 'unknown')), 'DOCUMENT_PROPERTIES_PARAMETERS_UNSUPPORTED'],
    [report({ label: 'release', space: '@all' }), 'DOCUMENT_PROPERTY_REPORT_PARAMETERS_UNSUPPORTED'],
    [report({ label: 'release', sortBy: '담당자' }), 'DOCUMENT_PROPERTY_REPORT_PARAMETERS_UNSUPPORTED'],
    [report({ label: 'release', firstcolumn: '결정 이름' }), 'DOCUMENT_PROPERTY_REPORT_PARAMETERS_UNSUPPORTED'],
    [report({ label: 'release', countComments: 'true' }), 'DOCUMENT_PROPERTY_REPORT_PARAMETERS_UNSUPPORTED'],
    [report({ cql: 'type = page AND space = DEV AND label = release AND ancestor = 12' }), 'DOCUMENT_PROPERTY_REPORT_PARAMETERS_UNSUPPORTED'],
    [report({ cql: 'space = DEV AND label = release' }), 'DOCUMENT_PROPERTY_REPORT_PARAMETERS_UNSUPPORTED'],
    [report({ label: 'release', space: 'DEV' }), 'DOCUMENT_PROPERTY_REPORT_SCOPE_UNRESOLVED'],
  ];

  for (const [raw, code] of cases) {
    const converted = convertLegacyContent(page('1', raw), withoutReferences);
    assert.deepEqual(converted.diagnostics.map(item => item.code), [code], raw);
    assert.equal(converted.content.content?.[0].type, 'codeBlock', raw);
    assert.equal(converted.content.content?.[0].content?.[0].text, raw.replaceAll('<col/>', '<col></col>'), raw);
  }
});

function migrationInput(id: string, records: LegacyRecord[]): MigrationPlanningInput {
  const source = { product: 'confluence' as const, instanceKey: 'synthetic-property-source', format: 'confluence-xml' as const, declaredVersion: '6.9.1', timezone: 'UTC' };
  const bundle: MigrationPackage = { dataset: { source, records, diagnostics: [], unsupported: [] }, summary: {
    id, source, filename: `${id}.zip`, sha256: 'a'.repeat(64), size: 8, version: 1, actorId: actor.id, createdAt: now,
    counts: {}, errors: 0, warnings: 0, fileCount: 1, expandedBytes: 8, applySupported: false,
  } };
  const options = buildMigrationOptions([bundle]), configuration = options.defaultConfiguration;
  configuration.datePolicy = 'import-time';
  return { id, configuration, actorId: actor.id, users: [actor], existingProjectKeys: [], packages: [bundle], now };
}

const space = (id: string, key: string) => record('project', id, { title: key, metadata: { sourceClass: 'Space', spaceKey: key } });

test('migration resolves an exact separately mapped Confluence report scope and refuses merged projects', () => {
  const source = report({ label: 'release', space: 'DEV', id: 'release' });
  const input = migrationInput('scope', [space('42', 'WIKI'), space('43', 'DEV'), page('1', source), page('2', properties(vertical), '43')]);
  const baseline = buildMigrationPlan(input);
  assert.equal(baseline.preview.canApply, true, JSON.stringify(baseline.preview.notices));
  const scopedReport = baseline.documents.find(document => document.title === '문서 1')?.content.content?.[0];
  assert.equal(scopedReport?.type, 'documentPropertyReport');
  assert.equal(scopedReport.attrs?.projectId, baseline.projects.find(project => project.key === 'DEV')?.id);
  assert.ok(baseline.sourceRecords.some(archive => archive.record.text === source));

  input.configuration.projects = input.configuration.projects.map(project => ({ ...project, key: 'MERGED', name: '합친 프로젝트' }));
  const merged = buildMigrationPlan(input);
  assert.equal(merged.preview.canApply, true, JSON.stringify(merged.preview.notices));
  assert.ok(merged.preview.notices.some(item => item.code === 'DOCUMENT_PROPERTY_REPORT_SCOPE_UNRESOLVED'));
  assert.equal(merged.documents.find(document => document.title === '문서 1')?.content.content?.[0].type, 'codeBlock');
});

test('same-version property reprojection uses the exact prior body and leaves local or contradictory content intact', () => {
  const first = page('1', properties(vertical));
  const second = page('2', report({ label: 'Release' }));
  const third = page('3', properties(vertical));
  const wiki = space('42', 'WIKI');
  const baseline = buildMigrationPlan(migrationInput('initial', [wiki, first, second, third]));
  assert.equal(baseline.preview.canApply, true, JSON.stringify(baseline.preview.notices));
  const [project] = baseline.projects;
  const preview = migrationInput('next', [wiki, first, second, { ...third, text: properties(vertical.replace('품질 팀', '다른 본문')) }]);
  preview.configuration.appendPagesTo = { projectId: project.id, refreshExisting: true };
  const imported = baseline.documents.map(document => {
    const original = baseline.sourceRecords.find(item => item.targetId === document.id)!;
    const previous = { ...original };
    delete previous.confluencePageFieldHashes;
    const { content, plainText } = convertLegacyContent(previous.record, { ...withoutReferences, legacyDocumentProperties: true });
    const afterEdit = previous.record.sourceId === '2'
      ? { ...content, content: [...content.content!, { type: 'paragraph', content: [{ type: 'text', text: '팀 편집' }] }] } : content;
    return { previous, previousTimezone: 'UTC', document: { ...document, content: afterEdit, plainText } };
  });
  preview.appendPages = { project, sourceSpaceId: '42', sourceSpaceKey: 'WIKI', labelListScope: 'isolated', token: 'scope-v1',
    knownPages: imported.map(({ document, previous }) => ({ sourceId: previous.record.sourceId, documentId: document.id,
      projectId: project.id, sourceSpaceId: '42', sourceTitle: document.title })), refreshDocuments: imported };
  const updated = buildMigrationPlan(preview);
  assert.equal(updated.preview.canApply, true, JSON.stringify(updated.preview.notices));
  assert.deepEqual(updated.preview.documentRefresh?.map(item => [item.sourceId, item.fields[0].decision]), [['1', 'apply'], ['2', 'conflict']]);
  assert.deepEqual(updated.documentUpdates?.map(update => [update.documentId, update.changes.content?.content?.[0].type]),
    [[imported[0].document.id, 'documentProperties']]);
  assert.ok(updated.preview.notices.some(item => item.code === 'CONFLUENCE_REFRESH_DOCUMENT_PROPERTIES_RESTORED'));
  assert.ok(updated.preview.notices.some(item => item.code === 'CONFLUENCE_REFRESH_SOURCE_NOT_NEWER'));
});
