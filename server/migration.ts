import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Express, Request } from 'express';
import type { AttachmentVersion, DocPage, Issue, LegacyDiagnostic, LegacyPackageDetail, LegacyPackageSummary, LegacyRecord, LegacySource, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview, Project, ProjectIssueSchema, ProjectWorkflow, SourceImport, SourceRecordArchive, User } from '../shared/types.js';
import { defaultIssueSchema } from '../shared/issue-schema.js';
import { defaultWorkflow } from '../shared/workflow-helpers.js';
import { isDocumentSectionId } from '../shared/document-sections.js';
import { LegacyImportError } from './legacy-import-model.js';
import { buildMigrationOptions } from './migration-planner.js';
import type { MigrationAppendContext, MigrationJiraRefreshCandidate, MigrationPackage, MigrationPageAppendContext, PreparedMigration } from './migration-contracts.js';
import type { MigrationSourceFile, MigrationWork } from './migration-work.js';
import { AttachmentAppend, type AppendedFile } from './attachment-append.js';
import { AttachmentFiles } from './attachments.js';
import { jiraAttachmentOwnerAliases, jiraAttachmentSourceId, jiraHistoryOwnerAliases, jiraHistorySourceKey } from './migration-jira-history.js';
import type { Store } from './store.js';
import type { LegacyImportService } from './legacy-import.js';
import { confluenceAttachmentOrigin, confluenceHistoryPage, confluenceHistoryVersion, parseMigrationAppendConfiguration, parseMigrationPageAppendConfiguration, type SourcePreservationService } from './source-preservation.js';

const MiB = 1024 * 1024;
const fail = (status: number, message: string): never => { throw new LegacyImportError(status, message); };
const unique = (values: string[]) => new Set(values).size === values.length;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const generationKey = 'migrationWorkspaceGeneration';
const conversionVersion = 3;
const MAX_REFRESH_ISSUES = 1000;
const MAX_REFRESH_DOCUMENTS = 300;
const MAX_REFRESH_BYTES = 64 * MiB;
const MAX_REUSED_FILE_BYTES = 256 * MiB;
type PreviewRow = { json: string; generation: string; conversionVersion: number | null };
type JiraArchiveRow = { id: string; json: string; importId: string };
type AppendDestination = Pick<MigrationAppendContext, 'project' | 'workflow' | 'schema'> & {
  instanceKey: string; sourceProjectId: string; originalSourceProjectId: string;
};
type JiraSparseRecords = { history?: true; attachments?: true };
type PageAppendDestination = Pick<MigrationPageAppendContext, 'project' | 'sourceSpaceId' | 'sourceSpaceKey'> & { instanceKey: string };
const invalidAppend = '같은 Jira 인스턴스에서 이관한 단일 원본 프로젝트와 기존 추가 대상을 선택해 주세요.';
const changedAppend = '추가 대상의 프로젝트 설정, 업무 버전·번호 또는 원본 연결이 변경되었습니다. 새 미리보기를 만들어 주세요.';
const invalidPageAppend = '같은 Confluence 인스턴스에서 이관한 단일 원본 공간과 기존 추가 대상을 선택해 주세요.';
const changedPageAppend = '대상 프로젝트, 원본 연결 또는 문서·첨부 이력이 변경되었습니다. 새 미리보기를 만들어 주세요.';
const jiraProjectKey = /^[A-Z][A-Z0-9_]*$/;
const jiraNumericId = /^\d+$/;

type Hooks = {
  actor: (request: Request) => string;
  validateIssueUpdates?: (prepared: PreparedMigration, request: Request) => void;
  validateDocumentUpdates?: (prepared: PreparedMigration, request: Request) => void;
  persistCanonical: (prepared: PreparedMigration, request: Request) => void;
  afterApply?: (prepared: PreparedMigration) => void;
};

export class MigrationService {
  private readonly append: AttachmentAppend;
  private readonly files: AttachmentFiles;
  private closed = false;
  private current: { abort: () => void } | null = null;
  private busy = false;

  constructor(private readonly store: Store, private readonly dataDir: string, private readonly legacy: LegacyImportService, private readonly sources: SourcePreservationService, hasArchivedVersion: (id: string) => boolean) {
    this.append = new AttachmentAppend(dataDir);
    this.files = new AttachmentFiles(dataDir);
    this.append.recover(id => this.sources.hasImport(id) || this.sources.hasLocalAttachmentVersion(id) || hasArchivedVersion(id));
    store.db.exec(`CREATE TABLE IF NOT EXISTS migration_previews (
      id TEXT PRIMARY KEY, expires_at TEXT NOT NULL, generation TEXT NOT NULL, size INTEGER NOT NULL, json TEXT NOT NULL
    )`);
    this.prune();
  }

  private generation(): string { return this.store.setting(generationKey) || 'initial'; }
  resetForNativeImport() {
    this.store.db.exec('DELETE FROM migration_previews');
    this.store.setSetting(generationKey, randomUUID());
  }
  private prune() { this.store.db.prepare('DELETE FROM migration_previews WHERE expires_at<=?').run(new Date().toISOString()); }
  private reserve() {
    if (this.closed) fail(503, '이관 서비스가 종료되었습니다.');
    if (this.busy) fail(409, '다른 이관 요청을 처리하고 있습니다. 완료 후 다시 시도해 주세요.');
    this.busy = true;
  }
  private packageIds(input: unknown): string[] {
    const values = typeof input === 'string' ? [input] : input;
    if (!Array.isArray(values) || !values.length || values.length > 20 ||
        values.some(value => typeof value !== 'string' || !uuid.test(value)) || !unique(values)) {
      return fail(400, '분석한 원본 패키지를 중복 없이 1~20개 선택해 주세요.');
    }
    return values;
  }
  private loadPackages(ids: string[], optionsOnly = false): MigrationPackage[] {
    const details = ids.map(id => this.legacy.detail(id));
    if (details.reduce((sum, item) => sum + item.summary.expandedBytes, 0) > 256 * MiB ||
        details.reduce((sum, item) => sum + Object.values(item.summary.counts).reduce((n, count) => n + count, 0), 0) > 100000) {
      fail(413, '한 번에 해제 크기 256MiB, 원본 객체 100000개까지 이관할 수 있습니다.');
    }
    const recordJson = optionsOnly ? "json_set(json,'$.text','')" : 'json';
    const records = this.store.db.prepare(`SELECT ${recordJson} AS json FROM legacy_records WHERE package_id=? ORDER BY rowid`);
    const diagnostics = this.store.db.prepare('SELECT json FROM legacy_diagnostics WHERE package_id=? ORDER BY rowid');
    return details.map(({ summary, unsupported }) => ({
      summary,
      dataset: {
        source: summary.source,
        records: (records.all(summary.id) as { json: string }[]).map(row => JSON.parse(row.json) as LegacyRecord),
        diagnostics: optionsOnly ? [] : (diagnostics.all(summary.id) as { json: string }[]).map(row => JSON.parse(row.json) as LegacyDiagnostic),
        unsupported,
      },
    }));
  }
  private sourceInstance(packages: MigrationPackage[], product: LegacySource['product']): string | undefined {
    const key = packages[0]?.summary.source.instanceKey;
    return key && packages.every(({ summary }) => summary.source.product === product && summary.source.instanceKey === key) ? key : undefined;
  }
  private projectBinding(product: LegacySource['product'], instanceKey: string, sourceId: string) {
    return this.store.db.prepare(`SELECT target_id AS id, import_id AS importId FROM source_bindings
      WHERE product=? AND source_instance=? AND kind='project' AND source_alias=? AND target_type='project'`)
      .get(product, instanceKey, sourceId) as { id: string; importId: string } | undefined;
  }
  private appendDestination(packages: MigrationPackage[], options: MigrationOptions, sparse: JiraSparseRecords = {}): AppendDestination | undefined {
    const instanceKey = this.sourceInstance(packages, 'jira');
    if (!instanceKey) return;
    const issueContainers = options.containers.filter(container => container.issueCount > 0);
    const sourceProjectId = issueContainers[0]?.sourceProjectId ?? this.sparseJiraProject(packages, instanceKey, sparse);
    if (!sourceProjectId || sourceProjectId === '__unassigned__' || issueContainers.some(container => container.sourceProjectId !== sourceProjectId)) return;
    let originalSourceProjectId = sourceProjectId;
    let projectId = this.projectBinding('jira', instanceKey, sourceProjectId)?.id;
    if (!projectId) {
      const officialKeys = new Set<string>();
      for (const pkg of packages) {
        const row = pkg.dataset.records.find(record => record.kind === 'project' && record.sourceId === sourceProjectId);
        for (const value of [row?.metadata.key, row?.metadata.pkey]) {
          if (typeof value === 'string' && jiraProjectKey.test(value)) officialKeys.add(value);
        }
      }
      if (officialKeys.size !== 1) return;
      const key = [...officialKeys][0];
      if (sourceProjectId !== key && !jiraNumericId.test(sourceProjectId)) return;
      // A search export can use the Jira key where a backup uses the numeric ID.
      // Resolve that difference only when the archived project proves it uniquely.
      const previous = this.store.db.prepare(`SELECT DISTINCT source_id AS sourceId, target_id AS id FROM source_records
        WHERE product='jira' AND source_instance=? AND kind='project' AND target_type='project' AND
          (json_extract(json,'$.record.metadata.key')=? OR json_extract(json,'$.record.metadata.pkey')=?)`)
        .all(instanceKey, key, key) as { sourceId: string; id: string }[];
      if (previous.length !== 1 || (sourceProjectId === key ? !jiraNumericId.test(previous[0].sourceId) : previous[0].sourceId !== key)) return;
      projectId = previous[0].id;
      originalSourceProjectId = previous[0].sourceId;
    }
    const project = this.store.get<Project>('projects', projectId);
    if (!project) return;
    const workflow = this.store.get<ProjectWorkflow>('workflows', project.id) || defaultWorkflow(project.id, project.createdAt);
    const schema = this.store.get<ProjectIssueSchema>('issue_schemas', project.id) || defaultIssueSchema(project.id, project.createdAt);
    return { project, workflow, schema, instanceKey, sourceProjectId, originalSourceProjectId };
  }
  private sparseJiraProject(packages: MigrationPackage[], instanceKey: string, { history, attachments }: JiraSparseRecords): string | undefined {
    if (!history && !attachments) return;
    const aliases = new Set<string>();
    for (const { dataset } of packages) for (const row of dataset.records) {
      const owners = history && jiraHistorySourceKey(row) ? jiraHistoryOwnerAliases(row) :
        attachments && jiraAttachmentSourceId(row) ? jiraAttachmentOwnerAliases(row) : null;
      for (const alias of owners ?? []) aliases.add(alias);
    }
    const origins = this.sources.jiraIssueOrigins(instanceKey, [...aliases], 'alias');
    const projects = new Set(origins.map(row => row.sourceProjectId));
    return projects.size === 1 ? [...projects][0] : undefined;
  }
  private appendContext(configuration: MigrationConfiguration, packages: MigrationPackage[], applying = false): MigrationAppendContext | undefined {
    const mapping = configuration.appendTo;
    if (!mapping) return;
    const destination = this.appendDestination(packages, buildMigrationOptions(packages), {
      history: mapping.refreshHistory, attachments: mapping.refreshAttachments,
    });
    if (!destination || destination.project.id !== mapping.projectId) {
      return fail(applying ? 409 : 400, applying ? changedAppend : invalidAppend);
    }
    const { project, workflow, schema, instanceKey, sourceProjectId } = destination;
    const sequence = this.store.db.prepare('SELECT next_number AS value FROM issue_sequences WHERE project_id=?')
      .get(project.id) as { value: number } | undefined;
    if (!sequence || !Number.isSafeInteger(sequence.value) || sequence.value < 1) return fail(409, changedAppend);
    const knownIssues = this.store.db.prepare(`SELECT binding.source_alias AS alias, binding.target_id AS issueId, issue.project_id AS projectId
      FROM source_bindings AS binding LEFT JOIN issues AS issue ON issue.id=binding.target_id
      WHERE binding.product='jira' AND binding.source_instance=? AND binding.kind='issue' AND binding.target_type='issue'
      ORDER BY binding.source_alias`).all(instanceKey) as MigrationAppendContext['knownIssues'];
    const digest = createHash('sha256').update(JSON.stringify([instanceKey, sourceProjectId, project, workflow, schema, sequence.value, knownIssues]));
    const refreshIssues = mapping.refreshExisting || mapping.refreshCustomFields
      ? this.jiraRefreshIssues(packages, configuration, knownIssues, project.id, instanceKey, digest)
      : undefined;
    const history = mapping.refreshHistory ? this.jiraHistoryContext(packages, configuration, knownIssues, destination, digest) : undefined;
    const attachments = mapping.refreshAttachments ? this.jiraAttachmentContext(packages, configuration, knownIssues, destination, digest) : undefined;
    return { project, workflow, schema, nextIssueNumber: sequence.value, token: digest.digest('hex'), knownIssues,
      ...(refreshIssues ? { refreshIssues } : {}), ...history, ...attachments };
  }
  private jiraChildIssues(packages: MigrationPackage[], configuration: MigrationConfiguration, knownIssues: MigrationAppendContext['knownIssues'],
    { project, instanceKey, sourceProjectId, originalSourceProjectId }: AppendDestination, select: (row: LegacyRecord) => string[] | null) {
    const excluded = new Set(configuration.excludedRecords);
    const live = new Map(knownIssues.filter(issue => issue.projectId === project.id).map(issue => [issue.alias, issue.issueId]));
    const candidates = new Set<string>();
    const addCandidate = (alias: string) => { const issueId = live.get(alias); if (issueId) candidates.add(issueId); };
    for (const { summary, dataset } of packages) {
      const aliases = new Set<string>();
      for (const row of dataset.records) {
        if (excluded.has(`${summary.id}/${row.id}`)) continue;
        for (const alias of select(row) ?? []) { aliases.add(alias); addCandidate(alias); }
      }
      for (const row of dataset.records) {
        if (row.kind !== 'issue' || excluded.has(`${summary.id}/${row.id}`)) continue;
        const issueAliases = typeof row.metadata.key === 'string' ? [row.sourceId, row.metadata.key] : [row.sourceId];
        if (issueAliases.some(alias => aliases.has(alias))) issueAliases.forEach(addCandidate);
      }
    }
    const sourceProjects = new Set([sourceProjectId, originalSourceProjectId]);
    const origins = this.sources.jiraIssueOrigins(instanceKey, [...candidates], 'issue').filter(origin =>
      origin.projectId === project.id && sourceProjects.has(origin.sourceProjectId));
    const owners = JSON.stringify([...new Set(origins.map(origin => origin.issueId))]);
    const issues = this.store.db.prepare(`SELECT id, project_id AS projectId, json_extract(json,'$.key') AS key,
      json_extract(json,'$.title') AS title FROM issues WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .all(project.id, owners) as NonNullable<MigrationAppendContext['historyIssues']>;
    return { origins, issues };
  }
  private jiraHistoryContext(packages: MigrationPackage[], configuration: MigrationConfiguration, knownIssues: MigrationAppendContext['knownIssues'],
    destination: AppendDestination, digest: ReturnType<typeof createHash>): Pick<MigrationAppendContext, 'historyIssues' | 'knownHistory'> {
    const selected = { comment: new Set<string>(), worklog: new Set<string>() };
    const { origins, issues: historyIssues } = this.jiraChildIssues(packages, configuration, knownIssues, destination, row => {
      const source = jiraHistorySourceKey(row);
      if (!source) return null;
      selected[source.kind].add(source.sourceId);
      return jiraHistoryOwnerAliases(row);
    });
    const known = this.sources.jiraKnownHistory(destination.instanceKey, { comment: [...selected.comment], worklog: [...selected.worklog] });
    // An unrelated local change to a ticket title is not a history conflict.
    digest.update('\njira-history\n').update(JSON.stringify([origins, historyIssues.map(issue => issue.id), known]));
    return { historyIssues, knownHistory: known.map(({ kind, sourceId, issueId }) => ({ kind, sourceId, issueId })) };
  }
  private jiraAttachmentContext(packages: MigrationPackage[], configuration: MigrationConfiguration, knownIssues: MigrationAppendContext['knownIssues'],
    destination: AppendDestination, digest: ReturnType<typeof createHash>): Pick<MigrationAppendContext, 'attachmentIssues' | 'knownAttachments'> {
    const selected = new Set<string>();
    const { origins, issues } = this.jiraChildIssues(packages, configuration, knownIssues, destination, row => {
      const sourceId = jiraAttachmentSourceId(row);
      if (!sourceId) return null;
      selected.add(sourceId);
      return jiraAttachmentOwnerAliases(row);
    });
    const attachmentIssues = issues.map(({ id, projectId }) => ({ id, projectId }));
    const known = this.sources.jiraKnownAttachments(destination.instanceKey, [...selected]);
    digest.update('\njira-attachments\n').update(JSON.stringify([origins, attachmentIssues, known]));
    return { attachmentIssues, knownAttachments: known.map(({ sourceId, issueId }) => ({ sourceId, issueId })) };
  }
  private jiraRefreshIssues(packages: MigrationPackage[], configuration: MigrationConfiguration, knownIssues: MigrationAppendContext['knownIssues'], projectId: string, instanceKey: string, digest: ReturnType<typeof createHash>): MigrationJiraRefreshCandidate[] {
    const refreshCustomFields = configuration.appendTo?.refreshCustomFields === true;
    const live = new Map(knownIssues.filter(issue => issue.projectId === projectId).map(issue => [issue.alias, issue.issueId]));
    const excluded = new Set(configuration.excludedRecords);
    const selected = new Set<string>();
    for (const { summary, dataset } of packages) for (const row of dataset.records) {
      if (row.kind !== 'issue' || excluded.has(`${summary.id}/${row.id}`)) continue;
      const byId = live.get(row.sourceId);
      const byKey = typeof row.metadata.key === 'string' ? live.get(row.metadata.key) : undefined;
      if (byId) selected.add(byId);
      if (byKey) selected.add(byKey);
    }
    if (selected.size > MAX_REFRESH_ISSUES) fail(413, '기존 Jira 업무의 변경은 한 번에 1000개까지 검토할 수 있습니다. 패키지를 나누어 주세요.');

    const oldIssue = this.store.db.prepare('SELECT json FROM issues WHERE id=? AND project_id=?');
    const linkedArchives = `SELECT archive.id, archive.json, archive.import_id AS importId FROM source_records AS archive
      JOIN source_imports AS receipt ON receipt.id=archive.import_id
      WHERE archive.target_type='issue' AND archive.target_id=? AND archive.product='jira' AND archive.source_instance=? AND archive.kind='issue'
        AND json_extract(archive.json,'$.targetProjectId')=?`;
    // Each option advances only its own comparison baseline. Use receipt time so
    // restored rows produce the same order regardless of their insertion order.
    const latestArchive = this.store.db.prepare(`${linkedArchives} AND json_type(archive.json,?)='object'
      ORDER BY julianday(json_extract(receipt.json,'$.createdAt')) DESC, archive.id DESC LIMIT 1`);
    const initialArchive = this.store.db.prepare(`${linkedArchives}
      ORDER BY julianday(json_extract(receipt.json,'$.createdAt')), archive.id LIMIT 1`);
    const receipts = new Map<string, SourceImport | undefined>();
    const candidates: MigrationJiraRefreshCandidate[] = [];
    let bytes = 0;
    const include = (json: string) => {
      bytes += Buffer.byteLength(json);
      if (bytes > MAX_REFRESH_BYTES) fail(413, '검토에 필요한 기존 Jira 원본이 64MiB를 넘습니다. 패키지를 나누어 주세요.');
      digest.update(json).update('\n');
    };
    const readBaseline = (row: JiraArchiveRow, issueId: string): MigrationJiraRefreshCandidate['previous'] | undefined => {
      include(row.json);
      const archive = JSON.parse(row.json) as SourceRecordArchive;
      if (!receipts.has(row.importId)) {
        const receipt = this.store.get<SourceImport>('source_imports', row.importId);
        if (receipt) include(JSON.stringify(receipt));
        receipts.set(row.importId, receipt);
      }
      const receipt = receipts.get(row.importId);
      const pkg = receipt?.packages.find(pkg => pkg.sha256 === archive.packageSha256 && pkg.source.product === 'jira' && pkg.source.instanceKey === instanceKey);
      if (!receipt || !pkg || archive.targetId !== issueId || archive.targetProjectId !== projectId) return undefined;
      return { archive, stagingId: pkg.stagingId, configuration: receipt.configuration };
    };

    digest.update('\njira-refresh\n');
    for (const issueId of [...selected].sort()) {
      const current = oldIssue.get(issueId, projectId) as { json: string } | undefined;
      const standard = latestArchive.get(issueId, instanceKey, projectId, '$.jiraIssueFieldHashes') as JiraArchiveRow | undefined;
      const custom = refreshCustomFields
        ? latestArchive.get(issueId, instanceKey, projectId, '$.jiraCustomFieldHashes') as JiraArchiveRow | undefined : undefined;
      const initial = !standard || (refreshCustomFields && !custom)
        ? initialArchive.get(issueId, instanceKey, projectId) as JiraArchiveRow | undefined : undefined;
      const previous = standard ?? initial;
      const previousCustom = refreshCustomFields ? custom ?? initial : undefined;
      digest.update(JSON.stringify([issueId, Boolean(current), Boolean(previous)])).update('\n');
      if (refreshCustomFields) digest.update(JSON.stringify([previous?.id ?? null, previousCustom?.id ?? null])).update('\n');
      if (!current || !previous) continue;
      include(current.json);
      const standardBaseline = readBaseline(previous, issueId);
      if (!standardBaseline) continue;
      const customBaseline = previousCustom?.id === previous.id ? standardBaseline : previousCustom && readBaseline(previousCustom, issueId);
      candidates.push({ issue: JSON.parse(current.json) as Issue, previous: standardBaseline,
        ...(customBaseline ? { previousCustom: customBaseline } : {}) });
    }
    return candidates;
  }
  private pageAppendDestination(packages: MigrationPackage[], options: MigrationOptions, allowSparseHistory = false): PageAppendDestination | undefined {
    const instanceKey = this.sourceInstance(packages, 'confluence');
    if (!instanceKey) return;
    const spaces = options.containers.filter(container => container.documentCount > 0);
    const sourceSpaceId = spaces[0]?.sourceProjectId ?? (allowSparseHistory ? this.sparseConfluenceSpace(packages, instanceKey) : undefined);
    if (!sourceSpaceId || sourceSpaceId === '__unassigned__' || spaces.some(space => space.sourceProjectId !== sourceSpaceId)) return;
    const binding = this.projectBinding('confluence', instanceKey, sourceSpaceId);
    const project = binding && this.store.get<Project>('projects', binding.id);
    if (!project) return;

    const keys = new Set<string>();
    for (const pkg of packages) {
      const row = pkg.dataset.records.find(record => record.kind === 'project' && record.sourceId === sourceSpaceId);
      const key = row?.metadata.spaceKey || row?.metadata.key;
      if (typeof key === 'string' && key) keys.add(key);
    }
    if (!keys.size) {
      const archived = this.store.db.prepare(`SELECT DISTINCT COALESCE(NULLIF(json_extract(json,'$.record.metadata.spaceKey'),''),
        json_extract(json,'$.record.metadata.key')) AS key FROM source_records WHERE import_id=? AND product='confluence'
        AND source_instance=? AND kind='project' AND source_id=? AND target_id=? AND target_type='project' AND json_valid(json)`)
        .all(binding.importId, instanceKey, sourceSpaceId, project.id) as { key: string | null }[];
      for (const { key } of archived) if (typeof key === 'string' && key) keys.add(key);
    }
    return { project, instanceKey, sourceSpaceId, ...(keys.size === 1 ? { sourceSpaceKey: [...keys][0] } : {}) };
  }
  private sparseConfluenceSpace(packages: MigrationPackage[], instanceKey: string): string | undefined {
    const ownerPages = new Set<string>();
    for (const pkg of packages) {
      const history = new Map(pkg.dataset.records.filter(record => record.kind === 'comment' || record.kind === 'revision')
        .map(record => [record.id, record]));
      for (const record of history.values()) {
        const page = confluenceHistoryPage(record, (kind, id) => history.get(`${kind}:${id}`));
        if (page && (record.kind === 'comment' || page !== record.sourceId)) ownerPages.add(page);
      }
    }
    if (!ownerPages.size) return;
    const rows = this.store.db.prepare(`SELECT DISTINCT json_extract(snapshot.json,'$.record.containerId') AS space
      FROM source_bindings AS binding JOIN source_records AS snapshot ON snapshot.import_id=binding.import_id
        AND snapshot.product=binding.product AND snapshot.source_instance=binding.source_instance
        AND snapshot.kind=binding.kind AND snapshot.source_id=binding.source_alias
        AND snapshot.target_type=binding.target_type AND snapshot.target_id=binding.target_id
      WHERE binding.product='confluence' AND binding.source_instance=? AND binding.kind='page' AND binding.target_type='document'
        AND binding.source_alias IN (SELECT value FROM json_each(?)) LIMIT 2`)
      .all(instanceKey, JSON.stringify([...ownerPages])) as { space: string | null }[];
    return rows.length === 1 ? rows[0].space ?? undefined : undefined;
  }
  private pageAppendContext(configuration: MigrationConfiguration, packages: MigrationPackage[], applying = false,
    sectionInventory?: boolean): MigrationPageAppendContext | undefined {
    if (!configuration.appendPagesTo) return;
    const destination = this.pageAppendDestination(packages, buildMigrationOptions(packages), configuration.appendPagesTo.refreshHistory);
    if (!destination || destination.project.id !== configuration.appendPagesTo.projectId) {
      return fail(applying ? 409 : 400, applying ? changedPageAppend : invalidPageAppend);
    }
    const { project, instanceKey, sourceSpaceId, sourceSpaceKey } = destination;
    const selectedPageIds = new Set(packages.flatMap(pkg => pkg.dataset.records.filter(record => record.kind === 'page').map(record => record.sourceId)));
    // Bindings retain the original space after a move or deletion. A reviewed refresh can supply a newer original
    // title for that same page; local document titles never participate in source lookups.
    const boundPages: MigrationPageAppendContext['knownPages'] = this.store.db.prepare(`WITH page_origins AS (
      SELECT binding.source_alias AS sourceId, binding.target_id AS documentId, document.project_id AS projectId,
        json_extract(archive.json,'$.record.containerId') AS sourceSpaceId,
        json_extract(archive.json,'$.record.title') AS sourceTitle
      FROM source_bindings AS binding
      LEFT JOIN documents AS document ON document.id=binding.target_id
      LEFT JOIN source_records AS archive ON archive.import_id=binding.import_id AND archive.product=binding.product
        AND archive.source_instance=binding.source_instance AND archive.kind=binding.kind AND archive.source_id=binding.source_alias
        AND archive.target_type=binding.target_type AND archive.target_id=binding.target_id AND json_valid(archive.json)
      WHERE binding.product='confluence' AND binding.source_instance=? AND binding.kind='page' AND binding.target_type='document'
    ), bound_pages AS (
      SELECT sourceId, documentId, projectId,
        CASE WHEN COUNT(DISTINCT sourceSpaceId)=1 THEN MAX(sourceSpaceId) END AS sourceSpaceId,
        CASE WHEN COUNT(DISTINCT sourceTitle)=1 THEN MAX(sourceTitle) ELSE '' END AS sourceTitle
      FROM page_origins GROUP BY sourceId, documentId, projectId
    ) SELECT bound.sourceId, bound.documentId, bound.projectId, bound.sourceSpaceId,
      COALESCE((SELECT json_extract(snapshot.json,'$.record.title')
      FROM source_records AS snapshot JOIN source_imports AS receipt ON receipt.id=snapshot.import_id
      WHERE bound.sourceSpaceId=? AND snapshot.target_type='document' AND snapshot.target_id=bound.documentId
        AND snapshot.product='confluence' AND snapshot.source_instance=? AND snapshot.kind='page' AND snapshot.source_id=bound.sourceId
        AND json_extract(snapshot.json,'$.record.containerId')=bound.sourceSpaceId AND json_extract(snapshot.json,'$.targetProjectId')=?
        AND length(trim(json_extract(snapshot.json,'$.record.title'))) BETWEEN 1 AND 300
        AND json_type(snapshot.json,'$.confluencePageFieldHashes')='object'
        AND json_type(receipt.json,'$.configuration.appendPagesTo.refreshExisting')='true'
      ORDER BY julianday(json_extract(receipt.json,'$.createdAt')) DESC, snapshot.id DESC LIMIT 1), bound.sourceTitle) AS sourceTitle
    FROM bound_pages AS bound ORDER BY bound.sourceId`).all(instanceKey, sourceSpaceId, instanceKey, project.id) as
      Omit<MigrationPageAppendContext['knownPages'][number], 'sectionIds'>[];
    const knownPages = boundPages.filter(page => page.sourceSpaceId === sourceSpaceId || selectedPageIds.has(page.sourceId));
    const hasSectionLinks = sectionInventory ?? packages.some(({ dataset }) => dataset.records.some(record => record.kind === 'page' &&
      record.textFormat === 'confluence-storage' && /\bac:anchor\s*=|\bhref\s*=\s*["'][^"'<>]*#/.test(record.text)));
    if (hasSectionLinks) {
      const scoped = new Map(knownPages.filter(page => page.projectId === project.id && page.sourceSpaceId === sourceSpaceId)
        .map(page => [page.documentId, page]));
      const sections = this.store.db.prepare(`SELECT DISTINCT document.id, section.atom AS sectionId
        FROM documents AS document, json_tree(document.json, '$.content') AS section
        WHERE document.project_id=? AND document.id IN (SELECT value FROM json_each(?))
          AND section.key='sectionId' AND section.type='text' AND section.atom GLOB 'confluence-*' AND section.path LIKE '%.attrs'
          AND json_extract(document.json, substr(section.path, 1, length(section.path)-6)||'.type')='heading'
        ORDER BY document.id, section.atom`);
      for (const { id, sectionId } of sections.iterate(project.id, JSON.stringify([...scoped.keys()])) as Iterable<{ id: string; sectionId: unknown }>) {
        const page = scoped.get(id);
        if (page && isDocumentSectionId(sectionId)) (page.sectionIds ??= []).push(sectionId);
      }
    }
    const digest = createHash('sha256').update(JSON.stringify([instanceKey, sourceSpaceId, sourceSpaceKey, project, knownPages]));
    // Additive history checks the exact reused files at apply, so unrelated local attachment updates can proceed.
    const attachmentDigest = configuration.appendPagesTo.refreshHistory && !configuration.appendPagesTo.refreshAttachments ? undefined : digest;
    const knownAttachments = this.confluenceKnownAttachments(knownPages, destination, attachmentDigest);
    const knownHistory = configuration.appendPagesTo.refreshHistory
      ? this.confluenceKnownHistory(packages, knownPages, destination, digest) : undefined;
    const refreshDocuments = configuration.appendPagesTo.refreshExisting
      ? this.confluenceRefreshDocuments(packages, configuration, knownPages, destination, digest) : undefined;
    return { project, sourceSpaceId, sourceSpaceKey, token: digest.digest('hex'), knownPages, knownAttachments,
      ...(hasSectionLinks ? { sectionInventory: true } : {}),
      ...(refreshDocuments ? { refreshDocuments } : {}), ...(knownHistory ? { knownHistory } : {}) };
  }
  private confluenceKnownHistory(packages: MigrationPackage[], knownPages: MigrationPageAppendContext['knownPages'],
    { project, instanceKey, sourceSpaceId }: PageAppendDestination, digest: ReturnType<typeof createHash>):
    NonNullable<MigrationPageAppendContext['knownHistory']> {
    const selected = { comment: new Set<string>(), revision: new Set<string>() };
    const revisionPages = new Set<string>();
    for (const pkg of packages) {
      const history = new Map(pkg.dataset.records.filter(record => record.kind === 'comment' || record.kind === 'revision')
        .map(record => [record.id, record]));
      for (const record of history.values()) {
        if (record.kind === 'comment') selected.comment.add(record.sourceId);
        if (record.kind !== 'revision') continue;
        selected.revision.add(record.sourceId);
        const page = confluenceHistoryPage(record, (kind, id) => history.get(`${kind}:${id}`));
        if (page) revisionPages.add(page);
      }
    }
    if (!selected.comment.size && !selected.revision.size) return [];
    const livePages = new Map(knownPages.filter(page => page.projectId === project.id && page.sourceSpaceId === sourceSpaceId)
      .map(page => [page.sourceId, page.documentId]));
    const liveDocumentIds = JSON.stringify([...new Set([...revisionPages].flatMap(page => livePages.get(page) ?? []))]);
    // The archive retains targets when users remove live comments or document revisions.
    const rows = this.store.db.prepare(`WITH history AS (
      SELECT snapshot.id, snapshot.json FROM source_records AS snapshot
      WHERE snapshot.owner_type='document' AND snapshot.owner_id IN (SELECT value FROM json_each(?))
        AND snapshot.product='confluence' AND snapshot.source_instance=? AND snapshot.kind='revision' AND snapshot.target_type='revision'
      UNION
      SELECT snapshot.id, snapshot.json FROM source_records AS snapshot
      WHERE snapshot.product='confluence' AND snapshot.source_instance=? AND snapshot.kind='comment' AND snapshot.target_type='comment'
        AND snapshot.source_id IN (SELECT value FROM json_each(?))
      UNION
      SELECT snapshot.id, snapshot.json FROM source_records AS snapshot
      WHERE snapshot.product='confluence' AND snapshot.source_instance=? AND snapshot.kind='revision' AND snapshot.target_type='revision'
        AND snapshot.source_id IN (SELECT value FROM json_each(?))
    ) SELECT json FROM history ORDER BY id`).iterate(liveDocumentIds, instanceKey, instanceKey,
      JSON.stringify([...selected.comment]), instanceKey, JSON.stringify([...selected.revision])) as Iterable<{ json: string }>;
    const known: NonNullable<MigrationPageAppendContext['knownHistory']> = [];
    const add = (source: typeof known[number], archive: SourceRecordArchive) => {
      known.push(source);
      digest.update(JSON.stringify([source, archive.id, archive.targetId])).update('\n');
    };
    for (const row of rows) {
      const archive = JSON.parse(row.json) as SourceRecordArchive;
      const { kind, sourceId } = archive.record;
      if ((kind !== 'comment' && kind !== 'revision') || !archive.ownerId || archive.ownerType !== 'document') continue;
      const page = archive.targetProjectId === project.id
        ? confluenceHistoryPage(archive.record, (kind, id) => this.sources.confluenceArchivedRecord(archive, kind, id)) : null;
      const sourcePageId = page && livePages.get(page) === archive.ownerId ? page : null;
      if (kind === 'revision' && (!sourcePageId || !revisionPages.has(sourcePageId)) && !selected.revision.has(sourceId)) continue;
      add({ kind, sourceId, sourcePageId, documentId: archive.ownerId,
        sourceVersion: sourcePageId && kind === 'revision' ? confluenceHistoryVersion(archive.record.metadata.version) : null }, archive);
    }
    if (!revisionPages.size) return known;
    const initial = this.store.db.prepare(`SELECT snapshot.json FROM source_bindings AS binding
      JOIN source_records AS snapshot ON snapshot.import_id=binding.import_id AND snapshot.product=binding.product
        AND snapshot.source_instance=binding.source_instance AND snapshot.kind=binding.kind AND snapshot.source_id=binding.source_alias
        AND snapshot.target_id=binding.target_id AND snapshot.target_type=binding.target_type
      WHERE binding.product='confluence' AND binding.source_instance=? AND binding.kind='page' AND binding.target_type='document'
        AND binding.target_id IN (SELECT value FROM json_each(?))
      ORDER BY snapshot.id`).iterate(instanceKey, liveDocumentIds) as Iterable<{ json: string }>;
    for (const row of initial) {
      const archive = JSON.parse(row.json) as SourceRecordArchive;
      const { sourceId, containerId, metadata } = archive.record;
      if (containerId !== sourceSpaceId || !archive.targetId || livePages.get(sourceId) !== archive.targetId || archive.targetProjectId !== project.id) continue;
      const sourceVersion = confluenceHistoryVersion(metadata.version);
      if (sourceVersion !== null) add({ kind: 'revision', sourceId, sourcePageId: sourceId, documentId: archive.targetId, sourceVersion }, archive);
    }
    return known;
  }
  private confluenceKnownAttachments(knownPages: MigrationPageAppendContext['knownPages'],
    { project, instanceKey, sourceSpaceId }: PageAppendDestination, digest?: ReturnType<typeof createHash>): NonNullable<MigrationPageAppendContext['knownAttachments']> {
    const livePages = new Map(knownPages.filter(page => page.projectId === project.id && page.sourceSpaceId === sourceSpaceId)
      .map(page => [page.sourceId, page.documentId]));
    if (!livePages.size) return [];
    const rows = this.store.db.prepare(`SELECT snapshot.json AS archive, snapshot.owner_id AS documentId,
      CASE WHEN anchor.id IS NOT NULL THEN version.json END AS version,
      (SELECT newer.id FROM attachment_versions AS newer WHERE newer.attachment_id=anchor.id
        AND json_type(newer.json,'$.localRevision')='integer'
        ORDER BY json_extract(newer.json,'$.localRevision') DESC LIMIT 1) AS latestLocalId
      FROM source_records AS snapshot
      JOIN documents AS document ON document.id=snapshot.owner_id AND document.project_id=?
      LEFT JOIN attachment_versions AS version ON version.id=snapshot.target_id
      LEFT JOIN attachments AS anchor ON anchor.id=version.attachment_id AND anchor.resource_type='document' AND anchor.resource_id=document.id
      WHERE snapshot.product='confluence' AND snapshot.source_instance=? AND snapshot.kind='attachment'
        AND snapshot.owner_type='document' AND snapshot.target_type='attachment' AND json_extract(snapshot.json,'$.targetProjectId')=?
      ORDER BY snapshot.source_id,snapshot.id`).iterate(project.id, instanceKey, project.id) as
      Iterable<{ archive: string; documentId: string; version: string | null; latestLocalId: string | null }>;
    const known: NonNullable<MigrationPageAppendContext['knownAttachments']> = [];
    for (const row of rows) {
      const archive = JSON.parse(row.archive) as SourceRecordArchive;
      const origin = confluenceAttachmentOrigin(archive.record, (kind, id) => this.sources.confluenceArchivedRecord(archive, kind, id));
      if (!origin || livePages.get(origin.sourcePageId) !== row.documentId) continue;
      const stored = row.version ? JSON.parse(row.version) as AttachmentVersion : null;
      const version = stored?.id === archive.targetId && stored?.sourceRecordId === archive.id && stored.sourceImportId === archive.sourceImportId &&
        stored.resourceType === 'document' && stored.resourceId === row.documentId && stored.localRevision === undefined ? stored : null;
      const filename = archive.record.title || archive.record.metadata.fileName;
      const attachment = { ...origin, sourceId: archive.record.sourceId, filename: typeof filename === 'string' && filename ? filename.trim() : version?.filename ?? '',
        documentId: row.documentId, version, hasLocalVersions: version !== null && row.latestLocalId !== null };
      known.push(attachment);
      digest?.update(JSON.stringify([attachment, version ? row.latestLocalId : null])).update('\n');
    }
    return known;
  }
  private reusedConfluenceAttachmentError(prepared: PreparedMigration, pages?: MigrationPageAppendContext): string | null {
    const reused = prepared.reusedAttachmentVersions ?? [];
    if (!reused.length) return null;
    const verified = new Map(pages?.knownAttachments?.flatMap(item => item.version ? [[item.version.id, item.version] as const] : []));
    const checked = new Set<string>();
    let bytes = 0;
    for (const expected of reused) {
      if (checked.has(expected.id)) continue;
      checked.add(expected.id);
      const current = verified.get(expected.id);
      if (!current || current.attachmentId !== expected.attachmentId || current.resourceId !== expected.resourceId ||
          current.sourceRecordId !== expected.sourceRecordId || current.size !== expected.size || current.sha256 !== expected.sha256 ||
          current.mimeType !== expected.mimeType || current.filename !== expected.filename) return '재사용할 Confluence 첨부 연결이 변경되었습니다.';
      bytes += current.size;
      if (bytes > MAX_REUSED_FILE_BYTES) return '한 번에 확인할 재사용 첨부가 256MiB를 넘습니다. 패키지를 나누어 주세요.';
      try { this.files.read(current); }
      catch { return `재사용할 Confluence 첨부 파일 '${current.filename}'의 저장 바이트 또는 SHA-256을 확인할 수 없습니다.`; }
    }
    return null;
  }
  private confluenceRefreshDocuments(packages: MigrationPackage[], configuration: MigrationConfiguration, knownPages: MigrationPageAppendContext['knownPages'],
    { project, instanceKey, sourceSpaceId }: PageAppendDestination, digest: ReturnType<typeof createHash>): NonNullable<MigrationPageAppendContext['refreshDocuments']> {
    const live = new Map(knownPages.filter(page => page.projectId === project.id && page.sourceSpaceId === sourceSpaceId)
      .map(page => [page.sourceId, page.documentId]));
    const excluded = new Set(configuration.excludedRecords);
    const selected = new Set<string>();
    for (const { summary, dataset } of packages) for (const row of dataset.records) {
      if (row.kind === 'page' && live.has(row.sourceId) && !excluded.has(`${summary.id}/${row.id}`)) selected.add(row.sourceId);
    }
    if (selected.size > MAX_REFRESH_DOCUMENTS) fail(413, '기존 Confluence 문서의 변경은 한 번에 300개까지 검토할 수 있습니다. 패키지를 나누어 주세요.');

    const currentDocument = this.store.db.prepare('SELECT json FROM documents WHERE id=? AND project_id=?');
    const previousPage = this.store.db.prepare(`SELECT snapshot.json, json_extract(receipt.json,'$.configuration.timezone') AS timezone
      FROM source_records AS snapshot JOIN source_imports AS receipt ON receipt.id=snapshot.import_id
      WHERE snapshot.target_type='document' AND snapshot.target_id=? AND snapshot.product='confluence' AND snapshot.source_instance=?
        AND snapshot.kind='page' AND snapshot.source_id=? AND json_extract(snapshot.json,'$.record.containerId')=?
        AND json_extract(snapshot.json,'$.targetProjectId')=?
      ORDER BY julianday(json_extract(receipt.json,'$.createdAt')) DESC, snapshot.id DESC LIMIT 1`);
    const candidates: NonNullable<MigrationPageAppendContext['refreshDocuments']> = [];
    let bytes = 0;
    digest.update('\nconfluence-refresh\n');
    for (const sourceId of [...selected].sort()) {
      const documentId = live.get(sourceId)!;
      const current = currentDocument.get(documentId, project.id) as { json: string } | undefined;
      const previous = previousPage.get(documentId, instanceKey, sourceId, sourceSpaceId, project.id) as { json: string; timezone: string } | undefined;
      digest.update(JSON.stringify([sourceId, Boolean(current), Boolean(previous)])).update('\n');
      if (!current || !previous) continue;
      bytes += Buffer.byteLength(current.json) + Buffer.byteLength(previous.json);
      if (bytes > MAX_REFRESH_BYTES) fail(413, '검토에 필요한 기존 Confluence 원본이 64MiB를 넘습니다. 패키지를 나누어 주세요.');
      digest.update(current.json).update('\n').update(previous.json).update('\n').update(JSON.stringify(previous.timezone)).update('\n');
      candidates.push({ document: JSON.parse(current.json) as DocPage, previous: JSON.parse(previous.json) as SourceRecordArchive,
        previousTimezone: previous.timezone });
    }
    return candidates;
  }
  private fileSpec(summary: LegacyPackageSummary): MigrationSourceFile {
    return { id: summary.id, filename: summary.filename, sha256: summary.sha256, path: join(this.dataDir, 'legacy-imports', `${summary.id}.bundle`) };
  }
  private verifyPackages(packages: SourceImport['packages']) {
    return packages.map(value => {
      let current: LegacyPackageDetail;
      try { current = this.legacy.detail(value.stagingId); }
      catch { return fail(409, '검토한 원본 패키지가 삭제되었습니다. 다시 분석하고 미리보기를 만들어 주세요.'); }
      if (current.summary.sha256 !== value.sha256 || current.summary.filename !== value.filename ||
          JSON.stringify(current.summary.source) !== JSON.stringify(value.source)) {
        return fail(409, '검토한 원본 패키지가 변경되었습니다.');
      }
      return this.fileSpec(current.summary);
    });
  }
  private work<T>(payload: MigrationWork): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./migration-worker.mjs', import.meta.url), {
        workerData: payload, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 },
      });
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.current = null;
        if (error) { void worker.terminate(); reject(error); }
        else resolve(value!);
      };
      const timer = setTimeout(() => finish(new LegacyImportError(408, '이관 준비가 30초를 초과했습니다. 패키지를 나누어 주세요.')), 30000);
      timer.unref();
      this.current = { abort: () => finish(new LegacyImportError(503, '이관 서비스가 종료되었습니다.')) };
      worker.once('message', (message: { ok: boolean; value?: T; status?: number; message?: string }) => {
        if (message.ok) finish(undefined, message.value);
        else finish(new LegacyImportError(message.status || 500, message.message || '이관 준비에 실패했습니다.'));
      });
      worker.once('error', () => finish(new LegacyImportError(500, '이관 작업 스레드가 종료되었습니다.')));
      worker.once('exit', () => finish(new LegacyImportError(500, '이관 작업을 완료하지 못했습니다.')));
    });
  }
  private validateConfiguration(value: unknown): MigrationConfiguration {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, '이관 매핑을 확인해 주세요.');
    const config = value as MigrationConfiguration;
    this.packageIds(config.packageIds);
    if (!Array.isArray(config.projects) || !Array.isArray(config.excludedRecords) ||
        typeof config.timezone !== 'string' || !['block', 'import-time'].includes(config.datePolicy)) {
      return fail(400, '프로젝트 매핑·시간대·제외 목록을 확인해 주세요.');
    }
    if (config.excludedRecords.length > 100000 ||
        config.excludedRecords.some(record => typeof record !== 'string' || !record || record.length > 1200)) {
      fail(400, '제외할 원본 ID를 확인해 주세요.');
    }
    for (const mapping of [config.users, config.statuses, config.issueTypes, config.fields, config.sourceBaseUrls]) {
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) fail(400, '이관 매핑 형식이 올바르지 않습니다.');
    }
    if (Object.hasOwn(config, 'appendTo') && Object.hasOwn(config, 'appendPagesTo')) fail(400, '기존 프로젝트에 추가할 원본 도구를 하나 선택해 주세요.');
    if (Object.hasOwn(config, 'appendTo')) {
      const appendTo = parseMigrationAppendConfiguration(config.appendTo);
      return { ...config, projects: [], statuses: {}, issueTypes: {}, fields: {}, appendTo };
    }
    if (Object.hasOwn(config, 'appendPagesTo')) {
      const appendPagesTo = parseMigrationPageAppendConfiguration(config.appendPagesTo);
      return { ...config, projects: [], statuses: {}, issueTypes: {}, fields: {}, appendPagesTo };
    }
    if (config.projects.length > 100 || config.projects.some(project => !project || typeof project !== 'object' ||
        typeof project.containerId !== 'string' || typeof project.key !== 'string' || typeof project.name !== 'string')) {
      fail(400, '프로젝트 매핑을 확인해 주세요.');
    }
    return config;
  }
  private async preview(value: unknown, request: Request, hooks: Hooks): Promise<MigrationPreview> {
    const actorId = hooks.actor(request);
    const configuration = this.validateConfiguration(value);
    this.reserve();
    try {
      const generation = this.generation();
      const packages = this.loadPackages(configuration.packageIds);
      const append = this.appendContext(configuration, packages);
      const appendPages = this.pageAppendContext(configuration, packages);
      const prepared = await this.work<PreparedMigration>({
        action: 'preview', sources: packages.map(item => this.fileSpec(item.summary)),
        input: { id: randomUUID(), configuration, actorId, packages, now: new Date().toISOString(),
          users: this.store.all<User>('users'), existingProjectKeys: this.store.all<Project>('projects').map(project => project.key),
          ...(append ? { append } : {}), ...(appendPages ? { appendPages } : {}) },
      });
      if (this.closed) fail(503, '이관 서비스가 종료되었습니다.');
      if (generation !== this.generation()) fail(409, '워크스페이스가 복원되었습니다. 새 미리보기를 만들어 주세요.');
      this.verifyPackages(prepared.sourceImport.packages);
      const binding = this.store.db.prepare('SELECT target_type AS type,target_id AS id FROM source_bindings WHERE product=? AND source_instance=? AND kind=? AND source_alias=?');
      const refreshIssueIds = new Set(append?.refreshIssues?.map(candidate => candidate.issue.id));
      const refreshDocumentIds = new Set(appendPages?.refreshDocuments?.map(candidate => candidate.document.id));
      const duplicate = prepared.sourceRecords.find(row => {
        if (!row.targetId || !['project', 'issue', 'page'].includes(row.record.kind)) return false;
        const { source, record } = row;
        const existingProject = source.product === 'jira' ? append?.project : appendPages?.project;
        const aliases = [record.sourceId];
        if (source.product === 'jira' && record.kind === 'issue' && typeof record.metadata.key === 'string') aliases.push(record.metadata.key);
        const jiraCheckpoint = configuration.appendTo?.refreshExisting && row.jiraIssueFieldHashes ||
          configuration.appendTo?.refreshCustomFields && row.jiraCustomFieldHashes;
        return aliases.some(alias => {
          const bound = binding.get(source.product, source.instanceKey, record.kind, alias) as { type: string; id: string } | undefined;
          if (!bound) return false;
          if (source.product === 'jira' && record.kind === 'issue' && row.targetType === 'issue' && jiraCheckpoint &&
              bound.type === 'issue' && bound.id === row.targetId && refreshIssueIds.has(bound.id)) return false;
          if (source.product === 'confluence' && record.kind === 'page' && row.targetType === 'document' && row.confluencePageFieldHashes &&
              bound.type === 'document' && bound.id === row.targetId && refreshDocumentIds.has(bound.id)) return false;
          return !(existingProject && record.kind === 'project' && row.targetType === 'project' &&
            bound.type === 'project' && bound.id === existingProject.id && row.targetId === existingProject.id);
        });
      });
      if (duplicate) {
        const sourcePackage = prepared.sourceImport.packages.find(item =>
          item.sha256 === duplicate.packageSha256 && item.source.product === duplicate.source.product &&
          item.source.instanceKey === duplicate.source.instanceKey);
        prepared.preview.canApply = false;
        prepared.preview.notices.unshift({
          severity: 'error', code: 'SOURCE_ALREADY_IMPORTED', message: '이관한 원본이 포함되어 있습니다. 적용할 패키지와 제외할 원본을 확인해 주세요.',
          recordId: sourcePackage ? `${sourcePackage.stagingId}/${duplicate.record.id}` : null, requiresAcknowledgement: false,
        });
      }
      if (prepared.preview.canApply) {
        const attachmentError = this.reusedConfluenceAttachmentError(prepared, appendPages);
        if (attachmentError) {
          prepared.preview.canApply = false;
          prepared.preview.notices.unshift({ severity: 'error', code: 'CONFLUENCE_ATTACHMENT_REUSE_INVALID', message: attachmentError,
            recordId: null, requiresAcknowledgement: false });
        }
      }
      if (prepared.preview.canApply && prepared.issueUpdates?.length) hooks.validateIssueUpdates?.(prepared, request);
      if (prepared.preview.canApply && prepared.documentUpdates?.length) hooks.validateDocumentUpdates?.(prepared, request);

      // Keep the review available even for a blocked plan, without saving arrays that cannot be applied.
      if (!prepared.preview.canApply) {
        const { preview } = prepared;
        this.storePreview({ preview }, generation);
        return preview;
      }
      this.storePreview(prepared, generation);
      return prepared.preview;
    } finally { this.busy = false; }
  }
  private storePreview(prepared: Pick<PreparedMigration, 'preview'>, generation: string) {
    const json = JSON.stringify({ ...prepared, conversionVersion });
    const size = Buffer.byteLength(json);
    if (size > 192 * MiB) fail(413, '변환 결과가 192MiB를 넘습니다. 패키지를 나누어 주세요.');
    this.store.transaction(() => {
      this.prune();
      // Keep recent plans while bounding storage. Older plans can always be regenerated.
      while (true) {
        const usage = this.store.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM migration_previews').get() as { count: number; bytes: number };
        if (usage.count < 12 && usage.bytes + size <= 256 * MiB) break;
        this.store.db.exec('DELETE FROM migration_previews WHERE rowid=(SELECT MIN(rowid) FROM migration_previews)');
      }
      this.store.db.prepare('INSERT INTO migration_previews VALUES (?,?,?,?,?)').run(prepared.preview.id, prepared.preview.expiresAt, generation, size, json);
    });
  }
  private getPreview(id: string, actorId: string, reviewOnly = false): { prepared: PreparedMigration; generation: string } {
    const json = reviewOnly ? "json_object('preview',json_extract(json,'$.preview'))" : 'json';
    const row = this.store.db.prepare(`SELECT ${json} AS json, generation,
      json_extract(json,'$.conversionVersion') AS conversionVersion FROM migration_previews WHERE id=?`).get(id) as PreviewRow | undefined;
    if (!row) return fail(408, '미리보기 보관 기간이 지났거나 새로 검토해야 합니다.');
    const prepared = JSON.parse(row.json) as PreparedMigration;
    if (prepared.preview.actorId !== actorId) fail(403, '미리보기를 만든 작업자를 선택해 주세요.');
    if (row.generation !== this.generation()) fail(409, '워크스페이스가 복원되었습니다. 새 미리보기를 만들어 주세요.');
    if (row.conversionVersion !== conversionVersion) fail(409, '원본 변환 규칙이 변경되었습니다. 새 미리보기를 만들어 주세요.');
    if (Date.parse(prepared.preview.expiresAt) <= Date.now()) fail(408, '미리보기가 만료되었습니다. 다시 검토해 주세요.');
    return { prepared, generation: row.generation };
  }
  private async apply(id: string, request: Request, hooks: Hooks): Promise<MigrationApplyResult> {
    const actorId = hooks.actor(request);
    const expectedVersion: unknown = request.body.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) fail(400, '미리보기 버전을 확인해 주세요.');
    const already = this.store.get<SourceImport>('source_imports', id);
    if (already) {
      if (already.actorId !== actorId) fail(403, '이관을 실행한 작업자를 선택해 주세요.');
      if (already.version !== expectedVersion) fail(409, '이관 영수증의 버전이 변경되었습니다.');
      return { import: already, duplicate: true };
    }
    this.reserve();
    try {
      const { prepared, generation } = this.getPreview(id, actorId);
      const { preview } = prepared;
      if (preview.version !== expectedVersion) fail(409, '미리보기 버전이 다릅니다.');
      if (!preview.canApply) fail(409, '미리보기의 적용을 막는 항목을 먼저 해결해 주세요.');
      if (!Array.isArray(prepared.atlassianLinks) && preview.configuration.packageIds.some(id => preview.configuration.sourceBaseUrls[id] != null)) {
        fail(409, '원본 주소가 포함된 이관의 미리보기를 다시 만들어 주세요.');
      }
      if (!Array.isArray(prepared.worklogs) &&
          prepared.sourceRecords.some(source => source.source.product==='jira' && source.record.metadata.kind==='worklog')) {
        fail(409, '작업 시간이 포함된 원본의 미리보기를 다시 만들어 주세요.');
      }
      const acknowledgements: unknown = request.body.acknowledgements;
      if (!Array.isArray(acknowledgements) || acknowledgements.some(code => typeof code !== 'string') ||
          !unique(acknowledgements) || acknowledgements.length !== preview.requiredAcknowledgements.length ||
          preview.requiredAcknowledgements.some(code => !acknowledgements.includes(code))) {
        fail(400, '미리보기의 필수 확인 항목을 모두 확인해 주세요.');
      }
      const sources = this.verifyPackages(prepared.sourceImport.packages);
      const copies = await this.work<(Omit<AppendedFile, 'bytes'> & { bytes: Uint8Array })[]>({
        action: 'files', sources, copies: prepared.fileCopies,
      });
      if (this.closed) fail(503, '이관 서비스가 종료되었습니다.');
      const files = copies.map(value => ({ ...value, bytes: Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength) }));
      const expectedFiles = new Map([...prepared.attachments, ...prepared.attachmentVersions].map(file => [file.id, file]));
      for (const file of files) {
        const expected = expectedFiles.get(file.id);
        if (!expected || expected.size !== file.size || expected.sha256 !== file.sha256) fail(409, '검토한 첨부 정보가 일치하지 않습니다.');
        expectedFiles.delete(file.id);
      }
      if (expectedFiles.size) fail(409, '검토한 첨부 내용 일부가 없습니다.');
      const staged = files.length ? this.append.stage(id, files) : null;
      prepared.sourceImport.notices = preview.notices;
      let receipt: SourceImport;
      try {
        receipt = this.store.withMutationContext({ actorId, origin: 'import' }, () => this.store.transaction(() => {
          if (generation !== this.generation()) fail(409, '워크스페이스가 복원되었습니다. 새 미리보기를 만들어 주세요.');
          if (Date.parse(preview.expiresAt) <= Date.now()) fail(408, '미리보기가 만료되었습니다. 다시 검토해 주세요.');
          this.verifyPackages(prepared.sourceImport.packages);
          const { append, appendPages } = prepared;
          if (Boolean(append) !== Boolean(preview.configuration.appendTo)) fail(409, changedAppend);
          if (append) {
            const current = this.appendContext(preview.configuration, this.loadPackages(preview.configuration.packageIds, true), true);
            if (!current || append.projectId !== current.project.id || append.startIssueNumber !== current.nextIssueNumber ||
                append.token !== current.token) fail(409, changedAppend);
          }
          if (Boolean(appendPages) !== Boolean(preview.configuration.appendPagesTo)) fail(409, changedPageAppend);
          if (appendPages) {
            const current = this.pageAppendContext(preview.configuration, this.loadPackages(preview.configuration.packageIds, true), true, appendPages.sectionInventory ?? false);
            if (!current || appendPages.projectId !== current.project.id || appendPages.token !== current.token) fail(409, changedPageAppend);
            const attachmentError = this.reusedConfluenceAttachmentError(prepared, current);
            if (attachmentError) fail(409, attachmentError);
          }
          const keys = new Set(this.store.all<Project>('projects').map(project => project.key));
          if (prepared.projects.some(project => keys.has(project.key))) fail(409, '이관할 프로젝트 키가 이미 사용 중입니다.');
          if (!this.store.get('users', actorId)) fail(409, '이관 작업자가 변경되었습니다. 다시 검토해 주세요.');
          hooks.persistCanonical(prepared, request);
          const recorded = this.sources.persistPrepared(prepared);
          staged?.install();
          this.store.db.prepare('DELETE FROM migration_previews WHERE id=?').run(id);
          return recorded;
        }));
      } catch (error) {
        staged?.rollback();
        throw error;
      }
      try { staged?.commit(); } catch { console.error('[teamspace migration] 첨부 추가 복구 기록 정리가 필요합니다.'); }
      try { hooks.afterApply?.(prepared); } catch { console.error('[teamspace migration] 이관한 문서의 공동 편집 알림을 보낼 수 없습니다.'); }
      return { import: receipt, duplicate: false };
    } finally { this.busy = false; }
  }
  registerRoutes(app: Express, hooks: Hooks) {
    app.get('/api/migrations/options', (req, res) => {
      if (Object.keys(req.query).some(key => key !== 'packageId')) fail(400, '원본 패키지 조회 조건을 확인해 주세요.');
      const packages = this.loadPackages(this.packageIds(req.query.packageId), true);
      const options = buildMigrationOptions(packages);
      const destination = this.appendDestination(packages, options, { history: true, attachments: true });
      if (destination) {
        const { project, workflow, schema, instanceKey, sourceProjectId } = destination;
        options.appendTarget = { projectId: project.id, key: project.key, name: project.name, instanceKey, sourceProjectId,
          statuses: workflow.statuses, issueTypes: schema.issueTypes, fields: schema.fields };
      }
      const pageDestination = this.pageAppendDestination(packages, options, true);
      if (pageDestination) {
        const { project, instanceKey, sourceSpaceId, sourceSpaceKey } = pageDestination;
        options.appendPagesTarget = { projectId: project.id, key: project.key, name: project.name, instanceKey, sourceSpaceId, sourceSpaceKey };
      }
      res.json(options);
    });
    app.post('/api/migrations/preview', async (req, res) => res.status(201).json(await this.preview(req.body.configuration, req, hooks)));
    app.get('/api/migrations/previews/:id', (req, res) => res.json(this.getPreview(String(req.params.id), hooks.actor(req), true).prepared.preview));
    app.post('/api/migrations/previews/:id/apply', async (req, res) => {
      const result = await this.apply(String(req.params.id), req, hooks);
      res.status(result.duplicate ? 200 : 201).json(result);
    });
  }
  close() { this.closed = true; this.current?.abort(); }
}
