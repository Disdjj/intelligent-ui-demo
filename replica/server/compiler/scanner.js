'use strict';
/**
 * Low-level scanners shared by the parser and the statement rewriter.
 *
 * None of these understand DIL; they only know enough JavaScript lexing (strings,
 * template literals, comments, regex literals) to find a matching bracket or a
 * top-level separator without being fooled by one inside a string.
 */

/** 1-based line/column of a UTF-16 index — what diagnostics report. */
function lineCol(src, index) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

const REGEX_PRECEDERS = '([{,;:=!&|?+-*%~^<>';

/**
 * Scan a balanced `open … close` region starting at `start` (src[start] === open).
 * Returns the inner text and whether it closed. Never throws: an unterminated region
 * runs to the end of the source with `ok: false`, which the parser turns into a
 * recovery diagnostic.
 */
function readBalanced(src, start, open = '{', close = '}') {
  let i = start;
  let depth = 0;
  const stack = []; // {type:'str',q} | {type:'tmpl'} | {type:'brace',depthAtOpen}
  const top = () => stack[stack.length - 1];
  let prevSig = ''; // last significant char, to guess whether `/` starts a regex

  while (i < src.length) {
    const c = src[i];
    const t = top();

    if (t && t.type === 'str') {
      if (c === '\\') { i += 2; continue; }
      if (c === t.q) stack.pop();
      i++;
      continue;
    }
    if (t && t.type === 'tmpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      // `${` opens an expression inside the template; remember the depth so its
      // closing `}` can be told apart from object literals inside it.
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ type: 'brace', depthAtOpen: depth });
        depth++;
        i += 2;
        prevSig = '{';
        continue;
      }
      i++;
      continue;
    }

    if (c === '"' || c === "'") { stack.push({ type: 'str', q: c }); i++; prevSig = c; continue; }
    if (c === '`') { stack.push({ type: 'tmpl' }); i++; prevSig = c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && (prevSig === '' || REGEX_PRECEDERS.includes(prevSig))) {
      i = skipRegex(src, i + 1);
      continue;
    }

    if (c === open) { depth++; i++; prevSig = c; continue; }
    if (c === close) {
      depth--;
      i++;
      if (t && t.type === 'brace' && depth === t.depthAtOpen) {
        stack.pop(); // closed a `${…}`: back to template-literal mode
        prevSig = close;
        continue;
      }
      if (depth === 0) return { inner: src.slice(start + 1, i - 1), end: i, ok: true };
      prevSig = c;
      continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return { inner: src.slice(start + 1), end: src.length, ok: false };
}

function skipRegex(src, i) {
  let inClass = false;
  while (i < src.length) {
    const d = src[i];
    if (d === '\\') { i += 2; continue; }
    if (d === '[') inClass = true;
    else if (d === ']') inClass = false;
    else if (d === '/' && !inClass) return i + 1;
    else if (d === '\n') return i;
    i++;
  }
  return i;
}

/**
 * Index of the first `match(expr, i)` at bracket/string depth 0, or -1. The
 * predicate form lets callers look for multi-character separators (` as `).
 */
function findTopLevel(expr, match, from = 0) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && match(expr, i)) return i;
  }
  return -1;
}

/** Index of a single character at depth 0, or -1. */
function topLevelIndex(expr, ch, from = 0) {
  return findTopLevel(expr, (s, i) => s[i] === ch, from);
}

/** `{#each list as item}` → { list, item } split at the top-level ` as `. */
function splitEachClause(expr) {
  const i = findTopLevel(expr, (s, j) => s.startsWith(' as ', j));
  return i < 0 ? null : { list: expr.slice(0, i).trim(), item: expr.slice(i + 4).trim() };
}

/** UTF-16 index → Unicode code point index; linear to build, O(1) per lookup. */
function codePointIndexer(src) {
  const table = new Uint32Array(src.length + 1);
  let cp = 0;
  for (let i = 0; i < src.length; i++) {
    table[i] = cp;
    const c = src.charCodeAt(i);
    const isLowSurrogate = c >= 0xdc00 && c <= 0xdfff;
    const prev = i > 0 ? src.charCodeAt(i - 1) : 0;
    if (isLowSurrogate && prev >= 0xd800 && prev <= 0xdbff) continue;
    cp++;
  }
  table[src.length] = cp;
  return (i) => table[Math.max(0, Math.min(i, src.length))];
}

module.exports = { lineCol, readBalanced, findTopLevel, topLevelIndex, splitEachClause, codePointIndexer };
