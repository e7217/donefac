import type { LegacyRecord } from '../shared/types.js';

export type JiraActivityKind = 'comment' | 'worklog';

const activity = {
  comment: { key: 'comments', partial: 'COMMENTS_PARTIAL', label: '댓글' },
  worklog: { key: 'worklogs', partial: 'WORKLOGS_PARTIAL', label: '작업 시간 기록' },
} as const;

type JsonObject = Record<string, unknown>;
type IssueLocation = { base: string; alias: string };
type Location = IssueLocation & { kind: JiraActivityKind | null; childId: string | null };
type StandalonePage = {
  kind: JiraActivityKind;
  path: string;
  root: JsonObject;
  rows: JsonObject[];
  start: number;
  total: number;
};
type EmbeddedPage = {
  issue: LegacyRecord;
  location: IssueLocation | null;
  kind: JiraActivityKind;
  path: string;
  ids: (string | null)[];
  start: number | undefined | null;
  total: number | undefined | null;
  malformed: boolean;
};
type AcceptedPage = StandalonePage & { ids: string[] };

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function numericId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9]\d{0,199}$/.test(value) ? value : null;
}

function location(value: unknown): Location | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const route = /^(.*?)\/rest\/api\/(?:2|3|latest)\/issue\/([1-9]\d*|[A-Z][A-Z0-9_]*-\d+)(?:\/(comment|worklog)(?:\/([1-9]\d{0,199}))?)?\/?$/.exec(url.pathname);
    if (!route) return null;
    const [, prefix, alias, kind, childId] = route;
    return { base: url.origin + prefix, alias, kind: (kind as JiraActivityKind | undefined) ?? null, childId: childId ?? null };
  } catch {
    return null;
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function embeddedCount(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return count(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
}

function aliases(issue: LegacyRecord): string[] {
  return typeof issue.metadata.key === 'string' ? [issue.sourceId, issue.metadata.key] : [issue.sourceId];
}

function agreesWithIssueId(source: JsonObject, issue: LegacyRecord): boolean {
  if (!Object.hasOwn(source, 'issueId')) return true;
  const id = numericId(source.issueId);
  return id !== null && numericId(issue.sourceId) === id;
}

function ownerKey(kind: JiraActivityKind, value: IssueLocation): string {
  return JSON.stringify([kind, value.base, value.alias]);
}

function verifyCoverage(embedded: EmbeddedPage, pages: AcceptedPage[]): boolean {
  const { ids, start, total, malformed } = embedded;
  if (!pages.length) return !malformed && (start === undefined || start === 0) && (total === undefined || total === ids.length);
  const expected = pages[0].total;
  if (malformed || total !== undefined && expected !== total || pages.some(page => page.total !== expected)) return false;

  const positions = new Map<number, string>();
  const offsets = new Map<string, number>();
  function add(offset: number, id: string | null): boolean {
    if (!id || offset >= expected) return false;
    const previousId = positions.get(offset), previousOffset = offsets.get(id);
    if (previousId !== undefined && previousId !== id || previousOffset !== undefined && previousOffset !== offset) return false;
    positions.set(offset, id);
    offsets.set(id, offset);
    return true;
  }
  for (const page of pages) if (!page.ids.every((id, index) => add(page.start + index, id))) return false;
  if (typeof start === 'number') {
    if (start > expected || ids.length > expected - start || !ids.every((id, index) => add(start + index, id))) return false;
  } else if (!ids.every(id => id !== null && offsets.has(id))) return false;
  return positions.size === expected;
}

export class JiraActivityPages {
  private readonly standalone: StandalonePage[] = [];
  private readonly embedded: EmbeddedPage[] = [];

  constructor(private readonly warn: (code: string, message: string, recordId: string | null, path: string) => void) {}

  read(root: JsonObject, path: string): boolean {
    const kinds = (Object.keys(activity) as JiraActivityKind[]).filter(kind => Object.hasOwn(root, activity[kind].key));
    if (!kinds.length) return false;
    const kind = kinds[0];
    const raw = root[activity[kind].key];
    const start = count(root.startAt), total = count(root.total), max = count(root.maxResults);
    if (kinds.length !== 1 || !Array.isArray(raw) || start === null || total === null || start > total ||
        raw.length > total - start || Object.hasOwn(root, 'maxResults') && (max === null || raw.length > max) ||
        !raw.every(row => object(row) !== null && numericId(row.id) !== null)) {
      this.warn('JIRA_ACTIVITY_PAGE_INVALID', 'Jira REST 댓글 또는 작업 시간 페이지의 형식과 범위를 확인할 수 없습니다.', null, path);
      return true;
    }
    this.standalone.push({ kind, path, root, rows: raw, start, total });
    return true;
  }

  track(issue: LegacyRecord, issueSelf: unknown, kind: JiraActivityKind, rawEnvelope: unknown, embeddedIds: (string | null)[], path: string): void {
    const issueLocation = location(issueSelf);
    const provenLocation = issueLocation && !issueLocation.kind && aliases(issue).includes(issueLocation.alias) ? issueLocation : null;
    const envelope = object(rawEnvelope);
    const start = embeddedCount(envelope?.startAt), total = embeddedCount(envelope?.total);
    const malformed = rawEnvelope != null && !envelope || start === null || total === null || start !== undefined && total !== undefined &&
      (start > total || embeddedIds.length > total - start) ||
      (Object.hasOwn(envelope ?? {}, activity[kind].key) || start !== undefined || total !== undefined) && !Array.isArray(envelope?.[activity[kind].key]);
    this.embedded.push({ issue, location: provenLocation, kind, path, ids: embeddedIds.map(numericId), start, total, malformed });
  }

  finish(write: (kind: JiraActivityKind, raw: unknown, issue: LegacyRecord, path: string, index: number) => void): void {
    const owners = new Map<string, EmbeddedPage | null>();
    for (const entry of this.embedded) {
      if (!entry.location) continue;
      for (const alias of aliases(entry.issue)) {
        const key = ownerKey(entry.kind, { base: entry.location.base, alias });
        const previous = owners.get(key);
        owners.set(key, previous === undefined || previous === entry ? entry : null);
      }
    }
    const pagesByOwner = new Map<EmbeddedPage, AcceptedPage[]>();
    for (const page of this.standalone) {
      const owner = this.resolveOwner(page, owners);
      if (!owner) {
        this.warn('JIRA_ACTIVITY_PAGE_OWNER_UNRESOLVED', 'Jira REST 페이지와 같은 원본의 업무를 입증할 수 없습니다.', null, page.path);
        continue;
      }
      const ids = page.rows.map((row, index) => {
        write(page.kind, row, owner.issue, page.path, page.start + index);
        return numericId(row.id)!;
      });
      const pages = pagesByOwner.get(owner) ?? [];
      pages.push({ ...page, ids });
      pagesByOwner.set(owner, pages);
    }
    for (const entry of this.embedded) {
      if (verifyCoverage(entry, pagesByOwner.get(entry) ?? [])) continue;
      const { partial, label } = activity[entry.kind];
      this.warn(partial, `REST ${label} 페이지의 전체 범위를 확인하지 못했습니다.`, entry.issue.id, entry.path);
    }
  }

  private resolveOwner(page: StandalonePage, owners: ReadonlyMap<string, EmbeddedPage | null>): EmbeddedPage | null {
    const find = (value: IssueLocation) => owners.get(ownerKey(page.kind, value)) ?? null;
    const hasRoot = Object.hasOwn(page.root, 'self');
    const root = hasRoot ? location(page.root.self) : null;
    if (hasRoot && (!root || root.kind !== page.kind || root.childId !== null)) return null;
    let owner = root && find(root);
    if (root && !owner) return null;

    for (const row of page.rows) {
      if (!root || Object.hasOwn(row, 'self')) {
        const child = location(row.self);
        if (!child || child.kind !== page.kind || child.childId !== numericId(row.id)) return null;
        const candidate = find(child);
        if (!candidate || owner && owner !== candidate) return null;
        owner = candidate;
      }
      if (!owner || !agreesWithIssueId(row, owner.issue)) return null;
    }
    return owner && agreesWithIssueId(page.root, owner.issue) ? owner : null;
  }
}
