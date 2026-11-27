// The product was renamed from "Teamspace" to "Donefac". Data written before the rename
// (databases, backups, exports, browser drafts, environment) still carries the old name,
// so readers accept it and writers use only the new one.
export const LEGACY_PRODUCT_ID = 'teamspace';

/** Returns the current product id for a value written under the legacy name. */
export function currentProductId(value: unknown): unknown {
  return value === LEGACY_PRODUCT_ID ? 'donefac' : value;
}

/** Replaces a leading legacy product id, e.g. "teamspace-migration-mapping" → "donefac-migration-mapping". */
export function currentProductFormat(value: unknown): unknown {
  return typeof value === 'string' && value.startsWith(`${LEGACY_PRODUCT_ID}-`)
    ? `donefac-${value.slice(LEGACY_PRODUCT_ID.length + 1)}` : value;
}

/** Normalizes a stored or imported relation whose origin was written under the legacy name. */
export function withCurrentRelationOrigin<T extends { origin?: unknown }>(value: T): T {
  return value.origin === LEGACY_PRODUCT_ID ? { ...value, origin: 'donefac' } : value;
}
