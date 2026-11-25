import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { User } from '../../shared/types.js';
import { parseJira } from '../../server/legacy-import-jira.js';
import type { MigrationPackage, MigrationPlanningInput } from '../../server/migration-contracts.js';
import { buildMigrationOptions, buildMigrationPlan } from '../../server/migration-planner.js';

const date = '2024-01-01T00:00:00Z';
const actor: User = { id: 'actor', name: 'Test operator', email: 'operator@example.test', color: '#668899' };
const instance = 'synthetic-service-desk';
const attachmentBytes = Buffer.from('proof');
const issue = (id: string, number: number) => `<Issue id="${id}" project="10" number="${number}"
  summary="Synthetic request ${number}" status="1" issuetype="3" created="${date}"/>`;
const comment = (id: string, owner: string, body: string) => `<Action id="${id}" issue="${owner}" type="comment"
  author="synthetic.author" created="${date}" body="${body}"/>`;
const attachment = (id: string, owner: string) => `<FileAttachment id="${id}" issue="${owner}"
  filename="proof.txt" filesize="5" mimetype="text/plain" created="${date}"/>`;
const visibility = (owner: string, internal = true, content = '') => `<EntityProperty id="400" entityName="sd.comment.property"
  propertyKey="sd.public.comment" value="{&quot;internal&quot;:${internal}}" ${owner}>${content}</EntityProperty>`;

function source(id: string, rows: string, attachmentIds: string[] = [], instanceKey = instance): MigrationPackage {
  const xml = Buffer.from(`<entity-engine-xml><Project id="10" pkey="OLD" name="Synthetic desk"/>
    <Status id="1" pname="Open"/><IssueType id="3" pname="Task"/>${rows}</entity-engine-xml>`);
  const files = new Map([['entities.xml', xml], ...attachmentIds.map(id => [`attachments/${id}`, attachmentBytes] as const)]);
  const dataset = parseJira(files, instanceKey);
  return { dataset, summary: { id, filename: `${id}.zip`, sha256: createHash('sha256').update(xml).digest('hex'),
    size: xml.length, version: 1, createdAt: date, actorId: actor.id, source: dataset.source, counts: {},
    errors: dataset.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length,
    warnings: dataset.diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length,
    fileCount: files.size, expandedBytes: xml.length + attachmentIds.length * attachmentBytes.length, applySupported: false } };
}

function request(packages: MigrationPackage[], excludedRecords: string[] = []): MigrationPlanningInput {
  const { containers, identities, defaultConfiguration: configuration } = buildMigrationOptions(packages);
  const instances = [...new Set(packages.map(({ dataset }) => dataset.source.instanceKey))];
  configuration.projects = containers.map(container => {
    const pkg = packages.find(({ summary }) => summary.id === container.packageId)!;
    const group = instances.indexOf(pkg.dataset.source.instanceKey);
    return { containerId: container.id, key: `DESK${group + 1}`, name: `Synthetic desk ${group + 1}` };
  });
  configuration.users = Object.fromEntries(identities.map(identity => [identity.id, actor.id]));
  configuration.excludedRecords = excludedRecords;
  const fileInfo = Object.fromEntries(packages.map(({ summary, dataset }) => [summary.id, Object.fromEntries(dataset.records.flatMap(row => {
    const { path, actualSize, sha256 } = row.metadata;
    return typeof path === 'string' && typeof sha256 === 'string' && typeof actualSize === 'number'
      ? [[path, { size: actualSize, sha256, mimeType: 'text/plain' }]] : [];
  }))]));
  return { id: 'synthetic-migration', configuration, actorId: actor.id, users: [actor], existingProjectKeys: [], packages, now: date, fileInfo };
}

test('missing or malformed JSM owners block publication even if the raw row is excluded', () => {
  for (const [owner, content, rawValues] of [['', '', []], ['entityId="98765 "', '', ['98765 ']],
    ['entityId="98765"', '<entityId>unscoped-owner</entityId>', ['98765', 'unscoped-owner']],
    ['', '<entityId><id>98765</id></entityId>', ['98765']]] as const) {
    const pkg = source('malformed', `${issue('100', 1)}${comment('98765', '100', 'Synthetic private note')}${visibility(owner, true, content)}`);
    const raw = pkg.dataset.records.find(row => row.metadata.jiraServiceDeskCommentProperty === true);
    assert.ok(raw);
    assert.deepEqual(raw.metadata.jiraServiceDeskCommentPropertySource, {
      id: ['400'], entityName: ['sd.comment.property'], entityId: rawValues,
      propertyKey: ['sd.public.comment'], value: ['{"internal":true}'],
    });
    const diagnostic = pkg.dataset.diagnostics.find(row => row.code === 'JIRA_SERVICE_DESK_COMMENT_OWNER_UNVERIFIED');
    assert.equal(diagnostic?.severity, 'error');
    assert.equal(diagnostic.recordId, null);
    assert.doesNotMatch(JSON.stringify(pkg.dataset.diagnostics), /98765|unscoped-owner|Synthetic private note/);
    for (const excluded of [[], [`malformed/${raw.id}`]]) {
      const plan = buildMigrationPlan(request([pkg], excluded));
      assert.equal(plan.preview.canApply, false);
      assert.deepEqual(plan.comments, []);
      assert.ok(plan.preview.notices.some(notice => notice.code === 'SOURCE_JIRA_SERVICE_DESK_COMMENT_OWNER_UNVERIFIED' &&
        notice.severity === 'error' && notice.recordId === null));
      assert.equal(plan.sourceRecords.find(row => row.record.id === raw.id)?.targetId, null);
    }
  }
});

test('a JSM property in another selected package protects its comment and named files only in the same Jira issue and instance', () => {
  const content = source('content', `${issue('100', 1)}${issue('101', 2)}${comment('200', '100', 'Synthetic private note [^proof.txt]')}
    ${comment('201', '100', 'Public note')}${attachment('300', '100')}${attachment('301', '101')}`, ['300', '301']);
  const evidence = source('evidence', `${issue('102', 3)}${visibility('entityId="200"')}${visibility('entityId="201"', false)}`);
  const other = source('other', `${issue('100', 1)}${comment('200', '100', 'Other instance note [^proof.txt]')}${attachment('300', '100')}`,
    ['300'], 'other-synthetic-desk');
  const raw = evidence.dataset.records.find(row => row.references.some(ref => ref.kind === 'comment' && ref.sourceId === '200'));
  assert.ok(raw);
  const restricted = ['content/comment:200', 'content/attachment:300'];
  for (const excluded of [[], [`evidence/${raw.id}`], ['content/comment:200', `evidence/${raw.id}`]]) {
    const blocked = buildMigrationPlan(request([content, evidence, other], excluded));
    assert.equal(blocked.preview.canApply, false);
    assert.deepEqual(blocked.preview.notices.filter(row => row.code === 'RESTRICTED_CONTENT').map(row => row.recordId),
      restricted.filter(id => !excluded.includes(id)));
  }
  const plan = buildMigrationPlan(request([content, evidence, other], restricted));
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.deepEqual(plan.comments.map(row => row.body).sort(), ['Other instance note proof.txt', 'Public note']);
  const archive = (pkg: MigrationPackage, recordId: string) =>
    plan.sourceRecords.find(row => row.packageSha256 === pkg.summary.sha256 && row.record.id === recordId);
  assert.equal(archive(content, 'comment:200')?.targetId, null);
  assert.equal(archive(content, 'attachment:300')?.targetId, null);
  assert.ok(archive(content, 'attachment:301')?.targetId);
  assert.ok(archive(other, 'attachment:300')?.targetId);
  assert.equal(archive(evidence, raw.id)?.targetId, null);
});

test('a canonical JSM orphan outside the selected packages leaves a redacted warning and unrelated content eligible', () => {
  const pkg = source('orphan', `${issue('100', 1)}${comment('200', '100', 'Unrelated note')}${visibility('entityId="98765"')}`);
  const plan = buildMigrationPlan(request([pkg]));
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.deepEqual(plan.comments.map(row => row.body), ['Unrelated note']);
  const warning = plan.preview.notices.find(row => row.code === 'SOURCE_JIRA_SERVICE_DESK_COMMENT_PROPERTY_UNVERIFIED');
  assert.equal(warning?.severity, 'warning');
  assert.equal(warning.recordId, null);
  assert.doesNotMatch(JSON.stringify(pkg.dataset.diagnostics), /98765/);
  assert.doesNotMatch(JSON.stringify(plan.preview.notices), /98765/);
});

test('contradictory canonical JSM candidates are held within their known set', () => {
  const content = source('content', `${issue('100', 1)}${comment('200', '100', 'First candidate')}
    ${comment('201', '100', 'Second candidate')}${comment('202', '100', 'Unrelated note')}`);
  const evidence = source('evidence', `${issue('101', 2)}${visibility('entityId="200"', true, '<entityId>201</entityId>')}`);
  const restricted = ['content/comment:200', 'content/comment:201'];
  const blocked = buildMigrationPlan(request([content, evidence]));
  assert.equal(blocked.preview.canApply, false);
  assert.deepEqual(blocked.preview.notices.filter(row => row.code === 'RESTRICTED_CONTENT').map(row => row.recordId), restricted);
  const plan = buildMigrationPlan(request([content, evidence], restricted));
  assert.equal(plan.preview.canApply, true, JSON.stringify(plan.preview.notices));
  assert.deepEqual(plan.comments.map(row => row.body), ['Unrelated note']);
});
