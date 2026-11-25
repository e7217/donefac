import { isDeepStrictEqual } from 'node:util';
import { isJiraCommentRestrictionAttribute, isRestrictedJiraHistory } from '../server/migration-jira-history.ts';
import { jiraWorklogRawStart, jiraWorklogRestrictionAttribute, parseJiraWorklogDuration } from '../server/migration-worklog.ts';

const pageSize = 100;
const maxRecords = 100_000;
const unavailableHistory = [404, 405];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const detailCount = value => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
const numericId = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
  : typeof value === 'string' && /^[1-9]\d{0,199}$/.test(value) ? value : null;
const historyId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value) ? value : numericId(value);

function location(value, base) {
  if (typeof value !== 'string' || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const raw = /^(.*?)\/rest\/api\/(?:2(?:\.0)?|latest)\/issue\/([1-9]\d*|[A-Z][A-Z0-9_]*-\d+)(?:\/(comment|worklog|changelog)(?:\/([A-Za-z0-9][A-Za-z0-9_.-]{0,199}))?)?\/?$/.exec(url.pathname);
    if (!raw) return null;
    const [, prefix, alias, endpoint = null, recordId = null] = raw;
    return { base: url.origin + prefix, alias, endpoint, recordId };
  } catch {
    return null;
  }
}

function ownedBy(position, issue, base, endpoint, recordId = null) {
  return position && (position.alias === String(issue.id) || position.alias === issue.key) &&
    position.base === base && position.endpoint === endpoint && position.recordId === recordId;
}

function assertOwner(record, issue, expected, recordId) {
  if (Object.hasOwn(record, 'issueId') && numericId(record.issueId) !== numericId(issue.id) ||
      Object.hasOwn(record, 'self') && !ownedBy(location(record.self, `${expected.base}/`), issue, expected.base, expected.endpoint, recordId)) {
    throw new Error(`Jira ${expected.endpoint} 응답의 원본 업무 또는 기록을 확인할 수 없습니다.`);
  }
}

function canonicalSelf(issue, expected, recordId = null) {
  const path = `${expected.base}/rest/api/2/issue/${issue.id}/${expected.endpoint}`;
  return recordId === null ? path : `${path}/${recordId}`;
}

function pageRows(value, key, endpoint, offset, expectedTotal) {
  const rows = value?.[key];
  if (!object(value) || !Array.isArray(rows) || !count(value.startAt) || value.startAt !== offset ||
      !count(value.total) || value.total > maxRecords || value.total < offset ||
      expectedTotal !== undefined && value.total !== expectedTotal || rows.length > value.total - offset ||
      !rows.length && offset < value.total ||
      Object.hasOwn(value, 'maxResults') && (!count(value.maxResults) || rows.length > value.maxResults) ||
      Object.hasOwn(value, 'isLast') && value.isLast !== (offset + rows.length === value.total) ||
      key === 'comments' && Object.hasOwn(value, 'worklogs') || key === 'worklogs' && Object.hasOwn(value, 'comments')) {
    throw new Error(`Jira ${endpoint} 페이지의 범위 또는 전체 개수가 일치하지 않습니다.`);
  }
  return rows;
}

function historyPayload(group) {
  const content = { ...group };
  delete content.id;
  delete content.self;
  return content;
}

function hasHistoryItems(group) {
  return Array.isArray(group.items) && group.items.every(object);
}

function dateValue(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:?\d\d)$/iu.test(value)) return value;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : value;
}

function observedWorklogStart(row) {
  const raw = jiraWorklogRawStart(row);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim();
  // Worklogs are grouped by Jira's written calendar day as well as retaining the instant.
  const timestamp = dateValue(value);
  return typeof timestamp === 'number' ? [value.slice(0, 10), timestamp] : value;
}

function numericValue(value) {
  const normalized = detailCount(value);
  return Number.isSafeInteger(normalized) ? normalized : value;
}

function retainsDate(before, after) {
  return before == null || isDeepStrictEqual(dateValue(before), dateValue(after));
}

function retainsObservation(before, after) {
  return before === undefined || isDeepStrictEqual(before, after);
}

function authorIds(author) {
  const id = value => (typeof value === 'string' && value.length > 0) || Number.isSafeInteger(value) ? String(value) : null;
  return object(author) ? [author.accountId, author.key, author.name ?? author.username, author.id].map(id) : [id(author)];
}

function retainsAuthor(before, after) {
  const source = authorIds(before), page = authorIds(after);
  if (!source.some(Boolean)) return true;
  if (!object(before) || !object(after)) {
    const primary = ids => ids.find(Boolean);
    return primary(source) === primary(page);
  }
  const shared = source.findIndex((value, index) => value !== null && page[index] !== null);
  return shared !== -1 && source[shared] === page[shared];
}

function retainsRestrictionValue(before, after) {
  if (object(before) && object(after)) {
    return Object.entries(before).every(([name, value]) => Object.hasOwn(after, name) && retainsRestrictionValue(value, after[name]));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.every(value => after.some(candidate => retainsRestrictionValue(value, candidate)));
  }
  return isDeepStrictEqual(numericValue(before), numericValue(after)) ||
    typeof before === 'boolean' && String(before) === after || typeof after === 'boolean' && before === String(after);
}

function retainedRestrictions(before, after, worklog) {
  const normalizedName = name => name.replace(/[\s_-]/g, '').toLowerCase();
  const restricts = (name, value) => isRestrictedJiraHistory({ kind: worklog ? 'history' : 'comment',
    metadata: { ...(worklog ? { kind: 'worklog' } : {}), [name]: value } });
  const afterEntries = Object.entries(after);
  return Object.entries(before).every(([name, value]) => {
    const restriction = worklog ? jiraWorklogRestrictionAttribute(name) : isJiraCommentRestrictionAttribute(name);
    if (!restriction || !restricts(name, value)) return true;
    const key = normalizedName(name);
    const source = Array.isArray(value) ? value.filter(entry => restricts(name, [entry])) : value;
    return afterEntries.some(([field, candidate]) => normalizedName(field) === key && restricts(field, candidate) &&
      retainsRestrictionValue(source, candidate));
  });
}

function sameActivityPayload(before, after, worklog) {
  const text = worklog ? 'comment' : 'body';
  const seconds = worklog ? parseJiraWorklogDuration(before) : undefined;
  return retainsObservation(before[text], after[text]) && retainsAuthor(before.author, after.author) &&
    retainsDate(before.created, after.created) && retainsDate(before.updated, after.updated) &&
    (!worklog || retainsObservation(observedWorklogStart(before), observedWorklogStart(after))) &&
    (typeof seconds !== 'number' || seconds === parseJiraWorklogDuration(after)) &&
    retainedRestrictions(before, after, worklog);
}

async function collectPages({ issue, getJson, addJson }, endpoint, key, embedded) {
  const history = endpoint === 'changelog';
  const idOf = history ? historyId : numericId;
  const collected = new Set();
  let total, offset = 0;
  do {
    const response = await getJson(`rest/api/2/issue/${issue.id}/${endpoint}`, { startAt: offset, maxResults: pageSize },
      offset === 0 && history ? { optionalStatuses: unavailableHistory } : undefined);
    if (response === null && offset === 0 && history) return null;
    if (!response) throw new Error(`Jira ${endpoint} 페이지를 읽지 못했습니다.`);
    const { value, url } = response;
    const expected = location(url);
    const original = issue.self === undefined ? null : location(issue.self);
    if (!expected || !ownedBy(expected, issue, expected.base, endpoint) ||
        issue.self !== undefined && (!original || !ownedBy(original, issue, expected.base, null))) {
      throw new Error(`Jira ${endpoint} 요청의 원본 업무를 확인할 수 없습니다.`);
    }
    const rows = pageRows(value, key, endpoint, offset, total);
    total = value.total;
    if (embedded?.total !== undefined && embedded.total !== total) {
      throw new Error(`Jira ${endpoint} 전체 개수가 업무 응답과 별도 페이지에서 서로 다릅니다.`);
    }
    if (offset === 0 && embedded?.envelope) {
      assertOwner(embedded.envelope, issue, expected, null);
      for (const [id, row] of embedded.groups) assertOwner(row, issue, expected, id);
    }
    assertOwner(value, issue, expected, null);
    const verified = rows.map((row, index) => {
      const id = object(row) && idOf(row.id);
      if (!id || collected.has(id) || history && !hasHistoryItems(row)) {
        throw new Error(`Jira ${endpoint} 기록 ID가 없거나 같은 기록이 반복됩니다.`);
      }
      assertOwner(row, issue, expected, id);
      const prior = embedded?.groups.get(id);
      if (history && prior && !isDeepStrictEqual(historyPayload(prior), historyPayload(row))) {
        throw new Error('같은 Jira 변경 이력의 내용이 업무 응답과 별도 페이지에서 서로 다릅니다.');
      }
      if (!history && prior && !sameActivityPayload(prior, row, endpoint === 'worklog')) {
        const label = endpoint === 'worklog' ? '작업 시간' : '댓글';
        throw new Error(`같은 Jira ${label}의 내용 또는 열람 제한이 업무 응답과 별도 페이지에서 서로 다릅니다.`);
      }
      const position = embedded?.positions?.get(id);
      if (position !== undefined && position !== offset + index) {
        throw new Error(`Jira ${endpoint} 기록의 위치가 업무 응답과 별도 페이지에서 서로 다릅니다.`);
      }
      collected.add(id);
      return Object.hasOwn(row, 'self') ? { ...row, self: canonicalSelf(issue, expected, id) } : row;
    });
    addJson(`activities/${issue.id}/${key === 'values' ? endpoint : key}-${offset}.json`, {
      ...value, self: canonicalSelf(issue, expected), [key]: verified,
    });
    offset += rows.length;
  } while (offset < total);
  if (embedded && [...embedded.groups.keys()].some(id => !collected.has(id))) {
    throw new Error(`업무 응답에 있던 Jira ${endpoint} 기록이 별도 페이지에서 누락되었습니다.`);
  }
  return collected.size;
}

function embeddedHistory(issue) {
  const { changelog } = issue;
  const groups = new Map();
  if (changelog == null) return { groups, complete: false };
  const { startAt = 0, total, maxResults } = changelog;
  const values = changelog.histories ?? changelog.values;
  if (!object(changelog) || !Array.isArray(values) || !count(startAt) ||
      total !== undefined && (!count(total) || total > maxRecords || startAt > total || values.length > total - startAt) ||
      maxResults !== undefined && (!count(maxResults) || values.length > maxResults)) {
    throw new Error('Jira 업무 응답의 변경 이력 범위 또는 형식이 올바르지 않습니다.');
  }
  for (const group of values) {
    const id = object(group) && historyId(group.id);
    if (!id || !hasHistoryItems(group) || groups.has(id)) throw new Error('Jira 업무 응답의 변경 이력 ID가 없거나 형식이 올바르지 않습니다.');
    groups.set(id, group);
  }
  return { groups, total, complete: startAt === 0 && total === groups.size };
}

function embeddedActivity(issue, endpoint, key) {
  const envelope = issue.fields?.[endpoint];
  if (envelope == null) return undefined;
  const startAt = detailCount(envelope.startAt), total = detailCount(envelope.total), maxResults = detailCount(envelope.maxResults);
  const rows = envelope[key] ?? [];
  if (!object(envelope) || !Array.isArray(rows) ||
      (Object.hasOwn(envelope, key) || startAt !== undefined || total !== undefined || maxResults !== undefined) && !Array.isArray(envelope[key]) ||
      maxResults !== undefined && (!count(maxResults) || rows.length > maxResults) ||
      startAt !== undefined && !count(startAt) || total !== undefined && (!count(total) || total > maxRecords ||
        (startAt ?? 0) > total || rows.length > total - (startAt ?? 0))) {
    throw new Error(`Jira 업무 응답의 ${endpoint} 범위 또는 형식이 올바르지 않습니다.`);
  }
  const groups = new Map();
  const positions = new Map();
  for (const [index, row] of rows.entries()) {
    const id = object(row) && numericId(row.id);
    if (!id || groups.has(id)) throw new Error(`Jira 업무 응답의 ${endpoint} 기록 ID가 없거나 같은 기록이 반복됩니다.`);
    groups.set(id, row);
    if (startAt !== undefined) positions.set(id, startAt + index);
  }
  return { envelope, groups, positions, total };
}

export async function collectJiraIssueActivity({ issue, getJson, addJson, report }) {
  if (!numericId(issue?.id) || typeof issue.key !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issue.key)) {
    throw new Error('Jira 댓글·작업 시간 수집에 원래 업무 ID와 키가 필요합니다.');
  }
  const context = { issue, getJson, addJson };
  const embedded = embeddedHistory(issue);
  const comments = embeddedActivity(issue, 'comment', 'comments');
  const worklogs = embeddedActivity(issue, 'worklog', 'worklogs');
  const commentCount = await collectPages(context, 'comment', 'comments', comments);
  const worklogCount = await collectPages(context, 'worklog', 'worklogs', worklogs);
  const historyCount = embedded.complete ? embedded.groups.size : await collectPages(context, 'changelog', 'values', embedded);
  report.commentCount += commentCount;
  report.worklogCount += worklogCount;
  report.historyCount += historyCount ?? embedded.groups.size;
  if (historyCount === null) report.incompleteHistories++;
}
