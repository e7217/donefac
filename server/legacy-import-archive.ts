import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { XMLValidator } from 'fast-xml-parser';
import { fromBufferPromise, getFileNameLowLevel, type Entry } from 'yauzl';
import type { LegacyFile } from '../shared/types.js';

export class LegacyArchiveError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}
export const LEGACY_MAX_RAW_BYTES = 64 * 1024 * 1024;
export const LEGACY_MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
export const LEGACY_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const LEGACY_MAX_FILES = 5000;
export const LEGACY_MAX_XML_DEPTH = 128;
export const LEGACY_MAX_XML_NODES = 500000;
export const LEGACY_MAX_XML_ATTRIBUTES = 128;
const MAX_PATH_LENGTH = 1024, MAX_XML_NAME_LENGTH = 512, MAX_ATTRIBUTE_LENGTH = 1024 * 1024;
function fail(message: string, status = 400): never { throw new LegacyArchiveError(status, message); }
const xmlSpace = /^[\x20\t\r\n]*$/;
const nameStart = ':A-Z_a-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02ff\\u0370-\\u037d\\u037f-\\u1fff\\u200c-\\u200d\\u2070-\\u218f\\u2c00-\\u2fef\\u3001-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufffd\\u{10000}-\\u{effff}';
const xmlName = new RegExp(`^[${nameStart}][${nameStart}.0-9\\-\\u00b7\\u0300-\\u036f\\u203f-\\u2040]*$`, 'u');
export interface LegacyXmlNode { name: string; attributes: Record<string, string>; children: LegacyXmlNode[]; text: string }

function checkName(name: string) {
  if (!name || name.length > MAX_XML_NAME_LENGTH || !xmlName.test(name)) fail('XML 요소 또는 속성 이름을 확인해 주세요.');
}
function xmlCharacter(code: number) { return code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff; }
function checkCharacters(text: string) {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (!xmlCharacter(code)) fail('XML에 허용되지 않는 문자 또는 손상된 유니코드가 있습니다.');
    if (code > 0xffff) i++;
  }
}
function decodeEntities(text: string): string {
  const parts: string[] = []; let offset = 0, at = text.indexOf('&');
  while (at !== -1) {
    parts.push(text.slice(offset, at));
    const end = text.indexOf(';', at + 1);
    if (end === -1 || end - at > 32) fail('XML 문자 참조를 확인해 주세요.');
    const name = text.slice(at + 1, end), predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, name)) parts.push(predefined[name]);
    else if (/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name)) {
      const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (!Number.isSafeInteger(code) || !xmlCharacter(code)) fail('XML 문자 참조에 허용되지 않는 코드가 있습니다.');
      parts.push(String.fromCodePoint(code));
    } else fail('XML에 정의되지 않은 엔티티가 있습니다.');
    offset = end + 1; at = text.indexOf('&', offset);
  }
  parts.push(text.slice(offset)); return parts.join('');
}
function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null); let at = 0, count = 0;
  while (at < source.length) {
    const whitespace = /^[\x20\t\r\n]+/.exec(source.slice(at));
    if (!whitespace) fail('XML 속성 사이에 공백이 필요합니다.');
    at += whitespace[0].length; if (at === source.length) break;
    const match = /^([^\x20\t\r\n=]+)[\x20\t\r\n]*=[\x20\t\r\n]*(["'])/.exec(source.slice(at));
    if (!match) fail('XML 속성은 따옴표로 감싼 값이 필요합니다.');
    const name = match[1]; checkName(name);
    if (++count > LEGACY_MAX_XML_ATTRIBUTES) fail('XML 요소의 속성 수가 제한을 초과했습니다.', 413);
    if (Object.hasOwn(result, name)) fail('XML에 중복된 속성이 있습니다.');
    at += match[0].length; const end = source.indexOf(match[2], at);
    if (end === -1) fail('XML 속성의 닫는 따옴표가 없습니다.');
    const value = source.slice(at, end);
    if (value.length > MAX_ATTRIBUTE_LENGTH) fail('XML 속성 값이 제한을 초과했습니다.', 413);
    if (value.includes('<')) fail('XML 속성 값의 여는 꺾쇠는 문자 참조로 표시해야 합니다.');
    result[name] = decodeEntities(value); at = end + 1;
  }
  return result;
}
function declaredEncoding(text: string): string | undefined {
  const declaration = /^<\?xml[\x20\t\r\n]+[\s\S]*?\?>/.exec(text)?.[0];
  return declaration ? /\bencoding[\x20\t\r\n]*=[\x20\t\r\n]*["']([^"']+)["']/.exec(declaration)?.[1].toLowerCase().replaceAll('-', '') : undefined;
}

/** Decode text strictly; a BOM is required for UTF-16, and byte/declaration
 * disagreement is rejected rather than replacing damaged bytes. */
export function decodeLegacyText(bytes: Buffer): string {
  if (!Buffer.isBuffer(bytes)) return fail('파일 바이트가 필요합니다.');
  if (bytes.length > LEGACY_MAX_FILE_BYTES) fail('개별 파일은 64 MiB 이하여야 합니다.', 413);
  if (bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0])) || bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) fail('UTF-32 인코딩은 지원하지 않습니다.');
  let encoding: 'utf8' | 'utf16le' | 'utf16be' = 'utf8', offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf16le'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf16be'; offset = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  let text: string;
  try { text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset)); }
  catch { return fail('파일이 올바른 UTF-8 또는 BOM이 있는 UTF-16이 아닙니다.'); }
  if (text.includes('\u0000')) fail('텍스트에 NUL 문자가 있습니다. UTF-16 파일은 BOM이 필요합니다.');
  const declared = declaredEncoding(text);
  if (declared && !['utf8', 'utf16', 'utf16le', 'utf16be'].includes(declared)) fail('선언된 문자 인코딩은 지원하지 않습니다. UTF-8 또는 BOM이 있는 UTF-16을 사용하세요.');
  if (declared && (encoding === 'utf8' ? declared !== 'utf8' : declared !== 'utf16' && declared !== encoding)) fail('파일 바이트와 XML 인코딩 선언이 일치하지 않습니다.');
  return text;
}

/** A bounded, non-resolving XML tree. The lexer preserves CDATA exactly;
 * fast-xml-parser's normal parser normalizes CRLF even inside CDATA. */
export function parseLegacyXml(input: string): LegacyXmlNode {
  if (typeof input !== 'string') return fail('XML 문자열이 필요합니다.');
  if (Buffer.byteLength(input, 'utf8') > LEGACY_MAX_FILE_BYTES) fail('XML 크기가 제한을 초과했습니다.', 413);
  const xml = input.startsWith('\ufeff') ? input.slice(1) : input;
  checkCharacters(xml);
  const stack: LegacyXmlNode[] = []; let root: LegacyXmlNode | undefined, at = 0, nodes = 0;
  const count = () => { if (++nodes > LEGACY_MAX_XML_NODES) fail('XML 노드 수가 제한을 초과했습니다.', 413); };
  while (at < xml.length) {
    if (xml[at] !== '<') {
      count();
      const next = xml.indexOf('<', at), end = next === -1 ? xml.length : next, text = xml.slice(at, end);
      if (text.includes(']]>')) fail('XML 일반 텍스트에 CDATA 닫기 문자를 사용할 수 없습니다.');
      if (!stack.length) { if (!xmlSpace.test(text)) fail('XML 루트 요소 밖에 텍스트가 있습니다.'); }
      else stack[stack.length - 1].text += decodeEntities(text);
      at = end; continue;
    }
    if (xml.startsWith('<!--', at)) {
      count();
      const end = xml.indexOf('-->', at + 4); if (end === -1) fail('XML 주석이 닫히지 않았습니다.');
      const text = xml.slice(at + 4, end); if (text.includes('--') || text.endsWith('-')) fail('XML 주석 안에 연속 하이픈이 있습니다.');
      at = end + 3; continue;
    }
    if (xml.startsWith('<![CDATA[', at)) {
      count();
      const end = xml.indexOf(']]>', at + 9); if (end === -1 || !stack.length) fail('CDATA 위치 또는 닫기 문자를 확인해 주세요.');
      stack[stack.length - 1].text += xml.slice(at + 9, end); at = end + 3; continue;
    }
    if (xml.startsWith('<?', at)) {
      count();
      const end = xml.indexOf('?>', at + 2); if (end === -1) fail('XML 처리 지시문이 닫히지 않았습니다.');
      const body = xml.slice(at + 2, end), target = /^[^\x20\t\r\n]+/.exec(body)?.[0] || ''; checkName(target);
      if (target.toLowerCase() === 'xml') {
        if (target !== 'xml' || at !== 0 || !/^xml[\x20\t\r\n]+version[\x20\t\r\n]*=[\x20\t\r\n]*(["'])1\.0\1(?:[\x20\t\r\n]+encoding[\x20\t\r\n]*=[\x20\t\r\n]*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:[\x20\t\r\n]+standalone[\x20\t\r\n]*=[\x20\t\r\n]*(["'])(?:yes|no)\3)?[\x20\t\r\n]*$/.test(body)) fail('XML 1.0 선언을 확인해 주세요.');
        const encoding = declaredEncoding(xml); if (encoding && !['utf8', 'utf16', 'utf16le', 'utf16be'].includes(encoding)) fail('선언된 XML 인코딩은 지원하지 않습니다.');
      }
      at = end + 2; continue;
    }
    if (xml.startsWith('<!', at)) fail('XML DTD·ENTITY 선언과 외부 엔티티는 지원하지 않습니다.');
    let end = at + 1, quote = '';
    for (; end < xml.length; end++) {
      const char = xml[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') fail('XML 태그 안에 잘못된 여는 꺾쇠가 있습니다.');
    }
    if (end === xml.length || quote) fail('XML 태그가 닫히지 않았습니다.');
    const body = xml.slice(at + 1, end);
    if (body.startsWith('/')) {
      const name = body.slice(1).replace(/[\x20\t\r\n]+$/, ''); checkName(name);
      if (!stack.length || stack[stack.length - 1].name !== name) fail('XML 여는 태그와 닫는 태그가 일치하지 않습니다.');
      stack.pop();
    } else {
      count();
      const selfClosing = body.endsWith('/'), source = selfClosing ? body.slice(0, -1) : body;
      const name = /^[^\x20\t\r\n]+/.exec(source)?.[0] || ''; checkName(name);
      if (stack.length + 1 > LEGACY_MAX_XML_DEPTH) fail('XML 중첩 깊이가 제한을 초과했습니다.', 413);
      const node: LegacyXmlNode = { name, attributes: attributes(source.slice(name.length)), children: [], text: '' };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (root) fail('XML은 루트 요소가 하나여야 합니다.');
      else root = node;
      if (!selfClosing) stack.push(node);
    }
    at = end + 1;
  }
  if (!root || stack.length) fail('XML 루트 또는 닫히지 않은 요소를 확인해 주세요.');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new LegacyArchiveError(400, '올바른 XML 문서가 아닙니다.', { line: valid.err.line, column: valid.err.col, code: valid.err.code });
  return root;
}

function safePath(path: string): string {
  if (!path || path.length > MAX_PATH_LENGTH || /[\x00-\x1f\x7f\\\ufffd]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path)) fail('아카이브 파일 경로를 확인해 주세요.');
  const value = path.endsWith('/') ? path.slice(0, -1) : path;
  if (!value || value.split('/').some(part => !part || part === '.' || part === '..')) fail('아카이브에 상대 경로 이동 또는 빈 경로가 있습니다.');
  return value;
}
function entryMode(entry: Entry): number { return entry.externalFileAttributes >>> 16 & 0xf000; }
function digest(path: string, bytes: Buffer): LegacyFile { return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
type ZipReadOptions = {
  maxExpandedBytes?: number;
  maxFileBytes?: number;
  normalizeEntryName?: (name: string) => string;
};

export async function readLegacyArchive(bytes: Buffer, filename: string, options: ZipReadOptions = {}):
  Promise<{ files: Map<string, Buffer>; manifest: LegacyFile[]; expandedBytes: number }> {
  if (!Buffer.isBuffer(bytes)) return fail('파일 바이트가 필요합니다.');
  if (bytes.length > LEGACY_MAX_RAW_BYTES) fail('원본 파일은 64 MiB 이하여야 합니다.', 413);
  const path = safePath(filename), extension = /\.([^.\/]+)$/.exec(path)?.[1].toLowerCase();
  if (!['zip', 'xml', 'csv', 'json'].includes(extension || '')) fail('ZIP·XML·CSV·JSON 파일만 지원합니다.');
  if (extension !== 'zip') return { files: new Map([[path, bytes]]), manifest: [digest(path, bytes)], expandedBytes: bytes.length };
  const files = new Map<string, Buffer>(), manifest: LegacyFile[] = [], seen = new Set<string>(), kinds = new Map<string, 'file' | 'directory'>();
  let expandedBytes = 0, entryCount = 0;
  const maxExpandedBytes = Math.min(LEGACY_MAX_EXPANDED_BYTES, options.maxExpandedBytes ?? LEGACY_MAX_EXPANDED_BYTES);
  const maxFileBytes = Math.min(LEGACY_MAX_FILE_BYTES, options.maxFileBytes ?? LEGACY_MAX_FILE_BYTES);
  try {
    const zip = await fromBufferPromise(bytes, { autoClose: false, lazyEntries: true, decodeStrings: !options.normalizeEntryName, strictFileNames: true, validateEntrySizes: true });
    try {
      const entries: { entry: Entry; directory: boolean; name: string }[] = []; let declaredExpandedBytes = 0;
      if (zip.entryCount > LEGACY_MAX_FILES) fail('아카이브 항목 수는 5,000개 이하여야 합니다.', 413);
      for await (const entry of zip.eachEntry()) {
        if (++entryCount > LEGACY_MAX_FILES) fail('아카이브 항목 수는 5,000개 이하여야 합니다.', 413);
        const originalName = options.normalizeEntryName
          ? getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, true)
          : entry.fileName;
        const entryName = options.normalizeEntryName?.(originalName) ?? originalName;
        const name = safePath(entryName), key = name.normalize('NFC').toLowerCase();
        if (seen.has(key)) fail('아카이브에 중복되거나 대소문자만 다른 파일 경로가 있습니다.'); seen.add(key);
        if (entry.generalPurposeBitFlag & 0x800) {
          try { new TextDecoder('utf-8', { fatal: true }).decode(entry.fileNameRaw); } catch { fail('아카이브 파일 이름의 UTF-8이 손상되었습니다.'); }
        }
        if (entry.isEncrypted() || entry.generalPurposeBitFlag & 0x40 || ![0, 8].includes(entry.compressionMethod)) fail('암호화 또는 지원하지 않는 압축 방식입니다.');
        const mode = entryMode(entry), directory = entryName.endsWith('/') || mode === 0x4000 || Boolean(entry.externalFileAttributes & 0x10);
        if (mode && mode !== 0x8000 && mode !== 0x4000) fail('심볼릭 링크와 특수 파일은 가져올 수 없습니다.');
        if (mode === 0x8000 && directory) fail('아카이브 파일·디렉터리 종류가 일치하지 않습니다.');
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > maxFileBytes) fail(`압축 해제 개별 파일은 ${maxFileBytes / 1024 / 1024} MiB 이하여야 합니다.`, 413);
        if (directory && entry.uncompressedSize !== 0) fail('디렉터리 항목에 파일 데이터가 있습니다.');
        if (kinds.get(key) === 'file' || !directory && kinds.get(key) === 'directory') fail('아카이브 파일과 디렉터리 경로가 충돌합니다.');
        kinds.set(key, directory ? 'directory' : 'file');
        const segments = key.split('/');
        for (let i = 1; i < segments.length; i++) { const parent = segments.slice(0, i).join('/'); if (kinds.get(parent) === 'file') fail('아카이브 상위 경로가 파일입니다.'); kinds.set(parent, 'directory'); }
        declaredExpandedBytes += entry.uncompressedSize;
        if (declaredExpandedBytes > maxExpandedBytes) fail(`압축 해제 합계는 ${maxExpandedBytes / 1024 / 1024} MiB 이하여야 합니다.`, 413);
        entries.push({ entry, directory, name });
      }
      for (const { entry, directory, name } of entries) {
        const stream = await zip.openReadStreamPromise(entry); const chunks: Buffer[] = []; let size = 0, checksum = 0;
        try {
          for await (const raw of stream) {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += chunk.length; expandedBytes += chunk.length;
            if (size > maxFileBytes || expandedBytes > maxExpandedBytes) fail('실제 압축 해제 크기가 제한을 초과했습니다.', 413);
            checksum = crc32(chunk, checksum); chunks.push(chunk);
          }
        } finally { stream.destroy(); }
        if (size !== entry.uncompressedSize || checksum !== entry.crc32) fail('아카이브 파일 크기 또는 CRC가 일치하지 않습니다.');
        if (!directory) { const content = Buffer.concat(chunks, size); files.set(name, content); manifest.push(digest(name, content)); }
      }
      return { files, manifest, expandedBytes };
    } finally { zip.close(); }
  } catch (cause) {
    if (cause instanceof LegacyArchiveError) throw cause;
    throw new LegacyArchiveError(400, '손상되었거나 지원하지 않는 ZIP 아카이브입니다.');
  }
}
