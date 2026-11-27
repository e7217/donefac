import { LEGACY_PRODUCT_ID } from '../../shared/legacy-name';

/**
 * Moves browser-stored view settings and unsaved drafts written before the product rename
 * ("teamspace:…" / "teamspace.…") to the current key names. A key that already exists under
 * the current name wins, and the legacy copy is kept in that case so nothing is dropped.
 */
export function adoptLegacyBrowserStorage(storage: Storage) {
  const legacyKeys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && (key.startsWith(`${LEGACY_PRODUCT_ID}:`) || key.startsWith(`${LEGACY_PRODUCT_ID}.`))) legacyKeys.push(key);
  }
  for (const key of legacyKeys) {
    const value = storage.getItem(key);
    if (value === null) continue;
    const current = `donefac${key.slice(LEGACY_PRODUCT_ID.length)}`;
    if (storage.getItem(current) !== null) continue;
    storage.setItem(current, value);
    storage.removeItem(key);
  }
}

if (typeof window !== 'undefined') {
  for (const area of ['localStorage', 'sessionStorage'] as const) {
    try { adoptLegacyBrowserStorage(window[area]); }
    catch { /* Storage can be unavailable (private mode, quota); the app works without it. */ }
  }
}
