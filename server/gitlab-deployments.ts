import { createHash } from 'node:crypto';
import { isGitlabDeploymentEnvironment } from '../shared/automation.js';
import { isCalendarDate } from '../shared/calendar.js';
import { gitlabObjectSha } from '../shared/gitlab-links.js';
import { GITLAB_DEPLOYMENT_STATES, type GitlabDeployment, type GitlabDeploymentMergeRequest, type GitlabDeploymentPage, type GitlabDeploymentState, type GitlabDeploymentStatusBinding, type GitlabLink } from '../shared/types.js';
import { gitlabPushLinkUrl, gitlabRepositoryUrl, gitlabScopedPushUrl } from './gitlab-push.js';
import type { Store } from './store.js';

const PAGE_SIZE = 50;
const MERGE_REQUEST_LIMIT = 250;
const STATES: ReadonlySet<unknown> = new Set(GITLAB_DEPLOYMENT_STATES);
const WEBHOOK_STATES: ReadonlySet<unknown> = new Set(['blocked', 'running', 'success', 'failed', 'canceled']);
const INSTANCE = /^[a-f0-9]{12}$/u;
const SHA_PATH = /\/-\/commit\/([a-f\d]{40}|[a-f\d]{64})$/iu;
const JOB_PATH = /\/-\/jobs\/([1-9]\d*)$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const LEGACY_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/u;
const FIELDS = new Set(['instance', 'repositoryId', 'deploymentId', 'environment', 'environmentTier', 'sha', 'status', 'changedAt', 'projectUrl', 'jobUrl', 'source', 'mergeRequests']);
const select = `d.instance, d.repository_id AS repositoryId, d.deployment_id AS deploymentId,
  d.environment, d.environment_tier AS environmentTier, d.sha, d.status, d.changed_at AS changedAt,
  d.project_url AS projectUrl, d.job_url AS jobUrl, d.source,
  (SELECT json_group_array(json_object('id',m.merge_request_id,'iid',m.merge_request_iid) ORDER BY m.merge_request_id)
    FROM gitlab_deployment_merge_requests m
    WHERE m.instance=d.instance AND m.repository_id=d.repository_id AND m.deployment_id=d.deployment_id) AS mergeRequests`;
const byLatest = `ORDER BY d.changed_at DESC, d.deployment_id DESC, d.repository_id, d.instance`;
const write = `INSERT INTO gitlab_deployments(instance,repository_id,deployment_id,environment,environment_tier,sha,status,changed_at,project_url,job_url,source,webhook_received_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(instance,repository_id,deployment_id) DO UPDATE SET
    environment_tier=COALESCE(excluded.environment_tier,gitlab_deployments.environment_tier),
    status=excluded.status, changed_at=excluded.changed_at, project_url=excluded.project_url,
    source=excluded.source, webhook_received_at=COALESCE(excluded.webhook_received_at,gitlab_deployments.webhook_received_at),
    status_review_evidence=NULL,
    job_url=CASE WHEN excluded.project_url=gitlab_deployments.project_url
      THEN COALESCE(excluded.job_url,gitlab_deployments.job_url) ELSE excluded.job_url END
  WHERE excluded.sha=gitlab_deployments.sha AND excluded.environment=gitlab_deployments.environment
    AND (excluded.changed_at>gitlab_deployments.changed_at OR
      excluded.changed_at=gitlab_deployments.changed_at AND gitlab_deployments.source='sync' AND excluded.source IS NULL)
    AND (gitlab_deployments.status IN ('created','blocked','running') OR excluded.status NOT IN ('created','blocked','running'))
    AND (excluded.source IS NULL OR gitlab_deployments.webhook_received_at IS NULL OR gitlab_deployments.webhook_received_at<?)`;

type StoredDeployment = Omit<GitlabDeployment, 'environmentTier' | 'jobUrl' | 'source' | 'mergeRequests'> & {
  environmentTier: string | null; jobUrl: string | null; source: 'sync' | null; mergeRequests: string;
};
type ReviewDeployment = StoredDeployment & { webhookReceivedAt: number | null; statusReviewEvidence: string | null };
type DeploymentScope = Pick<GitlabDeployment, 'instance' | 'repositoryId'>;
type DeploymentIdentity = DeploymentScope & Pick<GitlabDeployment, 'deploymentId'>;
type ShaEvidence = DeploymentScope & Pick<GitlabDeployment, 'sha'>;
type MergeRequestEvidence = DeploymentScope & GitlabDeploymentMergeRequest;
type LinkScope = DeploymentScope & { objectId: string };

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

export function gitlabDeploymentTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  let candidate = value;
  const legacy = LEGACY_TIMESTAMP.exec(value);
  if (legacy) {
    const [, date, time, zone] = legacy;
    const offset = zone === 'UTC' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    candidate = `${date}T${time}${offset}`;
  }
  if (!TIMESTAMP.test(candidate) || !isCalendarDate(candidate.slice(0, 10))) return;
  const time = Date.parse(candidate);
  if (!Number.isFinite(time) || time > Date.now()) return;
  const canonical = new Date(time).toISOString();
  if (canonical.length === 24) return canonical;
}

function fingerprint(baseUrl: string): string {
  return createHash('sha256').update(baseUrl).digest('hex').slice(0, 12);
}

function publicRow(row: StoredDeployment, exporting = false): GitlabDeployment {
  const { instance, repositoryId, deploymentId, environment, environmentTier, sha, status, changedAt, projectUrl, jobUrl, source, mergeRequests } = row;
  return { instance, repositoryId, deploymentId, environment, sha, status, changedAt, projectUrl,
    ...(environmentTier === null ? {} : { environmentTier }), ...(jobUrl === null ? {} : { jobUrl }),
    ...(source === null ? {} : { source }),
    ...(mergeRequests !== '[]' && (exporting || status === 'success') ? { mergeRequests: JSON.parse(mergeRequests) as GitlabDeploymentMergeRequest[] } : {}) };
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
  const changedAt = gitlabDeploymentTime(input.status_changed_at);
  const repository = gitlabRepositoryUrl(baseUrl, project);
  if (!deploymentId || !isGitlabDeploymentEnvironment(environment) || !isState(status) || !WEBHOOK_STATES.has(status) || !changedAt || !repository) return;

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

function parseMergeRequests(value: unknown): GitlabDeploymentMergeRequest[] | undefined {
  if (!Array.isArray(value) || value.length > MERGE_REQUEST_LIMIT) return;
  const ids = new Set<number>(), iids = new Set<number>();
  const result: GitlabDeploymentMergeRequest[] = [];
  for (const item of value) {
    const record = object(item);
    if (!record || Object.keys(record).length !== 2 || typeof record.id !== 'number' || typeof record.iid !== 'number' ||
        !positiveId(record.id) || !positiveId(record.iid) || ids.has(record.id) || iids.has(record.iid)) return;
    ids.add(record.id);
    iids.add(record.iid);
    result.push({ id: record.id, iid: record.iid });
  }
  return result.sort((left, right) => left.id - right.id);
}

function parseStoredRow(raw: unknown, latestTime: string): GitlabDeployment | undefined {
  const input = object(raw);
  if (!input || Object.keys(input).some(key => !FIELDS.has(key))) return;
  const { instance, repositoryId, deploymentId, environment, environmentTier, sha, status, changedAt, projectUrl, jobUrl, source, mergeRequests } = input;
  if (typeof instance !== 'string' || !INSTANCE.test(instance) || typeof repositoryId !== 'number' || !positiveId(repositoryId) ||
      typeof deploymentId !== 'number' || !positiveId(deploymentId) || !isGitlabDeploymentEnvironment(environment) ||
      environmentTier !== undefined && !label(environmentTier, 64) || typeof sha !== 'string' || revision(sha) !== sha ||
      !isState(status) || (source === undefined ? !WEBHOOK_STATES.has(status) : source !== 'sync') ||
      typeof changedAt !== 'string' || gitlabDeploymentTime(changedAt) !== changedAt || changedAt > latestTime ||
      typeof projectUrl !== 'string' || !isInstanceRepository(instance, projectUrl)) return;

  if (jobUrl !== undefined) {
    const jobId = typeof jobUrl === 'string' && jobUrl.length <= 4_000 && positiveId(jobUrl.match(JOB_PATH)?.[1]);
    if (!jobId || jobUrl !== jobAddress(projectUrl, jobId)) return;
  }
  const associations = mergeRequests === undefined ? [] : parseMergeRequests(mergeRequests);
  if (!associations) return;

  return { instance, repositoryId, deploymentId, environment, sha, status, changedAt, projectUrl,
    ...(environmentTier === undefined ? {} : { environmentTier }), ...(typeof jobUrl === 'string' ? { jobUrl } : {}),
    ...(source === 'sync' ? { source } : {}), ...(associations.length ? { mergeRequests: associations } : {}) };
}

function linkScope(link: GitlabLink): LinkScope | undefined {
  if (typeof link.id !== 'string' || !positiveId(link.projectId)) return;
  const [, instance, , , objectId] = link.id.split(':', 5);
  if (!INSTANCE.test(instance) || link.id !== `gitlab:${instance}:${link.projectId}:${link.kind}:${objectId}:${link.issueId}`) return;
  return { instance, repositoryId: link.projectId, objectId };
}

function linkEvidence(link: GitlabLink, { instance, repositoryId, objectId }: LinkScope): ShaEvidence[] {
  const evidence = (sha: string): ShaEvidence => ({ instance, repositoryId, sha });
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

function mergeRequestLinkEvidence(link: GitlabLink, { instance, repositoryId, objectId }: LinkScope): MergeRequestEvidence | undefined {
  if (link.kind === 'merge_request' && typeof link.iid === 'number' && positiveId(link.iid) && positiveId(objectId)) {
    return { instance, repositoryId, id: Number(objectId), iid: link.iid };
  }
}

function matchesDeploymentLink(link: GitlabLink, deployment: GitlabDeployment): boolean {
  const scope = linkScope(link);
  if (!scope || scope.instance !== deployment.instance || scope.repositoryId !== deployment.repositoryId) return false;
  if (linkEvidence(link, scope).some(({ sha }) => sha === deployment.sha)) return true;
  const mergeRequest = mergeRequestLinkEvidence(link, scope);
  return deployment.status === 'success' && !!mergeRequest &&
    !!deployment.mergeRequests?.some(({ id, iid }) => id === mergeRequest.id && iid === mergeRequest.iid);
}

export class GitlabDeployments {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS gitlab_deployments (
      instance TEXT NOT NULL, repository_id INTEGER NOT NULL, deployment_id INTEGER NOT NULL,
      environment TEXT NOT NULL, environment_tier TEXT, sha TEXT NOT NULL, status TEXT NOT NULL,
      changed_at TEXT NOT NULL, project_url TEXT NOT NULL, job_url TEXT, source TEXT, webhook_received_at INTEGER,
      status_review_evidence TEXT,
      PRIMARY KEY(instance, repository_id, deployment_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS gitlab_deployments_revision ON gitlab_deployments(instance,repository_id,sha);
    CREATE INDEX IF NOT EXISTS gitlab_deployments_repository ON gitlab_deployments(instance,repository_id,changed_at DESC,deployment_id DESC);
    CREATE INDEX IF NOT EXISTS gitlab_deployments_environment_success
      ON gitlab_deployments(instance,repository_id,environment,changed_at DESC)
      WHERE status='success';
    CREATE TABLE IF NOT EXISTS gitlab_deployment_merge_requests (
      instance TEXT NOT NULL, repository_id INTEGER NOT NULL, deployment_id INTEGER NOT NULL,
      merge_request_id INTEGER NOT NULL, merge_request_iid INTEGER NOT NULL,
      PRIMARY KEY(instance, repository_id, deployment_id, merge_request_id),
      UNIQUE(instance, repository_id, deployment_id, merge_request_iid),
      FOREIGN KEY(instance, repository_id, deployment_id)
        REFERENCES gitlab_deployments(instance, repository_id, deployment_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS gitlab_deployment_merge_requests_proof
      ON gitlab_deployment_merge_requests(instance,repository_id,merge_request_id,merge_request_iid,deployment_id);`);
    const columns = new Set(store.db.prepare('PRAGMA table_info(gitlab_deployments)').all().map(row => row.name));
    if (!columns.has('source')) store.db.exec('ALTER TABLE gitlab_deployments ADD COLUMN source TEXT');
    if (!columns.has('webhook_received_at')) store.db.exec('ALTER TABLE gitlab_deployments ADD COLUMN webhook_received_at INTEGER');
    if (!columns.has('status_review_evidence')) store.db.exec('ALTER TABLE gitlab_deployments ADD COLUMN status_review_evidence TEXT');
  }

  /** The webhook caller saves this observation with its receipt and any status changes. */
  observe(instance: string, baseUrl: string, repositoryId: number, raw: unknown,
    onSuccess?: (deployment: GitlabDeployment, fresh: boolean) => void): boolean {
    const observation = parseObservation(instance, baseUrl, repositoryId, raw);
    if (!observation) return false;
    const handleSuccess = observation.status === 'success' ? onSuccess : undefined;
    const previous = handleSuccess
      ? this.store.db.prepare(`SELECT status,source,changed_at AS changedAt FROM gitlab_deployments
        WHERE instance=? AND repository_id=? AND deployment_id=?`).get(instance, repositoryId, observation.deploymentId) as
          Pick<StoredDeployment, 'status' | 'source' | 'changedAt'> | undefined
      : undefined;
    if (!this.save(observation, Date.now())) return false;
    if (handleSuccess) {
      const advances = !previous || previous.source === 'sync' && previous.status === 'success' ||
        previous.changedAt < observation.changedAt && previous.status !== 'success';
      const superseded = advances && this.store.db.prepare(`SELECT 1 FROM gitlab_deployments
        WHERE instance=? AND repository_id=? AND environment=? AND status='success' AND changed_at>=? AND deployment_id<>?
        LIMIT 1`).get(instance, repositoryId, observation.environment, observation.changedAt, observation.deploymentId);
      handleSuccess(observation, advances && !superseded);
    }
    return true;
  }

  /** The caller checks the saved connection version and applies the read inside a repository transaction. */
  recordSync(instance: string, repositoryId: number, rows: readonly Omit<GitlabDeployment, 'instance'>[], capturedAt: number) {
    const latestTime = new Date().toISOString();
    const stored = new Set<number>();
    let mergeRequestsStored = 0;
    if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0 || capturedAt > Date.now()) throw new GitlabDeploymentError();
    for (const candidate of rows) {
      const deployment = parseStoredRow({ ...candidate, instance }, latestTime);
      if (deployment?.repositoryId !== repositoryId || deployment.source !== 'sync') throw new GitlabDeploymentError();
      if (this.save(deployment, null, capturedAt)) stored.add(deployment.deploymentId);
      if (deployment.status === 'success') mergeRequestsStored += this.saveMergeRequests(deployment);
    }
    return { stored: stored.size, mergeRequestsStored };
  }

  private scopedRow({ instance, repositoryId, deploymentId }: DeploymentIdentity): ReviewDeployment | undefined {
    return this.store.db.prepare(`SELECT ${select}, d.webhook_received_at AS webhookReceivedAt, d.status_review_evidence AS statusReviewEvidence
      FROM gitlab_deployments d
      WHERE d.instance=? AND d.repository_id=? AND d.deployment_id=?`).get(instance, repositoryId, deploymentId) as ReviewDeployment | undefined;
  }

  deployment(identity: DeploymentIdentity): GitlabDeployment | undefined {
    const row = this.scopedRow(identity);
    if (row) return publicRow(row);
  }

  issueReviewTarget(issueId: string, identity: DeploymentIdentity) {
    const row = this.scopedRow(identity);
    if (!row) return;
    const deployment = publicRow(row);
    const prefix = `gitlab:${identity.instance}:${identity.repositoryId}`;
    const rows = this.store.db.prepare(`SELECT json FROM gitlab_links WHERE issue_id=? AND id>=? AND id<? ORDER BY id`)
      .all(issueId, `${prefix}:`, `${prefix};`) as { json: string }[];
    const links = rows.map(({ json }) => JSON.parse(json) as GitlabLink);
    if (links.some(link => matchesDeploymentLink(link, deployment))) {
      return { deployment, links, fence: JSON.stringify([row, rows, this.competingSuccesses(deployment)]) };
    }
  }

  reviewLink(links: readonly GitlabLink[], freshlyRead: GitlabDeployment): GitlabLink | undefined {
    return links.find(link => !link.manualLinkId && matchesDeploymentLink(link, freshlyRead));
  }

  private latestOtherSuccess(deployment: GitlabDeployment, webhook: boolean) {
    const { instance, repositoryId, environment, deploymentId } = deployment;
    return this.store.db.prepare(`SELECT deployment_id AS deploymentId, sha, changed_at AS changedAt, source,
      webhook_received_at AS webhookReceivedAt FROM gitlab_deployments
      WHERE instance=? AND repository_id=? AND environment=? AND status='success' AND deployment_id<>?
        AND (source IS NULL)=?
      ORDER BY changed_at DESC, deployment_id DESC LIMIT 1`).get(instance, repositoryId, environment, deploymentId, Number(webhook)) as
        { deploymentId: number; sha: string; changedAt: string; source: string | null; webhookReceivedAt: number | null } | undefined;
  }

  private competingSuccesses(deployment: GitlabDeployment) {
    const { instance, repositoryId, environment, deploymentId } = deployment;
    const reviewed = this.store.db.prepare(`SELECT deployment_id AS deploymentId, sha,
      json_extract(status_review_evidence,'$.finishedAt') AS finishedAt FROM gitlab_deployments
      WHERE instance=? AND repository_id=? AND environment=? AND status='success' AND deployment_id<>?
        AND status_review_evidence IS NOT NULL
      ORDER BY finishedAt DESC, deployment_id DESC LIMIT 1`).get(instance, repositoryId, environment, deploymentId) as
        { deploymentId: number; sha: string; finishedAt: string } | undefined;
    return { webhook: this.latestOtherSuccess(deployment, true), sync: this.latestOtherSuccess(deployment, false), reviewed };
  }

  hasCompetingSuccess(deployment: GitlabDeployment, occurredAt: string): boolean {
    const { webhook, reviewed } = this.competingSuccesses(deployment);
    return !!webhook && webhook.changedAt >= occurredAt || !!reviewed && reviewed.finishedAt >= occurredAt;
  }

  // Exact review evidence is refreshed independently of the associations accumulated for deployment history.
  recordReviewEvidence({ instance, repositoryId, deploymentId, mergeRequests }: GitlabDeployment, finishedAt: string | null): void {
    const proof = finishedAt ? JSON.stringify({ finishedAt, mergeRequests: [...(mergeRequests ?? [])].sort((a, b) => a.id - b.id) }) : null;
    this.store.db.prepare(`UPDATE gitlab_deployments SET status_review_evidence=? WHERE instance=? AND repository_id=? AND deployment_id=?`)
      .run(proof, instance, repositoryId, deploymentId);
  }

  statusReviewProof(issueId: string, binding: GitlabDeploymentStatusBinding): string | null {
    const { linkId, occurredAt } = binding;
    if (gitlabDeploymentTime(occurredAt) !== occurredAt) return null;
    const row = this.scopedRow(binding);
    if (row?.status !== 'success' || !row.statusReviewEvidence) return null;
    const deployment = publicRow(row);
    const { finishedAt, mergeRequests } = JSON.parse(row.statusReviewEvidence) as { finishedAt: string; mergeRequests: GitlabDeploymentMergeRequest[] };
    const link = this.store.get<GitlabLink>('gitlab_links', linkId);
    if (finishedAt !== occurredAt || !link || link.issueId !== issueId || link.manualLinkId ||
        !matchesDeploymentLink(link, { ...deployment, mergeRequests }) || !matchesDeploymentLink(link, deployment)) return null;
    const competing = this.competingSuccesses(deployment);
    if (competing.webhook && competing.webhook.changedAt >= occurredAt || competing.reviewed && competing.reviewed.finishedAt >= occurredAt) return null;
    return createHash('sha256').update(JSON.stringify([row, link, competing])).digest('hex');
  }

  matchingAutomaticLinks({ instance, repositoryId, deploymentId, sha }: GitlabDeployment): GitlabLink[] {
    const mergeRequests = new Set(this.store.db.prepare(`SELECT merge_request_id AS id, merge_request_iid AS iid
      FROM gitlab_deployment_merge_requests WHERE instance=? AND repository_id=? AND deployment_id=?`)
      .all(instance, repositoryId, deploymentId).map(({ id, iid }) => `${id}:${iid}`));
    const prefix = `gitlab:${instance}:${repositoryId}`;
    const rows = this.store.db.prepare(`SELECT json FROM gitlab_links
      WHERE id>=? AND id<? AND json_extract(json,'$.manualLinkId') IS NULL AND (
        json_extract(json,'$.kind')='merge_request' OR
        json_extract(json,'$.kind') IN ('commit','pipeline') AND lower(json_extract(json,'$.sourceSha'))=?
      ) ORDER BY id`).all(`${prefix}:`, `${prefix};`, sha) as { json: string }[];
    return rows.flatMap(({ json }) => {
      const link = JSON.parse(json) as GitlabLink;
      const scope = linkScope(link);
      if (!scope || scope.instance !== instance || scope.repositoryId !== repositoryId) return [];
      const mergeRequest = mergeRequestLinkEvidence(link, scope);
      const exactMergeRequest = mergeRequest && mergeRequests.has(`${mergeRequest.id}:${mergeRequest.iid}`);
      return exactMergeRequest || linkEvidence(link, scope).some(evidence => evidence.sha === sha) ? [link] : [];
    });
  }

  issuePage(issueId: string, offset: number): GitlabDeploymentPage {
    const links = this.store.db.prepare('SELECT json FROM gitlab_links WHERE issue_id=?').all(issueId) as { json: string }[];
    const shaEvidence = new Map<string, ShaEvidence>();
    const mergeRequestEvidence = new Map<string, MergeRequestEvidence>();
    for (const { json } of links) {
      const link = JSON.parse(json) as GitlabLink;
      const scope = linkScope(link);
      if (!scope) continue;
      for (const value of linkEvidence(link, scope)) shaEvidence.set(`${value.instance}:${value.repositoryId}:${value.sha}`, value);
      const mergeRequest = mergeRequestLinkEvidence(link, scope);
      if (mergeRequest) {
        const { instance, repositoryId, id, iid } = mergeRequest;
        mergeRequestEvidence.set(`${instance}:${repositoryId}:${id}:${iid}`, mergeRequest);
      }
    }
    if (!shaEvidence.size && !mergeRequestEvidence.size) return { items: [], total: 0, offset, limit: PAGE_SIZE };
    const query = `FROM (
      SELECT r.instance,r.repository_id,r.deployment_id FROM json_each(?) e
      JOIN gitlab_deployments r ON r.instance=json_extract(e.value,'$.instance')
        AND r.repository_id=json_extract(e.value,'$.repositoryId') AND r.sha=json_extract(e.value,'$.sha')
      UNION
      SELECT m.instance,m.repository_id,m.deployment_id FROM json_each(?) e
      JOIN gitlab_deployment_merge_requests m ON m.instance=json_extract(e.value,'$.instance')
        AND m.repository_id=json_extract(e.value,'$.repositoryId') AND m.merge_request_id=json_extract(e.value,'$.id')
        AND m.merge_request_iid=json_extract(e.value,'$.iid')
      JOIN gitlab_deployments r USING(instance,repository_id,deployment_id) WHERE r.status='success'
    ) AS matched JOIN gitlab_deployments d USING(instance,repository_id,deployment_id)`;
    return this.page(query, [JSON.stringify([...shaEvidence.values()]), JSON.stringify([...mergeRequestEvidence.values()])], offset);
  }

  repositoryPage(instance: string, repositoryId: number, offset: number): GitlabDeploymentPage {
    return this.page('FROM gitlab_deployments d WHERE d.instance=? AND d.repository_id=?', [instance, repositoryId], offset);
  }

  exportRows(): GitlabDeployment[] {
    return (this.store.db.prepare(`SELECT ${select} FROM gitlab_deployments d ORDER BY d.instance,d.repository_id,d.deployment_id`).all() as StoredDeployment[])
      .map(row => publicRow(row, true));
  }

  /** Replace observations inside the caller's workspace restore transaction. */
  restore(raw: unknown, exportedAt: unknown): void {
    if (!Array.isArray(raw) || raw.length > 0 && (typeof exportedAt !== 'string' || gitlabDeploymentTime(exportedAt) !== exportedAt)) {
      throw new GitlabDeploymentError();
    }
    const seen = new Set<string>();
    const records = raw.map(value => {
      const record = parseStoredRow(value, exportedAt as string);
      if (!record) throw new GitlabDeploymentError();
      const identity = `${record.instance}:${record.repositoryId}:${record.deploymentId}`;
      if (seen.has(identity)) throw new GitlabDeploymentError();
      seen.add(identity);
      return record;
    });
    this.store.db.exec('DELETE FROM gitlab_deployments');
    for (const record of records) {
      this.save(record);
      this.saveMergeRequests(record);
    }
  }

  private page(query: string, arguments_: (string | number)[], offset: number): GitlabDeploymentPage {
    const { total } = this.store.db.prepare(`SELECT COUNT(*) AS total ${query}`).get(...arguments_) as { total: number };
    const rows = this.store.db.prepare(`SELECT ${select} ${query} ${byLatest} LIMIT ? OFFSET ?`)
      .all(...arguments_, PAGE_SIZE, offset) as StoredDeployment[];
    return { items: rows.map(row => publicRow(row)), total, offset, limit: PAGE_SIZE };
  }

  private save({ instance, repositoryId, deploymentId, environment, environmentTier, sha, status, changedAt, projectUrl, jobUrl, source }: GitlabDeployment,
    receivedAt: number | null = null, capturedAt: number | null = null): boolean {
    return this.store.db.prepare(write).run(instance, repositoryId, deploymentId, environment, environmentTier ?? null,
      sha, status, changedAt, projectUrl, jobUrl ?? null, source ?? null, receivedAt, capturedAt).changes === 1;
  }

  private saveMergeRequests({ instance, repositoryId, deploymentId, sha, environment, mergeRequests }: GitlabDeployment): number {
    if (!mergeRequests?.length) return 0;
    const current = this.store.db.prepare(`SELECT sha, environment FROM gitlab_deployments
      WHERE instance=? AND repository_id=? AND deployment_id=?`).get(instance, repositoryId, deploymentId);
    if (current?.sha !== sha || current.environment !== environment) return 0;
    const { total } = this.store.db.prepare(`SELECT COUNT(*) AS total FROM gitlab_deployment_merge_requests
      WHERE instance=? AND repository_id=? AND deployment_id=?`).get(instance, repositoryId, deploymentId) as { total: number };
    const insert = this.store.db.prepare(`INSERT INTO gitlab_deployment_merge_requests
      (instance,repository_id,deployment_id,merge_request_id,merge_request_iid) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`);
    let inserted = 0;
    for (const { id, iid } of mergeRequests) {
      if (total + inserted >= MERGE_REQUEST_LIMIT) break;
      inserted += Number(insert.run(instance, repositoryId, deploymentId, id, iid).changes);
    }
    return inserted;
  }
}
