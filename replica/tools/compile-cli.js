#!/usr/bin/env node
'use strict';
/**
 * CLI: compile a DIL source file (or the built-in demo) and print the pipeline result.
 *
 *   node tools/compile-cli.js                    # built-in demo
 *   node tools/compile-cli.js path/to/file.dil   # a file
 *   node tools/compile-cli.js --json             # machine readable
 *   node tools/compile-cli.js --out build/       # write code/constants/fallback
 */
const fs = require('node:fs');
const path = require('node:path');
const { compile } = require('../server/compiler');
const { DEMO_SOURCE } = require('../server/agent/demo-source');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

const source = positional[0] ? fs.readFileSync(positional[0], 'utf8') : DEMO_SOURCE;
const result = compile(source);

const outIdx = args.indexOf('--out');
const wroteOut = outIdx >= 0 && !!args[outIdx + 1];
if (wroteOut) {
  const dir = args[outIdx + 1];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'source.dil.md'), result.source);
  fs.writeFileSync(path.join(dir, 'compiled.js'), result.code);
  fs.writeFileSync(path.join(dir, 'constants.json'), JSON.stringify(result.constants, null, 2));
  fs.writeFileSync(path.join(dir, 'fallback.md'), result.fallbackMarkdown);
  fs.writeFileSync(path.join(dir, 'diagnostics.json'), JSON.stringify(result.diagnostics, null, 2));
  console.log(`wrote 5 files to ${dir}/`);
}

if (flags.has('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else if (!wroteOut) {
  console.log('─'.repeat(72));
  console.log(`source        ${result.sourceLength} chars`);
  console.log(`code          ${result.codeLength} chars`);
  console.log(`constants     ${result.constantCount}`);
  console.log(`components    ${result.requiredComponents.length ? result.requiredComponents.join(', ') : '(only intrinsics)'}`);
  console.log(`diagnostics   ${result.diagnosticSummary}`);
  console.log(`duration      ${result.durationMs} ms`);
  console.log('─'.repeat(72));
  console.log(result.code.slice(0, 1200) + (result.code.length > 1200 ? '\n… (truncated)' : ''));
}
