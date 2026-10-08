/* eslint-disable */
/**
 * DIL sandbox worker.
 *
 * This file is NOT imported as a module. The server inlines its text into
 * /sandbox/runner.html, which turns it into a `blob:` URL and spawns it as a Worker
 * (with a `data:` URL fallback). That is why it is written as a plain, dependency-free
 * script that talks over `self.onmessage` — and it is also why the runner's CSP needs
 * `worker-src blob: data:` and `script-src 'unsafe-eval'`.
 *
 * What lives here:
 *   • a tiny React-like runtime (useState / useRef / useMemo / useEffect)
 *   • `DIL.*` — the API surface the compiled code is allowed to call
 *   • `eval` of the compiled program, and serialization of the resulting element tree
 *
 * What deliberately does NOT live here: any DOM. The worker's output is a plain
 * JSON-serializable tree; the host turns it into DOM. Model code can therefore never
 * touch the page, only describe it.
 */
(function () {
  'use strict';

  var PROTOCOL_VERSION = 1;

  // ---------------------------------------------------------------------------
  // runtime
  // ---------------------------------------------------------------------------

  function createRuntime(emitDiagnostic, initialState, onStateChange) {
    var stateSlots = new Map(); // semantic key -> current value
    // A saved view state (from a previous session's `/dil/view_state`) seeds keyed
    // slots before the first render, so a reload lands where the user left off.
    // Only keyed state can be restored — positional slots have no stable address.
    var seeded = initialState && typeof initialState === 'object' ? initialState : {};
    var stateOrder = []; // for reporting / debugging
    var fnTable = new Map();
    var fnSeq = 0;
    var version = 0;
    var program = null; // compiled JS
    var constants = {};
    var appData = {};
    var hooks = null;
    var root = null;
    var lastGoodTree = null;
    var scheduled = false;
    var renderCount = 0;

    var FRAGMENT = { __dilFragment: true };
    var stateDirty = false;

    /** After a render, report keyed state once if anything keyed changed. */
    var stateReported = false;
    function flushStateChange() {
      if (!stateDirty || !onStateChange) return;
      stateDirty = false;
      onStateChange(api.stateSnapshot(), stateReported ? 'event' : 'initial');
      stateReported = true;
    }

    function scheduleRender(reason) {
      if (scheduled) return;
      scheduled = true;
      Promise.resolve().then(function () {
        scheduled = false;
        try {
          var tree = renderPass();
          lastGoodTree = tree;
          version += 1;
          emitSnapshot({ tree: tree, version: version, reason: reason || 'state' });
          flushStateChange();
        } catch (err) {
          emitSnapshot({ tree: lastGoodTree, version: version, error: describeError(err), reason: 'error' });
        }
      });
    }

    // -- hooks -----------------------------------------------------------------

    function currentKey(opts, index) {
      return opts && typeof opts.key === 'string' ? 'k:' + opts.key : 'i:' + index;
    }

    function useState(initial, opts) {
      var index = hooks.index++;
      var key = currentKey(opts, index);
      if (!stateSlots.has(key)) {
        var plain = key.slice(0, 2) === 'k:' ? key.slice(2) : null;
        var v = plain !== null && Object.prototype.hasOwnProperty.call(seeded, plain)
          ? seeded[plain]
          : typeof initial === 'function' ? initial() : initial;
        stateSlots.set(key, v);
        stateOrder.push(key);
        // A key that appears mid-stream extends the reported state shape.
        if (plain !== null) stateDirty = true;
      }
      var setter = function (next) {
        var prev = stateSlots.get(key);
        var value = typeof next === 'function' ? next(prev) : next;
        if (Object.is(value, prev)) return;
        stateSlots.set(key, value);
        emitDiagnostic && emitDiagnostic('state', 'changed', { key: key });
        if (key.slice(0, 2) === 'k:') stateDirty = true;
        scheduleRender('setState');
      };
      return [stateSlots.get(key), setter];
    }

    function useRef(initial) {
      var index = hooks.index++;
      var key = 'r:' + index;
      if (!stateSlots.has(key)) stateSlots.set(key, { current: initial });
      return stateSlots.get(key);
    }

    function useMemo(factory, deps) {
      var index = hooks.index++;
      var key = 'm:' + index;
      var prev = stateSlots.get(key);
      var same = prev && Array.isArray(deps) && Array.isArray(prev.deps) && deps.length === prev.deps.length && deps.every(function (d, i) { return Object.is(d, prev.deps[i]); });
      if (same) return prev.value;
      var value = factory();
      stateSlots.set(key, { deps: deps, value: value });
      return value;
    }

    function useCallback(fn, deps) {
      return useMemo(function () { return fn; }, deps || []);
    }

    var pendingEffects = [];
    function useEffect(effect, deps) {
      var index = hooks.index++;
      var key = 'e:' + index;
      var prev = stateSlots.get(key);
      var same = prev && Array.isArray(deps) && Array.isArray(prev.deps) && deps.length === prev.deps.length && deps.every(function (d, i) { return Object.is(d, prev.deps[i]); });
      if (same) return;
      stateSlots.set(key, { deps: deps });
      pendingEffects.push(effect);
    }

    function useConstants() {
      return hooks.constants;
    }

    function useAppData(selector) {
      var data = hooks.appData;
      return typeof selector === 'function' ? selector(data) : data;
    }

    function useNow(intervalMs) {
      // Deliberately inert in the replica: a real clock would make renders
      // non-deterministic during streaming. Exposed so the dialect is complete.
      return hooks.fixedNow;
    }

    var DIL = {
      Fragment: FRAGMENT,
      jsx: function (type, props) {
        var children = [];
        for (var i = 2; i < arguments.length; i++) children.push(arguments[i]);
        return { __dilEl: true, type: type, props: props || {}, children: children };
      },
      render: function (el) {
        root = el;
      },
      useState: useState,
      useRef: useRef,
      useMemo: useMemo,
      useCallback: useCallback,
      useEffect: useEffect,
      useConstants: useConstants,
      useAppData: useAppData,
      useNow: useNow,
    };

    // Compiled programs reference two separate namespaces, mirroring the real
    // artifact: `__dil` is the JSX runtime, `DIL` is the hook/API surface. Keeping
    // them apart means the codegen can emit `__dil.jsx(...)` without granting the
    // generated tree access to `useState`.
    var __dil = {
      Fragment: FRAGMENT,
      jsx: DIL.jsx,
    };

    // -- serialization ---------------------------------------------------------

    function serialize(node, depth) {
      if (depth > 64) return null;
      if (node == null || node === false || node === true) return null;
      var t = typeof node;
      if (t === 'string' || t === 'number') {
        var s = String(node);
        return s === '' ? null : { t: '#text', v: s };
      }
      if (Array.isArray(node)) {
        var arr = [];
        for (var i = 0; i < node.length; i++) {
          var c = serialize(node[i], depth + 1);
          if (c) arr.push(c);
        }
        return arr.length ? { t: '#frag', c: arr } : null;
      }
      if (t !== 'object' || !node.__dilEl) return null;

      var type = node.type;
      if (type === FRAGMENT) {
        var kids = [];
        for (var j = 0; j < node.children.length; j++) {
          var k = serialize(node.children[j], depth + 1);
          if (k) kids.push(k);
        }
        return kids.length ? { t: '#frag', c: kids } : null;
      }
      if (typeof type === 'function') {
        // Locally-defined function components are inlined: the sandbox evaluates them,
        // the host never sees a function.
        return serialize(type(node.props), depth + 1);
      }

      var props = {};
      var src = node.props || {};
      for (var key in src) {
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
        var v = src[key];
        if (typeof v === 'function') {
          var id = 'fn' + ++fnSeq;
          fnTable.set(id, v);
          props[key] = { __dilFn: id };
        } else if (typeof v === 'symbol' || typeof v === 'undefined') {
          continue;
        } else {
          props[key] = v;
        }
      }

      var out = [];
      for (var m = 0; m < node.children.length; m++) {
        var child = serialize(node.children[m], depth + 1);
        if (child) out.push(child);
      }
      return { t: String(type), p: props, c: out };
    }

    // -- render pass -----------------------------------------------------------

    function renderPass() {
      if (!program) return null;
      hooks = { index: 0, constants: constants, appData: appData, fixedNow: 0 };
      root = null;
      pendingEffects = [];
      fnTable = new Map();
      fnSeq = 0;
      renderCount += 1;

      // The whole program is a single expression + a `render()` call. Evaluating it
      // is the one place untrusted code runs; everything it can reach is the two
      // objects we hand it and nothing else.
      var factory = new Function('DIL', '__dil', '"use strict";\n' + program);
      factory(DIL, __dil);

      var tree = serialize(root, 0);

      if (pendingEffects.length) {
        var effects = pendingEffects;
        pendingEffects = [];
        Promise.resolve().then(function () {
          for (var i = 0; i < effects.length; i++) {
            try { effects[i](); } catch (err) { emitDiagnostic && emitDiagnostic('effect', 'threw', { message: String(err && err.message) }); }
          }
        });
      }
      return tree;
    }

    // -- public API ------------------------------------------------------------

    var api = {
      setProgram: function (nextProgram, nextConstants, nextAppData, keepState) {
        program = nextProgram;
        constants = nextConstants || {};
        appData = nextAppData || {};
        if (!keepState) {
          // A new artifact may have a different state shape; the real system keeps
          // state and lets the program read whatever it needs. We keep it too, so
          // streaming recompiles don't reset the UI on every chunk.
        }
        var tree = renderPass();
        lastGoodTree = tree;
        version += 1;
        // the caller emits the tree snapshot; schedule the state report after it
        if (stateDirty) Promise.resolve().then(flushStateChange);
        return { tree: tree, version: version, renderCount: renderCount };
      },
      invoke: function (fnId, args) {
        var fn = fnTable.get(fnId);
        if (!fn) return { ok: false, error: 'unknown handler ' + fnId };
        try {
          fn.apply(null, args || []);
          var tree = renderPass();
          lastGoodTree = tree;
          version += 1;
          emitSnapshot({ tree: tree, version: version, reason: 'event' });
          flushStateChange();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: describeError(err) };
        }
      },
      snapshot: function () {
        return { tree: lastGoodTree, version: version };
      },
      stateSnapshot: function () {
        var out = {};
        stateSlots.forEach(function (v, key) {
          if (key.slice(0, 2) === 'k:') out[key.slice(2)] = safe(v);
        });
        return out;
      },
      stats: function () {
        return { version: version, renderCount: renderCount, handlers: fnTable.size, states: stateOrder.length };
      },
    };
    return api;

    function safe(v) {
      try {
        return JSON.parse(JSON.stringify(v));
      } catch {
        return null;
      }
    }
  }

  function describeError(err) {
    if (!err) return { name: 'Error', message: 'unknown' };
    return {
      name: String((err && err.name) || 'Error'),
      message: String((err && err.message) || err),
      stack: typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 4).join('\n') : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // worker protocol
  // ---------------------------------------------------------------------------

  var runtime = null;
  var dataPort = null;
  var controlPort = null;
  var currentRunnerId = null;

  function emitSnapshot(payload) {
    if (!dataPort) return;
    dataPort.postMessage({
      __dilWorker: true,
      kind: 'snapshot',
      runnerId: currentRunnerId,
      tree: payload.tree,
      version: payload.version,
      error: payload.error || null,
      reason: payload.reason || null,
      stats: runtime ? runtime.stats() : null,
    });
  }

  function emitStateChanged(state, reason) {
    if (!dataPort) return;
    dataPort.postMessage({ __dilWorker: true, kind: 'stateChanged', runnerId: currentRunnerId, scope: 'root', state: state, reason: reason || 'event' });
  }

  function emitDiagnostic(stage, phase, detail) {
    if (!controlPort) return;
    try {
      controlPort.postMessage({ __dilWorker: true, kind: 'diagnostic', stage: stage, phase: phase, detail: detail || null });
    } catch {}
  }

  self.onmessage = function (event) {
    var msg = event.data;
    if (!msg || msg.__dilWorker !== true) return;

    switch (msg.kind) {
      case 'initializeControl': {
        controlPort = event.ports && event.ports[0];
        if (controlPort) {
          controlPort.onmessage = function (e) {
            var m = e.data;
            if (m && m.__dilWorker === true && m.kind === 'healthCheck') {
              controlPort.postMessage({ __dilWorker: true, kind: 'healthy', requestId: m.requestId, stats: runtime ? runtime.stats() : null });
            }
          };
          controlPort.start && controlPort.start();
        }
        emitDiagnostic('worker_module', 'returned', { protocolVersion: PROTOCOL_VERSION });
        break;
      }

      case 'createRunner': {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          emitDiagnostic('runner_create', 'rejected', { reason: 'protocol_mismatch', got: msg.protocolVersion });
          return;
        }
        dataPort = event.ports && event.ports[0];
        if (dataPort) {
          dataPort.onmessage = function (e) {
            var m = e.data;
            if (m && m.__dilWorker === true) handleCommand(m);
          };
          dataPort.start && dataPort.start();
        }
        currentRunnerId = msg.runnerId;
        runtime = createRuntime(emitDiagnostic, msg.initialState, emitStateChanged);
        emitDiagnostic('runner_create', 'begin', { runnerId: msg.runnerId });
        try {
          var r = runtime.setProgram(msg.compiledDil, msg.constants, msg.appData);
          dataPort.postMessage({ __dilWorker: true, kind: 'ready', protocolVersion: PROTOCOL_VERSION, runnerId: currentRunnerId, version: r.version, stats: runtime.stats() });
          emitSnapshot({ tree: r.tree, version: r.version, reason: 'initial' });
          // The real client POSTs the full initial state right after the first render
          // (captured record 421: all 15 keys at their initial values). setProgram has
          // already queued that report; it fires once the snapshot above is out.
          emitDiagnostic('worker_ready', 'sent', { runnerId: msg.runnerId });
        } catch (err) {
          dataPort.postMessage({ __dilWorker: true, kind: 'failure', runnerId: currentRunnerId, error: describeError(err), stage: 'evaluate' });
        }
        break;
      }

      case 'trigger': {
        if (!runtime) return;
        var res = runtime.invoke(msg.fnId, msg.args);
        if (!res.ok) {
          dataPort && dataPort.postMessage({ __dilWorker: true, kind: 'failure', runnerId: currentRunnerId, error: { name: 'HandlerError', message: res.error }, stage: 'event' });
        }
        break;
      }

      case 'stateSnapshotRequest': {
        dataPort && dataPort.postMessage({ __dilWorker: true, kind: 'stateSnapshot', runnerId: currentRunnerId, state: runtime ? runtime.stateSnapshot() : {} });
        break;
      }

      case 'dispose': {
        if (dataPort) { dataPort.close && dataPort.close(); dataPort = null; }
        if (controlPort) { controlPort.close && controlPort.close(); controlPort = null; }
        runtime = null;
        currentRunnerId = null;
        self.close && self.close();
        break;
      }
    }
  };

  function handleCommand(msg) {
    if (!runtime) return;
    switch (msg.command) {
      case 'setCompiledDil': {
        var changed = msg.data.compiledDil !== undefined;
        try {
          var r = runtime.setProgram(msg.data.compiledDil, msg.data.constants, msg.data.appData);
          dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: true, version: r.version, stats: runtime.stats() });
          if (changed) emitSnapshot({ tree: r.tree, version: r.version, reason: 'source' });
        } catch (err) {
          dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: false, error: describeError(err) });
          dataPort.postMessage({ __dilWorker: true, kind: 'failure', runnerId: currentRunnerId, error: describeError(err), stage: 'evaluate' });
        }
        break;
      }
      case 'setData': {
        try {
          var r2 = runtime.setProgram(msg.data.compiledDil, msg.data.constants, msg.data.appData);
          dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: true, version: r2.version });
          emitSnapshot({ tree: r2.tree, version: r2.version, reason: 'data' });
        } catch (err) {
          dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: false, error: describeError(err) });
        }
        break;
      }
      case 'snapshot': {
        dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: true, snapshot: runtime.snapshot() });
        break;
      }
      default:
        dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: false, error: 'unknown command ' + msg.command });
    }
  }

  // tell whoever spawned us that the module evaluated
  try {
    self.postMessage({ __dilWorker: true, kind: 'ready', protocolVersion: PROTOCOL_VERSION });
  } catch {}
})();
