import type { CustomFieldDefinition } from '../shared/types.js';

type ComponentOptionCandidate = { id: string; name: string; scope: string };

const optionNameLimit = 120;
const scopeLimit = 48;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidates(left: ComponentOptionCandidate, right: ComponentOptionCandidate): number {
  return Number(!left.name) - Number(!right.name) || compareText(left.name, right.name) ||
    Number(!left.scope) - Number(!right.scope) || compareText(left.scope, right.scope);
}

function fitLabel(value: string, limit: number): string {
  const clipped = value.slice(0, limit);
  return (clipped.isWellFormed() ? clipped : clipped.slice(0, -1)).trimEnd();
}

function qualifiedLabel(name: string, qualifier: string): string {
  const suffix = ` · ${qualifier}`;
  return `${fitLabel(name, optionNameLimit - suffix.length)}${suffix}`;
}

function labelCounts(labels: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}

export function buildJiraComponentOptions(candidates: readonly ComponentOptionCandidate[]): CustomFieldDefinition['options'] {
  const byId = new Map<string, ComponentOptionCandidate>();
  for (const { id, name, scope } of candidates) {
    const candidate = { id, name: name.toWellFormed().trim().normalize('NFC'), scope: scope.toWellFormed().trim().normalize('NFC') };
    const previous = byId.get(id);
    if (!previous || compareCandidates(candidate, previous) < 0) byId.set(id, candidate);
  }

  const rows = [...byId.values()].sort((left, right) => compareText(left.id, right.id)).map(({ id, name, scope }) => ({
    id, name: fitLabel(name || id, optionNameLimit), scope: fitLabel(scope, scopeLimit),
  }));
  const baseLabels = labelCounts(rows.map(row => row.name));
  const scopedLabels = new Map<string, string>();
  for (const { id, name, scope } of rows) {
    if (baseLabels.get(name) !== 1 && scope) scopedLabels.set(id, qualifiedLabel(name, scope));
  }
  const scopedCounts = labelCounts(scopedLabels.values());
  const used = new Set(baseLabels.keys());
  const qualified = new Map<string, string>();
  for (const [id, name] of scopedLabels) {
    if (scopedCounts.get(name) !== 1 || used.has(name)) continue;
    qualified.set(id, name);
    used.add(name);
  }

  const options = rows.map(({ id, name, scope }) => {
    if (baseLabels.get(name) === 1) return { id, name, archived: false };
    const scoped = qualified.get(id);
    if (scoped) return { id, name: scoped, archived: false };

    const qualifier = scope ? `${scope} · ${id}` : id;
    let label = qualifiedLabel(name, qualifier);
    // Literal Jira names can match a generated suffix, even one that includes the option ID.
    for (let number = 2; used.has(label); number++) label = qualifiedLabel(name, `${qualifier} (${number})`);
    used.add(label);
    return { id, name: label, archived: false };
  });
  return options.sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
}
