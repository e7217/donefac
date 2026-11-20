import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { compareConfluenceArchive } from './confluence-pilot-audit-archive.mjs';
import { readConfluenceInventory } from './confluence-pilot-audit-rest.mjs';

const spaceKeyPattern = /^~?[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const pageIdPattern = /^[1-9]\d{0,19}$/;
const auditPath = /^rest\/api\/(?:space\/~?[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\/content\/page|content\/[1-9]\d{0,19}(?:\/restriction\/byOperation\/(?:read|update))?)$/;
const maxMetadataBytes = 5 * 1024 * 1024;

async function readSmallText(path, maxBytes, description) {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error();
      const chunks = [];
      for await (const chunk of handle.createReadStream({ end: maxBytes, autoClose: false })) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.length < 1 || bytes.length > maxBytes) throw new Error();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { await handle.close(); }
  } catch {
    throw new Error(`${description}을 읽을 수 없습니다. 파일과 크기를 확인해 주세요.`);
  }
}

async function readConfiguration(path) {
  const text = await readSmallText(path, 64 * 1024, 'Confluence 대조 설정 파일');
  let raw;
  try { raw = JSON.parse(text); }
  catch { throw new Error('Confluence 대조 설정은 JSON 객체여야 합니다.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      typeof raw.baseUrl !== 'string' || typeof raw.authFile !== 'string' || !raw.authFile.trim() ||
      typeof raw.spaceKey !== 'string' || !spaceKeyPattern.test(raw.spaceKey) ||
      Object.keys(raw).some(key => !['baseUrl', 'authFile', 'spaceKey', 'pageIds'].includes(key))) {
    throw new Error('Confluence 기준 주소, 인증 파일과 공간 키를 확인해 주세요.');
  }
  const { pageIds } = raw;
  if (pageIds !== undefined && (!Array.isArray(pageIds) || pageIds.length < 1 || pageIds.length > 500 ||
      pageIds.some(id => typeof id !== 'string' || !pageIdPattern.test(id)) || new Set(pageIds).size !== pageIds.length)) {
    throw new Error('서로 다른 현재 페이지 ID를 문자열로 1~500개 지정해 주세요.');
  }
  let base;
  try { base = new URL(raw.baseUrl); }
  catch { throw new Error('Confluence 기준 주소를 확인해 주세요.'); }
  if (!/^https?:\/\/[^/]/i.test(raw.baseUrl) || /[\\?\x23\x00-\x20\x7f]/.test(raw.baseUrl) ||
      !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Confluence 기준 주소에는 HTTP(S) 호스트와 서비스 경로만 입력해 주세요.');
  }
  base.pathname = base.pathname.replace(/\/+$/, '') + '/';
  const authorization = (await readSmallText(resolve(dirname(path), raw.authFile), 8 * 1024, 'Confluence 인증 파일')).trim();
  if (!/^(?:Bearer [\x21-\x7e]+|Basic [A-Za-z0-9+/]+={0,2})$/.test(authorization)) {
    throw new Error('Confluence 인증 파일에 Basic 또는 Bearer 인증 값을 한 줄로 입력해 주세요.');
  }
  return { base, authorization, spaceKey: raw.spaceKey, pageIds };
}

async function readMetadata(response) {
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxMetadataBytes) throw new Error();
      chunks.push(chunk);
    }
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
}

function createReader({ base, authorization }, signal) {
  return async (path, query, { optionalStatuses = [] } = {}) => {
    if (typeof path !== 'string' || !auditPath.test(path)) throw new Error('지원하는 Confluence 읽기 주소의 범위를 벗어났습니다.');
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
    let response;
    try {
      response = await fetch(url, { method: 'GET', redirect: 'manual', headers: { Accept: 'application/json', Authorization: authorization },
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
    } catch {
      signal.throwIfAborted();
      throw new Error('Confluence 응답을 읽지 못했습니다. 서버 연결, 인증서와 응답 시간을 확인해 주세요.');
    }
    if (response.status !== 200 || !/\bapplication\/(?:json|[\w.+-]+\+json)\b/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel().catch(() => undefined);
      if (optionalStatuses.includes(response.status)) return null;
      if (response.status >= 300 && response.status < 400) throw new Error('Confluence가 다른 주소로 응답했습니다. 리다이렉트 없이 연결되는 기준 주소를 사용해 주세요.');
      if (response.status !== 200) throw new Error(`Confluence 읽기 요청이 실패했습니다 (HTTP ${response.status}).`);
      throw new Error('Confluence REST 서버에서 JSON 응답을 받지 못했습니다.');
    }
    try { return { value: await readMetadata(response), url: url.href }; }
    catch {
      signal.throwIfAborted();
      throw new Error('Confluence 메타데이터 응답의 JSON 형식, 전송 상태 또는 5MiB 한도를 확인해 주세요.');
    }
  };
}

const [configurationPath, archivePath, ...extra] = process.argv.slice(2);
const interrupted = new AbortController();
const cancel = () => interrupted.abort(new Error('Confluence 원본 대조를 중단했습니다.'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  if (!configurationPath || !isAbsolute(configurationPath) || extra.length ||
      archivePath !== undefined && (!isAbsolute(archivePath) || extname(archivePath).toLowerCase() !== '.zip')) {
    throw new Error('사용법: npm run pilot:confluence:audit -- /absolute/config.json [/absolute/export.zip]');
  }
  const configuration = await readConfiguration(configurationPath);
  const signal = interrupted.signal;
  const inventory = await readConfluenceInventory(configuration, createReader(configuration, signal));
  const archive = archivePath === undefined ? undefined : await compareConfluenceArchive(archivePath, inventory);
  signal.throwIfAborted();
  let restrictedPages = 0;
  let unknownRestrictions = 0;
  for (const page of inventory.pages.values()) {
    if (page.restriction === 'restricted') restrictedPages++;
    if (page.restriction === 'unknown') unknownRestrictions++;
  }
  const { unavailablePages } = inventory;
  const needsReview = !inventory.pages.size || unavailablePages > 0 || restrictedPages > 0 || unknownRestrictions > 0 || archive?.needsReview;
  const status = needsReview ? 'needs-review' : archive ? 'matched' : 'observed';
  process.stdout.write(`${JSON.stringify({ status, selection: inventory.explicitSelection ? 'explicit-pages' : 'visible-space',
    visiblePages: inventory.pages.size, unavailablePages, restrictedPages, unknownRestrictions, spacePermissions: 'manual-review', archive })}\n`);
  if (needsReview) process.exitCode = 2;
} catch (error) {
  process.exitCode = interrupted.signal.aborted ? 130 : 1;
  console.error(error instanceof Error ? error.message : 'Confluence 원본 대조에 실패했습니다.');
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
