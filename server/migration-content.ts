import { XMLParser } from 'fast-xml-parser';
import { isCalendarDate } from '../shared/calendar.js';
import { parseConfluenceJiraList } from '../shared/confluence-jira-list.js';
import {
  isCalloutVariant, MAX_CALLOUT_TITLE_LENGTH, MAX_DOCUMENT_TABLE_SPAN, MAX_STATUS_BADGE_LABEL_LENGTH,
  type CalloutVariant, type StatusBadgeTone,
} from '../shared/document-nodes.js';
import type { LegacyRecord, RichContent } from '../shared/types.js';
import { MAX_DOCUMENT_CHILD_LIST_DEPTH, MAX_DOCUMENT_CHILD_LIST_FIRST, normalizeDocumentChildListOptions } from '../shared/document-child-list.js';
import { documentSectionHash, isDocumentSectionId } from '../shared/document-sections.js';
import { normalizeDocumentLabelListOptions } from '../shared/document-label-list.js';
import { MAX_DOCUMENT_PROPERTY_BLOCKS, MAX_DOCUMENT_PROPERTY_REPORT_LIMIT } from '../shared/document-properties.js';
import { normalizeDocumentContent, MAX_DOCUMENT_BYTES } from './document-content.js';
import { parseLegacyXml } from './legacy-import-archive.js';
import { parseConfluenceLabelList } from './migration-confluence-label-list.js';
import { parseConfluenceColumnLayout } from './migration-confluence-layout.js';
import {
  confluencePropertyReportMacros, parseConfluenceDocumentProperties, parseConfluenceDocumentPropertyReport,
} from './migration-confluence-properties.js';
import { confluenceSectionAliases, scanConfluenceSections, type ConfluenceStorageNode as XmlNode } from './migration-confluence-sections.js';

// Format references (conversion is local and never requests these URLs):
// https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html
// https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
export interface MigrationPageIdentity { sourceId?: string; title?: string; spaceKey?: string }
export interface MigrationReferenceInput extends MigrationPageIdentity {
  kind: 'page' | 'issue' | 'attachment';
  url?: string;
  // A null owner marks an explicit container that cannot be resolved safely.
  attachmentOwner?: MigrationPageIdentity | null;
}
export interface MigrationContentContext {
  resolveReference: (input: MigrationReferenceInput) => { id: string; label: string; url?: string } | null;
  // Text-only fields and older migration checkpoints used explicit annotation labels.
  legacyAnnotations?: boolean;
  legacySectionBaseline?: boolean;
  legacyDocumentToc?: boolean;
  legacyDocumentLabelList?: boolean;
  legacyDocumentChildList?: boolean;
  legacyDocumentExcerpt?: boolean;
  legacyDocumentLayout?: boolean;
  legacyDocumentProperties?: boolean;
  resolveLabelListProject?: (sourceSpaceKey: string | null) => string | null;
  resolveChildListSpaceProject?: (sourceSpaceKey: string | null) => string | null;
  sectionLinks?: {
    documentId: string;
    resolvePageSection?: (page: MigrationReferenceInput, fragment: string, fromUrl: boolean) => { documentId: string; sectionId: string } | null;
  };
}
export interface MigrationContentDiagnostic { severity: 'warning' | 'error'; code: string; message: string }
export interface MigrationContentResult {
  content: RichContent; plainText: string; diagnostics: MigrationContentDiagnostic[];
  sectionTargets?: ReadonlyMap<string, string>;
}
const MAX_SOURCE_BYTES = 16 * 1024 * 1024, MAX_NODES = 30000, MAX_DEPTH = 50, MAX_WORK = 100000, MAX_MS = 2500;
const sourceStatusTones = new Map<string, StatusBadgeTone>([
  ['neutral', 'neutral'], ['grey', 'neutral'], ['gray', 'neutral'], ['blue', 'blue'], ['green', 'green'],
  ['yellow', 'amber'], ['red', 'red'], ['purple', 'purple'],
]);
const adfPanelVariants = new Map<string, CalloutVariant>([
  ['info', 'info'], ['note', 'note'], ['warning', 'warning'], ['success', 'tip'], ['error', 'warning'],
]);
type Mark = NonNullable<RichContent['marks']>[number];
const text = (value: string, marks?: Mark[]): RichContent[] => value ? [{ type: 'text', text: value, ...(marks?.length ? { marks } : {}) }] : [];
const paragraph = (content: RichContent[] = []): RichContent => ({ type: 'paragraph', content });
const inline = (node: RichContent) => node.type === 'text' || node.type === 'hardBreak' || node.type === 'statusBadge';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const ensureListItem = (nodes: RichContent[]) => { const blocks = flow(nodes); return blocks[0].type === 'paragraph' ? blocks : [paragraph(), ...blocks]; };
function flow(nodes: RichContent[], type = 'paragraph', attrs?: Record<string, unknown>): RichContent[] {
  const result: RichContent[] = []; let pending: RichContent[] = [];
  const flush = () => { if (pending.length) { result.push({ type, ...(attrs ? { attrs } : {}), content: pending }); pending = []; } };
  for (const node of nodes) { if (inline(node)) pending.push(node); else { flush(); result.push(node); } }
  flush(); return result.length ? result : [paragraph()];
}
const codeBlock = (value: string, language = ''): RichContent => ({ type: 'codeBlock', ...(language ? { attrs: { language } } : {}), content: text(value) });
class ConversionLimit extends Error {}
function pageIdentity(node: XmlNode): MigrationPageIdentity {
  return { sourceId: node.attrs['ri:content-id'] || node.attrs['ri:page-id'], title: node.attrs['ri:content-title'], spaceKey: node.attrs['ri:space-key'] };
}
const confluenceSpaceKey = /^(?:[A-Za-z0-9]+|~[^\s:]+)$/;
function confluencePageParameter(parameter: XmlNode | undefined): MigrationPageIdentity | { spaceRoot: string | null } | null | undefined {
  if (!parameter) return undefined;
  if (parameter.children.every(part => typeof part === 'string')) {
    const value = parameter.children.join('').trim();
    if (!value) return undefined;
    if (value === '/') return { spaceRoot: null };
    const separator = value.indexOf(':');
    if (separator < 0 || !confluenceSpaceKey.test(value.slice(0, separator))) return { title: value };
    const spaceKey = value.slice(0, separator), title = value.slice(separator + 1).trim();
    return title ? { spaceKey, title } : { spaceRoot: spaceKey };
  }
  const parts = parameter.children.filter(part => typeof part !== 'string' || part.trim());
  if (parts.length !== 1 || typeof parts[0] === 'string') return null;
  let page = parts[0];
  if (page.name === 'ac:link') {
    if (Object.keys(page.attrs).length) return null;
    const children = page.children.filter(child => typeof child !== 'string' || child.trim());
    if (children.length !== 1 || typeof children[0] === 'string') return null;
    page = children[0];
  }
  if (page.name !== 'ri:page' || page.children.some(child => typeof child !== 'string' || child.trim()) ||
      Object.keys(page.attrs).some(key => !['ri:content-id', 'ri:page-id', 'ri:content-title', 'ri:space-key'].includes(key))) return null;
  const identity = pageIdentity(page);
  if (page.attrs['ri:content-id'] && page.attrs['ri:page-id'] && page.attrs['ri:content-id'] !== page.attrs['ri:page-id']) return null;
  if (identity.spaceKey && !confluenceSpaceKey.test(identity.spaceKey)) return null;
  return identity.sourceId?.trim() || identity.title?.trim() ? identity : null;
}

// https://confluence.atlassian.com/spaces/CONF50/pages/329980084/Confluence+Storage+Format+for+Macros
function storageMacroParts(node: XmlNode) {
  if (Object.keys(node.attrs).some(key => !['ac:name', 'ac:schema-version', 'ac:macro-id', 'ac:local-id', 'xmlns:ac', 'xmlns:ri'].includes(key))) return null;
  const parameters = new Map<string, XmlNode>();
  let body: XmlNode | undefined;
  for (const part of node.children) {
    if (typeof part === 'string') {
      if (part.trim()) return null;
      continue;
    }
    if (part.name === 'ac:rich-text-body') {
      if (body || Object.keys(part.attrs).length) return null;
      body = part;
      continue;
    }
    const keys = Object.keys(part.attrs);
    const parameter = part.name === 'ac:default-parameter' && !keys.length ? ''
      : part.name === 'ac:parameter' && keys.length === 1 && keys[0] === 'ac:name' ? part.attrs['ac:name']
      : undefined;
    if (parameter === undefined || parameters.has(parameter)) return null;
    parameters.set(parameter, part);
  }
  return { parameters, body };
}

function plainStorageParameters(parameters: Map<string, XmlNode>): Record<string, string> | null {
  const result: Record<string, string> = Object.create(null);
  for (const [key, parameter] of parameters) {
    if (parameter.children.some(child => typeof child !== 'string')) return null;
    result[key] = parameter.children.join('');
  }
  return result;
}

function excerptParameterText(parameter: XmlNode | undefined): string | null {
  if (!parameter) return '';
  if (parameter.children.some(child => typeof child !== 'string')) return null;
  return parameter.children.join('').trim().toLowerCase();
}

function childListBound(value: string | undefined, limit: number): number | undefined | null {
  if (!value || value === 'none') return undefined;
  return /^[1-9]\d{0,2}$/.test(value) && Number(value) <= limit ? Number(value) : null;
}
function attachmentIdentity(node: XmlNode): MigrationReferenceInput {
  const reference: MigrationReferenceInput = { kind: 'attachment', sourceId: node.attrs['ri:content-id'], title: node.attrs['ri:filename'] };
  const containers = node.children.filter((child): child is XmlNode => typeof child !== 'string');
  if (!containers.length) return reference;
  reference.attachmentOwner = null;
  if (containers.length !== 1) return reference;
  const [container] = containers;
  if (container.name === 'ri:page') {
    const page = pageIdentity(container);
    if (page.sourceId || page.title) reference.attachmentOwner = page;
  } else if (container.name === 'ri:content-entity' && container.attrs['ri:content-id']) {
    reference.attachmentOwner = { sourceId: container.attrs['ri:content-id'] };
  }
  return reference;
}
const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function serializeXml(node: XmlNode | string): string { return typeof node === 'string' ? escapeXml(node) : `<${node.name}${Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('')}>${node.children.map(serializeXml).join('')}</${node.name}>`; }
const taskAttributes = new Set(['ac:local-id', 'xmlns:ac', 'xmlns:ri']);
const userLabels = ['ri:display-name', 'ri:displayname'];
const userIdentifiers = ['ri:username', 'ri:userkey', 'ri:account-id', 'ri:accountid'];
const userAttributes = new Set([...userLabels, ...userIdentifiers, 'xmlns:ri']);
const inertInline = (node: RichContent) => inline(node) && !node.marks?.some(mark => mark.type === 'link');
function confluenceDate(value: string): boolean {
  if (isCalendarDate(value)) return true;
  const timestamp = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/u.exec(value);
  return Boolean(timestamp && isCalendarDate(timestamp[1]));
}
function decodeXml(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|apos|quot);/g, (_, entity: string) => entity.startsWith('#') ? String.fromCodePoint(entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : named[entity]);
}
class Converter {
  diagnostics: MigrationContentDiagnostic[] = []; private codes = new Set<string>(); private work = 0; private started = performance.now();
  private sections?: ReturnType<typeof scanConfluenceSections>;
  private localSectionLinks = new Map<Mark, { id: string; originalTarget: string }>();
  private sourceTitle = '';
  private sourceHeadingMaximum = 3;
  private richDocument = false;
  private projectedProperties = 0;
  private firstSourceExcerpt?: XmlNode;
  private convertedFirstExcerpt = false;
  constructor(readonly source: string, readonly context: MigrationContentContext) {}
  sectionTargets(content: RichContent): ReadonlyMap<string, string> | undefined {
    if (!this.sections?.targets.size) return undefined;
    const present = this.presentSections(content);
    return new Map([...this.sections.targets].filter(([, id]) => present.has(id)));
  }
  private presentSections(content: RichContent): Set<string> {
    const present = new Set<string>();
    const pending = [content];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'heading' && isDocumentSectionId(node.attrs?.sectionId)) present.add(node.attrs.sectionId);
      for (const child of node.content ?? []) pending.push(child);
    }
    return present;
  }
  verifyLocalSectionLinks(content: RichContent): void {
    if (!this.localSectionLinks.size) return;
    const present = this.presentSections(content);
    if ([...this.localSectionLinks.values()].every(link => present.has(link.id))) return;
    const pending = [content];
    while (pending.length) {
      const node = pending.pop()!;
      const mark = node.marks?.find(mark => mark.type === 'link');
      const link = mark && this.localSectionLinks.get(mark);
      if (link && !present.has(link.id)) {
        node.marks = node.marks?.filter(item => item !== mark);
        node.text += ` (${link.originalTarget})`;
        this.unresolvedSection();
      }
      for (const child of node.content ?? []) pending.push(child);
    }
  }
  tick(depth = 0) { if (depth > MAX_DEPTH || ++this.work > MAX_WORK || performance.now() - this.started > MAX_MS) throw new ConversionLimit('변환 작업·중첩·시간 예산을 초과했습니다.'); }
  warn(code: string, message: string, severity: 'warning' | 'error' = 'warning') {
    const key = `${severity}:${code}`; if (this.codes.has(key)) return; this.codes.add(key);
    if (this.diagnostics.length < 200) this.diagnostics.push({ severity, code, message });
  }
  resolve(input: MigrationReferenceInput) {
    this.tick();
    try {
      const value = this.context.resolveReference(input);
      if (value && (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200 || /[\x00-\x1f\x7f]/.test(value.id) || typeof value.label !== 'string')) { this.warn('INVALID_REFERENCE_MAPPING', '참조 매핑의 식별자 또는 이름이 올바르지 않습니다.', 'error'); return null; }
      return value;
    } catch { this.warn('REFERENCE_RESOLUTION_FAILED', '참조 매핑 중 오류가 발생했습니다. 매핑을 확인해야 합니다.', 'error'); return null; }
  }
  safeUrl(value: string): string | null {
    const url = value.trim();
    if (!url || /[\x00-\x20\x7f\\]/.test(url)) return null;
    if (/^\/(?!\/)/.test(url) || url.startsWith('#')) return url;
    try { const parsed = new URL(url); return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? url : null; } catch { return null; }
  }
  reference(input: MigrationReferenceInput, include = false, displayLabel = ''): RichContent[] {
    const found = this.resolve(input), label = displayLabel || found?.label || (input.spaceKey && input.title ? `${input.spaceKey}:${input.title}` : input.title) || input.sourceId || input.url || '원본 참조';
    if (!found) { const target = input.sourceId || (input.spaceKey && input.title ? `${input.spaceKey}:${input.title}` : input.title) || input.url; this.warn('UNRESOLVED_REFERENCE', '이관 대상이 없는 문서·업무 참조를 읽을 수 있는 텍스트로 보존했습니다.'); return text(`[${include ? '문서 포함' : input.kind === 'issue' ? '업무' : '문서'} 참조: ${label}${target && target !== label ? ` (${target})` : ''}]`); }
    if (label.length > 300) this.warn('REFERENCE_LABEL_NORMALIZED', '참조 표시 이름이 300자를 넘어 원본 보관 자료와 함께 확인해야 합니다.');
    return [{ type: input.kind === 'issue' ? 'issueReference' : include ? 'documentInclude' : 'documentReference', attrs: { [input.kind === 'issue' ? 'issueId' : 'documentId']: found.id, label: label.slice(0, 300) } }];
  }
  link(label: RichContent[], url: string): RichContent[] {
    const safe = this.safeUrl(url);
    if (!safe) { this.warn('UNSAFE_URL', '안전하지 않은 URL은 실행 가능한 링크로 만들지 않고 텍스트로 보존했습니다.'); return [...label, ...text(` (${url})`)]; }
    const special = label.some(node => node.type !== 'text' || node.marks?.some(mark => mark.type === 'code'));
    if (special) this.warn('LINK_TARGET_SHOWN_AS_TEXT', '코드·이미지 등 링크를 직접 적용할 수 없는 내용 뒤에 원본 링크 주소를 텍스트로 남겼습니다.');
    const marked = label.map(node => node.type === 'text' && !node.marks?.some(mark => mark.type === 'code') ? { ...node, marks: [...(node.marks || []).filter(mark => mark.type !== 'link'), { type: 'link', attrs: { href: safe } }] } : node);
    return special ? [...marked, ...text(` (${url})`)] : marked;
  }
  sectionLink(label: RichContent[], display: string, fragment: string, page?: MigrationReferenceInput, fromUrl = false): RichContent[] {
    const settings = this.context.sectionLinks!;
    let target: { documentId: string; sectionId: string } | null = null;
    if (page) target = settings.resolvePageSection?.(page, fragment, fromUrl) ?? null;
    else {
      const aliases = fromUrl ? confluenceSectionAliases(fragment, this.sourceTitle) : [fragment];
      const matches = new Set(aliases.map(alias => this.sections?.targets.get(alias)).filter((id): id is string => Boolean(id)));
      if (matches.size === 1) target = { documentId: settings.documentId, sectionId: [...matches][0] };
    }
    const originalTarget = page?.url || (page?.sourceId || [page?.spaceKey, page?.title].filter(Boolean).join(':')) + '#' + fragment;
    if (target && isDocumentSectionId(target.sectionId) && !label.some(node => node.type !== 'text' || node.marks?.some(mark => mark.type === 'code'))) {
      const linked = this.link(label.length ? label : text(display || fragment), documentSectionHash(target.documentId, target.sectionId));
      if (!page) for (const node of linked) {
        const mark = node.marks?.find(mark => mark.type === 'link');
        if (mark) this.localSectionLinks.set(mark, { id: target.sectionId, originalTarget });
      }
      return linked;
    }
    this.unresolvedSection();
    return text(`${display || '절 링크'} (${originalTarget})`);
  }
  private unresolvedSection(): void {
    this.warn('SECTION_LINK_UNRESOLVED', 'Confluence 절 링크의 대상이나 표시 형식을 확정할 수 없어 링크 이름과 원본 대상 정보를 텍스트로 보존했습니다.');
  }
  image(input: MigrationReferenceInput, alt: string): RichContent[] {
    const found = this.resolve({ ...input, kind: 'attachment' });
    if (found?.url && /^\/api\/attachments\/[^/?#]+\/content\?inline=1$/.test(found.url) && this.safeUrl(found.url)) return [{ type: 'image', attrs: { src: found.url, alt: alt || found.label } }];
    this.warn(input.url && /^https?:/i.test(input.url) ? 'REMOTE_IMAGE_NOT_EMBEDDED' : 'UNRESOLVED_IMAGE', '이미지 파일을 로컬 첨부로 확정하지 못해 이름·주소를 텍스트로 보존했습니다. 원격 이미지는 자동으로 불러오지 않습니다.');
    const label = alt || found?.label || input.title || input.sourceId || '이미지', url = found?.url || input.url;
    return url ? this.link(text(`[이미지: ${label}]${this.safeUrl(url) ? ` (${url})` : ''}`), url) : text(`[이미지: ${label}]`);
  }
  marked(nodes: RichContent[], mark: Mark): RichContent[] {
    return nodes.map(node => {
      if (node.type !== 'text') return node;
      const previous = node.marks || [];
      if (mark.type !== 'code' && previous.some(item => item.type === 'code')) { this.warn('CODE_FORMAT_SIMPLIFIED', '인라인 코드와 겹친 다른 문자 서식은 코드 서식을 우선했습니다.'); return node; }
      if (mark.type === 'code' && previous.length) this.warn('CODE_FORMAT_SIMPLIFIED', '인라인 코드와 겹친 다른 문자 서식은 코드 서식을 우선했습니다.');
      return { ...node, marks: mark.type === 'code' ? [mark] : [...previous.filter(item => item.type !== mark.type), mark] };
    });
  }
  fallback(label: string, raw: string): RichContent[] { this.warn('UNSUPPORTED_CONTENT', `지원하지 않는 ${label}을 원문 텍스트 블록으로 보존했습니다.`); return [codeBlock(`[${label}]\n${raw}`)]; }
  callout(variant: CalloutVariant, title: string, content: RichContent[]): RichContent[] {
    if (title.length > MAX_CALLOUT_TITLE_LENGTH) {
      this.warn('CALLOUT_TITLE_UNSUPPORTED', '길이 한도를 초과한 안내 상자 제목 전체를 안내 상자 첫 문단으로 보존했습니다.');
      return [{ type: 'callout', attrs: { variant, title: '' }, content: [paragraph(text(title)), ...content] }];
    }
    return [{ type: 'callout', attrs: { variant, title }, content }];
  }
  statusBadge(label: string, color: string): RichContent[] {
    if (label.length > MAX_STATUS_BADGE_LABEL_LENGTH) {
      this.warn('STATUS_LABEL_UNSUPPORTED', '길이 한도를 초과한 상태 배지 이름 전체를 본문 텍스트로 보존했습니다. 배지 정보는 원본 보관 자료에서 확인할 수 있습니다.');
      return text(`[상태: ${label}]`);
    }
    const tone = sourceStatusTones.get(color.trim().toLowerCase());
    if (!tone) this.warn('STATUS_COLOR_UNSUPPORTED', '지원하지 않는 원본 상태 색상은 원본 보관 자료에 남으며 배지는 중립 색상으로 표시합니다.');
    return [{ type: 'statusBadge', attrs: { label, tone: tone ?? 'neutral' } }];
  }
  plain(value: string): RichContent[] { return value.replace(/\r\n?/g, '\n').split('\n').map(line => { this.tick(); return paragraph(text(line)); }); }
  span(value: unknown): number { const number = Number(value ?? 1); if (!Number.isSafeInteger(number) || number < 1 || number > MAX_DOCUMENT_TABLE_SPAN) { this.warn('TABLE_SPAN_NORMALIZED', '잘못되었거나 너무 큰 표 셀 병합 수를 1로 바꿨습니다.'); return 1; } return number; }
  headingLevel(value: unknown): number { const level = Number(value || 1); if (![1, 2, 3].includes(level)) this.warn('HEADING_LEVEL_NORMALIZED', '편집기가 지원하는 제목 1~3단계로 정규화했습니다.'); return Math.max(1, Math.min(3, Number.isFinite(level) ? level : 1)); }
  urlReference(url: string): MigrationReferenceInput | null {
    const address = url.trim();
    if (/\/browse\/[A-Za-z][A-Za-z0-9_]*-\d+(?:[?#/]|$)/.test(address)) return { kind: 'issue', url };
    if (/[?&]pageId=|(?:^|\/)(?:display|spaces)\//.test(address)) return { kind: 'page', url };
    return null;
  }
  adf(value: unknown, depth = 0): RichContent[] {
    this.tick(depth); const node = object(value), attrs = object(node.attrs), type = string(node.type);
    if (node.content !== undefined && !Array.isArray(node.content)) throw new Error('ADF content는 목록이어야 합니다.');
    if (type !== 'text' && Object.hasOwn(node, 'text')) return this.fallback('비정형 ADF 텍스트 구조', JSON.stringify(node));
    const children = () => Array.isArray(node.content) ? node.content.flatMap(child => this.adf(child, depth + 1)) : [];
    switch (type) {
      case 'doc': return flow(children());
      case 'text': {
        if (typeof node.text !== 'string') return this.fallback('ADF text', JSON.stringify(node));
        let nodes = text(node.text);
        const marks = Array.isArray(node.marks) ? node.marks.map(object) : [];
        if (marks.some(mark => mark.type === 'code')) {
          if (marks.length > 1) this.warn('CODE_FORMAT_SIMPLIFIED', '인라인 코드와 겹친 다른 서식은 코드 서식을 우선했습니다.');
          return this.marked(nodes, { type: 'code' });
        }
        for (const mark of marks) {
          this.tick(depth + 1); const kind = string(mark.type), mapped = ({ strong: 'bold', em: 'italic', strike: 'strike', underline: 'underline' } as Record<string, string>)[kind];
          if (mapped) nodes = this.marked(nodes, { type: mapped });
          else if (kind === 'link') nodes = this.link(nodes, string(object(mark.attrs).href));
          else this.warn('UNSUPPORTED_ADF_MARK', '편집기가 지원하지 않는 ADF 문자 서식은 원문 보관 자료에서 확인할 수 있으며 텍스트는 유지했습니다.');
        }
        return nodes;
      }
      case 'paragraph': return flow(children());
      case 'heading': return flow(children(), 'heading', { level: this.headingLevel(attrs.level) });
      case 'hardBreak': return [{ type: 'hardBreak' }];
      case 'rule': return [{ type: 'horizontalRule' }];
      case 'codeBlock': return Array.isArray(node.content) && node.content.some(child => !['text', 'hardBreak'].includes(string(object(child).type))) ? this.fallback('비정형 ADF 코드 블록', JSON.stringify(node)) : [codeBlock(this.adfPlain(node), string(attrs.language).slice(0, 100))];
      case 'blockquote': return [{ type: 'blockquote', content: flow(children()) }];
      case 'panel': {
        if (this.context.legacyAnnotations) {
          this.warn('PANEL_FLATTENED', 'ADF 패널은 종류를 제목으로 남긴 인용 블록으로 변환했습니다.');
          return [{ type: 'blockquote', content: [paragraph(text(`[${string(attrs.panelType) || '패널'}]`)), ...flow(children())] }];
        }
        const panelType = typeof attrs.panelType === 'string' ? attrs.panelType : '';
        const variant = adfPanelVariants.get(panelType);
        if (!variant || !Array.isArray(node.content) || !node.content.length) return this.fallback('ADF 패널', JSON.stringify(node));
        const title = panelType === 'success' ? '성공' : panelType === 'error' ? '오류' : '';
        if (title || Object.keys(attrs).some(key => key !== 'panelType')) {
          this.warn('CALLOUT_PRESENTATION_UNSUPPORTED', '원본 패널의 표시 설정은 원본 보관 자료에 남으며 안내 상자에는 지원하는 종류와 서식을 적용합니다.');
        }
        return this.callout(variant, title, flow(children()));
      }
      case 'bulletList': case 'orderedList': { const items = children(); return [{ type: type === 'bulletList' ? 'bulletList' : 'orderedList', ...(type === 'orderedList' ? { attrs: { start: Number.isSafeInteger(attrs.order) && Number(attrs.order) > 0 ? attrs.order : 1 } } : {}), content: items.length ? items : [{ type: 'listItem', content: [paragraph()] }] }]; }
      case 'listItem': return [{ type: 'listItem', content: ensureListItem(children()) }];
      case 'taskList': { const items = children(); return [{ type: 'taskList', content: items.length ? items : [{ type: 'taskItem', attrs: { checked: false }, content: [paragraph()] }] }]; }
      case 'taskItem': case 'blockTaskItem': return [{ type: 'taskItem', attrs: { checked: attrs.state === 'DONE' || attrs.state === 'done' || attrs.checked === true }, content: flow(children()) }];
      case 'expand': case 'nestedExpand': return [{ type: 'details', content: [{ type: 'detailsSummary', content: text(string(attrs.title) || '자세히 보기') }, { type: 'detailsContent', content: flow(children()) }] }];
      case 'table': return [{ type: 'table', content: children() }];
      case 'tableRow': return [{ type: 'tableRow', content: children() }];
      case 'tableCell': case 'tableHeader': return [{ type, attrs: { colspan: this.span(attrs.colspan), rowspan: this.span(attrs.rowspan) }, content: flow(children()) }];
      case 'inlineCard': case 'blockCard': {
        const url = string(attrs.url), reference = this.urlReference(url);
        return reference ? this.reference(reference) : this.link(text(url || '[URL이 없는 카드]'), url);
      }
      case 'mediaSingle': case 'mediaGroup': return children();
      case 'media': case 'mediaInline': return this.image({ kind: 'attachment', sourceId: string(attrs.id) || undefined, url: string(attrs.url) || undefined }, string(attrs.alt));
      case 'mention': this.warn('MENTION_FLATTENED', '원본 사용자 멘션은 표시 이름·ID를 텍스트로 보존했습니다.'); return text(string(attrs.text) || string(attrs.displayName) || `@${string(attrs.id)}`);
      case 'emoji': return text(string(attrs.text) || string(attrs.shortName) || string(attrs.id) || '[이모지]');
      case 'status': {
        if (this.context.legacyAnnotations) {
          this.warn('STATUS_FLATTENED', '본문 상태 배지는 상태 텍스트로 보존했습니다.');
          return text(`[상태: ${string(attrs.text) || string(attrs.color)}]`);
        }
        if (typeof attrs.text !== 'string' || !attrs.text.trim() || typeof attrs.color !== 'string' ||
            (Array.isArray(node.content) && node.content.length) || (Array.isArray(node.marks) && node.marks.length)) {
          return this.fallback('ADF 상태', JSON.stringify(node));
        }
        if (Object.keys(attrs).some(key => !['text', 'color', 'localId'].includes(key))) {
          this.warn('STATUS_PRESENTATION_UNSUPPORTED', '지원하지 않는 상태 배지의 표시 설정은 원본 보관 자료에서 확인할 수 있습니다.');
        }
        return this.statusBadge(attrs.text, attrs.color);
      }
      case 'date': this.warn('DATE_FLATTENED', '본문 날짜 노드는 원본 값이 보이는 텍스트로 변환했습니다.'); return text(string(attrs.timestamp));
      default: return this.fallback(`ADF ${type || '알 수 없는 노드'}`, JSON.stringify(value));
    }
  }
  adfPlain(value: Record<string, unknown>): string {
    let result = ''; const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
    while (stack.length) { const item = stack.pop()!; this.tick(item.depth); const node = object(item.value); if (node.type === 'text') result += string(node.text); else if (node.type === 'hardBreak') result += '\n'; else if (Array.isArray(node.content)) for (let i = node.content.length - 1; i >= 0; i--) stack.push({ value: node.content[i], depth: item.depth + 1 }); }
    return result;
  }
  xmlText(value: XmlNode | string, depth = 0): string { this.tick(depth); return typeof value === 'string' ? value : value.children.map(child => this.xmlText(child, depth + 1)).join(''); }
  findXml(node: XmlNode, name: string): XmlNode | undefined {
    const stack = [node]; while (stack.length) { const value = stack.pop()!; this.tick(); if (value.name === name) return value; for (let i = value.children.length - 1; i >= 0; i--) if (typeof value.children[i] !== 'string') stack.push(value.children[i] as XmlNode); } return undefined;
  }
  xmlParts(children: (XmlNode | string)[], depth: number, blockLayout = false): RichContent[] {
    const isBlock = (value: XmlNode | string | undefined) => {
      if (!value || typeof value === 'string') return false;
      if (['b', 'strong', 'i', 'em', 's', 'strike', 'del', 'u', 'code', 'tt', 'span', 'br', 'time', 'ri:user', 'ac:inline-comment-marker'].includes(value.name)) return false;
      if (['ac:structured-macro', 'ac:macro'].includes(value.name) && value.attrs['ac:name'] === 'status') return false;
      if (value.name === 'ac:link' && value.children.some(child => typeof child !== 'string' && ['ri:attachment', 'ri:user'].includes(child.name))) return false;
      return true;
    };
    return children.flatMap((child, index) => blockLayout && typeof child === 'string' && !child.trim() && (isBlock(children[index - 1]) || isBlock(children[index + 1])) ? [] : this.xml(child, depth + 1));
  }
  xml(node: XmlNode | string, depth = 0): RichContent[] {
    this.tick(depth); if (typeof node === 'string') return text(node);
    if (this.sections?.bound.has(node)) return [];
    const type = node.name, children = () => this.xmlParts(node.children, depth), child = (name: string) => node.children.find(value => typeof value !== 'string' && value.name === name) as XmlNode | undefined;
    if (/^h[1-6]$/.test(type)) {
      const sectionId = this.sections?.ids.get(node);
      return flow(children(), 'heading', { level: this.headingLevel(type.slice(1)), ...(sectionId ? { sectionId } : {}) });
    }
    if (['b', 'strong', 'i', 'em', 's', 'strike', 'del', 'u', 'code', 'tt'].includes(type)) return this.marked(children(), { type: ({ b: 'bold', strong: 'bold', i: 'italic', em: 'italic', s: 'strike', strike: 'strike', del: 'strike', u: 'underline', code: 'code', tt: 'code' } as Record<string, string>)[type] });
    switch (type) {
      case 'migration-root': case 'div': case 'ac:rich-text-body': return this.xmlParts(node.children, depth, true);
      case 'ac:layout': return this.richDocument ? this.columnLayout(node, depth) : this.fallback(`XML ${type}`, serializeXml(node));
      case 'p': return flow(children());
      case 'ac:inline-comment-marker': {
        this.warn('INLINE_COMMENT_ANCHOR_ARCHIVED', 'Confluence 문장 댓글의 위치 정보는 보존 원문에서 확인할 수 있습니다. 댓글이 붙은 본문 텍스트와 서식을 옮겼습니다.');
        return children();
      }
      case 'span': {
        let nodes = children(); const style = node.attrs.style || '';
        if (/text-decoration\s*:\s*line-through/i.test(style)) nodes = this.marked(nodes, { type: 'strike' });
        if (/text-decoration\s*:\s*underline/i.test(style)) nodes = this.marked(nodes, { type: 'underline' });
        if (style && !/^\s*text-decoration\s*:\s*(?:line-through|underline)\s*;?\s*$/i.test(style)) this.warn('UNSUPPORTED_TEXT_STYLE', '색상·배치 등 지원하지 않는 문자 스타일은 원문 보관 자료에 남기고 텍스트를 유지했습니다.');
        return nodes;
      }
      case 'br': return [{ type: 'hardBreak' }];
      case 'time': return this.confluenceTime(node, depth);
      case 'ri:user': return this.confluenceUser(node, depth);
      case 'hr': return [{ type: 'horizontalRule' }];
      case 'blockquote': return [{ type: 'blockquote', content: flow(this.xmlParts(node.children, depth, true)) }];
      case 'pre': return [codeBlock(this.xmlText(node))];
      case 'ul': case 'ol': {
        const items: RichContent[] = [];
        for (const value of node.children) {
          if (typeof value === 'string' && !value.trim()) continue;
          if (typeof value !== 'string' && value.name === 'li') items.push({ type: 'listItem', content: ensureListItem(this.xmlParts(value.children, depth + 1, true)) });
          else { this.warn('LIST_STRUCTURE_NORMALIZED', '목록 안의 비정형 내용을 별도 목록 항목으로 보존했습니다.'); items.push({ type: 'listItem', content: ensureListItem(this.xml(value, depth + 1)) }); }
        }
        return [{ type: type === 'ul' ? 'bulletList' : 'orderedList', ...(type === 'ol' ? { attrs: { start: /^\d+$/.test(node.attrs.start || '') && Number(node.attrs.start) > 0 ? Number(node.attrs.start) : 1 } } : {}), content: items.length ? items : [{ type: 'listItem', content: [paragraph()] }] }];
      }
      case 'table': {
        const rows: RichContent[] = [], extras: RichContent[] = [];
        const collect = (values: (XmlNode | string)[], nested: number) => {
          this.tick(nested); for (const value of values) {
            if (typeof value === 'string' && !value.trim()) continue;
            if (typeof value !== 'string' && ['tbody', 'thead', 'tfoot'].includes(value.name)) collect(value.children, nested + 1);
            else if (typeof value !== 'string' && value.name === 'tr') rows.push(...this.xml(value, nested + 1));
            else extras.push(...this.xml(value, nested + 1));
          }
        }; collect(node.children, depth + 1);
        if (!rows.length) return this.fallback('행이 없는 XML 표', serializeXml(node));
        if (extras.length) this.warn('TABLE_EXTRA_CONTENT_PRESERVED', '표의 캡션·비정형 내용은 표 앞의 별도 블록으로 보존했습니다.');
        return [...(extras.length ? flow(extras) : []), { type: 'table', content: rows }];
      }
      case 'tr': return [{ type: 'tableRow', content: node.children.filter(value => !(typeof value === 'string' && !value.trim())).flatMap(value => this.xml(value, depth + 1)) }];
      case 'td': case 'th': return [{ type: type === 'td' ? 'tableCell' : 'tableHeader', attrs: { colspan: this.span(node.attrs.colspan), rowspan: this.span(node.attrs.rowspan) }, content: flow(this.xmlParts(node.children, depth, true)) }];
      case 'a': {
        const url = node.attrs.href || '', reference = this.urlReference(url), label = this.xmlText(node);
        const values = children();
        const hash = url.indexOf('#');
        const page = reference?.kind === 'page' ? reference : undefined;
        if (this.context.sectionLinks && hash >= 0 && (page || hash === 0 && !url.startsWith('#/'))) {
          const encoded = url.slice(hash + 1);
          let fragment = encoded;
          try { fragment = decodeURIComponent(encoded); } catch { /* Keep the original target in the warning fallback. */ }
          if (fragment) return this.sectionLink(values, label || url, fragment, page, true);
        }
        return reference ? this.reference(reference, false, label) : this.link(values.length ? values : text(url), url);
      }
      case 'ac:link': {
        const user = child('ri:user');
        if (user) return this.confluenceUser(user, depth, node);
        const page = child('ri:page'), attachment = child('ri:attachment'), body = child('ac:plain-text-link-body') || child('ac:link-body'), label = body ? this.xmlText(body) : '';
        const fragment = node.attrs['ac:anchor']?.trim();
        if (this.context.sectionLinks && fragment) {
          if (node.children.some(value => typeof value === 'string' ? value.trim() : value !== page && value !== body)) {
            this.unresolvedSection();
            return this.fallback('비정형 Confluence 절 링크', serializeXml(node));
          }
          const display = body?.name === 'ac:link-body' ? this.xmlParts(body.children, depth + 1) : text(label);
          return this.sectionLink(display, label, fragment, page ? { kind: 'page', ...pageIdentity(page) } : undefined);
        }
        if (page) return this.reference({ kind: 'page', ...pageIdentity(page) }, false, label);
        if (attachment) {
          const input = attachmentIdentity(attachment), found = this.resolve(input);
          if (found?.url) return this.link(text(label || found.label), found.url);
          this.warn('UNRESOLVED_ATTACHMENT', '첨부 링크를 이관 대상 파일로 확정하지 못해 원본 파일명을 보존했습니다.');
          return text(`[첨부: ${label || input.title || input.sourceId || '원본 파일'}]`);
        }
        if (node.attrs['ac:anchor']) { this.warn('ANCHOR_FLATTENED', '원본 페이지 내 앵커 링크는 앵커 이름을 텍스트로 보존했습니다.'); return text(`${label || '앵커'} (#${node.attrs['ac:anchor']})`); }
        return this.fallback('해석할 수 없는 Confluence 링크', serializeXml(node));
      }
      case 'ac:image': {
        const attachment = child('ri:attachment'), url = child('ri:url');
        const input = attachment ? attachmentIdentity(attachment) : { kind: 'attachment' as const, url: url?.attrs['ri:value'] };
        return this.image(input, node.attrs['ac:alt'] || node.attrs['ac:title'] || '');
      }
      case 'img': return this.image({ kind: 'attachment', url: node.attrs.src }, node.attrs.alt || '');
      case 'ac:task-list': return this.confluenceTaskList(node, depth);
      case 'ac:task': return [{ type: 'taskList', content: [this.confluenceTask(node, depth)] }];
      case 'ac:structured-macro': case 'ac:macro': return this.richDocument && node.attrs['ac:name'] === 'section'
        ? this.columnLayout(node, depth) : this.macro(node, depth + 1);
      default: return this.fallback(`XML ${type}`, serializeXml(node));
    }
  }
  private unsupportedInline(node: XmlNode, label: string): RichContent[] {
    this.warn('UNSUPPORTED_CONTENT', `지원하지 않는 ${label} 구조는 해당 위치에 원문 텍스트로 보존했습니다.`);
    return text(serializeXml(node));
  }
  private confluenceTime(node: XmlNode, depth: number): RichContent[] {
    const date = node.attrs.datetime?.trim();
    if (!date || !confluenceDate(date) || Object.keys(node.attrs).some(key => key !== 'datetime')) {
      return this.unsupportedInline(node, 'Confluence 날짜');
    }
    const label = this.xmlParts(node.children, depth);
    if (!label.every(inertInline)) return this.unsupportedInline(node, 'Confluence 날짜');
    this.warn('DATE_FLATTENED', 'Confluence 본문 날짜는 원본 값이 보이는 텍스트로 변환했습니다.');
    const visible = this.xmlText(node).trim();
    if (!visible) return text(date);
    return visible === date ? label : [...label, ...text(` (${date})`)];
  }
  private confluenceUser(user: XmlNode, depth: number, link?: XmlNode): RichContent[] {
    const source = link ?? user;
    const body = link?.children.find((child): child is XmlNode => typeof child !== 'string' &&
      (child.name === 'ac:link-body' || child.name === 'ac:plain-text-link-body'));
    const unexpectedUser = user.children.some(child => typeof child !== 'string') || Object.keys(user.attrs).some(key => !userAttributes.has(key));
    const unexpectedLink = link && (Object.keys(link.attrs).some(key => !taskAttributes.has(key)) ||
      link.children.some(child => typeof child === 'string' ? child.trim() : child !== user && child !== body));
    const unexpectedBody = body && (Object.keys(body.attrs).length > 0 ||
      body.name === 'ac:plain-text-link-body' && body.children.some(child => typeof child !== 'string'));
    if (unexpectedUser || unexpectedLink || unexpectedBody) {
      return this.unsupportedInline(source, 'Confluence 사용자 참조');
    }
    const label = body ? this.xmlParts(body.children, depth + 1) : [];
    if (!label.every(inertInline)) return this.unsupportedInline(source, 'Confluence 사용자 참조');
    const display = this.xmlText(user).trim() || userLabels.map(key => user.attrs[key]?.trim()).find(Boolean);
    const identifier = userIdentifiers.map(key => user.attrs[key]?.trim()).find(Boolean);
    const fallback = display || (identifier ? `@${identifier.replace(/^@/u, '')}` : '');
    const result = body && this.xmlText(body).trim() ? label : text(fallback);
    if (!result.length) return this.unsupportedInline(source, 'Confluence 사용자 참조');
    this.warn('MENTION_FLATTENED', 'Confluence 사용자 참조는 표시 이름·원본 ID를 텍스트로 보존했습니다.');
    return result;
  }
  private confluenceTaskList(node: XmlNode, depth: number): RichContent[] {
    const blocks: RichContent[] = [];
    let items: RichContent[] = [];
    const flush = () => {
      if (!items.length) return;
      blocks.push({ type: 'taskList', content: items });
      items = [];
    };
    if (Object.keys(node.attrs).some(key => !taskAttributes.has(key))) {
      blocks.push(...this.fallback('Confluence 체크리스트 속성', serializeXml({ ...node, children: [] })));
    }
    for (const child of node.children) {
      if (typeof child !== 'string' && child.name === 'ac:task') items.push(this.confluenceTask(child, depth + 1));
      else if (typeof child !== 'string' || child.trim()) {
        this.tick(depth + 1);
        flush();
        blocks.push(...this.fallback('Confluence 체크리스트 항목', serializeXml(child)));
      }
    }
    flush();
    return blocks.length ? blocks : this.fallback('Confluence 빈 체크리스트', serializeXml(node));
  }
  private confluenceTask(node: XmlNode, depth: number): RichContent {
    this.tick(depth);
    const parts = node.children.filter(child => typeof child !== 'string' || child.trim());
    const nodes = parts.filter((child): child is XmlNode => typeof child !== 'string');
    const body = nodes.find(child => child.name === 'ac:task-body');
    const statuses = nodes.filter(child => child.name === 'ac:task-status');
    const [status] = statuses;
    const simple = (part: XmlNode) => !Object.keys(part.attrs).length && part.children.every(child => typeof child === 'string');
    const value = statuses.length === 1 && simple(status) ? this.xmlText(status).trim() : null;
    const knownStatus = value === 'complete' || value === 'incomplete';
    const blocks = body ? this.xmlParts(body.children, depth + 1, true) : [];
    for (const wrapper of [node, body]) {
      if (wrapper && Object.keys(wrapper.attrs).some(key => !taskAttributes.has(key))) {
        blocks.push(...this.fallback('Confluence 할 일 속성', serializeXml({ ...wrapper, children: [] })));
      }
    }
    const seenIds = new Set<string>();
    for (const part of parts) {
      this.tick(depth + 1);
      if (part === body || part === status && knownStatus) continue;
      if (typeof part !== 'string' && ['ac:task-id', 'ac:task-uuid'].includes(part.name) && simple(part) && !seenIds.has(part.name)) {
        seenIds.add(part.name);
        continue;
      }
      blocks.push(...this.fallback('Confluence 할 일의 부가 정보', serializeXml(part)));
    }
    return { type: 'taskItem', attrs: { checked: value === 'complete' }, content: ensureListItem(blocks) };
  }
  private columnLayout(node: XmlNode, depth: number): RichContent[] {
    const rows = parseConfluenceColumnLayout(node, depth === 1);
    if (!rows || this.context.legacyDocumentLayout) {
      const code = rows ? 'LEGACY_LAYOUT_REPRESENTATION' : 'LAYOUT_STRUCTURE_UNSUPPORTED';
      const message = rows ? '이전 이관에서 사용한 열 배치 원문 코드 블록을 확인했습니다.'
        : '현재 편집기로 표현할 수 없는 열 배치 구조나 설정을 원문 코드 블록으로 보존했습니다.';
      this.warn(code, message);
      const raw = serializeXml(node);
      return [codeBlock(node.name === 'ac:layout' ? `[XML ac:layout]\n${raw}` : raw)];
    }
    return rows.map(({ columns, weights, border }) => {
      this.tick(depth + 1);
      return { type: 'documentColumnLayout', attrs: { weights: [...weights], border }, content: columns.map(column => ({
        type: 'documentColumn', content: flow(this.xmlParts(column.children, depth + 2, true)),
      })) };
    });
  }
  macro(node: XmlNode, depth: number): RichContent[] {
    this.tick(depth); const name = node.attrs['ac:name'] || '', params: Record<string, string> = Object.create(null);
    for (const child of node.children) if (typeof child !== 'string' && child.name === 'ac:parameter') params[child.attrs['ac:name'] || ''] = this.xmlText(child);
    const body = node.children.find(value => typeof value !== 'string' && ['ac:rich-text-body', 'ac:plain-text-body'].includes(value.name)) as XmlNode | undefined;
    const blocks = () => flow(body ? this.xmlParts(body.children, depth + 1, true) : []);
    const disclosure = () => [{ type: 'details', content: [{ type: 'detailsSummary', content: text(params.title || '자세히 보기') }, { type: 'detailsContent', content: blocks() }] }];
    if (name === 'toc' && this.richDocument) return this.tableOfContents(node, params);
    if ((name === 'contentbylabel' || name === 'content-by-label') && this.richDocument) return this.documentLabelList(node, params);
    if (name === 'children' && this.richDocument) return this.documentChildList(node, params);
    if (name === 'excerpt' || name === 'excerpt-include') {
      if (this.context.legacyDocumentExcerpt || !this.richDocument) {
        if (this.context.legacyDocumentExcerpt) {
          this.warn('LEGACY_EXCERPT_REPRESENTATION', '이전 이관에서 사용한 발췌문 표시를 확인했습니다.');
        } else if (name === 'excerpt') {
          this.warn('EXCERPT_FLATTENED', '발췌문 정의는 본문으로 유지했으며 발췌 범위 의미는 원본 보관 자료에 남습니다.');
        } else {
          this.warn('UNSUPPORTED_MACRO', '지원하지 않는 동적·확장 매크로를 실행하지 않고 원문 코드 블록으로 보존했습니다.');
        }
        return name === 'excerpt' ? blocks() : [codeBlock(serializeXml(node))];
      }
      return name === 'excerpt' ? this.documentExcerpt(node, depth) : this.documentExcerptInclude(node);
    }
    if (name === 'code' || name === 'noformat') return [codeBlock(body ? this.xmlText(body) : '', name === 'code' ? (params.language || '').slice(0, 100) : '')];
    if (name === 'expand') return disclosure();
    if (name === 'details' || confluencePropertyReportMacros.has(name)) {
      const brandedDisclosure = name === 'details' && Object.keys(params).length === 1 && Object.hasOwn(params, 'title');
      if (brandedDisclosure || name === 'details' && !this.richDocument) return disclosure();
      if (this.richDocument) {
        if (this.context.legacyDocumentProperties) {
          this.warn('LEGACY_DOCUMENT_PROPERTIES_REPRESENTATION', '이전 이관에서 사용한 문서 속성 표현을 확인했습니다.');
          return name === 'details' ? disclosure() : [codeBlock(serializeXml(node))];
        }
        if (this.projectedProperties >= MAX_DOCUMENT_PROPERTY_BLOCKS) {
          this.warn('DOCUMENT_PROPERTY_BLOCK_LIMIT', `문서에서 변환한 속성과 보고서가 ${MAX_DOCUMENT_PROPERTY_BLOCKS}개에 도달해 이후 매크로를 원문 코드 블록으로 보존했습니다.`);
          return [codeBlock(serializeXml(node))];
        }
        const projected = name === 'details' ? this.documentProperties(node) : this.documentPropertyReport(node);
        if (projected[0].type !== 'codeBlock') this.projectedProperties++;
        return projected;
      }
    }
    if (this.context.legacyAnnotations) {
      if (isCalloutVariant(name)) {
        this.warn('PANEL_FLATTENED', '안내·경고 패널은 종류와 제목을 남긴 인용 블록으로 변환했습니다.');
        return [{ type: 'blockquote', content: [paragraph(text(`[${name}]${params.title ? ` ${params.title}` : ''}`)), ...blocks()] }];
      }
      if (name === 'status') {
        this.warn('STATUS_FLATTENED', '본문 상태 매크로는 상태 텍스트로 보존했습니다.');
        return text(`[상태: ${params.title || params.colour || '상태'}]`);
      }
    }
    if (isCalloutVariant(name) || name === 'status') {
      const parameters = node.children.filter((child): child is XmlNode => typeof child !== 'string' && child.name === 'ac:parameter');
      const malformed = parameters.length !== Object.keys(params).length || node.children.some(child => {
        if (typeof child === 'string') return Boolean(child.trim());
        if (child.name === 'ac:parameter') return child.children.some(value => typeof value !== 'string');
        return name === 'status' || child !== body;
      });
      if (malformed) return this.fallback(`Confluence ${name} 매크로의 비정형 구조`, serializeXml(node));
      if (name === 'status') {
        if (Object.keys(params).some(key => !['title', 'colour', 'subtle'].includes(key)) ||
            Object.hasOwn(params, 'subtle') && params.subtle.trim().toLowerCase() !== 'false') {
          this.warn('STATUS_PRESENTATION_UNSUPPORTED', '지원하지 않는 상태 배지의 표시 설정은 원본 보관 자료에서 확인할 수 있습니다.');
        }
        const color = params.colour?.trim() || 'Grey';
        const label = params.title?.trim() ? params.title : color;
        if (!params.title?.trim() && !sourceStatusTones.has(color.toLowerCase())) {
          return this.fallback('Confluence 상태 매크로의 제목과 색상', serializeXml(node));
        }
        return this.statusBadge(label, color);
      }
      if (Object.keys(params).some(key => key !== 'title' &&
          !(name !== 'panel' && key === 'icon' && params.icon.trim().toLowerCase() === 'true'))) {
        this.warn('CALLOUT_PRESENTATION_UNSUPPORTED', '원본 패널의 표시 설정은 원본 보관 자료에 남으며 안내 상자에는 지원하는 종류와 서식을 적용합니다.');
      }
      return this.callout(name, params.title || '', blocks());
    }
    if (name === 'include') {
      const page = this.findXml(node, 'ri:page');
      if (page) return this.reference({ kind: 'page', ...pageIdentity(page) }, true);
      const parameter = (params[''] || params.page || params.pageTitle || '').trim();
      const qualified = /^([A-Za-z0-9]+|~[^\s:]+):(\S[\s\S]*)$/.exec(parameter);
      const identity = qualified ? { spaceKey: qualified[1], title: qualified[2] } : { title: parameter };
      return this.reference({ kind: 'page', ...identity }, true);
    }
    if (['jira', 'jiraissues'].includes(name.toLowerCase())) {
      const original = serializeXml(node);
      if (this.richDocument && parseConfluenceJiraList(original)) {
        this.warn('JIRA_LIST_REVIEW', '보관한 Jira 목록 원문을 문서에서 선택한 뒤 대상 프로젝트와 검색 조건을 검토해 업무 목록으로 바꿀 수 있습니다.');
        return [codeBlock(original)];
      }
      const parameters = Object.keys(params).map(key => key.toLowerCase());
      const single = !parameters.some(key => ['jqlquery', 'url', 'filter'].includes(key))
        && (!parameters.includes('count') || params.count?.trim().toLowerCase() === 'false');
      if (params.key && single) {
        return this.reference({ kind: 'issue', sourceId: params.key });
      }
    }
    if (name === 'anchor' && this.context.legacySectionBaseline) this.warn('ANCHOR_DECLARATION_FLATTENED', '이전 앵커 매크로의 원문 표현을 확인했습니다.');
    else this.warn('UNSUPPORTED_MACRO', '지원하지 않는 동적·확장 매크로를 실행하지 않고 원문 코드 블록으로 보존했습니다.');
    return [codeBlock(serializeXml(node))];
  }
  private documentProperties(node: XmlNode): RichContent[] {
    const parts = storageMacroParts(node);
    const parameters = parts && plainStorageParameters(parts.parameters);
    const parsed = parameters ? parseConfluenceDocumentProperties(parameters, parts?.body) : { reason: 'parameters' as const };
    if ('options' in parsed) {
      if (parsed.containsStatus) this.warn('DOCUMENT_PROPERTIES_STATUS_PRESENTATION_CHANGED', '속성 값의 상태 배지는 이름을 유지하며 원래 색과 모양은 보관한 원문에서 확인할 수 있습니다.');
      return [{ type: 'documentProperties', attrs: { ...parsed.options } }];
    }
    const notices = {
      parameters: ['DOCUMENT_PROPERTIES_PARAMETERS_UNSUPPORTED', '현재 문서 속성으로 표현할 수 없는 원본 설정을 원문 코드 블록으로 보존했습니다.'],
      table: ['DOCUMENT_PROPERTIES_TABLE_UNSUPPORTED', '현재 문서 속성으로 변환할 수 없는 표 구조나 배치 설정을 원문 코드 블록으로 보존했습니다.'],
      values: ['DOCUMENT_PROPERTIES_VALUES_UNSUPPORTED', '서식·링크가 있는 값이나 지원 범위를 벗어난 이름·값을 원문 코드 블록으로 보존했습니다.'],
    } as const;
    const [code, message] = notices[parsed.reason];
    this.warn(code, message);
    return [codeBlock(serializeXml(node))];
  }
  private documentPropertyReport(node: XmlNode): RichContent[] {
    const parts = storageMacroParts(node);
    const parameters = parts && !parts.body && plainStorageParameters(parts.parameters);
    const parsed = parameters && parseConfluenceDocumentPropertyReport(parameters);
    if (!parsed) {
      this.warn('DOCUMENT_PROPERTY_REPORT_PARAMETERS_UNSUPPORTED', '현재 문서 속성 보고서로 재현할 수 없는 검색 조건이나 표시 설정을 원문 코드 블록으로 보존했습니다.');
      return [codeBlock(serializeXml(node))];
    }
    const projectId = this.context.resolveChildListSpaceProject?.(parsed.spaceKey) ?? this.context.resolveLabelListProject?.(parsed.spaceKey);
    if (!projectId) {
      this.warn('DOCUMENT_PROPERTY_REPORT_SCOPE_UNRESOLVED', '원본 공간의 문서만 조회하는 이관 프로젝트를 확인할 수 없어 보고서를 원문 코드 블록으로 보존했습니다.');
      return [codeBlock(serializeXml(node))];
    }
    this.warn('DOCUMENT_PROPERTY_REPORT_PAGINATION_CHANGED', `이관 보고서는 원본의 페이지 나누기를 적용하지 않고 최대 ${MAX_DOCUMENT_PROPERTY_REPORT_LIMIT}행을 표시합니다.`);
    return [{ type: 'documentPropertyReport', attrs: { ...parsed.options, projectId } }];
  }
  private documentExcerpt(node: XmlNode, depth: number): RichContent[] {
    const firstDefinition = node === this.firstSourceExcerpt;
    if (!firstDefinition && !this.convertedFirstExcerpt) {
      this.warn('EXCERPT_FIRST_DEFINITION_UNAVAILABLE', '원본의 첫 발췌문을 재현할 수 있어야 포함 대상이 유지됩니다. 뒤의 발췌문도 원문 코드 블록으로 보존했습니다.');
      return [codeBlock(serializeXml(node))];
    }
    const parts = storageMacroParts(node);
    const hidden = excerptParameterText(parts?.parameters.get('hidden'));
    const output = excerptParameterText(parts?.parameters.get('atlassian-macro-output-type'));
    if (!parts?.body || [...parts.parameters.keys()].some(key => !['hidden', 'atlassian-macro-output-type'].includes(key)) ||
      hidden === null || !['', 'true', 'false'].includes(hidden) || output === null || !['', 'block'].includes(output)) {
      this.warn('EXCERPT_PARAMETERS_UNSUPPORTED', '현재 발췌문으로 표현할 수 없는 원본 설정을 원문 코드 블록으로 보존했습니다.');
      return [codeBlock(serializeXml(node))];
    }
    if (firstDefinition) this.convertedFirstExcerpt = true;
    return [{ type: 'documentExcerpt', attrs: { hidden: hidden === 'true' }, content: flow(this.xmlParts(parts.body.children, depth + 1, true)) }];
  }
  private documentExcerptInclude(node: XmlNode): RichContent[] {
    const parts = storageMacroParts(node);
    const targetKeys = ['', 'page', 'pageTitle', 'default-parameter'];
    const targets = parts ? [...parts.parameters].filter(([key]) => targetKeys.includes(key)) : [];
    const noPanel = excerptParameterText(parts?.parameters.get('nopanel'));
    const reference = targets.length === 1 ? confluencePageParameter(targets[0][1]) : null;
    if (!parts || parts.body || [...parts.parameters.keys()].some(key => key !== 'nopanel' && !targetKeys.includes(key)) ||
      noPanel === null || !['', 'true', 'false'].includes(noPanel) || !reference || 'spaceRoot' in reference) {
      this.warn('EXCERPT_INCLUDE_PARAMETERS_UNSUPPORTED', '발췌문 포함의 대상이나 표시 설정을 확정할 수 없어 원문 코드 블록으로 보존했습니다.');
      return [codeBlock(serializeXml(node))];
    }
    const target = this.resolve({ kind: 'page', ...reference });
    if (!target) {
      this.warn('UNRESOLVED_EXCERPT_INCLUDE', '발췌문을 가져올 원본 문서를 확정하지 못해 원문 코드 블록으로 보존했습니다.');
      return [codeBlock(serializeXml(node))];
    }
    const label = target.label || reference.title || reference.sourceId || '';
    if (label.length > 300) this.warn('REFERENCE_LABEL_NORMALIZED', '참조 표시 이름이 300자를 넘어 원본 보관 자료와 함께 확인해야 합니다.');
    return [{ type: 'documentExcerptInclude', attrs: { documentId: target.id, label: label.slice(0, 300), noPanel: noPanel === 'true' } }];
  }
  private documentChildList(node: XmlNode, params: Record<string, string>): RichContent[] {
    const preserve = (code: string, message: string): RichContent[] => {
      this.warn(code, message);
      return [codeBlock(serializeXml(node))];
    };
    if (this.context.legacyDocumentChildList) {
      return preserve('LEGACY_CHILD_LIST_REPRESENTATION', '이전 이관의 하위 문서 목록 원문 코드 블록을 확인했습니다.');
    }
    const unsupported = () => preserve('CHILD_LIST_PARAMETERS_UNSUPPORTED', '현재 하위 문서 목록으로 표현할 수 없는 설정을 원문 코드 블록으로 보존했습니다.');
    const allowed = ['page', 'all', 'first', 'depth', 'style', 'excerpt', 'sort', 'reverse'];
    const parameters = node.children.filter(child => typeof child !== 'string');
    if (Object.keys(node.attrs).some(key => !['ac:name', 'ac:schema-version', 'ac:macro-id', 'ac:local-id', 'xmlns:ac', 'xmlns:ri'].includes(key)) ||
      parameters.length !== Object.keys(params).length || node.children.some(child => {
      if (typeof child === 'string') return Boolean(child.trim());
      const key = child.attrs['ac:name'];
      return child.name !== 'ac:parameter' || !allowed.includes(key) || Object.keys(child.attrs).length !== 1 ||
        (key !== 'page' && child.children.some(part => typeof part !== 'string'));
    })) return unsupported();
    const setting = (key: string) => params[key]?.trim().toLowerCase() || '';
    const excerpt = setting('excerpt');
    if (excerpt && excerpt !== 'none' && excerpt !== 'false') {
      return preserve('CHILD_LIST_EXCERPT_UNSUPPORTED', '하위 문서 본문 발췌 설정을 원문 코드 블록으로 보존했습니다.');
    }
    const all = setting('all'), reverse = setting('reverse');
    const first = childListBound(setting('first'), MAX_DOCUMENT_CHILD_LIST_FIRST);
    const depth = childListBound(setting('depth'), MAX_DOCUMENT_CHILD_LIST_DEPTH);
    const sortValue = setting('sort'), styleValue = setting('style');
    const sort = sortValue === 'creation' ? 'created' : sortValue === 'modified' ? 'updated' : sortValue === 'title' || !sortValue ? 'title' : null;
    const style = !styleValue || styleValue === 'none' ? 'list' : styleValue;
    if (first === null || depth === null || !sort || !['', 'true', 'false'].includes(all) || !['', 'true', 'false'].includes(reverse) ||
        !['list', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(style)) return unsupported();
    const parent = confluencePageParameter(parameters.find(parameter => parameter.attrs['ac:name'] === 'page'));
    if (parent === null) return unsupported();
    let scope = 'current', documentId: string | null = null, projectId: string | null = null;
    const unresolved = () => preserve('CHILD_LIST_SCOPE_UNRESOLVED', '확인 가능한 하위 문서 목록의 원본 부모 또는 공간을 찾지 못해 원문 코드 블록으로 보존했습니다.');
    if (parent && 'spaceRoot' in parent) {
      const project = this.context.resolveChildListSpaceProject?.(parent.spaceRoot);
      if (!project) return unresolved();
      scope = parent.spaceRoot === null ? 'current-space' : 'space';
      projectId = parent.spaceRoot === null ? null : project;
    } else if (parent) {
      const target = this.resolve({ kind: 'page', ...parent });
      if (!target) return unresolved();
      scope = 'document';
      documentId = target.id;
    }
    const options = normalizeDocumentChildListOptions({ scope, documentId, projectId, depth: all === 'true' ? 'all' : depth ?? 1,
      first: first ?? null, sort, descending: reverse === 'true', style });
    if (!options) return unsupported();
    if (!sortValue) this.warn('CHILD_LIST_DEFAULT_ORDER_CONVERTED', '원본에 정렬 기준이 없어 문서 제목순으로 표시합니다. 원본의 수동 순서는 보관 자료에서 확인할 수 있습니다.');
    return [{ type: 'documentChildList', attrs: { ...options } }];
  }
  private documentLabelList(node: XmlNode, params: Record<string, string>): RichContent[] {
    if (this.context.legacyDocumentLabelList) {
      this.warn('LEGACY_LABEL_LIST_REPRESENTATION', '이전 이관의 라벨별 문서 목록 원문 코드 블록을 확인했습니다.');
      return [codeBlock(serializeXml(node))];
    }
    const children = node.children.filter(child => typeof child !== 'string');
    const malformed = children.length !== Object.keys(params).length || node.children.some(child => {
      if (typeof child === 'string') return Boolean(child.trim());
      return child.name !== 'ac:parameter' || !child.attrs['ac:name'] || child.children.some(value => typeof value !== 'string');
    });
    const parsed = malformed ? null : parseConfluenceLabelList(params);
    if (parsed) {
      const { spaceKey, ...options } = parsed;
      const projectId = this.context.resolveLabelListProject?.(spaceKey);
      if (!projectId) {
        this.warn('LABEL_LIST_SCOPE_UNRESOLVED', '같은 원본 공간에 속한 페이지만 남는 이관 프로젝트를 확인할 수 없어 라벨별 문서 목록을 원문 코드 블록으로 보존했습니다.');
        return [codeBlock(serializeXml(node))];
      }
      const attrs = normalizeDocumentLabelListOptions({ projectId, ...options });
      if (attrs) return [{ type: 'documentLabelList', attrs: { ...attrs } }];
    }
    this.warn('LABEL_LIST_PARAMETERS_UNSUPPORTED', '현재 문서 목록으로 표현할 수 없는 라벨 필터나 표시 설정을 원문 코드 블록으로 보존했습니다.');
    return [codeBlock(serializeXml(node))];
  }
  tableOfContents(node: XmlNode, params: Record<string, string>): RichContent[] {
    const parameters = node.children.filter(child => typeof child !== 'string');
    const malformed = parameters.length !== Object.keys(params).length || node.children.some(child => {
      if (typeof child === 'string') return Boolean(child.trim());
      return child.name !== 'ac:parameter' || !child.attrs['ac:name'] || child.children.some(value => typeof value !== 'string');
    });
    const layout = params.type?.trim() ?? 'list';
    const min = params.minLevel?.trim() ?? '1';
    const max = params.maxLevel?.trim() ?? '7';
    const minLevel = Number(min), maxLevel = Number(max);
    const defaults: Record<string, string> = {
      outline: 'false', style: 'default', indent: '', separator: 'brackets', include: '', exclude: '',
      printable: 'true', class: '', absoluteUrl: 'false',
    };
    const unsupported = Object.entries(params).some(([key, value]) => {
      if (['type', 'minLevel', 'maxLevel'].includes(key)) return false;
      const parameterValue = key === 'include' || key === 'exclude' ? value : value.trim();
      return !Object.hasOwn(defaults, key) || parameterValue !== defaults[key];
    });
    const wouldIncludeExcludedHeadings = maxLevel >= 3 && maxLevel < this.sourceHeadingMaximum;
    if (malformed || unsupported || !['list', 'flat'].includes(layout) || !/^[1-3]$/.test(min) || !/^[1-7]$/.test(max) ||
        minLevel > maxLevel || wouldIncludeExcludedHeadings) {
      this.warn('TOC_PARAMETERS_UNSUPPORTED', '현재 편집기로 재현할 수 없는 목차 구조 또는 설정을 원문 코드 블록으로 보존했습니다.');
      return [codeBlock(serializeXml(node))];
    }
    if (this.context.legacyDocumentToc) {
      this.warn('LEGACY_TOC_REPRESENTATION', '이전 이관의 목차 원문 코드 블록을 확인했습니다.');
      return [codeBlock(serializeXml(node))];
    }
    return [{ type: 'documentToc', attrs: { minLevel, maxLevel: Math.min(maxLevel, 3), layout } }];
  }
  storage(title: string): RichContent[] {
    const htmlEntities: Record<string, string> = { nbsp: '160', mdash: '8212', ndash: '8211', hellip: '8230', copy: '169', reg: '174', trade: '8482', euro: '8364', lsquo: '8216', rsquo: '8217', ldquo: '8220', rdquo: '8221', laquo: '171', raquo: '187', bull: '8226', middot: '183' };
    const rawCdata: string[] = [];
    const source = this.source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|&([a-zA-Z]+);/g, (match, cdata: string | undefined, entity: string | undefined) => {
      if (cdata !== undefined) { rawCdata.push(cdata); return match; }
      return entity && htmlEntities[entity] ? `&#${htmlEntities[entity]};` : match;
    });
    if (source.includes('<?')) return this.fallback('XML 처리 지시문이 있는 저장 본문', this.source);
    const wrapped = `<migration-root>${source}</migration-root>`; parseLegacyXml(wrapped);
    const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', trimValues: false, parseTagValue: false, parseAttributeValue: false, processEntities: false, textNodeName: '#text', cdataPropName: '#cdata', maxNestedTags: 128 });
    const parsed = parser.parse(wrapped) as unknown; let cdataIndex = 0;
    const build = (value: unknown, depth: number): (XmlNode | string)[] => {
      this.tick(depth); if (!Array.isArray(value)) throw new Error('저장 XML 노드 목록이 없습니다.');
      return value.flatMap<XmlNode | string>(entry => {
        this.tick(depth); const item = object(entry);
        if (Object.hasOwn(item, '#text')) return [decodeXml(string(item['#text']))];
        if (Object.hasOwn(item, '#cdata')) { if (cdataIndex >= rawCdata.length) throw new Error('CDATA 위치가 일치하지 않습니다.'); return [rawCdata[cdataIndex++]]; }
        const name = Object.keys(item).find(key => key !== ':@'); if (!name) return [];
        if (this.richDocument && /^h[4-6]$/.test(name)) this.sourceHeadingMaximum = Math.max(this.sourceHeadingMaximum, Number(name[1]));
        const node: XmlNode = { name, attrs: Object.fromEntries(Object.entries(object(item[':@'])).map(([key, value]) => [key, decodeXml(string(value))])), children: [] };
        if (this.richDocument && !this.context.legacyDocumentExcerpt && !this.firstSourceExcerpt &&
            (name === 'ac:structured-macro' || name === 'ac:macro') && node.attrs['ac:name'] === 'excerpt') this.firstSourceExcerpt = node;
        node.children = build(item[name], depth + 1);
        return [node];
      });
    };
    const roots = build(parsed, 0); if (cdataIndex !== rawCdata.length) throw new Error('CDATA 수가 일치하지 않습니다.');
    if (this.context.sectionLinks) {
      this.sourceTitle = title;
      this.sections = scanConfluenceSections(roots, () => this.tick(), this.richDocument && !this.context.legacyDocumentLayout);
    }
    return flow(roots.flatMap(value => this.xml(value)));
  }
  wikiInline(source: string, depth = 0): RichContent[] {
    this.tick(depth); const result: RichContent[] = [], tokens = /\\|\{\{|\[|!|\*|_|\+|-|\{/g; let at = 0;
    while (at < source.length) {
      this.tick(depth); tokens.lastIndex = at; const next = tokens.exec(source);
      if (!next) { result.push(...text(source.slice(at))); break; }
      const start = next.index; result.push(...text(source.slice(at, start))); const token = next[0]; let end = -1;
      if (token === '\\' && start + 1 < source.length) { result.push(...(source[start + 1] === '\\' ? [{ type: 'hardBreak' }] : text(source[start + 1]))); at = start + 2; continue; }
      if (token === '{{' && (end = source.indexOf('}}', start + 2)) !== -1) { result.push(...text(source.slice(start + 2, end), [{ type: 'code' }])); at = end + 2; continue; }
      if (token === '[' && (end = source.indexOf(']', start + 1)) !== -1) {
        const body = source.slice(start + 1, end), separator = body.indexOf('|'), label = separator === -1 ? body : body.slice(0, separator), target = separator === -1 ? body : body.slice(separator + 1);
        if (target.startsWith('~')) { this.warn('MENTION_FLATTENED', '원본 사용자 멘션을 텍스트로 보존했습니다.'); result.push(...text(`@${target.slice(1)}`)); }
        else if (target.startsWith('^')) { const found = this.resolve({ kind: 'attachment', title: target.slice(1) }); if (found?.url) result.push(...this.link(text(separator === -1 ? found.label : label), found.url)); else { this.warn('UNRESOLVED_ATTACHMENT', '첨부 링크의 원본 파일명을 텍스트로 보존했습니다.'); result.push(...text(source.slice(start, end + 1))); } }
        else if (/^(?:(?:https?|mailto|tel|ftp|file|javascript|vbscript|data):|\/|#)/i.test(target)) {
          const reference = this.urlReference(target); result.push(...(reference ? this.reference(reference, false, separator === -1 ? '' : label) : this.link(text(label), target)));
        } else if (/^[A-Z][A-Z0-9_]*-\d+$/.test(target)) result.push(...this.reference({ kind: 'issue', sourceId: target }, false, separator === -1 ? '' : label));
        else { const page = /^([^:\s]+):(.+)$/.exec(target); result.push(...this.reference({ kind: 'page', title: page ? page[2] : target, ...(page ? { spaceKey: page[1] } : {}) }, false, separator === -1 ? '' : label)); }
        at = end + 1; continue;
      }
      if (token === '!' && (end = source.indexOf('!', start + 1)) !== -1) {
        const body = source.slice(start + 1, end), [name, ...parameters] = body.split('|'), alt = /(?:^|,)alt=([^,]+)/.exec(parameters.join(','))?.[1] || name;
        result.push(...this.image({ kind: 'attachment', ...(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(name) ? { url: name } : { title: name }) }, alt)); at = end + 1; continue;
      }
      if (['*', '_', '+', '-'].includes(token) && (start === 0 || /[\s([{:]/.test(source[start - 1])) && source[start + 1] && !/\s/.test(source[start + 1]) && (end = source.indexOf(token, start + 1)) > start + 1 && !/\s/.test(source[end - 1])) {
        result.push(...this.marked(this.wikiInline(source.slice(start + 1, end), depth + 1), { type: ({ '*': 'bold', _: 'italic', '+': 'underline', '-': 'strike' } as Record<string, string>)[token] })); at = end + 1; continue;
      }
      if (token === '{' && (end = source.indexOf('}', start + 1)) !== -1) { this.warn('UNSUPPORTED_WIKI_MACRO', '해석하지 못한 Jira 위키 매크로 표기를 원문 코드 블록으로 보존했습니다.'); result.push(codeBlock(source.slice(start, end + 1))); at = end + 1; continue; }
      result.push(...text(token)); at = start + token.length;
    }
    return result;
  }
  wikiList(lines: string[], depth: number): RichContent[] {
    let previousDepth = 0;
    const rows = lines.map(line => { const match = /^([*#]+)\s+(.*)$/.exec(line)!; let path = match[1]; if (path.length > previousDepth + 1) { path = path.slice(0, previousDepth + 1); this.warn('LIST_DEPTH_NORMALIZED', '상위 항목이 없는 목록 중첩을 읽을 수 있는 깊이로 정규화했습니다.'); } previousDepth = path.length; return { path, body: match[2] }; });
    let index = 0;
    const read = (level: number, prefix: string): RichContent => {
      this.tick(depth + level); const first = rows[index], marker = first.path[level - 1], task = marker === '*' && /^\[[ xX]\]\s+/.test(first.body), items: RichContent[] = [];
      while (index < rows.length) {
        this.tick(depth + level); const row = rows[index];
        if (row.path.length !== level || !row.path.startsWith(prefix) || row.path[level - 1] !== marker || (marker === '*' && /^\[[ xX]\]\s+/.test(row.body)) !== task) break;
        const body = task ? row.body.replace(/^\[[ xX]\]\s+/, '') : row.body;
        const item: RichContent = { type: task ? 'taskItem' : 'listItem', ...(task ? { attrs: { checked: /^\[[xX]\]/.test(row.body) } } : {}), content: ensureListItem(this.wikiInline(body, depth + level + 1)) };
        items.push(item); index++;
        while (index < rows.length && rows[index].path.length > level && rows[index].path.startsWith(row.path)) { const before = index, nested = read(level + 1, row.path); if (before === index) { this.warn('LIST_DEPTH_NORMALIZED', '상위 경로가 맞지 않는 목록 내용을 문단으로 보존했습니다.'); item.content!.push(...flow(this.wikiInline(rows[index++].body, depth + level + 1))); } else item.content!.push(nested); }
      }
      return { type: task ? 'taskList' : marker === '#' ? 'orderedList' : 'bulletList', content: items };
    };
    const result: RichContent[] = [];
    while (index < rows.length) { const before = index; result.push(read(1, '')); if (before === index) { this.warn('LIST_DEPTH_NORMALIZED', '비정형 목록 내용을 별도 문단으로 보존했습니다.'); result.push(...flow(this.wikiInline(rows[index++].body, depth + 1))); } }
    return result.filter(node => node.content?.length);
  }
  wikiCells(line: string): { header: boolean; cells: string[] } {
    const header = line.startsWith('||'), delimiter = header ? '||' : '|', cells: string[] = []; let value = line.slice(delimiter.length), at = 0, start = 0, brackets = 0, code = false;
    if (value.endsWith(delimiter)) value = value.slice(0, -delimiter.length);
    while (at < value.length) {
      if (value[at] === '\\') { at += 2; continue; }
      if (value.startsWith('{{', at)) { code = true; at += 2; continue; }
      if (value.startsWith('}}', at)) { code = false; at += 2; continue; }
      if (value[at] === '[') brackets++; else if (value[at] === ']') brackets = Math.max(0, brackets - 1);
      if (!brackets && !code && value.startsWith(delimiter, at)) { cells.push(value.slice(start, at).trim()); at += delimiter.length; start = at; } else at++;
    }
    cells.push(value.slice(start).trim()); return { header, cells };
  }
  wiki(value = this.source, depth = 0): RichContent[] {
    this.tick(depth); const lines = value.replace(/\r\n?/g, '\n').split('\n'), result: RichContent[] = []; let pending: string[] = [];
    const flush = () => { if (!pending.length) return; const nodes = pending.flatMap((line, index) => [...(index ? [{ type: 'hardBreak' }] : []), ...this.wikiInline(line, depth + 1)]); result.push(...flow(nodes)); pending = []; };
    for (let index = 0; index < lines.length; index++) {
      this.tick(depth); const line = lines[index];
      if (!line.trim()) { flush(); continue; }
      const heading = /^h([1-6])\.\s+(.*)$/.exec(line);
      if (heading) { flush(); result.push(...flow(this.wikiInline(heading[2], depth + 1), 'heading', { level: this.headingLevel(heading[1]) })); continue; }
      if (/^[*#]+\s+/.test(line)) { flush(); const list = [line]; while (index + 1 < lines.length && /^[*#]+\s+/.test(lines[index + 1])) list.push(lines[++index]); result.push(...this.wikiList(list, depth + 1)); continue; }
      if (line.startsWith('|')) { flush(); const rows = [line]; while (index + 1 < lines.length && lines[index + 1].startsWith('|')) rows.push(lines[++index]); result.push({ type: 'table', content: rows.map(row => { this.tick(depth + 1); const parsed = this.wikiCells(row); return { type: 'tableRow', content: parsed.cells.map(cell => ({ type: parsed.header ? 'tableHeader' : 'tableCell', content: flow(this.wikiInline(cell, depth + 2)) })) }; }) }); continue; }
      if (/^-{4,}$/.test(line.trim())) { flush(); result.push({ type: 'horizontalRule' }); continue; }
      if (line.startsWith('bq. ')) { flush(); result.push({ type: 'blockquote', content: flow(this.wikiInline(line.slice(4), depth + 1)) }); continue; }
      const macro = /^\{([a-zA-Z][a-zA-Z0-9_-]*)(?::([^}]*))?\}$/.exec(line.trim());
      if (macro) {
        flush(); const name = macro[1].toLowerCase(), params = macro[2] || '';
        if (name === 'include') { const page = /^([^:]+):(.+)$/.exec(params); result.push(...this.reference({ kind: 'page', title: page ? page[2] : params, ...(page ? { spaceKey: page[1] } : {}) }, true)); continue; }
        if (name === 'jira' && /^key=/.test(params)) { result.push(...this.reference({ kind: 'issue', sourceId: params.slice(4) })); continue; }
        let end = index + 1; while (end < lines.length && lines[end].trim() !== `{${macro[1]}}`) { this.tick(depth); end++; }
        if (end === lines.length) { if (['code', 'noformat', 'quote', 'panel', 'expand'].includes(name)) { this.warn('UNTERMINATED_WIKI_BLOCK', '닫히지 않은 위키 블록은 남은 원문 전체를 코드로 보존했습니다.'); result.push(codeBlock(lines.slice(index).join('\n'))); break; } result.push(...this.fallback(`위키 매크로 ${name}`, line)); continue; }
        const body = lines.slice(index + 1, end).join('\n');
        if (name === 'code' || name === 'noformat') result.push(codeBlock(body, name === 'code' ? params.replace(/^language=/, '').slice(0, 100) : ''));
        else if (name === 'expand') result.push({ type: 'details', content: [{ type: 'detailsSummary', content: text(params.replace(/^title=/, '') || '자세히 보기') }, { type: 'detailsContent', content: this.wiki(body, depth + 1) }] });
        else if (name === 'quote' || name === 'panel') { if (name === 'panel') this.warn('PANEL_FLATTENED', '위키 패널은 제목과 본문을 남긴 인용 블록으로 변환했습니다.'); result.push({ type: 'blockquote', content: [...(params ? [paragraph(text(params))] : []), ...this.wiki(body, depth + 1)] }); }
        else result.push(...this.fallback(`위키 매크로 ${name}`, lines.slice(index, end + 1).join('\n')));
        index = end; continue;
      }
      pending.push(line);
    }
    flush(); return result.length ? result : [paragraph()];
  }
  convert(record: LegacyRecord): RichContent[] {
    if (record.textFormat === 'none' || record.textFormat === 'plain') return this.plain(this.source);
    if (record.textFormat === 'adf') { const parsed = object(JSON.parse(this.source)); if (parsed.type !== 'doc' || parsed.version !== 1 || !Array.isArray(parsed.content)) throw new Error('ADF 루트 또는 버전이 올바르지 않습니다.'); return this.adf(parsed); }
    if (record.textFormat === 'confluence-storage') {
      this.richDocument = record.kind === 'page' || record.kind === 'revision';
      return this.storage(record.title);
    }
    if (record.textFormat === 'jira-wiki') return this.wiki();
    return this.fallback(record.textFormat, this.source);
  }
}

/** Pure, local conversion. Error diagnostics are blocking; callers must not
 * apply a limit/error placeholder as migrated source content. */
export function convertLegacyContent(record: LegacyRecord, context: MigrationContentContext): MigrationContentResult {
  const converter = new Converter(record.text, context);
  let content: RichContent;
  try {
    if (typeof record.text !== 'string' || Buffer.byteLength(record.text) > MAX_SOURCE_BYTES) throw new ConversionLimit('원본 본문이 변환 크기 한도를 초과했습니다.');
    content = { type: 'doc', content: converter.convert(record) };
    converter.verifyLocalSectionLinks(content);
    let count = 0; const stack = [{ node: content, depth: 0 }];
    while (stack.length) { const { node, depth } = stack.pop()!; converter.tick(depth); if (++count > MAX_NODES) throw new ConversionLimit('변환 문서 노드 수를 초과했습니다.'); for (const child of node.content || []) stack.push({ node: child, depth: depth + 1 }); }
    const normalized = normalizeDocumentContent(content);
    const sectionTargets = converter.sectionTargets(normalized.content);
    return { ...normalized, diagnostics: converter.diagnostics, ...(sectionTargets ? { sectionTargets } : {}) };
  } catch (cause) {
    if (cause instanceof ConversionLimit) converter.warn('CONVERSION_LIMIT_EXCEEDED', '원본 본문이 변환 크기·구조·작업 한도를 초과했습니다. 원본 보관 자료를 분할하거나 별도 검토해야 합니다.', 'error');
    else {
      converter.warn('RAW_CONTENT_FALLBACK', '원본 구조를 안전하게 변환할 수 없어 실행하지 않는 원문 코드 블록으로 보존했습니다.');
      try { const original = { type: 'doc', content: [codeBlock(record.text)] }; if (Buffer.byteLength(JSON.stringify(original)) <= MAX_DOCUMENT_BYTES) return { ...normalizeDocumentContent(original), diagnostics: converter.diagnostics }; } catch { /* Use the explicit blocking placeholder below. */ }
      converter.warn('CONVERSION_LIMIT_EXCEEDED', '원문 전체를 편집기 한도 안에 보존할 수 없습니다. 원본 보관 자료를 확인해야 합니다.', 'error');
    }
    content = { type: 'doc', content: [paragraph(text('본문 변환을 적용하지 않았습니다. 원본 보관 자료와 변환 오류를 확인해 주세요.'))] };
    return { ...normalizeDocumentContent(content), diagnostics: converter.diagnostics };
  }
}
