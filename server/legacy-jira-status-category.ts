export type JiraStatusCategory = 'new' | 'indeterminate' | 'done';

const categoriesById = new Map<string, JiraStatusCategory | 'undefined'>([
  ['1', 'undefined'], ['2', 'new'], ['3', 'done'], ['4', 'indeterminate'],
] as const);
const categoryKeys = new Set<string>(categoriesById.values());

/** Missing evidence is undefined, while incompatible evidence is null. */
export function readJiraStatusCategory(key: unknown, id: unknown): JiraStatusCategory | null | undefined {
  const idText = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  const fromId = categoriesById.get(idText);
  const fromKey = typeof key === 'string' && categoryKeys.has(key) ? key : undefined;
  if ((fromKey && id !== undefined && fromKey !== fromId) || (fromId && key !== undefined && fromId !== fromKey)) return null;
  const resolved = fromKey ?? fromId;
  if (resolved === 'new' || resolved === 'indeterminate' || resolved === 'done') return resolved;
}
