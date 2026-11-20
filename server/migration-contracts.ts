import type { Attachment,AttachmentVersion,Comment,DocPage,DocRevision,Issue,IssueRelation,JiraMigrationIssueValues,LegacyDataset,LegacyPackageSummary,MigrationConfiguration,MigrationPreview,Project,ProjectIssueSchema,ProjectWorkflow,ResourceLink,SourceImport,SourceRecordArchive,User,WorklogEntry } from '../shared/types.js';
import type { AtlassianLink } from '../shared/atlassian-links.js';

export interface MigrationPackage { summary:LegacyPackageSummary;dataset:LegacyDataset }
export interface MigrationJiraRefreshCandidate {
  issue: Issue;
  previous: { archive: SourceRecordArchive; stagingId: string; configuration: MigrationConfiguration };
}
export interface MigrationJiraIssueUpdate {
  issueId: string;
  expectedVersion: number;
  changes: JiraMigrationIssueValues;
}
export interface MigrationAppendContext {
  project: Project;
  workflow: ProjectWorkflow;
  schema: ProjectIssueSchema;
  nextIssueNumber: number;
  token: string;
  knownIssues: { alias: string; issueId: string; projectId: string | null }[];
  refreshIssues?: MigrationJiraRefreshCandidate[];
}
export interface MigrationPageAppendContext {
  project: Project;
  sourceSpaceId: string;
  sourceSpaceKey?: string;
  token: string;
  knownPages: { sourceId: string; documentId: string; projectId: string | null; sourceSpaceId: string | null; sourceTitle: string }[];
}
export interface MigrationPlanningInput {
  id:string;configuration:MigrationConfiguration;actorId:string;users:User[];existingProjectKeys:string[];
  packages:MigrationPackage[];now:string;
  fileInfo?:Record<string,Record<string,{size:number;sha256:string;mimeType:string}>>;
  append?: MigrationAppendContext;
  appendPages?: MigrationPageAppendContext;
}
export interface MigrationFileCopy { fileId:string;packageId:string;path:string;size:number;sha256:string }
export interface PreparedMigration {
  preview:MigrationPreview;sourceImport:SourceImport;sourceRecords:SourceRecordArchive[];
  projects:Project[];workflows:ProjectWorkflow[];issueSchemas:ProjectIssueSchema[];
  issues:Issue[];documents:DocPage[];comments:Comment[];revisions:DocRevision[];worklogs:WorklogEntry[];
  attachments:Attachment[];attachmentVersions:AttachmentVersion[];fileCopies:MigrationFileCopy[];
  resourceLinks:ResourceLink[];issueRelations:IssueRelation[];
  atlassianLinks:Omit<AtlassianLink,'id'|'createdAt'>[];
  append?: { projectId: string; token: string; startIssueNumber: number };
  appendPages?: { projectId: string; token: string };
  issueUpdates?: MigrationJiraIssueUpdate[];
}
