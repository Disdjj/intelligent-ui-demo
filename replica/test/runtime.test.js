'use strict';
/**
 * Sandbox runtime tests — the real `sandbox/worker.js`, executed in Node with the
 * globals a Worker would provide. No browser, no mocks of the thing being tested.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('../server/compiler');
const { bootSandbox, collectHandlers, treeToText } = require('../tools/node-sandbox');
const { DEMO_SOURCE } = require('../server/agent/demo-source');

// Every sandbox owns live MessagePorts; close them or the test process never exits.
const sandboxes = [];
function make() {
  const sb = bootSandbox();
  sandboxes.push(sb);
  return sb;
}
test.after(() => {
  for (const sb of sandboxes) {
    try { sb.close(); } catch (e) {}
  }
});

async function run(source) {
  const r = compile(source);
  const sb = make();
  sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: {} });
  await sb.flush();
  return { sb, compiled: r, snapshot: sb.latest };
}

/**
 * Collect every text leaf in document order. `{#each}` produces a nested #frag, so a
 * flat walk over `.c` is not enough — the renderer flattens, the tests must too.
 */
function texts(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  if (node.t === '#text') { out.push(node.v); return out; }
  (node.c || []).forEach((n) => texts(n, out));
  return out;
}

test('evaluates a compiled program and emits a tree', async () => {
  const { snapshot } = await run('<box><text>hello</text></box>');
  assert.ok(snapshot, 'expected a snapshot');
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.tree.t, 'box');
  assert.equal(snapshot.tree.c[0].t, 'text');
  assert.equal(snapshot.tree.c[0].c[0].v, 'hello');
});

test('reports protocol mismatch instead of trying to run', async () => {
  const sb = make();
  sb.createRunner({ compiledDil: 'DIL.render(null)', protocolVersion: 99 });
  await sb.flush();
  assert.equal(sb.latest, null);
  assert.ok(sb.diagnostics.some((d) => d.phase === 'rejected'));
});

test('a syntax error becomes a failure message, not a crash', async () => {
  const sb = make();
  sb.createRunner({ compiledDil: 'DIL.render(__dil.jsx(()=>{ this is not js },{}));' });
  await sb.flush();
  // the failure lands on the data port; snapshots stay empty
  assert.equal(sb.latest, null);
});

test('a runtime error inside the program is contained', async () => {
  const sb = make();
  sb.createRunner({ compiledDil: 'DIL.render(__dil.jsx(()=>{ throw new Error("boom") },{}));' });
  await sb.flush();
  assert.ok(sb.failures.length >= 1, 'expected a failure event');
  assert.match(JSON.stringify(sb.failures[0]), /boom/);
});

test('useState initial values reach the tree', async () => {
  const { snapshot } = await run('{@body const [n] = DIL.useState(42)}<box><text>{n}</text></box>');
  assert.equal(snapshot.tree.c[0].c[0].v, '42');
});

test('state survives a re-render caused by setState', async () => {
  const { sb, snapshot } = await run(
    '{@body const [n,setN] = DIL.useState(1)}\n<box><text>{n}</text><button onClick={()=>setN(n*10)}>x</button></box>'
  );
  const fnId = collectHandlers(snapshot.tree)[0];
  sb.trigger(fnId, []);
  await sb.flush();
  assert.equal(sb.latest.tree.c[0].c[0].v, '10');
});

test('state survives a recompile (streaming must not reset the UI)', async () => {
  const v1 = compile('{@body const [n,setN] = DIL.useState(5)}\n<box><text>{n}</text><button onClick={()=>setN(n+1)}>x</button></box>');
  const sb = make();
  sb.createRunner({ compiledDil: v1.code, constants: v1.constants, appData: {} });
  await sb.flush();
  sb.trigger(collectHandlers(sb.latest.tree)[0], []);
  await sb.flush();
  assert.equal(sb.latest.tree.c[0].c[0].v, '6');

  // a new revision of the same program arrives mid-stream
  const v2 = compile('{@body const [n,setN] = DIL.useState(5)}\n<box><text>value {n}</text><button onClick={()=>setN(n+1)}>x</button></box>');
  sb.setCompiledDil({ compiledDil: v2.code, constants: v2.constants, appData: {} });
  await sb.flush();
  const rendered = texts(sb.latest.tree).join('');
  assert.ok(rendered.includes('value') && rendered.includes('6'), 'state should carry across the recompile: ' + rendered);
});

test('semantic keys let two states be told apart', async () => {
  const { snapshot } = await run(
    '{@body const [a] = DIL.useState(1,{key:"a"})}\n{@body const [b] = DIL.useState(2,{key:"b"})}\n<box><text>{a}-{b}</text></box>'
  );
  assert.equal(snapshot.tree.c[0].c[0].v, '1');
  assert.equal(snapshot.tree.c[0].c[2].v, '2');
});

test('handler arguments are passed through (controlled inputs)', async () => {
  const { sb, snapshot } = await run(
    '{@body const [v,setV] = DIL.useState("a")}\n<box><select value={v} onChange={setV} options={[{"label":"A","value":"a"},{"label":"B","value":"b"}]}/></box>'
  );
  const fnId = collectHandlers(snapshot.tree)[0];
  sb.trigger(fnId, ['b']);
  await sb.flush();
  assert.equal(sb.latest.tree.c[0].p.value, 'b');
});

test('loops expand against live state', async () => {
  const { snapshot } = await run(
    '{@body const xs = ["a","b","c"]}\n<box>{#each xs as x}<text>{x}</text>{/each}</box>'
  );
  assert.deepEqual(texts(snapshot.tree).filter((t) => ['a', 'b', 'c'].includes(t)), ['a', 'b', 'c']);
});

test('conditionals pick the right branch', async () => {
  const on = await run('{@body const x = 1}\n<box>{#if x>0}<text>yes</text>{:else}<text>no</text>{/if}</box>');
  assert.equal(on.snapshot.tree.c[0].c[0].v, 'yes');
  const off = await run('{@body const x = -1}\n<box>{#if x>0}<text>yes</text>{:else}<text>no</text>{/if}</box>');
  assert.equal(off.snapshot.tree.c[0].c[0].v, 'no');
});

test('a throwing expression degrades to its fallback, not the whole tree', async () => {
  // `__dilSafe(()=>…, null)` is what makes one bad expression survivable.
  // The failing element drops out on its own; its siblings render (artifact semantics).
  const { snapshot } = await run('<box><text>ok</text><text>{undefinedThing.deep}</text><text>still here</text></box>');
  assert.ok(snapshot, 'tree should still render');
  assert.equal(snapshot.tree.c.length, 2);
  assert.equal(snapshot.tree.c[0].c[0].v, 'ok');
  assert.equal(snapshot.tree.c[1].c[0].v, 'still here');
});

test('an undefined variable in a prop removes one control, not the interface', async () => {
  // Real model output (MacBook guide): `options={usageOpts}` with usageOpts never declared
  // used to throw out of the render and leave the message blank.
  const { sb, snapshot } = await run(
    '<box><title>选购指南</title><segmented-control options={usageOpts} value={usage} onChange={setUsage}/><text>其余内容</text></box>'
  );
  assert.equal(sb.failures.length, 0);
  assert.deepEqual(texts(snapshot.tree), ['选购指南', '其余内容']);
});

test('useAppData exposes host-provided bindings', async () => {
  const r = compile('{@body const d = DIL.useAppData(a=>a.greeting)}\n<box><text>{d}</text></box>');
  const sb = make();
  sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: { greeting: 'hi from host' } });
  await sb.flush();
  assert.equal(sb.latest.tree.c[0].c[0].v, 'hi from host');
});

test('handlers are not serialized as functions', async () => {
  const { snapshot } = await run('<box><button onClick={()=>1}>x</button></box>');
  const props = snapshot.tree.c[0].p;
  assert.equal(typeof props.onClick, 'object');
  assert.match(props.onClick.__dilFn, /^fn\d+$/);
  // and the tree must survive a structured clone (it crosses a port)
  assert.doesNotThrow(() => JSON.stringify(snapshot.tree));
});

test('the full demo document renders all three tabs', async () => {
  const r = compile(DEMO_SOURCE);
  const sb = make();
  sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: {} });
  await sb.flush();
  assert.equal(sb.latest.error, null);

  const text = treeToText(sb.latest.tree).join('\n');
  assert.ok(text.includes('Experiment Console'));
  assert.ok(text.includes('当前放量'));

  // switch to the allocation tab via its segmented control, then to runs
  const switchTab = (value) => {
    const seg = findTag(sb.latest.tree, 'segmented-control')[0];
    const fnId = seg.p.onChange.__dilFn;
    sb.trigger(fnId, [value]);
  };
  switchTab('allocation');
  await sb.flush();
  let tree = treeToText(sb.latest.tree).join('\n');
  assert.ok(tree.includes('目标环境'), 'allocation tab should render');
  assert.ok(tree.includes('启用护栏自动回滚'));

  switchTab('runs');
  await sb.flush();
  tree = treeToText(sb.latest.tree).join('\n');
  assert.ok(tree.includes('RUN'), 'runs tab should render');
  assert.ok(tree.includes('run-1041'));
});

test('the sandbox has no ambient authority', async () => {
  // The worker is spawned with a restricted global object; these must all be absent
  // or inert. This is the "no DOM, no IO" half of the isolation story.
  const { snapshot } = await run(
    '{@body const kinds = [typeof fetch, typeof XMLHttpRequest, typeof document, typeof window, typeof localStorage, typeof importScripts]}\n' +
      '<box>{#each kinds as k}<text>{k}</text>{/each}</box>'
  );
  const values = texts(snapshot.tree).filter((t) => t === 'undefined');
  assert.equal(values.length, 6);
});

function findTag(node, tag, out) {
  out = out || [];
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => findTag(n, tag, out)); return out; }
  if (node.t === tag) out.push(node);
  (node.c || []).forEach((n) => findTag(n, tag, out));
  return out;
}

test('undeclared state whose option list is also undeclared still renders', async () => {
  const { sb, snapshot } = await run('<box><title>指南</title><segmented-control options={usageOpts} value={usage} onChange={setUsage}/><text>正文</text></box>');
  assert.equal(sb.failures.length, 0);
  assert.deepEqual(texts(snapshot.tree), ['指南', '正文']);
});
