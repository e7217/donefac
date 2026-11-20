import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Express, Request } from 'express';
import type { DocPage, Issue, LegacyDiagnostic, LegacyPackageDetail, LegacyPackageSummary, LegacyRecord, LegacySource, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview, Project, ProjectIssueSchema, ProjectWorkflow, SourceImport, SourceRecordArchive, User } from '../shared/types.js';
import { defaultIssueSchema } from '../shared/issue-schema.js';
import { defaultWorkflow } from '../shared/workflow-helpers.js';
import { LegacyImportError } from './legacy-import-model.js';
import { buildMigrationOptions } from './migration-planner.js';
import type { MigrationAppendContext, MigrationJiraRefreshCandidate, MigrationPackage, MigrationPageAppendContext, PreparedMigration } from './migration-contracts.js';
import type { MigrationSourceFile, MigrationWork } from './migration-work.js';
import { AttachmentAppend, type AppendedFile } from './attachment-append.js';
import type { Store } from './store.js';
import type { LegacyImportService } from './legacy-import.js';
import { parseMigrationAppendConfiguration, parseMigrationPageAppendConfiguration, type SourcePreservationService } from './source-preservation.js';

const MiB = 1024 * 1024;
const fail = (status: number, message: string): never => { throw new LegacyImportError(status, message); };
const unique = (values: string[]) => new Set(values).size === values.length;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const generationKey = 'migrationWorkspaceGeneration';
const conversionVersion = 2;
const MAX_REFRESH_ISSUES = 1000;
const MAX_REFRESH_DOCUMENTS = 300;
const MAX_REFRESH_BYTES = 64 * MiB;
type PreviewRow = { json: string; generation: string; conversionVersion: number | null };
type AppendDestination = Pick<MigrationAppendContext, 'project' | 'workflow' | 'schema'> & { instanceKey: string; sourceProjectId: string };
type PageAppendDestination = Pick<MigrationPageAppendContext, 'project' | 'sourceSpaceId' | 'sourceSpaceKey'> & { instanceKey: string };
const invalidAppend = '같은 Jira 인스턴스에서 이관한 단일 원본 프로젝트와 기존 추가 대상을 선택해 주세요.';
const changedAppend = '추가 대상의 프로젝트 설정, 업무 버전·번호 또는 원본 연결이 변경되었습니다. 새 미리보기를 만들어 주세요.';
const invalidPageAppend = '같은 Confluence 인스턴스에서 이관한 단일 원본 공간과 기존 추가 대상을 선택해 주세요.';
const changedPageAppend = '대상 프로젝트, 문서 버전 또는 원본 페이지 연결이 변경되었습니다. 새 미리보기를 만들어 주세요.';
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
  private closed = false;
  private current: { abort: () => void } | null = null;
  private busy = false;

  constructor(private readonly store: Store, private readonly dataDir: string, private readonly legacy: LegacyImportService, private readonly sources: SourcePreservationService, hasArchivedVersion: (id: string) => boolean) {
    this.append = new AttachmentAppend(dataDir);
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
  private appendDestination(packages: MigrationPackage[], options: MigrationOptions): AppendDestination | undefined {
    const instanceKey = this.sourceInstance(packages, 'jira');
    if (!instanceKey) return;
    const issueContainers = options.containers.filter(container => container.issueCount > 0);
    const sourceProjectId = issueContainers[0]?.sourceProjectId;
    if (!sourceProjectId || sourceProjectId === '__unassigned__' || issueContainers.some(container => container.sourceProjectId !== sourceProjectId)) return;
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
    }
    const project = this.store.get<Project>('projects', projectId);
    if (!project) return;
    const workflow = this.store.get<ProjectWorkflow>('workflows', project.id) || defaultWorkflow(project.id, project.createdAt);
    const schema = this.store.get<ProjectIssueSchema>('issue_schemas', project.id) || defaultIssueSchema(project.id, project.createdAt);
    return { project, workflow, schema, instanceKey, sourceProjectId };
  }
  private appendContext(configuration: MigrationConfiguration, packages: MigrationPackage[], applying = false): MigrationAppendContext | undefined {
    if (!configuration.appendTo) return;
    const destination = this.appendDestination(packages, buildMigrationOptions(packages));
    if (!destination || destination.project.id !== configuration.appendTo.projectId) {
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
    const refreshIssues = configuration.appendTo.refreshExisting
      ? this.jiraRefreshIssues(packages, configuration, knownIssues, project.id, instanceKey, digest)
      : undefined;
    return { project, workflow, schema, nextIssueNumber: sequence.value, token: digest.digest('hex'), knownIssues, ...(refreshIssues ? { refreshIssues } : {}) };
  }
  private jiraRefreshIssues(packages: MigrationPackage[], configuration: MigrationConfiguration, knownIssues: MigrationAppendContext['knownIssues'], projectId: string, instanceKey: string, digest: ReturnType<typeof createHash>): MigrationJiraRefreshCandidate[] {
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
    // Source import timestamps are captured at preview creation. A later refresh is prepared against
    // the previously stored baseline, and a restore can insert archived rows in a different order.
    const oldArchive = this.store.db.prepare(`SELECT archive.json, archive.import_id AS importId FROM source_records AS archive
      JOIN source_imports AS receipt ON receipt.id=archive.import_id
      WHERE archive.target_type='issue' AND archive.target_id=? AND archive.product='jira' AND archive.source_instance=? AND archive.kind='issue'
      ORDER BY julianday(json_extract(receipt.json,'$.createdAt')) DESC, archive.id DESC LIMIT 1`);
    const receipts = new Map<string, SourceImport | undefined>();
    const candidates: MigrationJiraRefreshCandidate[] = [];
    let bytes = 0;
    const include = (json: string) => {
      bytes += Buffer.byteLength(json);
      if (bytes > MAX_REFRESH_BYTES) fail(413, '검토에 필요한 기존 Jira 원본이 64MiB를 넘습니다. 패키지를 나누어 주세요.');
      digest.update(json).update('\n');
    };

    digest.update('\njira-refresh\n');
    for (const issueId of [...selected].sort()) {
      const current = oldIssue.get(issueId, projectId) as { json: string } | undefined;
      const previous = oldArchive.get(issueId, instanceKey) as { json: string; importId: string } | undefined;
      digest.update(JSON.stringify([issueId, Boolean(current), Boolean(previous)])).update('\n');
      if (!current || !previous) continue;
      include(current.json);
      include(previous.json);
      const archive = JSON.parse(previous.json) as SourceRecordArchive;
      if (!receipts.has(previous.importId)) {
        const receipt = this.store.get<SourceImport>('source_imports', previous.importId);
        if (receipt) include(JSON.stringify(receipt));
        receipts.set(previous.importId, receipt);
      }
      const receipt = receipts.get(previous.importId);
      const pkg = receipt?.packages.find(pkg => pkg.sha256 === archive.packageSha256 && pkg.source.product === 'jira' && pkg.source.instanceKey === instanceKey);
      if (!receipt || !pkg || archive.targetId !== issueId || archive.targetProjectId !== projectId) continue;
      candidates.push({ issue: JSON.parse(current.json) as Issue, previous: {
        archive, stagingId: pkg.stagingId, configuration: receipt.configuration,
      } });
    }
    return candidates;
  }
  private pageAppendDestination(packages: MigrationPackage[], options: MigrationOptions): PageAppendDestination | undefined {
    const instanceKey = this.sourceInstance(packages, 'confluence');
    if (!instanceKey) return;
    const spaces = options.containers.filter(container => container.documentCount > 0);
    const sourceSpaceId = spaces[0]?.sourceProjectId;
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
  private pageAppendContext(configuration: MigrationConfiguration, packages: MigrationPackage[], applying = false): MigrationPageAppendContext | undefined {
    if (!configuration.appendPagesTo) return;
    const destination = this.pageAppendDestination(packages, buildMigrationOptions(packages));
    if (!destination || destination.project.id !== configuration.appendPagesTo.projectId) {
      return fail(applying ? 409 : 400, applying ? changedPageAppend : invalidPageAppend);
    }
    const { project, instanceKey, sourceSpaceId, sourceSpaceKey } = destination;
    const selectedPageIds = new Set(packages.flatMap(pkg => pkg.dataset.records.filter(record => record.kind === 'page').map(record => record.sourceId)));
    // Bindings retain the original space after a move or deletion. A reviewed refresh can supply a newer original
    // title for that same page; local document titles never participate in source lookups.
    const boundPages = this.store.db.prepare(`WITH page_origins AS (
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
    FROM bound_pages AS bound ORDER BY bound.sourceId`).all(instanceKey, sourceSpaceId, instanceKey, project.id) as MigrationPageAppendContext['knownPages'];
    const knownPages = boundPages.filter(page => page.sourceSpaceId === sourceSpaceId || selectedPageIds.has(page.sourceId));
    const digest = createHash('sha256').update(JSON.stringify([instanceKey, sourceSpaceId, sourceSpaceKey, project, knownPages]));
    const refreshDocuments = configuration.appendPagesTo.refreshExisting
      ? this.confluenceRefreshDocuments(packages, configuration, knownPages, destination, digest) : undefined;
    return { project, sourceSpaceId, sourceSpaceKey, token: digest.digest('hex'), knownPages, ...(refreshDocuments ? { refreshDocuments } : {}) };
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
        return aliases.some(alias => {
          const bound = binding.get(source.product, source.instanceKey, record.kind, alias) as { type: string; id: string } | undefined;
          if (!bound) return false;
          if (source.product === 'jira' && record.kind === 'issue' && row.targetType === 'issue' && row.jiraIssueFieldHashes &&
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
            const current = this.pageAppendContext(preview.configuration, this.loadPackages(preview.configuration.packageIds, true), true);
            if (!current || appendPages.projectId !== current.project.id || appendPages.token !== current.token) fail(409, changedPageAppend);
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
      const destination = this.appendDestination(packages, options);
      if (destination) {
        const { project, workflow, schema, instanceKey, sourceProjectId } = destination;
        options.appendTarget = { projectId: project.id, key: project.key, name: project.name, instanceKey, sourceProjectId,
          statuses: workflow.statuses, issueTypes: schema.issueTypes, fields: schema.fields };
      }
      const pageDestination = this.pageAppendDestination(packages, options);
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
