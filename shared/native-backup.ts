export const NATIVE_BACKUP_SCHEMA_VERSION = 48;

export function supportsNativeBackupVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= NATIVE_BACKUP_SCHEMA_VERSION;
}
