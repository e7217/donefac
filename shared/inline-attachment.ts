const inlineAttachmentUrl = /^\/api\/attachments\/([\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12})\/content\?inline=1$/;
const attachmentDownloadUrl = /^\/api\/(?:attachments\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/content|attachment-versions\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/download)$/iu;

export function inlineAttachmentIdFromUrl(src: unknown): string | undefined {
  return typeof src === 'string' ? inlineAttachmentUrl.exec(src)?.[1] : undefined;
}

export function attachmentDownloadIdFromUrl(href: unknown): string | undefined {
  const match = typeof href === 'string' ? attachmentDownloadUrl.exec(href) : null;
  return match?.[1] ?? match?.[2];
}
