export type GitlabReadObject = Record<string, unknown>;
export type GitlabReadStage = 'merge-requests' | 'pipelines';
type GitlabReadErrorCode = 'http' | 'timeout' | 'network' | 'invalid-response' | 'response-too-large';
type Connection = { baseUrl: string; token?: string | null };

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MERGE_REQUEST_PAGE_SIZE = 100;
const MAX_MERGE_REQUEST_PAGES = 10;
const PIPELINE_PAGE_SIZE = 50;

export class GitlabReadError extends Error {
  constructor(readonly stage: GitlabReadStage, readonly code: GitlabReadErrorCode, readonly httpStatus: number | null = null) {
    const name = stage === 'merge-requests' ? 'MR' : '파이프라인';
    const description = {
      'http': `GitLab HTTP ${httpStatus} 응답`,
      'timeout': '응답 시간 초과',
      'network': '연결 실패',
      'invalid-response': '응답 형식 오류',
      'response-too-large': '응답 크기 한도 초과',
    }[code];
    super(`${name} 조회 중 ${description}`);
  }
}

async function readPage(url: URL, headers: Record<string, string>, stage: GitlabReadStage, maxRows: number, parentSignal?: AbortSignal): Promise<GitlabReadObject[]> {
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

    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw new GitlabReadError(stage, 'invalid-response'); }
    if (!Array.isArray(payload) || payload.length > maxRows || payload.some(value => !value || typeof value !== 'object' || Array.isArray(value))) {
      throw new GitlabReadError(stage, 'invalid-response');
    }
    return payload;
  } catch (error) {
    if (error instanceof GitlabReadError) throw error;
    throw new GitlabReadError(stage, signal.aborted ? 'timeout' : 'network');
  }
}

export async function readGitlabSyncProject({ baseUrl, token }: Connection, projectId: number, options: { signal?: AbortSignal } = {}) {
  let base: URL;
  try { base = new URL(baseUrl); }
  catch { throw new GitlabReadError('merge-requests', 'network'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !Number.isSafeInteger(projectId) || projectId < 1) {
    throw new GitlabReadError('merge-requests', 'network');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  const projectPath = `${base.pathname.replace(/\/+$/, '')}/api/v4/projects/${projectId}`;
  const mergeRequestsUrl = new URL(base);
  mergeRequestsUrl.pathname = `${projectPath}/merge_requests`;
  const mergeRequests: GitlabReadObject[] = [];
  for (let page = 1; page <= MAX_MERGE_REQUEST_PAGES; page++) {
    mergeRequestsUrl.search = new URLSearchParams({ scope: 'all', per_page: String(MERGE_REQUEST_PAGE_SIZE), page: String(page) }).toString();
    const rows = await readPage(mergeRequestsUrl, headers, 'merge-requests', MERGE_REQUEST_PAGE_SIZE, options.signal);
    mergeRequests.push(...rows);
    if (rows.length < MERGE_REQUEST_PAGE_SIZE) break;
  }
  const pipelinesUrl = new URL(base);
  pipelinesUrl.pathname = `${projectPath}/pipelines`;
  pipelinesUrl.search = new URLSearchParams({ per_page: String(PIPELINE_PAGE_SIZE) }).toString();
  const pipelines = await readPage(pipelinesUrl, headers, 'pipelines', PIPELINE_PAGE_SIZE, options.signal);
  return { mergeRequests, pipelines };
}
