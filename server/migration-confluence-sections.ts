import { createHash } from 'node:crypto';
import { parseConfluenceColumnLayout } from './migration-confluence-layout.js';

export interface ConfluenceStorageNode { name: string; attrs: Record<string, string>; children: (ConfluenceStorageNode | string)[] }
type Node = ConfluenceStorageNode;
type Anchor = { name: string; node: Node; source: Node };
const headings = /^h[1-6]$/;
const headingInline = new Set(['b', 'strong', 'i', 'em', 's', 'strike', 'del', 'u', 'code', 'tt', 'span', 'br']);
const containers = new Set(['migration-root', 'div', 'blockquote', 'ul', 'ol', 'li', 'table', 'tbody', 'thead',
  'tfoot', 'tr', 'td', 'th', 'ac:task-list', 'ac:task', 'ac:task-body', 'ac:rich-text-body']);
const containerMacros = new Set(['info', 'warning', 'note', 'tip', 'panel', 'expand', 'details', 'excerpt']);

const isMacro = (node: Node) => node.name === 'ac:structured-macro' || node.name === 'ac:macro';
const validName = (value: string) => value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(value);
const headingFragment = (title: string) => title.replace(/\s+/gu, '');
export function legacySectionId(name: string, kind: 'anchor' | 'heading'): string {
  return `confluence-${createHash('sha256').update(JSON.stringify([kind, name])).digest('hex').slice(0, 40)}`;
}

// Storage links name the target directly. Rendered Confluence URLs may prefix it with the compact page title.
// https://confluence.atlassian.com/spaces/CONF52/pages/401441625/Working+with+Links
export function confluenceSectionAliases(fragment: string, pageTitle?: string): string[] {
  const prefix = pageTitle ? headingFragment(pageTitle) + '-' : null;
  return prefix && fragment.startsWith(prefix) && fragment.length > prefix.length ? [fragment, fragment.slice(prefix.length)] : [fragment];
}

function anchor(value: Node | string, tick: () => void): Anchor | undefined {
  if (typeof value === 'string') return;
  if (isMacro(value) && value.attrs['ac:name'] === 'anchor') {
    const parameters = value.children.filter(child => typeof child !== 'string' || child.trim());
    const parameter = parameters[0];
    if (parameters.length !== 1 || typeof parameter === 'string' || parameter.name !== 'ac:parameter' || parameter.attrs['ac:name'] || parameter.children.some(child => typeof child !== 'string')) return;
    tick();
    const name = parameter.children.join('').trim();
    return validName(name) ? { name, node: value, source: value } : undefined;
  }
  if (!['p', 'span'].includes(value.name) || Object.keys(value.attrs).length) return;
  const children = value.children.filter(child => typeof child !== 'string' || child.trim());
  const child = children[0];
  if (children.length !== 1 || typeof child === 'string' || !isMacro(child)) return;
  const result = anchor(child, tick);
  return result ? { ...result, node: value } : undefined;
}

export function scanConfluenceSections(roots: readonly (Node | string)[], tick: () => void, allowColumns: boolean) {
  const candidates: { node: Node; anchors: Anchor[]; headingAliases: string[] }[] = [];
  const declarations = new Map<string, Set<Node>>();
  function declare(name: string, node: Node) {
    const values = declarations.get(name) ?? new Set<Node>();
    values.add(node);
    declarations.set(name, values);
  }
  function countDeclarations(children: readonly (Node | string)[]) {
    for (const value of children) {
      if (typeof value === 'string') continue;
      const marker = anchor(value, tick);
      if (marker) declare(marker.name, marker.source);
      const id = value.attrs.id?.trim();
      if (id && validName(id)) declare(id, value);
      countDeclarations(value.children);
    }
  }
  countDeclarations(roots);
  function visit(children: readonly (Node | string)[], depth: number) {
    let nearby: Anchor[] = [];
    for (const value of children) {
      tick();
      if (typeof value === 'string') {
        if (value.trim()) nearby = [];
        continue;
      }
      const marker = anchor(value, tick);
      if (marker) { nearby.push(marker); continue; }
      if (headings.test(value.name)) {
        const inline: string[] = [];
        const inside: Anchor[] = [];
        function collect(children: readonly (Node | string)[]): boolean {
          return children.every(child => {
            tick();
            if (typeof child === 'string') { inline.push(child); return true; }
            const nested = anchor(child, tick);
            if (nested) { inside.push(nested); return true; }
            if (child.name === 'br') { inline.push(' '); return true; }
            return headingInline.has(child.name) && collect(child.children);
          });
        }
        if (collect(value.children)) {
          const title = inline.join('').trim().replace(/\s+/gu, ' ');
          const headingName = headingFragment(title);
          if (headingName) {
            const id = value.attrs.id?.trim();
            candidates.push({ node: value, anchors: [...nearby, ...(id && validName(id) ? [{ name: id, node: value, source: value }] : []), ...inside],
              headingAliases: [...new Set([headingName, title].filter(validName))] });
          }
        }
      } else if (containers.has(value.name)) visit(value.children, depth + 1);
      else if (allowColumns && (value.name === 'ac:layout' || isMacro(value) && value.attrs['ac:name'] === 'section')) {
        for (const row of parseConfluenceColumnLayout(value, depth === 1) ?? []) {
          for (const column of row.columns) visit(column.children, depth + 3);
        }
      } else if (isMacro(value) && containerMacros.has(value.attrs['ac:name'])) {
        const body = value.children.find(child => typeof child !== 'string' && ['ac:rich-text-body', 'ac:plain-text-body'].includes(child.name));
        if (body && typeof body !== 'string') visit(body.children, depth + 2);
      }
      nearby = [];
    }
  }
  visit(roots, 0);
  const aliases = new Map<string, Node | null>();
  for (const candidate of candidates) {
    for (const name of [...candidate.anchors.map(value => value.name), ...candidate.headingAliases]) {
      tick();
      aliases.set(name, aliases.has(name) && aliases.get(name) !== candidate.node ? null : candidate.node);
    }
  }
  const targets = new Map<string, string>(), ids = new Map<Node, string>(), bound = new Set<Node>();
  const candidatesByNode = new Map(candidates.map(candidate => [candidate.node, candidate]));
  for (const [name, sources] of declarations) {
    const target = aliases.get(name);
    if (target && (sources.size !== 1 || !candidatesByNode.get(target)?.anchors.some(marker => marker.name === name && sources.has(marker.source)))) aliases.set(name, null);
  }
  for (const { node, anchors, headingAliases } of candidates) {
    const firstAnchor = anchors.find(marker => aliases.get(marker.name) === node);
    const headingName = headingAliases.find(name => aliases.get(name) === node);
    if (!firstAnchor && !headingName) continue;
    const sectionId = firstAnchor ? legacySectionId(firstAnchor.name, 'anchor') : legacySectionId(headingName!, 'heading');
    ids.set(node, sectionId);
    for (const name of [...anchors.map(value => value.name), ...headingAliases]) if (aliases.get(name) === node) targets.set(name, sectionId);
    for (const marker of anchors) if (marker.node !== node && aliases.get(marker.name) === node) bound.add(marker.node);
  }
  return { targets, ids, bound };
}
