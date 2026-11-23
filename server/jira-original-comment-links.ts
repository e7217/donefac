import type { StatementSync } from 'node:sqlite';
import type { Comment, IssueCommentView, JiraOriginalCommentLinksResult, SourceImport, SourceRecordArchive } from '../shared/types.js';
import { extractJiraOriginalCommentLinks } from './migration-content.js';
import { isRestrictedJiraHistory, isRestrictedJiraHistoryOwner, jiraHistoryOwnerAliases } from './migration-jira-history.js';
import type { SourcePreservationService } from './source-preservation.js';
import type { Store } from './store.js';

type ArchiveRow = { json: string };

export class JiraOriginalCommentLinks {
  private readonly candidates: StatementSync;
  private readonly byComment: StatementSync;

  constructor(private readonly store: Store, private readonly sources: SourcePreservationService) {
    // Discover candidate rows without pulling archived comment bodies into the issue comment list.
    this.candidates = store.db.prepare(`SELECT json_set(archive.json, '$.record.text', '') AS json
      FROM source_records AS archive JOIN comments AS live ON live.id=archive.target_id
        AND live.resource_type='issue' AND live.resource_id=archive.owner_id
      WHERE archive.owner_type='issue' AND archive.owner_id=? AND archive.kind='comment'
        AND archive.target_type='comment' AND archive.product='jira'
        AND json_extract(archive.json,'$.excluded') IS NOT 1
        AND (
          instr(lower(json_extract(archive.json,'$.record.text')), 'http')>0
          OR json_extract(archive.json,'$.record.textFormat')='adf'
            AND instr(json_extract(archive.json,'$.record.text'), '"link"')>0
          OR json_extract(archive.json,'$.record.metadata.bodyFormat')='search-rendered-html'
            AND instr(lower(json_extract(archive.json,'$.record.text')), 'href')>0
        )
        AND NOT EXISTS (SELECT 1 FROM source_records AS other
          WHERE other.target_type='comment' AND other.target_id=archive.target_id AND other.id<>archive.id)`);
    this.byComment = store.db.prepare(`SELECT json FROM source_records
      WHERE target_type='comment' AND target_id=? LIMIT 2`);
  }

  list(issueId: string, comments: Comment[]): IssueCommentView[] {
    const candidateIds = new Set<string>();
    const ownerEvidence = new Map<string, boolean>();
    for (const row of this.candidates.iterate(issueId) as Iterable<ArchiveRow>) {
      const archive = JSON.parse(row.json) as SourceRecordArchive;
      if (archive.targetId && this.verified(archive, issueId, ownerEvidence)) candidateIds.add(archive.targetId);
    }
    return comments.map(comment => ({ ...comment, jiraOriginalLinksAvailable: candidateIds.has(comment.id) ? true : undefined }));
  }

  read(comment: Comment): JiraOriginalCommentLinksResult | null {
    if (comment.resourceType !== 'issue') return null;
    const rows = this.byComment.all(comment.id) as ArchiveRow[];
    if (rows.length !== 1) return null;
    const archive = JSON.parse(rows[0].json) as SourceRecordArchive;
    if (archive.targetId !== comment.id || !this.verified(archive, comment.resourceId, new Map())) return null;
    return extractJiraOriginalCommentLinks(archive.record);
  }

  private verified(archive: SourceRecordArchive, issueId: string, ownerEvidence: Map<string, boolean>): boolean {
    if (archive.source.product !== 'jira' || archive.record.kind !== 'comment' || archive.targetType !== 'comment' ||
        archive.ownerType !== 'issue' || archive.ownerId !== issueId || !archive.targetProjectId ||
        archive.excluded || isRestrictedJiraHistory(archive.record)) return false;

    const receipt = this.store.get<SourceImport>('source_imports', archive.sourceImportId);
    const { instanceKey, format } = archive.source;
    if (!receipt?.projectIds.includes(archive.targetProjectId) || receipt.packages.filter(pack => pack.sha256 === archive.packageSha256 &&
        pack.source.instanceKey === instanceKey && pack.source.format === format && pack.source.product === 'jira').length !== 1) return false;

    const aliases = jiraHistoryOwnerAliases(archive.record);
    if (!aliases) return false;
    const key = JSON.stringify([instanceKey, archive.targetProjectId, aliases.sort()]);
    const cached = ownerEvidence.get(key);
    if (cached !== undefined) return cached;

    // Compare the stable Jira owner bindings against the archived project.
    const origins = this.sources.jiraIssueOrigins(instanceKey, aliases, 'alias');
    const known = new Set(origins.map(origin => origin.alias));
    const ownerIds = new Set(origins.map(origin => origin.archiveId));
    const verified = aliases.every(alias => known.has(alias)) && origins.every(origin =>
      origin.issueId === issueId && origin.projectId === archive.targetProjectId) && [...ownerIds].every(id => {
      const owner = this.store.get<SourceRecordArchive>('source_records', id);
      return owner?.record.kind === 'issue' && !owner.excluded && owner.record.metadata.restricted !== true &&
        !isRestrictedJiraHistoryOwner(owner.record);
    });
    ownerEvidence.set(key, verified);
    return verified;
  }
}
