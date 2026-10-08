'use strict';
/**
 * The state loop (ANALYSIS.md §8): sandbox state → `/dil/view_state` → server store →
 * `genui_state_snapshots` on the next turn. Uses the captured request body as the
 * golden input.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createViewStateStore, snapshotsToContext, validateState } = require('../server/view-state');
const { compile } = require('../server/compiler');
const { bootSandbox } = require('../tools/node-sandbox');

const CAPTURED = JSON.parse(
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'captures', 'record-421-view-state.json'), 'utf8')).request.body.text
);

const sandboxes = [];
test.after(() => sandboxes.forEach((sb) => { try { sb.close(); } catch (e) {} }));

test('the captured request body is accepted and answered in the captured shape', () => {
  const store = createViewStateStore();
  const res = store.apply('conv', 'msg', CAPTURED);
  assert.deepEqual(res, { status: 'success', updated_scopes: 0, message_id: 'msg', conversation_id: 'conv' });
  assert.deepEqual(store.get('msg'), CAPTURED.updates[0].state);
});

test('a first report is a baseline; a later different report counts as an update', () => {
  const store = createViewStateStore();
  store.apply('c', 'm', { updates: [{ scope: 'root', state: { tab: 'overview' }, client_update_id: 'u1' }] });
  const same = store.apply('c', 'm', { updates: [{ scope: 'root', state: { tab: 'overview' }, client_update_id: 'u2' }] });
  assert.equal(same.updated_scopes, 0, 'unchanged state is not an update');
  const changed = store.apply('c', 'm', { updates: [{ scope: 'root', state: { tab: 'audit' }, client_update_id: 'u3' }] });
  assert.equal(changed.updated_scopes, 1);
  assert.equal(store.get('m').tab, 'audit');
});

test('client_update_id makes retries idempotent', () => {
  const store = createViewStateStore();
  store.apply('c', 'm', { updates: [{ state: { n: 1 }, client_update_id: 'a' }] });
  store.apply('c', 'm', { updates: [{ state: { n: 2 }, client_update_id: 'b' }] });
  const replay = store.apply('c', 'm', { updates: [{ state: { n: 1 }, client_update_id: 'a' }] });
  assert.equal(replay.updated_scopes, 0);
  assert.equal(store.get('m').n, 2, 'a replayed old update must not roll state back');
});

test('state validation rejects non-JSON and oversize payloads', () => {
  assert.equal(validateState({ a: 1, b: [1, 2], c: { d: 'x' } }), null);
  assert.ok(validateState(null));
  assert.ok(validateState([1, 2]));
  assert.ok(validateState({ f: () => 1 }));
  assert.ok(validateState({ big: 'x'.repeat(20000) }));
  const store = createViewStateStore();
  assert.ok(store.apply('c', 'm', { updates: [{ scope: '../etc', state: {} }] }).error);
});

test('only user-modified scopes reach the model context', () => {
  const store = createViewStateStore();
  store.apply('c', 'm1', { updates: [{ state: { tab: 'overview' } }] });
  assert.equal(snapshotsToContext(store.snapshots('c')), '', 'untouched initial state costs no tokens');
  store.apply('c', 'm1', { updates: [{ state: { tab: 'audit', riskOnly: true } }] });
  store.apply('other', 'm2', { updates: [{ state: { x: 1 } }, { state: { x: 2 } }] });
  const ctx = snapshotsToContext(store.snapshots('c'));
  assert.ok(ctx.includes('"tab":"audit"'));
  assert.ok(!ctx.includes('"x"'), 'snapshots are scoped to their conversation');
});

test('the sandbox emits the initial state and then each keyed change', async () => {
  const r = compile('{@body const [n,setN] = DIL.useState(0)}\n{@body const [tmp,setTmp] = DIL.useState(0,{key:"tmp"})}\n<box><button onClick={()=>setN(n+1)}>+</button></box>');
  const sb = bootSandbox();
  sandboxes.push(sb);
  sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: r.appData });
  await sb.flush();
  assert.equal(sb.stateChanges.length, 1);
  assert.equal(sb.stateChanges[0].reason, 'initial');
  assert.deepEqual(sb.stateChanges[0].state, { n: 0, tmp: 0 });

  const btn = sb.latest.tree.c[0].p.onClick.__dilFn;
  sb.trigger(btn, []);
  await sb.flush();
  assert.equal(sb.stateChanges.length, 2);
  assert.deepEqual(sb.stateChanges[1].state, { n: 1, tmp: 0 });
  assert.equal(sb.stateChanges[1].scope, 'root');
});

test('a saved snapshot restores the UI where the user left it', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'artifacts', 'genui-source.dil.md'), 'utf8');
  const r = compile(src);
  const sb = bootSandbox();
  sandboxes.push(sb);
  const saved = Object.assign({}, CAPTURED.updates[0].state, { tab: 'audit', riskOnly: true });
  sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: r.appData, initialState: saved });
  await sb.flush();
  const state = await sb.requestState();
  assert.equal(state.tab, 'audit');
  assert.equal(state.riskOnly, true);
  assert.equal(state.wallet, 250, 'keys absent from the snapshot keep their initial value');
});

test('http: view_state round trip and snapshot replay into the next turn', async (t) => {
  const { server, viewState } = require('../server/index');
  viewState.clear();
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const post = (body) => fetch(`${base}/api/conversation/conv_t/message/msg_t/dil/view_state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  const first = await post(CAPTURED);
  assert.equal(first.status, 200);
  assert.equal(first.json.updated_scopes, 0);
  const second = await post({ client_session_id: 's', updates: [{ scope: 'root', state: { ...CAPTURED.updates[0].state, tab: 'audit' }, client_update_id: 'x' }] });
  assert.equal(second.json.updated_scopes, 1);

  const bad = await post({ updates: 'nope' });
  assert.equal(bad.status, 400);

  const snaps = await fetch(`${base}/api/conversation/conv_t/state_snapshots`).then((r) => r.json());
  assert.equal(snaps.genui_state_snapshots.length, 1);
  assert.ok(snaps.context.includes('"tab":"audit"'));

  // the next turn in the same conversation announces the replayed snapshots
  const sse = await fetch(`${base}/api/chat?conversation_id=conv_t&speed=0&source=${encodeURIComponent('<box><text>hi</text></box>')}`).then((r) => r.text());
  assert.match(sse, /"genui_state_snapshots":1/);
  assert.ok(sse.includes('event: note') && sse.includes('genui_state_snapshots —'));
});

test('http: an explicit source is replayed, never sent to the model', async (t) => {
  const { server } = require('../server/index');
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const sse = await fetch(`http://127.0.0.1:${port}/api/chat?speed=0&source=captured`).then((r) => r.text());
  assert.ok(sse.includes('mock · mock-dil-author'), 'replay must use the mock agent');
  assert.ok(sse.includes('Acme Billing'), 'the captured document is what streams');
});
