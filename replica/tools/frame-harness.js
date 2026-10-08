'use strict';
/**
 * Frame harness: runs the *real* `sandbox/frame.js` script in Node, with shims for the
 * four browser globals it touches (`window`, `document`, `MessageChannel`, `Worker`).
 *
 * The Worker shim evaluates the *real* `sandbox/worker.js` in its own VM context, so
 * this exercises the complete sandbox protocol — host → frame → worker → frame → host —
 * without a browser. That matters because the browser is where this logic is hardest to
 * observe: the iframe has an opaque origin, so DevTools cannot reach into it.
 *
 * The one thing it cannot cover is browser *policy* (CSP, blob: Workers, opaque
 * origins). `public/diag.html` covers that, and `tools/browser-check.js` drives it.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');

const { FRAME_SCRIPT, WORKER_SOURCE } = require('../server/sandbox/frame');

const PROTOCOL = 1;

/** A Worker that actually runs the real sandbox source in a separate VM context. */
function createWorkerShim() {
  function FakeWorker(url, options) {
    this.url = url;
    this.name = options && options.name;
    this.onmessage = null;
    this._listeners = [];
    this.terminated = false;
    this._hostPort = null;

    const outbox = this.outbox = [];
    const workerSelf = {
      onmessage: null,
      postMessage: (msg) => {
        outbox.push(msg);
        deliver(this, msg);
      },
      close: () => { this.terminated = true; },
    };

    const context = vm.createContext({
      self: workerSelf,
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
    this._self = workerSelf;
    this._context = context;
  }

  function deliver(worker, msg) {
    // the frame's data port is delivered as a transferred port in `ports`
    const ports = worker._pendingPorts || [];
    worker._pendingPorts = [];
    for (const fn of worker._listeners) fn({ data: msg });
    if (worker.onmessage) worker.onmessage({ data: msg });
    if (worker._self.onmessage) worker._self.onmessage({ data: msg, ports });
  }

  FakeWorker.prototype.addEventListener = function (type, fn) {
    if (type === 'error') this._listeners.push(fn);
  };
  FakeWorker.prototype.postMessage = function (msg, ports) {
    if (this.terminated) return;
    this._pendingPorts = (ports || []).slice();
    // Deliver asynchronously, like a real Worker boundary.
    setTimeout(() => {
      if (this.terminated) return;
      this._self.onmessage({ data: msg, ports: this._pendingPorts });
    }, 0);
  };
  FakeWorker.prototype.terminate = function () {
    this.terminated = true;
  };

  return FakeWorker;
}

/**
 * Build a frame environment and return a "host" object that speaks the documented
 * protocol to it.
 */
function createFrameHarness(options = {}) {
  const FakeWorker = createWorkerShim();
  const hostInbox = [];
  const frameDiagnostics = [];

  const workerSourceText = WORKER_SOURCE;

  const documentShim = {
    readyState: 'loading',
    getElementById(id) {
      if (id !== 'dil-worker-source') return null;
      // Mirrors the real trap: a <template>'s text lives in .content.
      return { content: { textContent: workerSourceText } };
    },
    addEventListener() {},
  };

  const messageSink = { fn: null };
  const windowShim = {
    __sink: (msg) => { if (messageSink.fn) messageSink.fn(msg); },
    URL: {
      createObjectURL: () => 'blob:dil-sandbox/' + Math.random().toString(36).slice(2),
      revokeObjectURL: () => {},
    },
    parent: {
      postMessage(msg) {
        if (msg && msg.kind === 'diagnostic') frameDiagnostics.push(msg);
        hostInbox.push(msg);
        const sink = windowShim && windowShim.__sink;
        if (sink) sink(msg);
      },
    },
    addEventListener() {},
  };

  const context = vm.createContext({
    window: windowShim,
    document: documentShim,
    MessageChannel,
    Worker: FakeWorker,
    Blob: class Blob {
      constructor(parts) {
        this.parts = parts;
      }
    },
    URL: {
      createObjectURL: () => 'blob:dil-sandbox/' + Math.random().toString(36).slice(2),
      revokeObjectURL: () => {},
    },
    console,
    Promise,
    Map,
    Set,
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
    parseInt,
    parseFloat,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    queueMicrotask,
  });
  context.globalThis = context;

  const snapshots = [];
  const failures = [];
  const acks = [];
  let frameMessageListener = null;
  windowShim.addEventListener = (type, fn) => {
    if (type === 'message') frameMessageListener = fn;
  };
  vm.runInContext(FRAME_SCRIPT, context, { filename: 'sandbox/frame-script.js' });

  if (!hostInbox.some((m) => m.kind === 'ready')) throw new Error('frame never posted a ready message');

  messageSink.fn = (msg) => {
    if (!msg || msg.__dilFrame !== true) return;
    if (msg.kind === 'snapshot') snapshots.push(msg);
    else if (msg.kind === 'failure') failures.push(msg);
    else if (msg.kind === 'ack') acks.push(msg);
  };

  function deliverToFrame(msg) {
    if (!frameMessageListener) throw new Error('frame registered no message listener');
    // the frame filters on event.source === window.parent
    frameMessageListener({ source: windowShim.parent, data: msg });
  }

  return {
    diagnostics: frameDiagnostics,
    snapshots,
    failures,
    acks,
    readyMessage: hostInbox.find((m) => m.kind === 'ready'),
    createRunner(payload) {
      deliverToFrame(Object.assign({ __dilFrame: true, kind: 'createRunner', protocolVersion: PROTOCOL }, payload));
    },
    setCompiledDil(payload) {
      deliverToFrame(Object.assign({ __dilFrame: true, kind: 'setCompiledDil' }, payload));
    },
    trigger(fnId, args) {
      deliverToFrame({ __dilFrame: true, kind: 'trigger', fnId, args: args || [] });
    },
    dispose() {
      deliverToFrame({ __dilFrame: true, kind: 'dispose' });
    },
    flush: async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

module.exports = { createFrameHarness, createWorkerShim };
