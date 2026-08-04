import type { ComponentChildren } from 'preact';
import { CopyButton } from './CopyButton.js';

type Part =
  | { type: 'code'; lang?: string; code: string }
  | { type: 'text'; text: string };

/** Splits fenced code blocks; an unclosed trailing fence (mid-stream) renders as code. */
function splitFences(src: string): Part[] {
  const parts: Part[] = [];
  const re = /```([\w+.-]*)\r?\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push({ type: 'text', text: src.slice(last, m.index) });
    parts.push({ type: 'code', lang: m[1] || undefined, code: m[2] ?? '' });
    last = m.index + m[0].length;
  }
  const rest = src.slice(last);
  const openIdx = rest.indexOf('```');
  if (openIdx === -1) {
    if (rest) parts.push({ type: 'text', text: rest });
  } else {
    if (openIdx > 0) parts.push({ type: 'text', text: rest.slice(0, openIdx) });
    const afterFence = rest.slice(openIdx + 3);
    const nl = afterFence.indexOf('\n');
    parts.push({
      type: 'code',
      lang: nl === -1 ? undefined : afterFence.slice(0, nl).trim() || undefined,
      code: nl === -1 ? '' : afterFence.slice(nl + 1),
    });
  }
  return parts;
}

/** Inline: `code`, **bold**, [link](url). Everything is built as DOM nodes — no raw HTML. */
function renderInline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code class="md-inline">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<a href={m[5]}>{m[4]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderTextBlock(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const header = /^(#{1,4})\s+(.*)$/.exec(line);
    if (header) out.push(<span class="md-h">{renderInline(header[2]!)}</span>);
    else if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      out.push(<span class="md-li">{renderInline(line)}</span>);
    } else out.push(...renderInline(line));
    if (i < lines.length - 1) out.push('\n');
  });
  return out;
}

const KEYWORDS = new Set(
  (
    'const let var function return if else for while class import export from async await new ' +
    'try catch finally throw type interface extends implements static public private readonly ' +
    'def elif lambda pass with as in not and or is None True False null undefined true false ' +
    'fn pub struct impl match enum use mod func package switch case break continue default do ' +
    'void int string bool number float double select go defer chan map range yield print'
  ).split(' '),
);

const HASH_COMMENT_LANGS = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'yaml', 'yml', 'rb', 'ruby', 'toml']);

/** Tiny regex highlighter: comments, strings, numbers, keywords. No dependencies. */
function highlight(code: string, lang?: string): ComponentChildren[] {
  const hashComments = !lang || HASH_COMMENT_LANGS.has(lang.toLowerCase());
  const re = new RegExp(
    [
      `(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/${hashComments ? '|#[^\\n]*' : ''})`,
      `("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,
      `\\b(\\d+(?:\\.\\d+)?)\\b`,
      `\\b([A-Za-z_][\\w]*)\\b`,
    ].join('|'),
    'g',
  );
  const out: ComponentChildren[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    if (m[1]) out.push(<span class="hl-com">{m[1]}</span>);
    else if (m[2]) out.push(<span class="hl-str">{m[2]}</span>);
    else if (m[3]) out.push(<span class="hl-num">{m[3]}</span>);
    else if (m[4]) {
      if (KEYWORDS.has(m[4])) out.push(<span class="hl-kw">{m[4]}</span>);
      else out.push(m[4]);
    }
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const parts = splitFences(text);
  return (
    <div class="md">
      {parts.map((p, i) =>
        p.type === 'code' ? (
          <pre class="md-code" key={i}>
            {p.lang && <span class="md-code-lang">{p.lang}</span>}
            <CopyButton text={p.code.replace(/\n$/, '')} label="Copy code" className="code-copy" />
            <code>{highlight(p.code.replace(/\n$/, ''), p.lang)}</code>
          </pre>
        ) : (
          <span class="md-text" key={i}>
            {renderTextBlock(p.text)}
          </span>
        ),
      )}
    </div>
  );
}
