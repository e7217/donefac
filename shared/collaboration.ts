import type { DocPage } from './types';

/** Persistent schema/version and transport contract shared by local clients and server. */
export const COLLABORATION_SCHEMA = 18;
export const COLLABORATION_BLOCK_ORDER_SCHEMA = 18;
export const COLLABORATION_CURSOR_PROTOCOL = 1;
export const MAX_COLLABORATION_CURSOR_BYTES = 256;
export type CollaborationSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | typeof COLLABORATION_SCHEMA;
export function supportsCollaborationSchema(version: unknown): version is CollaborationSchemaVersion {
  return typeof version === 'number' && Number.isInteger(version) && version >= 1 && version <= COLLABORATION_SCHEMA;
}
export interface CollaborationPeer { id: string; actorId: string; name: string; color: string }
/** Ephemeral Yjs relative positions, encoded as canonical base64. */
export interface CollaborationCursorSelection { anchor: string; head: string }
export interface CollaborationCursor { peerId: string; selection: CollaborationCursorSelection }
export interface CollaborationSession {
  enabled: boolean;
  epoch: string | null;
  schemaVersion: number;
  document: DocPage;
}
export type CollaborationClientMessage =
  | { type: 'hello'; epoch: string | null; schemaVersion: number; stateVector?: string; cursorProtocol?: typeof COLLABORATION_CURSOR_PROTOCOL }
  | { type: 'update'; epoch: string; requestId: string; update: string }
  | { type: 'cursor'; epoch: string; selection: CollaborationCursorSelection | null }
  | { type: 'ping' };
export type CollaborationServerMessage =
  | { type: 'welcome'; epoch: string; schemaVersion: number; update: string; stateVector: string; document: DocPage; peers: CollaborationPeer[]; cursorProtocol?: typeof COLLABORATION_CURSOR_PROTOCOL; peerId?: string; cursors?: CollaborationCursor[] }
  | { type: 'update'; epoch: string; update: string; document: DocPage }
  | { type: 'ack'; epoch: string; requestId: string; stateVector: string; document: DocPage }
  | { type: 'presence'; peers: CollaborationPeer[] }
  | { type: 'cursor'; epoch: string; peerId: string; selection: CollaborationCursorSelection | null }
  | { type: 'reset'; epoch: string; document: DocPage; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
