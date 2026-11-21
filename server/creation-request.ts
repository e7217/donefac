import { createHash } from 'node:crypto';

export const creationRequestId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function deterministicCreationId(parts: readonly string[]): string {
  // UUIDv8 keeps a restored resource identifiable after native import clears its receipt.
  const bytes = createHash('sha256').update(JSON.stringify(parts)).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function creationRequestFingerprint(input: Record<string, unknown>): string {
  // The actor is resolved and checked separately from the submitted payload.
  const payload = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'requestId' && key !== 'actorId'));
  const canonical = JSON.stringify(payload, (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : value);
  return createHash('sha256').update(canonical).digest('hex');
}
