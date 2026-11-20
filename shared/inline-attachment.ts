const inlineAttachmentUrl = /^\/api\/attachments\/([\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12})\/content\?inline=1$/;

export function inlineAttachmentIdFromUrl(src: unknown): string | undefined {
  return typeof src === 'string' ? inlineAttachmentUrl.exec(src)?.[1] : undefined;
}
