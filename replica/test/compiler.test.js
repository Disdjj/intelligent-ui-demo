'use strict';
/**
 * Compiler tests. The headline property is negative: **compilation never throws**,
 * whatever prefix of the document it is handed. That is what makes streaming possible.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, parse, toFallback, tidyFallback, readBalanced, splitEachClause } = require('../server/compiler');
const { DEMO_SOURCE } = require('../server/agent/demo-source');

test('compiles the demo document cleanly', () => {
  const r = compile(DEMO_SOURCE);
  assert.equal(r.diagnosticSummary, 'clean');
  assert.deepEqual(r.diagnostics, []);
  assert.ok(r.code.includes('function __dilSafe('));
  assert.ok(r.code.includes('DIL.render(__dil.jsx('));
  assert.ok(r.code.includes('DIL.useConstants()'));
  assert.ok(r.code.includes('DIL.useAppData('));
  assert.ok(r.constantCount > 10, 'string table should be populated');
  assert.ok(r.code.length > r.sourceLength * 0.8);
});

test('hoists text into the constant pool instead of inlining it', () => {
  const r = compile('你好，世界');
  assert.equal(r.constantCount, 1);
  assert.equal(r.constants['0'], '你好，世界');
  assert.ok(r.code.includes('__dilConstants["0"]'));
  assert.ok(!r.code.includes('你好，世界'), 'literal must not appear in the code');
});

test('hoists JSON-parseable attribute expressions', () => {
  const r = compile('<select options={[{"label":"a","value":"1"}]} value={1}/>');
  const hoisted = Object.values(r.constants).some((v) => Array.isArray(v));
  assert.ok(hoisted, 'options array should be hoisted');
});

test('a plain text answer still compiles to a DIL program', () => {
  // Mirrors the real artifact: even a one-line prose answer carries a compiled body.
  const r = compile('就是这样。');
  assert.ok(r.code.startsWith('function __dilSafe'));
  assert.ok(r.code.endsWith('{"key":"body:0"}));'));
  assert.ok(r.code.length > 100);
});

test('compilation never throws on any prefix of a document', () => {
  // This is the property the streaming pipeline depends on: every intermediate state
  // of a partially-streamed document is syntactically invalid.
  for (let n = 1; n <= DEMO_SOURCE.length; n += 29) {
    assert.doesNotThrow(() => compile(DEMO_SOURCE.slice(0, n)), `prefix of length ${n}`);
  }
});

test('emits recovery diagnostics for truncated input, then recovers', () => {
  const cut = DEMO_SOURCE.slice(0, 2000);
  const r = compile(cut);
  assert.ok(r.diagnostics.length > 0, 'expected diagnostics');
  const codes = new Set(r.diagnostics.map((d) => d.code));
  assert.ok(
    codes.has('unclosed_block') || codes.has('unclosed_tag') || codes.has('unterminated_tag'),
    'expected a structural recovery code, got ' + [...codes].join(',')
  );
  for (const d of r.diagnostics) {
    assert.ok(Number.isInteger(d.line) && d.line > 0);
    assert.ok(Number.isInteger(d.column) && d.column > 0);
  }
  // and despite the errors, a usable program comes out
  assert.ok(r.code.includes('DIL.render('));
});

test('recovers from an unterminated tag', () => {
  const r = compile('<box border radius="lg">\n<row gap={2}');
  assert.ok(r.diagnostics.some((d) => d.code.startsWith('unterminated') || d.code.startsWith('unclosed')));
  assert.ok(r.code.includes('"box"'));
});

test('recovers from an unterminated braced value', () => {
  const r = compile('{@body const x = DIL.useState({');
  assert.ok(r.diagnostics.some((d) => d.code === 'unterminated_braced_value'));
});

test('reports mismatched and unknown blocks', () => {
  const r = compile('{#each list as x}<text>a</text>{/if}');
  assert.ok(r.diagnostics.some((d) => d.code === 'mismatched_block_close'));
  const r2 = compile('{#while x}<text>a</text>{/while}');
  assert.ok(r2.diagnostics.some((d) => d.code === 'unknown_block'));
});

test('control flow compiles to the expected shapes', () => {
  const ifR = compile('{#if a}<text>x</text>{:else}<text>y</text>{/if}');
  assert.ok(ifR.code.includes('(__dilSafe(()=>(a),false))?'), 'condition is guarded with a false default');
  const eachR = compile('{#each xs as x}<text>{x}</text>{/each}');
  assert.ok(eachR.code.includes('(xs).map((x)=>__dilSafe('));
});

test('multi-child branches are wrapped in a Fragment', () => {
  const r = compile('{#if a}<text>x</text><text>y</text>{/if}');
  assert.ok(r.code.includes('__dil.jsx(__dil.Fragment,null,'));
});

test('whitespace-only text runs between elements are dropped', () => {
  const r = compile('<box>\n  <text>hi</text>\n</box>');
  assert.equal(r.constantCount, 1, 'only "hi" should be hoisted');
});

test('PascalCase tags become requiredComponents, lowercase tags stay intrinsic', () => {
  const r = compile('<box><WeatherWidget city="sf"/><text>x</text></box>');
  assert.deepEqual(r.requiredComponents, ['WeatherWidget']);
  const r2 = compile('<box><text>x</text></box>');
  assert.deepEqual(r2.requiredComponents, []);
});

test('every control gets a function handler reference, never an inline call', () => {
  const r = compile('<box>{@body 0}</box><button onClick={()=>1}>go</button>');
  assert.ok(/__dil\.jsx\("button",\{"onClick":/.test(r.code));
});

test('fallback markdown is non-trivial and free of empty headings', () => {
  const r = compile(DEMO_SOURCE);
  assert.ok(r.fallbackMarkdown.length > 200);
  assert.ok(!/^#{1,6}\s*$/m.test(r.fallbackMarkdown));
  assert.ok(r.fallbackMarkdown.includes('实验流量分配控制台'));
});

test('fallback degrades controls into readable text', () => {
  const r = compile('<box><segmented-control options={[{"label":"A","value":"a"}]}/><button>提交</button><divider/></box>');
  assert.ok(r.fallbackMarkdown.includes('- A'));
  assert.ok(r.fallbackMarkdown.includes('[提交]'));
  assert.ok(r.fallbackMarkdown.includes('---'));
});

test('tidyFallback removes punctuation-only lines', () => {
  const out = tidyFallback('## %\n\nreal text\n|||\n\n---\n');
  assert.ok(!out.includes('## %'));
  assert.ok(out.includes('real text'));
});

test('readBalanced understands nested braces, strings and template literals', () => {
  const src = '{a: `${b({c: 1})}`}';
  const r = readBalanced(src, 0);
  assert.ok(r.ok);
  assert.equal(r.inner, src.slice(1, -1));
});

test('readBalanced reports failure instead of throwing', () => {
  const r = readBalanced('{ a: 1', 0);
  assert.equal(r.ok, false);
});

test('splitEachClause finds the top-level `as`', () => {
  assert.deepEqual(splitEachClause('items as item'), { list: 'items', item: 'item' });
  assert.deepEqual(splitEachClause('[a, b] as x'), { list: '[a, b]', item: 'x' });
  assert.equal(splitEachClause('{ a: "as b" } as y').item, 'y');
});

test('parse returns positions for every diagnostic', () => {
  const { diagnostics } = parse('<box>\n\n  <row>');
  assert.ok(diagnostics.length >= 1);
  for (const d of diagnostics) assert.ok(d.line >= 1 && d.column >= 1);
});

test('source length and code length are reported for the UI', () => {
  const r = compile(DEMO_SOURCE);
  assert.equal(typeof r.sourceLength, 'number');
  assert.equal(typeof r.codeLength, 'number');
  assert.equal(typeof r.durationMs, 'number');
});

test('one {@body} block with several statements is split, keyed and guarded per statement', () => {
  const r = compile('{@body const [a, setA] = DIL.useState(1);\nconst [b, setB] = DIL.useState("x");\nconst c = a * 2;}\n<box><text>{c}</text></box>');
  assert.equal(r.diagnosticSummary, 'clean');
  assert.deepEqual(r.stateKeys, ['a', 'b']);
  assert.ok(r.code.includes('DIL.useState(1,{key:"a"})'));
  assert.ok(r.code.includes('const c = __dilSafe(()=>(a * 2),undefined)'));
});

test('splitStatements respects nesting', () => {
  const { splitStatements } = require('../server/compiler');
  assert.deepEqual(splitStatements('const a = {x:1;}; const b = "a;b"'), ['const a = {x:1;}', 'const b = "a;b"']);
});

test('markdown prose lowers to title / text+bold / list like the captured artifact', () => {
  const r = compile('## 这个示例体现了什么？\n\n它不只是 **图表**。\n\n1. **注入**：联动\n2. 第二项');
  assert.ok(r.code.includes('__dil.jsx("title",{"size":"lg"},__dilConstants["0"])'));
  assert.ok(r.code.includes('__dil.jsx("text",null,__dilConstants["1"],__dil.jsx("bold",null,__dilConstants["2"])'));
  assert.ok(r.code.includes('__dil.jsx("list",{"marker":"number"},__dil.jsx("list-item",null,__dil.jsx("text",null,__dil.jsx("bold"'));
  assert.ok(!Object.values(r.constants).some((c) => typeof c === 'string' && c.includes('**')), 'no raw markdown left in constants');
});

test('a paragraph keeps its interpolations inline; component text stays one flow', () => {
  const r = compile('本月 {n} 次\n\n<box>count: {n}</box>');
  assert.ok(r.code.includes('__dilSafe(()=>(__dil.jsx("text",null,__dilConstants["0"],(n),__dilConstants["1"])),null)'));
  assert.ok(r.code.includes('__dilSafe(()=>(__dil.jsx("box",null,__dilConstants["2"],(n))),null)'));
});

test('the fallback keeps the original markdown', () => {
  const r = compile('## 标题\n\n**粗体** 段落');
  assert.ok(r.fallbackMarkdown.includes('## 标题'));
  assert.ok(r.fallbackMarkdown.includes('**粗体**'));
});

test('HTML entities in prose are decoded', () => {
  const r = compile('<box><text>Usage &amp; Billing &lt;3</text></box>');
  assert.ok(Object.values(r.constants).includes('Usage & Billing <3'));
});

test('controlled state used but never declared is declared, seeded from the control', () => {
  const r = compile('<box><segmented-control value={usage} onChange={setUsage} options={[{"label":"办公","value":"office"},{"label":"剪辑","value":"media"}]}/><slider value={budget} onChange={setBudget} min={6000} max={30000}/><checkbox checked={portable} onChange={setPortable}>便携</checkbox></box>');
  assert.deepEqual(r.stateKeys, ['usage', 'budget', 'portable']);
  assert.ok(r.code.includes('DIL.useState("office",{key:"usage"})'));
  assert.ok(r.code.includes('DIL.useState(6000,{key:"budget"})'));
  assert.ok(r.code.includes('DIL.useState(false,{key:"portable"})'));
  assert.equal(r.diagnostics.filter((d) => d.code === 'implicit_state').length, 3);
});

test('declared state is never re-declared', () => {
  const r = compile('{@body const [tab,setTab] = DIL.useState("b")}\n<segmented-control value={tab} onChange={setTab} options={[{"label":"A","value":"a"}]}/>');
  assert.deepEqual(r.stateKeys, ['tab']);
  assert.ok(!r.diagnostics.some((d) => d.code === 'implicit_state'));
});

test('a ```html fence around the document is dropped, not rendered', () => {
  const r = compile('说明文字。\n```html\n<box><text>hi</text></box>\n```\n收尾。');
  assert.ok(!Object.values(r.constants).some((c) => typeof c === 'string' && c.includes('```')));
  assert.equal(r.diagnostics.filter((d) => d.code === 'stripped_code_fence').length, 2);
});

test('the example in the system prompt compiles clean and runs', async () => {
  const { EXAMPLE } = require('../server/agent/system-prompt');
  const { bootSandbox } = require('../tools/node-sandbox');
  const r = compile('示例。\n' + EXAMPLE);
  assert.equal(r.diagnosticSummary, 'clean');
  const sb = bootSandbox();
  sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: r.appData });
  await sb.flush();
  assert.equal(sb.failures.length, 0);
  assert.ok(JSON.stringify(sb.latest.tree).includes('"t":"chart"'));
  sb.close();
});
