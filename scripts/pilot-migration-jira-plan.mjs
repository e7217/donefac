import { decodeLegacyText, readLegacyArchive } from '../server/legacy-import-archive.ts';
import { jiraCollectionScope, jiraIssueKey, jiraNumericId } from './jira-pilot-collect-plan.mjs';

const zipHeader = 0x04034b50;
const collectorIssuePath = /^issues\/([1-9]\d{0,19})\.json$/u;
const issueSelfPath = /^(.*\/)rest\/api\/(?:2(?:\.0)?|3|latest)\/issue\/[^/]+\/?$/u;
const invalidBatch = 'Jira 수집 ZIP의 업무 전체가 계획의 묶음 하나와 정확히 일치해야 합니다.';

function issueSourceBase(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const prefix = issueSelfPath.exec(url.pathname)?.[1];
  if (!prefix) return null;
  const base = new URL(url.origin);
  base.pathname = prefix.replace(/\/+$/u, '') + '/';
  return base;
}

function batchKey(issues) {
  return JSON.stringify(issues.map(({ id, key }) => [id, key]).sort((left, right) => left[0].localeCompare(right[0])));
}

function readIssues(files, scopes) {
  const candidates = new Set();
  const canonical = [];
  const scopeCache = new Map();
  let issueCount = 0;

  function matchingScopes(base, projectKey) {
    if (!base || !scopes.has(projectKey)) return [];
    const key = JSON.stringify([base.href, projectKey]);
    if (!scopeCache.has(key)) {
      const byHash = scopes.get(projectKey);
      scopeCache.set(key, [true, false].flatMap(includeAttachments => {
        const state = byHash.get(jiraCollectionScope({ base, projectKey, includeAttachments }));
        return state ? [state] : [];
      }));
    }
    return scopeCache.get(key);
  }

  function observe(issue, fileId, containingProject) {
    issueCount++;
    const key = issue?.key;
    const validKey = typeof key === 'string' && jiraIssueKey.test(key);
    const keyProject = validKey ? key.slice(0, key.lastIndexOf('-')) : undefined;
    const projectKey = containingProject ?? issue?.fields?.project?.key;
    const base = issueSourceBase(issue?.self);
    const matches = matchingScopes(base, projectKey);
    for (const state of matches) candidates.add(state);
    if (keyProject !== projectKey) {
      for (const state of matchingScopes(base, keyProject)) candidates.add(state);
    }

    const id = issue?.id;
    if (matches.length === 1 && validKey && keyProject === projectKey && typeof id === 'string' &&
        id === fileId && jiraNumericId.test(id) && issue.self === new URL(`rest/api/2/issue/${id}`, base).href) {
      canonical.push({ id, key, state: matches[0] });
    }
  }

  for (const [path, bytes] of files) {
    if (!/\.json$/iu.test(path) || /(?:^|\/)attachments?\//iu.test(path)) continue;
    let root;
    try { root = JSON.parse(decodeLegacyText(bytes)); }
    catch { throw new Error('Jira 수집 ZIP의 업무 JSON 형식을 확인해 주세요.'); }
    if (Array.isArray(root?.projects)) {
      for (const project of root.projects) {
        const issues = project?.issues || project?.['work items'];
        if (Array.isArray(issues)) for (const issue of issues) observe(issue, undefined, project?.key);
      }
    } else if (Array.isArray(root?.issues)) {
      for (const issue of root.issues) observe(issue);
    } else if (root?.fields && (root.id || root.key)) {
      observe(root, collectorIssuePath.exec(path)?.[1]);
    }
  }
  return { candidates, canonical, issueCount };
}

/** Check only exact collector batches; the scope proves server and project, not attachment coverage. */
export function createJiraPlanCoverage(plans) {
  const scopes = new Map();
  const states = plans.map(plan => {
    const state = {
      plan, instanceKey: null, packageIds: Array(plan.batches.length).fill(null),
      batches: new Map(plan.batches.map((issues, index) => [batchKey(issues), index])),
    };
    let byHash = scopes.get(plan.projectKey);
    if (!byHash) scopes.set(plan.projectKey, byHash = new Map());
    if (byHash.has(plan.scopeSha256)) throw new Error('같은 범위의 Jira 수집 계획이 여러 개 있습니다.');
    byHash.set(plan.scopeSha256, state);
    return state;
  });
  const claimedPackages = new Set();

  async function addPackage(pkg, bytes) {
    if (!states.length || pkg.product !== 'jira' || pkg.format !== 'jira-json' ||
        bytes.length < 4 || bytes.readUInt32LE(0) !== zipHeader) return;
    const { files } = await readLegacyArchive(bytes, 'jira.zip');
    const { candidates, canonical, issueCount } = readIssues(files, scopes);
    if (!candidates.size) return;
    if (candidates.size !== 1) throw new Error('Jira 수집 ZIP의 범위가 둘 이상의 수집 계획과 겹칩니다.');

    const [state] = candidates;
    if (canonical.length !== issueCount || canonical.length !== pkg.counts.issue ||
        canonical.some(row => row.state !== state)) throw new Error(invalidBatch);
    const batch = state.batches.get(batchKey(canonical));
    if (batch === undefined) throw new Error(invalidBatch);
    if (state.packageIds[batch] !== null || claimedPackages.has(pkg.packageId)) {
      throw new Error(`Jira 수집 계획의 ${batch + 1}번 묶음이 중복되었습니다.`);
    }
    if (state.instanceKey !== null && state.instanceKey !== pkg.instanceKey) {
      throw new Error('같은 Jira 수집 계획의 모든 묶음에 같은 원본 인스턴스 식별값을 지정해 주세요.');
    }
    state.instanceKey = pkg.instanceKey;
    state.packageIds[batch] = pkg.packageId;
    claimedPackages.add(pkg.packageId);
  }

  function finish() {
    return states.map(({ plan, packageIds }) => {
      const missing = packageIds.indexOf(null);
      if (missing !== -1) throw new Error(`Jira 수집 계획의 ${missing + 1}번 묶음 ZIP이 없습니다.`);
      return { sha256: plan.sha256, issueCount: plan.issueCount, batchCount: packageIds.length, packageIds: [...packageIds] };
    });
  }

  return { addPackage, finish };
}
