import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { documentLabelKey } from '../shared/document-labels.js';
import { PRIORITY, type CustomFieldValue, type Issue, type IssueTemplate, type IssueTemplateDefaults, type Project, type User } from '../shared/types.js';
import { creationRequestId } from './creation-request.js';
import type { Store } from './store.js';

const RESTORE_VERSION_FLOOR = 'issueTemplateRestoreVersion';
const DEFAULT_FIELDS = ['title', 'description', 'descriptionFormat', 'type', 'priority', 'labels', 'customFields'];
const BACKUP_FIELDS = ['id', 'projectId', 'name', 'defaults', 'archived', 'version', 'authorId', 'createdAt', 'updatedAt'];
const INVALID_BACKUP = '백업의 업무 템플릿 데이터를 확인해 주세요.';

type ErrorReason = 'issue-template-invalid-input' | 'issue-template-invalid-backup' | 'issue-template-not-found' |
  'issue-template-archived' | 'issue-template-version-conflict' | 'issue-template-name-conflict' |
  'issue-template-source-not-found' | 'issue-template-source-version-conflict';
type ValidateDefaults = (projectId: string, defaults: IssueTemplateDefaults, source?: Issue) => IssueTemplateDefaults;

export class IssueTemplateError extends Error {
  constructor(public status: number, message: string, public details: { reason: ErrorReason; currentVersion?: number }) {
    super(message);
  }
}

function fail(status: number, message: string, reason: ErrorReason, currentVersion?: number): never {
  throw new IssueTemplateError(status, message, currentVersion === undefined ? { reason } : { reason, currentVersion });
}

function invalidInput(message: string, backup = false): never {
  return backup
    ? fail(400, INVALID_BACKUP, 'issue-template-invalid-backup')
    : fail(400, message, 'issue-template-invalid-input');
}

function record(value: unknown, fields: readonly string[], backup = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    return invalidInput('업무 템플릿 요청 데이터를 확인해 주세요.', backup);
  }
  return value as Record<string, unknown>;
}

function nameValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  const name = value.trim().normalize('NFC');
  return name && name.length <= 100 ? name : null;
}

function requireName(value: unknown): string {
  return nameValue(value) ?? invalidInput('업무 템플릿 이름은 1~100자로 입력해 주세요.');
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function nextVersion(version: number): number {
  if (version >= Number.MAX_SAFE_INTEGER) {
    return fail(409, '업무 템플릿의 편집 버전 범위를 초과했습니다.', 'issue-template-version-conflict', version);
  }
  return version + 1;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isCustomFieldValue(value: unknown): value is CustomFieldValue {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 20000;
  return Array.isArray(value) && value.length <= 200 && new Set(value).size === value.length &&
    value.every(option => typeof option === 'string' && /^[a-z][a-z0-9_-]{0,47}$/u.test(option));
}

function parseDefaults(input: unknown, backup = false): IssueTemplateDefaults {
  const { title, description, descriptionFormat, type, priority, labels, customFields } = record(input, DEFAULT_FIELDS, backup);
  if (typeof title !== 'string' || title.length > 300 || typeof description !== 'string' || description.length > 200000 ||
      (descriptionFormat !== 'plain' && descriptionFormat !== 'markdown') ||
      typeof type !== 'string' || !type.trim() || type.length > 48 ||
      typeof priority !== 'string' || !Object.hasOwn(PRIORITY, priority) ||
      !Array.isArray(labels) || labels.some(label => typeof label !== 'string' || label.length > 60) ||
      !customFields || typeof customFields !== 'object' || Array.isArray(customFields)) {
    return invalidInput('업무 템플릿의 기본값을 확인해 주세요.', backup);
  }
  const fields = Object.entries(customFields);
  const reserved = ['constructor', 'prototype'];
  if (fields.length > 100 || fields.some(([key, value]) =>
    !/^[a-z][a-z0-9_-]{0,47}$/u.test(key) || reserved.includes(key) || !isCustomFieldValue(value))) {
    return invalidInput('업무 템플릿의 사용자 정의 필드 값을 확인해 주세요.', backup);
  }
  return { title: title.trim(), description, descriptionFormat, type, priority: priority as IssueTemplateDefaults['priority'],
    labels: [...new Set<string>(labels)], customFields: Object.fromEntries(fields) };
}

export class IssueTemplatesService {
  constructor(private readonly store: Store, private readonly validateDefaults: ValidateDefaults) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS issue_templates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
        name_key TEXT NOT NULL,
        archived INTEGER NOT NULL CHECK(archived IN (0,1)),
        json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS issue_template_active_name
        ON issue_templates(project_id,name_key) WHERE archived=0;
      CREATE INDEX IF NOT EXISTS issue_template_project ON issue_templates(project_id,archived);
    `);
  }

  list(projectId: string, includeArchived = false): IssueTemplate[] {
    this.requireProject(projectId);
    const rows = this.store.db.prepare('SELECT json FROM issue_templates WHERE project_id=? AND (archived=0 OR ?=1)')
      .all(projectId, Number(includeArchived)) as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as IssueTemplate)
      .sort((left, right) => Number(left.archived) - Number(right.archived) ||
        left.name.localeCompare(right.name, 'ko') || left.id.localeCompare(right.id));
  }

  create(projectId: string, input: unknown, actorId: string): IssueTemplate {
    const body = record(input, ['name', 'defaults', 'sourceIssueId', 'expectedIssueVersion']);
    const name = requireName(body.name);
    const fromSource = Object.hasOwn(body, 'sourceIssueId');
    const { sourceIssueId, expectedIssueVersion } = body;
    if (fromSource !== Object.hasOwn(body, 'expectedIssueVersion') || fromSource === Object.hasOwn(body, 'defaults')) {
      return invalidInput('업무 템플릿의 기본값 또는 원본 업무를 지정해 주세요.');
    }
    const save = () => {
      this.requireProject(projectId);
      this.requireActor(actorId);
      const source = fromSource ? this.readSource(projectId, sourceIssueId, expectedIssueVersion) : undefined;
      const defaults = source ? {
        title: source.title, description: source.description, descriptionFormat: source.descriptionFormat ?? 'plain',
        type: source.type, priority: source.priority, labels: source.labels, customFields: source.customFields ?? {},
      } : parseDefaults(body.defaults);
      const validated = this.validateDefaults(projectId, defaults, source);
      const timestamp = new Date().toISOString();
      const template: IssueTemplate = {
        id: randomUUID(), projectId, name, defaults: source ? parseDefaults(validated) : validated,
        archived: false, version: 1, authorId: actorId, createdAt: timestamp, updatedAt: timestamp,
      };
      this.requireAvailableName(template);
      this.put(template);
      return template;
    };
    return this.store.db.isTransaction ? save() : this.store.transaction(save);
  }

  patch(projectId: string, templateId: string, input: unknown, actorId: string): IssueTemplate {
    const body = record(input, ['expectedVersion', 'name', 'archived', 'defaults']);
    const { expectedVersion, archived } = body;
    const name = Object.hasOwn(body, 'name') ? requireName(body.name) : undefined;
    const hasDefaults = Object.hasOwn(body, 'defaults');
    if (!isVersion(expectedVersion) || (Object.hasOwn(body, 'archived') && typeof archived !== 'boolean') ||
        (name === undefined && archived === undefined && !hasDefaults)) {
      return invalidInput('업무 템플릿의 버전과 변경 항목을 확인해 주세요.');
    }
    const save = () => {
      this.requireActor(actorId);
      const current = this.requireTemplate(projectId, templateId);
      this.requireVersion(current, expectedVersion);
      const defaults = hasDefaults ? this.validateDefaults(projectId, parseDefaults(body.defaults)) : current.defaults;
      const template = { ...current, name: name ?? current.name, archived: typeof archived === 'boolean' ? archived : current.archived, defaults };
      if (isDeepStrictEqual(current, template)) return current;
      this.requireAvailableName(template);
      const saved = { ...template, version: nextVersion(current.version), updatedAt: new Date().toISOString() };
      this.put(saved);
      return saved;
    };
    return this.store.db.isTransaction ? save() : this.store.transaction(save);
  }

  forCreation(projectId: string, templateId: unknown, expectedTemplateVersion: unknown): IssueTemplate {
    if (typeof templateId !== 'string' || !templateId || !isVersion(expectedTemplateVersion)) {
      return invalidInput('선택한 업무 템플릿과 버전을 확인해 주세요.');
    }
    const template = this.requireTemplate(projectId, templateId);
    if (template.archived) {
      return fail(409, '보관된 업무 템플릿입니다. 다른 템플릿을 선택해 주세요.', 'issue-template-archived', template.version);
    }
    this.requireVersion(template, expectedTemplateVersion);
    return template;
  }

  all(): IssueTemplate[] {
    const rows = this.store.db.prepare('SELECT json FROM issue_templates ORDER BY id').all() as { json: string }[];
    return rows.map(row => JSON.parse(row.json) as IssueTemplate);
  }

  validateRestore(input: unknown, projects: readonly Project[], users: readonly User[], exportedAt: unknown): IssueTemplate[] {
    if (!Array.isArray(input) || input.length > 100000 || (input.length && !isIsoTimestamp(exportedAt))) {
      return invalidInput(INVALID_BACKUP, true);
    }
    const projectIds = new Set(projects.map(project => project.id));
    const userIds = new Set(users.map(user => user.id));
    const ids = new Set<string>();
    const activeNames = new Set<string>();
    return input.map(value => {
      const row = record(value, BACKUP_FIELDS, true);
      const { id, projectId, version, archived, authorId, createdAt, updatedAt } = row;
      const name = nameValue(row.name);
      if (typeof id !== 'string' || !creationRequestId.test(id) || id !== id.toLowerCase() || ids.has(id) ||
          typeof projectId !== 'string' || !projectIds.has(projectId) ||
          !name || name !== row.name || !isVersion(version) || typeof archived !== 'boolean' ||
          typeof authorId !== 'string' || !userIds.has(authorId) ||
          !isIsoTimestamp(createdAt) || !isIsoTimestamp(updatedAt) || createdAt > updatedAt ||
          typeof exportedAt !== 'string' || updatedAt > exportedAt) {
        return invalidInput(INVALID_BACKUP, true);
      }
      const nameKey = JSON.stringify([projectId, documentLabelKey(name)]);
      if (!archived && activeNames.has(nameKey)) return invalidInput(INVALID_BACKUP, true);
      ids.add(id);
      if (!archived) activeNames.add(nameKey);
      // Templates can still be edited if a referenced field, option or type has since been deleted.
      const defaults = parseDefaults(row.defaults, true);
      return { id, projectId, name, defaults, archived, version, authorId, createdAt, updatedAt };
    });
  }

  restore(templates: readonly IssueTemplate[]): void {
    if (!this.store.db.isTransaction) throw new Error('Issue template restoration requires a transaction.');
    const local = this.store.db.prepare("SELECT MAX(json_extract(json,'$.version')) AS version FROM issue_templates")
      .get() as { version: number | null };
    const previous: unknown = this.store.setting(RESTORE_VERSION_FLOOR);
    const floor = Math.max(local.version ?? 0, isVersion(previous) ? previous : 0);
    this.store.db.exec('DELETE FROM issue_templates');
    let highestVersion = floor;
    for (const template of templates) {
      const version = Math.max(template.version, floor ? nextVersion(floor) : 1);
      this.put({ ...template, version });
      highestVersion = Math.max(highestVersion, version);
    }
    if (highestVersion) this.store.setSetting(RESTORE_VERSION_FLOOR, highestVersion);
  }

  private requireProject(projectId: string): void {
    if (!this.store.get<Project>('projects', projectId)) {
      fail(404, '업무 템플릿을 사용할 프로젝트를 찾을 수 없습니다.', 'issue-template-not-found');
    }
  }

  private requireActor(actorId: string): void {
    if (!this.store.get<User>('users', actorId)) invalidInput('업무 템플릿을 변경할 작업자를 확인해 주세요.');
  }

  private requireTemplate(projectId: string, templateId: string): IssueTemplate {
    const template = this.store.get<IssueTemplate>('issue_templates', templateId);
    if (!template || template.projectId !== projectId) {
      return fail(404, '프로젝트에서 업무 템플릿을 찾을 수 없습니다.', 'issue-template-not-found');
    }
    return template;
  }

  private requireVersion(template: IssueTemplate, expected: number): void {
    if (template.version !== expected) {
      fail(409, '업무 템플릿이 변경되었습니다. 최신 내용을 확인해 주세요.', 'issue-template-version-conflict', template.version);
    }
  }

  private readSource(projectId: string, sourceId: unknown, expected: unknown): Issue {
    if (typeof sourceId !== 'string' || !sourceId.trim() || !isVersion(expected)) {
      return invalidInput('원본 업무와 버전을 확인해 주세요.');
    }
    const source = this.store.get<Issue>('issues', sourceId);
    if (!source || source.projectId !== projectId) {
      return fail(404, '프로젝트에서 원본 업무를 찾을 수 없습니다.', 'issue-template-source-not-found');
    }
    if (source.version !== expected) {
      return fail(409, '원본 업무가 변경되었습니다. 최신 내용을 확인해 주세요.', 'issue-template-source-version-conflict', source.version);
    }
    return source;
  }

  private requireAvailableName(template: IssueTemplate): void {
    if (!template.archived && this.store.db.prepare(
      'SELECT 1 FROM issue_templates WHERE project_id=? AND name_key=? AND archived=0 AND id<>?'
    ).get(template.projectId, documentLabelKey(template.name), template.id)) {
      fail(409, '이 프로젝트에 같은 이름의 활성 업무 템플릿이 있습니다.', 'issue-template-name-conflict');
    }
  }

  private put(template: IssueTemplate): void {
    this.store.db.prepare(`INSERT INTO issue_templates(id,project_id,name_key,archived,json) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name_key=excluded.name_key,archived=excluded.archived,json=excluded.json`)
      .run(template.id, template.projectId, documentLabelKey(template.name), Number(template.archived), JSON.stringify(template));
  }
}
