'use strict';
/**
 * DIL parser: source → AST, with recovery diagnostics.
 *
 *   markdown prose          → { type:'text' }
 *   {@body stmt}            → { type:'stmt' }      hoisted into the render function
 *   {expr}                  → { type:'expr' }
 *   {#if}…{:else if}…{/if}  → { type:'if', branches }
 *   {#each xs as x}…{/each} → { type:'each', list, item, body }
 *   <tag attr=…>…</tag>     → { type:'element', name, attrs, children, pos, end, closed }
 *
 * Malformed input is the *normal* case: the source arrives a few dozen bytes at a time
 * and almost every intermediate state is invalid. Every failure is recorded as a
 * diagnostic and parsing continues with a best-effort AST — this function never throws.
 */
const { lineCol, readBalanced, splitEachClause } = require('./scanner');

const TAG_NAME = /^[A-Za-z_$][\w$]*(?:[-.][A-Za-z_$][\w$]*)*/;
const ATTR_NAME = /^[A-Za-z_$][\w$:-]*/;
const BLOCK_OPEN = new Set(['if', 'each']);
/**
 * Elements whose content is literal text, never DIL. Code samples are full of `{`,
 * `}`, `<` and `:=` — parsed as DIL they become broken JavaScript and the whole
 * program fails to evaluate (`<code>for i := 0; …{ wg.Add(1) }</code>`).
 */
const RAW_TEXT = new Set(['code', 'pre', 'code-block']);

class Diagnostics {
  constructor(src) {
    this.src = src;
    this.items = [];
    this.seen = new Set();
  }

  add(code, index, extra = {}) {
    const { line, column } = lineCol(this.src, index);
    const key = `${code}:${line}:${column}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push({ code, line, column, ...extra });
  }

  /** `clean`, or `code×n` pairs — the one-line form the UI shows. */
  summary() {
    if (!this.items.length) return 'clean';
    const counts = new Map();
    for (const d of this.items) counts.set(d.code, (counts.get(d.code) || 0) + 1);
    return [...counts.entries()].map(([k, v]) => `${k}×${v}`).join(' ');
  }
}

function parse(src) {
  const diag = new Diagnostics(src);
  const ctx = { src, i: 0, diag };
  const result = parseNodes(ctx, null);
  return { nodes: mergeText(result.nodes), diagnostics: diag.items, diagnosticSummary: diag.summary() };
}

/**
 * Parse a run of siblings. Stops at EOF, at `</closeTag>`, or at a `{:…}` / `{/…}`
 * terminator, which is returned to the enclosing block to interpret.
 */
function parseNodes(ctx, closeTag) {
  const { src } = ctx;
  const nodes = [];
  let textStart = -1;

  const flushText = (end) => {
    if (textStart < 0) return;
    const raw = src.slice(textStart, end);
    if (raw.length) nodes.push({ type: 'text', value: decodeEntities(raw), pos: textStart });
    textStart = -1;
  };

  while (ctx.i < src.length) {
    const c = src[ctx.i];
    const next = src[ctx.i + 1];

    if (closeTag && c === '<' && next === '/') {
      const closing = readClosingTag(ctx, closeTag);
      if (closing) {
        flushText(closing.at);
        return { nodes, terminator: closing.terminator };
      }
    }

    if (c === '{' && (next === ':' || next === '/')) {
      flushText(ctx.i);
      const term = readTerminator(ctx);
      if (term) return { nodes, ...term };
      continue;
    }

    if (c === '{' && next === '@') {
      flushText(ctx.i);
      const stmt = readAppDirective(ctx);
      if (stmt) nodes.push(stmt);
      continue;
    }

    if (c === '{' && next === '#') {
      flushText(ctx.i);
      const block = readBlock(ctx, closeTag);
      if (block) nodes.push(block);
      continue;
    }

    if (c === '<' && /[A-Za-z_$]/.test(next || '')) {
      flushText(ctx.i);
      const el = parseElement(ctx);
      if (el) nodes.push(el);
      continue;
    }

    if (c === '{') {
      flushText(ctx.i);
      const pos = ctx.i;
      const braced = readBalanced(src, pos);
      if (!braced.ok) ctx.diag.add('unterminated_braced_value', pos, { action: 'recovered_parse' });
      const code = braced.inner.trim();
      if (code) nodes.push({ type: 'expr', code, pos });
      ctx.i = braced.end;
      continue;
    }

    // plain text, including a `<` that does not start a tag ("a < b")
    if (textStart < 0) textStart = ctx.i;
    ctx.i++;
  }

  flushText(src.length);
  if (closeTag) ctx.diag.add('unclosed_block', src.length, { directive: closeTag, action: 'recovered_parse' });
  return { nodes, terminator: null };
}

/** `</name>` closing the current element. Null when it is not a tag at all. */
function readClosingTag(ctx, closeTag) {
  const { src } = ctx;
  const m = TAG_NAME.exec(src.slice(ctx.i + 2));
  if (!m) return null;
  const at = ctx.i;
  const gt = src.indexOf('>', at + 2 + m[0].length);
  if (gt < 0) {
    ctx.diag.add('unterminated_tag', at, { tag: m[0] });
    ctx.i = src.length;
    return { at, terminator: null };
  }
  if (m[0] !== closeTag) {
    ctx.diag.add('mismatched_tag', at, { expected: closeTag, found: m[0], action: 'recovered_parse' });
  }
  ctx.i = gt + 1;
  return { at, terminator: 'close' };
}

/**
 * `{:else}`, `{:else if expr}`, `{/if}`, `{/each}`. The cursor is left *on* the
 * terminator — the enclosing block advances past it by `length`. A malformed
 * terminator is consumed one character at a time and parsing continues.
 */
function readTerminator(ctx) {
  const { src } = ctx;
  const kind = src[ctx.i + 1] === ':' ? 'else' : 'close';
  const simple = /^\{[:/](\w+)\}/.exec(src.slice(ctx.i));
  if (simple) return { terminator: kind, name: simple[1], length: simple[0].length };

  if (kind === 'else' && /^\{:else\s+if\s/.test(src.slice(ctx.i, ctx.i + 16))) {
    const braced = readBalanced(src, ctx.i);
    if (!braced.ok) ctx.diag.add('unterminated_braced_value', ctx.i, { directive: 'if', action: 'recovered_parse' });
    const cond = braced.inner.replace(/^:else\s+if\s+/, '').trim() || 'false';
    return { terminator: 'else', name: 'else', cond, length: braced.end - ctx.i };
  }

  ctx.diag.add('malformed_terminator', ctx.i, { action: 'recovered_parse' });
  ctx.i += 1;
  return null;
}

/** A balanced region that spans another `{@` or a tag line has eaten too much. */
function runsIntoNextDirective(inner) {
  return /\n\s*(\{@|<[A-Za-z])/.test(inner);
}

/** `{@body …}` — one or more statements hoisted into the render function. */
function readAppDirective(ctx) {
  const { src } = ctx;
  const pos = ctx.i;
  let braced = readBalanced(src, pos);
  if (!braced.ok || runsIntoNextDirective(braced.inner)) {
    // Unterminated. If the model just dropped the closing `}` (`{@body const T = {a:{…}}`
    // then a newline), the balanced scan swallows the rest of the document. A directive
    // is one line, so close it at the end of the line it started on.
    const eol = src.indexOf('\n', pos);
    if (eol < 0) {
      // the directive is still being streamed: `{@body co` is not a statement yet
      ctx.diag.add('unterminated_braced_value', pos, { directive: 'body', action: 'deferred' });
      ctx.i = src.length;
      return null;
    }
    ctx.diag.add('unterminated_braced_value', pos, { directive: 'body', action: 'recovered_parse' });
    braced = { inner: src.slice(pos + 1, eol), end: eol, ok: false };
  }
  ctx.i = braced.end;
  const m = /^\s*([A-Za-z_$][\w$]*)\s*([\s\S]*)$/.exec(braced.inner.slice(1));
  if (!m) {
    ctx.diag.add('empty_app_directive', pos, { action: 'recovered_parse' });
    return null;
  }
  return { type: 'stmt', name: m[1], code: m[2].trim(), pos };
}

function readBlock(ctx, closeTag) {
  const { src } = ctx;
  const pos = ctx.i;
  const braced = readBalanced(src, pos);
  if (!braced.ok) ctx.diag.add('unterminated_braced_value', pos, { action: 'recovered_parse' });
  ctx.i = braced.end;
  const m = /^([A-Za-z_$][\w$]*)\s*([\s\S]*)$/.exec(braced.inner.slice(1).trim());
  if (!m || !BLOCK_OPEN.has(m[1])) {
    ctx.diag.add('unknown_block', pos, { action: 'dropped', directive: m ? m[1] : '' });
    return null;
  }
  return m[1] === 'if' ? readIf(ctx, closeTag, pos, m[2].trim()) : readEach(ctx, closeTag, pos, m[2].trim());
}

function readIf(ctx, closeTag, pos, firstCond) {
  const node = { type: 'if', pos, branches: [] };
  let cond = firstCond;
  for (;;) {
    const branch = parseNodes(ctx, closeTag);
    node.branches.push({ cond, body: mergeText(branch.nodes) });
    if (branch.terminator === 'else') {
      ctx.i += branch.length;
      cond = branch.cond != null ? branch.cond : null; // `{:else}` has no condition
      continue;
    }
    closeBlock(ctx, branch, 'if', pos);
    return node;
  }
}

function readEach(ctx, closeTag, pos, head) {
  const parts = splitEachClause(head);
  if (!parts) ctx.diag.add('malformed_each', pos, { action: 'recovered_parse' });
  const body = parseNodes(ctx, closeTag);
  closeBlock(ctx, body, 'each', pos);
  return {
    type: 'each',
    pos,
    list: parts ? parts.list : '[]',
    item: parts ? parts.item : 'item',
    body: mergeText(body.nodes),
  };
}

function closeBlock(ctx, result, directive, pos) {
  if (result.terminator === 'close') {
    ctx.i += result.length;
    if (result.name !== directive) {
      ctx.diag.add('mismatched_block_close', pos, { expected: directive, found: result.name, action: 'recovered_parse' });
    }
  } else {
    ctx.diag.add('unclosed_block', pos, { directive, action: 'recovered_parse' });
  }
}

function parseElement(ctx) {
  const { src } = ctx;
  const pos = ctx.i;
  const nameMatch = TAG_NAME.exec(src.slice(pos + 1));
  if (!nameMatch) { ctx.i++; return null; }
  const name = nameMatch[0];
  const { attrs, end, selfClosing, open } = readAttributes(ctx, name, pos + 1 + name.length);

  if (!open && !selfClosing) {
    ctx.diag.add('unterminated_tag', pos, { tag: name, action: 'recovered_parse' });
    ctx.i = src.length;
    return { type: 'element', name, attrs, children: [], pos, end: src.length, closed: false };
  }

  ctx.i = end;
  if (selfClosing) return { type: 'element', name, attrs, children: [], pos, end, closed: true };

  if (RAW_TEXT.has(name)) return readRawText(ctx, name, attrs, pos);

  const inner = parseNodes(ctx, name);
  const closed = inner.terminator === 'close';
  if (!closed) ctx.diag.add('unclosed_tag', pos, { tag: name, action: 'recovered_parse' });
  return { type: 'element', name, attrs, children: mergeText(inner.nodes), pos, end: ctx.i, closed };
}

/** Everything up to `</name>` is one text node (entities decoded). */
function readRawText(ctx, name, attrs, pos) {
  const { src } = ctx;
  const close = src.indexOf(`</${name}>`, ctx.i);
  const end = close < 0 ? src.length : close;
  const value = decodeEntities(src.slice(ctx.i, end));
  const children = value ? [{ type: 'text', value, pos: ctx.i, raw: true }] : [];
  if (close < 0) {
    ctx.diag.add('unclosed_tag', pos, { tag: name, action: 'recovered_parse' });
    ctx.i = src.length;
    return { type: 'element', name, attrs, children, pos, end: src.length, closed: false };
  }
  ctx.i = close + name.length + 3;
  return { type: 'element', name, attrs, children, pos, end: ctx.i, closed: true };
}

/**
 * Attribute forms: `name="str"`, `name={expr}`, `name=raw`, bare `name` (true).
 * Returns at `>` / `/>`, or at EOF with neither flag set.
 */
function readAttributes(ctx, tag, i) {
  const { src } = ctx;
  const attrs = [];
  const skipWs = (j) => j + /^\s*/.exec(src.slice(j))[0].length;

  while (i < src.length) {
    i = skipWs(i);
    if (src.startsWith('/>', i)) return { attrs, end: i + 2, selfClosing: true, open: false };
    if (src[i] === '>') return { attrs, end: i + 1, selfClosing: false, open: true };
    if (i >= src.length) break;

    const am = ATTR_NAME.exec(src.slice(i));
    if (!am) {
      ctx.diag.add('malformed_attribute', i, { tag, action: 'recovered_parse' });
      i++;
      continue;
    }
    const name = am[0];
    const afterName = skipWs(i + name.length);
    if (src[afterName] !== '=') {
      attrs.push({ name, kind: 'boolean', value: true, pos: i });
      i = afterName;
      continue;
    }

    const j = skipWs(afterName + 1);
    const q = src[j];
    if (q === '"' || q === "'") {
      let k = j + 1;
      let value = '';
      while (k < src.length && src[k] !== q) {
        if (src[k] === '\\') { value += src[k] + (src[k + 1] || ''); k += 2; continue; }
        value += src[k++];
      }
      if (k >= src.length) ctx.diag.add('unterminated_string', j, { tag, action: 'recovered_parse' });
      attrs.push({ name, kind: 'string', value, pos: j });
      i = Math.min(k + 1, src.length);
    } else if (q === '{') {
      const braced = readBalanced(src, j);
      if (!braced.ok) ctx.diag.add('unterminated_braced_value', j, { tag, action: 'recovered_parse' });
      attrs.push({ name, kind: 'expr', value: braced.inner.trim(), pos: j });
      i = braced.end;
    } else {
      const raw = (/^[^\s/>]+/.exec(src.slice(j)) || [''])[0];
      attrs.push({ name, kind: 'raw', value: raw, pos: j });
      i = j + raw.length;
    }
  }
  return { attrs, end: src.length, selfClosing: false, open: false };
}

/**
 * Text is JSX-like, so models sometimes escape it as HTML (`Usage &amp; Billing`).
 * Decode the common entities; the renderer only ever sets text, never HTML, so the
 * decoded characters are safe.
 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };
function decodeEntities(s) {
  return s.indexOf('&') < 0 ? s : s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, k) => ENTITIES[k]);
}

/**
 * Merge adjacent text runs (one constant per run, like the real compiler) and drop
 * layout whitespace between elements — whitespace-only runs that span a newline.
 */
function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text' && /^\s*$/.test(n.value) && n.value.includes('\n')) continue;
    const prev = out[out.length - 1];
    if (n.type === 'text' && prev && prev.type === 'text') prev.value += n.value;
    else out.push(n);
  }
  return out;
}

module.exports = { parse };
