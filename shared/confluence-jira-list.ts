import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { JIRA_SAVED_VIEW_QUERY_LIMIT } from './types.js';

export interface ConfluenceJiraList {
  jql: string;
  server?: string;
  maximumIssues?: number;
  columns?: string;
}

const MAX_MACRO_LENGTH = 64 * 1024;
const parser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', processEntities: false,
  parseTagValue: false, parseAttributeValue: false, trimValues: false, maxNestedTags: 3,
});
const macroAttributes = new Set(['ac:name', 'ac:schema-version', 'ac:macro-id', 'ac:local-id', 'xmlns:ac', 'xmlns:ri']);
const listParameters = new Set(['jqlQuery', 'server', 'serverId', 'maximumIssues', 'columns', 'count', 'cache', 'renderMode', 'anonymous']);
const xmlWhitespace = /^[\t\n\r ]*$/u;
const invalidXmlCharacter = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const xmlEntities = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);
const parameterName = new Set(['ac:name']);
type XmlPart = Record<string, unknown>;

function decodeText(text: string): string | undefined {
  let unknownReference = false;
  const decoded = text.replace(/&([^&;\s]+);|&/gu, (_match, name: string | undefined) => {
    const predefined = name && xmlEntities.get(name);
    if (predefined) return predefined;
    if (name && /^(?:#\d+|#x[0-9a-fA-F]+)$/u.test(name)) {
      const codepoint = Number(name.startsWith('#x') ? `0x${name.slice(2)}` : name.slice(1));
      if (codepoint <= 0x10FFFF) return String.fromCodePoint(codepoint);
    }
    unknownReference = true;
    return '';
  });
  return unknownReference || invalidXmlCharacter.test(decoded) ? undefined : decoded;
}

function attributes(part: XmlPart, allowed: ReadonlySet<string>): Record<string, string> | undefined {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, raw] of Object.entries(part[':@'] ?? {})) {
    const value = typeof raw === 'string' && !raw.includes('<') ? decodeText(raw) : undefined;
    if (!allowed.has(key) || value === undefined) return undefined;
    result[key] = value;
  }
  return result;
}

function element(part: XmlPart, tag: string): XmlPart[] | undefined {
  const children = part[tag];
  return Array.isArray(children) && Object.keys(part).every(key => key === tag || key === ':@') ? children as XmlPart[] : undefined;
}

function plainText(parts: XmlPart[]): string | undefined {
  let value = '';
  for (const part of parts) {
    const text = part['#text'];
    if (typeof text !== 'string' || Object.keys(part).length !== 1) return undefined;
    value += text;
  }
  return decodeText(value);
}

/** Extract the literal JQL from one standalone Confluence list macro without resolving any external reference. */
export function parseConfluenceJiraList(value: string): ConfluenceJiraList | undefined {
  if (value.length > MAX_MACRO_LENGTH) return undefined;
  const xml = value.trim();
  const start = /^<(ac:(?:structured-macro|macro))(?=[\t\n\r >])/u.exec(xml);
  if (!start || /<!|<\?|\]\]>/u.test(xml) || invalidXmlCharacter.test(xml) || XMLValidator.validate(xml) !== true) return undefined;

  let parsed: XmlPart[];
  try { parsed = parser.parse(xml) as XmlPart[]; }
  catch { return undefined; }
  if (parsed.length !== 1) return undefined;
  const [macro] = parsed;
  const children = element(macro, start[1]);
  const root = attributes(macro, macroAttributes);
  const name = root?.['ac:name']?.toLowerCase();
  if (!children || !root || (name !== 'jira' && name !== 'jiraissues') ||
      (root['ac:schema-version'] ?? '1') !== '1' ||
      (root['xmlns:ac'] ?? 'http://atlassian.com/content') !== 'http://atlassian.com/content' ||
      (root['xmlns:ri'] ?? 'http://atlassian.com/resource/identifier') !== 'http://atlassian.com/resource/identifier') return undefined;

  const parameters = new Map<string, string>();
  for (const child of children) {
    if (Object.keys(child).length === 1 && typeof child['#text'] === 'string' && xmlWhitespace.test(child['#text'])) continue;
    const lines = element(child, 'ac:parameter');
    const parameter = attributes(child, parameterName)?.['ac:name'];
    const text = lines && plainText(lines);
    if (!parameter || !listParameters.has(parameter) || parameters.has(parameter) || text === undefined) return undefined;
    parameters.set(parameter, text.trim());
  }

  const jql = parameters.get('jqlQuery');
  const count = parameters.get('count')?.toLowerCase() ?? 'false';
  const anonymous = parameters.get('anonymous')?.toLowerCase() ?? 'false';
  const cache = parameters.get('cache')?.toLowerCase() ?? 'on';
  const renderMode = parameters.get('renderMode')?.toLowerCase() ?? 'static';
  if (!jql || jql.length > JIRA_SAVED_VIEW_QUERY_LIMIT || count !== 'false' || anonymous !== 'false' ||
      !['on', 'off', 'true', 'false'].includes(cache) || !['static', 'dynamic'].includes(renderMode)) return undefined;

  const rows = parameters.get('maximumIssues');
  const maximumIssues = rows === undefined ? undefined : Number(rows);
  if (rows !== undefined && (!/^[1-9]\d*$/u.test(rows) || !Number.isSafeInteger(maximumIssues))) return undefined;
  const server = parameters.get('server');
  const columns = parameters.get('columns');
  return { jql, ...(server ? { server } : {}), ...(columns ? { columns } : {}), ...(maximumIssues === undefined ? {} : { maximumIssues }) };
}
