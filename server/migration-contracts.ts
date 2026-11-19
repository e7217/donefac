import type { Attachment,AttachmentVersion,Comment,DocPage,DocRevision,Issue,IssueRelation,LegacyDataset,LegacyPackageSummary,MigrationConfiguration,MigrationPreview,Project,ProjectIssueSchema,ProjectWorkflow,ResourceLink,SourceImport,SourceRecordArchive,User } from '../shared/types.js';

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
  issues:Issue[];documents:DocPage[];comments:Comment[];revisions:DocRevision[];
  attachments:Attachment[];attachmentVersions:AttachmentVersion[];fileCopies:MigrationFileCopy[];
  resourceLinks:ResourceLink[];issueRelations:IssueRelation[];
}
