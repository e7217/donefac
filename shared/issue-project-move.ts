import type { CustomFieldValue, Issue } from './types.js';

export interface IssueProjectMoveMapping {
  issueId: string;
  type?: string;
  status?: string;
  customFields?: Record<string, CustomFieldValue>;
  cycleId?: string | null;
  moduleId?: string | null;
  releaseId?: string | null;
}

export interface IssueProjectMoveInput {
  expectedVersion: number;
  projectId: string;
  includeConnected: boolean;
  mappings: IssueProjectMoveMapping[];
}

export interface IssueProjectMoveNotice {
  code: string;
  message: string;
  issueId?: string;
}

export interface IssueProjectMovePreview {
  issueId: string;
  sourceProjectId: string;
  projectId: string;
  issues: { id: string; key: string; title: string; version: number; targetKey: string; mapping: IssueProjectMoveMapping }[];
  blockers: IssueProjectMoveNotice[];
  warnings: IssueProjectMoveNotice[];
  token: string | null;
}

export interface IssueProjectMoveResult {
  issues: Issue[];
  duplicate: boolean;
}
