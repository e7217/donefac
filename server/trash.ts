import { randomUUID } from 'node:crypto';
import type {
  Attachment, AttachmentVersion, Comment, Dependency, DocPage, DocRevision,
  DocumentPublicationState, GitlabLink, Issue, IssueRelation, Project, ResourceLink,
  TrashEntrySummary, TrashPage, TrashResourceType, User,
} from '../shared/types.js';
import { attachmentId, MAX_FILE_BYTES, safeFilename } from './attachments.js';
import type { CollaborationExport } from './collaboration.js';
import { normalizeDocumentContent } from './document-content.js';
import { isDependencyLag, isDependencyType } from '../shared/schedule-dependencies.js';
import { isRestorableGitlabLink } from '../shared/gitlab-links.js';
import type { Store } from './store.js';

type ArchiveRows = {
  comments: Comment[];
  revisions: DocRevision[];
  attachments: Attachment[];
  attachmentVersions: AttachmentVersion[];
  dependencies: Dependency[];
  resourceLinks: ResourceLink[];
  issueRelations: IssueRelation[];
  gitlabLinks: GitlabLink[];
  milestoneIds: string[];
};
type ArchiveBase = Omit<TrashEntrySummary, 'resourceType'> & ArchiveRows;
type IssueArchive = ArchiveBase & {resourceType: 'issue'; resource: Issue; publication: null; collaboration: null};
type DocumentArchive = ArchiveBase & {
  resourceType: 'document'; resource: DocPage;
  publication: DocumentPublicationState | null; collaboration: CollaborationExport | null;
};
export type TrashArchive = IssueArchive | DocumentArchive;
type DocumentSnapshots = {publication?: DocumentPublicationState | null; collaboration?: CollaborationExport | null};
type ImportContext = {
  users: User[]; projects: Project[]; issues: Issue[]; documents: DocPage[];
  comments: Comment[]; revisions: DocRevision[]; attachments: Attachment[]; attachmentVersions?: AttachmentVersion[];
  dependencies: Dependency[]; resourceLinks: ResourceLink[]; issueRelations?: IssueRelation[]; gitlabLinks: GitlabLink[];
};

export class TrashError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) { super(message); }
}
function fail(status: number, message: string): never { throw new TrashError(status, message); }
function malformed(label: string): never { return fail(400, `백업의 휴지통 ${label}을(를) 확인해 주세요.`); }
function typeOf(value: unknown): TrashResourceType | null { return value === 'issue' || value === 'document' ? value : null; }
const tableFor = (type: TrashResourceType) => type === 'issue' ? 'issues' : 'documents';
const parseRows = <T>(rows: unknown[]): T[] => (rows as {json: string}[]).map(row => JSON.parse(row.json) as T);
const validString = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const validVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validDeletedAt = (value: unknown): value is string => validDate(value) && new Date(value).toISOString() === value;
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed(label);
  return value as Record<string, unknown>;
}
function uuid(value: unknown, label: string): string { try { return attachmentId(value); } catch { return malformed(label); } }
function reserve(seen: Set<string>, key: unknown, label: string) {
  if (!validString(key) || seen.has(key)) malformed(`${label} 식별자`);
  seen.add(key);
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 100000) malformed(`${label} 목록`);
  return value;
}
function collect<T extends {id: string}>(value: unknown, used: Set<string>, label: string, check: (row: Record<string, unknown>) => boolean): T[] {
  return array(value, label).map(input => {
    const row = record(input, label);
    reserve(used, row.id, label);
    if (!check(row)) malformed(label);
    return row as unknown as T;
  });
}
function formatSummary(entry: TrashArchive): TrashEntrySummary {
  const {id, resourceType, resourceId, projectId, title, issueKey, deletedAt, deletedById, parentId} = entry;
  return {id, resourceType, resourceId, projectId, title, issueKey, deletedAt, deletedById, parentId};
}

export class TrashService {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS trash_entries (
      id TEXT PRIMARY KEY, resource_type TEXT NOT NULL CHECK(resource_type IN ('issue','document')),
      resource_id TEXT NOT NULL, project_id TEXT, parent_id TEXT, deleted_at TEXT NOT NULL,
      json TEXT NOT NULL, summary TEXT NOT NULL, UNIQUE(resource_type,resource_id)
    );
    CREATE INDEX IF NOT EXISTS trash_deleted_at ON trash_entries(deleted_at DESC,id);
    CREATE INDEX IF NOT EXISTS trash_project_type ON trash_entries(project_id,resource_type,deleted_at DESC,id);
    CREATE INDEX IF NOT EXISTS trash_parent ON trash_entries(resource_type,parent_id);`);
  }
  private assertTransaction() {
    if (!this.store.db.isTransaction) fail(500, '휴지통 변경에는 트랜잭션이 필요합니다.');
  }
  private insert(entry: TrashArchive) {
    this.store.db.prepare(`INSERT INTO trash_entries(id,resource_type,resource_id,project_id,parent_id,deleted_at,json,summary)
      VALUES(?,?,?,?,?,?,?,?)`).run(entry.id, entry.resourceType, entry.resourceId, entry.projectId, entry.parentId,
      entry.deletedAt, JSON.stringify(entry), JSON.stringify(formatSummary(entry)));
  }
  capture(resourceType: 'issue', resource: Issue, deletedById: string): IssueArchive;
  capture(resourceType: 'document', resource: DocPage, deletedById: string, snapshots?: DocumentSnapshots): DocumentArchive;
  capture(resourceType: TrashResourceType, resource: Issue | DocPage, deletedById: string, snapshots?: DocumentSnapshots): TrashArchive {
    this.assertTransaction();
    const resourceId = resource.id, select = (sql: string, ...params: string[]) => this.store.db.prepare(sql).all(...params);
    const document = resourceType === 'document';
    const base: ArchiveBase = {
      id: randomUUID(), resourceId, projectId: resource.projectId, title: resource.title,
      issueKey: document ? null : (resource as Issue).key, parentId: resource.parentId,
      deletedById, deletedAt: new Date().toISOString(),
      comments: parseRows<Comment>(select('SELECT json FROM comments WHERE resource_type=? AND resource_id=? ORDER BY rowid', resourceType, resourceId)),
      revisions: document ? parseRows<DocRevision>(select('SELECT json FROM revisions WHERE document_id=? ORDER BY rowid', resourceId)) : [],
      attachments: parseRows<Attachment>(select('SELECT json FROM attachments WHERE resource_type=? AND resource_id=? ORDER BY rowid', resourceType, resourceId)),
      attachmentVersions: parseRows<AttachmentVersion>(select(`SELECT av.json FROM attachment_versions av JOIN attachments a ON a.id=av.attachment_id
        WHERE a.resource_type=? AND a.resource_id=? ORDER BY av.rowid`, resourceType, resourceId)),
      dependencies: document ? [] : parseRows<Dependency>(select('SELECT json FROM dependencies WHERE predecessor_id=? OR successor_id=? ORDER BY rowid', resourceId, resourceId)),
      resourceLinks: parseRows<ResourceLink>(select(`SELECT json FROM resource_links WHERE ${document ? 'document_id' : 'issue_id'}=? ORDER BY rowid`, resourceId)),
      issueRelations: document ? [] : parseRows<IssueRelation>(select('SELECT json FROM issue_relations WHERE source_issue_id=? OR target_issue_id=? ORDER BY rowid', resourceId, resourceId)),
      gitlabLinks: document ? [] : parseRows<GitlabLink>(select('SELECT json FROM gitlab_links WHERE issue_id=? ORDER BY rowid', resourceId)),
      milestoneIds: document ? [] : (select(`SELECT id FROM milestones WHERE project_id=? AND EXISTS (
        SELECT 1 FROM json_each(milestones.json,'$.issueIds') WHERE value=?) ORDER BY rowid`, (resource as Issue).projectId, resourceId) as {id: string}[]).map(row => row.id),
    };
    const entry: TrashArchive = document
      ? {...base, resourceType, resource: resource as DocPage, publication: snapshots?.publication ?? null, collaboration: snapshots?.collaboration ?? null}
      : {...base, resourceType, resource: resource as Issue, publication: null, collaboration: null};
    this.insert(entry);
    return entry;
  }
  get(id: string): TrashArchive {
    return this.store.get<TrashArchive>('trash_entries', id) ?? fail(404, '휴지통에서 이 항목을 찾을 수 없습니다.');
  }
  find(type: TrashResourceType, resourceId: string): TrashArchive | undefined {
    const row = this.store.db.prepare('SELECT json FROM trash_entries WHERE resource_type=? AND resource_id=?').get(type, resourceId) as {json: string} | undefined;
    return row && JSON.parse(row.json) as TrashArchive;
  }
  hasChildren(type: TrashResourceType, resourceId: string): boolean {
    return Boolean(this.store.db.prepare('SELECT 1 FROM trash_entries WHERE resource_type=? AND parent_id=? LIMIT 1').get(type, resourceId));
  }
  hasLocalAttachmentVersion(id: string): boolean {
    return Boolean(this.store.db.prepare(`SELECT 1 FROM trash_entries, json_each(trash_entries.json,'$.attachmentVersions') AS version
      WHERE json_extract(version.value,'$.id')=? AND json_type(version.value,'$.localRevision')='integer'
        AND json_extract(version.value,'$.localRevision')>=2 LIMIT 1`).get(id));
  }
  findGitlabBranchLink(cursorId: string): GitlabLink | undefined {
    const row = this.store.db.prepare(`SELECT link.value AS json
      FROM trash_entries, json_each(trash_entries.json,'$.gitlabLinks') AS link
      WHERE resource_type='issue' AND json_extract(link.value,'$.kind')='branch'
        AND json_extract(link.value,'$.id')=? || ':' || resource_id
      ORDER BY deleted_at DESC LIMIT 1`).get(cursorId) as {json: string} | undefined;
    return row && JSON.parse(row.json) as GitlabLink;
  }
  remove(id: string): void {
    this.assertTransaction();
    this.store.remove('trash_entries', id);
  }
  all(): TrashArchive[] { return this.store.all<TrashArchive>('trash_entries'); }
  list(query: Record<string, unknown>): TrashPage {
    if (Object.keys(query).some(key => !['scope','resourceType','projectId','offset','limit'].includes(key))) fail(400, '휴지통 조회 조건을 확인해 주세요.');
    const {scope = 'all', resourceType, projectId} = query;
    if (scope !== 'all' && scope !== 'project' && scope !== 'common' || resourceType !== undefined && !typeOf(resourceType) ||
      (scope === 'project' ? !validString(projectId) : projectId !== undefined)) fail(400, '휴지통 범위와 항목 종류를 확인해 주세요.');
    if (scope === 'project' && !this.store.get('projects', projectId as string)) fail(404, '프로젝트를 찾을 수 없습니다.');
    const readNumber = (value: unknown, fallback: number, min: number, max: number) => {
      if (value === undefined) return fallback;
      const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(number) || number < min || number > max) fail(400, '휴지통 페이지 범위를 확인해 주세요.');
      return number;
    };
    const offset = readNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = readNumber(query.limit, 50, 1, 100);
    const conditions: string[] = [], params: string[] = [];
    if (scope === 'project') { conditions.push('project_id=?'); params.push(projectId as string); }
    if (scope === 'common') conditions.push('project_id IS NULL');
    if (resourceType) { conditions.push('resource_type=?'); params.push(resourceType as string); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const {total} = this.store.db.prepare(`SELECT COUNT(*) total FROM trash_entries ${where}`).get(...params) as {total: number};
    const rows = this.store.db.prepare(`SELECT summary AS json FROM trash_entries ${where} ORDER BY deleted_at DESC,id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return {items: parseRows<TrashEntrySummary>(rows), total, offset, limit};
  }
  restoreChildren(archive: TrashArchive): void {
    this.assertTransaction();
    const restore = (table: string, values: {id: string}[]) => {
      for (const value of values) {
        if (this.store.get(table, value.id)) fail(409, '휴지통 항목의 데이터와 현재 항목 ID가 충돌합니다.');
        this.store.put(table, value);
      }
    };
    // Retain comments and authors without re-emitting historic comment.created events.
    this.store.withMutationContext({origin: 'import', actorId: null}, () => restore('comments', archive.comments));
    restore('revisions', archive.revisions);
    restore('attachments', archive.attachments);
    restore('gitlab_links', archive.gitlabLinks);
    const insert = this.store.db.prepare('INSERT INTO attachment_versions(id,attachment_id,json) VALUES(?,?,?)');
    for (const value of archive.attachmentVersions) insert.run(value.id, value.attachmentId, JSON.stringify(value));
  }
  restoreLinks(archive: TrashArchive, guards: {dependency: (value: Dependency) => string | undefined}): string[] {
    this.assertTransaction();
    const warnings: string[] = [];
    const endpoint = (kind: TrashResourceType, id: string) => ({kind, id});
    const targets = (left: ReturnType<typeof endpoint>, right: ReturnType<typeof endpoint>) => [left, right];
    const resolve = <K extends 'dependencies' | 'resourceLinks' | 'issueRelations'>(
      key: K, value: ArchiveRows[K][number], endpoints: ReturnType<typeof targets>, label: string, put: () => string | undefined,
    ) => {
      const missing = endpoints.find(({kind, id}) => !this.store.get(tableFor(kind), id));
      if (missing) {
        const other = this.find(missing.kind, missing.id);
        if (other) {
          const values = other[key] as {id: string}[];
          if (!values.some(candidate => candidate.id === value.id)) {
            values.push(value);
            this.store.db.prepare('UPDATE trash_entries SET json=? WHERE id=?').run(JSON.stringify(other), other.id);
          }
        } else warnings.push(`${label}의 상대 항목이 삭제되어 연결을 복원하지 않았습니다.`);
        return;
      }
      const warning = put();
      if (warning) warnings.push(warning);
    };
    for (const value of archive.dependencies) resolve('dependencies', value,
      targets(endpoint('issue', value.predecessorId), endpoint('issue', value.successorId)), '선후행 일정', () => {
        const existing = this.store.db.prepare('SELECT json FROM dependencies WHERE predecessor_id=? AND successor_id=?').get(value.predecessorId, value.successorId) as {json: string} | undefined;
        if (existing) {
          const current=JSON.parse(existing.json) as Dependency;
          return current.type===value.type&&current.lagDays===value.lagDays ? undefined : '선후행 일정에 현재 설정된 유형과 간격을 유지했습니다.';
        }
        if (this.store.get('dependencies', value.id)) return '선후행 일정 ID가 충돌하여 기존 연결을 유지했습니다.';
        const version=(value.version??1)+1;
        if(!Number.isSafeInteger(version))return '선후행 일정의 버전 범위를 초과했습니다.';
        const restored={...value,version};
        const error = guards.dependency(restored);
        if (error) return `선후행 일정을 복원하지 않았습니다. ${error}`;
        this.store.put('dependencies', restored);
      });
    for (const value of archive.resourceLinks) resolve('resourceLinks', value,
      targets(endpoint('issue', value.issueId), endpoint('document', value.documentId)), '업무·문서 연결', () => {
        const existing = this.store.db.prepare('SELECT json FROM resource_links WHERE issue_id=? AND document_id=?').get(value.issueId, value.documentId) as {json: string} | undefined;
        if (existing) return (JSON.parse(existing.json) as ResourceLink).kind === value.kind ? undefined : '업무·문서 사이에 현재 설정된 연결을 유지했습니다.';
        if (this.store.get('resource_links', value.id)) return '업무·문서 연결 ID가 충돌하여 기존 연결을 유지했습니다.';
        this.store.put('resource_links', value);
      });
    const insertRelation = this.store.db.prepare('INSERT INTO issue_relations(id,source_issue_id,target_issue_id,json) VALUES(?,?,?,?)');
    for (const value of archive.issueRelations) resolve('issueRelations', value,
      targets(endpoint('issue', value.sourceIssueId), endpoint('issue', value.targetIssueId)), '업무 관계', () => {
        const existing = this.store.get<IssueRelation>('issue_relations', value.id);
        if (existing) return existing.sourceIssueId === value.sourceIssueId && existing.targetIssueId === value.targetIssueId && existing.type === value.type
          ? undefined : '업무 관계 ID가 충돌하여 기존 관계를 유지했습니다.';
        insertRelation.run(value.id, value.sourceIssueId, value.targetIssueId, JSON.stringify(value));
      });
    return warnings;
  }

  validateImport(raw: unknown, context: ImportContext): TrashArchive[] {
    const ids = (rows: {id: string}[] = []) => new Set(rows.map(row => row.id));
    const reserved = {
      entries: new Set<string>(), issues: ids(context.issues), documents: ids(context.documents),
      issueKeys: new Set(context.issues.map(issue => issue.key)), comments: ids(context.comments), revisions: ids(context.revisions),
      attachments: ids(context.attachments), versions: ids(context.attachmentVersions), dependencies: ids(context.dependencies),
      resourceLinks: ids(context.resourceLinks), issueRelations: ids(context.issueRelations), gitlabLinks: ids(context.gitlabLinks),
    };
    const projects = ids(context.projects), users = ids(context.users);
    const isUser = (value: unknown) => validString(value) && users.has(value);
    const result = array(raw, '항목').map(item => {
      const entry = record(item, '항목'), resourceType = typeOf(entry.resourceType), id = uuid(entry.id, '항목 ID');
      if (!resourceType || !isUser(entry.deletedById) || !validDeletedAt(entry.deletedAt)) malformed('유형·삭제 이력');
      reserve(reserved.entries, id, '항목');
      const resource = record(entry.resource, '원래 항목');
      if (resource.id !== entry.resourceId || resource.projectId !== entry.projectId || resource.parentId !== entry.parentId ||
        resource.title !== entry.title || !validString(resource.title) || resource.title.length > 300 ||
        !(entry.parentId === null || validString(entry.parentId) && entry.parentId !== resource.id) ||
        !(entry.projectId === null && resourceType === 'document' || validString(entry.projectId) && projects.has(entry.projectId)) ||
        !validVersion(resource.version) || !validDate(resource.createdAt) || !validDate(resource.updatedAt)) malformed('원래 항목 메타데이터');
      reserve(reserved[tableFor(resourceType)], entry.resourceId, '원래 항목');
      if (resourceType === 'issue') {
        if (entry.issueKey !== resource.key || !validString(resource.status) || !validString(resource.type) ||
          resource.assigneeId !== null && !isUser(resource.assigneeId) || !Array.isArray(resource.collaboratorIds) || !resource.collaboratorIds.every(isUser)) malformed('업무 정보');
        reserve(reserved.issueKeys, resource.key, '업무 키');
      } else {
        if (entry.issueKey !== null || !isUser(resource.authorId) || resource.status !== 'draft' && resource.status !== 'published') malformed('문서 정보');
        normalizeDocumentContent(resource.content);
      }
      const isOwned = (row: Record<string, unknown>) => row.resourceId === entry.resourceId && row.resourceType === resourceType;
      const comments = collect<Comment>(entry.comments, reserved.comments, '댓글', row => isOwned(row) && isUser(row.authorId) && validDate(row.createdAt) && validString(row.body) && row.body.length <= 20000);
      const revisions = collect<DocRevision>(entry.revisions, reserved.revisions, '문서 이력', row => {
        if (resourceType !== 'document' || row.documentId !== entry.resourceId || !isUser(row.authorId) || !validDate(row.createdAt) ||
          !validVersion(row.version) || !validString(row.title) || typeof row.summary !== 'string') return false;
        normalizeDocumentContent(row.content);
        return true;
      });
      const checkFile = (row: Record<string, unknown>) => {
        uuid(row.id, '첨부 ID');
        try { safeFilename(row.filename); } catch { return false; }
        return isOwned(row) && isUser(row.authorId) && validDate(row.createdAt) && validString(row.mimeType) &&
          typeof row.sha256 === 'string' && /^[a-f\d]{64}$/.test(row.sha256) && typeof row.size === 'number' && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= MAX_FILE_BYTES;
      };
      const attachments = collect<Attachment>(entry.attachments, reserved.attachments, '첨부', checkFile);
      const roots = ids(attachments);
      const attachmentVersions = collect<AttachmentVersion>(entry.attachmentVersions, reserved.versions, '첨부 버전', row =>
        checkFile(row) && validString(row.attachmentId) && roots.has(row.attachmentId));
      const idInPair = (a: unknown, b: unknown) => validString(a) && validString(b) && a !== b && [a,b].includes(entry.resourceId as string);
      const dependencies = collect<Dependency>(entry.dependencies, reserved.dependencies, '선후행 일정', row =>
        resourceType === 'issue' && idInPair(row.predecessorId, row.successorId) && isDependencyType(row.type) && isDependencyLag(row.lagDays) &&
        (row.version===undefined||typeof row.version==='number'&&Number.isSafeInteger(row.version)&&row.version>0));
      const resourceLinks = collect<ResourceLink>(entry.resourceLinks, reserved.resourceLinks, '업무·문서 연결', row =>
        validString(row.issueId) && validString(row.documentId) && row[resourceType === 'issue' ? 'issueId' : 'documentId'] === entry.resourceId && validString(row.kind));
      const issueRelations = collect<IssueRelation>(entry.issueRelations, reserved.issueRelations, '업무 관계', row =>
        resourceType === 'issue' && idInPair(row.sourceIssueId, row.targetIssueId) && validString(row.type) && validVersion(row.version) && validDate(row.createdAt));
      const gitlabLinks = collect<GitlabLink>(entry.gitlabLinks, reserved.gitlabLinks, 'GitLab 연결', row =>
        resourceType === 'issue' && row.issueId === entry.resourceId && isRestorableGitlabLink(row));
      const seenMilestones = new Set<string>();
      const milestoneIds = array(entry.milestoneIds, '이정표').map(value => {
        if (resourceType !== 'issue' || !validString(value)) malformed('이정표 ID');
        reserve(seenMilestones, value, '이정표');
        return value;
      });
      if (resourceType === 'issue' && (entry.publication !== null || entry.collaboration !== null)) malformed('업무의 문서 상태');
      for (const snapshot of [entry.publication, entry.collaboration]) {
        if (snapshot !== null && record(snapshot, '문서 상태').documentId !== entry.resourceId) malformed('문서 상태·대상 ID');
      }
      return {...entry, comments, revisions, attachments, attachmentVersions, dependencies, resourceLinks, issueRelations, gitlabLinks, milestoneIds} as unknown as TrashArchive;
    });
    const parents = new Map([...context.issues.map(value => ['issue', value] as const), ...context.documents.map(value => ['document', value] as const),
      ...result.map(value => [value.resourceType, value.resource] as const)].map(([type, value]) => [`${type}:${value.id}`, value]));
    const checked = new Set<string>();
    for (const entry of result) {
      const seen = new Set([`${entry.resourceType}:${entry.resourceId}`]);
      let parentId = entry.parentId;
      while (parentId) {
        const key = `${entry.resourceType}:${parentId}`;
        if (checked.has(key)) break;
        if (seen.has(key)) malformed('부모 항목 순환 관계');
        seen.add(key);
        // A live document can move to another project while its child is in the trash.
        // Keep the snapshot importable and let the restore route resolve that conflict.
        const parent = parents.get(key);
        if (!parent) malformed('부모 항목');
        parentId = parent.parentId;
      }
      for (const key of seen) checked.add(key);
    }
    return result;
  }

  replaceImported(entries: TrashArchive[]): void {
    this.assertTransaction();
    this.store.db.exec('DELETE FROM trash_entries');
    for (const entry of entries) this.insert(entry);
  }
}
