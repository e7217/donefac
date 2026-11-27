import { createHash, type Hash } from 'node:crypto';
import type { SourceImport, SourceImportIntegrityPackage, SourceRecordArchive } from '../shared/types.js';

const RECORDS_DOMAIN = 'donefac.source-archive.records.v1\n';

class InvalidArchiveJson extends Error {}

// Object keys use JavaScript's default UTF-16 order; arrays and text retain their original order and characters.
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new InvalidArchiveJson('Archived JSON exceeds the nesting limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new InvalidArchiveJson('Archived values must be JSON.');
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1)}`).join(',')}}`;
}

function packageIdentity(sha256: string, source: SourceRecordArchive['source']): string {
  return canonicalJson([sha256, source]);
}

interface PackageDigest {
  stagingId: string;
  recordCount: number;
  boundAttachmentCount: number;
  hash: Hash;
}

export interface SourceArchiveMeasurement {
  packages: SourceImportIntegrityPackage[];
  unmatchedRecords: number;
  unmatchedBoundAttachments: number;
  columnMismatches: number;
}

/** Callers supply archived rows in binary archive ID order. Each row is consumed and released independently. */
export class SourceArchiveMeasurer {
  private readonly packages = new Map<string, PackageDigest>();
  private unmatchedRecords = 0;
  private unmatchedBoundAttachments = 0;
  private columnMismatches = 0;

  constructor(receipt: Pick<SourceImport, 'packages'>) {
    for (const item of receipt.packages) {
      this.packages.set(packageIdentity(item.sha256, item.source), {
        stagingId: item.stagingId, recordCount: 0, boundAttachmentCount: 0,
        hash: createHash('sha256').update(RECORDS_DOMAIN),
      });
    }
  }

  add(record: SourceRecordArchive | null, columnMismatch = false): void {
    if (columnMismatch) this.columnMismatches++;
    const boundAttachment = record?.targetType === 'attachment' && typeof record.targetId === 'string' && !!record.targetId;
    try {
      if (record) {
        const pkg = this.packages.get(packageIdentity(record.packageSha256, record.source));
        if (pkg) {
          pkg.hash.update(canonicalJson(record)).update('\n');
          pkg.recordCount++;
          if (boundAttachment) pkg.boundAttachmentCount++;
          return;
        }
      }
    } catch (error) {
      if (!(error instanceof InvalidArchiveJson)) throw error;
    }
    this.unmatchedRecords++;
    if (boundAttachment) this.unmatchedBoundAttachments++;
  }

  finish(): SourceArchiveMeasurement {
    return {
      packages: [...this.packages.values()].map(({ hash, ...item }) => ({ ...item, recordsSha256: hash.digest('hex') })),
      unmatchedRecords: this.unmatchedRecords, unmatchedBoundAttachments: this.unmatchedBoundAttachments,
      columnMismatches: this.columnMismatches,
    };
  }
}

export function measureIncomingArchive(receipt: SourceImport, records: SourceRecordArchive[]): SourceArchiveMeasurement {
  const digest = new SourceArchiveMeasurer(receipt);
  const ordered = records.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const record of ordered) digest.add(record);
  return digest.finish();
}
