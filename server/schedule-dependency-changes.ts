import type { Dependency } from '../shared/types.js';

export type ScheduleDependencyMutation =
  | { before: null; after: Dependency }
  | { before: Dependency; after: Dependency | null };

export function dependencyPair(predecessorId: string, successorId: string) {
  return JSON.stringify([predecessorId, successorId]);
}

export function addsScheduleDependencyPair({ before, after }: ScheduleDependencyMutation) {
  return Boolean(after && (!before || before.predecessorId !== after.predecessorId || before.successorId !== after.successorId));
}

export function projectScheduleDependencies(current: Dependency[], changes: ScheduleDependencyMutation[]) {
  const links = new Map(current.map(link => [link.id, link]));
  for (const { before, after } of changes) {
    if (after) links.set(after.id, after);
    else if (before) links.delete(before.id);
  }
  return [...links.values()];
}

export function hasScheduleDependencyCycle(dependencies: Dependency[]) {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const { predecessorId, successorId } of dependencies) {
    if (!incoming.has(predecessorId)) incoming.set(predecessorId, 0);
    incoming.set(successorId, (incoming.get(successorId) ?? 0) + 1);
    const next = outgoing.get(predecessorId);
    if (next) next.push(successorId);
    else outgoing.set(predecessorId, [successorId]);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < ready.length; index++) {
    for (const successor of outgoing.get(ready[index]) ?? []) {
      const count = incoming.get(successor)! - 1;
      incoming.set(successor, count);
      if (count === 0) ready.push(successor);
    }
  }
  return ready.length !== incoming.size;
}
