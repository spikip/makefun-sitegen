// A fast, byte-exact reimplementation of the makefun-site 1.0.0 static site
// generator, written for the site-generator-speed-01 competition.
//
// run(input) takes one case's { site, templates, files } and returns the same
// output tree (path -> text) the reference build returns. The semantics —
// front matter, the Markdown subset, the template dialect, the slug rule and
// the build report — follow the reference's README and behaviour exactly;
// the machinery is built for CPU: templates are compiled once per case into
// generated functions, Markdown is rendered in a single pass over the lines
// with a range-based inline renderer, escaping copies whole clean runs at a
// time, and slug/date/link work is memoised within the case. Nothing is kept
// between cases.

// ---------------------------------------------------------------- text rules

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** HTML escaping (& < > " '), in one scan; most values hold none. */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(text);
  if (m === null) return text;
  let out = text.slice(0, m.index) + ESC_MAP[m[0]];
  let last = m.index + 1;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESC_MAP[m[0]];
    last = m.index + 1;
  }
  return out + text.slice(last);
}

const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when empty.
 * Pure-ASCII input skips normalisation (NFKD is the identity there and ASCII
 * holds no combining marks); kept characters are all ASCII, so scanning code
 * units matches scanning code points.
 */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  const parts = date.split('-');
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

/** JavaScript's whitespace (the \s class) as a table over UTF-16 code units. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;

/** Whether a UTF-16 code unit is JavaScript whitespace (the \s class). */
function isWsCode(c) {
  return WS_TABLE[c] === 1;
}

/** The number of words in `text`: its runs of non-whitespace characters. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      count++;
      inWord = true;
    }
  }
  return count;
}

// ------------------------------------------------------------ front matter
//
// A source opens on a line "---" and its front matter runs to the next line
// "---"; every line between is blank, a comment ("#" first) or "key: value"
// with one space after the colon. Seven keys are known, each with its own
// value grammar; anything else refuses the file with the first reason met.

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    let seg = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(seg, i) + nx;
        i++;
        seg = i + 1;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
    }
    out += raw.slice(seg, raw.length - 1);
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      if (ok) {
        let prevDash = true; // a leading dash is as bad as a doubled one
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) {
            if (prevDash) { ok = false; break; }
            prevDash = true;
          } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
          else { ok = false; break; }
        }
        if (prevDash) ok = false; // trailing dash
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The body is sliced
 * out of the source, never split and rejoined.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  const data = {};
  let pos = firstNl === -1 ? text.length + 1 : firstNl + 1;
  let lineNo = 2;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: nl === -1 ? '' : text.slice(nl + 1) };
    }
    // blank lines and comments are skipped
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // "key: value": the key is [a-z_]+, then ":", then end-of-line or " " + value
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      let raw = null;
      if (j > 0 && line.charCodeAt(j) === 58) {
        if (j + 1 === line.length) raw = '';
        else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
      }
      if (raw === null) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, j);
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c === 32 || c === 9) e--;
        else break;
      }
      if (e !== raw.length) raw = raw.slice(0, e);
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  return { error: 'the front matter is not closed' };
}

// ---------------------------------------------------------------- Markdown
//
// The reference's own subset: ATX headings (each with an id), fenced code,
// thematic breaks, blockquotes, flat lists and paragraphs; inline code
// spans, strong, emphasis, links and backslash escapes. Rendered in one
// pass over the source's lines; the inline renderer works on index ranges
// of the original string instead of slices.

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence opening's language, or null: ``` plus [A-Za-z0-9_+-]* plus blanks. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return i === n ? line.slice(3, langEnd) : null;
}

/** Whether `line` closes a fence: ``` plus blanks. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  const n = line.length;
  while (i < n && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6 || i >= n) return null;
  const depth = i;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < n) {
    const cc = line.charCodeAt(i);
    if (cc === 32 || cc === 9) i++;
    else break;
  }
  let e = n;
  while (e > i) {
    const cc = line.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  if (e === i) return null;
  return { depth, text: line.slice(i, e) };
}

/** Whether `line` is a thematic break: --- or ***, plus blanks. */
function isBreak(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null: "- " or "* " and the rest of the line. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item's number and text, or null: 1-9 digits, ". ", the rest. */
function orderedOf(line) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: at least two spaces, then non-space. */
function isContinued(line) {
  let i = 0;
  const n = line.length;
  while (i < n && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < n && !isWsCode(line.charCodeAt(i));
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is a heading, without cutting its text out. */
function isHeadingLine(line) {
  let i = 0;
  const n = line.length;
  while (i < n && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6 || i >= n) return false;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return false;
  while (i < n) {
    const cc = line.charCodeAt(i);
    if (cc === 32 || cc === 9) i++;
    else break;
  }
  return i < n; // a non-blank character remains for the heading's text
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || isHeadingLine(line) || isBreak(line);
}

// The characters a backslash escapes, as a table over ASCII codes.
const ESCAPABLE = new Array(128).fill(false);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = true;

function escapableAt(s, i) {
  const c = s.charCodeAt(i);
  return c < 128 && ESCAPABLE[c];
}

/** The first index in [from, end) holding `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && escapableAt(s, j + 1)) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && escapableAt(s, j + 1)) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

/**
 * s[start, end) rendered inline; env.link(target) is a link's href. Plain
 * runs between marks are escaped in one slice each; nested marks recurse on
 * ranges, so nothing is copied until it is emitted.
 */
/** The characters that can open an inline mark: \ ` * [ */
const SPECIAL_RE = /[\\`*[]/g;

function inlineRange(s, start, end, env, C) {
  let out = '';
  let plain = start;
  let i = start;
  while (i < end) {
    // Jump straight to the next possible mark; the run before it is plain.
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    i = m === null || m.index >= end ? end : m.index;
    if (i >= end) break;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < end && escapableAt(s, i + 1)) {
        if (i > plain) out += escapeHtml(s.slice(plain, i));
        out += escapeHtml(s[i + 1]);
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        if (i > plain) out += escapeHtml(s.slice(plain, i));
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (i + 1 < end && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          if (i > plain) out += escapeHtml(s.slice(plain, i));
          out += `<strong>${inlineRange(s, i + 2, j, env, C)}</strong>`;
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        if (i > plain) out += escapeHtml(s.slice(plain, i));
        out += `<em>${inlineRange(s, i + 1, j, env, C)}</em>`;
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, end);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= end ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWhitespace(target)) {
        if (i > plain) out += escapeHtml(s.slice(plain, i));
        out += `<a href="${escapeHtml(env.link(target))}">${inlineRange(s, i + 1, k, env, C)}</a>`;
        i = m + 1;
        plain = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (end > plain) out += escapeHtml(s.slice(plain, end));
  return out;
}

function inline(s, env, C) {
  return inlineRange(s, 0, s.length, env, C);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML).
 */
function renderMarkdown(src, env, C) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const toc = [];
  let html = '';
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      let inner = '';
      while (i < n && !fenceClose(lines[i])) {
        inner += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      html += lang === '' ? `<pre><code>${inner}</code></pre>\n` : `<pre><code class="language-${escapeHtml(lang)}">${inner}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(C.slugify(heading.text), ids);
      const h = inline(heading.text, env, C);
      html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
      i++;
      continue;
    }
    if (isBreak(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        const stripped = raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const t = trimLine(stripped);
        if (t !== '') parts.push(t);
        i++;
      }
      html += parts.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(parts.join('\n'), env, C)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const items = [];
      let cur = [trimLine(isOrd ? ordered.text : bullet)];
      items.push(cur);
      i++;
      while (i < n) {
        const l = lines[i];
        if (isOrd) {
          const m = orderedOf(l);
          if (m !== null) {
            cur = [trimLine(m.text)];
            items.push(cur);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(l);
          if (m !== null) {
            cur = [trimLine(m)];
            items.push(cur);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          cur.push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      let block = isOrd && ordered.num !== 1 ? `<ol start="${ordered.num}">\n` : `<${tag}>\n`;
      for (const parts of items) block += `<li>${inline(parts.join('\n'), env, C)}</li>\n`;
      block += `</${tag}>`;
      html += `${block}\n`;
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const p = inline(parts.join('\n'), env, C);
    if (excerpt === null) excerpt = p;
    html += `<p>${p}</p>\n`;
  }
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// --------------------------------------------------------------- templates
//
// The reference's own dialect:
//   {{ path }}            the value at path, HTML-escaped
//   {{{ path }}}          the value at path, raw
//   {% for x in path %} ... {% endfor %}
//   {% if path %} / {% if not path %} ... {% else %} ... {% endif %}
//   {% include "name" %}  rendered in the same scope, at most 8 deep
// A {% %} tag alone on its line takes its whole line with it. Each template
// is parsed once per case and compiled into a generated function that pushes
// output pieces onto an array; rendering is then plain function calls.

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether src[a, b) is only spaces and tabs. */
function blankRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  const n = src.length;
  let text = '';
  let i = 0;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = blankRange(src, lineStart, open) && blankRange(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The helpers every compiled template calls (H in the generated code). */
const H = {
  esc: escapeHtml,
  txt: textOf,
  tru: truthy,
  lk: lookup,
  inc(ctx, name, scope, depth) {
    const fn = ctx.fns.get(name);
    return fn !== undefined && depth < INCLUDE_DEPTH ? fn(scope, ctx, depth + 1, H) : '';
  },
};

/**
 * A parsed template compiled into a function (scope, ctx, depth, H) that
 * returns its rendered text. Lookup paths are hoisted into constants at the
 * top of the generated body, so loops reuse one array per path. Includes are
 * inlined into the including template (the set is fixed for the case), with
 * the same depth check at every edge; an include that would close a cycle
 * stays a dynamic call, which the depth cap then bounds as the reference's
 * renderer bounds it.
 */
function compileTemplate(name, nodes, trees) {
  const pathConsts = [];
  const pathIds = new Map();
  const pathConst = (path) => {
    const key = JSON.stringify(path);
    let id = pathIds.get(key);
    if (id === undefined) {
      id = pathConsts.length;
      pathIds.set(key, id);
      pathConsts.push(key);
    }
    return `P${id}`;
  };
  let uid = 0;
  const gen = (list, scopeVar, depthVar, stack, inline) => {
    let code = '';
    for (const nd of list) {
      switch (nd.kind) {
        case 'text':
          code += `out+=${JSON.stringify(nd.text)};`;
          break;
        case 'var':
          code += `out+=esc(txt(lk(${scopeVar},${pathConst(nd.path)})));`;
          break;
        case 'raw':
          code += `out+=txt(lk(${scopeVar},${pathConst(nd.path)}));`;
          break;
        case 'if':
          code += `if (tru(lk(${scopeVar},${pathConst(nd.path)})) !== ${nd.not}) {${gen(nd.then, scopeVar, depthVar, stack, inline)}}`;
          if (nd.else !== null) code += ` else {${gen(nd.else, scopeVar, depthVar, stack, inline)}}`;
          break;
        case 'for': {
          const id = uid++;
          const xs = `xs$${id}`;
          const ln = `ln$${id}`;
          const k = `k$${id}`;
          const sc = `sc$${id}`;
          code += `{const ${xs}=lk(${scopeVar},${pathConst(nd.path)});if(Array.isArray(${xs})){const ${ln}=${xs}.length;for(let ${k}=0;${k}<${ln};${k}++){const ${sc}={vars:{[${JSON.stringify(nd.name)}]:${xs}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${ln}-1,length:${ln}}},parent:${scopeVar}};${gen(nd.body, sc, depthVar, stack, inline)}}}}`;
          break;
        }
        case 'include': {
          const target = inline ? trees.get(nd.name) : undefined;
          if (target !== undefined && !stack.includes(nd.name)) {
            const dv = `d$${uid++}`;
            code += `if(${depthVar}<${INCLUDE_DEPTH}){const ${dv}=${depthVar}+1;${gen(target, scopeVar, dv, [...stack, nd.name], inline)}}`;
          } else {
            code += `out+=inc(ctx,${JSON.stringify(nd.name)},${scopeVar},${depthVar});`;
          }
          break;
        }
      }
    }
    return code;
  };
  const make = (inline) => {
    const body = gen(nodes, 'scope', 'depth', [name], inline);
    const consts = pathConsts.map((key, id) => `const P${id}=${key};`).join('');
    return new Function('scope', 'ctx', 'depth', 'H', `${consts}const lk=H.lk,esc=H.esc,txt=H.txt,tru=H.tru,inc=H.inc;let out='';${body}return out;`);
  };
  try {
    return make(true);
  } catch {
    return make(false);
  }
}

// ------------------------------------------------------------------- build

const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a URI scheme (a letter, then letters, digits, +, - or ., then :). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text, exactly the reference build's. */
function build(input) {
  // Per-case memo tables: slugs, long dates and resolved links repeat a lot
  // inside one site; nothing here outlives the case.
  const slugMap = new Map();
  const dateMap = new Map();
  const linkMaps = new Map(); // dir -> Map(target -> resolved href | null for broken)
  const C = {
    slugify(text) {
      let v = slugMap.get(text);
      if (v === undefined) {
        v = slugifyRaw(text);
        slugMap.set(text, v);
      }
      return v;
    },
  };
  const longDate = (date) => {
    let v = dateMap.get(date);
    if (v === undefined) {
      v = longDateRaw(date);
      dateMap.set(date, v);
    }
    return v;
  };

  const report = [];
  const trees = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      trees.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const fns = new Map();
  for (const [name, nodes] of trees) fns.set(name, compileTemplate(name, nodes, trees));
  const baseUrl = input.site.base_url;
  let baseEnd = baseUrl.length;
  while (baseEnd > 0 && baseUrl.charCodeAt(baseEnd - 1) === 47) baseEnd--;
  const base = baseEnd === baseUrl.length ? baseUrl : baseUrl.slice(0, baseEnd);

  // 1. The sources, in code-unit order of their paths, line ends made "\n";
  //    a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      // Line ends made "\n"; most sources hold no "\r" and skip the rewrite.
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped,
  //    and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!fns.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  //    directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? C.slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  //    files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    let dirLinks = linkMaps.get(dir);
    if (dirLinks === undefined) {
      dirLinks = new Map();
      linkMaps.set(dir, dirLinks);
    }
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        let resolved = dirLinks.get(target);
        if (resolved === undefined) {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          const hit = path === null ? undefined : bySource.get(path);
          if (hit !== undefined) resolved = `${hit.url}${frag}`;
          else if (path !== null && staticPaths.has(path)) resolved = `${base}/${path}${frag}`;
          else resolved = null;
          dirLinks.set(target, resolved);
        }
        if (resolved === null) {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return resolved;
      },
    };
    const md = renderMarkdown(s.body, env, C);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  //    posts' order, ordered by count and then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = C.slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = C.slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = C.slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  //    through theirs.
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { fns };
  const render = (name, vars) => {
    const fn = fns.get(name);
    if (fn === undefined) return null;
    return fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, H);
  };

  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  //    not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, computed faster. */
export function run(input) {
  return build(input);
}
