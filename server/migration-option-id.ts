import { createHash } from 'node:crypto';

export function migrationOptionId(packageId: string, kind: string, value: string): string {
  const hash = createHash('sha256').update(JSON.stringify([packageId, kind, value])).digest('hex');
  return `option_${hash.slice(0, 40)}`;
}
