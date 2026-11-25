import { useEffect, useState } from 'react';

type TreeExpansion = { key: string; selection: string; collapsed: ReadonlySet<string> };
const emptyBranches: ReadonlySet<string> = new Set();

function readCollapsedBranches(key: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (Array.isArray(stored)) return new Set(stored.filter(id => typeof id === 'string' && id.length > 0));
  } catch { /* A view preference is optional when browser storage is unavailable. */ }
  return emptyBranches;
}

function revealPath(collapsed: ReadonlySet<string>, ancestors: readonly { id: string }[]) {
  if (!ancestors.some(page => collapsed.has(page.id))) return collapsed;
  const revealed = new Set(collapsed);
  for (const page of ancestors) revealed.delete(page.id);
  return revealed;
}

export function useDocumentTreeExpansion(actorId: string, restoreGeneration: string | undefined,
  selectedDocumentId: string | null, ancestors: readonly { id: string }[]) {
  const key = `teamspace:document-tree-expansion:${JSON.stringify([actorId, restoreGeneration ?? null])}`;
  // Keep the reveal stable while snapshots refresh or unrelated document data changes.
  const selection = JSON.stringify([selectedDocumentId, ancestors.map(page => page.id)]);
  const [view, setView] = useState<TreeExpansion>(() => ({
    key, selection, collapsed: revealPath(readCollapsedBranches(key), ancestors),
  }));
  if (view.key !== key || view.selection !== selection) {
    const saved = view.key === key ? view.collapsed : readCollapsedBranches(key);
    setView({ key, selection, collapsed: revealPath(saved, ancestors) });
  }

  useEffect(() => {
    try {
      if (view.collapsed.size) localStorage.setItem(view.key, JSON.stringify([...view.collapsed]));
      else localStorage.removeItem(view.key);
    } catch { /* The current document tree stays usable without browser storage. */ }
  }, [view]);

  function toggleBranch(id: string) {
    setView(previous => {
      const next = new Set(previous.collapsed);
      if (!next.delete(id)) next.add(id);
      return { ...previous, collapsed: next };
    });
  }
  return { collapsed: view.collapsed, toggleBranch };
}
