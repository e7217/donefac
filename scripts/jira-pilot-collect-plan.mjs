import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const jiraIssueKey = /^[A-Z][A-Z0-9_]{0,39}-[1-9]\d{0,19}$/;
export const jiraNumericId = /^[1-9]\d{0,19}$/;
export const JIRA_COLLECT_MAX_BATCH = 500;
export const JIRA_COLLECT_MAX_PLAN = 10_000;

const format = 'teamspace-jira-collection-plan';
const version = 1;
const maxPlanBytes = 2 * 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const invalidPlan = 'Jira 수집 계획의 형식 또는 업무 범위를 확인해 주세요.';
const readFailure = 'Jira 수집 계획 파일을 읽을 수 없습니다. 파일과 크기를 확인해 주세요.';
const writeFailure = 'Jira 수집 계획 파일을 저장할 수 없습니다. 출력 경로를 확인해 주세요.';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function collectionScope({ base, projectKey, includeAttachments }) {
  return sha256(JSON.stringify([base.href, projectKey, includeAttachments]));
}

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validBatchSize(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= JIRA_COLLECT_MAX_BATCH;
}

function validatePlan(plan, projectKey, scopeSha256) {
  if (!hasKeys(plan, ['format', 'version', 'scopeSha256', 'batchSize', 'batches']) || plan.format !== format || plan.version !== version ||
      typeof plan.scopeSha256 !== 'string' || !sha256Pattern.test(plan.scopeSha256) || !validBatchSize(plan.batchSize) ||
      !Array.isArray(plan.batches) || plan.batches.length === 0 || plan.batches.length > Math.ceil(JIRA_COLLECT_MAX_PLAN / plan.batchSize)) {
    throw new Error(invalidPlan);
  }
  if (plan.scopeSha256 !== scopeSha256) {
    throw new Error('Jira 수집 계획의 서버·프로젝트·첨부 설정이 현재 수집 설정과 다릅니다.');
  }

  const ids = new Set();
  const keys = new Set();
  for (const [index, batch] of plan.batches.entries()) {
    const finalBatch = index === plan.batches.length - 1;
    if (!Array.isArray(batch) || !batch.length || batch.length > plan.batchSize || !finalBatch && batch.length !== plan.batchSize) {
      throw new Error(invalidPlan);
    }
    for (const issue of batch) {
      if (!hasKeys(issue, ['id', 'key']) || typeof issue.id !== 'string' || !jiraNumericId.test(issue.id) || ids.has(issue.id) ||
          typeof issue.key !== 'string' || !jiraIssueKey.test(issue.key) || keys.has(issue.key) ||
          issue.key.slice(0, issue.key.lastIndexOf('-')) !== projectKey) {
        throw new Error(invalidPlan);
      }
      ids.add(issue.id);
      keys.add(issue.key);
    }
  }
  if (ids.size > JIRA_COLLECT_MAX_PLAN) throw new Error(invalidPlan);
}

export async function saveJiraCollectionPlan(output, configuration, selected, batchSize, signal) {
  signal.throwIfAborted();
  if (!validBatchSize(batchSize) || !Array.isArray(selected) || selected.length < 1 || selected.length > JIRA_COLLECT_MAX_PLAN) {
    throw new Error(invalidPlan);
  }
  const batches = [];
  for (let index = 0; index < selected.length; index += batchSize) {
    batches.push(selected.slice(index, index + batchSize).map(issue => ({ id: issue?.id, key: issue?.key })));
  }
  const scopeSha256 = collectionScope(configuration);
  const plan = { format, version, scopeSha256, batchSize, batches };
  validatePlan(plan, configuration.projectKey, scopeSha256);
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  if (bytes.length > maxPlanBytes) throw new Error(invalidPlan);

  let staging;
  try {
    const parent = await realpath(dirname(output));
    staging = await mkdtemp(join(parent, '.jira-pilot-plan-'));
    const stagedFile = join(staging, 'plan.json');
    await writeFile(stagedFile, bytes, { flag: 'wx', mode: 0o600, flush: true, signal });
    await chmod(stagedFile, 0o600);
    signal.throwIfAborted();
    await link(stagedFile, join(parent, basename(output)));
  } catch (error) {
    signal.throwIfAborted();
    if (error?.code === 'EEXIST') throw new Error('Jira 수집 계획 경로에 파일 또는 디렉터리가 이미 있습니다.');
    throw new Error(writeFailure);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => { throw new Error(writeFailure); });
  }
  return { issueCount: selected.length, batchCount: batches.length, sha256: sha256(bytes) };
}

async function readPlanBytes(planPath, signal) {
  signal.throwIfAborted();
  let handle;
  try {
    handle = await open(planPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxPlanBytes) throw new Error(readFailure);
    const bytes = Buffer.allocUnsafe(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    signal.throwIfAborted();
    if (length !== metadata.size) throw new Error(readFailure);
    return bytes.subarray(0, length);
  } catch {
    signal.throwIfAborted();
    throw new Error(readFailure);
  } finally {
    if (handle) await handle.close().catch(() => { throw new Error(readFailure); });
  }
}

export async function readJiraCollectionBatch(planPath, configuration, batch, signal) {
  const bytes = await readPlanBytes(planPath, signal);
  let plan;
  try { plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(invalidPlan); }
  validatePlan(plan, configuration.projectKey, collectionScope(configuration));
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > plan.batches.length) {
    throw new Error('Jira 수집 계획의 묶음 번호를 확인해 주세요.');
  }
  signal.throwIfAborted();
  const selected = plan.batches[batch - 1].map(issue => ({ ...issue, projectKey: configuration.projectKey }));
  return { selected, planSha256: sha256(bytes) };
}
