import * as Y from 'yjs';

export const COLLABORATION_BLOCK_ORDER_ROOT = 'block-order';
export const MAX_COLLABORATION_BLOCK_MOVES = 4096;
const MAX_ORDER_STRUCTS = MAX_COLLABORATION_BLOCK_MOVES * 8;

type Block = ReturnType<Y.XmlFragment['toArray']>[number];
type Side = 'before' | 'after';
type BlockMove = [blockId: string, side: Side, neighborId: string, fallbackId: string | null];
type BlockMoveLog = { moves: BlockMove[]; structs: number };

export class CollaborationBlockOrderError extends Error {}

export function collaborationBlockId(block: Block): string | null {
  if (!block.doc) return null;
  const id = Y.createRelativePositionFromTypeIndex(block, 0).type;
  const key = id ? `${id.client}:${id.clock}` : null;
  return isBlockId(key) ? key : null;
}

function isBlockId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,9}):(?:0|[1-9][0-9]{0,15})$/u.test(value)) return false;
  const [client, clock] = value.split(':').map(Number);
  return client <= 0xffff_ffff && Number.isSafeInteger(clock);
}

function isBlockMove(value: unknown): value is BlockMove {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [block, side, neighbor, fallback] = value;
  return isBlockId(block) && (side === 'before' || side === 'after') && isBlockId(neighbor) && block !== neighbor &&
    (fallback === null || isBlockId(fallback) && fallback !== block && fallback !== neighbor);
}

function readBlockMoves(doc: Y.Doc): BlockMoveLog {
  const shared = doc.share.get(COLLABORATION_BLOCK_ORDER_ROOT);
  if (!shared) return { moves: [], structs: 0 };
  // An update initially materializes named roots as AbstractType. Check the
  // stored item shape as well as the concrete kind assigned by the client.
  if ((shared.constructor !== Y.AbstractType && !(shared instanceof Y.Array)) || shared._map.size) {
    throw new CollaborationBlockOrderError('공동 편집 블록 순서 저장 형식을 확인해 주세요.');
  }
  const order = doc.getArray<unknown>(COLLABORATION_BLOCK_ORDER_ROOT);
  if (order.length > MAX_COLLABORATION_BLOCK_MOVES) {
    throw new CollaborationBlockOrderError('공동 편집 블록 이동 기록의 한도를 초과했습니다.');
  }

  const moves: BlockMove[] = [];
  let structs = 0;
  for (let item = order._start; item; item = item.right) {
    if (++structs > MAX_ORDER_STRUCTS) {
      throw new CollaborationBlockOrderError('공동 편집 블록 이동 기록의 한도를 초과했습니다.');
    }
    if (item.deleted && item.content instanceof Y.ContentDeleted) continue;
    if (!item.countable || !(item.content instanceof Y.ContentAny)) {
      throw new CollaborationBlockOrderError('공동 편집 블록 순서 항목을 확인해 주세요.');
    }
    if (item.deleted) continue;
    for (const value of item.content.getContent()) {
      if (!isBlockMove(value)) throw new CollaborationBlockOrderError('공동 편집 블록 이동 항목을 확인해 주세요.');
      moves.push(value);
    }
  }
  return { moves, structs };
}

export function validateCollaborationBlockOrder(doc: Y.Doc): void {
  readBlockMoves(doc);
}

type ListNode = { block: Block | null; previous: ListNode | null; next: ListNode | null };

function defaultBlockDocument(root: Y.XmlFragment): Y.Doc | null {
  const doc = root.doc;
  const shared: unknown = doc?.share.get('default');
  return shared === root ? doc : null;
}

function remainingPlacements({ moves, structs }: BlockMoveLog): number {
  return Math.min(MAX_COLLABORATION_BLOCK_MOVES - moves.length, MAX_ORDER_STRUCTS - structs);
}

/** Conservative number of further placements that can be recorded without compacting order history. */
export function collaborationBlockMoveCapacity(root: Y.XmlFragment): number {
  const doc = defaultBlockDocument(root);
  return doc ? remainingPlacements(readBlockMoves(doc)) : 0;
}

function referencedTombstones(doc: Y.Doc, root: Y.XmlFragment, moves: BlockMove[], live: ReadonlySet<string>) {
  const known = new Set<string>();
  const tombstones = new Map<Y.Item, { id: string; clock: number }[]>();
  const parent: unknown = root;
  for (const [block, , neighbor, fallback] of moves) {
    for (const id of [block, neighbor, fallback]) {
      if (!id || live.has(id) || known.has(id)) continue;
      known.add(id);
      const [client, clock] = id.split(':').map(Number);
      if (Y.getState(doc.store, client) <= clock) continue;
      const item = Y.getItem(doc.store, Y.createID(client, clock));
      if (!(item instanceof Y.Item) || !item.deleted || item.parent !== parent || item.parentSub !== null ||
          (!item.countable && !(item.content instanceof Y.ContentDeleted))) continue;
      const group = tombstones.get(item);
      if (group) group.push({ id, clock });
      else tombstones.set(item, [{ id, clock }]);
    }
  }
  return tombstones;
}

function projectBlocks(doc: Y.Doc, root: Y.XmlFragment, moves: BlockMove[]): readonly Block[] {
  const physical = root.toArray();
  if (!moves.length || physical.length < 2) return physical;

  const byId = new Map<string, ListNode>();
  const ids = physical.map(collaborationBlockId);
  const live = new Set(ids.filter((id): id is string => id !== null));
  let head: ListNode | null = null;
  let tail: ListNode | null = null;
  function append(block: Block | null, id: string | null) {
    const entry: ListNode = { block, previous: tail, next: null };
    if (tail) tail.next = entry;
    else head = entry;
    tail = entry;
    if (id) byId.set(id, entry);
  }
  const dead = referencedTombstones(doc, root, moves, live);
  // Retain referenced deleted items as invisible anchors while replaying. Yjs
  // can merge consecutive deleted items into one struct with a clock range.
  if (dead.size) {
    let offset = 0;
    for (let item = root._start; item; item = item.right) {
      if (item.deleted) {
        for (const { id } of dead.get(item)?.sort((a, b) => a.clock - b.clock) ?? []) append(null, id);
      } else if (item.countable) {
        const visibleCount = item.content.getContent().length;
        for (let index = 0; index < visibleCount; index++) {
          append(physical[offset], ids[offset]);
          offset++;
        }
      }
    }
  } else {
    physical.forEach((block, index) => append(block, ids[index]));
  }

  for (const [id, side, neighborId, fallbackId] of moves) {
    const entry = byId.get(id);
    const neighbor = byId.get(neighborId);
    const fallback = fallbackId ? byId.get(fallbackId) : undefined;
    const anchor: ListNode | null = neighbor ?? fallback ?? (fallbackId === null ? (side === 'before' ? head : tail) : null);
    if (!entry || !anchor || entry === anchor) continue;
    const after = fallback && !neighbor ? side === 'before' : side === 'after';
    if (entry.previous) entry.previous.next = entry.next;
    else head = entry.next;
    if (entry.next) entry.next.previous = entry.previous;
    else tail = entry.previous;

    entry.previous = after ? anchor : anchor.previous;
    entry.next = after ? anchor.next : anchor;
    if (entry.previous) entry.previous.next = entry;
    else head = entry;
    if (entry.next) entry.next.previous = entry;
    else tail = entry;
  }

  const order: Block[] = [];
  for (let entry: ListNode | null = head; entry; entry = entry.next) if (entry.block) order.push(entry.block);
  return order;
}

export function projectCollaborationBlocks(root: Y.XmlFragment): readonly Block[] {
  const doc = defaultBlockDocument(root);
  return doc ? projectBlocks(doc, root, readBlockMoves(doc).moves) : root.toArray();
}

/** Insert one move into the same Yjs update as any other local edit. */
export function moveCollaborationBlock(root: Y.XmlFragment, blockId: string, neighborId: string, side: Side, origin?: unknown): boolean {
  const doc = defaultBlockDocument(root);
  if (!doc || blockId === neighborId) return false;
  const log = readBlockMoves(doc);
  if (!remainingPlacements(log)) return false;
  const current = projectBlocks(doc, root, log.moves).map(collaborationBlockId);
  const from = current.indexOf(blockId), neighbor = current.indexOf(neighborId);
  if (from < 0 || neighbor < 0 || from === neighbor + (side === 'before' ? -1 : 1)) return false;

  const order = doc.getArray<BlockMove>(COLLABORATION_BLOCK_ORDER_ROOT);
  current.splice(from, 1);
  const to = current.indexOf(neighborId);
  const fallback = current[to + (side === 'before' ? -1 : 1)] ?? null;
  doc.transact(() => order.push([[blockId, side, neighborId, fallback]]), origin);
  return true;
}
