import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { createJiraPilotArchive, jiraCollectAttachmentUrl } from './jira-pilot-collect-archive.mjs';
import { collectJiraIssueActivity } from './jira-pilot-collect-activity.mjs';
import {
  jiraIssueKey, jiraNumericId, JIRA_COLLECT_MAX_BATCH, JIRA_COLLECT_MAX_PLAN, readJiraCollectionBatch, saveJiraCollectionPlan,
} from './jira-pilot-collect-plan.mjs';
import { LEGACY_MAX_FILE_BYTES } from '../server/legacy-import-archive.ts';
import { MAX_FILE_BYTES } from '../server/attachments.ts';

const projectKey = /^[A-Z][A-Z0-9_]{0,39}$/;
const pageSize = 100;
const defaultBatchSize = 100;

function collectError(message) { throw new Error(message); }

async function readLocalText(path, limit, label) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error();
    const bytes = await readFile(path);
    if (bytes.length > limit) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return collectError(`${label}을 읽을 수 없습니다. 파일과 크기를 확인해 주세요.`);
  }
}

async function readConfiguration(path) {
  const text = await readLocalText(path, 64 * 1024, '수집 설정 파일');
  let raw;
  try { raw = JSON.parse(text); }
  catch { return collectError('수집 설정은 JSON 객체여야 합니다.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.baseUrl !== 'string' ||
      typeof raw.authFile !== 'string' || !raw.authFile ||
      Object.keys(raw).some(key => !['baseUrl', 'authFile', 'projectKey', 'issueKeys', 'includeAttachments'].includes(key))) {
    collectError('Jira 기준 주소, 인증 파일, 수집 범위를 확인해 주세요.');
  }
  const hasProject = Object.hasOwn(raw, 'projectKey');
  const hasIssues = Object.hasOwn(raw, 'issueKeys');
  if (hasProject === hasIssues || hasProject && (typeof raw.projectKey !== 'string' || !projectKey.test(raw.projectKey)) ||
      hasIssues && (!Array.isArray(raw.issueKeys) || !raw.issueKeys.length || raw.issueKeys.length > JIRA_COLLECT_MAX_BATCH ||
        raw.issueKeys.some(key => typeof key !== 'string' || !jiraIssueKey.test(key)) || new Set(raw.issueKeys).size !== raw.issueKeys.length) ||
      raw.includeAttachments !== undefined && typeof raw.includeAttachments !== 'boolean') {
    collectError('프로젝트 키 하나 또는 서로 다른 현재 업무 키 1~500개를 지정해 주세요.');
  }

  let base;
  try { base = new URL(raw.baseUrl); }
  catch { return collectError('Jira 기준 주소를 확인해 주세요.'); }
  if (!/^https?:\/\/[^/]/i.test(raw.baseUrl) || /[\\?\x23\x00-\x20\x7f]/.test(raw.baseUrl) ||
      !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    collectError('Jira 기준 주소에는 HTTP(S) 호스트와 서비스 경로만 입력해 주세요.');
  }
  base.pathname = base.pathname.replace(/\/+$/, '') + '/';
  const authorization = (await readLocalText(resolve(dirname(path), raw.authFile), 8 * 1024, 'Jira 인증 파일')).trim();
  if (!/^(?:Bearer [\x21-\x7e]+|Basic [A-Za-z0-9+/]+={0,2})$/.test(authorization)) {
    collectError('Jira 인증 파일에 Bearer 또는 Basic 인증 값을 한 줄로 입력해 주세요.');
  }
  return { base, authorization, projectKey: raw.projectKey, issueKeys: raw.issueKeys, includeAttachments: raw.includeAttachments ?? true };
}

async function boundedBody(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) collectError('Jira 응답이 이관 파일 크기 한도를 초과했습니다. 업무를 나누어 수집해 주세요.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function createReader({ base, authorization }, signal) {
  async function request(url, accept, maxBytes, optionalStatuses = []) {
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.hash) {
      collectError('요청 주소가 지정한 Jira 서버와 서비스 경로를 벗어났습니다.');
    }
    let response;
    try {
      response = await fetch(url, { method: 'GET', redirect: 'manual', headers: { Accept: accept, Authorization: authorization },
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
    } catch {
      signal.throwIfAborted();
      return collectError('Jira 응답을 읽지 못했습니다. 서버 연결, 인증서 및 응답 시간을 확인해 주세요.');
    }
    if (optionalStatuses.includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 300 && response.status < 400) collectError('Jira가 다른 주소로 응답했습니다. 리다이렉트 없이 연결되는 기준 주소를 사용해 주세요.');
      collectError(`Jira 읽기 요청이 실패했습니다 (HTTP ${response.status}).`);
    }
    if (accept === 'application/json' && !/\bapplication\/(?:json|[\w.+-]+\+json)\b/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel().catch(() => undefined);
      collectError('Jira에서 REST JSON 응답을 받지 못했습니다.');
    }
    try { return await boundedBody(response, maxBytes); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message.startsWith('Jira 응답이 이관')) throw error;
      return collectError('Jira 응답 전송이 중단됐습니다. 연결을 확인해 주세요.');
    }
  }

  async function getJson(path, query, { optionalStatuses } = {}) {
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
    const bytes = await request(url, 'application/json', LEGACY_MAX_FILE_BYTES, optionalStatuses);
    if (bytes === null) return null;
    try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), url: url.href }; }
    catch { return collectError('Jira REST 응답의 JSON 형식을 확인해 주세요.'); }
  }

  return { getJson, getAttachment: url => request(url, '*/*', MAX_FILE_BYTES, [403, 404, 410]) };
}

function verifiedIssue(raw, expected) {
  const id = typeof raw?.id === 'string' ? raw.id : Number.isSafeInteger(raw?.id) ? String(raw.id) : '';
  const key = raw?.key;
  const fields = raw?.fields;
  if (!jiraNumericId.test(id) || typeof key !== 'string' || !jiraIssueKey.test(key) ||
      !fields || typeof fields !== 'object' || Array.isArray(fields) ||
      fields.project?.key !== key.slice(0, key.lastIndexOf('-')) ||
      expected.projectKey && fields.project.key !== expected.projectKey || expected.id && id !== expected.id ||
      expected.key && key !== expected.key) {
    return collectError('Jira 응답에서 선택한 프로젝트 및 업무의 ID와 키를 확인할 수 없습니다.');
  }
  return { id, key };
}

async function selectProjectIssues(projectKey, getJson, limit, limitMessage) {
  const expected = { projectKey };
  const selected = [], ids = new Set(), keys = new Set();
  let total;
  do {
    const startAt = selected.length;
    const { value } = await getJson('rest/api/2/search', {
      jql: `project = "${expected.projectKey}" ORDER BY key ASC`, fields: 'project', startAt, maxResults: pageSize,
    });
    if (Number.isSafeInteger(value?.total) && value.total > limit) collectError(limitMessage);
    if (!Number.isSafeInteger(value?.total) || value.total < startAt || value.startAt !== startAt ||
        !Array.isArray(value.issues) || value.issues.length > Math.min(value.total - startAt, pageSize) ||
        !value.issues.length && startAt < value.total || total !== undefined && value.total !== total) {
      collectError('Jira 프로젝트 검색 페이지의 범위가 달라졌습니다. 다시 수집해 주세요.');
    }
    total = value.total;
    for (const row of value.issues) {
      const issue = verifiedIssue(row, expected);
      if (ids.has(issue.id) || keys.has(issue.key)) collectError('Jira 프로젝트 검색에서 같은 업무가 여러 번 발견됐습니다.');
      ids.add(issue.id);
      keys.add(issue.key);
      selected.push({ ...issue, projectKey: expected.projectKey });
    }
  } while (selected.length < total);
  if (!selected.length) collectError('프로젝트에서 읽을 수 있는 Jira 업무가 없습니다.');
  return selected;
}

function requireProject(configuration) {
  if (!configuration.projectKey) collectError('분할 수집에는 projectKey를 지정한 Jira 설정이 필요합니다.');
}

async function planCollection(configuration, output, batchSize, signal) {
  const { getJson } = createReader(configuration, signal);
  const read = () => selectProjectIssues(configuration.projectKey, getJson, JIRA_COLLECT_MAX_PLAN,
    '프로젝트에서 읽을 수 있는 업무가 10,000개를 넘습니다. 관리자 내보내기를 사용해 주세요.');
  const first = await read();
  const second = await read();
  if (first.length !== second.length || first.some((issue, index) => issue.id !== second[index].id || issue.key !== second[index].key)) {
    collectError('두 차례 Jira 검색에서 업무 목록이 달라졌습니다. 분할 수집 계획을 다시 만들어 주세요.');
  }
  return saveJiraCollectionPlan(output, configuration, first, batchSize, signal);
}

function verifySelf(value, requestUrl, issue) {
  if (value === undefined || value === null) return;
  let source;
  try { source = new URL(value); }
  catch { return collectError('Jira 업무 응답의 원본 주소를 확인할 수 없습니다.'); }
  const root = requestUrl.pathname.slice(0, requestUrl.pathname.lastIndexOf('rest/api/2/issue/'));
  if (source.origin !== requestUrl.origin || source.username || source.password || source.search || source.hash ||
      !['2', '2.0', 'latest'].some(version => [issue.id, issue.key].some(id =>
        source.pathname === `${root}rest/api/${version}/issue/${id}`))) {
    collectError('Jira 업무 응답의 원본 주소가 요청한 서버 또는 업무와 일치하지 않습니다.');
  }
}

function remoteLinkSelfMatches(value, base, issue, linkId) {
  if (typeof value !== 'string' || /[\\\u0000-\u0020\u007f]/u.test(value)) return false;
  const url = URL.parse(value);
  // Keep the raw path for the comparison because URL removes dot segments.
  const path = /^https?:\/\/[^/?#]+(\/[^?#]*)$/iu.exec(value)?.[1];
  return url?.origin === base.origin && !url.username && !url.password &&
    ['2', '2.0', 'latest'].some(version => [issue.id, issue.key].some(alias =>
      path === `${base.pathname}rest/api/${version}/issue/${alias}/remotelink/${linkId}`));
}

async function collectRemoteLinks(issue, base, getJson, report, seen) {
  const response = await getJson(`rest/api/2/issue/${issue.id}/remotelink`, undefined, { optionalStatuses: [403, 404] });
  if (response === null) {
    report.unavailableRemoteLinkIssues++;
    return { status: 'unavailable' };
  }
  const { value } = response;
  if (!Array.isArray(value)) collectError('Jira 원격 연결 목록의 형식을 확인할 수 없습니다.');
  for (const link of value) {
    const id = typeof link?.id === 'string' ? link.id : Number.isSafeInteger(link?.id) ? String(link.id) : '';
    if (!jiraNumericId.test(id) || seen.has(id) || !link.object || typeof link.object !== 'object' || Array.isArray(link.object) ||
        Object.hasOwn(link, 'self') && !remoteLinkSelfMatches(link.self, base, issue, id)) {
      collectError('Jira 원격 연결의 식별자나 원본 업무가 올바르지 않거나 중복됩니다.');
    }
    seen.add(id);
  }
  report.remoteLinkCount += value.length;
  return { status: 'complete', values: value };
}

async function collectAttachments(issue, configuration, reader, archive, report, seen) {
  const attachments = issue.fields.attachment;
  if (attachments == null) return;
  if (!Array.isArray(attachments)) collectError('Jira 업무의 첨부 메타데이터를 확인할 수 없습니다.');
  for (const attachment of attachments) {
    const id = String(attachment?.id ?? '');
    if (!jiraNumericId.test(id) || seen.has(id)) collectError('Jira 첨부의 식별자가 없거나 여러 업무에 겹칩니다.');
    seen.add(id);
    if (!configuration.includeAttachments) { report.skippedAttachments++; continue; }
    const size = attachment.size;
    if (Number.isSafeInteger(size) && size > MAX_FILE_BYTES) { report.oversizedAttachments++; continue; }
    const url = jiraCollectAttachmentUrl(attachment.content, configuration.base, id);
    if (!url || !Number.isSafeInteger(size) || size < 0) { report.unavailableAttachments++; continue; }
    const bytes = await reader.getAttachment(new URL(url));
    if (bytes === null) { report.unavailableAttachments++; continue; }
    if (bytes.length !== size) collectError('Jira 첨부파일이 수집 도중 변경됐습니다. 다시 수집해 주세요.');
    archive.addAttachment(id, bytes);
    report.attachmentCount++;
  }
}

async function collect(configuration, output, signal, plannedIssues) {
  const archive = await createJiraPilotArchive(output);
  try {
    const reader = createReader(configuration, signal);
    const selected = plannedIssues ?? (configuration.issueKeys ? configuration.issueKeys.map(key => ({ key })) :
      await selectProjectIssues(configuration.projectKey, reader.getJson, JIRA_COLLECT_MAX_BATCH,
        '프로젝트에서 읽을 수 있는 업무가 500개를 넘습니다. plan으로 분할 수집 계획을 만들어 주세요.'));
    const report = { issueCount: 0, commentCount: 0, worklogCount: 0, historyCount: 0, incompleteHistories: 0,
      remoteLinkCount: 0, unavailableRemoteLinkIssues: 0,
      attachmentCount: 0, skippedAttachments: 0, unavailableAttachments: 0, oversizedAttachments: 0 };
    const seen = new Set(), attachments = new Set(), remoteLinks = new Set();
    for (const expected of selected) {
      const { value: issue, url } = await reader.getJson(`rest/api/2/issue/${expected.id ?? expected.key}`, {
        fields: '*all', expand: 'names,schema,changelog',
      });
      const { id, key } = verifiedIssue(issue, expected);
      if (seen.has(id)) collectError('선택한 Jira 업무에서 동일한 원본 ID가 여러 번 발견됐습니다.');
      seen.add(id);
      verifySelf(issue.self, new URL(url), { id, key });
      issue.id = id;
      issue.self = new URL(`rest/api/2/issue/${id}`, configuration.base).href;
      await collectJiraIssueActivity({ issue, getJson: reader.getJson, addJson: archive.addJson, report });
      issue.remoteLinks = await collectRemoteLinks(issue, configuration.base, reader.getJson, report, remoteLinks);
      await collectAttachments(issue, configuration, reader, archive, report, attachments);
      delete issue.fields.comment;
      delete issue.fields.worklog;
      archive.addJson(`issues/${id}.json`, issue);
      report.issueCount++;
    }
    signal.throwIfAborted();
    return { ...report, ...await archive.publish(signal) };
  } finally { await archive.close(); }
}

const usage = [
  'npm run pilot:jira:collect -- /absolute/config.json /absolute/output.zip',
  'npm run pilot:jira:collect -- plan /absolute/config.json /absolute/plan.json [--batch-size 100]',
  'npm run pilot:jira:collect -- batch /absolute/config.json /absolute/plan.json 1 /absolute/output.zip',
].join('\n');

const absoluteFile = (path, extension) => Boolean(path && isAbsolute(path) && (!extension || extname(path) === extension));

async function run(args, signal) {
  if (args[0] === 'plan') {
    const [, config, output, flag, size, ...extra] = args;
    const batchSize = flag === undefined ? defaultBatchSize : Number(size);
    if (!absoluteFile(config) || !absoluteFile(output, '.json') || extra.length ||
        flag !== undefined && (flag !== '--batch-size' || !/^[1-9]\d{0,2}$/.test(size ?? '') || batchSize > JIRA_COLLECT_MAX_BATCH)) {
      collectError(`사용법\n${usage}`);
    }
    const configuration = await readConfiguration(config);
    requireProject(configuration);
    return planCollection(configuration, output, batchSize, signal);
  }
  if (args[0] === 'batch') {
    const [, config, plan, ordinal, output, ...extra] = args;
    if (!absoluteFile(config) || !absoluteFile(plan, '.json') || !/^[1-9]\d{0,4}$/.test(ordinal ?? '') ||
        !absoluteFile(output, '.zip') || extra.length) collectError(`사용법\n${usage}`);
    const batch = Number(ordinal);
    const configuration = await readConfiguration(config);
    requireProject(configuration);
    const { selected, planSha256 } = await readJiraCollectionBatch(plan, configuration, batch, signal);
    return { ...await collect(configuration, output, signal, selected), batch, planSha256 };
  }
  const [config, output, ...extra] = args;
  if (!absoluteFile(config) || !absoluteFile(output, '.zip') || extra.length) collectError(`사용법\n${usage}`);
  return collect(await readConfiguration(config), output, signal);
}

const interrupted = new AbortController();
const cancel = () => interrupted.abort(new Error('Jira 원본 수집을 중단했습니다.'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const report = await run(process.argv.slice(2), interrupted.signal);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.exitCode = interrupted.signal.aborted ? 130 : 1;
  console.error(error instanceof Error ? error.message : 'Jira 원본 수집에 실패했습니다.');
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
