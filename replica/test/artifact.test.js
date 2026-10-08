'use strict';
/**
 * Fidelity tests against the *captured* ChatGPT artifact (`artifacts/`), not a
 * hand-written demo. If the replica can compile and run what the real model wrote,
 * and reports the same state the real client reported, the dialect is right.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compile, rewriteStatement } = require('../server/compiler');
const { bootSandbox, collectHandlers } = require('../tools/node-sandbox');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'artifacts', 'genui-source.dil.md'), 'utf8');
const REAL_CODE = fs.readFileSync(path.join(ROOT, 'artifacts', 'genui-compiled.js'), 'utf8');
const VIEW_STATE = JSON.parse(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'captures', 'record-421-view-state.json'), 'utf8')).request.body.text
);

const sandboxes = [];
test.after(() => sandboxes.forEach((sb) => { try { sb.close(); } catch (e) {} }));

async function boot(r) {
  const sb = bootSandbox();
  sandboxes.push(sb);
  sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: r.appData });
  await sb.flush();
  return sb;
}

function texts(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  if (node.t === '#text') { out.push(node.v); return out; }
  (node.c || []).forEach((n) => texts(n, out));
  return out;
}

function find(node, pred, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  (node.c || []).forEach((n) => find(n, pred, out));
  return out;
}

const r = compile(SOURCE);

test('the captured source compiles without a single diagnostic', () => {
  assert.equal(r.diagnosticSummary, 'clean');
  assert.deepEqual(r.requiredComponents, ['MemoryCite'], 'Chart is a compiler shim, not a host component');
});

test('useState keys match the real artifact and the captured view_state body', () => {
  const realKeys = [...REAL_CODE.matchAll(/DIL\.useState\([^)]*?\{key:"(\w+)"\}\)/g)].map((m) => m[1]);
  assert.deepEqual(r.stateKeys, realKeys);
  assert.deepEqual(r.stateKeys, Object.keys(VIEW_STATE.updates[0].state));
  for (const k of realKeys) assert.ok(r.code.includes(`{key:"${k}"}`), 'missing key ' + k);
});

test('derived declarations are guarded exactly like the artifact', () => {
  assert.equal(
    rewriteStatement('const n = period==="7"?7:period==="30"?10:12'),
    'const n = __dilSafe(()=>(period==="7"?7:period==="30"?10:12),undefined)'
  );
  assert.ok(REAL_CODE.includes('const n = __dilSafe(()=>(period==="7"?7:period==="30"?10:12),undefined)'));
  // function declarations and hooks are left alone
  assert.equal(rewriteStatement('function f(){return 1}'), 'function f(){return 1}');
  assert.equal(rewriteStatement('const d = DIL.useAppData(a=>a)'), 'const d = DIL.useAppData(a=>a)');
});

test('the initial state snapshot equals what ChatGPT POSTed to /dil/view_state', async () => {
  const sb = await boot(r);
  assert.equal(sb.failures.length, 0);
  const state = await sb.requestState();
  assert.deepEqual(state, VIEW_STATE.updates[0].state);
});

test('<Chart content={…}/> lowers to card + intrinsic chart with series', async () => {
  const sb = await boot(r);
  const charts = find(sb.latest.tree, (n) => n.t === 'chart');
  assert.equal(charts.length, 2, 'overview tab shows the trend line and the channel bar chart');
  const line = charts[0].p;
  assert.equal(line.xAxis.dataKey, 'period');
  assert.deepEqual(line.series.map((s) => s.dataKey), ['revenue', 'cost']);
  assert.equal(line.series[0].type, 'line');
  assert.equal(line.data.length, 7);
});

test('a broken chart spec degrades to its fallback instead of throwing', async () => {
  const bad = compile('<box><Chart content={{"chartType":"donut","data":[]}}/><text>after</text></box>');
  const sb = await boot(bad);
  assert.equal(sb.failures.length, 0);
  assert.equal(find(sb.latest.tree, (n) => n.t === 'chart').length, 0);
  assert.ok(texts(sb.latest.tree).includes('after'));
});

test('host components carry a resolution id that appData can resolve', async () => {
  const sb = await boot(r);
  const [cite] = find(sb.latest.tree, (n) => n.t === 'MemoryCite');
  assert.ok(cite, 'MemoryCite should reach the host');
  const id = cite.p.__resolutionId;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(r.appData.opGenui.componentResults[id].componentName, 'MemoryCite');
});

test('all three workspaces render and their handlers work', async () => {
  const sb = await boot(r);
  const [tabs] = find(sb.latest.tree, (n) => n.t === 'segmented-control' && n.p.value === 'overview');
  assert.ok(tabs, 'tab switcher present');

  sb.trigger(tabs.p.onChange.__dilFn, ['sandbox']);
  await sb.flush();
  let all = texts(sb.latest.tree).join('');
  assert.ok(all.includes('计费沙盒') || all.includes('Credits'), 'sandbox tab rendered');

  // charge once: wallet decreases and the ledger gains a row
  const before = (await sb.requestState()).wallet;
  const charge = find(sb.latest.tree, (n) => n.t === 'button' && texts(n).join('').includes('试扣'))[0];
  assert.ok(charge, 'charge button present');
  sb.trigger(charge.p.onClick.__dilFn, []);
  await sb.flush();
  const after = await sb.requestState();
  assert.ok(after.wallet < before, `wallet ${before} → ${after.wallet}`);
  assert.equal(after.ledger.length, 1);

  const [tabs2] = find(sb.latest.tree, (n) => n.t === 'segmented-control' && n.p.value === 'sandbox');
  sb.trigger(tabs2.p.onChange.__dilFn, ['audit']);
  await sb.flush();
  all = texts(sb.latest.tree).join('');
  assert.ok(all.includes('EVT-1042'), 'audit tab lists events');
  assert.equal(collectHandlers(sb.latest.tree).length > 0, true);
});

test('every streamed prefix of the real source compiles and never throws in the sandbox', async () => {
  const sb = bootSandbox();
  sandboxes.push(sb);
  let started = false;
  let rendered = 0;
  for (let n = 400; n <= SOURCE.length; n += 997) {
    const part = compile(SOURCE.slice(0, n));
    if (!started) { sb.createRunner({ compiledDil: part.code, constants: part.constants, appData: part.appData }); started = true; }
    else sb.setCompiledDil({ compiledDil: part.code, constants: part.constants, appData: part.appData });
    await sb.flush();
    if (sb.latest && sb.latest.tree) rendered++;
  }
  assert.ok(rendered > 10, 'most prefixes should produce a tree, got ' + rendered);
});

// ---------------------------------------------------------------------------
// genui_components
// ---------------------------------------------------------------------------

const { genuiComponentPatches } = require('../server/index');

test('genui_components source ranges match the capture exactly (code-point offsets)', () => {
  const got = r.genuiComponents.map((c) => [c.type, c.start_index, c.end_index]);
  assert.deepEqual(got, [
    ['charts_widget_v2', 8021, 8209],
    ['charts_widget_v2', 8416, 8723],
    ['charts_widget_v2', 14464, 14740],
    ['memory_cite', 23408, 23422],
  ]);
  assert.equal(r.genuiComponents[3].component_resolution_id, r.constants[Object.keys(r.constants).pop()]);
});

test('a widget that is still being written is marked and its end grows', () => {
  const a = compile(SOURCE.slice(0, 8045)).genuiComponents;
  const b = compile(SOURCE.slice(0, 8150)).genuiComponents;
  assert.equal(a[0].streaming, true);
  assert.ok(b[0].end_index > a[0].end_index);
  const done = compile(SOURCE.slice(0, 8300)).genuiComponents;
  assert.equal(done[0].end_index, 8209);
  assert.equal(done[0].streaming, undefined);
});

test('component patches use the captured add / replace end_index / append ops', () => {
  const steps = [8045, 8150, 8300, 8500, 9000].map((n) => compile(SOURCE.slice(0, n)).genuiComponents);
  const ops = [];
  let prev = [];
  for (const next of steps) { ops.push(...genuiComponentPatches(prev, next)); prev = next; }
  assert.equal(ops[0].o, 'add');
  assert.equal(ops[0].p, '/message/metadata/genui_components');
  assert.ok(ops.some((o) => o.p === '/message/metadata/genui_components/0/end_index' && o.o === 'replace'));
  assert.ok(ops.some((o) => o.o === 'append' && o.v[0].start_index === 8416));
});
