import { normalizeDocumentLabels } from '../shared/document-labels.js';

// https://confluence.atlassian.com/spaces/CONF54/pages/428803038/_ContentByLabelMacroMarkup
// https://developer.atlassian.com/server/confluence/advanced-searching-using-cql/
type Sort = 'title' | 'created' | 'updated';
type Scope = { spaceKey: string | null; labels: string[]; match: 'any' | 'all' };
type Order = { sort: Sort; descending: boolean };
export type ConfluenceLabelList = Scope & Order & {
  limit: number; title: string; showLabels: boolean; showSpace: boolean; excludeCurrent: boolean;
};

const spaceKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const legacyLabelPattern = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;
const keys = {
  label: ['label', 'labels'], space: ['space', 'spaces'], limit: ['max', 'maxResults'],
  excerpt: ['excerpt', 'excerpts'], excludeCurrent: ['excludeCurrent', 'excludeCurrentPage'],
};
const displayParameters = new Set(['title', 'sort', 'reverse', 'showLabels', 'showSpace',
  ...keys.limit, ...keys.excerpt, ...keys.excludeCurrent]);
const legacyParameters = new Set([...displayParameters, ...keys.label, ...keys.space, 'type', 'operator']);
const modernParameters = new Set([...displayParameters, 'cql', 'excerptType']);

function one(params: Record<string, string>, aliases: string[]): string | null | undefined {
  const provided = aliases.filter(key => Object.hasOwn(params, key));
  if (provided.length > 1) return null;
  return provided.length === 1 ? params[provided[0]].trim() : undefined;
}

function bool(value: string | undefined | null, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  const key = value?.toLowerCase();
  return key === 'true' ? true : key === 'false' ? false : null;
}

function legacyScope(params: Record<string, string>): Scope | null {
  const labelParameter = one(params, keys.label);
  const space = one(params, keys.space);
  const operator = params.operator?.trim().toLowerCase() ?? 'or';
  if (!labelParameter || !space || params.type?.trim().toLowerCase() !== 'page' || !['and', 'or'].includes(operator)) return null;
  const rawLabels = labelParameter.split(/[,\s]+/u);
  const labels = rawLabels.every(label => legacyLabelPattern.test(label)) ? normalizeDocumentLabels(rawLabels) : null;
  if (!labels?.length || !(space === '@self' || spaceKeyPattern.test(space))) return null;
  return { spaceKey: space === '@self' ? null : space, labels, match: operator === 'and' ? 'all' : 'any' };
}

type Token = { text: string; quoted: boolean };
function cqlTokens(query: string): Token[] | null {
  // This small positive grammar never executes CQL or discards predicates.
  if (!query || query.length > 4096) return null;
  const tokens: Token[] = [];
  const pattern = /\s+|"([^"\\]*)"|'([^'\\]*)'|[=(),]|[\p{L}\p{N}_-]+/uy;
  while (pattern.lastIndex < query.length) {
    const match = pattern.exec(query);
    if (!match || tokens.length >= 200) return null;
    if (!match[0].trim()) continue;
    const quoted = match[1] ?? match[2];
    tokens.push({ text: quoted ?? match[0], quoted: quoted !== undefined });
  }
  return tokens;
}

function cqlScope(query: string): (Scope & { order?: Order }) | null {
  const tokens = cqlTokens(query);
  if (!tokens?.length) return null;
  let index = 0, space: string | null | undefined, pages = false;
  let match: Scope['match'] = 'all';
  const rawLabels: string[] = [];
  const consume = (term: string) => {
    if (!tokens[index] || tokens[index].quoted || tokens[index].text.toLowerCase() !== term) return false;
    index++;
    return true;
  };
  const value = () => {
    const token = tokens[index];
    if (!token || !token.quoted && !/^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(token.text)) return;
    if (!token.quoted && ['and', 'or', 'not', 'in', 'order', 'by', 'null'].includes(token.text.toLowerCase())) return;
    index++;
    return token.text;
  };
  function predicate(): boolean {
    if (consume('(')) return conjunction() && consume(')');
    if (consume('type')) {
      if (pages || !consume('=') || value()?.toLowerCase() !== 'page') return false;
      pages = true;
    } else if (consume('space')) {
      if (space !== undefined) return false;
      const explicitValueList = consume('in');
      if (explicitValueList ? !consume('(') : !consume('=')) return false;
      if (!explicitValueList && consume('currentspace')) {
        if (!consume('(') || !consume(')')) return false;
        space = null;
      } else {
        const key = value();
        if (!key || !spaceKeyPattern.test(key) || explicitValueList && !consume(')')) return false;
        space = key;
      }
    } else if (consume('label')) {
      if (consume('=')) {
        const label = value();
        if (!label || !legacyLabelPattern.test(label) || match === 'any') return false;
        rawLabels.push(label);
      } else if (consume('in')) {
        if (rawLabels.length || !consume('(')) return false;
        match = 'any';
        do {
          const label = value();
          if (!label || !legacyLabelPattern.test(label)) return false;
          rawLabels.push(label);
        } while (consume(','));
        if (!consume(')')) return false;
      } else return false;
    } else return false;
    return true;
  }
  function conjunction(): boolean {
    do {
      if (!predicate()) return false;
    } while (consume('and'));
    return true;
  }

  if (!conjunction()) return null;
  let order: Order | undefined;
  if (consume('order')) {
    if (!consume('by')) return null;
    const sort = consume('title') ? 'title' : consume('created') ? 'created' : consume('lastmodified') ? 'updated' : null;
    if (!sort) return null;
    const descending = consume('desc');
    if (!descending) consume('asc');
    order = { sort, descending };
  }
  const labels = normalizeDocumentLabels(rawLabels);
  return space !== undefined && pages && labels?.length && index === tokens.length ? { spaceKey: space, labels, match, order } : null;
}

export function parseConfluenceLabelList(params: Record<string, string>): ConfluenceLabelList | null {
  const modern = Object.hasOwn(params, 'cql');
  const whitelist = modern ? modernParameters : legacyParameters;
  if (Object.keys(params).some(key => !whitelist.has(key))) return null;
  const scope: (Scope & { order?: Order }) | null = modern ? cqlScope(params.cql.trim()) : legacyScope(params);
  if (!scope) return null;
  const { order, spaceKey, match, labels } = scope;
  const explicitSort = params.sort?.trim().toLowerCase();
  const sort: Sort | undefined = explicitSort === 'title' ? 'title' : explicitSort === 'creation' ? 'created' : explicitSort === 'modified' ? 'updated' : undefined;
  const reverse = bool(params.reverse?.trim(), false);
  if (reverse === null || explicitSort !== undefined && !sort || modern && !sort && reverse) return null;
  const displaySort = sort && { sort, descending: (sort !== 'title') !== reverse };
  const chosenOrder = order ?? displaySort ?? (!modern ? { sort: 'updated' as const, descending: true } : null);
  if (!chosenOrder || order && displaySort && (order.sort !== displaySort.sort || order.descending !== displaySort.descending)) return null;

  const rawLimit = one(params, keys.limit);
  const limit = rawLimit === undefined ? 15 : rawLimit && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  const excerpt = one(params, [...keys.excerpt, 'excerptType']);
  if (!(limit >= 1 && limit <= 500) || excerpt === null || excerpt && !['false', 'none'].includes(excerpt.toLowerCase())) return null;
  const showLabels = bool(params.showLabels?.trim(), true), showSpace = bool(params.showSpace?.trim(), true);
  const excludeCurrent = bool(one(params, keys.excludeCurrent), false);
  if (showLabels === null || showSpace === null || excludeCurrent === null) return null;
  return { spaceKey, match, labels, ...chosenOrder, limit, title: params.title?.trim() ?? '', showLabels, showSpace, excludeCurrent };
}
