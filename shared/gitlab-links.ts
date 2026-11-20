export function gitlabObjectSha(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value) ? value.toLowerCase() : null;
}

export function isGitlabBranchName(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || !value.isWellFormed() || value === '@') return false;
  if (value.startsWith('-') || value.endsWith('.') || value.includes('..') || value.includes('@{') || value.includes('[') || value.includes('\\') || /[\u0000-\u0020\u007f~^:?*]/u.test(value)) return false;
  return value.split('/').every(segment => segment.length > 0 && !segment.startsWith('.') && !segment.endsWith('.lock'));
}

export function isRestorableGitlabLink(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const link = value as Record<string, unknown>;
  if (Object.hasOwn(link, 'branchObservationSource') &&
      (link.kind !== 'branch' || link.branchObservationSource !== 'sync' || link.state !== 'active')) return false;
  if (link.kind !== 'branch') {
    return typeof link.kind === 'string' && ['merge_request', 'commit', 'pipeline'].includes(link.kind) && Number.isInteger(link.projectId) &&
      typeof link.webUrl === 'string' && /^https?:\/\//.test(link.webUrl);
  }

  const { iid, projectId, title, sourceBranch, sourceSha, state, updatedAt, webUrl } = link;
  const sha = gitlabObjectSha(sourceSha);
  if (iid !== 0 || typeof projectId !== 'number' || !Number.isSafeInteger(projectId) || projectId < 1 ||
      !isGitlabBranchName(sourceBranch) || title !== sourceBranch || !sha || /^0+$/.test(sha) ||
      (state !== 'active' && state !== 'deleted') || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)) ||
      typeof webUrl !== 'string' || webUrl.length > 4_000) return false;
  let url: URL;
  try { url = new URL(webUrl); }
  catch { return false; }
  const suffix = `/-/tree/${encodeURIComponent(sourceBranch)}`;
  return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password &&
    !url.search && !url.hash && url.toString() === webUrl && url.pathname.length > suffix.length && url.pathname.endsWith(suffix);
}
