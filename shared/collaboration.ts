import type { DocPage } from './types';

/** Persistent schema/version and transport contract shared by local clients and server. */
export const COLLABORATION_SCHEMA = 2;
export interface CollaborationPeer { id: string; actorId: string; name: string; color: string }
export interface CollaborationSession {
  enabled: boolean;
  epoch: string | null;
  schemaVersion: number;
  document: DocPage;
}
export type CollaborationClientMessage =
  | { type: 'hello'; epoch: string | null; schemaVersion: number; stateVector?: string }
  | { type: 'update'; epoch: string; requestId: string; update: string }
  | { type: 'ping' };
export type CollaborationServerMessage =
  | { type: 'welcome'; epoch: string; schemaVersion: number; update: string; stateVector: string; document: DocPage; peers: CollaborationPeer[] }
  | { type: 'update'; epoch: string; update: string; document: DocPage }
  | { type: 'ack'; epoch: string; requestId: string; stateVector: string; document: DocPage }
  | { type: 'presence'; peers: CollaborationPeer[] }
  | { type: 'reset'; epoch: string; document: DocPage; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
