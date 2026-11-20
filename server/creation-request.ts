import { createHash } from 'node:crypto';

export const creationRequestId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function creationRequestFingerprint(input: Record<string, unknown>): string {
  // The actor is resolved and checked separately from the submitted payload.
  const payload = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'requestId' && key !== 'actorId'));
  const canonical = JSON.stringify(payload, (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : value);
  return createHash('sha256').update(canonical).digest('hex');
}
