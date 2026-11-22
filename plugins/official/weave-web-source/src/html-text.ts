const hiddenTags = new Set(['script', 'style', 'template', 'noscript', 'svg']);
const rawTags = new Set(['script', 'style', 'noscript']);
const blockTags = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'caption',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);
const entities: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(?:[xX][\da-fA-F]+|\d+)|[A-Za-z][A-Za-z\d]*);/g, (entity: string) => {
    const name = entity.slice(1, -1);
    if (name[0] !== '#') return Object.hasOwn(entities, name) ? entities[name]! : entity;
    const hex = name[1] === 'x' || name[1] === 'X';
    const value = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value)
      : entity;
  });
}

function normalizeText(text: string): string {
  return decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly end: number;
}

function readTag(html: string, start: number): Tag | undefined {
  let position = start + 1;
  const closing = html[position] === '/';
  if (closing) position += 1;
  if (!/[A-Za-z]/.test(html[position] ?? '')) return undefined;
  const nameStart = position;
  while (/[A-Za-z\d:-]/.test(html[position] ?? '')) position += 1;
  const name = html.slice(nameStart, position).toLowerCase();
  if (!/[\s/>]/.test(html[position] ?? '')) return undefined;
  let quote = '';
  for (; position < html.length; position += 1) {
    const character = html[position]!;
    if (quote !== '') {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>')
      return { name, closing, selfClosing: html[position - 1] === '/', end: position + 1 };
  }
  return { name, closing, selfClosing: false, end: html.length };
}

/** A bounded, single-pass text extractor; no DOM, script or subresource execution. */
export function htmlToText(html: string): { title: string; text: string } {
  const visible: string[] = [];
  const title: string[] = [];
  const hidden: string[] = [];
  let headDepth = 0;
  let inTitle = false;
  let index = 0;
  while (index < html.length) {
    const raw = hidden[hidden.length - 1];
    if (raw !== undefined && rawTags.has(raw)) {
      const close = html.indexOf('</', index);
      if (close < 0) break;
      const nameEnd = close + 2 + raw.length;
      if (
        html.slice(close + 2, nameEnd).toLowerCase() === raw &&
        /[\s/>]/.test(html[nameEnd] ?? '')
      ) {
        const tag = readTag(html, close);
        if (tag) {
          hidden.pop();
          index = tag.end;
          continue;
        }
      }
      index = close + 2;
      continue;
    }
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[index] === '<') {
      if (html[index + 1] === '!' || html[index + 1] === '?') {
        const end = html.indexOf('>', index + 2);
        index = end < 0 ? html.length : end + 1;
        continue;
      }
      const tag = readTag(html, index);
      if (tag) {
        index = tag.end;
        const suppressed = hidden[hidden.length - 1];
        if (suppressed) {
          if (tag.closing && tag.name === suppressed) hidden.pop();
          else if (
            !rawTags.has(suppressed) &&
            !tag.closing &&
            (!tag.selfClosing || tag.name !== 'svg') &&
            hiddenTags.has(tag.name)
          )
            hidden.push(tag.name);
          continue;
        }
        if (inTitle) {
          if (tag.closing && tag.name === 'title') inTitle = false;
          continue;
        }
        if (hiddenTags.has(tag.name)) {
          if (!tag.closing && (!tag.selfClosing || tag.name !== 'svg')) hidden.push(tag.name);
          continue;
        }
        if (tag.name === 'head') {
          headDepth = Math.max(0, headDepth + (tag.closing ? -1 : 1));
          continue;
        }
        if (tag.name === 'title') {
          if (!tag.closing && !tag.selfClosing) inTitle = true;
          continue;
        }
        if (headDepth > 0) continue;
        if (blockTags.has(tag.name)) visible.push('\n');
        if (tag.name === 'li' && !tag.closing) visible.push('- ');
        continue;
      }
    }
    const next = html.indexOf('<', index + 1);
    const end = next < 0 ? html.length : next;
    const part = html.slice(index, end);
    if (inTitle) title.push(part);
    else if (hidden.length === 0 && headDepth === 0) visible.push(part);
    index = end;
  }
  return {
    title: normalizeText(title.join('')).replace(/\n/g, ' '),
    text: normalizeText(visible.join('')),
  };
}
