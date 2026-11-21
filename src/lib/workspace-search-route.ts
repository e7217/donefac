import { normalizeDocumentLabelKey } from '../../shared/document-labels';
import { normalizeWorkspaceSearchInput, type WorkspaceSearchFilters } from '../../shared/workspace-search';

export function readWorkspaceSearchFilters(parameters: URLSearchParams): WorkspaceSearchFilters {
  const selectedScope = parameters.get('space') ?? '';
  const selectedKind = parameters.get('type');
  const kind = selectedKind === 'issue' || selectedKind === 'document' ? selectedKind : 'all';
  const projectScope = /^project:[^\s\u0000-\u001f\u007f]{1,200}$/u.test(selectedScope);
  const requestedPage = parameters.get('page') ?? '';
  return {
    query: normalizeWorkspaceSearchInput(parameters.get('q') ?? ''),
    kind,
    scope: projectScope || selectedScope === 'common' ? selectedScope : '',
    label: kind === 'issue' ? '' : normalizeDocumentLabelKey(parameters.get('label')) ?? '',
    page: /^[1-9]\d{0,6}$/u.test(requestedPage) ? Number(requestedPage) : 1,
  };
}

export function appendWorkspaceSearchFilters(parameters: URLSearchParams, filters: WorkspaceSearchFilters): void {
  const query = normalizeWorkspaceSearchInput(filters.query);
  if (query) parameters.set('q', query);
  if (filters.kind !== 'all') parameters.set('type', filters.kind);
  if (filters.scope) parameters.set('space', filters.scope);
  if (filters.label) parameters.set('label', filters.label);
  if (filters.page > 1) parameters.set('page', String(filters.page));
}

export function sameWorkspaceSearchFilters(a?: WorkspaceSearchFilters, b?: WorkspaceSearchFilters): boolean {
  return a?.query === b?.query && a?.kind === b?.kind && a?.scope === b?.scope && a?.label === b?.label && a?.page === b?.page;
}
