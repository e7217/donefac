import type { Attachment,AttachmentVersion,Comment,ConfluenceMigrationDocumentValues,DocPage,DocRevision,DocumentSiblingOrder,DocumentSourceSelection,Issue,IssueRelation,JiraMigrationIssueValues,LegacyDataset,LegacyPackageSummary,LegacyRecord,MigrationConfiguration,MigrationPreview,PlanningItem,Project,ProjectIssueSchema,ProjectWorkflow,ResourceLink,SourceImport,SourceRecordArchive,User,WorklogEntry } from '../shared/types.js';
import type { AtlassianLink } from '../shared/atlassian-links.js';
import type { JiraMigrationWorklogValues } from '../shared/types.js';
import type { MigrationRetainedResourceLinks } from './migration-retained-resource-links.js';

export interface MigrationPackage { summary:LegacyPackageSummary;dataset:LegacyDataset }
export interface MigrationJiraRefreshCandidate {
  issue: Issue;
  previous: { archive: SourceRecordArchive; stagingId: string; configuration: MigrationConfiguration;
    priorityOption?: Pick<LegacyRecord, 'sourceId' | 'title'> & { ambiguous?: boolean } };
  previousCustom?: MigrationJiraRefreshCandidate['previous'];
  initialParentId?: string | null;
}
export interface MigrationJiraIssueUpdate {
  issueId: string;
  expectedVersion: number;
  changes: JiraMigrationIssueValues;
  contentReview?: { recordId: string; title: string };
}
export interface MigrationConfluenceRefreshCandidate {
  document: DocPage;
  previous: SourceRecordArchive;
  previousTimezone: string;
  initialParentId?: string | null;
}
export interface MigrationConfluenceDocumentUpdate {
  documentId: string;
  expectedVersion: number;
  changes: ConfluenceMigrationDocumentValues;
  contentReview?: { recordId: string; title: string };
}
export interface MigrationConfluenceKnownAttachment {
  sourcePageId: string;
  sourceRootId: string;
  sourceId: string;
  sourceRevision: number | null;
  filename: string;
  documentId: string;
  version: AttachmentVersion | null;
  hasLocalVersions: boolean;
}
export interface MigrationConfluenceKnownHistory {
  kind: 'comment' | 'revision';
  sourceId: string;
  sourcePageId: string | null;
  documentId: string;
  sourceVersion: number | null;
}
export interface MigrationJiraWorklogCandidate {
  sourceId: string;
  originalRecordId: string;
  previousRecordId: string;
  current: Pick<WorklogEntry, 'id' | 'issueId' | 'projectId' | 'authorId' | 'workDate' | 'note' | 'version'> &
    { durationSeconds: number; deletedAt: string | null };
  previous: { updatedAt: string; workDate: string; durationSeconds: number; noteSha256: string } | null;
}
export interface MigrationJiraWorklogUpdate {
  id: string;
  issueId: string;
  projectId: string;
  expectedVersion: number;
  sourceRecordId: string;
  changes: JiraMigrationWorklogValues;
}
export interface MigrationAppendContext {
  project: Project;
  workflow: ProjectWorkflow;
  schema: ProjectIssueSchema;
  nextIssueNumber: number;
  token: string;
  planningItems?: PlanningItem[];
  planningToken?: string;
  cyclePlanningItems?: PlanningItem[];
  cyclePlanningToken?: string;
  knownIssues: { alias: string; issueId: string; projectId: string | null }[];
  movedOutIssueAliases?: string[];
  refreshIssues?: MigrationJiraRefreshCandidate[];
  hierarchyIssues?: Pick<Issue, 'id' | 'projectId' | 'parentId' | 'key' | 'title' | 'version'>[];
  hierarchyIssueAliases?: { alias: string; issueId: string }[];
  historyIssues?: Pick<Issue, 'id' | 'projectId' | 'key' | 'title'>[];
  knownHistory?: { kind: 'comment' | 'worklog'; sourceId: string; issueId: string }[];
  jiraWorklogCandidates?: MigrationJiraWorklogCandidate[];
  attachmentIssues?: Pick<Issue, 'id' | 'projectId'>[];
  knownAttachments?: { sourceId: string; issueId: string }[];
  relationRefresh?: {
    issues: (Pick<Issue, 'id' | 'projectId' | 'key' | 'title' | 'version'> & { projectName: string })[];
    provenAliases: { alias: string; issueId: string }[];
    active: IssueRelation[];
    previouslyApplied: { record: LegacyRecord; relationId: string }[];
    legacy: LegacyRecord[];
  };
}
export interface MigrationPageAppendContext {
  project: Project;
  sourceSpaceId: string;
  sourceSpaceKey?: string;
  labelListScope?: 'isolated' | 'mixed';
  token: string;
  sectionInventory?: boolean;
  knownPages: { sourceId: string; documentId: string; projectId: string | null; sourceSpaceId: string | null; sourceTitle: string;
    sourceClass?: string | null; sectionIds?: string[] }[];
  refreshDocuments?: MigrationConfluenceRefreshCandidate[];
  hierarchyDocuments?: Pick<DocPage, 'id' | 'parentId' | 'title' | 'version'>[];
  knownAttachments?: MigrationConfluenceKnownAttachment[];
  knownHistory?: MigrationConfluenceKnownHistory[];
  knownInlineCommentRoots?: { sourceId: string; sourcePageId: string; documentId: string; commentId: string }[];
  inlineCommentBodyHashes?: Record<string, string>;
}
export interface MigrationPlanningInput {
  id:string;configuration:MigrationConfiguration;actorId:string;users:User[];existingProjectKeys:string[];
  packages:MigrationPackage[];now:string;
  fileInfo?:Record<string,Record<string,{size:number;sha256:string;mimeType:string}>>;
  append?: MigrationAppendContext;
  appendPages?: MigrationPageAppendContext;
  retainedResourceLinks?: MigrationRetainedResourceLinks;
}
export interface MigrationFileCopy { fileId:string;packageId:string;path:string;size:number;sha256:string }
export interface PreparedMigration {
  preview:MigrationPreview;sourceImport:SourceImport;sourceRecords:SourceRecordArchive[];
  projects:Project[];workflows:ProjectWorkflow[];issueSchemas:ProjectIssueSchema[];
  planningItems?: PlanningItem[];
  issues:Issue[];documents:DocPage[];comments:Comment[];revisions:DocRevision[];worklogs:WorklogEntry[];
  documentOrders?: Omit<DocumentSiblingOrder, 'version'>[];
  attachments:Attachment[];attachmentVersions:AttachmentVersion[];fileCopies:MigrationFileCopy[];
  resourceLinks:ResourceLink[];issueRelations:IssueRelation[];
  atlassianLinks:Omit<AtlassianLink,'id'|'createdAt'>[];
  append?: { projectId: string; token: string; startIssueNumber: number; planningToken?: string; cyclePlanningToken?: string };
  appendPages?: { projectId: string; token: string; sectionInventory?: boolean; labelListInventory?: true };
  retainedResourceLinkToken?: string;
  issueUpdates?: MigrationJiraIssueUpdate[];
  jiraHistoryOwners?: string[];
  jiraWorklogUpdates?: MigrationJiraWorklogUpdate[];
  jiraAttachmentOwners?: string[];
  documentUpdates?: MigrationConfluenceDocumentUpdate[];
  confluenceAttachmentOwners?: string[];
  confluenceHistoryOwners?: string[];
  confluenceCommentAnchors?: { commentId: string; bodyHash: string; selection: DocumentSourceSelection }[];
  reusedAttachmentVersions?: AttachmentVersion[];
}
