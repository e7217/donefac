import { randomUUID } from 'node:crypto';
import { documentLabelKey } from '../shared/document-labels.js';
import { documentNodes } from '../shared/document-references.js';
import { documentSectionHash, isDocumentSectionId } from '../shared/document-sections.js';
import type { DocPage, DocumentTemplate, DocumentTemplateSummary, Project, RichContent, User } from '../shared/types.js';
import { creationRequestFingerprint, creationRequestId } from './creation-request.js';
import { DocumentContentError, normalizeDocumentContent } from './document-content.js';
import type { DocumentTemplateAssetsService } from './document-template-assets.js';
import type { Store } from './store.js';

type ErrorReason = 'invalid_input' | 'invalid_backup' | 'source_version_conflict' | 'template_version_conflict' |
  'template_archived' | 'template_not_found' | 'source_not_found' | 'template_scope' | 'attachment_reference' |
  'name_conflict' | 'request_conflict' | 'request_unavailable';
type StoredTemplate = { metadata: string; content: string };
type CreationReceipt = { actor_id: string; fingerprint: string; template_id: string | null };

const MAX_NAME_LENGTH = 100;
const MAX_TEMPLATE_VERSION = Number.MAX_SAFE_INTEGER;
const RESTORE_VERSION_FLOOR = 'documentTemplateRestoreVersion';
const BACKUP_FIELDS = ['id', 'projectId', 'name', 'icon', 'sourceDocumentId', 'sourceTitle', 'sourceVersion', 'version',
  'archived', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'attachmentCount', 'content'];
const INVALID_BACKUP = '백업의 문서 템플릿 데이터를 확인해 주세요.';
const sectionRoute = /^#\/[^/]+\/documents\/([^/?#]+)\?([^#]+)$/u;

export class DocumentTemplateError extends Error {
  readonly details: { reason: ErrorReason; currentVersion?: number };

  constructor(readonly status: number, message: string, reason: ErrorReason, currentVersion?: number) {
    super(message);
    this.details = currentVersion === undefined ? { reason } : { reason, currentVersion };
  }
}

function fail(status: number, message: string, reason: ErrorReason, currentVersion?: number): never {
  throw new DocumentTemplateError(status, message, reason, currentVersion);
}

function record(value: unknown, allowed: readonly string[], backup = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    return fail(400, backup ? INVALID_BACKUP : '템플릿 요청 데이터를 확인해 주세요.', backup ? 'invalid_backup' : 'invalid_input');
  }
  return value as Record<string, unknown>;
}

function nameValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  const name = value.trim().normalize('NFC');
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

function requireName(value: unknown): string {
  return nameValue(value) ?? fail(400, '템플릿 이름은 1~100자로 입력해 주세요.', 'invalid_input');
}

function identifier(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()); }

function requestVersion(value: unknown, label: string): number {
  if (!isVersion(value)) return fail(400, label + ' 버전을 확인해 주세요.', 'invalid_input');
  return value;
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function nextVersion(version: number): number {
  if (version >= MAX_TEMPLATE_VERSION) fail(409, '템플릿의 편집 버전 범위를 초과했습니다.', 'template_version_conflict', version);
  return version + 1;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isIcon(value: unknown): value is string { return typeof value === 'string' && value.length <= 20; }
function isSourceTitle(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 300;
}

function restoredTemplateContent(value: unknown): RichContent {
  try { return normalizeDocumentContent(value).content; }
  catch (error) {
    if (error instanceof DocumentContentError) fail(400, INVALID_BACKUP, 'invalid_backup');
    throw error;
  }
}

function ownSection(href: string, sourceId: string, sections: ReadonlySet<string>): string | null {
  const value = href.trim();
  if (value.startsWith('#') && sections.has(value.slice(1))) return value.slice(1);
  let hash = value;
  if (/^https?:\/\//iu.test(value)) {
    try { hash = new URL(value).hash; } catch { return null; }
  }
  const route = sectionRoute.exec(hash);
  if (!route) return null;
  try { if (decodeURIComponent(route[1]) !== sourceId) return null; } catch { return null; }
  const query = new URLSearchParams(route[2]);
  const section = query.get('section');
  return query.size === 1 && section && sections.has(section) ? section : null;
}

/** Rebase unpinned self-links to headings that were copied into the new draft. */
export function templateDraftContent(template: DocumentTemplate, newDocumentId: string): RichContent {
  const draft = structuredClone(template.content);
  const sections = new Set<string>();
  for (const node of documentNodes(draft)) {
    if (node.type === 'heading' && isDocumentSectionId(node.attrs?.sectionId)) sections.add(node.attrs.sectionId);
  }
  if (!sections.size) return draft;
  for (const node of documentNodes(draft)) {
    for (const mark of node.marks ?? []) {
      if (mark.type !== 'link' || typeof mark.attrs?.href !== 'string') continue;
      const section = ownSection(mark.attrs.href, template.sourceDocumentId, sections);
      if (section) mark.attrs.href = documentSectionHash(newDocumentId, section);
    }
  }
  return draft;
}

function unpack(row: StoredTemplate): DocumentTemplate {
  return { ...JSON.parse(row.metadata) as DocumentTemplateSummary, content: JSON.parse(row.content) as RichContent };
}

export class DocumentTemplatesService {
  constructor(private readonly store: Store, private readonly assets: DocumentTemplateAssetsService) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS document_templates (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
        name_key TEXT NOT NULL,
        archived INTEGER NOT NULL CHECK(archived IN (0,1)),
        metadata TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS document_template_active_name
        ON document_templates(COALESCE(project_id,''),name_key) WHERE archived=0;
      CREATE INDEX IF NOT EXISTS document_template_project ON document_templates(project_id,archived);
      CREATE TABLE IF NOT EXISTS document_template_creation_requests (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        template_id TEXT
      );
    `);
  }

  list(projectId: string | null, includeArchived = false): DocumentTemplateSummary[] {
    if (projectId !== null && !this.store.get<Project>('projects', projectId)) fail(404, '문서 공간을 찾을 수 없습니다.', 'template_not_found');
    const rows = this.store.db.prepare(`SELECT metadata FROM document_templates
      WHERE (project_id IS NULL OR project_id=?) AND (archived=0 OR ?=1)`)
      .all(projectId, Number(includeArchived)) as {metadata: string}[];
    return rows.map(row => JSON.parse(row.metadata) as DocumentTemplateSummary)
      .sort((left, right) => Number(left.archived) - Number(right.archived) || left.name.localeCompare(right.name, 'ko') || left.id.localeCompare(right.id));
  }

  all(): DocumentTemplate[] {
    return (this.store.db.prepare('SELECT metadata,content FROM document_templates ORDER BY id').all() as StoredTemplate[]).map(unpack);
  }

  create(actorId: string, raw: unknown, origins: readonly string[] = []): { template: DocumentTemplateSummary; duplicate: boolean } {
    const body = record(raw, ['requestId', 'name', 'sourceDocumentId', 'expectedDocumentVersion']);
    const { requestId, sourceDocumentId } = body;
    if (typeof requestId !== 'string' || !creationRequestId.test(requestId)) fail(400, '템플릿 등록 요청 ID를 확인해 주세요.', 'invalid_input');
    if (!identifier(sourceDocumentId)) fail(400, '원본 문서를 확인해 주세요.', 'invalid_input');
    const name = requireName(body.name);
    const sourceVersion = requestVersion(body.expectedDocumentVersion, '원본 문서');
    const fingerprint = creationRequestFingerprint({ name, sourceDocumentId, sourceVersion });
    const receiptId = requestId.toLowerCase();
    return this.store.transaction(() => {
      this.requireActor(actorId);
      const receipt = this.store.db.prepare('SELECT actor_id,fingerprint,template_id FROM document_template_creation_requests WHERE id=?')
        .get(receiptId) as CreationReceipt | undefined;
      if (receipt) {
        if (receipt.actor_id !== actorId || receipt.fingerprint !== fingerprint) {
          fail(409, '이미 사용한 템플릿 등록 요청입니다. 템플릿 목록을 확인해 주세요.', 'request_conflict');
        }
        const saved = receipt.template_id && this.summary(receipt.template_id);
        if (!saved) fail(409, '기존 등록 요청의 템플릿을 찾을 수 없습니다. 템플릿 목록을 확인해 주세요.', 'request_unavailable');
        return { template: saved, duplicate: true };
      }
      const { fields, assets } = this.capture(this.readSource(sourceDocumentId, sourceVersion), origins);
      const timestamp = new Date().toISOString();
      const template: DocumentTemplate = { id: randomUUID(), name, ...fields, version: 1,
        archived: false, createdBy: actorId, updatedBy: actorId, createdAt: timestamp, updatedAt: timestamp };
      this.requireAvailableName(template);
      const summary = this.put(template);
      this.assets.replace(template.id, assets);
      this.store.db.prepare('INSERT INTO document_template_creation_requests(id,actor_id,fingerprint,template_id) VALUES(?,?,?,?)')
        .run(receiptId, actorId, fingerprint, template.id);
      return { template: summary, duplicate: false };
    });
  }

  patch(id: string, actorId: string, raw: unknown, origins: readonly string[] = []): DocumentTemplateSummary {
    const body = record(raw, ['expectedVersion', 'name', 'archived', 'sourceDocumentId', 'expectedDocumentVersion']);
    const expected = requestVersion(body.expectedVersion, '템플릿');
    const replace = Object.hasOwn(body, 'sourceDocumentId');
    const sourceId = body.sourceDocumentId;
    let sourceVersion: number | undefined;
    if (replace !== Object.hasOwn(body, 'expectedDocumentVersion') || (replace && !identifier(sourceId))) {
      fail(400, '교체할 원본 문서와 버전을 확인해 주세요.', 'invalid_input');
    }
    if (replace) sourceVersion = requestVersion(body.expectedDocumentVersion, '원본 문서');
    const name = Object.hasOwn(body, 'name') ? requireName(body.name) : undefined;
    const archived = body.archived;
    if (Object.hasOwn(body, 'archived') && typeof archived !== 'boolean') fail(400, '보관 여부를 확인해 주세요.', 'invalid_input');
    if (name === undefined && archived === undefined && !replace) fail(400, '변경할 템플릿 항목을 확인해 주세요.', 'invalid_input');
    return this.store.transaction(() => {
      this.requireActor(actorId);
      const current = this.find(id);
      if (!current) return fail(404, '문서 템플릿을 찾을 수 없습니다.', 'template_not_found');
      this.requireVersion(current, expected);
      const source = typeof sourceId === 'string' && sourceVersion !== undefined
        ? this.readSource(sourceId, sourceVersion, current.projectId) : undefined;
      const snapshot = source && (source.id !== current.sourceDocumentId || source.version !== current.sourceVersion)
        ? this.capture(source, origins) : undefined;
      const replacement = { ...current, ...snapshot?.fields, name: name ?? current.name, archived: (archived as boolean | undefined) ?? current.archived };
      if (!snapshot && current.name === replacement.name && current.archived === replacement.archived) {
        return this.summary(id)!;
      }
      this.requireAvailableName(replacement);
      const summary = this.put({ ...replacement, version: nextVersion(current.version), updatedBy: actorId, updatedAt: new Date().toISOString() });
      if (snapshot) this.assets.replace(id, snapshot.assets);
      return summary;
    });
  }

  forDraft(id: string, expectedVersion: unknown, destinationProjectId: string | null): DocumentTemplate {
    const version = requestVersion(expectedVersion, '템플릿');
    const template = this.find(id);
    if (!template || (template.projectId !== null && template.projectId !== destinationProjectId)) {
      return fail(404, '선택한 문서 공간에서 템플릿을 찾을 수 없습니다.', 'template_not_found');
    }
    if (template.archived) fail(409, '보관된 문서 템플릿입니다. 다른 템플릿을 선택해 주세요.', 'template_archived', template.version);
    this.requireVersion(template, version);
    return template;
  }

  validateRestore(raw: unknown, projects: readonly Project[], users: readonly User[], exportedAt: unknown): DocumentTemplate[] {
    if (!Array.isArray(raw) || raw.length > 100000 || (raw.length && !isIsoTimestamp(exportedAt))) {
      return fail(400, INVALID_BACKUP, 'invalid_backup');
    }
    const projectIds = new Set(projects.map(project => project.id));
    const userIds = new Set(users.map(user => user.id));
    const ids = new Set<string>();
    const names = new Set<string>();
    return raw.map(value => {
      const row = record(value, BACKUP_FIELDS, true);
      const { id, projectId, icon, sourceDocumentId, sourceTitle, sourceVersion, version, archived, createdAt, updatedAt, createdBy, updatedBy, attachmentCount } = row;
      const name = nameValue(row.name);
      if (typeof id !== 'string' || !creationRequestId.test(id) || id !== id.toLowerCase() || ids.has(id) ||
          (projectId !== null && (typeof projectId !== 'string' || !projectIds.has(projectId))) || !name || name !== row.name ||
          !isIcon(icon) || !identifier(sourceDocumentId) || !isSourceTitle(sourceTitle) || !isVersion(sourceVersion) ||
          !isVersion(version) || typeof archived !== 'boolean' || !isIsoTimestamp(createdAt) || !isIsoTimestamp(updatedAt) ||
          (attachmentCount !== undefined && (typeof attachmentCount !== 'number' || !Number.isSafeInteger(attachmentCount) || attachmentCount < 0)) ||
          createdAt > updatedAt || typeof exportedAt !== 'string' || updatedAt > exportedAt ||
          typeof createdBy !== 'string' || !userIds.has(createdBy) || typeof updatedBy !== 'string' || !userIds.has(updatedBy)) {
        return fail(400, INVALID_BACKUP, 'invalid_backup');
      }
      const key = JSON.stringify([projectId, documentLabelKey(name)]);
      if (!archived && names.has(key)) fail(400, '백업의 같은 문서 공간에 활성 템플릿 이름이 중복됩니다.', 'invalid_backup');
      ids.add(id);
      if (!archived) names.add(key);
      return { id, projectId, name, icon, sourceDocumentId, sourceTitle, sourceVersion, version, archived, createdAt,
        updatedAt, createdBy, updatedBy, ...(attachmentCount !== undefined ? { attachmentCount } : {}), content: restoredTemplateContent(row.content) };
    });
  }

  /** The caller owns the transaction that replaces the workspace and its file data. */
  restore(templates: readonly DocumentTemplate[]): void {
    if (!this.store.db.isTransaction) throw new Error('Document template restoration requires a transaction.');
    const local = this.store.db.prepare("SELECT MAX(json_extract(metadata,'$.version')) AS version FROM document_templates")
      .get() as {version: number | null};
    const earlier: unknown = this.store.setting(RESTORE_VERSION_FLOOR);
    const floor = Math.max(local.version ?? 0, isVersion(earlier) ? earlier : 0);
    this.store.db.exec('DELETE FROM document_templates; UPDATE document_template_creation_requests SET template_id=NULL WHERE template_id IS NOT NULL;');
    let highestVersion = floor;
    for (const template of templates) {
      const version = Math.max(template.version, floor ? nextVersion(floor) : 1);
      this.put({ ...template, version });
      highestVersion = Math.max(highestVersion, version);
    }
    if (highestVersion) this.store.setSetting(RESTORE_VERSION_FLOOR, highestVersion);
  }

  private readSource(sourceId: string, version: number, scope?: string | null): DocPage {
    const document = this.store.get<DocPage>('documents', sourceId);
    if (!document) return fail(404, '원본 문서를 찾을 수 없습니다.', 'source_not_found');
    if (scope !== undefined && document.projectId !== scope) fail(400, '같은 문서 공간의 문서로 템플릿을 교체해 주세요.', 'template_scope');
    if (document.version !== version) {
      fail(409, '원본 문서가 변경되었습니다. 최신 저장본을 확인해 주세요.', 'source_version_conflict', document.version);
    }
    return document;
  }

  private capture(document: DocPage, origins: readonly string[]) {
    const { content, assets } = this.assets.capture(normalizeDocumentContent(document.content).content, document.id, origins);
    return { assets, fields: {
      projectId: document.projectId, sourceDocumentId: document.id, sourceTitle: document.title,
      sourceVersion: document.version, icon: document.icon, content, attachmentCount: assets.length || undefined,
    } };
  }

  private requireActor(id: string): void {
    if (!this.store.get<User>('users', id)) fail(400, '템플릿을 변경할 작업자를 확인해 주세요.', 'invalid_input');
  }

  private requireVersion(template: DocumentTemplateSummary, expected: number): void {
    if (template.version !== expected) {
      fail(409, '템플릿이 변경되었습니다. 최신 내용을 확인해 주세요.', 'template_version_conflict', template.version);
    }
  }

  private requireAvailableName(template: DocumentTemplateSummary): void {
    if (!template.archived && this.store.db.prepare(
      'SELECT 1 FROM document_templates WHERE project_id IS ? AND name_key=? AND archived=0 AND id<>?'
    ).get(template.projectId, documentLabelKey(template.name), template.id)) {
      fail(409, '이 문서 공간에 같은 이름의 활성 템플릿이 있습니다.', 'name_conflict');
    }
  }

  private find(id: string): DocumentTemplate | undefined {
    const row = this.store.db.prepare('SELECT metadata,content FROM document_templates WHERE id=?').get(id) as StoredTemplate | undefined;
    return row && unpack(row);
  }

  private summary(id: string): DocumentTemplateSummary | undefined {
    const row = this.store.db.prepare('SELECT metadata FROM document_templates WHERE id=?').get(id) as {metadata: string} | undefined;
    return row && JSON.parse(row.metadata) as DocumentTemplateSummary;
  }

  private put(template: DocumentTemplate): DocumentTemplateSummary {
    const { content, ...summary } = template;
    this.store.db.prepare(`INSERT INTO document_templates(id,project_id,name_key,archived,metadata,content)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      project_id=excluded.project_id,name_key=excluded.name_key,archived=excluded.archived,
      metadata=excluded.metadata,content=excluded.content`)
      .run(summary.id, summary.projectId, documentLabelKey(summary.name), Number(summary.archived), JSON.stringify(summary), JSON.stringify(content));
    return summary;
  }
}
