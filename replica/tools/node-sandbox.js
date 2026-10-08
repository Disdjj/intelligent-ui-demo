'use strict';
/**
 * Boot the real `sandbox/worker.js` inside Node so the whole runtime can be tested
 * and inspected without a browser. We provide the three globals a Worker would have
 * (`self`, `postMessage`, `MessageChannel`) and otherwise run the file verbatim.
 *
 * This is how `npm test` proves that compiled DIL actually executes.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');

const WORKER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'sandbox', 'worker.js'), 'utf8');

function bootSandbox() {
  const outbox = []; // everything the worker posts on its own global scope
  const diagnostics = [];
  const snapshots = [];
  let failures = [];

  const fakeSelf = {
    onmessage: null,
    postMessage(msg) {
      outbox.push(msg);
    },
    close() {},
  };

  const context = vm.createContext({
    self: fakeSelf,
    console,
    Promise,
    Map,
    Set,
    WeakMap,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    Symbol,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    structuredClone,
  });
  context.globalThis = context;
  vm.runInContext(WORKER_SOURCE, context, { filename: 'sandbox/worker.js' });

  const send = (data, ports = []) => fakeSelf.onmessage({ data, ports });

  // control channel (health checks / diagnostics)
  const control = new MessageChannel();
  control.port1.on('message', (m) => {
    if (m && m.kind === 'diagnostic') diagnostics.push(m);
  });
  control.port1.start();
  control.port1.unref && control.port1.unref();
  control.port2.unref && control.port2.unref();
  send({ __dilWorker: true, kind: 'initializeControl', protocolVersion: 1 }, [control.port2]);

  // data channel (compiled code / snapshots)
  const data = new MessageChannel();
  data.port1.on('message', (m) => {
    if (!m) return;
    if (m.kind === 'snapshot') snapshots.push(m);
    else if (m.kind === 'failure') failures.push(m);
    else if (m.kind === 'stateSnapshot') stateWaiters.splice(0).forEach((w) => w(m.state));
    else if (m.kind === 'stateChanged') stateChanges.push(m);
  });
  data.port1.start();
  // Node keeps the event loop alive for started ports; unref them so a test process
  // can exit on its own instead of needing process.exit().
  data.port1.unref && data.port1.unref();
  data.port2.unref && data.port2.unref();

  let seq = 0;
  const stateWaiters = [];
  const stateChanges = [];
  const api = {
    outbox,
    diagnostics,
    snapshots,
    get failures() {
      return failures;
    },
    get latest() {
      return snapshots[snapshots.length - 1] || null;
    },
    stateChanges,
    createRunner({ runnerId = 'runner-1', compiledDil, constants = {}, appData = {}, initialState = null, protocolVersion = 1 }) {
      snapshots.length = 0;
      failures = [];
      send({ __dilWorker: true, kind: 'createRunner', protocolVersion, runnerId, compiledDil, constants, appData, initialState }, [data.port2]);
      return api;
    },
    setCompiledDil(payload) {
      data.port1.postMessage({ __dilWorker: true, kind: 'command', command: 'setCompiledDil', id: 'c' + ++seq, data: payload });
      return api;
    },
    trigger(fnId, args = []) {
      send({ __dilWorker: true, kind: 'trigger', fnId, args });
      return api;
    },
    /** Ask the worker for its keyed state — the body of a `/dil/view_state` update. */
    requestState() {
      const p = new Promise((resolve) => stateWaiters.push(resolve));
      send({ __dilWorker: true, kind: 'stateSnapshotRequest' });
      return p;
    },
    healthCheck() {
      const requestId = 'h' + ++seq;
      control.port1.postMessage({ __dilWorker: true, kind: 'healthCheck', requestId });
      return requestId;
    },
    close() {
      try { control.port1.close(); } catch (e) {}
      try { control.port2.close(); } catch (e) {}
      try { data.port1.close(); } catch (e) {}
      try { data.port2.close(); } catch (e) {}
    },
  };

  // Port delivery is asynchronous and can take more than one turn (worker microtask →
  // data port → host port). Drain a few turns so tests never race the queue.
  api.flush = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    return api;
  };
  return api;
}

/** Collect every fnId referenced in a tree (used by tests and the CLI). */
function collectHandlers(tree, out = []) {
  if (!tree) return out;
  if (Array.isArray(tree)) {
    tree.forEach((t) => collectHandlers(t, out));
    return out;
  }
  if (tree.p) {
    for (const v of Object.values(tree.p)) {
      if (v && typeof v === 'object' && typeof v.__dilFn === 'string') out.push(v.__dilFn);
    }
  }
  if (tree.c) collectHandlers(tree.c, out);
  return out;
}

/** Render a serialized tree as indented text — handy for CLI verification. */
function treeToText(node, depth = 0, lines = []) {
  if (!node) return lines;
  const pad = '  '.repeat(depth);
  if (node.t === '#text') return lines.push(`${pad}"${node.v}"`), lines;
  if (node.t === '#frag') {
    for (const c of node.c || []) treeToText(c, depth, lines);
    return lines;
  }
  const props = Object.entries(node.p || {})
    .map(([k, v]) => `${k}=${v && v.__dilFn ? `⟪${v.__dilFn}⟫` : JSON.stringify(v)}`)
    .join(' ');
  lines.push(`${pad}<${node.t}${props ? ' ' + props : ''}>`);
  for (const c of node.c || []) treeToText(c, depth + 1, lines);
  return lines;
}

module.exports = { bootSandbox, collectHandlers, treeToText, WORKER_SOURCE };
