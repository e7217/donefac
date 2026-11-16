import type { RichContent } from './types.js';

export const DOCUMENT_DIFF_LIMITS = { bytes: 8 * 1024 * 1024, titleBytes: 64 * 1024, nodes: 30_000, depth: 256, textChunk: 1024, myersWork: 250_000 } as const;
export interface DocumentDiffSource { title: string; content: RichContent }
export interface DocumentDiffUnit {
  kind: 'title' | 'node' | 'text';
  /** Paths describe the original position; they do not take part in matching. */
  path: string;
  depth: number;
  nodeType: string;
  text: string;
  metadata: string;
  signature: string;
}
export interface DocumentDiffRun { kind: 'equal' | 'delete' | 'insert'; before: DocumentDiffUnit[]; after: DocumentDiffUnit[] }
export interface DocumentDiffResult {
  runs: DocumentDiffRun[];
  identical: boolean;
  stats: { added: number; removed: number; unchanged: number; structuralAdded: number; structuralRemoved: number; textAdded: number; textRemoved: number };
  /** bytes counts serialized rich body only; title has a separate 64KiB cap. */
  before: { nodes: number; bytes: number };
  after: { nodes: number; bytes: number };
  /** Fallback still reports every source unit, but can show a larger changed span. */
  fallbackGaps: number;
  myersWork: number;
}
export class DocumentDiffError extends Error {
  constructor(public code: 'size' | 'nodes' | 'depth' | 'invalid', message: string) { super(message); }
}
const invalid = (message: string): never => { throw new DocumentDiffError('invalid', message); };
const encoder = new TextEncoder();
function textChunks(text: string): string[] {
  const result: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + DOCUMENT_DIFF_LIMITS.textChunk);
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end++;
    result.push(text.slice(start, end)); start = end;
  }
  return result;
}

/** Canonical JSON ignores object-key order, while retaining array order and values. */
function canonical(value: unknown, depth = 0, ancestors = new WeakSet<object>()): string {
  if (depth > DOCUMENT_DIFF_LIMITS.depth) throw new DocumentDiffError('depth', `구조 정보가 비교 깊이 한도 ${DOCUMENT_DIFF_LIMITS.depth}단계를 초과했습니다.`);
  if (value === null) return 'null';
  if (typeof value === 'string') { if (value.length > DOCUMENT_DIFF_LIMITS.bytes) throw new DocumentDiffError('size', '문서가 비교 크기 한도 8MiB를 초과했습니다.'); return JSON.stringify(value); }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : invalid('구조 정보에 유한하지 않은 숫자가 있습니다.');
  if (typeof value !== 'object' || !value) return invalid('구조 정보는 JSON 값이어야 합니다.');
  if (ancestors.has(value)) return invalid('문서 구조에 순환 참조가 있습니다.');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? `[${value.map(item => item === undefined ? 'null' : canonical(item, depth + 1, ancestors)).join(',')}]`
    : `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1, ancestors)}`).join(',')}}`;
  ancestors.delete(value);
  if (result.length > DOCUMENT_DIFF_LIMITS.bytes + 256) throw new DocumentDiffError('size', '문서가 비교 크기 한도 8MiB를 초과했습니다.');
  return result;
}

export function flattenDocumentForDiff(source: DocumentDiffSource): { units: DocumentDiffUnit[]; nodes: number; bytes: number } {
  if (!source || typeof source.title !== 'string' || !source.content || typeof source.content !== 'object') return invalid('비교할 문서의 제목과 본문 구조가 필요합니다.');
  if (source.title.length > DOCUMENT_DIFF_LIMITS.titleBytes || encoder.encode(source.title).length > DOCUMENT_DIFF_LIMITS.titleBytes) throw new DocumentDiffError('size', '제목이 비교 크기 한도 64KiB를 초과했습니다.');
  const units: DocumentDiffUnit[] = (source.title ? textChunks(source.title) : ['']).map((text, index) => ({ kind: 'title', path: `제목/${index + 1}`, depth: 0, nodeType: 'title', text, metadata: '', signature: `title:${text}` }));
  type Visit = { node: RichContent; path: string; depth: number; leave?: boolean };
  const pending: Visit[] = [{ node: source.content, path: '본문', depth: 0 }], ancestors = new WeakSet<object>();
  let nodes = 0, scheduledNodes = 1, byteFloor = 0;
  while (pending.length) {
    const entry = pending.pop()!, node = entry.node;
    if (entry.leave) { ancestors.delete(node); continue; }
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.type !== 'string') return invalid('본문 노드의 형식을 확인해 주세요.');
    if (++nodes > DOCUMENT_DIFF_LIMITS.nodes) throw new DocumentDiffError('nodes', `문서가 비교 노드 한도 ${DOCUMENT_DIFF_LIMITS.nodes.toLocaleString('ko-KR')}개를 초과했습니다.`);
    if (entry.depth > DOCUMENT_DIFF_LIMITS.depth) throw new DocumentDiffError('depth', `문서가 비교 깊이 한도 ${DOCUMENT_DIFF_LIMITS.depth}단계를 초과했습니다.`);
    if (ancestors.has(node)) return invalid('문서 구조에 순환 참조가 있습니다.');
    ancestors.add(node); pending.push({ ...entry, leave: true });
    if (node.content !== undefined && !Array.isArray(node.content)) return invalid('본문 노드의 하위 내용이 배열이 아닙니다.');
    if (node.text !== undefined && typeof node.text !== 'string') return invalid('본문의 텍스트 형식을 확인해 주세요.');
    if (node.text && node.text.length > DOCUMENT_DIFF_LIMITS.bytes) throw new DocumentDiffError('size', '문서가 비교 크기 한도 8MiB를 초과했습니다.');
    const properties = Object.fromEntries(Object.entries(node).filter(([key, value]) => key !== 'text' && key !== 'content' && value !== undefined));
    const metadata = canonical({ properties, shape: { hasContent: node.content !== undefined, hasText: node.text !== undefined, childCount: node.content?.length || 0 } });
    byteFloor += encoder.encode(metadata).length + (node.text ? encoder.encode(node.text).length : 0);
    // The structural wrapper adds fewer than 128 bytes per node. This early
    // bound prevents shared huge attributes from being expanded repeatedly.
    if (byteFloor > DOCUMENT_DIFF_LIMITS.bytes + DOCUMENT_DIFF_LIMITS.nodes * 128) throw new DocumentDiffError('size', '문서가 비교 크기 한도 8MiB를 초과했습니다.');
    units.push({ kind: 'node', path: entry.path, depth: entry.depth, nodeType: node.type, text: node.type, metadata, signature: `node:${entry.depth}:${metadata}` });
    if (node.text !== undefined) {
      for (const [chunk, text] of textChunks(node.text).entries()) {
        units.push({ kind: 'text', path: `${entry.path}/텍스트 ${chunk + 1}`, depth: entry.depth, nodeType: node.type, text, metadata: '', signature: `text:${entry.depth}:${text}` });
      }
    }
    scheduledNodes += node.content?.length || 0;
    if (scheduledNodes > DOCUMENT_DIFF_LIMITS.nodes) throw new DocumentDiffError('nodes', `문서가 비교 노드 한도 ${DOCUMENT_DIFF_LIMITS.nodes.toLocaleString('ko-KR')}개를 초과했습니다.`);
    for (let index = (node.content?.length || 0) - 1; index >= 0; index--) pending.push({ node: node.content![index], path: `${entry.path}/${index + 1}`, depth: entry.depth + 1 });
  }
  let serialized: string;
  try { serialized = JSON.stringify(source.content); }
  catch { return invalid('문서를 JSON 구조로 읽을 수 없습니다.'); }
  const bytes = encoder.encode(serialized).length;
  if (bytes > DOCUMENT_DIFF_LIMITS.bytes) throw new DocumentDiffError('size', '문서가 비교 크기 한도 8MiB를 초과했습니다.');
  return { units, nodes, bytes };
}

type Step = { kind: DocumentDiffRun['kind']; a?: number; b?: number };
type Budget = { work: number; fallbackGaps: number };
const same = (a: DocumentDiffUnit, b: DocumentDiffUnit) => a.signature === b.signature;

/** Unique signatures and a longest increasing subsequence give patience anchors. */
function anchors(a: DocumentDiffUnit[], b: DocumentDiffUnit[], aStart: number, aEnd: number, bStart: number, bEnd: number): [number, number][] {
  const left = new Map<string, number>(), right = new Map<string, number>();
  for (let index = aStart; index < aEnd; index++) left.set(a[index].signature, left.has(a[index].signature) ? -1 : index);
  for (let index = bStart; index < bEnd; index++) right.set(b[index].signature, right.has(b[index].signature) ? -1 : index);
  const pairs: [number, number][] = [];
  for (let index = aStart; index < aEnd; index++) { const key = a[index].signature, target = right.get(key); if (left.get(key) === index && target !== undefined && target >= 0) pairs.push([index, target]); }
  const tails: number[] = [], previous = Array<number>(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index++) {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >>> 1; if (pairs[tails[mid]][1] < pairs[index][1]) low = mid + 1; else high = mid; }
    if (low) previous[index] = tails[low - 1]; tails[low] = index;
  }
  const result: [number, number][] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) result.push(pairs[index]);
  return result.reverse();
}

/** A single global budget bounds every Myers diagonal and matching step. */
function myers(a: DocumentDiffUnit[], b: DocumentDiffUnit[], aStart: number, aEnd: number, bStart: number, bEnd: number, budget: Budget): Step[] | null {
  const n = aEnd - aStart, m = bEnd - bStart, trace: Map<number, number>[] = [], vector = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= n + m; distance++) {
    trace.push(new Map(vector));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (budget.work >= DOCUMENT_DIFF_LIMITS.myersWork) return null; budget.work++;
      const down = vector.get(diagonal + 1) ?? 0, right = vector.get(diagonal - 1) ?? 0;
      let x = diagonal === -distance || diagonal !== distance && right < down ? down : right + 1;
      let y = x - diagonal;
      while (x < n && y < m && same(a[aStart + x], b[bStart + y])) { if (budget.work >= DOCUMENT_DIFF_LIMITS.myersWork) return null; budget.work++; x++; y++; }
      vector.set(diagonal, x);
      if (x >= n && y >= m) {
        const steps: Step[] = []; let backX = n, backY = m;
        for (let d = trace.length - 1; d >= 0; d--) {
          const v = trace[d], k = backX - backY, previousK = k === -d || k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0) ? k + 1 : k - 1;
          const previousX = v.get(previousK) ?? 0, previousY = previousX - previousK;
          while (backX > previousX && backY > previousY) { steps.push({ kind: 'equal', a: aStart + --backX, b: bStart + --backY }); }
          if (!d) break;
          if (backX === previousX) steps.push({ kind: 'insert', b: bStart + --backY }); else steps.push({ kind: 'delete', a: aStart + --backX });
        }
        return steps.reverse();
      }
    }
  }
  return null;
}

export function diffDocuments(beforeSource: DocumentDiffSource, afterSource: DocumentDiffSource): DocumentDiffResult {
  const before = flattenDocumentForDiff(beforeSource), after = flattenDocumentForDiff(afterSource), a = before.units, b = after.units;
  const runs: DocumentDiffRun[] = [], budget: Budget = { work: 0, fallbackGaps: 0 };
  function emit(kind: DocumentDiffRun['kind'], left?: DocumentDiffUnit, right?: DocumentDiffUnit) { let last = runs.at(-1); if (!last || last.kind !== kind) { last = { kind, before: [], after: [] }; runs.push(last); } if (left) last.before.push(left); if (right) last.after.push(right); }
  function gap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    while (aStart < aEnd && bStart < bEnd && same(a[aStart], b[bStart])) emit('equal', a[aStart++], b[bStart++]);
    let suffix = 0;
    while (aStart < aEnd - suffix && bStart < bEnd - suffix && same(a[aEnd - suffix - 1], b[bEnd - suffix - 1])) suffix++;
    const leftEnd = aEnd - suffix, rightEnd = bEnd - suffix;
    if (aStart === leftEnd) { for (let index = bStart; index < rightEnd; index++) emit('insert', undefined, b[index]); }
    else if (bStart === rightEnd) { for (let index = aStart; index < leftEnd; index++) emit('delete', a[index]); }
    else {
      const steps = myers(a, b, aStart, leftEnd, bStart, rightEnd, budget);
      if (steps) for (const step of steps) emit(step.kind, step.a === undefined ? undefined : a[step.a], step.b === undefined ? undefined : b[step.b]);
      else { budget.fallbackGaps++; for (let index = aStart; index < leftEnd; index++) emit('delete', a[index]); for (let index = bStart; index < rightEnd; index++) emit('insert', undefined, b[index]); }
    }
    for (let index = 0; index < suffix; index++) emit('equal', a[leftEnd + index], b[rightEnd + index]);
  }
  let aStart = 0, bStart = 0, aEnd = a.length, bEnd = b.length;
  while (aStart < aEnd && bStart < bEnd && same(a[aStart], b[bStart])) emit('equal', a[aStart++], b[bStart++]);
  let suffix = 0;
  while (aStart < aEnd - suffix && bStart < bEnd - suffix && same(a[aEnd - suffix - 1], b[bEnd - suffix - 1])) suffix++;
  aEnd -= suffix; bEnd -= suffix;
  for (const [left, right] of anchors(a, b, aStart, aEnd, bStart, bEnd)) { gap(aStart, left, bStart, right); emit('equal', a[left], b[right]); aStart = left + 1; bStart = right + 1; }
  gap(aStart, aEnd, bStart, bEnd);
  for (let index = 0; index < suffix; index++) emit('equal', a[aEnd + index], b[bEnd + index]);
  const stats = { added: 0, removed: 0, unchanged: 0, structuralAdded: 0, structuralRemoved: 0, textAdded: 0, textRemoved: 0 };
  for (const run of runs) {
    if (run.kind === 'equal') stats.unchanged += run.before.length;
    else if (run.kind === 'insert') { stats.added += run.after.length; for (const unit of run.after) { if (unit.kind === 'node') stats.structuralAdded++; else stats.textAdded++; } }
    else { stats.removed += run.before.length; for (const unit of run.before) { if (unit.kind === 'node') stats.structuralRemoved++; else stats.textRemoved++; } }
  }
  return { runs, identical: stats.added === 0 && stats.removed === 0, stats, before: { nodes: before.nodes, bytes: before.bytes }, after: { nodes: after.nodes, bytes: after.bytes }, fallbackGaps: budget.fallbackGaps, myersWork: budget.work };
}
