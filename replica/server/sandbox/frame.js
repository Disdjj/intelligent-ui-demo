'use strict';
/**
 * Generates `/sandbox/runner.html` — the sandboxed iframe document.
 *
 * Structure mirrors the real DIL runner (see RUNNER-SANDBOX.md):
 *
 *   • CSP `default-src 'none'` ⇒ the document has no network at all. No
 *     connect-src, no img-src, no font-src. `worker-src blob: data:` is the single
 *     exception, and it exists solely so the Worker can be spawned.
 *   • `script-src` is pinned to the SHA-256 of the one inline script instead of
 *     `'unsafe-inline'`; under CSP3 a hash makes `unsafe-inline` inert, so nothing
 *     else can be injected into this document.
 *   • `'unsafe-eval'` is required: the Worker evaluates model-authored code.
 *   • `frame-src 'none'` — nesting stops here.
 *   • The worker source travels in an inert `<template>`, not a script tag.
 *
 * The iframe is intentionally *headless*: it computes an element tree and posts it
 * out. It has no visual output of its own, which is what makes the Worker's lack of
 * DOM irrelevant.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WORKER_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'sandbox', 'worker.js'), 'utf8');

/** HTML-escape so the worker source survives a round-trip through <template>. */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// NOTE: this whole block is a template literal. Never write a backtick inside it
// (not even in a comment) — it terminates the string and the failure surfaces as a
// syntax error only at runtime. The vm.Script check below turns that into a startup
// error instead.
const FRAME_SCRIPT = `(function () {
  'use strict';
  var PROTOCOL = 1;
  var RENDER_BUDGET_MS = 2500;
  var MAX_RESPAWNS = 1;

  var worker = null;
  var workerUrl = null;
  // Commands (setCompiledDil) travel on the data port, the same channel the worker
  // listens on for them; the worker's global scope only handles lifecycle messages.
  var dataPort = null;
  var runnerMessage = null;
  var renderTimer = null;
  var respawns = 0;
  var seq = 0;
  var pending = new Map();

  function post(msg) {
    try { window.parent.postMessage(Object.assign({ __dilFrame: true, protocolVersion: PROTOCOL }, msg), '*'); } catch (e) {}
  }

  /**
   * Diagnostics deliberately go over window.postMessage rather than the MessagePort.
   * The port is the fast path for snapshots and acks, but it is also the thing most
   * likely to be broken — and "the channel you use to report that the channel is
   * broken" cannot be the channel itself.
   */
  function record(stage, phase, detail) {
    try {
      window.parent.postMessage(
        { __dilFrame: true, kind: 'diagnostic', protocolVersion: PROTOCOL, stage: stage, phase: phase, detail: detail || null },
        '*'
      );
    } catch (e) {}
  }

  function workerSource() {
    var t = document.getElementById('dil-worker-source');
    if (!t) return '';
    // A <template>'s children live in .content — textContent on the element itself is
    // always empty. Easy mistake, and it fails silently at exactly the wrong moment.
    return t.content ? t.content.textContent : t.textContent;
  }

  function fail(stage, error) {
    post({ __dilFrame: true, kind: 'failure', protocolVersion: PROTOCOL, stage: stage,
           error: { name: (error && error.name) || 'Error', message: String((error && error.message) || error) } });
  }

  /**
   * Spawn the sandbox Worker.
   *
   * Two transports, tried in order, because browser policy decides which one works:
   *
   *   blob:  - the normal path. Cheap, and the worker revokes its own URL on boot.
   *   data:  - the fallback. A blob: Worker created from a document with an OPAQUE
   *            origin (a sandboxed iframe without allow-same-origin) becomes
   *            origin becomes blob:null/..., which some engines refuse to load, so the
   *            worker script never evaluates. postMessage succeeds silently and nothing
   *            ever comes back. Hence: the fallback is chosen by TIMEOUT, not by exception.
   *
   * Either way the worker announces itself with a ready message, so whether it booted is
   * observable rather than assumed.
   */
  var WORKER_BOOT_TIMEOUT_MS = 1200;
  var bootTimer = null;

  function clearBootTimer() {
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  }

  function spawnWorker(attempt) {
    attempt = attempt || 0;
    var src = workerSource();
    record('worker_create', 'begin', { attempt: attempt, bytes: src.length });
    if (!src) { record('worker_create', 'reported_error', { reason: 'empty_worker_source' }); fail('worker_create', new Error('worker source is empty')); return; }

    var transport;
    try {
      if (attempt === 0) {
        var blob = new Blob(['(self.URL||self.webkitURL).revokeObjectURL(self.location.href);', src],
                            { type: 'text/javascript;charset=utf-8' });
        workerUrl = (window.URL || window.webkitURL).createObjectURL(blob);
        worker = new Worker(workerUrl, { name: 'dil-sandbox' });
        transport = 'blob';
      } else {
        worker = new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(src), { name: 'dil-sandbox' });
        transport = 'data';
      }
    } catch (e) {
      record('worker_create', 'threw', { attempt: attempt, transport: transport || (attempt === 0 ? 'blob' : 'data'), message: String(e && e.message) });
      if (attempt === 0) { spawnWorker(1); } else { fail('worker_create', e); }
      return;
    }

    if (!worker) { fail('worker_create', new Error('Worker construction returned nothing')); return; }
    record('worker_create', 'returned', { attempt: attempt, transport: transport });

    // The boot ack is what tells us the transport actually works.
    worker.onmessage = function (ev) {
      var m = ev && ev.data;
      if (m && m.__dilWorker === true && m.kind === 'ready') {
        clearBootTimer();
        record('worker_ready', 'received', { attempt: attempt, transport: transport, protocolVersion: m.protocolVersion });
      }
    };
    worker.addEventListener('error', function (ev) {
      record('worker_create', 'reported_error', { attempt: attempt, transport: transport, message: String((ev && ev.message) || '') });
    });

    clearBootTimer();
    bootTimer = setTimeout(function () {
      bootTimer = null;
      record('worker_create', 'timeout', { attempt: attempt, transport: transport, budgetMs: WORKER_BOOT_TIMEOUT_MS });
      try { if (worker) worker.terminate(); } catch (e) {}
      worker = null;
      if (attempt === 0) {
        record('recovery', 'decision', { reason: 'blob_worker_never_booted', next: 'data_url' });
        spawnWorker(1);
      } else {
        fail('worker_create', new Error('sandbox worker never booted on either transport'));
      }
    }, WORKER_BOOT_TIMEOUT_MS);

    // control channel: health probes + diagnostics only
    var ctrl = new MessageChannel();
    ctrl.port1.onmessage = function (e) {
      var m2 = e.data;
      if (!m2) return;
      if (m2.kind === 'healthy') record('health_probe', 'received', { stats: m2.stats || null });
      else if (m2.kind === 'diagnostic') record(m2.stage, m2.phase, m2.detail);
    };
    ctrl.port1.start();
    worker.postMessage({ __dilWorker: true, kind: 'initializeControl', protocolVersion: PROTOCOL }, [ctrl.port2]);

    // data channel: compiled programs + snapshots
    var data = new MessageChannel();
    data.port1.onmessage = onWorkerMessage;
    data.port1.start();
    dataPort = data.port1;
    var msg = Object.assign({}, runnerMessage, { __dilWorker: true, kind: 'createRunner', protocolVersion: PROTOCOL });
    worker.postMessage(msg, [data.port2]);
  }

  function armWatchdog(stage) {
    clearWatchdog();
    renderTimer = setTimeout(function () {
      renderTimer = null;
      record('recovery', 'decision', { reason: 'render_budget_exceeded', stage: stage, budgetMs: RENDER_BUDGET_MS, respawns: respawns });
      post({ __dilFrame: true, kind: 'timeout', protocolVersion: PROTOCOL, stage: stage });
      if (respawns < MAX_RESPAWNS) {
        respawns += 1;
        recycle();
      } else {
        post({ __dilFrame: true, kind: 'quarantined', protocolVersion: PROTOCOL, reason: 'worker_unresponsive' });
      }
    }, RENDER_BUDGET_MS);
  }

  function clearWatchdog() { if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; } }

  function recycle() {
    clearBootTimer();
    try { if (worker) worker.terminate(); } catch (e) {}
    try { if (workerUrl) (self.URL || self.webkitURL).revokeObjectURL(workerUrl); } catch (e) {}
    clearBootTimer();
    worker = null;
    workerUrl = null;
    dataPort = null;
    pending.clear();
    spawnWorker(0);
  }

  function onWorkerMessage(e) {
    var m = e.data;
    if (!m || m.__dilWorker !== true) return;
    switch (m.kind) {
      case 'ready':
        record('worker_ready', 'received', { protocolVersion: m.protocolVersion });
        break;
      case 'snapshot':
        clearWatchdog();
        record('snapshot_forward', 'sent', { version: m.version, reason: m.reason, hasError: !!m.error });
        post({ __dilFrame: true, kind: 'snapshot', protocolVersion: PROTOCOL, runnerId: m.runnerId, tree: m.tree, version: m.version, error: m.error || null, stats: m.stats || null, reason: m.reason || null });
        break;
      case 'failure':
        clearWatchdog();
        post({ __dilFrame: true, kind: 'failure', protocolVersion: PROTOCOL, error: m.error, stage: m.stage });
        break;
      case 'response':
        clearWatchdog();
        if (m.id && pending.has(m.id)) { pending.delete(m.id); }
        post({ __dilFrame: true, kind: 'ack', protocolVersion: PROTOCOL, id: m.id, ok: m.ok, error: m.error || null, stats: m.stats || null });
        break;
      case 'stateSnapshot':
        post({ __dilFrame: true, kind: 'stateSnapshot', protocolVersion: PROTOCOL, state: m.state });
        break;
      case 'stateChanged':
        // Remember the latest keyed state: if the watchdog recycles the worker, the
        // respawned runner is seeded with it instead of snapping back to initial values.
        if (runnerMessage) runnerMessage.initialState = m.state;
        post({ __dilFrame: true, kind: 'stateChanged', protocolVersion: PROTOCOL, scope: m.scope, state: m.state, reason: m.reason });
        break;
    }
  }

  function onHostMessage(e) {
    try { handleHostMessage(e); }
    catch (err) {
      // Anything thrown out of a message handler disappears into the event loop. If
      // the frame cannot act on a command, the host must hear about it.
      record('command', 'threw', { message: String((err && err.message) || err) });
      post({ __dilFrame: true, kind: 'failure', protocolVersion: PROTOCOL, stage: 'command',
             error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err) } });
    }
  }

  function handleHostMessage(e) {
    var m = e.data;
    record('frame_msg', 'received', { kind: (m && m.kind) || null, hasFrameFlag: !!(m && m.__dilFrame === true) });
    if (!m || m.__dilFrame !== true) return;
    switch (m.kind) {
      case 'createRunner':
        if (m.protocolVersion !== PROTOCOL) { record('runner_create', 'rejected', { reason: 'protocol_mismatch' }); return; }
        record('runner_create', 'host_received', { runnerId: m.runnerId });
        runnerMessage = { runnerId: m.runnerId, compiledDil: m.compiledDil, constants: m.constants || {}, appData: m.appData || {}, initialState: m.initialState || null };
        record('runner_create', 'received', { runnerId: m.runnerId, bytes: (m.compiledDil || '').length });
        if (worker) { recycle(); } else { spawnWorker(0); }
        break;
      case 'setCompiledDil':
        if (!runnerMessage) return;
        runnerMessage.compiledDil = m.compiledDil;
        if (m.constants) runnerMessage.constants = m.constants;
        if (m.appData) runnerMessage.appData = m.appData;
        if (!worker) { spawnWorker(0); return; }
        var id = 'c' + ++seq;
        pending.set(id, true);
        (dataPort || worker).postMessage({ __dilWorker: true, kind: 'command', command: 'setCompiledDil', id: id,
                             data: { compiledDil: m.compiledDil, constants: runnerMessage.constants, appData: runnerMessage.appData } });
        armWatchdog('setCompiledDil');
        break;
      case 'trigger':
        if (!worker) return;
        worker.postMessage({ __dilWorker: true, kind: 'trigger', fnId: m.fnId, args: m.args || [] });
        armWatchdog('trigger');
        break;
      case 'stateSnapshotRequest':
        if (worker) worker.postMessage({ __dilWorker: true, kind: 'stateSnapshotRequest' });
        break;
      case 'dispose':
        clearWatchdog();
        clearBootTimer();
        try { if (worker) worker.postMessage({ __dilWorker: true, kind: 'dispose' }); } catch (e) {}
        try { if (worker) worker.terminate(); } catch (e) {}
        worker = null;
        break;
    }
  }

  // Transport note
  // --------------
  // The real DIL runner hands the host one end of a MessageChannel on its ready
  // message, and does all business traffic over that port. The replica uses
  // window.postMessage throughout instead: it is the same structured-clone channel, it
  // works from an opaque-origin frame, and unlike a port the traffic is visible in
  // DevTools and to the host, which matters a great deal when the sandbox misbehaves.
  window.addEventListener('message', function (e) {
    var m = e.data;
    record('frame_window_msg', 'received', {
      hasSource: !!e.source,
      sourceIsParent: e.source === window.parent,
      kind: (m && m.kind) || null,
      frameFlag: !!(m && m.__dilFrame === true),
    });
    if (e.source !== window.parent) return;
    if (!m || m.__dilFrame !== true) return;
    if (m.kind === 'probe') { record('frame_probe', 'received', { readyState: document.readyState }); return; }
    onHostMessage(e);
  });

  window.addEventListener('pagehide', function (e) {
    if (e.persisted) return;
    clearWatchdog();
    clearBootTimer();
    try { if (worker) worker.terminate(); } catch (err) {}
    worker = null;
  });

  // Hand the host one end of our port. After this the host never needs
  // window.postMessage again.
  record('frame_boot', 'done', { readyState: document.readyState });
  post({ kind: 'ready' });
})();`;

// The frame script is assembled as a template string, so a stray escape sequence can
// silently produce invalid JavaScript that only fails inside the sandbox — the hardest
// place to debug. Parse it once, at startup, where the error is cheap.
try {
  new vm.Script(FRAME_SCRIPT, { filename: 'sandbox/frame-script.js' });
} catch (err) {
  throw new Error('sandbox frame script is not valid JavaScript: ' + err.message);
}

function buildFrameHtml() {
  const hash = crypto.createHash('sha256').update(FRAME_SCRIPT, 'utf8').digest('base64');
  const csp = [
    // The load-bearing directive: no connect-src, no img-src, no font-src, so the
    // sandbox has no way to reach the network at all.
    "default-src 'none'",
    // 'unsafe-eval' is REQUIRED, not an oversight: the Worker evaluates the model's
    // compiled program with new Function(). Isolation here comes from having nothing
    // to reach (no IO, no DOM, cross-document boundary), not from banning eval.
    // The sha256 pins the single inline bootstrap so nothing else can be injected.
    `script-src 'sha256-${hash}' 'unsafe-eval'`,
    // blob: is the Worker's source; data: is the fallback transport.
    'worker-src blob: data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DIL Runner</title>
    <script>${FRAME_SCRIPT}</script>
  </head>
  <body>
    <!-- Inert: never executed, never blocked by script-src, read via textContent. -->
    <template id="dil-worker-source">${escapeHtml(WORKER_SOURCE)}</template>
  </body>
</html>`;
}

module.exports = { buildFrameHtml, FRAME_SCRIPT, WORKER_SOURCE };
