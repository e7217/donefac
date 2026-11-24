import { constants } from 'node:fs';
import { link, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { compareConfluenceArchive } from './confluence-pilot-audit-archive.mjs';
import { readConfluenceInventory } from './confluence-pilot-audit-rest.mjs';
import { CONFLUENCE_FINDINGS_FORMAT, CONFLUENCE_FINDINGS_VERSION } from './pilot-migration-confluence-findings.mjs';

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

async function writeFindings(path, value, signal) {
  let stagingDirectory;
  try {
    stagingDirectory = await mkdtemp(join(dirname(path), '.teamspace-confluence-findings-'));
    const stagedFile = join(stagingDirectory, 'findings.json');
    await writeFile(stagedFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true, signal });
    signal.throwIfAborted();
    await link(stagedFile, path);
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === 'EEXIST') throw new Error('페이지별 검토 파일이 이미 있습니다. 새 경로를 지정해 주세요.');
    throw new Error('페이지별 검토 파일을 저장할 수 없습니다. 상위 디렉터리와 쓰기 권한을 확인해 주세요.');
  } finally {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

const [configurationPath, archivePath, ...extra] = process.argv.slice(2);
const findingsPath = extra[1];
const interrupted = new AbortController();
const cancel = () => interrupted.abort(new Error('Confluence 원본 대조를 중단했습니다.'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  if (!configurationPath || !isAbsolute(configurationPath) ||
      archivePath !== undefined && (!isAbsolute(archivePath) || extname(archivePath).toLowerCase() !== '.zip') ||
      extra.length && (extra.length !== 2 || extra[0] !== '--findings' || !archivePath || !isAbsolute(findingsPath))) {
    throw new Error('npm run pilot:confluence:audit -- /absolute/config.json [/absolute/export.zip [--findings /absolute/findings.json]] 형식으로 실행해 주세요.');
  }
  const configuration = await readConfiguration(configurationPath);
  const signal = interrupted.signal;
  const inventory = await readConfluenceInventory(configuration, createReader(configuration, signal));
  const pageFindings = new Map();
  function addFinding(pageId, code) {
    if (!findingsPath) return;
    if (!pageFindings.has(pageId)) pageFindings.set(pageId, new Set());
    pageFindings.get(pageId).add(code);
  }
  const archive = archivePath === undefined ? undefined
    : await compareConfluenceArchive(archivePath, inventory, findingsPath ? addFinding : undefined);
  signal.throwIfAborted();
  let restrictedPages = 0;
  let unknownRestrictions = 0;
  for (const page of inventory.pages.values()) {
    if (page.restriction === 'restricted') {
      restrictedPages++;
      addFinding(page.id, 'LIVE_RESTRICTED');
    }
    if (page.restriction === 'unknown') {
      unknownRestrictions++;
      addFinding(page.id, 'LIVE_RESTRICTION_UNKNOWN');
    }
  }
  const { unavailablePages } = inventory;
  const needsReview = !inventory.pages.size || unavailablePages > 0 || restrictedPages > 0 || unknownRestrictions > 0 || archive?.needsReview;
  const status = needsReview ? 'needs-review' : archive ? 'matched' : 'observed';
  const selection = inventory.explicitSelection ? 'explicit-pages' : 'visible-space';
  const spacePermissions = 'manual-review';
  if (findingsPath) {
    for (const pageId of inventory.unreadableIds) addFinding(pageId, 'LIVE_PAGE_UNAVAILABLE');
    const findings = [...pageFindings].filter(([pageId]) => typeof pageId === 'string' && pageIdPattern.test(pageId))
      .sort(([left], [right]) => left.length - right.length || left.localeCompare(right))
      .map(([pageId, codes]) => ({ pageId, codes: [...codes].sort() }));
    await writeFindings(findingsPath, {
      format: CONFLUENCE_FINDINGS_FORMAT, version: CONFLUENCE_FINDINGS_VERSION, checkedAt: new Date().toISOString(),
      selection, status, archive: { sha256: archive.sha256, bytes: archive.bytes }, spacePermissions,
      unidentifiedPages: pageFindings.size - findings.length, findings,
      coverage: { archivePages: archive.totalCurrentPages, matchedPages: archive.matchedPages,
        permissionCheckedPages: archive.permissionCheckedPages, outsideSelectionPages: archive.outsideSelectionPages,
        otherSpacePages: archive.otherSpacePages, unassignedPages: archive.unassignedPages },
    }, signal);
  }
  process.stdout.write(`${JSON.stringify({ status, selection, visiblePages: inventory.pages.size, unavailablePages,
    restrictedPages, unknownRestrictions, spacePermissions, archive })}\n`);
  if (needsReview) process.exitCode = 2;
} catch (error) {
  process.exitCode = interrupted.signal.aborted ? 130 : 1;
  console.error(error instanceof Error ? error.message : 'Confluence 원본 대조에 실패했습니다.');
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
