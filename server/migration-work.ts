import { readFile } from 'node:fs/promises';
import { hash, sniffMime } from './attachments.js';
import { readLegacyArchive } from './legacy-import-archive.js';
import { LegacyImportError } from './legacy-import-model.js';
import type { MigrationPlanningInput, PreparedMigration } from './migration-contracts.js';
import type { AppendedFile } from './attachment-append.js';

export interface MigrationSourceFile {
  id: string;
  path: string;
  filename: string;
  sha256: string;
}
export type MigrationWork =
  | { action: 'preview'; sources: MigrationSourceFile[]; input: MigrationPlanningInput; restrictedConfluencePages?: ReadonlyMap<string, ReadonlySet<string>> }
  | { action: 'files'; sources: MigrationSourceFile[]; copies: PreparedMigration['fileCopies'] };

export async function runMigrationWork(work: MigrationWork): Promise<PreparedMigration | AppendedFile[]> {
  const info: NonNullable<MigrationPlanningInput['fileInfo']> = {};
  const files: AppendedFile[] = [];
  for (const source of work.sources) {
    let raw: Buffer;
    try { raw = await readFile(source.path); }
    catch { throw new LegacyImportError(409, '보관한 원본 파일을 읽을 수 없습니다. 원본을 다시 분석해 주세요.'); }
    if (hash(raw) !== source.sha256) throw new LegacyImportError(409, '보관한 원본 파일의 해시가 달라졌습니다.');
    const archive = await readLegacyArchive(raw, source.filename);
    if (work.action === 'preview') {
      info[source.id] = Object.fromEntries(archive.manifest.map(file => [
        file.path, { size: file.size, sha256: file.sha256, mimeType: sniffMime(archive.files.get(file.path)!) },
      ]));
    } else {
      for (const copy of work.copies.filter(copy => copy.packageId === source.id)) {
        const bytes = archive.files.get(copy.path);
        if (!bytes || bytes.length !== copy.size || hash(bytes) !== copy.sha256) {
          throw new LegacyImportError(409, '검토한 첨부 파일의 바이트 또는 해시가 달라졌습니다.');
        }
        // A ZIP member may share a large allocation with other entries. Send only the selected bytes.
        files.push({ id: copy.fileId, bytes: Buffer.from(bytes), sha256: copy.sha256, size: copy.size });
      }
    }
  }
  if (work.action === 'preview') {
    const { buildMigrationPlan } = await import('./migration-planner.js');
    return buildMigrationPlan({ ...work.input, fileInfo: info }, work.restrictedConfluencePages);
  }
  if (files.length !== work.copies.length) throw new LegacyImportError(409, '첨부 파일의 원본 패키지가 없습니다.');
  return files;
}
