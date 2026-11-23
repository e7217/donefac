import { createHash } from 'node:crypto';

type MessageHeader = 'webhook-id' | 'idempotency-key';

/** GitLab sends the same retry-stable message ID under either header name. */
export function gitlabWebhookMessageDigest(headers: unknown, requireSignedId = false): string | null {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const values: Partial<Record<MessageHeader, string>> = {};
  for (const [key, rawValue] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name !== 'webhook-id' && name !== 'idempotency-key') continue;
    if (Object.hasOwn(values, name) || typeof rawValue !== 'string') return null;
    const value = rawValue.replace(/^[\t ]+|[\t ]+$/gu, '');
    // Reject comma-coalesced transport duplicates and preserve the ID's case.
    if (!value || value.length > 500 || /[^\x21-\x2b\x2d-\x7e]/u.test(value)) return null;
    values[name] = value;
  }
  const modern = values['webhook-id'];
  const legacy = values['idempotency-key'];
  if (modern && legacy && modern !== legacy) return null;
  const messageId = modern ?? (requireSignedId ? undefined : legacy);
  return messageId ? createHash('sha256').update('gitlab-webhook-message\0').update(messageId).digest('hex') : null;
}
