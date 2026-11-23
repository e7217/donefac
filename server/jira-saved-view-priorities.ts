import type { JiraViewSourceAlias } from '../shared/jira-view-query.js';
import { PRIORITY, type Issue, type LegacyRecord, type SourceRecordArchive } from '../shared/types.js';
import { jiraFieldDigest, jiraSourceFieldHashes, jiraSourcePriorityRaw, recognizedJiraPriority } from './migration-planner.js';
import type { Store } from './store.js';

type Priority = Issue['priority'];
type Option = Pick<LegacyRecord, 'title' | 'metadata'>;
type Observation = { id?: string; label?: string; priority: Priority | null; accepted: boolean; checkpointPriority?: Priority; time: number };
const priorityDigests = new Map(Object.keys(PRIORITY).map(key => [jiraFieldDigest('priority', key), key as Priority]));

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}

function sourcePriority(archive: SourceRecordArchive, original: boolean, time: number,
  readOption: (sourceId: string) => Option | undefined): Observation | undefined {
  const row = archive.record;
  const raw = jiraSourcePriorityRaw(row);
  if (raw === undefined && row.metadata.jiraPriorityAmbiguous !== true) return;
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const inline = text(object.name || object.text) || text(raw);
  const number = text(object.id) || text(raw);
  const id = /^[1-9]\d{0,19}$/u.test(number) ? number : undefined;
  const key = id && `builtin:priority:${id}`;
  const option = key && row.references.some(ref => ref.kind === 'option' && ref.relation === 'priority' && ref.sourceId === key)
    ? readOption(key) : undefined;
  const rawLabel = inline === id ? '' : inline;
  const label = rawLabel || (option && text(option.title) !== id ? text(option.title) : '');
  const ambiguous = row.metadata.jiraPriorityAmbiguous === true || !rawLabel && option?.metadata.jiraPriorityAmbiguous === true;
  const priority = !ambiguous && label ? recognizedJiraPriority(label) : null;
  const recorded = archive.jiraIssueFieldHashes?.priority;
  const links = archive.jiraIssueSourceFieldHashes?.priority;
  const sourceHashes = jiraSourceFieldHashes('priority', row);
  const verifiedSource = original || links?.length === sourceHashes.length && sourceHashes.every((hash, index) => links[index] === hash);
  // The oldest receipts predate option lookup and used the inline label or the default medium.
  const accepted = priority !== null && verifiedSource && (recorded === undefined
    ? original && priority === (recognizedJiraPriority(rawLabel) ?? 'medium')
    : recorded === jiraFieldDigest('priority', priority));
  const checkpointPriority = !original && id && verifiedSource && !ambiguous && recorded ? priorityDigests.get(recorded) : undefined;
  return { ...(id ? { id } : {}), ...(label && !ambiguous ? { label } : {}), priority, accepted, checkpointPriority, time };
}

function add<T>(index: Map<string, Set<T>>, key: string, value: T) {
  const values = index.get(key) ?? new Set<T>();
  values.add(value);
  index.set(key, values);
}

/** Check whether the observed Jira values still partition the live imported issues into native priority buckets. */
export function jiraSavedViewPriorities(store: Store, projectId: string) {
  const rows = store.db.prepare(`SELECT DISTINCT issue.id, json_extract(issue.json, '$.priority') AS priority
    FROM issues AS issue JOIN source_bindings AS binding ON binding.target_id=issue.id
    WHERE issue.project_id=? AND binding.product='jira' AND binding.kind='issue' AND binding.target_type='issue'`)
    .all(projectId) as { id: string; priority: Priority }[];
  const observations = new Map<string, Observation[]>();

  function observe(archive: SourceRecordArchive, original: boolean, createdAt: string, readOption: (id: string) => Option | undefined) {
    if (!archive.targetId) return;
    const time = Date.parse(createdAt);
    if (!Number.isFinite(time)) return;
    const observation = sourcePriority(archive, original, time, readOption);
    if (!observation) return;
    const history = observations.get(archive.targetId) ?? [];
    history.push(observation);
    observations.set(archive.targetId, history);
  }

  function prepare() {
    const identity = ({ id, label }: Observation) => id ? `id:${id}` : label ? `label:${label.toLowerCase()}` : null;
    const byAlias = new Map<string, Set<string>>();
    const observedTargets = new Map<string, Set<Priority>>();
    const currentTargets = new Map<string, Set<Priority>>();
    const byTarget = new Map<Priority, Set<string>>();
    const blockedTargets = new Set<Priority>();
    for (const row of rows) {
      const history = observations.get(row.id) ?? [];
      const firstAccepted = new Map<string, number>();
      for (const { id, accepted, priority, time } of history) {
        if (!id || !accepted || !priority) continue;
        const key = `${id}:${priority}`;
        firstAccepted.set(key, Math.min(time, firstAccepted.get(key) ?? Infinity));
      }
      let latestTime = -Infinity;
      let latest: Observation[] = [];
      for (const observed of history) {
        const { id, checkpointPriority, time } = observed;
        // Renaming a stable Jira option can leave the previously imported native level intact.
        const prior = id && checkpointPriority ? firstAccepted.get(`${id}:${checkpointPriority}`) : undefined;
        const item = !observed.accepted && checkpointPriority && prior !== undefined && prior < time
          ? { ...observed, priority: checkpointPriority, accepted: true } : observed;
        const source = identity(item);
        if (source) {
          if (item.id) add(byAlias, item.id, source);
          if (item.label) add(byAlias, item.label.toLowerCase(), source);
          if (item.priority) add(observedTargets, source, item.priority);
        }
        if (item.time > latestTime) {
          latestTime = item.time;
          latest = [item];
        } else if (item.time === latestTime) latest.push(item);
      }
      const [first] = latest;
      const source = first && identity(first);
      for (const item of latest) {
        const id = identity(item);
        if (id && item.priority) add(currentTargets, id, item.priority);
      }
      if (!source || latest.some(item => identity(item) !== source || !item.accepted || item.priority !== row.priority)) {
        blockedTargets.add(row.priority);
        for (const item of latest) if (item.priority) blockedTargets.add(item.priority);
      }
    }
    const bySource = new Map([...observedTargets, ...currentTargets]);
    for (const [source, targets] of bySource) for (const target of targets) add(byTarget, target, source);
    return {
      blockedTargets,
      resolve(value: string): JiraViewSourceAlias {
        const key = value.toLowerCase();
        const sources = byAlias.get(key);
        if (!sources) return { kind: 'unmapped' };
        const labelId = `label:${key}`;
        const numericSources = [...sources].filter(id => id !== labelId);
        if (numericSources.length > 1) return { kind: 'ambiguous' };
        const sourceId = numericSources[0] ?? labelId;
        const targets = bySource.get(sourceId);
        if (!targets) return { kind: 'unmapped' };
        if (targets.size !== 1) return { kind: 'ambiguous' };
        const [targetId] = targets;
        const sameName = sourceId !== labelId && sources.has(labelId);
        const labelTargets = sameName ? bySource.get(labelId) : undefined;
        if (sameName && (/^\d+$/u.test(key) || labelTargets?.size !== 1 || !labelTargets.has(targetId))) return { kind: 'ambiguous' };
        return { kind: 'mapped', sourceId, targetId, targetSourceIds: [...byTarget.get(targetId)!].sort(),
          ...(sameName ? { sameNameSourceIds: [labelId] } : {}) };
      },
    };
  }

  return { observe, prepare };
}
