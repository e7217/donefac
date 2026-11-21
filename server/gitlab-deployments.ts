import { createHash } from 'node:crypto';
import { isCalendarDate } from '../shared/calendar.js';
import { gitlabObjectSha } from '../shared/gitlab-links.js';
import { GITLAB_DEPLOYMENT_STATES, type GitlabDeployment, type GitlabDeploymentPage, type GitlabDeploymentState, type GitlabLink } from '../shared/types.js';
import { gitlabPushLinkUrl, gitlabRepositoryUrl, gitlabScopedPushUrl } from './gitlab-push.js';
import type { Store } from './store.js';

const PAGE_SIZE = 50;
const STATES: ReadonlySet<unknown> = new Set(GITLAB_DEPLOYMENT_STATES);
const INSTANCE = /^[a-f0-9]{12}$/u;
const SHA_PATH = /\/-\/commit\/([a-f\d]{40}|[a-f\d]{64})$/iu;
const JOB_PATH = /\/-\/jobs\/([1-9]\d*)$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const FIELDS = new Set(['instance', 'repositoryId', 'deploymentId', 'environment', 'environmentTier', 'sha', 'status', 'changedAt', 'projectUrl', 'jobUrl']);
const select = `d.instance, d.repository_id AS repositoryId, d.deployment_id AS deploymentId,
  d.environment, d.environment_tier AS environmentTier, d.sha, d.status, d.changed_at AS changedAt,
  d.project_url AS projectUrl, d.job_url AS jobUrl`;
const byLatest = `ORDER BY d.changed_at DESC, d.deployment_id DESC, d.repository_id, d.instance`;
const write = `INSERT INTO gitlab_deployments(instance,repository_id,deployment_id,environment,environment_tier,sha,status,changed_at,project_url,job_url)
  VALUES(?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(instance,repository_id,deployment_id) DO UPDATE SET
    environment_tier=COALESCE(excluded.environment_tier,gitlab_deployments.environment_tier),
    status=excluded.status, changed_at=excluded.changed_at, project_url=excluded.project_url,
    job_url=CASE WHEN excluded.project_url=gitlab_deployments.project_url
      THEN COALESCE(excluded.job_url,gitlab_deployments.job_url) ELSE excluded.job_url END
  WHERE excluded.sha=gitlab_deployments.sha AND excluded.environment=gitlab_deployments.environment
    AND excluded.changed_at>gitlab_deployments.changed_at
    AND (gitlab_deployments.status IN ('blocked','running') OR excluded.status NOT IN ('blocked','running'))`;

type StoredDeployment = Omit<GitlabDeployment, 'environmentTier' | 'jobUrl'> & { environmentTier: string | null; jobUrl: string | null };
type Evidence = Pick<GitlabDeployment, 'instance' | 'repositoryId' | 'sha'>;

export class GitlabDeploymentError extends Error {
  readonly status = 400;

  constructor() { super('백업의 GitLab 배포 데이터 형식을 확인해 주세요.'); }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveId(value: unknown): number | undefined {
  const id = typeof value === 'string' && /^[1-9]\d{0,15}$/u.test(value) ? Number(value) : value;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return id;
}

function label(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value &&
    value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function revision(value: unknown): string | undefined {
  const sha = gitlabObjectSha(value);
  return sha && !/^0+$/u.test(sha) ? sha : undefined;
}

function isState(value: unknown): value is GitlabDeploymentState {
  return STATES.has(value);
}

function canonicalTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || !isCalendarDate(value.slice(0, 10))) return;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > Date.now()) return;
  const canonical = new Date(time).toISOString();
  if (canonical.length === 24) return canonical;
}

function fingerprint(baseUrl: string): string {
  return createHash('sha256').update(baseUrl).digest('hex').slice(0, 12);
}

function publicRow({ environmentTier, jobUrl, ...record }: StoredDeployment): GitlabDeployment {
  return { ...record, ...(environmentTier === null ? {} : { environmentTier }), ...(jobUrl === null ? {} : { jobUrl }) };
}

function jobAddress(projectUrl: string, jobId: number): string {
  return `${projectUrl}/-/jobs/${jobId}`;
}

function parseObservation(instance: string, baseUrl: string, repositoryId: number, raw: unknown): GitlabDeployment | undefined {
  const input = object(raw), project = object(input?.project);
  if (!input || !project || !positiveId(repositoryId) || positiveId(project.id) !== repositoryId ||
      input.object_kind !== undefined && input.object_kind !== 'deployment' ||
      input.project_id !== undefined && positiveId(input.project_id) !== repositoryId ||
      !INSTANCE.test(instance) || fingerprint(baseUrl) !== instance) return;

  const deploymentId = positiveId(input.deployment_id);
  const { environment, status } = input;
  const changedAt = canonicalTime(input.status_changed_at);
  const repository = gitlabRepositoryUrl(baseUrl, project);
  if (!deploymentId || !label(environment, 255) || !isState(status) || !changedAt || !repository) return;

  const projectUrl = repository.href;
  const commitUrl = gitlabScopedPushUrl(baseUrl, input.commit_url);
  if (!commitUrl) return;
  const urlSha = new URL(commitUrl).pathname.match(SHA_PATH)?.[1];
  const sha = revision(urlSha);
  if (!urlSha || !sha || commitUrl !== gitlabPushLinkUrl(repository, 'commit', urlSha)) return;
  if (input.short_sha != null && (typeof input.short_sha !== 'string' || !/^[a-f\d]{4,64}$/iu.test(input.short_sha) ||
      !sha.startsWith(input.short_sha.toLowerCase()))) return;

  const environmentTier = input.environment_tier ?? undefined;
  if (environmentTier !== undefined && !label(environmentTier, 64)) return;
  const jobId = positiveId(input.deployable_id);
  if (input.deployable_id != null && !jobId) return;
  const jobUrl = input.deployable_url == null ? undefined : gitlabScopedPushUrl(baseUrl, input.deployable_url);
  if (input.deployable_url != null && (!jobId || jobUrl !== jobAddress(projectUrl, jobId))) return;

  return { instance, repositoryId, deploymentId, environment, sha, status, changedAt, projectUrl,
    ...(environmentTier === undefined ? {} : { environmentTier }), ...(jobUrl ? { jobUrl } : {}) };
}

// Check that the repository belongs to the saved origin and base path represented by its instance key.
function isInstanceRepository(instance: string, projectUrl: string): boolean {
  if (projectUrl.length > 4_000) return false;
  let url: URL;
  try { url = new URL(projectUrl); }
  catch { return false; }
  const segments = url.pathname.slice(1).split('/');
  for (let length = 0; length <= segments.length - 2; length++) {
    const base = length ? `${url.origin}/${segments.slice(0, length).join('/')}` : url.origin;
    if (fingerprint(base) === instance && gitlabRepositoryUrl(base, { web_url: projectUrl })?.href === projectUrl) return true;
  }
  return false;
}

function parseBackupRow(raw: unknown, exportedAt: string): GitlabDeployment | undefined {
  const input = object(raw);
  if (!input || Object.keys(input).some(key => !FIELDS.has(key))) return;
  const { instance, repositoryId, deploymentId, environment, environmentTier, sha, status, changedAt, projectUrl, jobUrl } = input;
  if (typeof instance !== 'string' || !INSTANCE.test(instance) || typeof repositoryId !== 'number' || !positiveId(repositoryId) ||
      typeof deploymentId !== 'number' || !positiveId(deploymentId) || !label(environment, 255) ||
      environmentTier !== undefined && !label(environmentTier, 64) || typeof sha !== 'string' || revision(sha) !== sha ||
      !isState(status) || typeof changedAt !== 'string' || canonicalTime(changedAt) !== changedAt || changedAt > exportedAt ||
      typeof projectUrl !== 'string' || !isInstanceRepository(instance, projectUrl)) return;

  if (jobUrl !== undefined) {
    const jobId = typeof jobUrl === 'string' && jobUrl.length <= 4_000 && positiveId(jobUrl.match(JOB_PATH)?.[1]);
    if (!jobId || jobUrl !== jobAddress(projectUrl, jobId)) return;
  }

  return { instance, repositoryId, deploymentId, environment, sha, status, changedAt, projectUrl,
    ...(environmentTier === undefined ? {} : { environmentTier }), ...(typeof jobUrl === 'string' ? { jobUrl } : {}) };
}

function linkEvidence(link: GitlabLink): Evidence[] {
  if (typeof link.id !== 'string' || !positiveId(link.projectId)) return [];
  const [, instance, , , objectId] = link.id.split(':', 5);
  if (!INSTANCE.test(instance) || link.id !== `gitlab:${instance}:${link.projectId}:${link.kind}:${objectId}:${link.issueId}`) return [];
  const evidence = (sha: string): Evidence => ({ instance, repositoryId: link.projectId, sha });
  if (link.kind === 'commit') {
    const sha = revision(link.sourceSha);
    return sha && revision(objectId) === sha ? [evidence(sha)] : [];
  }
  if (!positiveId(objectId)) return [];
  if (link.kind === 'pipeline') {
    const sha = revision(link.sourceSha);
    return sha ? [evidence(sha)] : [];
  }
  if (link.kind === 'merge_request' && link.state === 'merged' && Array.isArray(link.mergeCommitShas)) {
    return link.mergeCommitShas.flatMap(value => {
      const sha = revision(value);
      return sha ? [evidence(sha)] : [];
    });
  }
  return [];
}

export class GitlabDeployments {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS gitlab_deployments (
      instance TEXT NOT NULL, repository_id INTEGER NOT NULL, deployment_id INTEGER NOT NULL,
      environment TEXT NOT NULL, environment_tier TEXT, sha TEXT NOT NULL, status TEXT NOT NULL,
      changed_at TEXT NOT NULL, project_url TEXT NOT NULL, job_url TEXT,
      PRIMARY KEY(instance, repository_id, deployment_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS gitlab_deployments_revision ON gitlab_deployments(instance,repository_id,sha);
    CREATE INDEX IF NOT EXISTS gitlab_deployments_repository ON gitlab_deployments(instance,repository_id,changed_at DESC,deployment_id DESC);`);
  }

  /** The webhook caller includes this observation in the same transaction as its delivery receipt. */
  observe(instance: string, baseUrl: string, repositoryId: number, raw: unknown): boolean {
    const observation = parseObservation(instance, baseUrl, repositoryId, raw);
    return observation ? this.save(observation) : false;
  }

  issuePage(issueId: string, offset: number): GitlabDeploymentPage {
    const links = this.store.db.prepare('SELECT json FROM gitlab_links WHERE issue_id=?').all(issueId) as { json: string }[];
    const evidence = new Map<string, Evidence>();
    for (const { json } of links) {
      const link = JSON.parse(json) as GitlabLink;
      for (const value of linkEvidence(link)) evidence.set(`${value.instance}:${value.repositoryId}:${value.sha}`, value);
    }
    if (!evidence.size) return { items: [], total: 0, offset, limit: PAGE_SIZE };
    const query = `FROM json_each(?) e
      JOIN gitlab_deployments d ON d.instance=json_extract(e.value,'$.instance')
      AND d.repository_id=json_extract(e.value,'$.repositoryId') AND d.sha=json_extract(e.value,'$.sha')`;
    return this.page(query, [JSON.stringify([...evidence.values()])], offset);
  }

  repositoryPage(instance: string, repositoryId: number, offset: number): GitlabDeploymentPage {
    return this.page('FROM gitlab_deployments d WHERE d.instance=? AND d.repository_id=?', [instance, repositoryId], offset);
  }

  exportRows(): GitlabDeployment[] {
    return (this.store.db.prepare(`SELECT ${select} FROM gitlab_deployments d ORDER BY d.instance,d.repository_id,d.deployment_id`).all() as StoredDeployment[]).map(publicRow);
  }

  /** Replace observations inside the caller's workspace restore transaction. */
  restore(raw: unknown, exportedAt: unknown): void {
    if (!Array.isArray(raw) || raw.length > 0 && (typeof exportedAt !== 'string' || canonicalTime(exportedAt) !== exportedAt)) {
      throw new GitlabDeploymentError();
    }
    const seen = new Set<string>();
    const records = raw.map(value => {
      const record = parseBackupRow(value, exportedAt as string);
      if (!record) throw new GitlabDeploymentError();
      const identity = `${record.instance}:${record.repositoryId}:${record.deploymentId}`;
      if (seen.has(identity)) throw new GitlabDeploymentError();
      seen.add(identity);
      return record;
    });
    this.store.db.exec('DELETE FROM gitlab_deployments');
    for (const record of records) this.save(record);
  }

  private page(query: string, arguments_: (string | number)[], offset: number): GitlabDeploymentPage {
    const { total } = this.store.db.prepare(`SELECT COUNT(*) AS total ${query}`).get(...arguments_) as { total: number };
    const rows = this.store.db.prepare(`SELECT ${select} ${query} ${byLatest} LIMIT ? OFFSET ?`)
      .all(...arguments_, PAGE_SIZE, offset) as StoredDeployment[];
    return { items: rows.map(publicRow), total, offset, limit: PAGE_SIZE };
  }

  private save({ instance, repositoryId, deploymentId, environment, environmentTier, sha, status, changedAt, projectUrl, jobUrl }: GitlabDeployment): boolean {
    return this.store.db.prepare(write).run(instance, repositoryId, deploymentId, environment, environmentTier ?? null,
      sha, status, changedAt, projectUrl, jobUrl ?? null).changes === 1;
  }
}
