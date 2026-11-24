import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeLegacyPackageBytes } from '../../server/legacy-import-analysis.js';
import { parseJira } from '../../server/legacy-import-jira.js';
import { LegacyImportError } from '../../server/legacy-import-model.js';
import type { LegacyDataset } from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const parse=(name:string,value:string,extra:Map<string,Buffer>=new Map())=>parseJira(new Map([[name,Buffer.from(value)],...extra]),'jira-synthetic');
const find=(data:LegacyDataset,id:string)=>{const item=data.records.find(item=>item.id===id);assert.ok(item,`Missing ${id}`);return item;};
const codes=(data:LegacyDataset)=>new Set(data.diagnostics.map(item=>item.code));

test('Jira REST parent evidence verifies identities and distinguishes explicit clear from omission', () => {
  const parent = (data: LegacyDataset, id: number) => find(data, `issue:${id}`).metadata.jiraParentSourceId;
  const row = (id: number, key: string, value?: unknown) => ({ id, key, fields: {
    project: { id: '20', key: 'OLD' }, summary: key, ...(value === undefined ? {} : { parent: value }),
  } });
  const data = parse('rest.json', JSON.stringify({ issues: [
    row(100, 'OLD-1'), row(200, 'OLD-2'), row(201, 'OLD-3'), row(202, 'OLD-3'),
    row(300, 'OLD-30', { id: '100', key: 'OLD-1' }), row(301, 'OLD-31', null), row(302, 'OLD-32'),
    row(303, 'OLD-33', { id: '100', key: 'OLD-2' }), row(304, 'OLD-34', { key: 'OLD-1' }),
    row(305, 'OLD-35', { key: 'OLD-99' }), row(306, 'OLD-36', { id: '300', key: 'not an issue key' }),
    row(307, 'OLD-37', { id: '307' }), row(308, 'OLD-38', '100'), row(309, 'OLD-39', { key: 'OLD-3' }),
    row(310, 'OLD-40', { id: 100 }), row(311, 'OLD-41', { id: Number.MAX_SAFE_INTEGER + 1, key: 'OLD-1' }),
    row(312, 'OLD-42', { id: '900', key: 'OLD-90' }),
  ] }));
  assert.deepEqual([300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312].map(id => parent(data, id)),
    ['100', null, undefined, undefined, '100', 'OLD-99', undefined, undefined, undefined, undefined, '100', undefined, '900']);
  for (const id of [300, 304]) assert.equal(find(data, `issue:${id}`).metadata.jiraParentSourceKey, 'OLD-1');
  assert.equal(find(data, 'issue:312').metadata.jiraParentSourceKey, 'OLD-90');
  assert.equal(find(data, 'issue:303').parentId, '100');
  assert.equal(find(data, 'issue:308').parentId, '100');
  const importers = parse('importers.json', JSON.stringify({ projects: [{ key: 'OLD', issues: [
    { externalId: '100', key: 'OLD-1', summary: 'Importer parent field', parent: null },
  ] }] }));
  assert.equal(parent(importers, 100), undefined);
});

test('Jira XML subtask links provide positive parent evidence only when singular and consistent', () => {
  const issue = (id: number, attributes = '') => `<Issue id="${id}" project="20" number="${id}" ${attributes}/>`;
  const link = (id: number, source: number, destination: number, type = 800) =>
    `<IssueLink id="${id}" linktype="${type}" source="${source}" destination="${destination}"/>`;
  const data = parse('entities.xml', `<entity-engine-xml>
    <Project id="20" pkey="OLD"/>${issue(100)}${issue(200)}${issue(300)}${issue(301)}${issue(302, 'parent="100"')}
    ${issue(303, 'parent="200"')}${issue(304, 'parent="100"')}${issue(305)}${issue(306)}${issue(307)}
    <IssueLinkType id="800" style="jira_subtask"/><IssueLinkType id="810" style="jira_subtask"/>
    <IssueLinkType id="810" style="jira_subtask"/><IssueLinkType id="820" style="jira_subtask"/>
    ${link(801, 100, 300)}${link(802, 100, 302)}${link(803, 100, 303)}
    ${link(804, 100, 305)}${link(805, 200, 305)}${link(806, 100, 306, 810)}
    <IssueLink id="807" linktype="820" source="200" destination="307"><source>100</source></IssueLink>
  </entity-engine-xml>`);
  assert.deepEqual([300, 301, 302, 303, 304, 305, 306, 307].map(id => find(data, `issue:${id}`).metadata.jiraParentSourceId),
    ['100', undefined, '100', undefined, undefined, undefined, undefined, undefined]);
  assert.equal(find(data, 'issue:303').parentId, '100');
  assert.equal(find(data, 'issue:305').parentId, '200');
});

test('Jira search exports provide only unambiguous positive parent evidence', () => {
  const item = (id: number, extra = '') => `<item><key id="${id}">OLD-${id}</key><project id="20" key="OLD"/>${extra}</item>`;
  const rss = parse('search.xml', `<rss><channel>${item(10)}${item(20)}
    ${item(30, '<parent id="10">OLD-10</parent>')}${item(31, '<parent/>')}
    ${item(32, '<parent id="10">OLD-20</parent>')}${item(33, '<parent id="10">OLD-10</parent><parent id="20"/>')}
  </channel></rss>`);
  const csv = parse('search.csv', [
    'Issue key,Issue id,Summary,Parent id,Parent', 'OLD-10,10,First parent,,', 'OLD-20,20,Second parent,,',
    'OLD-30,30,Matched parent,10,OLD-10', 'OLD-31,31,Blank parent,,', 'OLD-32,32,Conflicting parent,10,OLD-20',
    'OLD-33,33,Incomplete row,10',
  ].join('\n'));
  for (const data of [rss, csv]) {
    assert.deepEqual([30, 31, 32, 33].map(id => find(data, `issue:${id}`).metadata.jiraParentSourceId),
      ['10', undefined, undefined, undefined]);
    assert.equal(find(data, 'issue:30').metadata.jiraParentSourceKey, 'OLD-10');
  }
  const duplicateCsv = parse('duplicate.csv', 'Issue key,Issue id,Parent id,Parent id\nOLD-30,30,10,20');
  assert.equal(find(duplicateCsv, 'issue:30').metadata.jiraParentSourceId, undefined);
});

test('administrator XML preserves allowlisted users, issues, typed fields, comments, change groups, attachments and relationships without credentials',()=>{
  const bytes=Buffer.from('synthetic attachment bytes'),xml=`<?xml version="1.0"?><entity-engine-xml version="9.12">
    <ApplicationUser id="10" userKey="user-key-alice" lowerUserName="alice"/>
    <User id="1" userName="alice" displayName="가상 작성자" emailAddress="alice@example.test" active="0" credential="NEVER_COPY_CREDENTIAL"/>
    <Project id="20" pkey="OLD" name="가상 프로젝트" lead="alice"/>
    <Status id="1" pname="열림"/><IssueType id="3" pname="작업"/><Priority id="4" pname="보통"/>
    <CustomField id="100" name="영향 범위" customfieldtypekey="select"/><CustomFieldOption id="200" customfield="100" value="전체" disabled="Y"/>
    <Issue id="300" project="20" number="7" summary="한글 원본" creator="alice" reporter="alice" assignee="alice" status="1" issuetype="3" priority="4" created="2020-01-01 10:00:00.000"><description><![CDATA[원래 *위키* 본문]]></description></Issue>
    <Issue id="301" project="20" number="8" summary="자식 업무" status="1" issuetype="3"/>
    <CustomFieldValue id="400" issue="300" customfield="100" stringvalue="200"/><CustomFieldValue id="401" issue="300" customfield="100" numbervalue="0"/>
    <Action id="500" issue="300" type="comment" author="alice" created="2020-01-02 10:00:00.000" level="team-private" rolelevel="123"><body><![CDATA[원본 댓글]]></body></Action>
    <ChangeGroup id="600" issue="300" author="alice" created="2020-01-03 10:00:00.000"/><ChangeItem id="601" group="600" field="status" fieldtype="jira" oldvalue="1" oldstring="열림" newvalue="5" newstring="종료"/>
    <FileAttachment id="700" issue="300" filename="첨부.txt" filesize="26" mimetype="text/plain" author="alice" created="2020-01-04 10:00:00.000" version="2"/>
    <IssueLinkType id="800" linkname="Sub-task" style="jira_subtask"/><IssueLink id="801" linktype="800" source="300" destination="301"/>
    <RemoteIssueLink id="900" issueid="300" title="가상 설계 문서" url="https://wiki.example.test/pages/viewpage.action?pageId=777&amp;token=NEVER_COPY_TOKEN"/>
    <Workflow id="1000" name="기존 흐름"><descriptor><![CDATA[<password>NEVER_COPY_WORKFLOW_SECRET</password>]]></descriptor></Workflow>
    <OSPropertyEntry id="1001" propertyKey="secret" value="NEVER_COPY_SETTING"/><UnknownPlugin id="1002" secret="NEVER_COPY_PLUGIN"/>
  </entity-engine-xml>`;
  const active='<backup><data tableName="AO_PLUGIN"><row><column name="password">NEVER_COPY_AO_SECRET</column></row></data></backup>';
  const data=parse('entities.xml',xml,new Map([['attachments/OLD/OLD-7/700',bytes],['activeobjects.xml',Buffer.from(active)]]));assert.equal(data.source.format,'jira-backup-xml');assert.equal(data.source.declaredVersion,'9.12');assert.equal(find(data,'identity:user-key-alice').title,'가상 작성자');assert.equal(find(data,'issue:300').authorId,'user-key-alice');assert.equal(find(data,'issue:300').metadata.key,'OLD-7');assert.equal(find(data,'issue:300').text,'원래 *위키* 본문');assert.equal(find(data,'issue:301').parentId,'300');assert.equal(find(data,'comment:500').metadata.level,'team-private');assert.deepEqual(find(data,'history:600').metadata.items,[{id:'601',field:'status',fieldtype:'jira',oldvalue:'1',oldstring:'열림',newvalue:'5',newstring:'종료'}]);assert.equal(find(data,'option:200').metadata.disabled,'Y');
  const attachment=find(data,'attachment:700');assert.equal(attachment.metadata.path,'attachments/OLD/OLD-7/700');assert.equal(attachment.metadata.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(attachment.metadata.version,'2');assert.equal(find(data,'relation:remote:900').metadata.url,'https://wiki.example.test/pages/viewpage.action?pageId=777');assert.ok(find(data,'relation:remote:900').references.some(ref=>ref.kind==='page'&&ref.sourceId==='777'));
  assert.ok(!JSON.stringify(data).includes('NEVER_COPY'));assert.ok(data.unsupported.some(item=>item.type==='OSPropertyEntry'&&item.count===1));assert.ok(data.unsupported.some(item=>item.type==='activeobjects:AO_PLUGIN'));assert.ok(codes(data).has('WORKFLOW_DESCRIPTOR_NOT_CONVERTED'));assert.ok(codes(data).has('DATE_TIMEZONE_UNRESOLVED'));assert.ok(codes(data).has('PREVIEW_ONLY'));
});

test('Jira analysis refuses multiple administrator backups without selecting either source', () => {
  const backup = (id: number, summary: string) => Buffer.from(
    `<entity-engine-xml><Issue id="${id}" summary="${summary}"/></entity-engine-xml>`,
  );
  const exports: [string, Buffer][] = [
    ['export-a/entities.xml', backup(10, 'first private source')],
    ['export-b/ENTITIES.XML', backup(20, 'second private source')],
  ];
  const renamed = exports.map(([name, bytes]): [string, Buffer] => [name.replace(/entities\.xml$/i, 'backup.xml'), bytes]);
  for (const entries of [exports, exports.slice().reverse(), renamed]) {
    const data = parseJira(new Map(entries), 'ambiguous-jira-admin');
    assert.equal(data.source.format, 'jira-backup-xml');
    assert.deepEqual(data.records, []);
    assert.deepEqual(data.diagnostics.filter(item => item.severity === 'error').map(({ code, path }) => [code, path]), [
      ['JIRA_ADMIN_BACKUP_AMBIGUOUS', null],
    ]);
    assert.doesNotMatch(JSON.stringify(data), /first private source|second private source/);
  }
});

test('Jira analysis uses only the sibling Active Objects file and keeps attachment XML as files', () => {
  const entities = `<entity-engine-xml version="9.12">
    <Project id="20" pkey="OLD"/><Issue id="10" project="20" number="1" summary="Wrapped issue"/>
    <CustomField id="1000" cfname="Sprint" customfieldtypekey="com.pyxis.greenhopper.jira:gh-sprint"/>
    <CustomFieldValue id="700" issue="10" customfield="1000" stringvalue="80"/>
    <FileAttachment id="701" issue="10" filename="entities.xml"/>
    </entity-engine-xml>`;
  const active = (name: string) => Buffer.from(`<backup><data tableName="AO_60DB71_SPRINT">
    <column name="ID"/><column name="NAME"/><row><integer>80</integer><string>${name}</string></row>
    </data></backup>`);
  const attachment = Buffer.from('attachment bytes');
  for (const filename of ['entities.xml', 'jira-admin.xml']) {
    const data = parse(`export/deep/${filename}`, entities, new Map([
      ['outside/activeobjects.xml', active('Foreign sprint')],
      ['activeobjects.xml', Buffer.from('foreign file without valid XML')],
      ['export/deep/ACTIVEOBJECTS.XML', active('Verified sibling sprint')],
      ['export/deep/Attachments/OLD/OLD-1/entities.xml', Buffer.from('attached XML is not a backup')],
      ['export/deep/attachment/OLD/OLD-1/activeobjects.xml', Buffer.from('attached XML is not a registry')],
      ['export/deep/attachments/OLD/OLD-1/701', attachment],
    ]));
    assert.equal(data.source.format, 'jira-backup-xml');
    assert.equal(find(data, 'issue:10').title, 'Wrapped issue');
    assert.equal(find(data, 'option:builtin:sprints:80').title, 'Verified sibling sprint');
    assert.equal(find(data, 'option:builtin:sprints:80').metadata.jiraSprintAmbiguous, undefined);
    assert.equal(find(data, 'attachment:701').metadata.sha256, createHash('sha256').update(attachment).digest('hex'));
    assert.deepEqual(data.diagnostics.filter(item => item.code === 'JIRA_ACTIVEOBJECTS_OUTSIDE_BACKUP_ROOT').map(item => item.path),
      ['outside/activeobjects.xml', 'activeobjects.xml']);
    assert.doesNotMatch(JSON.stringify(data), /Foreign sprint/);
  }
  const rest = parse('issue.json', JSON.stringify({ id: '10', key: 'OLD-1', fields: { summary: 'REST issue' } }), new Map([
    ['activeobjects.xml', Buffer.from('not parsed without an administrator export')],
  ]));
  assert.equal(find(rest, 'issue:10').title, 'REST issue');
  assert.ok(codes(rest).has('JIRA_ACTIVEOBJECTS_OUTSIDE_BACKUP_ROOT'));
});

test('automatic archive detection ignores XML metadata clues inside Jira attachment directories', async () => {
  const attachmentPath = 'export/Attachments/OLD/OLD-1/entities.xml';
  const { dataset, files } = await analyzeLegacyPackageBytes({ product: 'auto', filename: 'wrapped-jira.zip',
    instanceKey: 'jira-auto-attachment', bytes: zip([
      { path: 'export/entities.xml', bytes: Buffer.from('<entity-engine-xml><Issue id="10" summary="Administrator issue"/></entity-engine-xml>') },
      { path: attachmentPath, bytes: Buffer.from('<hibernate-generic/>') },
    ]) });
  assert.equal(dataset.source.product, 'jira');
  assert.equal(find(dataset, 'issue:10').title, 'Administrator issue');
  assert.ok(files.some(file => file.path === attachmentPath));
});

test('RSS search XML is a separate dialect preserving authors/comments/options/links and reports partial snapshots',()=>{
  const source=`<rss version="0.92"><channel><title>검색 결과</title><issue start="0" end="1" total="3"/><item><key id="10">OLD-1</key><project id="20" key="OLD">가상 프로젝트</project><summary>검색 업무</summary><description><![CDATA[<p>렌더링한 본문</p>]]></description><reporter username="alice">Alice</reporter><created>Tue, 24 Feb 2009 16:45:02 -0600 (CST)</created><status id="1">열림</status><security id="private">비공개</security><parent id="11">OLD-2</parent><comments><comment id="30" author="alice" created="2020-01-01T00:00:00Z"><![CDATA[댓글 원문]]></comment></comments><attachments><attachment id="40" name="문서.txt" author="alice" size="4"/></attachments><customfields><customfield id="customfield_55" key="select"><customfieldname>영향</customfieldname><customfieldvalues><customfieldvalue>높음</customfieldvalue></customfieldvalues></customfield></customfields><issuelinks><issuelinktype id="1"><name>Blocks</name><outwardlinks description="blocks"><issuelink><issuekey id="11">OLD-2</issuekey></issuelink></outwardlinks></issuelinktype></issuelinks></item></channel></rss>`;
  const data=parse('search.xml',source);assert.equal(data.source.format,'jira-search-xml');assert.equal(find(data,'issue:10').text,'<p>렌더링한 본문</p>');assert.equal(find(data,'issue:10').parentId,'11');assert.deepEqual((find(data,'issue:10').metadata.fields as Record<string,unknown>).security,[{id:'private',text:'비공개'}]);assert.equal(find(data,'comment:30').authorId,'alice');assert.equal(find(data,'field:customfield_55').title,'영향');assert.ok(data.records.some(item=>item.kind==='relation'&&item.references.some(ref=>ref.sourceId==='11')));assert.ok(codes(data).has('ISSUES_PARTIAL'));assert.ok(codes(data).has('ATTACHMENT_BYTES_MISSING'));assert.ok(codes(data).has('SEARCH_XML_HISTORY_NOT_PROVIDED'));
});

test('Jira administrator and RSS XML preserve original estimate seconds without inferring remaining effort', () => {
  const issue = (id: number, attrs: string, body = '') => `<Issue id="${id}" summary="Issue ${id}" ${attrs}>${body}</Issue>`;
  const administrator = parse('entities.xml', `<entity-engine-xml>
    ${issue(10, 'timeoriginalestimate="3600" timeestimate="2400" timespent="1200"')}
    ${issue(11, '', '<timeoriginalestimate>0</timeoriginalestimate>')}
    ${issue(12, 'timeoriginalestimate="600"', '<timeoriginalestimate>60</timeoriginalestimate>')}
    ${issue(13, 'timeoriginalestimate="1h"')}${issue(14, 'timeestimate="120" timespent="720"')}
    </entity-engine-xml>`);
  const rssRow = (id: number, body: string) => `<item><key id="${id}">OLD-${id}</key>${body}</item>`;
  const rss = parse('search.xml', `<rss><channel>
    ${rssRow(10, '<timeoriginalestimate seconds="3600">1시간</timeoriginalestimate><timeestimate seconds="2400">40분</timeestimate>')}
    ${rssRow(11, '<timeoriginalestimate seconds="0">0 minutes</timeoriginalestimate>')}
    ${rssRow(12, '<timeoriginalestimate seconds="600"/><timeoriginalestimate seconds="60"/>')}
    ${rssRow(13, '<timeoriginalestimate>1 hour</timeoriginalestimate>')}
    ${rssRow(14, '<timeestimate seconds="120"/><timespent seconds="720"/><aggregatetimeoriginalestimate seconds="600"/>')}
    </channel></rss>`);
  for (const data of [administrator, rss]) {
    assert.deepEqual([10, 11, 12, 13, 14].map(id => find(data, `issue:${id}`).metadata.jiraOriginalEstimateSeconds),
      [3600, 0, undefined, undefined, undefined]);
    assert.deepEqual(data.diagnostics.filter(item => item.code === 'JIRA_ORIGINAL_ESTIMATE_UNRESOLVED').map(({ recordId }) => recordId),
      ['issue:12', 'issue:13']);
  }
  assert.deepEqual((find(administrator, 'issue:12').metadata.fields as Record<string, unknown>).timeoriginalestimate, ['600', '60']);
  assert.equal((find(administrator, 'issue:10').metadata.fields as Record<string, unknown>).timeestimate, '2400');
  assert.deepEqual((find(rss, 'issue:10').metadata.fields as Record<string, unknown>).timeestimate, [{ seconds: '2400', text: '40분' }]);
});

test('Jira REST original estimate requires numeric seconds or explicit null and agrees across aliases', () => {
  const claims = [
    { timeoriginalestimate: 7200, timeestimate: 1800 },
    { timetracking: { originalEstimateSeconds: 900, remainingEstimateSeconds: 800 } },
    { timeoriginalestimate: 0, timetracking: { originalEstimateSeconds: 0 } },
    { timeoriginalestimate: null },
    { timeestimate: 1800, timespent: 400, aggregatetimeoriginalestimate: 4200, timetracking: { remainingEstimateSeconds: 1800 } },
    { timeoriginalestimate: 30, timetracking: { originalEstimateSeconds: 60 } },
    { timeoriginalestimate: '60' },
    { timetracking: { originalEstimate: '1h' } },
    { timeoriginalestimate: 60, timetracking: ['ambiguous'] },
    { timeoriginalestimate: Number.MAX_SAFE_INTEGER + 1 },
    { timeoriginalestimate: -60 },
    { timeoriginalestimate: null, timetracking: { originalEstimateSeconds: 0 } },
    { timeoriginalestimate: 1.5 },
    { timetracking: { originalEstimateSeconds: null } },
    { timetracking: null },
    { timeoriginalestimate: 61 },
  ];
  const issues = claims.map((fields, index) => ({ id: String(index + 1), key: `OLD-${index + 1}`, fields }));
  const data = parse('issues.json', JSON.stringify({ issues }));
  assert.deepEqual(issues.map(({ id }) => find(data, `issue:${id}`).metadata.jiraOriginalEstimateSeconds), [
    7200, 900, 0, null, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null, undefined, 61,
  ]);
  assert.deepEqual(data.diagnostics.filter(item => item.code === 'JIRA_ORIGINAL_ESTIMATE_UNRESOLVED').map(({ recordId }) => recordId),
    ['issue:6', 'issue:7', 'issue:8', 'issue:9', 'issue:10', 'issue:11', 'issue:12', 'issue:13']);
  assert.deepEqual(find(data, 'issue:2').metadata.fields, { timetracking: { originalEstimateSeconds: 900, remainingEstimateSeconds: 800 } });
  assert.deepEqual(find(data, 'issue:6').metadata.fields, { timeoriginalestimate: 30, timetracking: { originalEstimateSeconds: 60 } });
  assert.throws(() => parse('duplicate.json', JSON.stringify({ issues: [issues[0], { ...issues[0], fields: claims[1] }] })), LegacyImportError);
});

test('Jira CSV original estimate uses one exact native seconds column with a complete issue row', () => {
  const data = parse('issues.csv', [
    'Issue key,Issue id,Summary,Original Estimate,Remaining Estimate,Custom field (Original Estimate)',
    'OLD-1,1,Original,1200,2400,3', 'OLD-2,2,Zero,0,,', 'OLD-3,3,Blank,,2800,2400', 'OLD-4,4,Display,1h,,',
    'OLD-5,5,Incomplete row,600',
  ].join('\n'));
  assert.deepEqual([1, 2, 3, 4, 5].map(id => find(data, `issue:${id}`).metadata.jiraOriginalEstimateSeconds),
    [1200, 0, undefined, undefined, undefined]);
  assert.deepEqual(data.diagnostics.filter(item => item.code === 'JIRA_ORIGINAL_ESTIMATE_UNRESOLVED').map(({ recordId }) => recordId),
    ['issue:4', 'issue:5']);
  const duplicate = parse('duplicate.csv', 'Issue key,Summary,Original Estimate,original estimate\nOLD-1,Duplicate,120,240');
  assert.equal(find(duplicate, 'issue:OLD-1').metadata.jiraOriginalEstimateSeconds, undefined);
  assert.ok(codes(duplicate).has('JIRA_ORIGINAL_ESTIMATE_UNRESOLVED'));
  const external = parse('external.csv', 'Key,Summary,Original Estimate\nOLD-1,Custom file,120');
  assert.equal(find(external, 'issue:OLD-1').metadata.jiraOriginalEstimateSeconds, undefined);
});

test('CSV BOM, repeated headers, quoted multiline text and attachment URLs retain each source object',()=>{
  const csv='\uFEFFIssue key,Issue id,Summary,Description,Reporter,Comment,Comment,Attachment,Custom field (영향),Custom field (영향),Status\r\nOLD-1,10,"한글, ""따옴표""\n두 번째 줄",원문,alice,"01/Mar/20 10:00;alice;첫 댓글;세미콜론",두 번째 댓글,"01/Mar/20 11:00;alice;첨부.txt;https://jira.example.test/secure/attachment/700/첨부.txt",높음,낮음,열림\r\n';
  const data=parse('issues.csv',csv,new Map([['attachments/OLD/OLD-1/700',Buffer.from('file')]]));assert.equal(data.source.format,'jira-csv');assert.equal(find(data,'issue:10').title,'한글, "따옴표"\n두 번째 줄');assert.deepEqual((find(data,'issue:10').metadata.fields as Record<string,unknown>)['Custom field (영향)'],['높음','낮음']);const comments=data.records.filter(item=>item.kind==='comment');assert.equal(comments.length,2);assert.equal(comments[0].text,'첫 댓글;세미콜론');assert.equal(comments[1].text,'두 번째 댓글');assert.equal(comments[1].authorId,null);assert.equal(find(data,'attachment:700').metadata.bytesPresent,true);assert.equal(find(data,'option:csv:Status:열림').metadata.syntheticId,true);assert.ok(codes(data).has('CSV_HISTORY_NOT_PROVIDED'));assert.ok(codes(data).has('CSV_COMMENT_ATTRIBUTION_UNRESOLVED'));
});

test('Jira CSV records explicit blank custom columns and refuses to infer blanks from incomplete rows', () => {
  const data = parse('custom-fields.csv', [
    'Issue key,Issue id,Summary,Custom field (등급),Custom field (등급),Custom field (점수)',
    'OLD-1,10,명시적으로 비운 값,,,',
    'OLD-2,20,반복된 열의 값,높음,,0',
    'OLD-3,30,일부 열이 빠진 행,높음',
  ].join('\r\n'));
  assert.equal(find(data, 'field:csv:Custom field (등급)').title, 'Custom field (등급)');
  assert.equal(find(data, 'field:csv:Custom field (점수)').title, 'Custom field (점수)');
  const headers = ['csv:Custom field (등급)', 'csv:Custom field (점수)'];
  const blank = find(data, 'issue:10').metadata;
  assert.deepEqual(blank.jiraSnapshotCustomFields, headers);
  assert.equal(Object.hasOwn(blank.fields as object, 'Custom field (등급)'), false);
  assert.equal(Object.hasOwn(blank.fields as object, 'Custom field (점수)'), false);
  const filled = find(data, 'issue:20').metadata;
  assert.deepEqual(filled.jiraSnapshotCustomFields, headers);
  assert.equal((filled.fields as Record<string, unknown>)['Custom field (등급)'], '높음');
  assert.equal((filled.fields as Record<string, unknown>)['Custom field (점수)'], '0');
  assert.equal(find(data, 'issue:30').metadata.jiraSnapshotCustomFields, undefined);
  assert.ok(data.diagnostics.some(item => item.code === 'CSV_COLUMN_COUNT_MISMATCH' && item.severity === 'error'));
});

test('REST JSON retains ADF, custom fields, actors, changelog and partial-page diagnostics without network requests',()=>{
  const data=parse('rest.json',JSON.stringify({startAt:50,maxResults:50,total:200,names:{customfield_100:'확인 여부'},schema:{customfield_100:{type:'boolean'}},issues:[{id:'10',key:'OLD-1',fields:{project:{id:'20',key:'OLD',name:'가상 프로젝트'},summary:'REST 업무',description:{type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:'ADF 원문'}]}]},reporter:{accountId:'actor-1',displayName:'이전 작성자',emailAddress:'actor@example.test'},status:{id:'1',name:'열림'},security:{id:'private',name:'비공개',credential:'NEVER_COPY_SECURITY'},customfield_100:false,customfield_101:{id:'choice-a',value:'높음'},vendorUnsupported:{password:'NEVER_COPY_VENDOR'},worklog:{startAt:0,total:2,worklogs:[{id:'70',author:{accountId:'actor-1'},comment:'작업 기록',started:'2020-01-01T00:00:00Z',timeSpentSeconds:0}]},comment:{startAt:0,total:3,comments:[{id:'30',author:{accountId:'actor-1'},body:'댓글',created:'2020-01-01T00:00:00Z'}]},attachment:[{id:'40',filename:'없음.bin',content:'https://jira.example.test/attachment/40/file',author:{accountId:'actor-1'}}],issuelinks:[{id:'50',type:{name:'Blocks'},outwardIssue:{id:'11',key:'OLD-2'}}]},changelog:{startAt:0,total:4,histories:[{id:'60',author:{accountId:'actor-1'},created:'2020-01-01T00:00:00Z',items:[{field:'status',from:'1',to:'5'}]}]}}]}));
  assert.equal(data.source.format,'jira-json');assert.equal(find(data,'issue:10').textFormat,'adf');assert.deepEqual((find(data,'issue:10').metadata.fields as Record<string,unknown>).security,{id:'private',name:'비공개',present:true});assert.ok(!JSON.stringify(data).includes('NEVER_COPY_SECURITY'));assert.ok(find(data,'issue:10').text.includes('ADF 원문'));assert.equal((find(data,'issue:10').metadata.fields as Record<string,unknown>).customfield_100,false);assert.equal(find(data,'field:customfield_100').title,'확인 여부');assert.equal(find(data,'option:customfield_101:choice-a').metadata.originalId,'choice-a');assert.equal(find(data,'history:60').authorId,'actor-1');assert.equal(find(data,'history:worklog:70').metadata.timeSpentSeconds,'0');assert.ok(codes(data).has('WORKLOGS_PARTIAL'));assert.ok(codes(data).has('JSON_FIELDS_NOT_NORMALIZED'));assert.ok(!JSON.stringify(data).includes('NEVER_COPY_VENDOR'));assert.ok(data.unsupported.some(item=>item.type==='json-field:vendorUnsupported'));assert.ok(codes(data).has('JSON_REST_DIALECT'));assert.ok(codes(data).has('ISSUES_PARTIAL'));assert.ok(codes(data).has('COMMENTS_PARTIAL'));assert.ok(codes(data).has('HISTORY_PARTIAL'));assert.ok(codes(data).has('ATTACHMENT_BYTES_MISSING'));
});

test('REST remote links archive the exact issue owner and sanitized target with explicit coverage', () => {
  const source = 'https://jira.example.test/tools/jira/rest/api/2/issue';
  const wiki = 'https://wiki.example.test/wiki/pages/viewpage.action?pageId=777';
  const row = (id: number) => ({ id, key: `OLD-${id}`, self: `${source}/${id}`, fields: { summary: `Ticket ${id}` } });
  const data = parse('rest.json', JSON.stringify({ issues: [
    { ...row(10), remoteLinks: { status: 'complete', values: [{ id: 90,
      self: `${source}/OLD-10/remotelink/90`, issueId: '10', relationship: 'mentioned in',
      globalId: 'appId=synthetic-application&pageId=777&%74oken=NEVER_COPY_GLOBAL',
      application: { type: 'com.atlassian.confluence', name: 'Source wiki', apiKey: 'NEVER_COPY_APP' },
      object: { url: `${wiki}&access_token=NEVER_COPY_TARGET`, title: 'Release runbook',
        icon: { url16x16: 'https://user:NEVER_COPY_ICON@wiki.example.test/assets/icon.png', access_token: 'NEVER_COPY_FIELD' } },
    }] } },
    { ...row(11), remoteLinks: { status: 'complete', values: [] } },
    { ...row(12), remoteLinks: { status: 'unavailable' } },
    row(13),
  ] }));
  const link = find(data, 'relation:remote:90');
  assert.equal(link.title, 'Release runbook');
  assert.equal(link.containerId, '10');
  assert.deepEqual(link.references, [{ kind: 'issue', sourceId: '10', relation: 'source' }]);
  assert.equal(link.metadata.jiraRestRemoteLink, true);
  assert.equal(link.metadata.jiraRemoteLinkConflict, undefined);
  assert.equal(link.metadata.url, wiki);
  assert.equal(link.metadata.relationship, 'mentioned in');
  assert.equal(link.metadata.globalId, 'appId=synthetic-application&pageId=777');
  assert.equal(link.metadata.remoteApplicationType, 'com.atlassian.confluence');
  assert.equal(link.metadata.remotePageId, '777');
  assert.deepEqual(link.metadata.application, { type: 'com.atlassian.confluence', name: 'Source wiki' });
  assert.deepEqual(data.diagnostics.filter(item => item.code === 'JIRA_REMOTE_LINKS_UNAVAILABLE').map(item => item.recordId), ['issue:12']);
  assert.equal(data.records.filter(item => item.kind === 'relation').length, 1);
  assert.doesNotMatch(JSON.stringify(data), /NEVER_COPY/u);
});

test('REST remote links retain invalid identities, conflicting owners, and selectors as inert source rows', () => {
  const source = 'https://jira.example.test/jira/rest/api/2/issue';
  const wiki = 'https://wiki.example.test/wiki/pages/viewpage.action?pageId=777';
  const row = (owner: number, values: unknown[]) => ({ id: owner, key: `OLD-${owner}`, self: `${source}/${owner}`, fields: { summary: 'Issue' },
    remoteLinks: { status: 'complete', values } });
  const target = { object: { title: 'Runbook', url: wiki } };
  const data = parse('rest.json', JSON.stringify({ issues: [
    row(10, [{ id: '90', ...target }, { id: 91, ...target, self: `${source}/11/remotelink/91` },
      { id: 92, ...target, self: `${source.replace('/jira/', '/wrong/')}/10/remotelink/92` },
      { id: 93, ...target, issueId: 11 }, { id: 94, ...target, globalId: 'appId=wiki&pageId=778' },
      { id: 95, ...target, globalId: 'appId=wiki&pageId=777&pageId=777' },
      { id: 96, ...target, self: `${source}/10/remotelink/999` },
      { id: 97, object: { url: `${wiki}&pageVersion=3` } },
      { id: 98, object: { url: 'https://wiki.example.test/wiki/else/%2e%2e/pages/viewpage.action?pageId=777' } },
      { id: 'invalid', ...target }, { id: 99, object: { url: 'javascript:alert(1)' } }]),
    row(11, [{ id: 90, ...target }]),
    { ...row(12, []), remoteLinks: { status: 'complete', values: {} } },
  ] }));
  const relations = data.records.filter(item => item.kind === 'relation');
  assert.equal(relations.length, 12);
  assert.ok(relations.every(item => item.metadata.jiraRestRemoteLink === true && item.metadata.jiraRemoteLinkConflict === true));
  assert.equal(find(data, 'relation:remote:90').containerId, '10');
  assert.equal(find(data, 'relation:remote:99').metadata.url, null);
  assert.equal(relations.filter(item => item.sourceId.startsWith('remote-invalid:')).length, 2);
  assert.ok(codes(data).has('JIRA_REMOTE_LINK_CONFLICT'));
  assert.ok(codes(data).has('JIRA_REMOTE_LINKS_MALFORMED'));
});

test('Jira JSON registers custom user identities without inferring users from ordinary fields', () => {
  const data = parse('custom-users.json', JSON.stringify({
    names: { customfield_100: '계정 담당', customfield_101: '서버 담당' },
    schema: { customfield_100: { type: 'user' }, customfield_101: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' } },
    issues: [{ id: '10', key: 'OLD-1', fields: { summary: '사용자 필드',
      customfield_100: { accountId: 'account-owner', displayName: '원본 담당자' },
      customfield_101: { key: 'server-owner' },
      customfield_102: { id: 'choice', name: '보통 옵션', value: '보통 옵션' },
      customfield_103: 'ordinary-text',
    } }],
  }));
  assert.deepEqual(data.records.filter(row => row.kind === 'identity').map(row => row.sourceId), ['account-owner', 'server-owner']);
  assert.equal(find(data, 'identity:account-owner').title, '원본 담당자');
  assert.ok(find(data, 'issue:10').references.some(ref => ref.kind === 'identity' && ref.sourceId === 'server-owner' && ref.relation === 'customFieldUser'));
  assert.equal(find(data, 'option:customfield_102:choice').title, '보통 옵션');
  const importers = parse('custom-values.json', JSON.stringify({ projects: [{ key: 'OLD', issues: [{ externalId: '20',
    key: 'OLD-2', summary: '값 기록', customFieldValues: [{ fieldName: '생략' }, { fieldName: '비움', value: null }],
  }] }] }));
  const values = find(importers, 'issue:20').metadata.fields as Record<string, unknown>;
  assert.equal(Object.hasOwn(values, 'named:생략'), false);
  assert.equal(values['named:비움'], null);
});

test('Jira REST preserves account proof from typed user roles and withholds conflicting or fallback IDs', () => {
  const profiles = [
    { accountId: 'cloud:account', displayName: 'First name' }, { accountId: 'cloud:account', displayName: 'Renamed' },
    { key: 'JIRAUSER10000', name: 'native-name' }, { name: 'fallback-name' }, { accountId: 'unknown' }, { accountId: 1234 },
    { accountId: 'same-id' }, { key: 'same-id' }, { accountId: 'same-id' },
    { accountId: 'alias-conflict', key: 'old-a' }, { accountId: 'alias-conflict', key: 'old-b' },
    { accountId: 'cloud:one', key: 'shared-key' }, { accountId: 'cloud:two', key: 'shared-key' }, { key: 'shared-key' },
    'fallback-collision', { accountId: 'fallback-collision' },
  ];
  const issues = profiles.map((creator, index) => ({ id: String(index + 1), key: `OLD-${index + 1}`, fields: {
    summary: 'Synthetic issue', creator,
  } }));
  const data = parse('issues.json', JSON.stringify({ issues: [...issues, { id: '99', key: 'OLD-99', fields: {
    summary: 'Typed and untyped sources', customfield_10001: { accountId: 'untyped-custom-value' },
    comment: { comments: [{ id: '40', author: { accountId: 'cloud-comment-author' }, body: 'Comment' }] },
  } }] }));
  const markers = (row: LegacyDataset['records'][number]) => [row.metadata.migrationAccountKind, row.metadata.migrationAccountKey];
  assert.deepEqual(markers(find(data, 'identity:cloud:account')), ['jira-account-id', 'cloud:account']);
  assert.deepEqual(markers(find(data, 'identity:JIRAUSER10000')), ['jira-user-key', 'JIRAUSER10000']);
  assert.deepEqual(markers(find(data, 'identity:cloud-comment-author')), ['jira-account-id', 'cloud-comment-author']);
  for (const id of ['fallback-name', 'unknown', '1234', 'untyped-custom-value']) {
    assert.deepEqual(markers(find(data, `identity:${id}`)), [undefined, undefined]);
  }
  for (const id of ['same-id', 'alias-conflict', 'cloud:one', 'cloud:two', 'shared-key', 'fallback-collision']) {
    assert.deepEqual(markers(find(data, `identity:${id}`)), [null, undefined]);
  }
  const imported = parse('importers.json', JSON.stringify({
    users: [{ accountId: 'imported-actor' }], projects: [{ key: 'OLD', issues: [{ key: 'OLD-1', creator: { key: 'imported-key' } }] }],
  }));
  assert.deepEqual(markers(find(imported, 'identity:imported-actor')), [undefined, undefined]);
  assert.deepEqual(markers(find(imported, 'identity:imported-key')), [undefined, undefined]);
});

test('Jira administrator analysis proves only exact unique ApplicationUser keys', () => {
  const data = parse('entities.xml', `<entity-engine-xml>
    <ApplicationUser id="1" lowerUserName="jane" userKey="JIRAUSER10001"/>
    <CwdUser id="21" userName="Jane" lowerUserName="jane" displayName="Jane"/>
    <ApplicationUser id="2" lowerUserName="without-profile"><userKey>auth-key</userKey></ApplicationUser>
    <ApplicationUser id="3" lowerUserName="duplicated" userKey="first-claim"/>
    <ApplicationUser id="4" lowerUserName="duplicated" userKey="second-claim"/>
    <ApplicationUser id="5" lowerUserName="ambiguous-directory" userKey="directory-account"/>
    <CwdUser id="22" userName="ambiguous-directory" displayName="First directory"/>
    <CwdUser id="23" userName="ambiguous-directory" displayName="Second directory"/>
    <ApplicationUser id="6" lowerUserName="mismatched-key" userKey="first-form"><userKey>second-form</userKey></ApplicationUser>
    <CwdUser id="24" userName="fallback-name" userKey="fallback-key"/>
    <Issue id="30" summary="Synthetic issue" creator="duplicated" assignee="jane" reporter="mismatched-key"/>
    </entity-engine-xml>`);
  const markers = (id: string) => {
    const { migrationAccountKind, migrationAccountKey } = find(data, `identity:${id}`).metadata;
    return [migrationAccountKind, migrationAccountKey];
  };
  assert.deepEqual(markers('JIRAUSER10001'), ['jira-user-key', 'JIRAUSER10001']);
  assert.deepEqual(markers('auth-key'), ['jira-user-key', 'auth-key']);
  assert.deepEqual(markers('second-claim'), [null, undefined]);
  assert.deepEqual(markers('directory-account'), [null, undefined]);
  for (const id of ['second-form', 'fallback-key']) assert.deepEqual(markers(id), [undefined, undefined]);
  assert.equal(find(data, 'issue:30').authorId, 'second-claim');
});

test('Jira REST email evidence stays uncertain after conflicting or malformed claims for the same account', () => {
  const row = (id: number, accountId: string, emails: Record<string, unknown>) => ({ id, key: `OLD-${id}`, fields: {
    project: { id: '20', key: 'OLD' }, summary: `업무 ${id}`, assignee: { accountId, displayName: accountId, ...emails },
  } });
  const data = parse('rest.json', JSON.stringify({ issues: [
    row(1, 'agree', { emailAddress: ' BEARER@example.test ' }),
    row(2, 'agree', { emailAddress: null }),
    row(3, 'agree', { email: 'bearer@EXAMPLE.TEST' }),
    row(4, 'conflict', { emailAddress: 'first@example.test' }),
    row(5, 'conflict', { emailAddress: 'later@example.test' }),
    row(6, 'conflict', { emailAddress: '' }),
    row(7, 'conflict', { emailAddress: 'first@example.test' }),
    row(8, 'malformed', { email: { address: 'real@example.test' } }),
    row(9, 'malformed', { emailAddress: 'real@example.test' }),
    row(10, 'simultaneous', { emailAddress: 'a@example.test', email: 'b@example.test' }),
    row(11, 'only-an-id@example.test', {}),
  ] }));
  assert.equal(find(data, 'identity:agree').metadata.jiraIdentityEmailEvidence, 'bearer@example.test');
  for (const id of ['conflict', 'malformed', 'simultaneous']) {
    assert.equal(find(data, `identity:${id}`).metadata.jiraIdentityEmailEvidence, null);
  }
  assert.equal(find(data, 'identity:conflict').metadata.emailAddress, 'first@example.test');
  assert.ok(!Object.hasOwn(find(data, 'identity:only-an-id@example.test').metadata, 'jiraIdentityEmailEvidence'));
});

test('Jira administrator export checks every email observation and withholds an ambiguous account alias', () => {
  const data = parse('entities.xml', `<entity-engine-xml>
    <ApplicationUser lowerUserName="known" userKey="known-key"/>
    <CwdUser id="1" userName="known" emailAddress="Known@Example.Test"/>
    <OSUser id="2" userName="known"><email> known@example.test </email></OSUser>
    <CwdUser id="3" userName="competing" emailAddress="first@example.test"/>
    <User id="4" userName="competing" email="later@example.test"/>
    <User id="5" userName="mixed" emailAddress="one@example.test"><emailAddress>two@example.test</emailAddress></User>
    <ApplicationUser lowerUserName="alias" userKey="reused-1"/>
    <ApplicationUser lowerUserName="alias" userKey="reused-2"/>
    <User id="6" userName="alias" email="member@example.test"/>
  </entity-engine-xml>`);
  assert.equal(find(data, 'identity:known-key').metadata.jiraIdentityEmailEvidence, 'known@example.test');
  assert.equal(find(data, 'identity:known-key').metadata.emailAddress, 'Known@Example.Test');
  for (const id of ['competing', 'mixed', 'reused-2']) {
    assert.equal(find(data, `identity:${id}`).metadata.jiraIdentityEmailEvidence, null);
  }
});

test('Jira reporter evidence distinguishes the creator, explicit blanks and incomplete source identities', () => {
  const creator = { accountId: 'creator-a', displayName: '원본 작성자' };
  const rest = parse('issues.json', JSON.stringify({ issues: [
    { id: '1', key: 'OLD-1', fields: { creator, reporter: { accountId: 'reporter-b', displayName: '원본 보고자', credential: 'never-store-this' } } },
    { id: '2', key: 'OLD-2', fields: { creator } },
    { id: '3', key: 'OLD-3', fields: { creator, reporter: null } },
    { id: '4', key: 'OLD-4', fields: { creator, reporter: { displayName: '계정 ID 없음' } } },
  ] }));
  const restIssue = find(rest, 'issue:1');
  assert.equal(restIssue.authorId, 'creator-a');
  assert.equal(restIssue.metadata.jiraReporter, 'reporter-b');
  assert.ok(restIssue.references.some(reference => reference.relation === 'creatorOrReporter' && reference.sourceId === 'creator-a'));
  assert.ok(restIssue.references.some(reference => reference.relation === 'reporter' && reference.sourceId === 'reporter-b'));
  assert.equal(find(rest, 'identity:reporter-b').title, '원본 보고자');
  assert.equal(find(rest, 'issue:2').metadata.jiraReporter, undefined);
  assert.equal(find(rest, 'issue:3').metadata.jiraReporter, null);
  assert.equal(find(rest, 'issue:4').metadata.jiraReporter, undefined);
  assert.ok(!JSON.stringify(rest).includes('never-store-this'));

  const csv = parse('issues.csv', [
    'Issue id,Issue key,Creator,Reporter,Summary', '1,OLD-1,creator-a,reporter-b,보고자 있음',
    '2,OLD-2,creator-a,,보고자 없음', '3,OLD-3,creator-a',
  ].join('\r\n'));
  assert.equal(find(csv, 'issue:1').authorId, 'creator-a');
  assert.equal(find(csv, 'issue:1').metadata.jiraReporter, 'reporter-b');
  assert.equal(find(csv, 'issue:2').metadata.jiraReporter, null);
  assert.equal(find(csv, 'issue:3').metadata.jiraReporter, undefined);
  const duplicate = parse('duplicate.csv', 'Issue id,Issue key,Reporter,Reporter\r\n1,OLD-1,first,second');
  assert.equal(find(duplicate, 'issue:1').metadata.jiraReporter, undefined);

  const backup = parse('entities.xml', `<entity-engine-xml>
    <Project id="20" pkey="OLD"/><ApplicationUser lowerUserName="bob" userKey="reporter-b"/>
    <Issue id="1" project="20" creator="creator-a" reporter="bob"/><Issue id="2" project="20" creator="creator-a"/>
    <Issue id="3" project="20" creator="creator-a" reporter=""/>
  </entity-engine-xml>`);
  assert.equal(find(backup, 'issue:1').authorId, 'creator-a');
  assert.equal(find(backup, 'issue:1').metadata.jiraReporter, 'reporter-b');
  assert.equal(find(backup, 'issue:1').references.filter(reference => reference.relation === 'reporter').length, 1);
  assert.equal(find(backup, 'issue:2').metadata.jiraReporter, undefined);
  assert.equal(find(backup, 'issue:3').metadata.jiraReporter, null);

  const search = parse('search.xml', `<rss><channel>
    <item><key id="1">OLD-1</key><reporter username="reporter-b">원본 이름</reporter></item>
    <item><key id="2">OLD-2</key><reporter>표시 이름만 있음</reporter></item>
    <item><key id="3">OLD-3</key><reporter/></item>
  </channel></rss>`);
  assert.equal(find(search, 'issue:1').metadata.jiraReporter, 'reporter-b');
  assert.equal(find(search, 'issue:2').authorId, '표시 이름만 있음');
  assert.equal(find(search, 'issue:2').metadata.jiraReporter, undefined);
  assert.equal(find(search, 'issue:3').metadata.jiraReporter, null);
});

test('Importers JSON is explicitly identified and preserves authored history, comments, custom data and top-level links',()=>{
  const data=parse('importers.json',JSON.stringify({users:[{name:'alice',fullname:'원본 Alice',email:'alice@example.test'}],projects:[{key:'OLD',name:'기존 프로젝트',issues:[{externalId:'10',key:'OLD-1',summary:'원본 부모',reporter:'alice',issueType:'Task',status:'Closed',created:'P-3D',customFieldValues:[{fieldName:'점수',fieldType:'float',value:0}],comments:[{author:'alice',body:'이전 댓글',created:'2020-01-01T00:00:00Z'}],history:[{author:'alice',created:'2020-01-02T00:00:00Z',items:[{fieldType:'jira',field:'status',fromString:'Open',toString:'Closed'}]}]},{externalId:'11',key:'OLD-2',summary:'자식'}]}],links:[{name:'sub-task-link',sourceId:'11',destinationId:'10'}]}));
  assert.equal(find(data,'identity:alice').title,'원본 Alice');assert.equal(find(data,'issue:10').createdAt,'P-3D');assert.equal(find(data,'field:named:점수').metadata.fieldType,'float');assert.equal(data.records.filter(item=>item.kind==='comment').length,1);assert.equal(data.records.filter(item=>item.kind==='history').length,1);assert.ok(data.records.some(item=>item.kind==='relation'&&item.title==='sub-task-link'));assert.ok(codes(data).has('JSON_IMPORTERS_DIALECT'));assert.ok(!codes(data).has('JSON_REST_DIALECT'));assert.ok(codes(data).has('DATE_TIMEZONE_UNRESOLVED'));
});

test('Jira history parsing keeps explicit restriction properties and identifies generated fallback IDs', () => {
  const data = parse('rest.json', JSON.stringify({ issues: [{ id: '10', key: 'OLD-1', fields: {
    summary: '업무', comment: { comments: [{ id: '90', body: '내부 Jira 서비스 댓글', visibility: {},
      properties: [{ key: 'sd.public.comment', value: { internal: true } }] }, { body: 'ID 없는 댓글' }] },
    worklog: { worklogs: [{ comment: 'ID 없는 작업 시간', timeSpentSeconds: 80 }] },
  } }] }));
  assert.deepEqual(find(data, 'comment:90').metadata.properties, [{ key: 'sd.public.comment', value: { internal: true } }]);
  assert.equal(find(data, 'comment:json:10:comment:1').metadata.syntheticId, true);
  assert.equal(find(data, 'history:worklog:10:0').metadata.syntheticId, true);
  const xml = parse('entities.xml', '<entity-engine-xml><Issue id="10" summary="업무"/>' +
    '<Action id="91" issue="10" type="comment" grouplevel="private-team" body="팀 제한"/></entity-engine-xml>');
  assert.equal(find(xml, 'comment:91').metadata.grouplevel, 'private-team');
});

test('duplicate source IDs, malformed CSV/JSON/XML and unsupported input cannot silently look successful',()=>{
  assert.throws(()=>parse('entities.xml','<entity-engine-xml><Issue id="1" summary="A"/><Issue id="1" summary="B"/></entity-engine-xml>'));
  assert.throws(()=>parse('bad.csv','Issue key,Summary\nOLD-1,"unterminated'));
  for(const malformed of ['Issue key,Summary\nOLD-1,"a"x','Issue key,Summary\nOLD-1,a"b'])assert.throws(()=>parse('bad.csv',malformed),(error:unknown)=>error instanceof LegacyImportError&&error.status===400);
  assert.throws(()=>parse('bad.json','{"issues":'));
  assert.throws(()=>parse('entities.xml','<!DOCTYPE test [<!ENTITY external SYSTEM "file:///etc/passwd">]><entity-engine-xml/>'));
  const unknown=parse('unknown.json','{"credentials":{"password":"NEVER_COPY"}}');assert.ok(codes(unknown).has('JSON_DIALECT_UNSUPPORTED'));assert.ok(!JSON.stringify(unknown).includes('NEVER_COPY'));const noSource=parseJira(new Map([['readme.txt',Buffer.from('not an export')]]),'synthetic');assert.ok(codes(noSource).has('JIRA_INPUT_NOT_FOUND'));assert.ok(noSource.diagnostics.some(item=>item.severity==='error'));
});

test('Jira attachment analysis distinguishes recovered original IDs from positional fallbacks', () => {
  const bytes = Buffer.from('synthetic Jira attachment');
  const json = JSON.stringify({ issues: [{ id: '10', key: 'OLD-1', fields: { summary: '파일 업무', attachment: [
    { filename: 'recovered.txt', content: 'https://jira.example.test/secure/attachment/70/recovered.txt' },
    { filename: 'position-only.txt', groupLevel: 'limited' },
  ] } }] });
  const data = parse('rest.json', json, new Map([['attachments/OLD/OLD-1/70', bytes]]));
  const stable = find(data, 'attachment:70');
  assert.equal(stable.metadata.syntheticId, undefined);
  assert.equal(stable.metadata.actualSize, bytes.length);
  assert.equal(stable.metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
  const fallback = find(data, 'attachment:json:10:attachment:1');
  assert.equal(fallback.metadata.syntheticId, true);
  assert.equal(fallback.metadata.groupLevel, 'limited');
});

test('multiple REST shard files retain coverage warnings and exact attachment ambiguity remains visible',()=>{
  const first={startAt:0,total:2,issues:[{id:'1',key:'OLD-1',fields:{summary:'첫 번째',attachment:[{id:'99',filename:'same.txt'}]}}]},second={startAt:1,total:2,issues:[{id:'2',key:'OLD-2',fields:{summary:'두 번째'}}]};const data=parseJira(new Map([['page-1.json',Buffer.from(JSON.stringify(first))],['page-2.json',Buffer.from(JSON.stringify(second))],['attachments/A/99',Buffer.from('a')],['attachments/B/99',Buffer.from('b')]]),'synthetic');assert.equal(data.records.filter(item=>item.kind==='issue').length,2);assert.equal(find(data,'attachment:99').metadata.bytesPresent,false);assert.equal(find(data,'attachment:99').metadata.path,null);assert.ok(codes(data).has('ATTACHMENT_PATH_AMBIGUOUS'));assert.ok(codes(data).has('ISSUES_PARTIAL'));assert.ok(codes(data).has('HISTORY_NOT_PROVIDED'));
});
