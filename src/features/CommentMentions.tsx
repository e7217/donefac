'use client';

import { Fragment, useEffect, useId, useImperativeHandle, useRef, useState, type ComponentPropsWithoutRef, type Ref } from 'react';
import { MAX_COMMENT_MENTIONS, type Comment, type CommentMention, type User } from '../../shared/types';
import './comment-mentions.css';

export type CommentDraft = { body: string; mentions: CommentMention[] };
type CommentContent = { body: string; mentions?: readonly CommentMention[] };
type InputProps = Omit<ComponentPropsWithoutRef<'textarea'>, 'children' | 'defaultValue' | 'onChange' | 'value'> & {
  draft: CommentDraft;
  onChange(draft: CommentDraft): void;
  users: readonly User[];
  textareaRef?: Ref<HTMLTextAreaElement>;
};
type Range = Pick<CommentMention, 'from' | 'to'>;
type InputEdit = Range & { body: string; inputType: string };
type MentionQuery = Range & { text: string };

const cachePrefix = 'teamspace:comment-draft:1\n';
const queryLimit = 120;

export function emptyCommentDraft(): CommentDraft {
  return { body: '', mentions: [] };
}

export function sameCommentDraft(a: CommentContent, b: CommentContent): boolean {
  const left = a.mentions ?? [];
  const right = b.mentions ?? [];
  return a.body === b.body && left.length === right.length && left.every((mention, index) =>
    mention.userId === right[index].userId && mention.from === right[index].from && mention.to === right[index].to);
}

export function encodeCommentDraft(draft: CommentDraft): string {
  return `${cachePrefix}${JSON.stringify(draft)}`;
}

export function decodeCommentDraft(raw: string | null): CommentDraft {
  if (!raw) return emptyCommentDraft();
  if (raw.startsWith(cachePrefix)) {
    try {
      const value = JSON.parse(raw.slice(cachePrefix.length)) as Partial<CommentDraft> | null;
      if (typeof value?.body === 'string') return { body: value.body, mentions: readDraftMentions(value.mentions, value.body) };
    } catch {
      // Older drafts were plain text and may start with the same prefix.
    }
  }
  return { body: raw, mentions: [] };
}

function readDraftMentions(value: unknown, body: string): CommentMention[] {
  if (!Array.isArray(value) || value.length > MAX_COMMENT_MENTIONS) return [];
  const mentions: CommentMention[] = [];
  let previousEnd = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') return [];
    const { userId, from, to } = item as Partial<CommentMention>;
    if (typeof userId !== 'string' || !userId || typeof from !== 'number' || typeof to !== 'number' ||
        !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < previousEnd || to - from < 2 ||
        to > body.length || body[from] !== '@') return [];
    mentions.push({ userId, from, to });
    previousEnd = to;
  }
  return mentions;
}

export function commentDraftPayload(draft: CommentDraft): { body: string; mentions?: CommentMention[] } {
  const body = draft.body.trim();
  if (!draft.mentions.length) return { body };
  const leading = draft.body.length - draft.body.trimStart().length;
  const shifted = draft.mentions.map(({ userId, from, to }) => ({ userId, from: from - leading, to: to - leading }));
  const mentions = readDraftMentions(shifted, body);
  return mentions.length ? { body, mentions } : { body };
}

function editRange(previous: string, next: string, caret: number, edit: InputEdit | null): Range {
  const delta = next.length - previous.length;
  if (edit?.body === previous) {
    let { from, to } = edit;
    if (from === to && edit.inputType.startsWith('delete')) {
      from = Math.min(from, caret);
      to = from - delta;
    }
    const replacementEnd = to + delta;
    if (to <= previous.length && replacementEnd >= from && replacementEnd <= next.length &&
        previous.slice(0, from) === next.slice(0, from) && previous.slice(to) === next.slice(replacementEnd)) {
      return { from, to };
    }
  }

  let from = 0;
  const sharedPrefixLimit = Math.min(previous.length, next.length, caret);
  while (from < sharedPrefixLimit && previous[from] === next[from]) from++;
  let to = previous.length;
  let nextEnd = next.length;
  while (to > from && nextEnd > from && previous[to - 1] === next[nextEnd - 1]) {
    to--;
    nextEnd--;
  }
  return { from, to };
}

function mentionsAfterEdit(mentions: readonly CommentMention[], { from, to }: Range, delta: number): CommentMention[] {
  return mentions.flatMap(mention => {
    if (mention.to <= from) return [mention];
    if (mention.from >= to) return [{ userId: mention.userId, from: mention.from + delta, to: mention.to + delta }];
    return [];
  });
}

function mentionQuery({ body, mentions }: CommentDraft, cursor: Range | null): MentionQuery | null {
  if (!cursor || cursor.from !== cursor.to || cursor.to === 0 || mentions.length >= MAX_COMMENT_MENTIONS) return null;
  const to = cursor.to;
  const recent = body.slice(Math.max(0, to - queryLimit - 2), to);
  const offset = to - recent.length;
  let from = recent.lastIndexOf('@');
  while (from >= 0 && offset + from > 0 && !/[\s([{"'“‘,:;]/u.test(body[offset + from - 1])) {
    from = from > 0 ? recent.lastIndexOf('@', from - 1) : -1;
  }
  if (from < 0 || mentions.some(range => range.from <= offset + from && offset + from < range.to)) return null;
  const text = recent.slice(from + 1);
  if (text.length > queryLimit || !/^[\p{L}\p{M}\p{N}_.+@ -]*$/u.test(text)) return null;
  return { from: offset + from, to, text };
}

function cursorRange(field: HTMLTextAreaElement): Range {
  return { from: field.selectionStart, to: field.selectionEnd };
}

function searchText(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase();
}

export function CommentMentionInput({ draft, onChange, users, textareaRef, disabled, readOnly, maxLength = 20_000,
  onBlur, onFocus, onSelect, onKeyDown, onCompositionStart, onCompositionEnd, ...props }: InputProps) {
  const listId = useId();
  const region = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const edit = useRef<InputEdit | null>(null);
  const [cursor, setCursor] = useState<Range | null>(null);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<{ body: string; at: number } | null>(null);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const query = disabled || readOnly || composing || (dismissed?.body === draft.body && dismissed.at === cursor?.to)
    ? null : mentionQuery(draft, cursor);
  const term = searchText(query?.text.trim() ?? '');
  const choices = query ? users.filter(user => searchText(user.name).includes(term) || searchText(user.email).includes(term)) : [];
  const selectedIndex = Math.max(0, choices.findIndex(user => user.id === activeUserId));

  useImperativeHandle(textareaRef, () => textarea.current!, []);
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const beforeInput = (event: Event) => {
      edit.current = { ...cursorRange(element), body: element.value, inputType: (event as InputEvent).inputType ?? '' };
    };
    element.addEventListener('beforeinput', beforeInput);
    return () => element.removeEventListener('beforeinput', beforeInput);
  }, []);

  function insert(user: User) {
    const element = textarea.current;
    if (!query || !element || element.value !== draft.body || cursorRange(element).to !== query.to ||
        cursorRange(element).from !== query.to || document.activeElement !== element && !region.current?.contains(document.activeElement)) return;
    const token = `@${user.name}`;
    const nextCharacter = draft.body.charAt(query.to);
    const space = /[\s,.!?;:…，。！？；：)\]}]/u.test(nextCharacter) ? '' : ' ';
    const insertion = token + space;
    const body = draft.body.slice(0, query.from) + insertion + draft.body.slice(query.to);
    if (body.length > maxLength) return;
    const mentions = mentionsAfterEdit(draft.mentions, query, body.length - draft.body.length);
    mentions.push({ userId: user.id, from: query.from, to: query.from + token.length });
    mentions.sort((left, right) => left.from - right.from);
    const caret = query.from + insertion.length + (/^[ \t]$/u.test(nextCharacter) ? 1 : 0);
    onChange({ body, mentions });
    edit.current = null;
    setCursor({ from: caret, to: caret });
    setActiveUserId(null);
    requestAnimationFrame(() => {
      if (textarea.current === element && element.value === body && region.current?.contains(document.activeElement)) {
        element.focus({ preventScroll: true });
        element.setSelectionRange(caret, caret);
      }
    });
  }

  return <div ref={region} className="comment-mention-input">
    <textarea {...props} ref={textarea} value={draft.body} disabled={disabled} readOnly={readOnly} maxLength={maxLength}
      aria-autocomplete="list" aria-haspopup="listbox" aria-controls={choices.length ? listId : undefined}
      aria-activedescendant={choices.length ? `${listId}-${selectedIndex}` : undefined}
      onChange={event => {
        const field = event.currentTarget;
        const body = field.value;
        const nextCursor = cursorRange(field);
        const mentions = draft.mentions.length ? mentionsAfterEdit(
          draft.mentions, editRange(draft.body, body, nextCursor.to, edit.current), body.length - draft.body.length,
        ) : [];
        edit.current = null;
        setCursor(nextCursor);
        setDismissed(null);
        setActiveUserId(null);
        onChange({ body, mentions });
      }}
      onFocus={event => { setCursor(cursorRange(event.currentTarget)); onFocus?.(event); }}
      onBlur={event => {
        if (!region.current?.contains(event.relatedTarget)) {
          setCursor(null);
          setComposing(false);
          setDismissed(null);
          setActiveUserId(null);
        }
        onBlur?.(event);
      }}
      onSelect={event => { setCursor(cursorRange(event.currentTarget)); onSelect?.(event); }}
      onCompositionStart={event => { setComposing(true); onCompositionStart?.(event); }}
      onCompositionEnd={event => {
        setComposing(false);
        setCursor(cursorRange(event.currentTarget));
        onCompositionEnd?.(event);
      }}
      onKeyDown={event => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || !query || !choices.length) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const step = event.key === 'ArrowUp' ? -1 : 1;
          const index = (selectedIndex + step + choices.length) % choices.length;
          setActiveUserId(choices[index].id);
          document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          insert(choices[selectedIndex]);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDismissed({ body: draft.body, at: query.to });
        }
      }} />
    {choices.length > 0 && <div id={listId} className="comment-mention-list" role="listbox" aria-label="팀원 멘션">
      {choices.map((user, index) => <button id={`${listId}-${index}`} key={user.id} type="button" role="option" tabIndex={-1}
        aria-selected={selectedIndex === index} className="comment-mention-option"
        onMouseDown={event => event.preventDefault()} onClick={() => insert(user)}>
        <strong>{user.name}</strong><span>{user.email}</span>
      </button>)}
    </div>}
  </div>;
}

export function CommentMentionText({ comment }: { comment: Pick<Comment, 'body' | 'mentions'> }) {
  const mentions = readDraftMentions(comment.mentions, comment.body);
  return <>{mentions.map(({ userId, from, to }, index) => <Fragment key={from}>
    {comment.body.slice(mentions[index - 1]?.to ?? 0, from)}
    <span className="comment-mention-text" data-mention-user-id={userId}>{comment.body.slice(from, to)}</span>
  </Fragment>)}{comment.body.slice(mentions.at(-1)?.to ?? 0)}</>;
}
