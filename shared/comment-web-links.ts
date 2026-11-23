export interface CommentWebLinkRange {
  from: number;
  to: number;
  href: string;
}

const boundary = /[\s([{<"'‘“（［【「『]/u;
const rawUrl = /https?:\/\/[^\s<>"'‘’“”]+/giu;
const invalidUrlCharacter = /[\s\p{Cc}\p{Cf}\\<>"'‘’“”]/u;
const sentenceEnd = /[.,;:!?…、。，；：！？]/u;
const exactQuotes = new Map([['<', '>'], ['"', '"'], ["'", "'"], ['‘', '’'], ['“', '”']]);
const brackets = new Map([[')', '('], [']', '['], ['}', '{'], ['）', '（'], ['］', '［'], ['】', '【'], ['」', '「'], ['』', '『']]);

/** Accept a literal web address without changing its path, query, or fragment. */
export function commentWebUrl(value: string): string | undefined {
  const href = value.trim();
  const authority = /^https?:\/\/([^/?#]+)/iu.exec(href)?.[1];
  if (!authority || authority.includes('@') || invalidUrlCharacter.test(href) || !href.isWellFormed()) return undefined;
  try {
    const url = new URL(href);
    if (url.hostname && !url.username && !url.password) return href;
  } catch { /* Keep invalid addresses as comment text. */ }
  return undefined;
}

function literalEnd(address: string, left: string, right: string): number {
  // Angle delimiters preserve exact destinations from Jira, including terminal punctuation.
  if (right && exactQuotes.get(left) === right) return address.length;
  const balance = new Map<string, number>();
  for (let offset = 0; offset < address.length; offset++) {
    const character = address[offset];
    const opener = brackets.get(character);
    if (opener) {
      const count = balance.get(opener) ?? 0;
      if (opener === left && count === 0) return offset;
      balance.set(opener, count - 1);
    } else if ('([{（［【「『'.includes(character)) {
      balance.set(character, (balance.get(character) ?? 0) + 1);
    }
  }
  let end = address.length;
  while (end > 0) {
    const character = address[end - 1];
    const opener = brackets.get(character);
    if (opener) {
      const count = balance.get(opener) ?? 0;
      if (count >= 0) break;
      balance.set(opener, count + 1);
    } else if (!sentenceEnd.test(character)) break;
    end--;
  }
  return end;
}

/** Offsets use UTF-16, like the existing comment mention ranges. */
export function commentWebLinkRanges(body: string): readonly CommentWebLinkRange[] {
  const links: CommentWebLinkRange[] = [];
  for (const match of body.matchAll(rawUrl)) {
    const from = match.index;
    const left = body[from - 1] ?? '';
    if (left && !boundary.test(left)) continue;
    const address = match[0];
    const length = literalEnd(address, left, body[from + address.length] ?? '');
    const href = commentWebUrl(address.slice(0, length));
    if (href) links.push({ from, to: from + length, href });
  }
  return links;
}
