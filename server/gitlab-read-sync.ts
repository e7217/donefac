import { gitlabRepositoryUrl } from './gitlab-push.js';

export type GitlabReadObject = Record<string, unknown>;
export type GitlabReadStage = 'merge-requests' | 'pipelines' | 'project' | 'branches' | 'commits';
type GitlabReadErrorCode = 'http' | 'timeout' | 'network' | 'invalid-response' | 'response-too-large';
type Connection = { baseUrl: string; token?: string | null };
type ManualObjectKind = 'merge_request' | 'pipeline';
type RepositoryHistory = {
  project: GitlabReadObject;
  branches: GitlabReadObject[];
  commits: GitlabReadObject[];
  branchesLimited: boolean;
  commitsLimited: boolean;
};

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MERGE_REQUEST_PAGE_SIZE = 100;
const MAX_MERGE_REQUEST_PAGES = 10;
const PIPELINE_PAGE_SIZE = 50;
const BRANCH_PAGE_SIZE = 100;
const MAX_BRANCH_PAGES = 5;
const COMMIT_PAGE_SIZE = 100;

const stageNames: Record<GitlabReadStage, string> = {
  'merge-requests': 'MR',
  pipelines: '파이프라인',
  project: '저장소',
  branches: '브랜치',
  commits: '커밋',
};

export class GitlabReadError extends Error {
  constructor(readonly stage: GitlabReadStage, readonly code: GitlabReadErrorCode, readonly httpStatus: number | null = null) {
    const description = {
      'http': `GitLab HTTP ${httpStatus} 응답`,
      'timeout': '응답 시간 초과',
      'network': '연결 실패',
      'invalid-response': '응답 형식 오류',
      'response-too-large': '응답 크기 한도 초과',
    }[code];
    super(`${stageNames[stage]} 조회 중 ${description}`);
  }
}

export class GitlabManualUrlError extends Error {
  readonly status = 400;
}

function isReadObject(value: unknown): value is GitlabReadObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(url: URL, headers: Record<string, string>, stage: GitlabReadStage, parentSignal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
  try {
    const response = await fetch(url, { headers, signal, redirect: 'manual' });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new GitlabReadError(stage, 'http', response.status);
    }
    if (!response.body) throw new GitlabReadError(stage, 'invalid-response');
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      void response.body.cancel().catch(() => {});
      throw new GitlabReadError(stage, 'response-too-large');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw new GitlabReadError(stage, 'response-too-large');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }

    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw new GitlabReadError(stage, 'invalid-response'); }
  } catch (error) {
    if (error instanceof GitlabReadError) throw error;
    throw new GitlabReadError(stage, signal.aborted ? 'timeout' : 'network');
  }
}

async function readPage(url: URL, headers: Record<string, string>, stage: GitlabReadStage, maxRows: number, signal?: AbortSignal): Promise<GitlabReadObject[]> {
  const payload = await readJson(url, headers, stage, signal);
  if (!Array.isArray(payload) || payload.length > maxRows || !payload.every(isReadObject)) {
    throw new GitlabReadError(stage, 'invalid-response');
  }
  return payload;
}

async function readRepositoryHistory(projectUrl: URL, projectId: number, headers: Record<string, string>, signal?: AbortSignal): Promise<RepositoryHistory> {
  const project = await readJson(projectUrl, headers, 'project', signal);
  if (!isReadObject(project) || project.id !== projectId) throw new GitlabReadError('project', 'invalid-response');

  const branchesUrl = new URL(projectUrl);
  branchesUrl.pathname += '/repository/branches';
  const branches: GitlabReadObject[] = [];
  for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
    branchesUrl.search = new URLSearchParams({ per_page: String(BRANCH_PAGE_SIZE), page: String(page) }).toString();
    const rows = await readPage(branchesUrl, headers, 'branches', BRANCH_PAGE_SIZE, signal);
    branches.push(...rows);
    if (rows.length < BRANCH_PAGE_SIZE) break;
  }

  const commitsUrl = new URL(projectUrl);
  commitsUrl.pathname += '/repository/commits';
  commitsUrl.search = new URLSearchParams({ all: 'true', per_page: String(COMMIT_PAGE_SIZE) }).toString();
  const commits = await readPage(commitsUrl, headers, 'commits', COMMIT_PAGE_SIZE, signal);
  return {
    project,
    branches,
    commits,
    branchesLimited: branches.length === MAX_BRANCH_PAGES * BRANCH_PAGE_SIZE,
    commitsLimited: commits.length === COMMIT_PAGE_SIZE,
  };
}

function projectReadRequest({ baseUrl, token }: Connection, projectId: number, stage: GitlabReadStage) {
  let base: URL;
  try { base = new URL(baseUrl); }
  catch { throw new GitlabReadError(stage, 'network'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !Number.isSafeInteger(projectId) || projectId < 1) {
    throw new GitlabReadError(stage, 'network');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  const projectUrl = new URL(base);
  projectUrl.pathname = `${base.pathname.replace(/\/+$/, '')}/api/v4/projects/${projectId}`;
  return { base, headers, projectUrl };
}

function canonicalPath(pathname: string): string | null {
  try {
    const path = pathname.replace(/\/$/, '');
    if (!path) return '';
    const segments = path.slice(1).split('/').map(segment => decodeURIComponent(segment));
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f/\\]/u.test(segment))) return null;
    return '/' + segments.map(segment => encodeURIComponent(segment)).join('/');
  } catch { return null; }
}

function gitlabPage(raw: unknown, base: URL, allowSuffix: boolean) {
  if (typeof raw !== 'string' || raw.length > 4000 || !raw.isWellFormed()) return null;
  const text = raw.trim();
  if (/[\u0000-\u0020\u007f\\]/u.test(text)) return null;
  // Check the original path before URL parsing can resolve dot segments.
  const input = /^https?:\/\/[^/?#@]+(\/[^?#]*)?(?:[?#]|$)/iu.exec(text);
  if (!input?.[1]) return null;
  const path = canonicalPath(input[1]);
  const scope = canonicalPath(base.pathname.replace(/\/+$/, '') + '/');
  if (!path || scope === null || !path.startsWith(`${scope}/`)) return null;
  try {
    const url = new URL(text);
    if (url.origin !== base.origin || url.username || url.password || (!allowSuffix && (text.includes('?') || text.includes('#')))) return null;
    return path;
  } catch { return null; }
}

function manualPage(raw: unknown, base: URL, allowSuffix: boolean) {
  const path = gitlabPage(raw, base, allowSuffix);
  if (!path) return null;
  const match = /^(.+)\/(merge_requests|pipelines)\/([1-9]\d*)$/u.exec(path);
  if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
  const repositoryPath = match[1].replace(/\/-$/u, '');
  const kind: ManualObjectKind = match[2] === 'merge_requests' ? 'merge_request' : 'pipeline';
  return { repositoryPath, kind, id: Number(match[3]) };
}

export async function readGitlabManualObject(connection: Connection, projectId: number, rawUrl: unknown, signal?: AbortSignal): Promise<{
  kind: ManualObjectKind;
  object: GitlabReadObject;
  webUrl: string;
}> {
  const { base, headers, projectUrl } = projectReadRequest(connection, projectId, 'project');
  const page = manualPage(rawUrl, base, true);
  if (!page) throw new GitlabManualUrlError('설정한 GitLab의 MR 또는 파이프라인 페이지 주소를 입력해 주세요.');

  const project = await readJson(projectUrl, headers, 'project', signal);
  if (!isReadObject(project) || project.id !== projectId) throw new GitlabReadError('project', 'invalid-response');
  const repositoryPath = gitlabPage(project.web_url, base, false);
  const namespace = project.path_with_namespace === undefined ? gitlabRepositoryUrl(connection.baseUrl, { web_url: project.web_url })
    : gitlabRepositoryUrl(connection.baseUrl, { path_with_namespace: project.path_with_namespace });
  if (!repositoryPath || !namespace || canonicalPath(namespace.pathname) !== repositoryPath) throw new GitlabReadError('project', 'invalid-response');
  if (page.repositoryPath !== repositoryPath) throw new GitlabManualUrlError('선택한 GitLab 저장소의 MR 또는 파이프라인 주소를 입력해 주세요.');

  const stage = page.kind === 'merge_request' ? 'merge-requests' : 'pipelines';
  const collection = page.kind === 'merge_request' ? 'merge_requests' : 'pipelines';
  const itemUrl = new URL(projectUrl);
  itemUrl.pathname += `/${collection}/${page.id}`;
  const object = await readJson(itemUrl, headers, stage, signal);
  if (!isReadObject(object) || object.project_id !== projectId || typeof object.id !== 'number' ||
      !Number.isSafeInteger(object.id) || object.id < 1 ||
      (page.kind === 'merge_request' ? object.iid !== page.id || (object.target_project_id !== undefined && object.target_project_id !== projectId)
        : object.id !== page.id)) throw new GitlabReadError(stage, 'invalid-response');

  const verified = manualPage(object.web_url, base, false);
  if (!verified || verified.repositoryPath !== page.repositoryPath || verified.kind !== page.kind || verified.id !== page.id) {
    throw new GitlabReadError(stage, 'invalid-response');
  }
  const webUrl = new URL(`${repositoryPath}/-/${collection}/${page.id}`, base.origin).href;
  return { kind: page.kind, object: { ...object, web_url: webUrl }, webUrl };
}

export async function readGitlabSyncProject(
  connection: Connection, projectId: number, options: { signal?: AbortSignal; includeHistory?: boolean } = {},
): Promise<{ mergeRequests: GitlabReadObject[]; pipelines: GitlabReadObject[]; history?: RepositoryHistory }> {
  const { projectUrl, headers } = projectReadRequest(connection, projectId, 'merge-requests');
  const history = options.includeHistory ? await readRepositoryHistory(projectUrl, projectId, headers, options.signal) : undefined;
  const mergeRequestsUrl = new URL(projectUrl);
  mergeRequestsUrl.pathname += '/merge_requests';
  const mergeRequests: GitlabReadObject[] = [];
  for (let page = 1; page <= MAX_MERGE_REQUEST_PAGES; page++) {
    mergeRequestsUrl.search = new URLSearchParams({ scope: 'all', per_page: String(MERGE_REQUEST_PAGE_SIZE), page: String(page) }).toString();
    const rows = await readPage(mergeRequestsUrl, headers, 'merge-requests', MERGE_REQUEST_PAGE_SIZE, options.signal);
    mergeRequests.push(...rows);
    if (rows.length < MERGE_REQUEST_PAGE_SIZE) break;
  }
  const pipelinesUrl = new URL(projectUrl);
  pipelinesUrl.pathname += '/pipelines';
  pipelinesUrl.search = new URLSearchParams({ per_page: String(PIPELINE_PAGE_SIZE) }).toString();
  const pipelines = await readPage(pipelinesUrl, headers, 'pipelines', PIPELINE_PAGE_SIZE, options.signal);
  return { mergeRequests, pipelines, ...(history ? { history } : {}) };
}
