import { isJiraIssueKey } from '../shared/atlassian-links.js';
import type { Issue, IssueKeyMatch, IssueSearchAlias } from '../shared/types.js';
import { activeOriginalJiraIssueKeys } from './gitlab-jira-sources.js';
import { previousIssueKeys, type PreviousIssueKey } from './reporting-ledger.js';
import type { Store } from './store.js';

export class IssueKeyLookupError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type KeyOwner = Pick<Issue, 'id' | 'key'>;
const normalizeKey = (key: string) => key.normalize('NFKC').trim().toLowerCase();
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function lookupKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 200 || !value.isWellFormed() || /\p{Cc}/u.test(value)) return undefined;
  const normalized = normalizeKey(value);
  return normalized && normalized.length <= 200 ? normalized : undefined;
}

/** Project only the former keys that still resolve to a live ticket. */
export function readIssueSearchAliases(store: Store, issues: readonly KeyOwner[],
  origins: ReadonlyMap<string, readonly PreviousIssueKey[]> = previousIssueKeys(store),
): Record<string, IssueSearchAlias[]> {
  if (!issues.length) return {};
  const currentKeys = new Map(issues.map(issue => [issue.id, normalizeKey(issue.key)]));
  const aliases = new Map<string, Map<string, IssueSearchAlias>>();
  function add(issueId: string, key: string, source: IssueSearchAlias['source']) {
    const currentKey = currentKeys.get(issueId);
    if (currentKey === undefined || (source === 'jira' && !isJiraIssueKey(key))) return;
    const normalized = lookupKey(key);
    if (!normalized || currentKey === normalized) return;
    let issueAliases = aliases.get(issueId);
    if (!issueAliases) {
      issueAliases = new Map();
      aliases.set(issueId, issueAliases);
    }
    const identity = `${source}:${normalized}`;
    const previous = issueAliases.get(identity);
    if (!previous || compareText(key, previous.key) < 0) issueAliases.set(identity, { key, source });
  }
  for (const { issueId, originalJiraKey } of activeOriginalJiraIssueKeys(store)) add(issueId, originalJiraKey, 'jira');
  for (const [issueId, formerKeys] of origins) {
    for (const { key } of formerKeys) add(issueId, key, 'move');
  }
  return Object.fromEntries([...aliases].sort(([left], [right]) => compareText(left, right)).map(([issueId, entries]) => [
    issueId, [...entries].sort(([left], [right]) => compareText(left, right)).map(([, alias]) => alias),
  ]));
}

function parseLookup(query: Record<string, unknown>): { key: string; projectId?: string } {
  if (!query || Object.keys(query).some(name => name !== 'key' && name !== 'projectId')) {
    throw new IssueKeyLookupError(400, '업무 키 조회 조건을 확인해 주세요.');
  }
  const { key, projectId } = query;
  const normalized = lookupKey(key);
  if (!normalized) throw new IssueKeyLookupError(400, '조회할 업무 키를 입력해 주세요.');
  if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim() || /[\p{Cc}]/u.test(projectId))) {
    throw new IssueKeyLookupError(400, '조회할 프로젝트를 확인해 주세요.');
  }
  return { key: normalized, projectId };
}

export function readIssueKeyMatches(store: Store, query: Record<string, unknown>,
  allowedProjectIds: readonly string[] | null = null,
): IssueKeyMatch[] {
  const { key, projectId } = parseLookup(query);
  if (projectId !== undefined && allowedProjectIds !== null && !allowedProjectIds.includes(projectId)) {
    throw new IssueKeyLookupError(403, '이 API 키에서 허용하지 않은 프로젝트입니다.');
  }
  const ownTransaction = !store.db.isTransaction;
  if (ownTransaction) store.db.exec('BEGIN');
  try {
    if (projectId !== undefined && !store.get('projects', projectId)) {
      throw new IssueKeyLookupError(404, '프로젝트를 찾을 수 없습니다.');
    }
    const sql = "SELECT id, project_id AS projectId, json_extract(json,'$.key') AS key FROM issues";
    const ownersStatement = projectId !== undefined ? `${sql} WHERE project_id=?`
      : allowedProjectIds !== null ? `${sql} WHERE project_id IN (SELECT value FROM json_each(?))` : sql;
    const params = projectId !== undefined ? [projectId] : allowedProjectIds !== null ? [JSON.stringify(allowedProjectIds)] : [];
    const owners = store.db.prepare(ownersStatement).all(...params) as (KeyOwner & Pick<Issue, 'projectId'>)[];
    const aliases = readIssueSearchAliases(store, owners);
    const matches = owners.flatMap(owner => {
      const current = normalizeKey(owner.key) === key;
      const matchedAliases = Object.hasOwn(aliases, owner.id) ? aliases[owner.id].filter(alias => normalizeKey(alias.key) === key) : [];
      return current || matchedAliases.length ? [{ owner, current, matchedAliases }] : [];
    });
    matches.sort((left, right) => Number(right.current) - Number(left.current) ||
      compareText(left.owner.projectId, right.owner.projectId) || compareText(left.owner.key, right.owner.key) || compareText(left.owner.id, right.owner.id));
    const results = matches.map(({ owner, matchedAliases }) => ({ issue: store.get<Issue>('issues', owner.id)!, matchedAliases }));
    if (ownTransaction) store.db.exec('COMMIT');
    return results;
  } catch (error) {
    if (ownTransaction) store.db.exec('ROLLBACK');
    throw error;
  }
}
