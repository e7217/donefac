import { measureIncomingArchive } from '../../server/source-archive-integrity.js';
import type { SourceImport, SourceRecordArchive } from '../../shared/types.js';

interface MigrationBackupFixture {
  schemaVersion: number;
  sourceImports?: SourceImport[];
  sourceRecords?: SourceRecordArchive[];
}

export function historicalMigrationBackup<T extends MigrationBackupFixture>(current: T, schemaVersion: number): T {
  const backup = structuredClone(current);
  backup.schemaVersion = schemaVersion;
  const records = backup.sourceRecords ?? [];
  for (const record of records) delete record.authorAttribution;
  for (const receipt of backup.sourceImports ?? []) {
    if (!receipt.authorAttributionVersion) continue;
    delete receipt.authorAttributionVersion;
    if (receipt.integrity) {
      const previous = records.filter(record => record.sourceImportId === receipt.id);
      receipt.integrity.packages = measureIncomingArchive(receipt, previous).packages;
    }
  }
  return backup;
}
