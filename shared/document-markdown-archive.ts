export const MAX_MARKDOWN_ARCHIVE_BYTES = 64 * 1024 * 1024;

export type DocumentMarkdownArchiveFormat = 'teamspace' | 'docmost' | 'markdown';

export interface MarkdownArchiveHtmlNode {
  tag: string;
  attributes: Readonly<Record<string, string>>;
  children: readonly (MarkdownArchiveHtmlNode | string)[];
}

export interface DocumentMarkdownArchiveTarget {
  projectId: string | null;
  parentId: string | null;
}

export interface DocumentMarkdownArchivePage {
  path: string;
  parentPath: string | null;
  title: string;
  attachmentCount: number;
}

export interface DocumentMarkdownArchiveWarning {
  path: string;
  message: string;
}

export interface DocumentMarkdownArchivePreview extends DocumentMarkdownArchiveTarget {
  id: string;
  format: DocumentMarkdownArchiveFormat;
  expiresAt: string;
  pages: DocumentMarkdownArchivePage[];
  warnings: DocumentMarkdownArchiveWarning[];
  attachmentCount: number;
}

export interface DocumentMarkdownArchiveResult {
  documentIds: string[];
  rootIds: string[];
  attachmentCount: number;
  duplicate: boolean;
}
