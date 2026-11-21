import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

const recordKinds = ['identity', 'project', 'issue', 'page', 'comment', 'revision', 'history', 'attachment', 'relation', 'field', 'option', 'workflow'];
const severityOrder = { error: 0, warning: 1, info: 2 };
const formats = new Set(['jira-backup-xml', 'jira-search-xml', 'jira-csv', 'jira-json', 'confluence-xml']);

function diagnosticGroups(dataset) {
  const groups = new Map();
  for (const diagnostic of dataset.diagnostics) {
    const severity = Object.hasOwn(severityOrder, diagnostic.severity) ? diagnostic.severity : 'error';
    const code = /^[A-Z][A-Z0-9_]{0,79}$/u.test(diagnostic.code) ? diagnostic.code : 'UNRECOGNIZED_CODE';
    const key = `${severity}:${code}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { severity, code, count: 1 });
  }
  return [...groups.values()].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.code.localeCompare(b.code));
}

function summarize({ dataset, files, expandedBytes }, requestedProduct, jiraHistory, isJiraWorklog, maxFileBytes) {
  const { source, records } = dataset;
  if (source.product !== requestedProduct || !formats.has(source.format)) return { status: 'blocked', failure: 'ANALYSIS_UNAVAILABLE' };
  const counts = Object.fromEntries(recordKinds.map(kind => [kind, 0]));
  const diagnostics = diagnosticGroups(dataset);
  const unsupported = { types: dataset.unsupported.length, objects: dataset.unsupported.reduce((sum, item) => sum + item.count, 0) };
  const authors = new Set(records.filter(record => record.kind === 'identity' && record.metadata.identityIncomplete !== true).map(record => record.sourceId));
  const recordIds = new Set(records.map(record => record.id));
  const filesByPath = new Map(files.map(file => [file.path, file]));
  const coverage = {
    metadata: { declaredVersionPresent: Boolean(source.declaredVersion), timezonePresent: Boolean(source.timezone) },
    authors: { exportedProfiles: authors.size, recordsWithAuthor: 0, unresolvedAuthors: 0 },
    references: { total: 0, unresolvedInPackage: 0 },
    attachments: { matched: 0, unconfirmed: 0, empty: 0, overUploadLimit: 0 },
    restrictions: { markedRecords: 0, spacePermissionRecords: 0 },
    ...(source.product === 'jira' ? { jira: { changeGroups: 0, statusChanges: 0, worklogs: 0 } } : { confluence: { pagesWithBody: 0, revisions: 0 } }),
  };
  for (const record of records) {
    if (Object.hasOwn(counts, record.kind)) counts[record.kind]++;
    if (record.authorId) {
      coverage.authors.recordsWithAuthor++;
      if (!authors.has(record.authorId)) coverage.authors.unresolvedAuthors++;
    }
    coverage.references.total += record.references.length;
    for (const reference of record.references) {
      if (!recordIds.has(`${reference.kind}:${reference.sourceId}`)) coverage.references.unresolvedInPackage++;
    }
    if (record.kind === 'attachment') {
      const file = filesByPath.get(record.metadata.packagePath || record.metadata.path);
      if (!file || file.sha256 !== record.metadata.sha256) coverage.attachments.unconfirmed++;
      else {
        coverage.attachments.matched++;
        if (!file.size) coverage.attachments.empty++;
        if (file.size > maxFileBytes) coverage.attachments.overUploadLimit++;
      }
    }
    if (coverage.jira) {
      if (record.kind === 'history') {
        if (isJiraWorklog(record)) coverage.jira.worklogs++;
        else if (Array.isArray(record.metadata.items)) {
          coverage.jira.changeGroups++;
          coverage.jira.statusChanges += jiraHistory.countJiraStatusTransitions(record);
        }
      }
      if (jiraHistory.isRestrictedJiraHistoryOwner(record) || jiraHistory.isRestrictedJiraHistory(record) ||
          jiraHistory.isRestrictedJiraStatusHistory(record) || jiraHistory.isRestrictedJiraAttachment(record)) coverage.restrictions.markedRecords++;
    } else {
      if (record.kind === 'page' && record.textFormat === 'confluence-storage') coverage.confluence.pagesWithBody++;
      if (record.kind === 'revision') coverage.confluence.revisions++;
      if (record.metadata.restricted === true) coverage.restrictions.markedRecords++;
      if (record.kind === 'relation' && record.metadata.sourceClass === 'SpacePermission') coverage.restrictions.spacePermissionRecords++;
    }
  }
  const review = diagnostics.some(group => group.severity === 'warning') || unsupported.objects > 0 ||
    coverage.authors.unresolvedAuthors > 0 || coverage.references.unresolvedInPackage > 0 ||
    coverage.attachments.unconfirmed > 0 || coverage.attachments.empty > 0 || coverage.attachments.overUploadLimit > 0 ||
    coverage.restrictions.markedRecords > 0 || coverage.restrictions.spacePermissionRecords > 0;
  const status = diagnostics.some(group => group.severity === 'error') ? 'blocked' : review ? 'review' : 'analyzed';
  return { status, analysis: { format: source.format, expandedBytes, fileCount: files.length, counts, diagnostics, unsupported, coverage } };
}

try {
  const { analyzeLegacyPackageBytes } = await tsImport('../server/legacy-import-analysis.ts', import.meta.url);
  const jiraHistory = await tsImport('../server/migration-jira-history.ts', import.meta.url);
  const { isJiraWorklog } = await tsImport('../server/migration-worklog.ts', import.meta.url);
  const { MAX_FILE_BYTES } = await tsImport('../server/attachments.ts', import.meta.url);
  const { bytes, filename, instanceKey, product } = workerData;
  const analysis = await analyzeLegacyPackageBytes({ bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), filename, instanceKey, product });
  parentPort.postMessage(summarize(analysis, product, jiraHistory, isJiraWorklog, MAX_FILE_BYTES));
} catch (error) {
  const status = error?.status;
  const failure = status === 413 ? 'ANALYSIS_LIMIT'
    : Number.isInteger(status) && status >= 400 && status < 500 ? 'ANALYSIS_REJECTED' : 'ANALYSIS_UNAVAILABLE';
  parentPort.postMessage({ status: 'blocked', failure });
} finally { parentPort.close(); }
