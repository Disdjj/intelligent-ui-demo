'use strict';
/**
 * Syntax validation of model-written JavaScript fragments.
 *
 * The program is evaluated as one unit (`new Function(program)`), so a single
 * unparsable fragment anywhere — `<code>a := b</code>` read as DIL, an unclosed
 * object literal — fails the *whole* interface on every recompile. Checking each
 * fragment here, and replacing the bad ones with a safe placeholder, turns that
 * into one missing value.
 *
 * Only *compiles* the fragment (vm.Script with a wrapper); nothing is executed.
 */
const vm = require('node:vm');

const cache = new Map();
const CACHE_LIMIT = 4000;

function parses(wrapped) {
  if (cache.has(wrapped)) return cache.get(wrapped);
  let ok = true;
  try {
    // wrap in a function so `return`, and top-level `await` errors, behave as in the sandbox
    new vm.Script(`(function(){${wrapped}\n})`);
  } catch {
    ok = false;
  }
  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(wrapped, ok);
  return ok;
}

/** An expression usable as `(${code})`. */
function isExpression(code) {
  return parses(`return (${code}\n);`);
}

/** A statement usable inside the render function body. */
function isStatement(code) {
  return parses(`${code}\n;`);
}

/** The finished program, as the sandbox will evaluate it. */
function isProgram(code) {
  return parses(code);
}

module.exports = { isExpression, isStatement, isProgram };
