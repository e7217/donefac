import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  AtlassianReadError, atlassianContextPath, atlassianWebUrl, isConfluencePageId, isJiraIssueKey, parseAtlassianLink,
  type AtlassianLinkPreview, type AtlassianProduct, type ParsedAtlassianLink,
} from '../shared/atlassian-links.js';

const settings = {
  jira: { base: 'TEAMSPACE_JIRA_BASE_URL', auth: 'TEAMSPACE_JIRA_AUTH_FILE' },
  confluence: { base: 'TEAMSPACE_CONFLUENCE_BASE_URL', auth: 'TEAMSPACE_CONFLUENCE_AUTH_FILE' },
} as const satisfies Record<AtlassianProduct, { base: string; auth: string }>;
const MAX_AUTH_BYTES = 4096;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 6000;

type Credentials = { header: string; redactions: string[] };
type JsonObject = Record<string, unknown>;

function invalidAuth(): never {
  throw new AtlassianReadError(503, '원본 조회용 인증 파일 설정을 확인해 주세요.');
}

function readAuthFile(path: string): string {
  if (!isAbsolute(path)) return invalidAuth();
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size < 1 || metadata.size > MAX_AUTH_BYTES) return invalidAuth();
      const bytes = Buffer.alloc(MAX_AUTH_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_AUTH_BYTES) return invalidAuth();
      return bytes.toString('utf8', 0, length).replace(/\r?\n$/u, '');
    } finally { closeSync(descriptor); }
  } catch { return invalidAuth(); }
}

function readCredentials(path: string | undefined): Credentials | undefined {
  if (path === undefined) return undefined;
  const header = readAuthFile(path);
  if (header.includes('\r') || header.includes('\n')) return invalidAuth();
  const bearer = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/u.exec(header);
  if (bearer) return { header, redactions: [header, bearer[1]] };

  const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(header);
  if (!basic) return invalidAuth();
  const bytes = Buffer.from(basic[1], 'base64');
  if (bytes.toString('base64') !== basic[1] || bytes.indexOf(0x3a) < 1 || bytes.some(byte => byte < 0x20 || byte === 0x7f)) {
    return invalidAuth();
  }
  const redactions = new Set([header, basic[1]]);
  for (const decoded of [bytes.toString('utf8'), bytes.toString('latin1')]) {
    const separator = decoded.indexOf(':');
    redactions.add(decoded);
    redactions.add(decoded.slice(0, separator));
    const password = decoded.slice(separator + 1);
    if (password) redactions.add(password);
  }
  return { header, redactions: [...redactions] };
}

function requestUrl(base: URL, link: ParsedAtlassianLink): URL {
  const url = new URL(base);
  if (link.product === 'jira') {
    url.pathname = `${link.contextPath}/rest/api/2/issue/${encodeURIComponent(link.issueKey)}`;
    url.searchParams.set('fields', 'summary,status,updated');
    return url;
  }

  const detail = 'pageId' in link;
  url.pathname = `${link.contextPath}/rest/api/content${detail ? `/${encodeURIComponent(link.pageId)}` : ''}`;
  url.searchParams.set('expand', 'version,space');
  if (!detail) {
    url.searchParams.set('type', 'page');
    url.searchParams.set('spaceKey', link.spaceKey);
    url.searchParams.set('title', link.title);
    url.searchParams.set('limit', '2');
  }
  return url;
}

function upstreamError(status: number): AtlassianReadError {
  if (status === 401 || status === 403) return new AtlassianReadError(403, '원본을 조회할 권한을 확인해 주세요.');
  if (status === 404) return new AtlassianReadError(404, '원본에서 항목을 찾지 못했습니다.');
  if (status === 429) return new AtlassianReadError(429, '원본 조회 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.');
  return new AtlassianReadError(502, '원본 서비스에서 조회 응답을 받지 못했습니다.');
}

function invalidResponse(): never {
  throw new AtlassianReadError(502, '원본 서비스 응답 형식을 확인해 주세요.');
}

function responseTooLarge(): never {
  throw new AtlassianReadError(502, '원본 서비스 응답이 조회 크기 한도를 넘었습니다.');
}

async function readJson(url: URL, credentials: Credentials | undefined, parentSignal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (credentials) headers.Authorization = credentials.header;
  try {
    const response = await fetch(url, { method: 'GET', headers, signal, redirect: 'manual' });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw upstreamError(response.status);
    }
    if (!response.body) return invalidResponse();
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      void response.body.cancel().catch(() => {});
      return responseTooLarge();
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
          return responseTooLarge();
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { return invalidResponse(); }
  } catch (error) {
    if (error instanceof AtlassianReadError) throw error;
    if (parentSignal?.aborted) throw new AtlassianReadError(408, '원본 조회를 취소했습니다.');
    if (deadline.aborted) throw new AtlassianReadError(504, '원본 조회 응답 시간이 초과되었습니다.');
    throw new AtlassianReadError(502, '원본 서비스에 연결할 수 없습니다.');
  }
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function displayText(value: unknown, max: number, credentials?: Credentials): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  if (credentials?.redactions.some(secret => text.includes(secret))) return '[숨김]';
  return text.slice(0, max) || null;
}

function updatedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function jiraPreview(payload: unknown, credentials: Credentials | undefined): AtlassianLinkPreview {
  const issue = object(payload);
  const fields = object(issue?.fields);
  const title = displayText(fields?.summary, 500, credentials);
  if (!title || !isJiraIssueKey(issue?.key)) return invalidResponse();
  return {
    title, locator: issue.key.toUpperCase(),
    status: displayText(object(fields?.status)?.name, 160, credentials), updatedAt: updatedAt(fields?.updated),
  };
}

function confluencePreview(payload: unknown, link: Extract<ParsedAtlassianLink, { product: 'confluence' }>, credentials: Credentials | undefined): AtlassianLinkPreview {
  let page = object(payload);
  if (!('pageId' in link)) {
    const results = page?.results;
    if (!Array.isArray(results)) return invalidResponse();
    if (results.length === 0) throw upstreamError(404);
    if (results.length > 1 || object(page?._links)?.next) {
      throw new AtlassianReadError(409, '같은 제목의 원본이 여러 개입니다. 페이지 ID가 포함된 주소를 사용해 주세요.');
    }
    page = object(results[0]);
    if (page?.title !== link.title || object(page.space)?.key !== link.spaceKey) return invalidResponse();
  }

  const rawId = page?.id;
  const pageId = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
  const title = displayText(page?.title, 500, credentials);
  if (!title || page?.type !== 'page' || !isConfluencePageId(pageId) || ('pageId' in link && pageId !== link.pageId)) return invalidResponse();
  const spaceKey = displayText(object(page.space)?.key, 120, credentials);
  const version = object(page.version);
  const number = version?.number;
  const label = typeof number === 'number' && Number.isSafeInteger(number) && number >= 1 ? `v${number}` : null;
  return {
    title, locator: [spaceKey, pageId, label].filter(Boolean).join(' · '),
    status: displayText(page.status, 160, credentials), updatedAt: updatedAt(version?.when),
  };
}

function redact(preview: AtlassianLinkPreview, credentials: Credentials | undefined): AtlassianLinkPreview {
  if (!credentials) return preview;
  const safe = (value: string | null) => value && credentials.redactions.some(secret => value.includes(secret)) ? null : value;
  return {
    title: safe(preview.title) ?? '', locator: safe(preview.locator) ?? '',
    status: safe(preview.status), updatedAt: safe(preview.updatedAt),
  };
}

export class AtlassianReader {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async preview(product: unknown, url: unknown, signal?: AbortSignal): Promise<AtlassianLinkPreview> {
    const link = parseAtlassianLink(product, url);
    const setting = settings[link.product];
    const address = this.env[setting.base];
    if (!address) throw new AtlassianReadError(409, '이 원본의 미리보기 주소가 설정되지 않았습니다.');
    const base = atlassianWebUrl(address);
    const context = base && atlassianContextPath(base.pathname);
    if (!base || address.includes('?') || address.includes('#') || context === undefined) {
      throw new AtlassianReadError(503, '원본 조회용 서비스 주소 설정을 확인해 주세요.');
    }
    if (link.origin !== base.origin || link.contextPath !== context) {
      throw new AtlassianReadError(403, '설정된 원본 서비스의 주소에서만 미리 볼 수 있습니다.');
    }

    const credentials = readCredentials(this.env[setting.auth]);
    const payload = await readJson(requestUrl(base, link), credentials, signal);
    const preview = link.product === 'jira' ? jiraPreview(payload, credentials) : confluencePreview(payload, link, credentials);
    return redact(preview, credentials);
  }
}
