import { XMLParser } from 'fast-xml-parser';
import type { LegacyRecord, RichContent } from '../shared/types.js';
import { normalizeDocumentContent, MAX_DOCUMENT_BYTES } from './document-content.js';
import { parseLegacyXml } from './legacy-import-archive.js';

// Format references (conversion is local and never requests these URLs):
// https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html
// https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
export interface MigrationReferenceInput { kind: 'page' | 'issue' | 'attachment'; sourceId?: string; title?: string; spaceKey?: string; url?: string }
export interface MigrationContentContext { resolveReference: (input: MigrationReferenceInput) => { id: string; label: string; url?: string } | null }
export interface MigrationContentDiagnostic { severity: 'warning' | 'error'; code: string; message: string }
export interface MigrationContentResult { content: RichContent; plainText: string; diagnostics: MigrationContentDiagnostic[] }
const MAX_SOURCE_BYTES = 16 * 1024 * 1024, MAX_NODES = 30000, MAX_DEPTH = 50, MAX_WORK = 100000, MAX_MS = 2500;
type Mark = NonNullable<RichContent['marks']>[number];
const text = (value: string, marks?: Mark[]): RichContent[] => value ? [{ type: 'text', text: value, ...(marks?.length ? { marks } : {}) }] : [];
const paragraph = (content: RichContent[] = []): RichContent => ({ type: 'paragraph', content });
const inline = (node: RichContent) => node.type === 'text' || node.type === 'hardBreak';
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
interface XmlNode { name: string; attrs: Record<string, string>; children: (XmlNode | string)[] }
const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function serializeXml(node: XmlNode | string): string { return typeof node === 'string' ? escapeXml(node) : `<${node.name}${Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('')}>${node.children.map(serializeXml).join('')}</${node.name}>`; }
function decodeXml(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|apos|quot);/g, (_, entity: string) => entity.startsWith('#') ? String.fromCodePoint(entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : named[entity]);
}
class Converter {
  diagnostics: MigrationContentDiagnostic[] = []; private codes = new Set<string>(); private work = 0; private started = performance.now();
  constructor(readonly source: string, readonly context: MigrationContentContext) {}
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
  plain(value: string): RichContent[] { return value.replace(/\r\n?/g, '\n').split('\n').map(line => { this.tick(); return paragraph(text(line)); }); }
  span(value: unknown): number { const number = Number(value ?? 1); if (!Number.isSafeInteger(number) || number < 1 || number > 100) { this.warn('TABLE_SPAN_NORMALIZED', '잘못되었거나 너무 큰 표 셀 병합 수를 1로 바꿨습니다.'); return 1; } return number; }
  headingLevel(value: unknown): number { const level = Number(value || 1); if (![1, 2, 3].includes(level)) this.warn('HEADING_LEVEL_NORMALIZED', '편집기가 지원하는 제목 1~3단계로 정규화했습니다.'); return Math.max(1, Math.min(3, Number.isFinite(level) ? level : 1)); }
  urlReference(url: string): MigrationReferenceInput | null {
    if (/\/browse\/[A-Za-z][A-Za-z0-9_]*-\d+(?:[?#/]|$)/.test(url)) return { kind: 'issue', url };
    if (/[?&]pageId=|\/(?:display|spaces)\//.test(url)) return { kind: 'page', url };
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
      case 'panel': this.warn('PANEL_FLATTENED', 'ADF 패널은 종류를 제목으로 남긴 인용 블록으로 변환했습니다.'); return [{ type: 'blockquote', content: [paragraph(text(`[${string(attrs.panelType) || '패널'}]`)), ...flow(children())] }];
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
      case 'status': this.warn('STATUS_FLATTENED', '본문 상태 배지는 상태 텍스트로 보존했습니다.'); return text(`[상태: ${string(attrs.text) || string(attrs.color)}]`);
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
      if (['b', 'strong', 'i', 'em', 's', 'strike', 'del', 'u', 'code', 'tt', 'span', 'br'].includes(value.name)) return false;
      if (['ac:structured-macro', 'ac:macro'].includes(value.name) && value.attrs['ac:name'] === 'status') return false;
      if (value.name === 'ac:link' && value.children.some(child => typeof child !== 'string' && child.name === 'ri:attachment')) return false;
      return true;
    };
    return children.flatMap((child, index) => blockLayout && typeof child === 'string' && !child.trim() && (isBlock(children[index - 1]) || isBlock(children[index + 1])) ? [] : this.xml(child, depth + 1));
  }
  xml(node: XmlNode | string, depth = 0): RichContent[] {
    this.tick(depth); if (typeof node === 'string') return text(node);
    const type = node.name, children = () => this.xmlParts(node.children, depth), child = (name: string) => node.children.find(value => typeof value !== 'string' && value.name === name) as XmlNode | undefined;
    if (/^h[1-6]$/.test(type)) return flow(children(), 'heading', { level: this.headingLevel(type.slice(1)) });
    if (['b', 'strong', 'i', 'em', 's', 'strike', 'del', 'u', 'code', 'tt'].includes(type)) return this.marked(children(), { type: ({ b: 'bold', strong: 'bold', i: 'italic', em: 'italic', s: 'strike', strike: 'strike', del: 'strike', u: 'underline', code: 'code', tt: 'code' } as Record<string, string>)[type] });
    switch (type) {
      case 'migration-root': case 'div': case 'ac:rich-text-body': return this.xmlParts(node.children, depth, true);
      case 'p': return flow(children());
      case 'span': {
        let nodes = children(); const style = node.attrs.style || '';
        if (/text-decoration\s*:\s*line-through/i.test(style)) nodes = this.marked(nodes, { type: 'strike' });
        if (/text-decoration\s*:\s*underline/i.test(style)) nodes = this.marked(nodes, { type: 'underline' });
        if (style && !/^\s*text-decoration\s*:\s*(?:line-through|underline)\s*;?\s*$/i.test(style)) this.warn('UNSUPPORTED_TEXT_STYLE', '색상·배치 등 지원하지 않는 문자 스타일은 원문 보관 자료에 남기고 텍스트를 유지했습니다.');
        return nodes;
      }
      case 'br': return [{ type: 'hardBreak' }];
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
        const values = children(); return reference ? this.reference(reference, false, label) : this.link(values.length ? values : text(url), url);
      }
      case 'ac:link': {
        const page = child('ri:page'), attachment = child('ri:attachment'), body = child('ac:plain-text-link-body') || child('ac:link-body'), label = body ? this.xmlText(body) : '';
        if (page) return this.reference({ kind: 'page', sourceId: page.attrs['ri:content-id'] || page.attrs['ri:page-id'], title: page.attrs['ri:content-title'], spaceKey: page.attrs['ri:space-key'] }, false, label);
        if (attachment) { const input: MigrationReferenceInput = { kind: 'attachment', sourceId: attachment.attrs['ri:content-id'], title: attachment.attrs['ri:filename'] }, found = this.resolve(input); if (found?.url) return this.link(text(label || found.label), found.url); this.warn('UNRESOLVED_ATTACHMENT', '첨부 링크를 이관 대상 파일로 확정하지 못해 원본 파일명을 보존했습니다.'); return text(`[첨부: ${label || input.title || input.sourceId || '원본 파일'}]`); }
        if (node.attrs['ac:anchor']) { this.warn('ANCHOR_FLATTENED', '원본 페이지 내 앵커 링크는 앵커 이름을 텍스트로 보존했습니다.'); return text(`${label || '앵커'} (#${node.attrs['ac:anchor']})`); }
        return this.fallback('해석할 수 없는 Confluence 링크', serializeXml(node));
      }
      case 'ac:image': {
        const attachment = child('ri:attachment'), url = child('ri:url');
        return this.image({ kind: 'attachment', sourceId: attachment?.attrs['ri:content-id'], title: attachment?.attrs['ri:filename'], url: url?.attrs['ri:value'] }, node.attrs['ac:alt'] || node.attrs['ac:title'] || '');
      }
      case 'img': return this.image({ kind: 'attachment', url: node.attrs.src }, node.attrs.alt || '');
      case 'ac:task-list': return [{ type: 'taskList', content: node.children.filter(value => typeof value !== 'string' || value.trim()).flatMap(value => this.xml(value, depth + 1)) }];
      case 'ac:task': { const body = child('ac:task-body'), status = child('ac:task-status'); return [{ type: 'taskItem', attrs: { checked: Boolean(status && this.xmlText(status).trim() === 'complete') }, content: flow(body ? this.xmlParts(body.children, depth + 1, true) : []) }]; }
      case 'ac:structured-macro': case 'ac:macro': return this.macro(node, depth + 1);
      default: return this.fallback(`XML ${type}`, serializeXml(node));
    }
  }
  macro(node: XmlNode, depth: number): RichContent[] {
    this.tick(depth); const name = node.attrs['ac:name'] || '', params: Record<string, string> = Object.create(null);
    for (const child of node.children) if (typeof child !== 'string' && child.name === 'ac:parameter') params[child.attrs['ac:name'] || ''] = this.xmlText(child);
    const body = node.children.find(value => typeof value !== 'string' && ['ac:rich-text-body', 'ac:plain-text-body'].includes(value.name)) as XmlNode | undefined;
    const blocks = () => flow(body ? this.xmlParts(body.children, depth + 1, true) : []);
    if (name === 'code' || name === 'noformat') return [codeBlock(body ? this.xmlText(body) : '', name === 'code' ? (params.language || '').slice(0, 100) : '')];
    if (name === 'expand' || name === 'details') return [{ type: 'details', content: [{ type: 'detailsSummary', content: text(params.title || '자세히 보기') }, { type: 'detailsContent', content: blocks() }] }];
    if (['info', 'warning', 'note', 'tip', 'panel'].includes(name)) { this.warn('PANEL_FLATTENED', '안내·경고 패널은 종류와 제목을 남긴 인용 블록으로 변환했습니다.'); return [{ type: 'blockquote', content: [paragraph(text(`[${name}]${params.title ? ` ${params.title}` : ''}`)), ...blocks()] }]; }
    if (name === 'include') { const page = this.findXml(node, 'ri:page'); return this.reference({ kind: 'page', sourceId: page?.attrs['ri:content-id'] || page?.attrs['ri:page-id'], title: page?.attrs['ri:content-title'] || params[''] || params.page, spaceKey: page?.attrs['ri:space-key'] }, true); }
    if ((name === 'jira' || name === 'jiraissues') && params.key) return this.reference({ kind: 'issue', sourceId: params.key });
    if (name === 'status') { this.warn('STATUS_FLATTENED', '본문 상태 매크로는 상태 텍스트로 보존했습니다.'); return text(`[상태: ${params.title || params.colour || '상태'}]`); }
    if (name === 'excerpt') { this.warn('EXCERPT_FLATTENED', '발췌문 정의는 본문으로 유지했으며 발췌 범위 의미는 원본 보관 자료에 남습니다.'); return blocks(); }
    this.warn('UNSUPPORTED_MACRO', '지원하지 않는 동적·확장 매크로를 실행하지 않고 원문 코드 블록으로 보존했습니다.');
    return [codeBlock(serializeXml(node))];
  }
  storage(): RichContent[] {
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
        return [{ name, attrs: Object.fromEntries(Object.entries(object(item[':@'])).map(([key, value]) => [key, decodeXml(string(value))])), children: build(item[name], depth + 1) }];
      });
    };
    const roots = build(parsed, 0); if (cdataIndex !== rawCdata.length) throw new Error('CDATA 수가 일치하지 않습니다.');
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
    if (record.textFormat === 'confluence-storage') return this.storage();
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
    let count = 0; const stack = [{ node: content, depth: 0 }];
    while (stack.length) { const { node, depth } = stack.pop()!; converter.tick(depth); if (++count > MAX_NODES) throw new ConversionLimit('변환 문서 노드 수를 초과했습니다.'); for (const child of node.content || []) stack.push({ node: child, depth: depth + 1 }); }
    return { ...normalizeDocumentContent(content), diagnostics: converter.diagnostics };
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
