import type { Attachment,AttachmentVersion,Comment,DocPage,DocRevision,Issue,IssueRelation,LegacyDataset,LegacyPackageSummary,MigrationConfiguration,MigrationPreview,Project,ProjectIssueSchema,ProjectWorkflow,ResourceLink,SourceImport,SourceRecordArchive,User,WorklogEntry } from '../shared/types.js';
import type { AtlassianLink } from '../shared/atlassian-links.js';

export interface MigrationPackage { summary:LegacyPackageSummary;dataset:LegacyDataset }
export interface MigrationPlanningInput {
  id:string;configuration:MigrationConfiguration;actorId:string;users:User[];existingProjectKeys:string[];
  packages:MigrationPackage[];now:string;
  fileInfo?:Record<string,Record<string,{size:number;sha256:string;mimeType:string}>>;
}
export interface MigrationFileCopy { fileId:string;packageId:string;path:string;size:number;sha256:string }
export interface PreparedMigration {
  preview:MigrationPreview;sourceImport:SourceImport;sourceRecords:SourceRecordArchive[];
  projects:Project[];workflows:ProjectWorkflow[];issueSchemas:ProjectIssueSchema[];
  issues:Issue[];documents:DocPage[];comments:Comment[];revisions:DocRevision[];worklogs:WorklogEntry[];
  attachments:Attachment[];attachmentVersions:AttachmentVersion[];fileCopies:MigrationFileCopy[];
  resourceLinks:ResourceLink[];issueRelations:IssueRelation[];
  atlassianLinks:Omit<AtlassianLink,'id'|'createdAt'>[];
}
