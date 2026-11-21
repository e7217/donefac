import type { Express, Request } from 'express';
import { CONFLUENCE_MIGRATION_DOCUMENT_FIELDS, JIRA_MIGRATION_ISSUE_FIELDS, type Attachment, type AttachmentVersion, type Comment, type DocPage, type DocRevision, type Issue, type IssueRelation, type JiraMigrationCustomFieldHashes, type LegacyRecord, type LegacyRecordKind, type LegacySource, type MigrationAppendConfiguration, type MigrationConfiguration, type MigrationNotice, type Project, type SourceImport, type SourceImportIntegrity, type SourceImportIntegrityPackage, type SourceRecordArchive, type SourceRecordPage, type SourceRecordSummary, type User } from '../shared/types.js';
import { isCanonicalTeamspaceIssueRelation } from '../shared/issue-relations.js';
import { addRecord, emptyDataset, LEGACY_MAX_RECORDS } from './legacy-import-model.js';
import { attachmentId, MAX_FILE_BYTES, safeFilename } from './attachments.js';
import type { PreparedMigration } from './migration-contracts.js';
import { jiraIssueStatusHistory } from './jira-status-history.js';
import { isRestrictedJiraAttachment, isRestrictedJiraHistory, isRestrictedJiraHistoryOwner, isRestrictedJiraStatusHistory, jiraAttachmentFileEvidence, jiraAttachmentOwnerAliases, jiraAttachmentSourceId, jiraHistoryOwnerAliases, jiraHistorySourceKey } from './migration-jira-history.js';
import { jiraIssueRelationSource, jiraRelationEndpoints } from './migration-jira-relations.js';
import { measureIncomingArchive, SourceArchiveMeasurer, type SourceArchiveMeasurement } from './source-archive-integrity.js';
import type { Store } from './store.js';

export class SourcePreservationError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }
export interface SourcePreservationData { imports: SourceImport[]; records: SourceRecordArchive[]; versions: AttachmentVersion[]; relations: IssueRelation[] }
export interface SourcePreservationContext { users: User[]; projects: Project[]; issues: Issue[]; documents: DocPage[]; comments: Comment[]; revisions: DocRevision[]; attachments: Attachment[] }
const kinds: LegacyRecordKind[] = ['identity', 'project', 'issue', 'page', 'comment', 'revision', 'history', 'attachment', 'relation', 'field', 'option', 'workflow'];
export function isLegacyRecordKind(value: unknown): value is LegacyRecordKind {
  return typeof value === 'string' && kinds.includes(value as LegacyRecordKind);
}
function fail(status: number, message: string): never { throw new SourcePreservationError(status, message); }
function sourceRecordWindow(query: Record<string, unknown>): { offset: number; limit: number } {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = query[name];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      fail(400, '원본 기록 페이지 범위를 확인해 주세요.');
    }
    return Number(value);
  };
  return { offset: integer('offset', 0, 0, 1_000_000), limit: integer('limit', 50, 1, 100) };
}
function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(400, `${label}은 JSON 객체여야 합니다.`); return value as Record<string, unknown>; }
function list(value: unknown, label: string, max = 1000000): unknown[] { if (!Array.isArray(value) || value.length > max) fail(400, `${label} 목록을 확인해 주세요.`); return value; }
function string(value: unknown, label: string, max = 500): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, `${label} 식별자·문자열을 확인해 주세요.`); return value; }
function nullable(value: unknown, label: string, max = 500): string | null { return value === null ? null : string(value, label, max); }
function positive(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) fail(400, '양의 정수 버전이 필요합니다.'); return Number(value); }
function timestamp(value: unknown): string { const text = string(value, '기록 시각', 100); if (!Number.isFinite(Date.parse(text))) fail(400, '기록 시각을 확인해 주세요.'); return text; }
function sha(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(400, '원본 SHA-256을 확인해 주세요.'); return value; }
function uuid(value: unknown): string { try { return attachmentId(value); } catch { return fail(400, '원본 보관·파일 버전 UUID를 확인해 주세요.'); } }
function unique<T extends { id: string }>(values: T[], label: string): Map<string, T> { const map = new Map<string, T>(); for (const value of values) { if (map.has(value.id)) fail(400, `${label} ID가 중복되었습니다.`); map.set(value.id, value); } return map; }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${stable(value)}`).join(',')}}`; return JSON.stringify(value) ?? 'null'; }
function legacySource(raw: unknown): LegacySource {
  const value = object(raw, '원본 출처'), product = value.product, format = value.format;
  if (product !== 'jira' && product !== 'confluence' || typeof format !== 'string' || !(product === 'jira' ? ['jira-backup-xml', 'jira-search-xml', 'jira-csv', 'jira-json'] : ['confluence-xml']).includes(format)) fail(400, '원본 도구·내보내기 형식이 일치하지 않습니다.');
  return { product, format: format as LegacySource['format'], instanceKey: string(value.instanceKey, '원본 인스턴스', 200), declaredVersion: nullable(value.declaredVersion, '원본 버전', 100), timezone: nullable(value.timezone, '원본 시간대', 100) };
}
function mapping<T>(raw: unknown, convert: (value: unknown) => T): Record<string, T> {
  const entries = Object.entries(object(raw, '이관 매핑'));
  if (entries.length > 100000) fail(400, '이관 매핑 개수가 너무 많습니다.');
  return Object.fromEntries(entries.map(([key, value]) => {
    string(key, '매핑 ID', 1200);
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(400, '이관 매핑 키를 확인해 주세요.');
    return [key, convert(value)];
  }));
}
export function parseMigrationAppendConfiguration(raw: unknown): MigrationAppendConfiguration {
  const append = object(raw, '기존 프로젝트 추가 설정');
  const refresh = Object.hasOwn(append, 'refreshExisting');
  const custom = Object.hasOwn(append, 'refreshCustomFields');
  const history = Object.hasOwn(append, 'refreshHistory');
  const attachments = Object.hasOwn(append, 'refreshAttachments');
  const relations = Object.hasOwn(append, 'refreshRelations');
  if (Object.keys(append).length !== 4 + Number(refresh) + Number(custom) + Number(history) + Number(attachments) + Number(relations) ||
      (refresh && append.refreshExisting !== true) || (custom && append.refreshCustomFields !== true) ||
      (history && append.refreshHistory !== true) || (attachments && append.refreshAttachments !== true) || (relations && append.refreshRelations !== true)) {
    fail(400, '기존 프로젝트 추가 설정 형식을 확인해 주세요.');
  }
  return {
    projectId: string(append.projectId, '추가 대상 프로젝트', 200),
    statuses: mapping(append.statuses, value => string(value, '추가 대상 상태', 200)),
    issueTypes: mapping(append.issueTypes, value => string(value, '추가 대상 업무 유형', 200)),
    fields: mapping(append.fields, value => nullable(value, '추가 대상 필드', 200)),
    ...(refresh ? { refreshExisting: true } : {}),
    ...(custom ? { refreshCustomFields: true } : {}),
    ...(history ? { refreshHistory: true } : {}),
    ...(attachments ? { refreshAttachments: true } : {}),
    ...(relations ? { refreshRelations: true } : {}),
  };
}
export function parseMigrationPageAppendConfiguration(raw: unknown): NonNullable<MigrationConfiguration['appendPagesTo']> {
  const append = object(raw, '기존 프로젝트 문서 추가 설정');
  const refresh = Object.hasOwn(append, 'refreshExisting');
  const attachments = Object.hasOwn(append, 'refreshAttachments');
  const history = Object.hasOwn(append, 'refreshHistory');
  if (Object.keys(append).length !== 1 + Number(refresh) + Number(attachments) + Number(history) ||
      (refresh && append.refreshExisting !== true) || (attachments && append.refreshAttachments !== true) ||
      (history && append.refreshHistory !== true)) {
    fail(400, '기존 프로젝트 문서 추가 설정 형식을 확인해 주세요.');
  }
  return { projectId: string(append.projectId, '문서를 추가할 프로젝트', 200), ...(refresh ? { refreshExisting: true } : {}),
    ...(attachments ? { refreshAttachments: true } : {}), ...(history ? { refreshHistory: true } : {}) };
}
export function parseJiraPlanSelections(raw: unknown, packageIds: readonly string[], label: '릴리스' | '스프린트'): Record<string, string | null> {
  const entries = Object.entries(object(raw, `Jira ${label} 매핑`));
  if (entries.length > 10_000) fail(400, `Jira ${label} 선택은 10,000개까지 보관할 수 있습니다.`);
  const packages = new Set(packageIds);
  return Object.fromEntries(entries.map(([key, value]) => {
    const recordId = string(key, `Jira ${label} 매핑 업무`, 1200);
    const boundary = recordId.indexOf('/');
    const recordKind = '/issue:';
    if (boundary < 1 || !packages.has(recordId.slice(0, boundary)) || !recordId.startsWith(recordKind, boundary) ||
        !recordId.slice(boundary + recordKind.length).trim()) {
      fail(400, `선택한 패키지의 Jira 업무에 ${label} 항목을 지정해 주세요.`);
    }
    return [recordId, nullable(value, `Jira 원본 ${label} ID`)];
  }));
}
function configuration(raw: unknown, users: Set<string>): MigrationConfiguration {
  const value = object(raw, '이관 설정');
  const packageIds = list(value.packageIds, '설정 패키지', 20).map(id => string(id, '패키지 ID', 200)); if (new Set(packageIds).size !== packageIds.length) fail(400, '설정 패키지가 중복되었습니다.');
  const projects = list(value.projects, '설정 프로젝트', 100).map(raw => { const item = object(raw, '설정 프로젝트'); const key = string(item.key, '프로젝트 키', 12); if (!/^[A-Z][A-Z0-9]{1,11}$/.test(key)) fail(400, '원본 이관 프로젝트 키를 확인해 주세요.'); return { containerId: string(item.containerId, '원본 컨테이너', 500), key, name: string(item.name, '프로젝트 이름', 300) }; });
  if (new Set(projects.map(value => value.containerId)).size !== projects.length) fail(400, '이관 설정 원본 컨테이너가 중복되었습니다.');
  const projectNames = new Map<string, string>(); for (const project of projects) { if (projectNames.has(project.key) && projectNames.get(project.key) !== project.name) fail(400, '같은 신규 프로젝트 키는 같은 이름으로 매핑해야 합니다.'); projectNames.set(project.key, project.name); }
  const mappedUsers = mapping(value.users, value => { const id = nullable(value, '매핑 사용자', 200); if (id && !users.has(id)) fail(400, '이관 설정의 현재 사용자를 찾을 수 없습니다.'); return id; });
  const statuses = mapping(value.statuses, value => { if (typeof value !== 'string' || !['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'].includes(value)) fail(400, '원본 상태 매핑을 확인해 주세요.'); return value as MigrationConfiguration['statuses'][string]; });
  const issueTypes = mapping(value.issueTypes, value => nullable(value, '업무 유형', 200));
  const fields = mapping(value.fields, value => { if (typeof value !== 'string' || !['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'user', 'url', 'archive'].includes(value)) fail(400, '원본 필드 매핑을 확인해 주세요.'); return value as MigrationConfiguration['fields'][string]; });
  const sourceBaseUrls = mapping(value.sourceBaseUrls, value => { if (value === null) return null; const text = string(value, '원본 기준 주소', 4000); try { const url = new URL(text); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); } catch { fail(400, '원본 기준 주소에는 http(s) 주소만 사용할 수 있습니다.'); } return text; });
  const timezone = string(value.timezone, '해석 시간대', 100); try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); } catch { fail(400, '이관 해석 시간대를 확인해 주세요.'); }
  if (value.datePolicy !== 'block' && value.datePolicy !== 'import-time') fail(400, '날짜 해석 정책을 확인해 주세요.');
  const excludedRecords = list(value.excludedRecords, '제외 원본', 100000).map(value => string(value, '제외 원본', 1200)); if (new Set(excludedRecords).size !== excludedRecords.length) fail(400, '제외 원본이 중복되었습니다.');
  const appendTo = Object.hasOwn(value, 'appendTo') ? parseMigrationAppendConfiguration(value.appendTo) : undefined;
  const appendPagesTo = Object.hasOwn(value, 'appendPagesTo') ? parseMigrationPageAppendConfiguration(value.appendPagesTo) : undefined;
  const jiraReleaseSelections = Object.hasOwn(value, 'jiraReleaseSelections') ? parseJiraPlanSelections(value.jiraReleaseSelections, packageIds, '릴리스') : undefined;
  const jiraSprintSelections = Object.hasOwn(value, 'jiraSprintSelections') ? parseJiraPlanSelections(value.jiraSprintSelections, packageIds, '스프린트') : undefined;
  if (appendTo && appendPagesTo) fail(400, '기존 프로젝트에 추가할 원본 도구를 하나 선택해 주세요.');
  return { packageIds, projects, users: mappedUsers, statuses, issueTypes, fields, sourceBaseUrls, timezone, datePolicy: value.datePolicy,
    excludedRecords, ...(appendTo ? { appendTo } : {}), ...(appendPagesTo ? { appendPagesTo } : {}),
    ...(jiraReleaseSelections ? { jiraReleaseSelections } : {}), ...(jiraSprintSelections ? { jiraSprintSelections } : {}) };
}

const jiraIssueFields = new Set(JIRA_MIGRATION_ISSUE_FIELDS);
const confluencePageFields = new Set(CONFLUENCE_MIGRATION_DOCUMENT_FIELDS);
function parseFieldHashes<Field extends string>(raw: unknown, fields: ReadonlySet<Field>, label: string): Partial<Record<Field, string>> {
  const hashes: Partial<Record<Field, string>> = {};
  for (const [field, value] of Object.entries(object(raw, label))) {
    const name = field as Field;
    if (!fields.has(name)) fail(400, `${label}에 지원하지 않는 필드가 있습니다.`);
    hashes[name] = sha(value);
  }
  return hashes;
}

function parseJiraCustomFieldHashes(raw: unknown): JiraMigrationCustomFieldHashes {
  const entries = Object.entries(object(raw, 'Jira 사용자 정의 필드 기준'));
  if (!entries.length || entries.length > 100) fail(400, 'Jira 사용자 정의 필드 기준의 개수를 확인해 주세요.');
  return Object.fromEntries(entries.map(([fieldId, item]) => {
    const checkpoint = object(item, 'Jira 사용자 정의 필드 기준');
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(fieldId) || ['constructor', 'prototype'].includes(fieldId) ||
        Object.keys(checkpoint).length !== 2) fail(400, 'Jira 사용자 정의 필드 기준의 형식을 확인해 주세요.');
    return [fieldId, { sourceFieldId: string(checkpoint.sourceFieldId, 'Jira 원본 필드', 500), hash: sha(checkpoint.hash) }];
  }));
}

function parseIntegrity(raw: unknown, packages: SourceImport['packages']): SourceImportIntegrity | undefined {
  if (raw === undefined) return;
  const value = object(raw, '보존 원본 무결성 기준');
  if (value.version !== 1 || Object.keys(value).length !== 2) fail(400, '보존 원본 무결성 기준 형식을 확인해 주세요.');
  const entries = list(value.packages, '보존 원본 무결성 패키지', 20);
  const stagingIds = new Set(packages.map(item => item.stagingId));
  const byStagingId = new Map<string, SourceImportIntegrityPackage>();
  for (const raw of entries) {
    const item = object(raw, '보존 원본 무결성 패키지');
    const { stagingId, recordCount, boundAttachmentCount } = item;
    if (Object.keys(item).length !== 4 || typeof stagingId !== 'string' || !stagingIds.has(stagingId) || byStagingId.has(stagingId) ||
        typeof recordCount !== 'number' || !Number.isSafeInteger(recordCount) || recordCount < 0 || recordCount > LEGACY_MAX_RECORDS ||
        typeof boundAttachmentCount !== 'number' || !Number.isSafeInteger(boundAttachmentCount) || boundAttachmentCount < 0 || boundAttachmentCount > recordCount) {
      fail(400, '보존 원본 무결성 패키지 ID와 수량을 확인해 주세요.');
    }
    byStagingId.set(stagingId, { stagingId, recordCount, boundAttachmentCount, recordsSha256: sha(item.recordsSha256) });
  }
  if (byStagingId.size !== packages.length) fail(400, '보존 원본 무결성 패키지가 영수증과 일치하지 않습니다.');
  return { version: 1, packages: packages.map(item => byStagingId.get(item.stagingId)!) };
}

function archiveTotals(packages: SourceImportIntegrityPackage[]) {
  return packages.reduce((totals, item) => ({
    sourceRecords: totals.sourceRecords + item.recordCount,
    attachmentVersions: totals.attachmentVersions + item.boundAttachmentCount,
  }), { sourceRecords: 0, attachmentVersions: 0 });
}

function validateArchiveManifests(imports: SourceImport[], records: SourceRecordArchive[], status = 400): void {
  const byImport = new Map(imports.filter(receipt => receipt.integrity).map(receipt => [receipt.id, [] as SourceRecordArchive[]]));
  if (!byImport.size) return;
  for (const record of records) byImport.get(record.sourceImportId)?.push(record);
  for (const receipt of imports) {
    if (!receipt.integrity) continue;
    const measured = measureIncomingArchive(receipt, byImport.get(receipt.id)!);
    const totals = archiveTotals(measured.packages);
    const expected = receipt.integrity.packages;
    if (measured.unmatchedRecords || expected.length !== measured.packages.length ||
        measured.packages.some((item, index) => {
          const previous = expected[index];
          return item.stagingId !== previous.stagingId || item.recordCount !== previous.recordCount ||
            item.boundAttachmentCount !== previous.boundAttachmentCount || item.recordsSha256 !== previous.recordsSha256;
        }) ||
        receipt.counts.sourceRecords !== totals.sourceRecords || receipt.counts.attachmentVersions !== totals.attachmentVersions) {
      fail(status, '보존 원본이 이관 영수증의 무결성 기준과 일치하지 않습니다.');
    }
  }
}

function parseImport(raw: unknown, users: Set<string>): SourceImport {
  const value = object(raw, '이관 영수증'), actorId = string(value.actorId, '이관 작업자', 200); if (!users.has(actorId)) fail(400, '이관 작업자가 현재 사용자 목록에 없습니다.');
  const projectIds = list(value.projectIds, '이관 프로젝트', 100).map(value => string(value, '이관 프로젝트', 200)); if (new Set(projectIds).size !== projectIds.length) fail(400, '이관 프로젝트가 중복되었습니다.');
  const packages = list(value.packages, '원본 패키지', 20).map(raw => { const item = object(raw, '원본 패키지'); let filename: string; try { filename = safeFilename(item.filename); } catch { return fail(400, '원본 패키지 파일명을 확인해 주세요.'); } return { stagingId: string(item.stagingId, '분석 패키지 ID', 200), filename, sha256: sha(item.sha256), source: legacySource(item.source) }; });
  if (!packages.length || new Set(packages.map(value => value.stagingId)).size !== packages.length || new Set(packages.map(value => stable([value.source.product, value.source.instanceKey, value.sha256]))).size !== packages.length) fail(400, '원본 패키지 출처가 중복되거나 비었습니다.');
  const config = configuration(value.configuration, users); if (config.packageIds.length !== packages.length || packages.some(value => !config.packageIds.includes(value.stagingId))) fail(400, '이관 설정과 원본 패키지 목록이 다릅니다.');
  if (config.appendTo && (projectIds.length !== 1 || projectIds[0] !== config.appendTo.projectId ||
      packages.some(pkg => pkg.source.product !== 'jira' || pkg.source.instanceKey !== packages[0].source.instanceKey))) {
    fail(400, '추가 이관 영수증의 대상 프로젝트와 Jira 원본 인스턴스를 확인해 주세요.');
  }
  if (config.appendPagesTo && (projectIds.length !== 1 || projectIds[0] !== config.appendPagesTo.projectId ||
      packages.some(pkg => pkg.source.product !== 'confluence' || pkg.source.instanceKey !== packages[0].source.instanceKey))) {
    fail(400, '문서 추가 이관 영수증의 대상 프로젝트와 Confluence 원본 인스턴스를 확인해 주세요.');
  }
  const rawCounts = object(value.counts, '이관 수량'), counts: Record<string, number> = {}; if (Object.keys(rawCounts).length > 100) fail(400, '이관 수량 종류가 너무 많습니다.');
  for (const [key, count] of Object.entries(rawCounts)) { string(key, '수량 종류', 100); if (['__proto__', 'prototype', 'constructor'].includes(key) || !Number.isSafeInteger(count) || Number(count) < 0) fail(400, '이관 수량을 확인해 주세요.'); counts[key] = Number(count); }
  const notices = value.notices === undefined ? undefined : list(value.notices, '검토한 이관 안내', 10000).map(raw => {
    const item = object(raw, '검토한 이관 안내'); if (item.severity !== 'warning' && item.severity !== 'info' || typeof item.requiresAcknowledgement !== 'boolean') fail(400, '완료된 이관에는 오류 진단을 포함할 수 없습니다.');
    if (typeof item.message !== 'string' || !item.message.trim() || item.message.length > 2000) fail(400, '이관 안내 메시지를 확인해 주세요.');
    return { severity: item.severity, code: string(item.code, '이관 안내 코드', 100), message: item.message, recordId: nullable(item.recordId, '이관 안내 원본', 1200), requiresAcknowledgement: item.requiresAcknowledgement } as MigrationNotice;
  });
  const integrity = parseIntegrity(value.integrity, packages);
  return { id: string(value.id, '이관 ID', 200), version: positive(value.version), createdAt: timestamp(value.createdAt), actorId, projectIds, configuration: config, packages, counts, ...(notices ? { notices } : {}), ...(integrity ? { integrity } : {}) };
}
const baseAttachment = (value: Attachment): Attachment => ({ id: value.id, resourceType: value.resourceType, resourceId: value.resourceId, filename: value.filename, mimeType: value.mimeType, size: value.size, sha256: value.sha256, authorId: value.authorId, createdAt: value.createdAt });
type ConfluenceArchiveKind = 'attachment' | 'page' | 'revision' | 'comment';
export function confluenceHistoryVersion(value: unknown): number | null {
  const version = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

export function confluenceHistoryPage(record: LegacyRecord,
  lookup: (kind: 'comment' | 'revision', sourceId: string) => LegacyRecord | undefined): string | null {
  const pending = [{ row: record, exiting: false }];
  const visiting = new Set<string>();
  const checked = new Set<string>();
  let page: string | null = null;
  while (pending.length) {
    const { row, exiting } = pending.pop()!;
    const key = stable([row.kind, row.sourceId]);
    if (exiting) {
      visiting.delete(key);
      checked.add(key);
      continue;
    }
    if (checked.has(key)) continue;
    if (visiting.has(key) || row.metadata.restricted === true || row.metadata.orphan === true || row.metadata.bodyVariant === true) return null;
    let owners: LegacyRecord['references'];
    if (row.kind === 'comment' && row.metadata.sourceClass === 'Comment') {
      if (row.metadata.currentVersionId || row.metadata.contentStatus === 'historical' ||
          row.metadata.originalVersionId && row.metadata.originalVersionId !== row.sourceId ||
          row.references.some(ref => ['current-version', 'original-version'].includes(ref.relation) && ref.sourceId !== row.sourceId)) return null;
      owners = row.references.filter(ref => ref.relation === 'container-content');
      if (owners.length !== 1 || owners[0].sourceId !== row.containerId) return null;
    } else if (row.kind === 'revision' && ['Page', 'BlogPost'].includes(String(row.metadata.sourceClass))) {
      owners = row.references.filter(ref => ref.relation === 'current-version' || ref.relation === 'original-version' && ref.sourceId !== row.sourceId);
      if (!owners.length || owners.some(ref => ref.kind !== 'revision' && ref.kind !== 'page') ||
          row.metadata.currentVersionId && !owners.some(ref => ref.relation === 'current-version' && ref.sourceId === row.metadata.currentVersionId) ||
          row.metadata.originalVersionId && row.metadata.originalVersionId !== row.sourceId &&
            !owners.some(ref => ref.relation === 'original-version' && ref.sourceId === row.metadata.originalVersionId)) return null;
    } else return null;
    visiting.add(key);
    pending.push({ row, exiting: true });
    for (const owner of owners) {
      if (owner.kind === 'page') {
        if (page !== null && page !== owner.sourceId) return null;
        page = owner.sourceId;
        continue;
      }
      if (owner.kind !== 'comment' && owner.kind !== 'revision') return null;
      const target = lookup(owner.kind, owner.sourceId);
      if (!target || target.kind !== owner.kind || target.sourceId !== owner.sourceId ||
          row.kind === 'revision' && target.metadata.sourceClass !== row.metadata.sourceClass) return null;
      pending.push({ row: target, exiting: false });
    }
  }
  return page;
}
export function confluenceAttachmentOrigin(record: LegacyRecord, lookup: (kind: ConfluenceArchiveKind, id: string) => LegacyRecord | undefined) {
  const pageOf = (candidate: LegacyRecord): string | null => {
    if (candidate.kind !== 'attachment' || candidate.metadata.restricted === true || !candidate.containerId) return null;
    const owners = candidate.references.filter(reference => reference.relation === 'container-content');
    if (owners.length !== 1 || owners[0].sourceId !== candidate.containerId) return null;
    let owner = owners[0];
    const visited = new Set<string>();
    while (owner.kind === 'revision') {
      if (visited.has(owner.sourceId)) return null;
      visited.add(owner.sourceId);
      const revision = lookup('revision', owner.sourceId);
      if (!revision || revision.metadata.restricted === true) return null;
      const targets = revision.references.filter(reference => reference.relation === 'current-version');
      if (targets.length !== 1 || targets[0].sourceId !== revision.metadata.currentVersionId) return null;
      owner = targets[0];
    }
    return owner.kind === 'page' ? owner.sourceId : null;
  };
  const pageId = pageOf(record);
  if (!pageId) return null;
  const visited = new Set<string>();
  let rootId = record.sourceId;
  let current: LegacyRecord | undefined = record;
  while (current) {
    if (visited.has(rootId) || pageOf(current) !== pageId) return null;
    visited.add(rootId);
    const next = current.metadata.currentVersionId;
    if (typeof next !== 'string' || !next) break;
    rootId = next;
    current = lookup('attachment', next);
  }
  const version = record.metadata.attachmentVersion ?? record.metadata.version;
  const revision = typeof version === 'number' || typeof version === 'string' && /^\d+$/.test(version) ? Number(version) : NaN;
  return { sourcePageId: pageId, sourceRootId: rootId, sourceRevision: Number.isSafeInteger(revision) && revision > 0 ? revision : null };
}
function confluenceArchiveKey(record: SourceRecordArchive, kind = record.record.kind, sourceId = record.record.sourceId): string {
  return stable([record.sourceImportId, record.packageSha256, record.source.instanceKey, kind, sourceId]);
}
interface EarlierAttachments { versions: AttachmentVersion[]; records: SourceRecordArchive[] }
interface AppliedConfluenceHistory { owners: Set<string>; commentIds: Set<string>; revisionIds: Set<string> }
interface AppliedJiraChildren {
  historyOwners: Set<string>;
  attachmentOwners: Set<string>;
  comments: Map<string, string>;
  worklogs: Map<string, string>;
  attachments: Map<string, string>;
}
interface JiraIssueOrigin { alias: string; issueId: string; projectId: string; sourceProjectId: string; archiveId: string }
interface JiraHistoryArchive { kind: 'comment' | 'worklog'; sourceId: string; issueId: string; archiveId: string }
interface JiraAttachmentArchive { sourceId: string; issueId: string; archiveId: string }
function jiraIssueAliases(record: LegacyRecord): string[] {
  const key = record.metadata.key;
  return typeof key === 'string' && key !== record.sourceId ? [record.sourceId, key] : [record.sourceId];
}
type Binding = { product: string; instance: string; kind: string; alias: string; type: string; id: string; importId: string };
interface ArchiveSqlRow {
  id: string;
  importId: string;
  ownerType: string | null;
  ownerId: string | null;
  targetType: string | null;
  targetId: string | null;
  kind: string;
  instanceKey: string;
  product: string;
  sourceId: string;
  json: string;
}

function archiveMatchesColumns(record: SourceRecordArchive, row: ArchiveSqlRow): boolean {
  return record.id === row.id && record.sourceImportId === row.importId && record.ownerType === row.ownerType &&
    record.ownerId === row.ownerId && record.targetType === row.targetType && record.targetId === row.targetId &&
    record.record?.kind === row.kind && record.record?.sourceId === row.sourceId &&
    record.source?.instanceKey === row.instanceKey && record.source?.product === row.product;
}

function archiveReceiptMetadata(receipt: SourceImport): SourceImport {
  const metadata = { ...receipt, version: 0 };
  delete metadata.integrity;
  return metadata;
}

export class SourcePreservationService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS source_imports(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_records(id TEXT PRIMARY KEY,import_id TEXT NOT NULL REFERENCES source_imports(id) ON DELETE CASCADE,owner_type TEXT,owner_id TEXT,target_type TEXT,target_id TEXT,kind TEXT NOT NULL,source_instance TEXT NOT NULL,product TEXT NOT NULL,source_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS source_records_import ON source_records(import_id,kind);
      CREATE INDEX IF NOT EXISTS source_records_archive_measurement ON source_records(import_id,id);
      CREATE INDEX IF NOT EXISTS source_records_owner ON source_records(owner_type,owner_id,kind);
      CREATE INDEX IF NOT EXISTS source_records_target ON source_records(target_type,target_id);
      CREATE INDEX IF NOT EXISTS source_records_author ON source_records(import_id,product,source_instance,kind,source_id);
      CREATE INDEX IF NOT EXISTS source_records_confluence_history
        ON source_records(source_instance,kind,source_id) WHERE product='confluence';
      CREATE INDEX IF NOT EXISTS source_records_jira_history
        ON source_records(source_instance,kind,source_id) WHERE product='jira';
      CREATE INDEX IF NOT EXISTS source_records_jira_unowned_change_owner
        ON source_records(source_instance,json_extract(json,'$.record.containerId'))
        WHERE product='jira' AND kind='history' AND owner_type IS NULL AND owner_id IS NULL;
      CREATE TABLE IF NOT EXISTS attachment_versions(id TEXT PRIMARY KEY,attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachment_versions_attachment ON attachment_versions(attachment_id);
      CREATE UNIQUE INDEX IF NOT EXISTS attachment_versions_local_revision
        ON attachment_versions(attachment_id,json_extract(json,'$.localRevision')) WHERE json_type(json,'$.localRevision')='integer';
      CREATE UNIQUE INDEX IF NOT EXISTS attachment_versions_source_revision
        ON attachment_versions(attachment_id,json_extract(json,'$.sourceRevision')) WHERE json_type(json,'$.sourceRevision')='integer';
      CREATE TABLE IF NOT EXISTS issue_relations(id TEXT PRIMARY KEY,source_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,target_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS issue_relations_source ON issue_relations(source_issue_id);
      CREATE INDEX IF NOT EXISTS issue_relations_target ON issue_relations(target_issue_id);
      CREATE UNIQUE INDEX IF NOT EXISTS issue_relations_teamspace_pair
        ON issue_relations(source_issue_id,target_issue_id,json_extract(json,'$.type')) WHERE json_extract(json,'$.origin')='teamspace';
      CREATE TABLE IF NOT EXISTS source_bindings(product TEXT NOT NULL,source_instance TEXT NOT NULL,kind TEXT NOT NULL,source_alias TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT NOT NULL,import_id TEXT NOT NULL REFERENCES source_imports(id) ON DELETE CASCADE,PRIMARY KEY(product,source_instance,kind,source_alias));
      CREATE INDEX IF NOT EXISTS source_bindings_target ON source_bindings(target_type,target_id,product,kind);`);
    store.db.function('is_restricted_jira_status_history', { deterministic: true }, json => {
      const archive = JSON.parse(String(json)) as SourceRecordArchive;
      return Number(isRestrictedJiraStatusHistory(archive.record));
    });
  }
  allImports(): SourceImport[] { return this.store.all<SourceImport>('source_imports'); }
  allRecords(): SourceRecordArchive[] { return this.store.all<SourceRecordArchive>('source_records'); }
  allVersions(): AttachmentVersion[] { return this.store.all<AttachmentVersion>('attachment_versions'); }
  allRelations(): IssueRelation[] { return this.store.all<IssueRelation>('issue_relations'); }

  measureArchive(receipt: SourceImport): SourceArchiveMeasurement {
    const measurement = new SourceArchiveMeasurer(receipt);
    const rows = this.store.db.prepare(`SELECT id, import_id AS importId, owner_type AS ownerType, owner_id AS ownerId,
      target_type AS targetType, target_id AS targetId, kind, source_instance AS instanceKey, product, source_id AS sourceId, json
      FROM source_records WHERE import_id = ? ORDER BY id COLLATE BINARY`).iterate(receipt.id) as Iterable<ArchiveSqlRow>;
    for (const row of rows) {
      let archive: SourceRecordArchive | null = null;
      try {
        const parsed: unknown = JSON.parse(row.json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) archive = parsed as SourceRecordArchive;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      measurement.add(archive, !archive || !archiveMatchesColumns(archive, row));
    }
    return measurement.finish();
  }

  hasImport(id: string): boolean { return Boolean(this.store.db.prepare('SELECT 1 FROM source_imports WHERE id=?').get(id)); }
  jiraIssueOrigins(instanceKey: string, selected: string[], by: 'alias' | 'issue'): JiraIssueOrigin[] {
    if (!selected.length) return [];
    const selector = by === 'alias' ? 'binding.source_alias' : 'binding.target_id';
    return this.store.db.prepare(`SELECT binding.source_alias AS alias, binding.target_id AS issueId,
      project.target_id AS projectId, project.source_alias AS sourceProjectId, snapshot.id AS archiveId
      FROM source_bindings AS binding
      JOIN source_records AS snapshot ON snapshot.import_id=binding.import_id AND snapshot.product=binding.product
        AND snapshot.source_instance=binding.source_instance AND snapshot.kind='issue' AND snapshot.target_type='issue'
        AND snapshot.target_id=binding.target_id AND snapshot.owner_type='issue' AND snapshot.owner_id=binding.target_id
        AND (snapshot.source_id=binding.source_alias OR json_extract(snapshot.json,'$.record.metadata.key')=binding.source_alias)
      JOIN source_bindings AS project ON project.product=binding.product AND project.source_instance=binding.source_instance
        AND project.kind='project' AND project.target_type='project' AND project.source_alias=json_extract(snapshot.json,'$.record.containerId')
        AND project.target_id=json_extract(snapshot.json,'$.targetProjectId')
      WHERE binding.product='jira' AND binding.source_instance=? AND binding.kind='issue' AND binding.target_type='issue'
        AND ${selector} IN (SELECT value FROM json_each(?))
      ORDER BY binding.source_alias,snapshot.id`).all(instanceKey, JSON.stringify(selected)) as unknown as JiraIssueOrigin[];
  }
  jiraKnownHistory(instanceKey: string, selected: Record<'comment' | 'worklog', string[]>): JiraHistoryArchive[] {
    if (!selected.comment.length && !selected.worklog.length) return [];
    const legacyWorklogs = selected.worklog.length && this.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='worklogs'").get()
      ? "OR EXISTS (SELECT 1 FROM worklogs WHERE json_extract(worklogs.json,'$.sourceRecordId')=history.id AND worklogs.issue_id=history.owner_id)" : '';
    return this.store.db.prepare(`SELECT id AS archiveId, owner_id AS issueId, source_id AS sourceId, 'comment' AS kind
      FROM source_records WHERE product='jira' AND source_instance=? AND kind='comment' AND target_type='comment'
        AND owner_type='issue' AND source_id IN (SELECT value FROM json_each(?))
      UNION ALL
      SELECT id AS archiveId, owner_id AS issueId, source_id AS sourceId, 'worklog' AS kind
      FROM source_records AS history WHERE product='jira' AND source_instance=? AND kind='history' AND owner_type='issue'
        AND source_id IN (SELECT value FROM json_each(?)) AND json_extract(history.json,'$.record.metadata.kind')='worklog'
        AND (json_type(history.json,'$.jiraHistoryAppend')='true' ${legacyWorklogs})
      ORDER BY kind,sourceId,archiveId`).all(instanceKey, JSON.stringify(selected.comment), instanceKey, JSON.stringify(selected.worklog)) as unknown as JiraHistoryArchive[];
  }
  jiraKnownAttachments(instanceKey: string, sourceIds: string[]): JiraAttachmentArchive[] {
    if (!sourceIds.length) return [];
    // The archive link remains authoritative even when the file or its issue was removed.
    return this.store.db.prepare(`SELECT id AS archiveId,owner_id AS issueId,source_id AS sourceId FROM source_records
      WHERE product='jira' AND source_instance=? AND kind='attachment' AND target_type='attachment'
        AND owner_type='issue' AND source_id IN (SELECT value FROM json_each(?))
      ORDER BY source_id,id`).all(instanceKey, JSON.stringify(sourceIds)) as unknown as JiraAttachmentArchive[];
  }
  jiraKnownRelations(instanceKey: string, sourceIds: string[], aliases: string[]) {
    const rows = this.store.db.prepare(`WITH aliases(id) AS (SELECT value FROM json_each(?)),
      matches AS (SELECT source_id, id, json FROM source_records
        WHERE product='jira' AND source_instance=? AND kind='relation' AND NOT coalesce(json_type(json,'$.excluded')='true',0))
      SELECT json_extract(json,'$.record') AS record, json_extract(json,'$.jiraRelationId') AS relationId
      FROM matches
      WHERE (json_type(json,'$.jiraRelationId')='text' AND source_id IN (SELECT value FROM json_each(?)))
        OR (json_array_length(json_extract(json,'$.record.references'))=2
          AND json_extract(json,'$.record.references[0].sourceId') IN (SELECT id FROM aliases)
          AND json_extract(json,'$.record.references[1].sourceId') IN (SELECT id FROM aliases))
      ORDER BY source_id,id`).all(JSON.stringify([...new Set(aliases)]), instanceKey, JSON.stringify(sourceIds)) as { record: string; relationId: string | null }[];
    const previouslyApplied: { record: LegacyRecord; relationId: string }[] = [];
    const legacy: LegacyRecord[] = [];
    for (const { record: raw, relationId } of rows) {
      const record = JSON.parse(raw) as LegacyRecord;
      if (!jiraIssueRelationSource(record)) continue;
      if (relationId) previouslyApplied.push({ record, relationId });
      else legacy.push(record);
    }
    return { previouslyApplied, legacy };
  }
  hasLocalAttachmentVersion(id: string): boolean {
    return Boolean(this.store.db.prepare(`SELECT 1 FROM attachment_versions WHERE id=? AND id<>attachment_id
      AND json_type(json,'$.localRevision')='integer' AND json_extract(json,'$.localRevision')>=2`).get(id));
  }
  versionsForAttachments(ids: string[]): AttachmentVersion[] { const result: AttachmentVersion[] = []; for (const id of new Set(ids)) result.push(...(this.store.db.prepare('SELECT json FROM attachment_versions WHERE attachment_id=? ORDER BY rowid').all(id) as { json: string }[]).map(row => JSON.parse(row.json) as AttachmentVersion)); return result; }
  validateImport(input: { imports: unknown; records: unknown; versions: unknown; relations: unknown }, context: SourcePreservationContext,
    earlier?: EarlierAttachments, appliedHistory?: AppliedConfluenceHistory, appliedJiraChildren?: AppliedJiraChildren): SourcePreservationData {
    const users = new Set(context.users.map(value => value.id)), imports = list(input.imports, '이관 영수증', 10000).map(value => parseImport(value, users)), byImport = unique(imports, '이관 영수증');
    const datasets = new Map<string, ReturnType<typeof emptyDataset>>(), packages = new Map(imports.map(value => [value.id, new Map(value.packages.map(pkg => [stable([pkg.sha256, pkg.source]), pkg]))]));
    const records = list(input.records, '보존 원본').map(raw => {
      const value = object(raw, '보존 원본'), sourceImportId = string(value.sourceImportId, '이관 ID', 200), owner = byImport.get(sourceImportId); if (!owner) fail(400, '보존 원본의 이관 영수증이 없습니다.');
      const source = legacySource(value.source), packageSha256 = sha(value.packageSha256), namespace = stable([packageSha256, source]); if (!packages.get(sourceImportId)!.has(namespace)) fail(400, '보존 원본의 패키지 출처·SHA가 영수증과 다릅니다.');
      const record = structuredClone(object(value.record, '원본 객체')) as unknown as LegacyRecord;
      if (!['none', 'plain', 'jira-wiki', 'confluence-storage', 'adf', 'json'].includes(record.textFormat)) fail(400, '원본 본문 형식을 확인해 주세요.');
      const datasetKey = stable([sourceImportId, namespace]); let dataset = datasets.get(datasetKey); if (!dataset) { dataset = emptyDataset(source); datasets.set(datasetKey, dataset); }
      try { addRecord(dataset, record); } catch (cause) { throw new SourcePreservationError(400, cause instanceof Error ? cause.message : '원본 객체가 올바르지 않습니다.'); }
      const targetType = value.targetType, ownerType = value.ownerType;
      if (targetType !== null && !['project', 'issue', 'document', 'comment', 'revision', 'attachment'].includes(String(targetType)) || ownerType !== null && ownerType !== 'issue' && ownerType !== 'document') fail(400, '원본의 대상·소유자 종류를 확인해 주세요.');
      const targetId = nullable(value.targetId, '대상 ID', 200), ownerId = nullable(value.ownerId, '소유자 ID', 200), targetProjectId = nullable(value.targetProjectId, '대상 프로젝트', 200);
      if ((targetType === null) !== (targetId === null) || (ownerType === null) !== (ownerId === null)) fail(400, '원본 대상·소유자 종류와 ID는 함께 있어야 합니다.');
      if (targetProjectId && !owner.projectIds.includes(targetProjectId)) fail(400, '원본 대상 프로젝트가 이관 영수증에 없습니다.');
      const expected = ({ project: 'project', issue: 'issue', page: 'document', comment: 'comment', revision: 'revision', attachment: 'attachment' } as Record<string, string>)[record.kind]; if (targetType !== null && targetType !== expected) fail(400, '원본 객체 종류와 적용 대상 종류가 다릅니다.');
      if (value.excluded !== undefined && (value.excluded !== true || targetType !== null)) fail(400, '제외된 원본은 적용 대상에 연결할 수 없습니다.');
      const jiraIssueFieldHashes = Object.hasOwn(value, 'jiraIssueFieldHashes') ? parseFieldHashes(value.jiraIssueFieldHashes, jiraIssueFields, 'Jira 업무 필드 기준') : undefined;
      const jiraCustomFieldHashes = Object.hasOwn(value, 'jiraCustomFieldHashes') ? parseJiraCustomFieldHashes(value.jiraCustomFieldHashes) : undefined;
      if ((jiraIssueFieldHashes || jiraCustomFieldHashes) && (source.product !== 'jira' || record.kind !== 'issue' || targetType !== 'issue' ||
          ownerType !== 'issue' || ownerId !== targetId || !targetProjectId)) fail(400, 'Jira 업무 필드 기준의 원본과 연결 대상을 확인해 주세요.');
      const confluencePageFieldHashes = Object.hasOwn(value, 'confluencePageFieldHashes')
        ? parseFieldHashes(value.confluencePageFieldHashes, confluencePageFields, 'Confluence 문서 필드 기준') : undefined;
      if (confluencePageFieldHashes && (source.product !== 'confluence' || record.kind !== 'page' || targetType !== 'document' ||
          ownerType !== 'document' || ownerId !== targetId || !targetProjectId)) fail(400, 'Confluence 문서 필드 기준의 원본과 연결 대상을 확인해 주세요.');
      const jiraHistory = Object.hasOwn(value, 'jiraHistoryAppend') ? jiraHistorySourceKey(record) : null;
      if (Object.hasOwn(value, 'jiraHistoryAppend') && (value.jiraHistoryAppend !== true || source.product !== 'jira' ||
          !owner.configuration.appendTo?.refreshHistory || owner.configuration.appendTo.projectId !== targetProjectId ||
          ownerType !== 'issue' || !ownerId || value.excluded === true || !jiraHistory || isRestrictedJiraHistory(record) ||
          targetType !== (jiraHistory.kind === 'comment' ? 'comment' : null))) {
        fail(400, 'Jira 댓글·작업 시간 원본의 적용 설정과 대상을 확인해 주세요.');
      }
      const jiraAttachmentAppend = Object.hasOwn(value, 'jiraAttachmentAppend');
      if (jiraAttachmentAppend && (value.jiraAttachmentAppend !== true || source.product !== 'jira' ||
          !owner.configuration.appendTo?.refreshAttachments || owner.configuration.appendTo.projectId !== targetProjectId ||
          ownerType !== 'issue' || !ownerId || value.excluded === true || targetType !== 'attachment' ||
          !jiraAttachmentSourceId(record) || !jiraAttachmentFileEvidence(record) || isRestrictedJiraAttachment(record))) {
        fail(400, 'Jira 첨부 원본의 적용 설정과 대상을 확인해 주세요.');
      }
      const jiraRelationId = Object.hasOwn(value, 'jiraRelationId') ? uuid(value.jiraRelationId) : undefined;
      if (jiraRelationId && (source.product !== 'jira' || targetType !== null || value.excluded === true || !jiraIssueRelationSource(record))) {
        fail(400, 'Jira 업무 관계의 원본과 적용 ID를 확인해 주세요.');
      }
      return { id: uuid(value.id), sourceImportId, packageSha256, source, record, targetType, targetId, targetProjectId, ownerType, ownerId,
        ...(value.excluded === true ? { excluded: true } : {}), ...(jiraIssueFieldHashes ? { jiraIssueFieldHashes } : {}),
        ...(jiraCustomFieldHashes ? { jiraCustomFieldHashes } : {}),
        ...(jiraHistory ? { jiraHistoryAppend: true } : {}),
        ...(jiraAttachmentAppend ? { jiraAttachmentAppend: true } : {}),
        ...(jiraRelationId ? { jiraRelationId } : {}),
        ...(confluencePageFieldHashes ? { confluencePageFieldHashes } : {}) } as SourceRecordArchive;
    });
    const byRecord = unique(records, '보존 원본'), attachments = new Map(context.attachments.map(value => [value.id, value]));
    validateArchiveManifests(imports, records);
    const localRevisions = new Map<string, number[]>();
    const versions = list(input.versions, '첨부 버전').map(raw => {
      const value = object(raw, '첨부 버전'), attachment = attachments.get(string(value.attachmentId, '첨부 ID', 200)); if (!attachment) fail(400, '첨부 버전의 현재 첨부파일이 없습니다.');
      const id = uuid(value.id), resourceType = value.resourceType, resourceId = string(value.resourceId, '첨부 소유자', 200), authorId = string(value.authorId, '첨부 작성자', 200);
      if (resourceType !== attachment.resourceType || resourceId !== attachment.resourceId || !users.has(authorId)) fail(400, '첨부 버전의 소유자·작성자가 올바르지 않습니다.');
      let filename: string; try { filename = safeFilename(value.filename); } catch { return fail(400, '첨부 버전 파일명을 확인해 주세요.'); }
      if (!Number.isSafeInteger(value.size) || Number(value.size) < 1 || Number(value.size) > MAX_FILE_BYTES || typeof value.mimeType !== 'string' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'application/octet-stream'].includes(value.mimeType)) fail(400, '첨부 버전 크기·형식을 확인해 주세요.');
      const sourceImportId = nullable(value.sourceImportId, '첨부 원본 이관', 200), sourceRecordId = nullable(value.sourceRecordId, '첨부 보관 원본', 200);
      if ((sourceImportId === null) !== (sourceRecordId === null)) fail(400, '첨부 원본 이관과 원본 객체가 함께 있어야 합니다.');
      if (sourceImportId && (!byImport.has(sourceImportId) || !sourceRecordId || byRecord.get(sourceRecordId)?.sourceImportId !== sourceImportId || byRecord.get(sourceRecordId)?.record.kind !== 'attachment')) fail(400, '첨부 버전의 보관 원본이 올바르지 않습니다.');
      if (sourceRecordId) { const archive = byRecord.get(sourceRecordId)!; if (archive.targetType !== 'attachment' || archive.targetId !== id || archive.ownerType !== attachment.resourceType || archive.ownerId !== attachment.resourceId) fail(400, '첨부 파일 버전과 원본 객체의 파일·소유자 연결이 다릅니다.'); }
      const version: AttachmentVersion = { id, attachmentId: attachment.id, resourceType: attachment.resourceType, resourceId, filename, mimeType: value.mimeType, size: Number(value.size), sha256: sha(value.sha256), authorId, createdAt: timestamp(value.createdAt), versionLabel: string(value.versionLabel, '첨부 버전 이름', 100), sourceImportId, sourceRecordId };
      if (id === attachment.id && stable(baseAttachment(version)) !== stable(baseAttachment(attachment))) fail(400, '기준 첨부 버전과 파일 메타데이터가 다릅니다.');
      if (id !== attachment.id && attachments.has(id)) fail(400, '과거 첨부 버전 ID가 다른 현재 파일과 충돌합니다.');
      if (value.localRevision !== undefined) {
        const localRevision = positive(value.localRevision);
        if (localRevision < 2 || id === attachment.id || sourceImportId || version.versionLabel !== `v${localRevision}`) fail(400, '직접 추가한 첨부 버전의 순번·이름·출처를 확인해 주세요.');
        version.localRevision = localRevision;
        const revisions = localRevisions.get(attachment.id) ?? [];
        revisions.push(localRevision);
        localRevisions.set(attachment.id, revisions);
      }
      if (value.sourceRevision !== undefined) {
        const sourceRevision = positive(value.sourceRevision);
        const archive = sourceRecordId && byRecord.get(sourceRecordId);
        const receipt = sourceImportId && byImport.get(sourceImportId);
        if (!archive || !receipt || receipt.configuration.appendPagesTo?.refreshAttachments !== true || archive.source.product !== 'confluence' ||
            archive.targetProjectId !== receipt.configuration.appendPagesTo.projectId || version.resourceType !== 'document' ||
            version.localRevision !== undefined || id === attachment.id || version.versionLabel !== String(sourceRevision) ||
            archive.record.metadata.sha256 !== version.sha256 || Number(archive.record.metadata.size) !== version.size) {
          fail(400, 'Confluence 첨부 버전의 출처·순번 또는 원본 바이트가 올바르지 않습니다.');
        }
        version.sourceRevision = sourceRevision;
      }
      return version;
    });
    for (const revisions of localRevisions.values()) {
      revisions.sort((a, b) => a - b);
      if (revisions.some((value, index) => value !== index + 2)) fail(400, '직접 추가한 첨부 버전의 순번이 중복되거나 누락되었습니다.');
    }
    const byVersion = unique(versions, '첨부 버전');
    this.validateConfluenceAttachmentRoots(versions, records, earlier);
    this.validateTargets(records, context, byVersion);
    this.validateConfluenceHistory(imports, records, context.revisions, appliedHistory);
    this.validateJiraChildren(imports, records, attachments, byVersion, appliedJiraChildren);
    const issues = new Map(context.issues.map(value => [value.id, value]));
    const relations = list(input.relations, '업무 관계').map((raw): IssueRelation => {
      const value = object(raw, '업무 관계');
      const sourceIssueId = string(value.sourceIssueId, '관계 원본 업무', 200);
      const targetIssueId = string(value.targetIssueId, '관계 대상 업무', 200);
      if (!issues.has(sourceIssueId) || !issues.has(targetIssueId) || sourceIssueId === targetIssueId) {
        fail(400, '업무 관계는 현재 존재하는 서로 다른 업무를 연결해야 합니다.');
      }
      const relation = { id: string(value.id, '업무 관계 ID', 200), sourceIssueId, targetIssueId,
        type: string(value.type, '업무 관계 종류', 300), version: positive(value.version), createdAt: timestamp(value.createdAt) };
      if (!Object.hasOwn(value, 'origin')) return relation;
      if (!isCanonicalTeamspaceIssueRelation(value)) fail(400, 'Teamspace 업무 관계의 출처·유형·방향·버전을 확인해 주세요.');
      return { ...relation, origin: 'teamspace' };
    });
    const relationById = unique(relations, '업무 관계');
    const bindings = this.bindings(records);
    this.validateJiraRelations(records, byImport, relationById, issues, bindings, Boolean(appliedJiraChildren));
    return { imports, records, versions, relations };
  }
  private validateJiraRelations(records: SourceRecordArchive[], receipts: Map<string, SourceImport>, relations: Map<string, IssueRelation>,
    issues: Map<string, Issue>, bindings: Binding[], applying: boolean): void {
    const marked = records.filter(record => record.jiraRelationId);
    if (!marked.length) return;
    const key = (instance: string, alias: string) => JSON.stringify([instance, alias]);
    const needed = new Set<string>();
    for (const archive of marked) {
      const source = jiraIssueRelationSource(archive.record)!;
      needed.add(key(archive.source.instanceKey, source.sourceAlias));
      needed.add(key(archive.source.instanceKey, source.targetAlias));
    }
    const durable = new Map(bindings.filter(binding => binding.product === 'jira' && binding.kind === 'issue')
      .map(binding => [key(binding.instance, binding.alias), binding.id]));
    const lookup = applying ? this.store.db.prepare(`SELECT target_id AS id FROM source_bindings
      WHERE product='jira' AND source_instance=? AND kind='issue' AND target_type='issue' AND source_alias=?`) : undefined;
    const target = (instance: string, alias: string) => durable.get(key(instance, alias)) ??
      (lookup?.get(instance, alias) as { id: string } | undefined)?.id;
    const extra = new Map<string, Set<string>>();
    for (const archive of records) {
      const { record, source } = archive, otherAlias = record.metadata.key;
      if (source.product !== 'jira' || record.kind !== 'issue' || archive.excluded || isRestrictedJiraHistoryOwner(record) ||
          typeof otherAlias !== 'string' || !otherAlias || otherAlias === record.sourceId) continue;
      const aliases = [record.sourceId, otherAlias];
      if (!aliases.some(alias => needed.has(key(source.instanceKey, alias)))) continue;
      const ids = aliases.flatMap(alias => target(source.instanceKey, alias) ?? []);
      if (!ids.length) continue;
      for (const alias of aliases) {
        const qualified = key(source.instanceKey, alias), values = extra.get(qualified) ?? new Set<string>();
        for (const id of ids) values.add(id);
        extra.set(qualified, values);
      }
    }
    const resolved = (instance: string, alias: string) => {
      const id = target(instance, alias), additional = extra.get(key(instance, alias));
      if (!additional) return id;
      if (additional.size !== 1 || id && !additional.has(id)) return undefined;
      return [...additional][0];
    };
    const seen = new Set<string>();
    for (const archive of marked) {
      const relationId = archive.jiraRelationId!;
      if (seen.has(relationId)) fail(400, 'Jira 원본과 적용한 업무 관계가 중복됩니다.');
      seen.add(relationId);
      const relation = relations.get(relationId);
      // Archived evidence must survive an issue's removal even when its relation has been cascaded away.
      if (!relation) continue;
      const source = jiraIssueRelationSource(archive.record)!;
      const receipt = receipts.get(archive.sourceImportId)!;
      const first = resolved(archive.source.instanceKey, source.sourceAlias);
      const second = resolved(archive.source.instanceKey, source.targetAlias);
      const canonical = first && second && jiraRelationEndpoints(source, first, second);
      const original = source.sourceAlias === source.storedSourceAlias ? [first, second] : [second, first];
      // Initial/default import keeps the original row order. Follow-up relations between existing issues use canonical direction.
      const matchesEndpoints = Boolean(canonical) && [canonical, original].some(endpoints => endpoints &&
        relation.sourceIssueId === endpoints[0] && relation.targetIssueId === endpoints[1]);
      const sourceProject = issues.get(relation.sourceIssueId)?.projectId;
      const targetProject = issues.get(relation.targetIssueId)?.projectId;
      if (relation.origin || relation.type !== source.typeName || !matchesEndpoints ||
          !sourceProject || !targetProject || !receipt.projectIds.includes(sourceProject) || !receipt.projectIds.includes(targetProject)) {
        fail(400, 'Jira 업무 관계의 원본·업무 대상·프로젝트가 일치하지 않습니다.');
      }
    }
  }
  private validateJiraChildren(imports: SourceImport[], records: SourceRecordArchive[], attachments: Map<string, Attachment>,
    versions: Map<string, AttachmentVersion>, applied?: AppliedJiraChildren): void {
    const marked = records.filter(record => record.jiraHistoryAppend || record.jiraAttachmentAppend);
    if (!marked.length && !applied?.comments.size && !applied?.worklogs.size && !applied?.attachments.size) return;
    const receipts = new Map(imports.map(receipt => [receipt.id, receipt]));
    const jira = records.filter(record => record.source.product === 'jira');
    const sourceIdentity = (record: SourceRecordArchive) => stable([record.source.instanceKey, record.record.kind, record.record.sourceId]);
    const supplementalKey = (value: SourceRecordArchive) => value.jiraAttachmentAppend
      ? { kind: 'attachment' as const, sourceId: jiraAttachmentSourceId(value.record)! } : jiraHistorySourceKey(value.record)!;
    const ownerAliases = (value: SourceRecordArchive) => value.jiraAttachmentAppend
      ? jiraAttachmentOwnerAliases(value.record) : jiraHistoryOwnerAliases(value.record);
    const issueKey = (record: SourceRecordArchive, alias: string) => stable([record.sourceImportId, record.packageSha256, record.source.instanceKey, alias]);
    const projectKey = (instance: string, projectId: string) => stable([instance, projectId]);
    const catalogKey = (instance: string, projectId: string, alias: string) => stable([instance, projectId, alias]);
    const rawIssues = new Map<string, SourceRecordArchive[]>();
    const projectSources = new Map<string, Map<string, Set<string>>>();
    const anchors = new Map<string, SourceRecordArchive[]>();
    const linkedCounts = new Map<string, number>();
    const addProject = (record: SourceRecordArchive) => {
      const origin = projectKey(record.source.instanceKey, record.targetProjectId!);
      const projects = projectSources.get(origin) ?? new Map<string, Set<string>>();
      const current = projects.get(record.record.sourceId) ?? new Set<string>();
      for (const name of [record.record.metadata.key, record.record.metadata.pkey]) if (typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name)) current.add(name);
      projects.set(record.record.sourceId, current);
      projectSources.set(origin, projects);
    };
    for (const record of jira) {
      if (record.record.kind === 'project' && record.targetType === 'project' && record.targetProjectId === record.targetId) addProject(record);
      if (record.record.kind === 'issue') for (const alias of jiraIssueAliases(record.record)) {
        const key = issueKey(record, alias), raw = rawIssues.get(key) ?? [];
        raw.push(record);
        rawIssues.set(key, raw);
        if (!applied && record.targetType === 'issue' && record.ownerType === 'issue' && record.ownerId === record.targetId && record.targetProjectId && record.record.containerId) {
          const scope = catalogKey(record.source.instanceKey, record.targetProjectId, alias), archived = anchors.get(scope) ?? [];
          archived.push(record);
          anchors.set(scope, archived);
        }
      }
      if (record.targetType === 'comment' || record.targetType === 'attachment' || record.jiraHistoryAppend) {
        const identity = sourceIdentity(record);
        linkedCounts.set(identity, (linkedCounts.get(identity) ?? 0) + 1);
      }
    }
    const archivedProjectScopes = new Set<string>();
    const projectArchive = this.store.db.prepare(`SELECT json FROM source_records WHERE product='jira' AND source_instance=?
      AND kind='project' AND target_type='project' AND target_id=?`);
    const verified = { comment: new Set<string>(), worklog: new Set<string>(), attachment: new Set<string>() };
    const alreadyStored = new Map<string, Set<string>>();
    if (applied) {
      const selectedByInstance = new Map<string, { comment: string[]; worklog: string[]; attachment: string[]; aliases: Set<string> }>();
      const incomingRecordIds = new Set(marked.map(record => record.id));
      for (const history of marked) {
        const instance = history.source.instanceKey, { kind, sourceId } = supplementalKey(history);
        const selected = selectedByInstance.get(instance) ?? { comment: [], worklog: [], attachment: [], aliases: new Set<string>() };
        selected[kind].push(sourceId);
        for (const alias of ownerAliases(history) ?? []) {
          selected.aliases.add(alias);
          for (const owner of rawIssues.get(issueKey(history, alias)) ?? []) {
            for (const candidate of jiraIssueAliases(owner.record)) selected.aliases.add(candidate);
          }
        }
        selectedByInstance.set(instance, selected);
      }
      for (const [instance, selected] of selectedByInstance) {
        const known = [...this.jiraKnownHistory(instance, selected), ...this.jiraKnownAttachments(instance, selected.attachment)
          .map(value => ({ ...value, kind: 'attachment' as const }))];
        alreadyStored.set(instance, new Set(known.filter(value => !incomingRecordIds.has(value.archiveId))
          .map(value => stable([value.kind, value.sourceId]))));
        const snapshots = new Map<string, SourceRecordArchive>();
        for (const origin of this.jiraIssueOrigins(instance, [...selected.aliases], 'alias')) {
          let archive = snapshots.get(origin.archiveId);
          if (!archive) {
            archive = this.store.get<SourceRecordArchive>('source_records', origin.archiveId);
            if (archive) snapshots.set(origin.archiveId, archive);
          }
          if (!archive) continue;
          const key = catalogKey(instance, origin.projectId, origin.alias), earlier = anchors.get(key) ?? [];
          earlier.push(archive);
          anchors.set(key, earlier);
        }
      }
    }
    const invalid = (attachment = false) => fail(400, attachment ? 'Jira 첨부 파일의 이전 원본 업무 및 프로젝트 연결을 확인해 주세요.' :
      'Jira 댓글·작업 시간의 이전 원본 업무 및 프로젝트 연결을 확인해 주세요.');
    for (const history of marked) {
      const { kind, sourceId } = supplementalKey(history);
      const instance = history.source.instanceKey, projectId = history.targetProjectId!;
      const isAttachment = kind === 'attachment';
      const owners = isAttachment ? applied?.attachmentOwners : applied?.historyOwners;
      if (applied && (!owners?.has(history.ownerId!) || alreadyStored.get(instance)?.has(stable([kind, sourceId])))) invalid(isAttachment);
      if (linkedCounts.get(sourceIdentity(history)) !== 1) invalid(isAttachment);
      const scope = projectKey(instance, projectId);
      if (applied && !archivedProjectScopes.has(scope)) {
        for (const row of projectArchive.all(instance, projectId) as { json: string }[]) addProject(JSON.parse(row.json) as SourceRecordArchive);
        archivedProjectScopes.add(scope);
      }
      const projects = projectSources.get(scope);
      const sameProject = (a: string, b: string) => {
        if (a === b) return true;
        if (/^\d+$/.test(a) === /^\d+$/.test(b)) return false;
        const [numeric, key] = /^\d+$/.test(a) ? [a, b] : [b, a];
        return projects?.get(numeric)?.has(key) === true && projects.has(key);
      };
      const aliases = ownerAliases(history);
      const receipt = receipts.get(history.sourceImportId)!;
      const earlier = (alias: string) => (anchors.get(catalogKey(instance, projectId, alias)) ?? []).filter(archive =>
        archive.sourceImportId !== history.sourceImportId && (applied || Date.parse(receipts.get(archive.sourceImportId)!.createdAt) <= Date.parse(receipt.createdAt)) &&
        archive.record.containerId && projects?.has(archive.record.containerId) && !isRestrictedJiraHistoryOwner(archive.record));
      if (!aliases || !aliases.every(alias => {
        const supplied = rawIssues.get(issueKey(history, alias)) ?? [];
        if (supplied.length > 1 || supplied.some(row => row.excluded || !row.record.containerId || isRestrictedJiraHistoryOwner(row.record))) return false;
        const direct = earlier(alias);
        const owners = [...direct, ...supplied.flatMap(row => jiraIssueAliases(row.record).flatMap(earlier))];
        return owners.length > 0 && owners.every(owner => owner.targetId === history.ownerId &&
          supplied.every(row => sameProject(owner.record.containerId!, row.record.containerId!)));
      })) invalid(isAttachment);
      const targetId = kind === 'worklog' ? history.id : history.targetId!;
      const targets = kind === 'comment' ? applied?.comments : kind === 'worklog' ? applied?.worklogs : applied?.attachments;
      if (verified[kind].has(targetId) || applied && targets?.get(targetId) !== history.ownerId) invalid(isAttachment);
      if (isAttachment && attachments.has(targetId)) {
        const original = versions.get(targetId);
        const evidence = jiraAttachmentFileEvidence(history.record)!;
        if (!original || original.attachmentId !== targetId || original.sourceRecordId !== history.id ||
            original.resourceId !== history.ownerId || original.resourceType !== 'issue' ||
            original.size !== evidence.size || original.sha256 !== evidence.sha256) {
          fail(400, 'Jira 첨부 파일의 기준 버전과 원본 바이트 확인값이 다릅니다.');
        }
      }
      verified[kind].add(targetId);
    }
    if (applied && (verified.comment.size !== applied.comments.size || verified.worklog.size !== applied.worklogs.size)) invalid();
    if (applied && verified.attachment.size !== applied.attachments.size) invalid(true);
  }
  confluenceArchivedRecord(archive: SourceRecordArchive, kind: ConfluenceArchiveKind, sourceId: string): LegacyRecord | undefined {
    const rows = this.store.db.prepare(`SELECT json FROM source_records WHERE import_id=? AND product='confluence' AND source_instance=?
      AND kind=? AND source_id=? AND json_extract(json,'$.packageSha256')=? LIMIT 2`)
      .all(archive.sourceImportId, archive.source.instanceKey, kind, sourceId, archive.packageSha256) as { json: string }[];
    return rows.length === 1 ? (JSON.parse(rows[0].json) as SourceRecordArchive).record : undefined;
  }
  private validateConfluenceHistory(imports: SourceImport[], records: SourceRecordArchive[], revisions: DocRevision[],
    applied?: AppliedConfluenceHistory): void {
    const enabled = new Map(imports.filter(receipt => receipt.configuration.appendPagesTo?.refreshHistory)
      .map(receipt => [receipt.id, receipt]));
    const marked = revisions.filter(revision => revision.confluenceSourceVersion !== undefined);
    if (!enabled.size && (applied ? !applied.commentIds.size && !applied.revisionIds.size : !marked.length)) return;
    const markedVersions = new Set<string>();
    for (const revision of marked) {
      const version = positive(revision.confluenceSourceVersion);
      const key = stable([revision.documentId, version]);
      if (version !== revision.version || markedVersions.has(key)) fail(400, 'Confluence 문서 이력의 원본 버전 번호가 잘못되었거나 중복되었습니다.');
      markedVersions.add(key);
    }
    const confluence = records.filter(archive => archive.source.product === 'confluence');
    const receipts = new Map(imports.map(receipt => [receipt.id, receipt]));
    const raw = new Map(confluence.map(archive => [confluenceArchiveKey(archive), archive]));
    const anchors = new Map<string, SourceRecordArchive[]>();
    const projects = new Set<string>();
    const aliases = new Map<string, number>();
    const sourceVersions = new Map<string, SourceRecordArchive[]>();
    const byRevision = new Map(revisions.map(revision => [revision.id, revision]));
    for (const archive of confluence) {
      const { kind, sourceId, metadata } = archive.record;
      const instance = archive.source.instanceKey;
      if (kind === 'page' && archive.targetType === 'document' && archive.targetId) {
        const key = stable([instance, archive.targetId]);
        const group = anchors.get(key) ?? [];
        group.push(archive);
        anchors.set(key, group);
      } else if (kind === 'project' && archive.targetType === 'project') {
        projects.add(stable([instance, sourceId, archive.targetId]));
      } else if ((kind === 'comment' || kind === 'revision') && archive.targetType === kind) {
        const key = stable([instance, kind, sourceId]);
        aliases.set(key, (aliases.get(key) ?? 0) + 1);
        const version = kind === 'revision' ? confluenceHistoryVersion(metadata.version) : null;
        if (version === null) continue;
        const versionKey = stable([instance, archive.ownerId, version]);
        const group = sourceVersions.get(versionKey) ?? [];
        group.push(archive);
        sourceVersions.set(versionKey, group);
      }
    }
    const archivedPage = this.store.db.prepare(`SELECT candidate.json FROM source_bindings AS binding
      JOIN source_records AS candidate ON candidate.import_id=binding.import_id AND candidate.product=binding.product
        AND candidate.source_instance=binding.source_instance AND candidate.kind=binding.kind AND candidate.source_id=binding.source_alias
        AND candidate.target_type=binding.target_type AND candidate.target_id=binding.target_id
      WHERE binding.product='confluence' AND binding.source_instance=? AND binding.kind='page' AND binding.target_type='document'
        AND binding.target_id=? LIMIT 2`);
    const archivedProject = this.store.db.prepare(`SELECT 1 FROM source_bindings WHERE product='confluence' AND source_instance=?
      AND kind='project' AND source_alias=? AND target_type='project' AND target_id=?`);
    const previousAlias = this.store.db.prepare(`SELECT 1 FROM source_records WHERE product='confluence' AND source_instance=? AND kind=?
      AND target_type IN ('comment','revision') AND target_type=kind AND source_id=? AND import_id<>? LIMIT 1`);
    const archivedPages = new Map<string, SourceRecordArchive[]>();
    const pageOf = (archive: SourceRecordArchive) => confluenceHistoryPage(archive.record, (kind, id) => {
      const related = raw.get(confluenceArchiveKey(archive, kind, id));
      return related?.excluded ? undefined : related?.record;
    });
    const verifiedComments = new Set<string>(), verifiedMarkers = new Set<string>();
    for (const archive of confluence) {
      const receipt = enabled.get(archive.sourceImportId);
      const { kind, sourceId, metadata } = archive.record;
      if (!receipt || kind !== archive.targetType || (kind !== 'comment' && kind !== 'revision')) continue;
      const revision = kind === 'revision' && archive.targetId ? byRevision.get(archive.targetId) : undefined;
      const instance = archive.source.instanceKey;
      const ownerId = archive.ownerId;
      const projectId = receipt.configuration.appendPagesTo!.projectId;
      const ownerKey = stable([instance, ownerId]);
      if (applied && ownerId && applied.owners.has(ownerId) && !archivedPages.has(ownerKey)) {
        const saved = archivedPage.all(instance, ownerId) as { json: string }[];
        archivedPages.set(ownerKey, saved.map(row => JSON.parse(row.json) as SourceRecordArchive));
      }
      const previousPages = applied ? archivedPages.get(ownerKey) ?? [] : (anchors.get(ownerKey) ?? []).filter(page =>
        page.sourceImportId !== receipt.id && Date.parse(receipts.get(page.sourceImportId)!.createdAt) <= Date.parse(receipt.createdAt));
      if (applied ? !ownerId || !applied.owners.has(ownerId) : !previousPages.length && revision?.confluenceSourceVersion === undefined) continue;
      const sourcePageId = pageOf(archive);
      const origins = previousPages.filter(page => page.record.sourceId === sourcePageId && page.targetProjectId === projectId &&
        page.record.containerId && page.ownerType === 'document' && page.ownerId === ownerId &&
        ['Page', 'BlogPost'].includes(String(page.record.metadata.sourceClass)));
      const spaces = new Set(origins.map(page => page.record.containerId));
      const [space] = spaces;
      if (!ownerId || archive.ownerType !== 'document' || archive.targetProjectId !== projectId || !sourcePageId || spaces.size !== 1 || !space ||
          !(projects.has(stable([instance, space, projectId])) || applied && archivedProject.get(instance, space, projectId)) ||
          archive.record.references.some(ref => ref.kind === 'project' && ref.relation === 'space' && ref.sourceId !== space) ||
          (aliases.get(stable([instance, kind, sourceId])) ?? 0) !== 1 || applied && previousAlias.get(instance, kind, sourceId, receipt.id)) {
        fail(400, 'Confluence 이력의 기존 같은 공간 문서 연결과 원본 ID를 확인해 주세요.');
      }
      if (kind === 'comment') {
        if (verifiedComments.has(archive.targetId!)) fail(400, 'Confluence 댓글의 보존 원본이 중복되었습니다.');
        verifiedComments.add(archive.targetId!);
        continue;
      }
      const version = confluenceHistoryVersion(metadata.version);
      const duplicates = sourceVersions.get(stable([instance, ownerId, version])) ?? [];
      const [initial] = origins.sort((a, b) => Date.parse(receipts.get(a.sourceImportId)?.createdAt ?? '') - Date.parse(receipts.get(b.sourceImportId)?.createdAt ?? ''));
      if (version === null || version === confluenceHistoryVersion(initial.record.metadata.version) ||
          duplicates.some(other => other.id !== archive.id && pageOf(other) === sourcePageId) ||
          revision && (revision.documentId !== ownerId || revision.confluenceSourceVersion !== version || verifiedMarkers.has(revision.id))) {
        fail(400, 'Confluence 문서 이력과 보존 원본의 문서·버전 번호를 확인해 주세요.');
      }
      if (revision) verifiedMarkers.add(revision.id);
    }
    if (marked.some(revision => (!applied || applied.revisionIds.has(revision.id)) && !verifiedMarkers.has(revision.id))) {
      fail(400, 'Confluence 문서 이력에 확인된 원본 보관 객체가 없습니다.');
    }
    if (applied && [...applied.commentIds].some(id => !verifiedComments.has(id))) {
      fail(400, 'Confluence 댓글에 확인된 원본 보관 객체가 없습니다.');
    }
  }
  private validateConfluenceAttachmentRoots(versions: AttachmentVersion[], records: SourceRecordArchive[], earlier?: EarlierAttachments): void {
    const extended = versions.filter(version => version.sourceRevision !== undefined);
    if (!extended.length) return;
    const allVersions = [...earlier?.versions ?? [], ...versions];
    const allRecords = [...earlier?.records ?? [], ...records];
    const byId = new Map(allVersions.map(version => [version.id, version]));
    const byRecordId = new Map(allRecords.map(record => [record.id, record]));
    const recordsBySource = new Map(allRecords.filter(record => record.source.product === 'confluence' &&
      ['attachment', 'page', 'revision'].includes(record.record.kind)).map(record => [confluenceArchiveKey(record), record.record]));
    const originOf = (version: AttachmentVersion) => {
      const archive = version.sourceRecordId && byRecordId.get(version.sourceRecordId);
      if (!archive || archive.targetType !== 'attachment' || archive.targetId !== version.id || archive.sourceImportId !== version.sourceImportId ||
          archive.source.product !== 'confluence' || archive.ownerType !== 'document' || archive.ownerId !== version.resourceId) return null;
      const origin = confluenceAttachmentOrigin(archive.record, (kind, id) => recordsBySource.get(confluenceArchiveKey(archive, kind, id)) ??
        (earlier ? this.confluenceArchivedRecord(archive, kind, id) : undefined));
      return origin ? { ...origin, namespace: archive.source.instanceKey, projectId: archive.targetProjectId } : null;
    };
    const extendedAnchors = new Set(extended.map(version => version.attachmentId));
    const earlierIds = new Set(earlier?.versions.map(version => version.id));
    const largestEarlier = new Map<string, number>();
    for (const version of allVersions) {
      if (!extendedAnchors.has(version.attachmentId) || (version.sourceRevision !== undefined && !earlierIds.has(version.id))) continue;
      const revision = originOf(version)?.sourceRevision ?? 0;
      largestEarlier.set(version.attachmentId, Math.max(largestEarlier.get(version.attachmentId) ?? 0, revision));
    }
    const distinct = new Set<string>();
    for (const version of extended) {
      const anchor = byId.get(version.attachmentId);
      const base = anchor && originOf(anchor), origin = originOf(version), revision = version.sourceRevision!;
      const key = stable([version.attachmentId, revision]);
      if (!anchor || !base || !origin || base.sourceRevision === null || origin.sourceRevision !== revision ||
          base.namespace !== origin.namespace || base.projectId !== origin.projectId || base.sourcePageId !== origin.sourcePageId ||
          base.sourceRootId !== origin.sourceRootId || anchor.attachmentId !== anchor.id || anchor.sourceImportId === version.sourceImportId ||
          revision <= Math.max(base.sourceRevision, largestEarlier.get(version.attachmentId) ?? 0) || distinct.has(key)) {
        fail(400, 'Confluence 첨부 파일의 기존 원본 연결과 새 버전 번호를 확인해 주세요.');
      }
      distinct.add(key);
    }
  }
  private validateTargets(records: SourceRecordArchive[], context: SourcePreservationContext, versions: Map<string, AttachmentVersion>, requireCurrent = false) {
    const issues = new Map(context.issues.map(value => [value.id, value])), documents = new Map(context.documents.map(value => [value.id, value]));
    const targets = { project: new Map(context.projects.map(value => [value.id, value])), issue: issues, document: documents, comment: new Map(context.comments.map(value => [value.id, value])), revision: new Map(context.revisions.map(value => [value.id, value])), attachment: new Map([...context.attachments.map(value => [value.id, value] as const), ...versions]) };
    for (const value of records) {
      if (value.targetType === 'project' && value.targetProjectId !== value.targetId) fail(400, '원본 프로젝트와 적용 당시 프로젝트 ID가 다릅니다.');
      if (value.ownerType && !targets[value.ownerType].has(value.ownerId!) && targets[value.ownerType === 'issue' ? 'document' : 'issue'].has(value.ownerId!)) fail(400, '현재 존재하는 원본 소유 리소스의 종류가 다릅니다.');
      if (requireCurrent && value.ownerType && !targets[value.ownerType].has(value.ownerId!)) fail(400, '이관 원본의 현재 소유 리소스가 없습니다.');
      if (!value.targetType) continue;
      const target = targets[value.targetType].get(value.targetId!); if (!target) { if (Object.entries(targets).some(([type, rows]) => type !== value.targetType && rows.has(value.targetId!))) fail(400, '현재 존재하는 원본 적용 대상의 종류가 다릅니다.'); if (requireCurrent) fail(400, '이관 원본의 적용 대상이 없습니다.'); continue; }
      if (value.targetType === 'attachment' && versions.get(target.id)?.localRevision !== undefined) fail(400, '직접 추가한 첨부 버전은 이관 원본의 대상이 될 수 없습니다.');
      let owner: { type: 'issue' | 'document'; id: string } | undefined;
      if (value.targetType === 'issue' || value.targetType === 'document') owner = { type: value.targetType, id: target.id };
      else if (value.targetType === 'comment' || value.targetType === 'attachment') { const resource = target as Comment | Attachment; owner = { type: resource.resourceType, id: resource.resourceId }; }
      else if (value.targetType === 'revision') owner = { type: 'document', id: (target as DocRevision).documentId };
      if (owner && (value.ownerType !== owner.type || value.ownerId !== owner.id)) fail(400, '현재 적용 대상과 원본 기록 소유자가 다릅니다.');
      // targetProjectId is the immutable project at migration time. A document
      // can move later; current permissions follow the live owner instead.
    }
  }
  private bindings(records: SourceRecordArchive[]): Binding[] {
    const found = new Map<string, Binding>();
    for (const value of records) {
      if (!value.targetType || !value.targetId || !['project', 'issue', 'page'].includes(value.record.kind)) continue;
      const aliases = new Set([value.record.sourceId]);
      if (value.source.product === 'jira' && value.record.kind === 'issue' && value.record.metadata.key !== undefined && value.record.metadata.key !== null && value.record.metadata.key !== '') aliases.add(string(value.record.metadata.key, 'Jira 원본 키', 500));
      for (const alias of aliases) {
        const key = stable([value.source.product, value.source.instanceKey, value.record.kind, alias]), previous = found.get(key);
        if (previous && (previous.type !== value.targetType || previous.id !== value.targetId)) fail(409, '동일한 원본 식별자를 서로 다른 리소스로 다시 이관할 수 없습니다.');
        if (!previous) found.set(key, { product: value.source.product, instance: value.source.instanceKey, kind: value.record.kind, alias, type: value.targetType, id: value.targetId, importId: value.sourceImportId });
      }
    }
    return [...found.values()];
  }
  private current(): SourcePreservationContext { return { users: this.store.all<User>('users'), projects: this.store.all<Project>('projects'), issues: this.store.all<Issue>('issues'), documents: this.store.all<DocPage>('documents'), comments: this.store.all<Comment>('comments'), revisions: this.store.all<DocRevision>('revisions'), attachments: this.store.all<Attachment>('attachments') }; }
  private callerTransaction() { if (!this.store.db.isTransaction) fail(500, '원본 보존 쓰기는 호출자의 트랜잭션 안에서 수행해야 합니다.'); }
  private putData(data: SourcePreservationData) {
    const insertImport = this.store.db.prepare('INSERT INTO source_imports(id,json) VALUES(?,?)'), insertRecord = this.store.db.prepare('INSERT INTO source_records(id,import_id,owner_type,owner_id,target_type,target_id,kind,source_instance,product,source_id,json) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for (const value of data.imports) insertImport.run(value.id, JSON.stringify(value));
    for (const value of data.records) insertRecord.run(value.id, value.sourceImportId, value.ownerType, value.ownerId, value.targetType, value.targetId, value.record.kind, value.source.instanceKey, value.source.product, value.record.sourceId, JSON.stringify(value));
    const insertVersion = this.store.db.prepare('INSERT INTO attachment_versions(id,attachment_id,json) VALUES(?,?,?)'); for (const value of data.versions) insertVersion.run(value.id, value.attachmentId, JSON.stringify(value));
    const insertRelation = this.store.db.prepare('INSERT INTO issue_relations(id,source_issue_id,target_issue_id,json) VALUES(?,?,?,?)'); for (const value of data.relations) insertRelation.run(value.id, value.sourceIssueId, value.targetIssueId, JSON.stringify(value));
    const insertBinding = this.store.db.prepare('INSERT OR IGNORE INTO source_bindings(product,source_instance,kind,source_alias,target_type,target_id,import_id) VALUES(?,?,?,?,?,?,?)');
    for (const value of this.bindings(data.records)) {
      const previous = this.store.db.prepare('SELECT target_type,target_id FROM source_bindings WHERE product=? AND source_instance=? AND kind=? AND source_alias=?').get(value.product, value.instance, value.kind, value.alias) as { target_type: string; target_id: string } | undefined;
      if (previous && (previous.target_type !== value.type || previous.target_id !== value.id)) fail(409, '이미 이관한 원본 ID·Jira 키를 다른 새 프로젝트에 중복 생성할 수 없습니다.');
      insertBinding.run(value.product, value.instance, value.kind, value.alias, value.type, value.id, value.importId);
    }
  }
  persistPrepared(prepared: PreparedMigration): SourceImport {
    this.callerTransaction();
    const anchorIds = prepared.attachmentVersions.filter(version => version.sourceRevision !== undefined).map(version => version.attachmentId);
    const versions = this.versionsForAttachments(anchorIds).filter(version => version.sourceImportId !== prepared.sourceImport.id);
    const earlier = versions.length ? { versions, records: [...new Set(versions.map(version => version.sourceRecordId).filter((id): id is string => !!id))]
      .map(id => this.store.get<SourceRecordArchive>('source_records', id)).filter((record): record is SourceRecordArchive => !!record) } : undefined;
    const owners = new Set(prepared.confluenceHistoryOwners);
    const appliedHistory = { owners, commentIds: new Set(prepared.comments.filter(comment => owners.has(comment.resourceId)).map(comment => comment.id)),
      revisionIds: new Set(prepared.revisions.filter(revision => revision.confluenceSourceVersion !== undefined).map(revision => revision.id)) };
    const historyOwners = new Set(prepared.jiraHistoryOwners);
    const attachmentOwners = new Set(prepared.jiraAttachmentOwners);
    const appliedJiraChildren = { historyOwners, attachmentOwners,
      comments: new Map(prepared.comments.filter(comment => historyOwners.has(comment.resourceId)).map(comment => [comment.id, comment.resourceId])),
      worklogs: new Map((prepared.worklogs ?? []).filter(worklog => historyOwners.has(worklog.issueId)).map(worklog => [worklog.sourceRecordId!, worklog.issueId])),
      attachments: new Map(prepared.attachments.filter(attachment => attachmentOwners.has(attachment.resourceId))
        .map(attachment => [attachment.id, attachment.resourceId])) };
    const context = this.current(), data = this.validateImport({ imports: [prepared.sourceImport], records: prepared.sourceRecords, versions: prepared.attachmentVersions, relations: prepared.issueRelations },
      context, earlier, appliedHistory, appliedJiraChildren);
    this.validateTargets(data.records, context, new Map(data.versions.map(value => [value.id, value])), true);
    const receipt = data.imports[0];
    if (receipt.projectIds.some(id => !context.projects.some(project => project.id === id))) fail(400, '적용할 현재 프로젝트가 없습니다.');
    const appendTo = receipt.configuration.appendTo;
    const newIssueIds = new Set(prepared.issues.map(issue => issue.id));
    const relationIds = new Set(data.relations.map(relation => relation.id));
    const markedRelations = new Set(data.records.flatMap(record => record.jiraRelationId ? [record.jiraRelationId] : []));
    if ([...markedRelations].some(id => !relationIds.has(id))) fail(400, 'Jira 원본의 적용 업무 관계가 없습니다.');
    if (appendTo && data.relations.some(relation => !newIssueIds.has(relation.sourceIssueId) && !newIssueIds.has(relation.targetIssueId) &&
        (appendTo.refreshRelations !== true || !markedRelations.has(relation.id)))) {
      fail(400, '기존 Jira 업무 사이의 관계에는 후속 관계 이관 설정과 원본 연결이 필요합니다.');
    }
    if (appendTo?.refreshCustomFields !== true) {
      if (data.records.some(record => record.jiraCustomFieldHashes && !newIssueIds.has(record.targetId!))) {
        fail(400, '기존 Jira 업무의 사용자 정의 필드 기준에는 변경분 적용 설정이 필요합니다.');
      }
    }
    const measured = measureIncomingArchive(receipt, data.records);
    const totals = archiveTotals(measured.packages);
    if (measured.unmatchedRecords || data.versions.length !== totals.attachmentVersions ||
        (receipt.counts.sourceRecords !== undefined && receipt.counts.sourceRecords !== totals.sourceRecords) ||
        (receipt.counts.attachmentVersions !== undefined && receipt.counts.attachmentVersions !== totals.attachmentVersions)) {
      fail(400, '보존 원본 또는 첨부 버전의 수량이 이관 영수증과 일치하지 않습니다.');
    }
    const sealed: SourceImport = { ...receipt, counts: { ...receipt.counts, ...totals }, integrity: { version: 1, packages: measured.packages } };
    const existing = this.store.get<SourceImport>('source_imports', receipt.id);
    if (existing) {
      if (stable(existing) !== stable(existing.integrity ? sealed : receipt)) fail(409, '기존 원본 이관 영수증은 변경할 수 없습니다.');
      const previousRecords = this.allRecords().filter(value => value.sourceImportId === existing.id), previousVersions = this.allVersions().filter(value => value.sourceImportId === existing.id);
      if (stable(previousRecords.slice().sort((a, b) => a.id.localeCompare(b.id))) !== stable(data.records.slice().sort((a, b) => a.id.localeCompare(b.id))) || stable(previousVersions.slice().sort((a, b) => a.id.localeCompare(b.id))) !== stable(data.versions.slice().sort((a, b) => a.id.localeCompare(b.id)))) fail(409, '기존 원본 객체·첨부 버전은 변경할 수 없습니다.');
      for (const relation of data.relations) if (stable(this.store.get('issue_relations', relation.id)) !== stable(relation)) fail(409, '기존 이관 관계가 변경되었습니다.');
      return existing;
    }
    this.putData({ ...data, imports: [sealed] });
    return sealed;
  }
  replaceImported(data: SourcePreservationData, previousImportVersions: Map<string, number>): void {
    this.callerTransaction();
    const previousImports = new Map(this.allImports().map(value => [value.id, value]));
    const trusted = new Set<string>();
    for (const current of data.imports) {
      const previous = previousImports.get(current.id);
      if (!previous) continue;
      if (stable(archiveReceiptMetadata(previous)) !== stable(archiveReceiptMetadata(current))) {
        fail(409, '동일한 이관 영수증 ID의 원본 출처·적용 설정은 변경할 수 없습니다.');
      }
      if (stable(previous.integrity) !== stable(current.integrity)) fail(409, '기존 이관 영수증의 무결성 기준은 변경할 수 없습니다.');
      if (previous.integrity) trusted.add(current.id);
    }
    validateArchiveManifests(data.imports.filter(receipt => trusted.has(receipt.id)), data.records, 409);
    const unverified = new Map(data.records.filter(record => !trusted.has(record.sourceImportId)).map(record => [record.id, record]));
    if (unverified.size) {
      const priorRows = this.store.db.prepare('SELECT id, json FROM source_records').iterate() as Iterable<{ id: string; json: string }>;
      for (const { id, json } of priorRows) {
        const incoming = unverified.get(id);
        if (!incoming) continue;
        let previous: unknown;
        try { previous = JSON.parse(json); }
        catch { fail(409, '기존 원본 보관 객체를 확인할 수 없습니다.'); }
        if (stable(previous) !== stable(incoming)) fail(409, '동일한 원본 보관 UUID의 출처·원문·적용 대상을 변경할 수 없습니다.');
      }
    }
    this.store.db.exec('DELETE FROM attachment_versions;DELETE FROM issue_relations;DELETE FROM source_bindings;DELETE FROM source_records;DELETE FROM source_imports;');
    const imports = data.imports.map(value => ({ ...value, version: Math.max(value.version, (previousImportVersions.get(value.id) || 0) + 1) })); this.putData({ ...data, imports });
  }
  private sourceImport(id: string): SourceImport { return this.store.get<SourceImport>('source_imports', id) || fail(404, '이관 영수증을 찾을 수 없습니다.'); }
  record(importId: string, id: string): SourceRecordArchive {
    this.sourceImport(importId); const row = this.store.db.prepare('SELECT json FROM source_records WHERE import_id=? AND id=?').get(importId, id) as { json: string } | undefined; return row ? JSON.parse(row.json) as SourceRecordArchive : fail(404, '보존한 원본 객체를 찾을 수 없습니다.');
  }
  private page(where: string, params: (string | number)[], query: Record<string, unknown>): SourceRecordPage {
    const { offset, limit } = sourceRecordWindow(query);
    if (query.kind !== undefined) { if (!isLegacyRecordKind(query.kind)) fail(400, '원본 객체 종류를 확인해 주세요.'); where += ' AND r.kind=?'; params.push(query.kind); }
    const total = Number((this.store.db.prepare(`SELECT COUNT(*) AS total FROM source_records r WHERE ${where}`).get(...params) as { total: number }).total);
    const rows = this.store.db.prepare(`SELECT json_remove(r.json,'$.record.text','$.record.metadata','$.record.references') AS summary,
      substr(json_extract(r.json,'$.record.text'),1,600) AS preview,length(CAST(json_extract(r.json,'$.record.text') AS BLOB)) AS bytes,json_array_length(json_extract(r.json,'$.record.references')) AS refs,
      coalesce((SELECT coalesce(nullif(json_extract(a.json,'$.record.title'),''),a.source_id) FROM source_records a WHERE a.import_id=r.import_id AND a.product=r.product AND a.source_instance=r.source_instance AND a.kind='identity' AND a.source_id=json_extract(r.json,'$.record.authorId') AND json_extract(a.json,'$.packageSha256')=json_extract(r.json,'$.packageSha256') ORDER BY a.rowid LIMIT 1),
      (SELECT coalesce(nullif(json_extract(a.json,'$.record.title'),''),a.source_id) FROM source_records a WHERE a.import_id=r.import_id AND a.product=r.product AND a.source_instance=r.source_instance AND a.kind='identity' AND a.source_id=json_extract(r.json,'$.record.authorId') ORDER BY a.rowid LIMIT 1)) AS author
      FROM source_records r WHERE ${where} ORDER BY r.rowid LIMIT ? OFFSET ?`).all(...params, limit, offset) as { summary: string; preview: string; bytes: number; refs: number; author: string | null }[];
    const records = rows.map(row => { const summary = JSON.parse(row.summary) as SourceRecordSummary; return { ...summary, record: { ...summary.record, textPreview: row.preview, textBytes: row.bytes, referenceCount: row.refs }, originalAuthorName: row.author }; });
    return { records, total, offset, limit };
  }
  records(importId: string, query: Record<string, unknown> = {}): SourceRecordPage {
    this.sourceImport(importId); let where = 'r.import_id=?'; const params: (string | number)[] = [importId];
    if (query.targetType !== undefined) { if (typeof query.targetType !== 'string' || !['project', 'issue', 'document', 'comment', 'revision', 'attachment'].includes(query.targetType)) fail(400, '원본 대상 종류를 확인해 주세요.'); where += ' AND r.target_type=?'; params.push(query.targetType); }
    if (query.targetId !== undefined) { where += ' AND r.target_id=?'; params.push(string(query.targetId, '원본 대상', 200)); }
    return this.page(where, params, query);
  }
  origins(query: Record<string, unknown>): SourceRecordPage {
    if (query.resourceType !== 'issue' && query.resourceType !== 'document') fail(400, '원본 기록 소유자 종류를 확인해 주세요.');
    const resourceId = string(query.resourceId, '원본 기록 소유자', 200);
    return this.page(`r.owner_type=? AND r.owner_id=? AND CASE WHEN r.product='jira' AND r.kind='history'
      THEN is_restricted_jira_status_history(r.json)=0 ELSE 1 END`, [query.resourceType, resourceId], query);
  }
  attachmentVersions(id: string): AttachmentVersion[] {
    const attachment = this.store.get<Attachment>('attachments', id); if (!attachment) fail(404, '첨부파일을 찾을 수 없습니다.');
    const values = this.versionsForAttachments([id]);
    const hasLocalVersions = values.some(value => value.localRevision !== undefined);
    if (!values.some(value => value.id === id)) values.push({ ...attachment, attachmentId: id, versionLabel: hasLocalVersions ? 'v1' : '현재 파일', sourceImportId: null, sourceRecordId: null });
    return values.sort((a, b) => (b.localRevision ?? 0) - (a.localRevision ?? 0) ||
      (b.sourceRevision ?? 0) - (a.sourceRevision ?? 0) ||
      (hasLocalVersions ? Number(b.id === id) - Number(a.id === id) : 0) || b.createdAt.localeCompare(a.createdAt) ||
      Number(b.id === id) - Number(a.id === id) || a.versionLabel.localeCompare(b.versionLabel));
  }
  registerRoutes(app: Express): void {
    const query = (request: Request, allowed: string[]) => { if (Object.keys(request.query).some(key => !allowed.includes(key))) fail(400, '지원하지 않는 원본 기록 조회 조건입니다.'); return request.query; };
    app.get('/api/source-imports', (request, response) => { query(request, []); response.json(this.allImports().sort((a, b) => b.createdAt.localeCompare(a.createdAt))); });
    app.get('/api/source-imports/:id/records', (request, response) => response.json(this.records(String(request.params.id), query(request, ['offset', 'limit', 'kind', 'targetType', 'targetId']))));
    app.get('/api/source-imports/:id/records/:recordId', (request, response) => { query(request, []); response.json(this.record(String(request.params.id), String(request.params.recordId))); });
    app.get('/api/resource-origins', (request, response) => response.json(this.origins(query(request, ['resourceType', 'resourceId', 'kind', 'offset', 'limit']))));
    app.get('/api/issues/:id/jira-status-history', (request, response) => {
      response.set('Cache-Control', 'no-store');
      const { offset, limit } = sourceRecordWindow(query(request, ['offset', 'limit']));
      const issue = this.store.get<Issue>('issues', String(request.params.id));
      if (!issue) fail(404, '업무를 찾을 수 없습니다.');
      response.json(jiraIssueStatusHistory(this.store, issue, offset, limit));
    });
    app.get('/api/attachments/:id/versions', (request, response) => { query(request, []); response.json(this.attachmentVersions(String(request.params.id))); });
  }
}
