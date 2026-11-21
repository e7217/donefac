import type { DocPage } from './types';

/** Persistent schema/version and transport contract shared by local clients and server. */
export const COLLABORATION_SCHEMA = 10;
export const COLLABORATION_CURSOR_PROTOCOL = 1;
export const MAX_COLLABORATION_CURSOR_BYTES = 256;
export type CollaborationSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | typeof COLLABORATION_SCHEMA;
export function supportsCollaborationSchema(version: unknown): version is CollaborationSchemaVersion {
  return version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6 || version === 7 || version === 8 || version === 9 || version === COLLABORATION_SCHEMA;
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
