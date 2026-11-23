import { createHash } from 'node:crypto';
import { MIGRATION_MAPPING_FILE_MAX_BYTES, STATUS, type LegacyPackageSummary, type MigrationConfiguration, type MigrationMappingFile,
  type MigrationOptions, type User } from '../shared/types.js';
import { LegacyImportError } from './legacy-import-model.js';
import type { MigrationPackage } from './migration-contracts.js';
import { parseMigrationOriginBase } from './migration-origin-links.js';
import { migrationOptionId } from './migration-planner.js';

const mappingFormat = 'teamspace-migration-mapping';
const sha256 = /^[a-f0-9]{64}$/u;
const control = /[\u0000-\u001f\u007f]/u;
const formats = { jira: ['jira-backup-xml', 'jira-search-xml', 'jira-csv', 'jira-json'], confluence: ['confluence-xml'] };
const fieldKinds = new Set(['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'user', 'url', 'archive']);
const configurationKeys = new Set(['packageIds', 'projects', 'users', 'statuses', 'issueTypes', 'fields', 'sourceBaseUrls',
  'timezone', 'datePolicy', 'excludedRecords', 'jiraReleaseSelections', 'jiraSprintSelections', 'jiraWorkflows', 'appendTo', 'appendPagesTo']);
type MappingPackage = MigrationMappingFile['packages'][number];
type MappingFileInput = Omit<MigrationMappingFile, 'configuration'> & { configuration: unknown };

export function mappingError(status: number, reason: string, message: string): never {
  throw new LegacyImportError(status, message, { reason });
}

export function invalidMigrationMapping(message = '이관 매핑 파일의 형식이나 매핑 항목을 확인해 주세요.'): never {
  return mappingError(400, 'mapping_invalid', message);
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identifier = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= max && value.isWellFormed() && !control.test(value);

export function assertMappingSize(value: unknown): void {
  let json: string;
  try { json = JSON.stringify(value); }
  catch { return invalidMigrationMapping(); }
  if (Buffer.byteLength(json) > MIGRATION_MAPPING_FILE_MAX_BYTES) {
    mappingError(413, 'mapping_too_large', '이관 매핑 파일은 16MiB 이하여야 합니다.');
  }
}

export function readMappingRequest(raw: unknown, key: 'configuration' | 'mapping'): unknown {
  if (!object(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, key) || !object(raw[key])) return invalidMigrationMapping();
  const value = raw[key];
  assertMappingSize(value);
  return value;
}

export function mappingConfigurationInput(value: unknown) {
  if (!object(value) || !Array.isArray(value.packageIds) || Object.keys(value).some(key => !configurationKeys.has(key))) {
    return invalidMigrationMapping();
  }
  return value;
}

export function readMappingFile(raw: unknown): MappingFileInput {
  if (!object(raw) || Object.keys(raw).length !== 5 || raw.format !== mappingFormat || raw.version !== 1 ||
      !Array.isArray(raw.packages) || raw.packages.length < 1 || raw.packages.length > 20 || !object(raw.mappedUsers)) return invalidMigrationMapping();
  const packages = raw.packages.map((value: unknown): MappingPackage => {
    if (!object(value) || Object.keys(value).length !== 5) return invalidMigrationMapping();
    const { id, sha256: digest, product, instanceKey, format } = value;
    if (!identifier(id) || typeof digest !== 'string' || !sha256.test(digest) ||
        (product !== 'jira' && product !== 'confluence') || !identifier(instanceKey) || instanceKey !== instanceKey.trim() ||
        typeof format !== 'string' || !formats[product].includes(format)) return invalidMigrationMapping();
    return { id, sha256: digest, product, instanceKey, format: format as MappingPackage['format'] };
  });
  if (new Set(packages.map(({ id }) => id)).size !== packages.length) return invalidMigrationMapping();
  const mappedUsers = Object.fromEntries(Object.entries(raw.mappedUsers).map(([id, value]) => {
    if (!identifier(id) || typeof value !== 'string' || !sha256.test(value)) return invalidMigrationMapping();
    return [id, value];
  }));
  return { format: mappingFormat, version: 1, packages, configuration: raw.configuration, mappedUsers };
}

export function mappingPackage(summary: LegacyPackageSummary): MappingPackage {
  const { id, sha256, source: { product, instanceKey, format } } = summary;
  return { id, sha256, product, instanceKey, format };
}

export function resolveMappingPackages(required: MappingPackage[], available: LegacyPackageSummary[]): string[] {
  const current = available.map(mappingPackage);
  const ids = required.map((fingerprint, index) => {
    const matches = current.filter(item => item.sha256 === fingerprint.sha256 && item.product === fingerprint.product &&
      item.instanceKey === fingerprint.instanceKey && item.format === fingerprint.format);
    const exact = matches.find(item => item.id === fingerprint.id);
    if (exact) return exact.id;
    if (!matches.length) return mappingError(409, 'package_missing', `${index + 1}번째 원본과 같은 파일을 같은 인스턴스 값으로 먼저 분석해 주세요.`);
    if (matches.length !== 1) return mappingError(409, 'package_ambiguous', `${index + 1}번째 원본과 같은 분석 패키지가 여러 개입니다.`);
    return matches[0].id;
  });
  if (new Set(ids).size !== ids.length) return mappingError(409, 'package_ambiguous', '서로 다른 매핑 패키지가 같은 분석 패키지에 연결됩니다.');
  return ids;
}

function remapObject<T>(values: Record<string, T>, key: (id: string) => string, value: (entry: T) => T = entry => entry): Record<string, T> {
  if (Object.keys(values).length > 100_000) return invalidMigrationMapping();
  return Object.fromEntries(Object.entries(values).map(([id, entry]) => [key(id), value(entry)]));
}

function checkedValue<T>(value: T, allowed: (value: T) => boolean): T {
  if (!allowed(value)) return invalidMigrationMapping();
  return value;
}

function validateJiraWorkflowDestinations(workflows: NonNullable<MigrationConfiguration['jiraWorkflows']>,
  projects: MigrationConfiguration['projects'], options: MigrationOptions): void {
  const keyByContainer = new Map(projects.map(project => [project.containerId, project.key.trim().toUpperCase()]));
  const statesByKey = new Map(Object.keys(workflows).map(key => [key, new Set<string>()]));
  for (const status of options.jiraWorkflowStatuses ?? []) for (const container of status.containerIds) {
    const key = keyByContainer.get(container);
    if (key) statesByKey.get(key)?.add(status.id);
  }
  for (const [key, workflow] of Object.entries(workflows)) {
    const states = statesByKey.get(key);
    if (!states?.size) return invalidMigrationMapping('Jira 업무가 매핑된 새 프로젝트에 워크플로를 지정해 주세요.');
    for (const state of workflow.additionalStatuses ?? []) states.add(state.id);
    if (!states.has(workflow.initialStatusId) || workflow.transitions.some(edge => !states.has(edge.from) || !states.has(edge.to))) {
      return invalidMigrationMapping('해당 프로젝트에 매핑한 Jira 상태 또는 추가 상태를 선택해 주세요.');
    }
  }
}

export function remapMappingConfiguration(configuration: MigrationConfiguration, packages: MigrationPackage[], options: MigrationOptions): MigrationConfiguration {
  const byOld = new Map(configuration.packageIds.map((id, index) => [id, packages[index]]));
  const oldByCurrent = new Map([...byOld].map(([id, pkg]) => [pkg.summary.id, id]));
  const previousOptionLookup = (kind: string, values: readonly { id: string; packageId: string; sourceValue: string }[]) => {
    const ids = new Map(values.map(item => [migrationOptionId(oldByCurrent.get(item.packageId)!, kind, item.sourceValue), item.id]));
    return (id: string) => ids.get(id) ?? invalidMigrationMapping('선택한 원본에서 매핑 항목을 찾을 수 없습니다.');
  };
  const containerId = previousOptionLookup('container', options.containers.map(item => ({ ...item, sourceValue: item.sourceProjectId })));
  const identityId = previousOptionLookup('identity', options.identities);
  const statusId = previousOptionLookup('status', options.statuses);
  const typeId = previousOptionLookup('issuetype', options.issueTypes);
  const fieldId = previousOptionLookup('field', options.fields);
  const selectedRecords = new Map(packages.map(pkg => [pkg.summary.id, new Set(pkg.dataset.records.map(record => record.id))]));
  const knownPackage = (id: string) => byOld.get(id) ?? invalidMigrationMapping('선택한 원본 패키지의 매핑만 보관할 수 있습니다.');
  const recordKey = (key: string) => {
    const separator = key.indexOf('/');
    if (separator < 1) return invalidMigrationMapping('패키지가 지정된 원본 객체 ID를 확인해 주세요.');
    const pkg = knownPackage(key.slice(0, separator));
    const recordId = key.slice(separator + 1);
    if (!selectedRecords.get(pkg.summary.id)!.has(recordId)) return invalidMigrationMapping('선택한 패키지에서 원본 객체를 찾을 수 없습니다.');
    return `${pkg.summary.id}/${recordId}`;
  };
  const projects = configuration.projects.map(({ containerId: oldId, key, name }) => {
    if (key.length > 200 || name.length > 300 || control.test(key) || control.test(name)) return invalidMigrationMapping();
    return { containerId: containerId(oldId), key, name };
  });
  const excludedRecords = configuration.excludedRecords.map(recordKey);
  if (new Set(projects.map(project => project.containerId)).size !== projects.length ||
      new Set(excludedRecords).size !== excludedRecords.length || configuration.timezone.length > 100 || control.test(configuration.timezone)) {
    return invalidMigrationMapping();
  }
  const sourceBaseUrls = Object.fromEntries(Object.entries(configuration.sourceBaseUrls).map(([id, value]) => {
    const pkg = knownPackage(id);
    if (value === null) return [pkg.summary.id, null];
    const base = parseMigrationOriginBase(pkg.summary.source.product, value);
    if (!base) return invalidMigrationMapping('원본 기준 주소에는 사용자 정보, 검색 조건, 조각 또는 개별 항목 주소를 넣을 수 없습니다.');
    return [pkg.summary.id, `${base.origin}${base.contextPath}`];
  }));
  const { appendTo, appendPagesTo, jiraReleaseSelections, jiraSprintSelections, jiraWorkflows } = configuration;
  // Workflow states use source instance and source status IDs, independent of staging package IDs.
  if (jiraWorkflows) validateJiraWorkflowDestinations(jiraWorkflows, projects, options);
  return {
    packageIds: packages.map(pkg => pkg.summary.id), projects,
    users: remapObject(configuration.users, identityId, value => checkedValue(value, value => value === null || identifier(value))),
    statuses: remapObject(configuration.statuses, statusId, value => checkedValue(value, value => typeof value === 'string' && Object.hasOwn(STATUS, value))),
    issueTypes: remapObject(configuration.issueTypes, typeId, value => checkedValue(value, value => value === null || identifier(value))),
    fields: remapObject(configuration.fields, fieldId, value => checkedValue(value, value => typeof value === 'string' && fieldKinds.has(value))),
    sourceBaseUrls, timezone: configuration.timezone, datePolicy: configuration.datePolicy, excludedRecords,
    ...(jiraReleaseSelections ? { jiraReleaseSelections: remapObject(jiraReleaseSelections, recordKey) } : {}),
    ...(jiraSprintSelections ? { jiraSprintSelections: remapObject(jiraSprintSelections, recordKey) } : {}),
    ...(jiraWorkflows ? { jiraWorkflows } : {}),
    ...(appendTo ? { appendTo: { ...appendTo, statuses: remapObject(appendTo.statuses, statusId),
      issueTypes: remapObject(appendTo.issueTypes, typeId), fields: remapObject(appendTo.fields, fieldId) } } : {}),
    ...(appendPagesTo ? { appendPagesTo } : {}),
  };
}

const emailFingerprint = (user: User) => createHash('sha256').update(user.email.trim().toLowerCase()).digest('hex');
const mappedIds = (configuration: MigrationConfiguration) => [...new Set(Object.values(configuration.users).filter((id): id is string => id !== null))];
const missingUser = () => mappingError(409, 'mapped_user_missing', '매핑한 팀원을 찾을 수 없습니다. 해당 이메일의 팀원을 등록하거나 매핑을 다시 지정해 주세요.');
const ambiguousUser = () => mappingError(409, 'mapped_user_ambiguous', '매핑한 이메일에 해당하는 팀원이 여러 명입니다. 팀원 이메일을 확인해 주세요.');

export function makeMappingFile(configuration: MigrationConfiguration, packages: MigrationPackage[], users: User[]): MigrationMappingFile {
  const byId = new Map(users.map(user => [user.id, user]));
  const mappedUsers = Object.fromEntries(mappedIds(configuration).map(id => [id, emailFingerprint(byId.get(id) ?? missingUser())]));
  if (new Set(Object.values(mappedUsers)).size !== Object.keys(mappedUsers).length) return ambiguousUser();
  const file: MigrationMappingFile = { format: mappingFormat, version: 1, packages: packages.map(pkg => mappingPackage(pkg.summary)), configuration, mappedUsers };
  assertMappingSize(file);
  return file;
}

export function restoreMappedUsers(configuration: MigrationConfiguration, mappedUsers: Record<string, string>, users: User[]): MigrationConfiguration {
  const ids = mappedIds(configuration);
  if (ids.length !== Object.keys(mappedUsers).length || ids.some(id => !Object.hasOwn(mappedUsers, id))) return invalidMigrationMapping();
  if (new Set(Object.values(mappedUsers)).size !== ids.length) return ambiguousUser();
  const byFingerprint = new Map<string, string[]>();
  for (const user of users) {
    const hash = emailFingerprint(user);
    const matches = byFingerprint.get(hash);
    if (matches) matches.push(user.id);
    else byFingerprint.set(hash, [user.id]);
  }
  const currentIds = new Map(ids.map(id => {
    const matches = byFingerprint.get(mappedUsers[id]);
    if (!matches?.length) return missingUser();
    if (matches.length !== 1) return ambiguousUser();
    return [id, matches[0]];
  }));
  return { ...configuration, users: remapObject(configuration.users, id => id, id => id === null ? null : currentIds.get(id)!) };
}
