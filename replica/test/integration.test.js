'use strict';
/**
 * End-to-end tests: the whole loop, and the HTTP surface.
 *
 *   source → compile → sandbox → element tree → DOM → click → sandbox → DOM
 *
 * The DOM half runs on `linkedom`, the sandbox half on the real `sandbox/worker.js`,
 * and the transport between them is the real `MessageChannel` protocol. Nothing about
 * the mechanism under test is stubbed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { compile } = require('../server/compiler');
const { DEMO_SOURCE } = require('../server/agent/demo-source');
const { createHarness, closeAll } = require('../tools/dom-harness');
const { server } = require('../server/index');

test.after(() => closeAll());

// ---------------------------------------------------------------------------
// DOM integration
// ---------------------------------------------------------------------------

const COUNTER = [
  '{@body const [n,setN] = DIL.useState(0)}',
  '<box gap={2}>',
  '  <text>count: {n}</text>',
  '  <button onClick={()=>setN(n+1)}>inc</button>',
  '</box>',
].join('\n');

test('renders into DOM with data-d-component markers', async () => {
  const r = compile(COUNTER);
  const h = createHarness();
  await h.render(r.code, r.constants);
  assert.equal(h.text(), 'count: 0inc');
  assert.ok(h.html().includes('data-d-component="box"'));
  assert.ok(h.html().includes('data-d-component="text"'));
  assert.ok(h.html().includes('data-d-component="button"'));
});

test('a click travels to the sandbox and the result is patched back', async () => {
  const r = compile(COUNTER);
  const h = createHarness();
  await h.render(r.code, r.constants);
  await h.fire('[data-d-component="button"]');
  assert.equal(h.text(), 'count: 1inc');
  await h.fire('[data-d-component="button"]');
  assert.equal(h.text(), 'count: 2inc');
  assert.equal(h.events.length, 2);
});

test('DOM element identity is preserved across updates (focus safety)', async () => {
  const r = compile(COUNTER);
  const h = createHarness();
  await h.render(r.code, r.constants);
  const btnBefore = h.document.querySelector('[data-d-component="button"]');
  await h.fire('[data-d-component="button"]');
  const btnAfter = h.document.querySelector('[data-d-component="button"]');
  assert.equal(btnBefore, btnAfter, 'the same DOM node should be patched in place');
});

test('a controlled input keeps its value while new revisions stream in', async () => {
  const src = [
    '{@body const [q,setQ] = DIL.useState("")}',
    '<box><input value={q} onChange={setQ} placeholder="search"/><text>q={q}</text></box>',
  ].join('\n');
  const r = compile(src);
  const h = createHarness();
  await h.render(r.code, r.constants);

  const input = h.document.querySelector('[data-d-component="input"]');
  input.value = 'abc';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await h.settle();

  assert.equal(h.text(), 'q=abc');

  // now a *new revision* of the same program arrives mid-stream
  const r2 = compile(src + '\n<text>v2</text>');
  await h.push(r2.code, r2.constants);
  assert.ok(h.text().includes('q=abc'), 'state and input value must survive the recompile');
});

test('streaming every prefix of a document never breaks the view', async () => {
  const h = createHarness();
  let lastGood = 0;
  // Simulate the server: recompile and push as the document arrives.
  for (let n = 60; n <= DEMO_SOURCE.length; n += 400) {
    const r = compile(DEMO_SOURCE.slice(0, n));
    const snap = await h.push(r.code, r.constants);
    if (snap && snap.tree) lastGood += 1;
  }
  const final = compile(DEMO_SOURCE);
  await h.push(final.code, final.constants);
  assert.ok(lastGood > 0, 'at least some intermediate revisions should produce a tree');
  assert.ok(h.text().includes('Experiment Console'));
});

test('an unresolved host component renders a placeholder, not an error', async () => {
  const r = compile('<box><WeatherWidget city="sf"/><text>after</text></box>');
  const h = createHarness();
  await h.render(r.code, r.constants);
  assert.ok(h.html().includes('dil-widget-unresolved'));
  assert.ok(h.text().includes('after'), 'the rest of the tree still renders');
});

test('a chart renders without any model-authored markup', async () => {
  const r = compile('{@body const d = [{"label":"a","value":3},{"label":"b","value":7}]}\n<box><chart data={d} height={120}/></box>');
  const h = createHarness();
  await h.render(r.code, r.constants);
  const bars = h.document.querySelectorAll('.dil-chart-bar');
  assert.equal(bars.length, 2);
  assert.ok(h.html().includes('<title>a · value：3</title>'));
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function listen() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('http surface: health, compile, and a streamed conversation', async (t) => {
  const port = await listen();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.protocolVersion, 1);

  const compiled = await (
    await fetch(base + '/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: '<box><text>hi</text></box>' }),
    })
  ).json();
  assert.equal(compiled.ok, true);
  assert.ok(compiled.code.includes('DIL.render('));
  assert.equal(compiled.constantCount, 1);

  const bad = await fetch(base + '/api/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nope: 1 }),
  });
  assert.equal(bad.status, 400);

  // the sandbox document must ship a policy, not just declare one in <meta>
  const frameRes = await fetch(base + '/sandbox/runner.html');
  const csp = frameRes.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /worker-src blob: data:/);
  assert.match(csp, /script-src 'sha256-/);
  assert.ok(!csp.includes('unsafe-inline'));
  const frameHtml = await frameRes.text();
  assert.ok(frameHtml.includes('dil-worker-source'));

  // stream a conversation and check the patch protocol
  const res = await fetch(base + '/api/chat?q=test&speed=0');
  const text = await res.text();
  const patches = [];
  let complete = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    const obj = JSON.parse(payload);
    if (obj.type === 'message_stream_complete') complete = obj.stats;
    else if (obj.p) patches.push(obj);
  }

  assert.ok(patches.length > 10, 'expected many patches, got ' + patches.length);
  const appends = patches.filter((p) => p.p === '/message/content/parts/0' && p.o === 'append');
  assert.ok(appends.length > 50);
  // the whole source arrives as appends, in order
  assert.ok(appends.map((p) => p.v).join('').includes('Experiment Console'));

  const codeRevisions = patches.filter((p) => p.p.endsWith('/code') && p.o === 'replace');
  assert.ok(codeRevisions.length >= 5, 'expected several whole-program revisions, got ' + codeRevisions.length);
  // every revision is a complete program, never a fragment
  for (const rev of codeRevisions) {
    assert.ok(rev.v.includes('DIL.render('), 'each revision must be self-contained');
  }
  // revisions grow monotonically (the final one is the biggest)
  const sizes = codeRevisions.map((r) => r.v.length);
  assert.ok(sizes[sizes.length - 1] >= Math.max(...sizes));

  assert.ok(complete, 'expected a completion summary');
  assert.equal(complete.sourceLength, DEMO_SOURCE.length);
  assert.equal(complete.diagnostics, 0);
  assert.ok(complete.compiles >= 5);
});

test('http surface: static files stay inside public/', async (t) => {
  const port = await listen();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  // `fetch` normalises a literal `/../`, so encode the dots to make the traversal
  // actually reach the server
  // each target exists only *outside* public/, so a 200 would mean a real escape
  for (const p of ['/%2e%2e/server/config.js', '/dil/%2e%2e/%2e%2e/server/index.js', '/%2e%2e/%2e%2e/artifacts/genui-source.dil.md']) {
    const res = await fetch(base + p);
    assert.ok(res.status === 403 || res.status === 404, `${p} must not be served, got ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// captured artifact, end to end in the DOM
// ---------------------------------------------------------------------------

test('the captured source renders multi-series SVG charts and a resolved MemoryCite', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'artifacts', 'genui-source.dil.md'), 'utf8');
  const r = compile(src);
  const h = createHarness();
  await h.render(r.code, r.constants, r.appData);
  const svgs = h.document.querySelectorAll('.dil-chart-svg');
  assert.equal(svgs.length, 2);
  assert.equal(svgs[0].querySelectorAll('.dil-chart-line').length, 2, 'revenue + cost lines');
  assert.ok(h.html().includes('收入'), 'legend carries series labels');
  const cite = h.document.querySelector('[data-d-component="MemoryCite"]');
  assert.ok(cite && cite.className.includes('dil-memory-cite'), 'MemoryCite resolves through componentResults');
});

test('a host component without a resolved result stays a placeholder', async () => {
  const r = compile('<box><MemoryCite/></box>');
  const h = createHarness();
  await h.render(r.code, r.constants, {}); // no componentResults shipped
  assert.ok(h.html().includes('dil-widget-unresolved'));
});

test('checkbox: children are the label, `checked` drives state, `value` is tolerated', async () => {
  const r = compile('{@body const [a,setA] = DIL.useState(false)}\n<box><checkbox checked={a} onChange={setA}>写报告</checkbox><checkbox value={true} label="旧写法"/></box>');
  const h = createHarness();
  await h.render(r.code, r.constants);
  const boxes = h.document.querySelectorAll('[data-d-component="checkbox"]');
  assert.ok(boxes[0].querySelector('.dil-checkbox-body').textContent.includes('写报告'));
  assert.ok(boxes[1].className.includes('dil-checked'));
  assert.ok(boxes[1].textContent.includes('旧写法'));
  const input = boxes[0].querySelector('input');
  input.checked = true;
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.settle();
  const after = h.document.querySelectorAll('[data-d-component="checkbox"]')[0];
  assert.ok(after.className.includes('dil-checked'), 'state round-tripped through the sandbox');
});

test('radio-group with <radio> children (the captured dialect) selects one and reports its value', async () => {
  const r = compile('{@body const [m,setM] = DIL.useState("b")}\n<radio-group value={m} onChange={setM}><radio value="a">A</radio><radio value="b">B</radio><radio value="c">C</radio></radio-group><text>sel={m}</text>');
  const h = createHarness();
  await h.render(r.code, r.constants);
  const checked = () => [...h.document.querySelectorAll('.dil-radio.dil-checked')].map((n) => n.textContent);
  assert.deepEqual(checked(), ['B']);
  const input = h.document.querySelectorAll('.dil-radio input')[2];
  input.checked = true;
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.settle();
  assert.deepEqual(checked(), ['C']);
  assert.ok(h.text().includes('sel=c'));
});

test('radio-group with options still works', async () => {
  const r = compile('{@body const [m,setM] = DIL.useState(2)}\n<radio-group value={m} onChange={setM} options={[{"label":"one","value":1},{"label":"two","value":2}]}/>');
  const h = createHarness();
  await h.render(r.code, r.constants);
  assert.deepEqual([...h.document.querySelectorAll('.dil-radio.dil-checked')].map((n) => n.textContent), ['two']);
});
