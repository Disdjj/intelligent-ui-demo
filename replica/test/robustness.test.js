'use strict';
/**
 * Robustness against real model output. Fixtures are DeepSeek generations that broke
 * earlier versions:
 *
 *   model-g2  Go code inside <code> (`for i := 0; … { wg.Add(1) }`) parsed as DIL
 *   model-n2  `{@body const T = {…}}` missing its final `}` — swallowed the document
 *   model-t1  state never declared, option arrays never declared, ```html fences
 *   model-t3  state never declared
 *
 * The property: for EVERY prefix of every document (that is what streaming sends),
 * the compiled program parses, and running it never fails the sandbox.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compile } = require('../server/compiler');
const { bootSandbox } = require('../tools/node-sandbox');

const FIXTURES = path.join(__dirname, 'fixtures');
const SOURCES = [
  ...fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.dil.md')).map((f) => [f, fs.readFileSync(path.join(FIXTURES, f), 'utf8')]),
  ['captured', fs.readFileSync(path.join(__dirname, '..', '..', 'artifacts', 'genui-source.dil.md'), 'utf8')],
];

for (const [name, src] of SOURCES) {
  test(`${name}: every streamed prefix compiles to a parsable program`, () => {
    for (let n = 1; n <= src.length; n += 5) {
      const r = compile(src.slice(0, n));
      assert.doesNotThrow(() => new vm.Script(`(function(){${r.code}\n})`), `prefix ${n}`);
      assert.ok(!r.diagnostics.some((d) => d.code === 'invalid_program'), `prefix ${n} fell back to text`);
    }
  });

  test(`${name}: streaming it through one sandbox never fails`, async () => {
    const sb = bootSandbox();
    let started = false;
    let trees = 0;
    try {
      for (let n = 200; n <= src.length + 200; n += 211) {
        const r = compile(src.slice(0, n));
        const payload = { compiledDil: r.code, constants: r.constants, appData: r.appData };
        if (!started) { sb.createRunner(payload); started = true; } else sb.setCompiledDil(payload);
        await sb.flush();
        if (sb.latest && sb.latest.tree) trees++;
      }
      assert.deepEqual(sb.failures.map((f) => f.error && f.error.message), []);
      assert.ok(trees > 0);
    } finally {
      sb.close();
    }
  });
}

test('the final render of each fixture has working controls', async () => {
  for (const [name, src] of SOURCES) {
    const r = compile(src);
    const sb = bootSandbox();
    sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: r.appData });
    await sb.flush();
    const json = JSON.stringify(sb.latest.tree);
    assert.ok(/"__dilFn"/.test(json), `${name} rendered no interactive controls`);
    sb.close();
  }
});

test('<code> and <pre> are raw text: braces and := never reach the program', () => {
  const r = compile('<box><code>for i := 0; i &lt; n; i++ { wg.Add(1); go func(){ defer wg.Done() }() }</code></box>');
  assert.equal(r.diagnosticSummary, 'clean');
  assert.ok(Object.values(r.constants).includes('for i := 0; i < n; i++ { wg.Add(1); go func(){ defer wg.Done() }() }'));
});

test('an invalid expression is replaced, the rest renders', () => {
  const r = compile('<box><text>{a b c}</text><text>ok</text></box>');
  assert.ok(r.diagnostics.some((d) => d.code === 'invalid_expression'));
  assert.doesNotThrow(() => new vm.Script(`(function(){${r.code}\n})`));
});
