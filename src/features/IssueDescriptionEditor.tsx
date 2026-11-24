'use client';

import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bold, Code2, Heading2, Link2, List, ListChecks } from 'lucide-react';
import { lexer, type MarkedToken, type Token } from 'marked';
import { parseDocumentHash } from '../../shared/document-sections';
import type { IssueDescriptionFormat } from '../../shared/types';
import './issue-description-editor.css';

type Props = {
  value: string;
  format: IssueDescriptionFormat;
  onChange: (value: string) => void;
  onFormatChange: (format: IssueDescriptionFormat) => void;
  disabled?: boolean;
  name?: string;
  initialPreview?: boolean;
};

const MAX_DESCRIPTION = 200_000;
const MAX_PREVIEW_NODES = 12_000;
const MAX_PREVIEW_DEPTH = 45;
const DESCRIPTION_PLACEHOLDER = '배경, 목표, 완료 조건을 적어주세요.';
const TOO_LONG = '설명은 200,000자까지 입력할 수 있습니다.';
const MINIMUM_FORMAT = 'plain';
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®' };
const headingTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

function displayText(value: string) {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([A-Za-z]+));/g,
    (raw, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : raw;
      const number = decimal === undefined ? Number.parseInt(hex ?? '', 16) : Number(decimal);
      return number > 0 && number <= 0x10ffff && (number < 0xd800 || number > 0xdfff) ? String.fromCodePoint(number) : raw;
    });
}

function safeLink(value: string) {
  const href = value.trim();
  if (/[\\\u0000-\u001f\u007f]/u.test(value) || !href) return undefined;
  if (/^\/(?!\/)/u.test(href)) return href;
  try {
    const url = new URL(href);
    if (/^https?:\/\/[^/]/iu.test(href) && url.hostname && !url.username && !url.password) return href;
    if (url.protocol === 'mailto:' && url.pathname && !/%0[ad]/iu.test(href)) return href;
  } catch { /* Keep the link caption as text. */ }
  return undefined;
}

type PreviewBudget = { remaining: number; inertLinks: boolean };

function spend(budget: PreviewBudget, depth: number) {
  if (depth > MAX_PREVIEW_DEPTH || --budget.remaining < 0) throw new Error('Markdown preview bounds');
}

function renderTokens(tokens: readonly Token[], budget: PreviewBudget, depth = 0, insideLink = false): ReactNode {
  return tokens.map((raw, index) => {
    spend(budget, depth);
    const token = raw as MarkedToken;
    const content = (children: readonly Token[]) => renderTokens(children, budget, depth + 1, insideLink);
    switch (token.type) {
      case 'space':
      case 'def':
      case 'checkbox':
        return null;
      case 'heading': {
        const Tag = headingTags[token.depth - 1] ?? 'h6';
        return <Tag key={index}>{content(token.tokens)}</Tag>;
      }
      case 'paragraph': return <p key={index}>{content(token.tokens)}</p>;
      case 'text':
        return <span key={index}>{token.tokens?.length ? content(token.tokens) : token.escaped ? token.text : displayText(token.text)}</span>;
      case 'escape': return <span key={index}>{token.text}</span>;
      case 'strong': return <strong key={index}>{content(token.tokens)}</strong>;
      case 'em': return <em key={index}>{content(token.tokens)}</em>;
      case 'del': return <del key={index}>{content(token.tokens)}</del>;
      case 'code': return <pre key={index}><code>{token.text}</code></pre>;
      case 'codespan': return <code key={index}>{token.text}</code>;
      case 'br': return <br key={index} />;
      case 'hr': return <hr key={index} />;
      case 'blockquote': return <blockquote key={index}>{content(token.tokens)}</blockquote>;
      case 'list': {
        const ListTag = token.ordered ? 'ol' : 'ul';
        return <ListTag key={index} start={typeof token.start === 'number' && token.ordered ? token.start : undefined}>
          {token.items.map((item, itemIndex) => {
            spend(budget, depth + 1);
            return <li key={itemIndex} data-task={item.task || undefined}>
              {item.task && <input type="checkbox" checked={Boolean(item.checked)} disabled readOnly aria-label="체크 항목" />}
              {content(item.tokens)}
            </li>;
          })}
        </ListTag>;
      }
      case 'table':
        return <div key={index} className="issue-description-table"><table>
          <thead><tr>{token.header.map((cell, column) => {
            spend(budget, depth + 1);
            return <th key={column} scope="col" style={{ textAlign: cell.align ?? undefined }}>{content(cell.tokens)}</th>;
          })}</tr></thead>
          <tbody>{token.rows.map((row, rowIndex) => {
            spend(budget, depth + 1);
            return <tr key={rowIndex}>{row.map((cell, column) => {
              spend(budget, depth + 1);
              return <td key={column} style={{ textAlign: cell.align ?? undefined }}>{content(cell.tokens)}</td>;
            })}</tr>;
          })}</tbody>
        </table></div>;
      case 'link': {
        const href = insideLink || budget.inertLinks ? undefined : safeLink(token.href);
        const documentLink = href?.startsWith('/#/') && parseDocumentHash(href.slice(1));
        const label = token.autolink ? token.text
          : token.tokens.length ? renderTokens(token.tokens, budget, depth + 1, true) : displayText(token.text) || '링크';
        return href ? <a key={index} href={href} title={token.title ?? undefined} target={documentLink ? undefined : '_blank'} rel="noopener noreferrer">{label}</a>
          : <span key={index}>{label}</span>;
      }
      case 'image': {
        const href = insideLink || budget.inertLinks ? undefined : safeLink(token.href);
        const label = token.text ? `${displayText(token.text)} (이미지)` : '이미지';
        return href ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <span key={index}>{label}</span>;
      }
      case 'html':
        return token.block ? <p className="issue-description-literal" key={index}>{token.raw}</p> : <span key={index}>{token.raw}</span>;
      default: return <span key={index}>{raw.raw}</span>;
    }
  });
}

const tools = [
  { id: 'heading', label: '제목', icon: Heading2 },
  { id: 'bold', label: '굵게', icon: Bold },
  { id: 'list', label: '목록', icon: List },
  { id: 'task', label: '체크리스트', icon: ListChecks },
  { id: 'code', label: '코드 블록', icon: Code2 },
  { id: 'link', label: '링크', icon: Link2 },
] as const;
type EditAction = typeof tools[number]['id'];

function markdownEdit(value: string, start: number, end: number, action: EditAction) {
  const selected = value.slice(start, end);
  if (action === 'heading' || action === 'list' || action === 'task') {
    const prefix = action === 'heading' ? '## ' : action === 'list' ? '- ' : '- [ ] ';
    const lineStart = value.slice(0, start).lastIndexOf('\n') + 1;
    const lastCharacter = end > start && value[end - 1] === '\n' ? end - 1 : end;
    const nextBreak = value.indexOf('\n', lastCharacter);
    const lineEnd = nextBreak === -1 ? value.length : nextBreak;
    const current = value.slice(lineStart, lineEnd);
    const block = (current || (action === 'heading' ? '제목' : '항목')).split('\n').map(line => prefix + line).join('\n');
    const selectionStart = start === end && current ? start + prefix.length : lineStart + prefix.length;
    return {
      value: value.slice(0, lineStart) + block + value.slice(lineEnd),
      start: selectionStart,
      end: start === end && current ? selectionStart : lineStart + block.length,
    };
  }

  let text = selected || '텍스트';
  let leading = '**';
  let trailing = '**';
  if (action === 'code') {
    text = selected || '코드';
    const width = (text.match(/`+/gu) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3);
    const fence = '`'.repeat(width);
    leading = (start && value[start - 1] !== '\n' ? '\n' : '') + fence + '\n';
    trailing = '\n' + fence + (end < value.length && value[end] !== '\n' ? '\n' : '');
  }
  if (action === 'link') {
    leading = `[${(selected || '링크 제목').replace(/([\\[\]])/gu, '\\$1')}](`;
    text = 'https://';
    trailing = ')';
  }
  return { value: value.slice(0, start) + leading + text + trailing + value.slice(end),
    start: start + leading.length, end: start + leading.length + text.length };
}

export function ReadonlyIssueDescription({ value, format, inertLinks = false }: {
  value: string; format: IssueDescriptionFormat; inertLinks?: boolean;
}) {
  const preview = useMemo(() => {
    if (!value.trim() || format !== 'markdown') return null;
    try {
      if (value.length > MAX_DESCRIPTION || !value.isWellFormed() || value.includes('\u0000')) throw new Error('Markdown preview bounds');
      return { body: renderTokens(lexer(value, { gfm: true }), { remaining: MAX_PREVIEW_NODES, inertLinks }), fallback: false };
    } catch {
      return { body: value, fallback: true };
    }
  }, [format, inertLinks, value]);

  return <section className="issue-description-preview" aria-label="설명 미리보기">
    {preview?.fallback ? <>
      <p className="issue-description-note" role="status">미리보기를 표시할 수 없어 설명 원문을 보여줍니다.</p>
      <div className="issue-description-literal">{preview.body}</div>
    </> : preview?.body ?? (value.trim() ? <div className="issue-description-literal">{value}</div>
      : <p className="issue-description-note">작성된 설명이 없습니다.</p>)}
  </section>;
}

export function IssueDescriptionEditor({ value, format, onChange, onFormatChange, disabled, name, initialPreview }: Props) {
  const uid = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [view, setView] = useState<'edit' | 'preview'>(initialPreview && format === 'markdown' ? 'preview' : 'edit');
  const [toolMessage, setToolMessage] = useState('');
  const formatted = format === 'markdown';
  const showPreview = formatted && view === 'preview';

  function applyFormat(action: EditAction) {
    const field = input.current;
    if (disabled || !field || showPreview) return;
    const edit = markdownEdit(value, field.selectionStart, field.selectionEnd, action);
    if (edit.value.length > MAX_DESCRIPTION) {
      setToolMessage(TOO_LONG);
      return;
    }
    setToolMessage('');
    onChange(edit.value);
    requestAnimationFrame(() => {
      if (input.current !== field || field.value !== edit.value || field.closest('[hidden]')) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(edit.start, edit.end);
    });
  }

  return <div className="issue-description-editor">
    <div className="issue-description-editor-header">
      <div className="issue-description-format">
        <label htmlFor={`${uid}-format`}>설명 서식</label>
        <select id={`${uid}-format`} className="field" value={formatted ? 'markdown' : MINIMUM_FORMAT} disabled={disabled}
          onChange={event => {
            setView('edit');
            setToolMessage('');
            onFormatChange(event.currentTarget.value === 'markdown' ? 'markdown' : 'plain');
          }}>
          <option value="plain">일반 텍스트</option>
          <option value="markdown">Markdown</option>
        </select>
      </div>
      {formatted && <div className="issue-description-mode" role="group" aria-label="설명 보기">
        <button className="btn btn-ghost" type="button" aria-pressed={!showPreview} disabled={disabled} onClick={() => setView('edit')}>편집</button>
        <button className="btn btn-ghost" type="button" aria-pressed={showPreview} disabled={disabled} onClick={() => setView('preview')}>미리보기</button>
      </div>}
    </div>
    <div className="issue-description-source" hidden={showPreview}>
      <label htmlFor={`${uid}-source`} className="issue-form-label">설명</label>
      {formatted && <div className="issue-description-toolbar" role="group" aria-label="Markdown 서식">
        {tools.map(({ id, label, icon: Icon }) => <button className="btn btn-ghost" type="button" disabled={disabled}
          aria-label={label} title={label} key={id} onMouseDown={event => event.preventDefault()} onClick={() => applyFormat(id)}>
          <Icon size={15} aria-hidden="true" />
        </button>)}
      </div>}
      <textarea id={`${uid}-source`} className="field issue-description-input" ref={input} name={name} value={value} disabled={disabled}
        placeholder={DESCRIPTION_PLACEHOLDER} rows={5} maxLength={MAX_DESCRIPTION} onChange={event => {
          if (toolMessage) setToolMessage('');
          onChange(event.currentTarget.value);
        }} />
      {toolMessage && <p className="issue-description-note" role="status">{toolMessage}</p>}
    </div>
    {showPreview && <ReadonlyIssueDescription value={value} format={format} />}
  </div>;
}
