const maxPages = 500;
const pageBatchSize = 50;
const restrictionBatchSize = 100;
const inventoryExpansion = 'space,version,ancestors';
const restrictionExpansion = 'restrictions.user,restrictions.group';
const unavailablePage = { optionalStatuses: [403, 404, 410] };
const unavailableRestrictions = { optionalStatuses: [400, 401, 403, 404, 405, 410, 501] };

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validId(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}

function numericId(value) {
  if (validId(value)) return value;
  return positiveInteger(value) ? String(value) : null;
}

function invalidInventory() {
  throw new Error('Confluence 페이지 조회 범위 또는 페이지 응답이 일치하지 않습니다.');
}

function pageLimitExceeded() {
  throw new Error('읽을 수 있는 Confluence 페이지가 500개를 넘습니다. pageIds로 나누어 확인해 주세요.');
}

function readPage(value, spaceKey, expectedId) {
  const spaceId = numericId(value?.space?.id);
  if (!record(value) || !validId(value.id) || (expectedId !== undefined && value.id !== expectedId)
    || value.type !== 'page' || value.status !== 'current' || value.space?.key !== spaceKey || !spaceId
    || !positiveInteger(value.version?.number) || !Array.isArray(value.ancestors)
    || value.ancestors.length > maxPages) {
    invalidInventory();
  }

  const ancestors = value.ancestors.map(ancestor => {
    if (!record(ancestor) || !validId(ancestor.id) || ancestor.type !== 'page'
      || (ancestor.status !== undefined && ancestor.status !== 'current')
      || (ancestor.space?.key !== undefined && ancestor.space.key !== spaceKey)
      || (ancestor.space?.id !== undefined && numericId(ancestor.space.id) !== spaceId)) {
      invalidInventory();
    }
    return ancestor.id;
  });
  if (ancestors.includes(value.id) || new Set(ancestors).size !== ancestors.length) invalidInventory();
  return { id: value.id, spaceId, version: value.version.number, ancestors };
}

function validPageWindow(value, start, limit) {
  return record(value) && Array.isArray(value.results) && value.start === start
    && positiveInteger(value.limit) && value.limit <= limit
    && value.size === value.results.length && value.size <= value.limit;
}

function scopedLink(link, responseUrl, path) {
  if (typeof link !== 'string' || !link || /[\s\\]/.test(link) || link.startsWith('//')) return undefined;
  const response = new URL(responseUrl);
  let target;
  try {
    target = new URL(link, response);
  } catch {
    return undefined;
  }
  // Confluence also returns application-relative links when it runs below a context path.
  const applicationRelative = link.startsWith('/rest/api/') && target.pathname === `/${path}`;
  if (target.origin !== response.origin || target.username || target.password || target.hash
    || (!applicationRelative && target.pathname !== response.pathname)) {
    return undefined;
  }
  return target;
}

function nextListOffset(value, responseUrl, path) {
  const next = value._links.next;
  if (next === undefined) return undefined;
  const target = scopedLink(next, responseUrl, path);
  if (!target) invalidInventory();

  const params = target.searchParams;
  const startValue = params.get('start');
  const start = Number(startValue);
  const limit = params.get('limit');
  if (!positiveInteger(start) || `${start}` !== startValue || params.getAll('start').length !== 1
    || (start !== value.start + value.limit && start !== value.start + value.size)
    || start <= value.start || params.getAll('limit').length > 1 || params.getAll('expand').length > 1
    || (limit !== null && limit !== `${value.limit}` && limit !== `${pageBatchSize}`)
    || (params.has('expand') && params.get('expand') !== inventoryExpansion)
    || [...params.keys()].some(key => !['start', 'limit', 'expand'].includes(key))) {
    invalidInventory();
  }
  return start;
}

async function readVisiblePages(spaceKey, getJson) {
  const pages = new Map();
  const path = `rest/api/space/${encodeURIComponent(spaceKey)}/content/page`;
  let start = 0;
  let observedTotal;
  for (let request = 0; request < maxPages; request += 1) {
    const { value, url } = await getJson(path, { start, limit: pageBatchSize, expand: inventoryExpansion });
    if (!validPageWindow(value, start, pageBatchSize) || !record(value._links)) invalidInventory();
    if (value._links.self !== undefined && !scopedLink(value._links.self, url, path)) invalidInventory();
    if (value.total !== undefined && value.totalCount !== undefined && value.total !== value.totalCount) {
      invalidInventory();
    }
    const total = value.totalCount === undefined ? value.total : value.totalCount;
    if (Number.isSafeInteger(total) && total > maxPages) pageLimitExceeded();
    if ((total !== undefined && (!Number.isSafeInteger(total) || total < 0))
      || (request > 0 && total !== observedTotal)) {
      invalidInventory();
    }
    observedTotal = total;

    for (const row of value.results) {
      const page = readPage(row, spaceKey);
      if (pages.has(page.id)) invalidInventory();
      if (pages.size >= maxPages) pageLimitExceeded();
      pages.set(page.id, page);
    }

    const next = nextListOffset(value, url, path);
    if (next === undefined) {
      if (observedTotal !== undefined && pages.size !== observedTotal) invalidInventory();
      return pages;
    }
    if (observedTotal !== undefined && pages.size >= observedTotal) invalidInventory();
    start = next;
  }
  invalidInventory();
}

async function readPageById(spaceKey, id, getJson) {
  const path = `rest/api/content/${id}`;
  const response = await getJson(path, { expand: inventoryExpansion }, unavailablePage);
  if (response === null) return null;
  if (response.value?._links?.self !== undefined && !scopedLink(response.value._links.self, response.url, path)) {
    invalidInventory();
  }
  return readPage(response.value, spaceKey, id);
}

function scopeStatus(value) {
  if (!validPageWindow(value, 0, restrictionBatchSize)) return 'unknown';
  if (value.results.some(subject => !record(subject))) return 'unknown';
  if (value.size > 0) return 'restricted';
  if ((value._links !== undefined && !record(value._links)) || value._links?.next !== undefined
    || (value.total !== undefined && value.total !== 0) || (value.totalCount !== undefined && value.totalCount !== 0)) {
    return 'unknown';
  }
  return 'clear';
}

function combineRestrictions(statuses) {
  if (statuses.includes('restricted')) return 'restricted';
  return statuses.includes('unknown') ? 'unknown' : 'clear';
}

async function readRestriction(id, operation, getJson) {
  const path = `rest/api/content/${id}/restriction/byOperation/${operation}`;
  const response = await getJson(path, { start: 0, limit: restrictionBatchSize, expand: restrictionExpansion }, unavailableRestrictions);
  const value = response?.value;
  if (!record(value) || value.operation !== operation || !record(value.restrictions)) return 'unknown';
  if (value.content !== undefined && (!record(value.content) || value.content.id !== id)) return 'unknown';
  if (value._links?.self !== undefined && !scopedLink(value._links.self, response.url, path)) return 'unknown';
  const status = combineRestrictions([scopeStatus(value.restrictions.user), scopeStatus(value.restrictions.group)]);
  return status === 'clear' && value._links?.next !== undefined ? 'unknown' : status;
}

async function fetchMissingAncestors(pages, unreadableIds, spaceKey, getJson) {
  const ancestors = new Map(pages);
  const needed = new Set([...pages.values()].flatMap(page => page.ancestors.filter(id => !ancestors.has(id) && !unreadableIds.has(id))));
  for (const id of [...needed].slice(0, maxPages)) {
    ancestors.set(id, await readPageById(spaceKey, id, getJson));
  }
  for (const page of pages.values()) {
    page.ancestors.forEach((id, index) => {
      const ancestor = ancestors.get(id);
      if (ancestor && (ancestor.spaceId !== page.spaceId || ancestor.ancestors.length !== index
        || ancestor.ancestors.some((parentId, position) => parentId !== page.ancestors[position]))) {
        invalidInventory();
      }
    });
  }
  return ancestors;
}

export async function readConfluenceInventory({ spaceKey, pageIds }, getJson) {
  const explicitSelection = pageIds !== undefined;
  const requestedPageIds = explicitSelection ? new Set(pageIds) : undefined;
  const pages = explicitSelection ? new Map() : await readVisiblePages(spaceKey, getJson);
  const unreadableIds = new Set();
  if (requestedPageIds) {
    if (requestedPageIds.size < 1 || requestedPageIds.size > maxPages) invalidInventory();
    for (const id of requestedPageIds) {
      if (!validId(id)) invalidInventory();
      const page = await readPageById(spaceKey, id, getJson);
      if (page) pages.set(id, page);
      else unreadableIds.add(id);
    }
  }

  const spaceId = pages.values().next().value?.spaceId ?? null;
  if ([...pages.values()].some(page => page.spaceId !== spaceId)) invalidInventory();
  const ancestors = await fetchMissingAncestors(pages, unreadableIds, spaceKey, getJson);
  const restrictionRequests = new Map();
  const restriction = (id, operation) => {
    const key = `${id}:${operation}`;
    if (!restrictionRequests.has(key)) {
      restrictionRequests.set(key, ancestors.get(id) ? readRestriction(id, operation, getJson) : Promise.resolve('unknown'));
    }
    return restrictionRequests.get(key);
  };

  for (const page of pages.values()) {
    // View restrictions apply to descendants, while edit restrictions apply to the page itself.
    const statuses = await Promise.all([restriction(page.id, 'read'), restriction(page.id, 'update')]);
    for (const id of page.ancestors) statuses.push(await restriction(id, 'read'));
    page.restriction = combineRestrictions(statuses);
  }

  return { spaceKey, spaceId, explicitSelection, requestedPageIds, pages, unreadableIds, unavailablePages: unreadableIds.size };
}
