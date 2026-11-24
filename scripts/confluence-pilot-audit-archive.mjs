import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { LEGACY_MAX_RAW_BYTES } from '../server/legacy-import-archive.ts';
import { analyzeLegacyPackageBytes } from '../server/legacy-import-analysis.ts';

async function readArchive(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new Error('검토할 Confluence ZIP을 열 수 없습니다.');
  });
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(LEGACY_MAX_RAW_BYTES)) {
      throw new Error('Confluence ZIP은 64 MiB 이하의 비어 있지 않은 일반 파일이어야 합니다.');
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (offset !== bytes.length || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error('검토 중인 Confluence ZIP이 읽는 동안 바뀌었습니다.');
    }
    return bytes;
  } finally {
    await file.close();
  }
}

function isCurrentPage(row) {
  const status = row.metadata.contentStatus;
  return row.kind === 'page' && row.metadata.sourceClass === 'Page' &&
    (status === undefined || status === '' || typeof status === 'string' && status.trim().toLowerCase() === 'current');
}

async function analyzeConfluenceArchive(bytes) {
  const { dataset } = await analyzeLegacyPackageBytes({
    bytes, filename: 'confluence-export.zip', instanceKey: 'confluence-pilot-audit', product: 'auto',
  }).catch(() => {
    throw new Error('Confluence ZIP의 XML 구조와 첨부 항목을 분석할 수 없습니다.');
  });
  if (dataset.source.product !== 'confluence') throw new Error('Confluence 공간 XML 내보내기 ZIP을 입력해야 합니다.');
  return dataset;
}

export async function readConfluenceArchivePageIds(bytes) {
  const { records } = await analyzeConfluenceArchive(bytes);
  return new Set(records.filter(isCurrentPage).map(row => row.sourceId));
}

function sameHierarchy(row, expected, currentPages) {
  const ancestors = expected.ancestors;
  const declared = row.metadata.ancestorIds;
  // XML collections may omit the ancestors, but any included IDs must agree with the REST chain.
  if (Array.isArray(declared) && (new Set(declared).size !== declared.length ||
      declared.some(id => !ancestors.includes(id)))) return false;
  let parent = row.parentId;
  for (let index = ancestors.length - 1; index >= 0; index--) {
    if (parent !== ancestors[index]) return false;
    const archivedParent = currentPages.get(parent);
    if (!archivedParent) return true; // A requested page can be exported without all ancestors.
    if (archivedParent.containerId !== row.containerId) return false;
    parent = archivedParent.parentId;
  }
  return parent === null;
}

function validAttachmentBinary(row) {
  const { packagePath, size, fileSize } = row.metadata;
  if (typeof packagePath !== 'string' || typeof size !== 'number') return false;
  return fileSize === undefined || typeof fileSize === 'string' && /^\d+$/u.test(fileSize) && Number(fileSize) === size;
}

const permissionWarningCode = 'CONFLUENCE_SPACE_PERMISSION_REVIEW';
const restrictedCode = 'CONFLUENCE_RESTRICTED_CONTENT';
const unlinkedBinaryCode = 'CONFLUENCE_UNLINKED_ATTACHMENT_FILES';

export async function compareConfluenceArchive(archivePath, inventory, { addFinding, addPermissionCheckedPage } = {}) {
  const bytes = await readArchive(archivePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const dataset = await analyzeConfluenceArchive(bytes);
  const spaces = dataset.records.filter(row => row.kind === 'project' && row.metadata.sourceClass === 'Space');
  const matching = spaces.filter(row => row.metadata.spaceKey === inventory.spaceKey);
  if (matching.length !== 1) throw new Error('Confluence ZIP에서 요청한 공간을 하나로 확정할 수 없습니다.');

  const spaceId = matching[0].sourceId;
  if (inventory.spaceId && spaceId !== inventory.spaceId) throw new Error('Confluence ZIP과 현재 공간의 원본 ID가 일치하지 않습니다.');
  const spaceIds = new Set(spaces.map(row => row.sourceId));
  const current = dataset.records.filter(isCurrentPage);
  const currentPages = new Map(current.map(row => [row.sourceId, row]));
  const requested = inventory.requestedPageIds ?? inventory.pages;
  const archived = new Map();
  const scoped = new Set();
  let otherSpacePages = 0;
  let unassignedPages = 0;
  let outsideSelectionPages = 0;
  for (const row of current) {
    if (row.containerId !== spaceId) {
      if (spaceIds.has(row.containerId)) otherSpacePages++;
      else unassignedPages++;
      continue;
    }
    archived.set(row.sourceId, row);
    if (inventory.explicitSelection && !requested.has(row.sourceId)) outsideSelectionPages++;
    else scoped.add(row.sourceId);
  }

  let missingPages = 0;
  let matchedPages = 0;
  let permissionCheckedPages = 0;
  let versionMismatches = 0;
  let hierarchyMismatches = 0;
  let restrictionMismatches = 0;
  for (const [id, page] of inventory.pages) {
    const row = archived.get(id);
    if (!row) {
      missingPages++;
      addFinding?.(id, 'MISSING_FROM_ARCHIVE');
      continue;
    }
    matchedPages++;
    const version = row.metadata.version;
    if (typeof version !== 'string' || !/^\d+$/u.test(version) || Number(version) !== page.version) {
      versionMismatches++;
      addFinding?.(id, 'VERSION_MISMATCH');
    }
    if (!sameHierarchy(row, page, currentPages)) {
      hierarchyMismatches++;
      addFinding?.(id, 'HIERARCHY_MISMATCH');
    }
    if (page.restriction === 'clear' || page.restriction === 'restricted') {
      permissionCheckedPages++;
      addPermissionCheckedPage?.(id);
      if ((row.metadata.restricted === true) !== (page.restriction === 'restricted')) {
        restrictionMismatches++;
        addFinding?.(id, 'RESTRICTION_MISMATCH');
      }
    }
  }

  let archiveOnlyPages = 0;
  let archivedRestrictedPages = 0;
  let missingPageBodies = 0;
  for (const id of scoped) {
    const row = archived.get(id);
    if (!inventory.pages.has(id)) {
      archiveOnlyPages++;
      addFinding?.(id, 'ARCHIVE_ONLY_PAGE');
    }
    if (row.metadata.restricted === true) {
      archivedRestrictedPages++;
      addFinding?.(id, 'ARCHIVE_RESTRICTED');
    }
    if (row.metadata.bodyPresent !== true) {
      missingPageBodies++;
      addFinding?.(id, 'MISSING_ARCHIVE_BODY');
    }
  }

  const scopedAttachments = dataset.records.filter(row => row.kind === 'attachment' &&
    row.metadata.containerClass === 'Page' && scoped.has(row.containerId));
  let attachmentBinaries = 0;
  let attachmentEvidenceProblems = 0;
  for (const row of scopedAttachments) {
    if (typeof row.metadata.packagePath === 'string') attachmentBinaries++;
    if (!validAttachmentBinary(row)) {
      attachmentEvidenceProblems++;
      addFinding?.(row.containerId, 'ATTACHMENT_EVIDENCE_PROBLEM');
    }
  }
  const recordById = new Map(dataset.records.map(row => [row.id, row]));
  function hasOutOfScopePageOwner(item) {
    const row = recordById.get(item.recordId);
    if (!row) return false;
    const owner = isCurrentPage(row) ? row.sourceId : row.metadata.containerClass === 'Page' ? row.containerId : row.metadata.currentVersionId;
    return currentPages.has(owner) && !scoped.has(owner);
  }

  const keys = new Map();
  let analysisErrors = 0;
  let analysisWarnings = 0;
  let scopedAnalysisErrors = 0;
  let permissionWarnings = 0;
  let unlinkedAttachmentWarnings = 0;
  for (const item of dataset.diagnostics) {
    if (item.severity === 'error') {
      analysisErrors++;
      if (item.code !== restrictedCode || !hasOutOfScopePageOwner(item)) scopedAnalysisErrors++;
    } else if (item.severity === 'warning') analysisWarnings++;
    else continue;
    if (item.code === permissionWarningCode) permissionWarnings++;
    if (item.code === unlinkedBinaryCode) unlinkedAttachmentWarnings++;
    const key = `${item.severity}:${item.code}`;
    const entry = keys.get(key) ?? { severity: item.severity, code: item.code, count: 0 };
    entry.count++;
    keys.set(key, entry);
  }

  return {
    sha256, bytes: bytes.length, pages: archived.size, matchedPages, missingPages, archiveOnlyPages, outsideSelectionPages,
    totalCurrentPages: current.length, permissionCheckedPages,
    otherSpaces: spaces.length - 1, otherSpacePages, unassignedPages, versionMismatches, hierarchyMismatches, restrictionMismatches,
    archivedRestrictedPages, missingPageBodies, attachments: scopedAttachments.length, attachmentBinaries, attachmentEvidenceProblems,
    permissionWarnings, unlinkedAttachmentWarnings, analysisErrors, analysisWarnings,
    diagnostics: [...keys.values()].sort((a, b) => a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code)),
    needsReview: [missingPages, archiveOnlyPages, unassignedPages, versionMismatches, hierarchyMismatches, restrictionMismatches,
      archivedRestrictedPages, missingPageBodies, attachmentEvidenceProblems, permissionWarnings, unlinkedAttachmentWarnings, scopedAnalysisErrors]
      .some(count => count > 0),
  };
}
