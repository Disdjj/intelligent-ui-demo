'use strict';
/**
 * Headless browser harness.
 *
 * Wires the three real pieces together in Node — the sandbox worker, the sandbox host
 * protocol, and the DOM renderer — against a `linkedom` document. That is enough to
 * exercise the full loop, including the part that is easiest to get wrong:
 *
 *     click in the DOM → fnId over the port → closure runs in the sandbox
 *                      → new tree → patched back into the same DOM node
 *
 * Used by `npm test` and by `tools/render-cli.js`.
 */
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { bootSandbox, collectHandlers, treeToText } = require('./node-sandbox');

// Harnesses hold live MessagePorts. Tests register them here and close everything in
// one `after` hook so the runner can exit on its own.
const live = [];
function closeAll() {
  while (live.length) {
    const h = live.pop();
    try { h.sandbox.close(); } catch (e) {}
  }
}

const RENDERER_PATH = path.join(__dirname, '..', 'public', 'dil', 'renderer', 'index.js');

function createHarness() {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');

  // The renderer is a browser ES module that touches `document` only when it builds
  // nodes, so pointing the globals at this harness's document is enough. Node loads
  // the ESM graph through require() (synchronous ESM, Node >= 22).
  global.window = window;
  global.document = document;
  global.HTMLElement = window.HTMLElement;
  global.Event = window.Event;
  const renderer = require(RENDERER_PATH);

  const sandbox = bootSandbox();
  let view = null;
  let started = false;
  let version = 0;
  const events = [];

  function mount(tree, appData) {
    if (!view) {
      const host = document.createElement('div');
      host.className = 'dil-root';
      document.body.appendChild(host);
      view = renderer.mount(host, tree, {
        appData,
        onEvent(fnId, args) {
          events.push({ fnId, args });
          sandbox.trigger(fnId, args);
        },
      });
      view.host = host;
    } else {
      view.update(tree);
    }
    return view;
  }

  const api = {
    window,
    document,
    renderer,
    sandbox,
    events,
    get view() {
      return view;
    },
    get version() {
      return version;
    },
    /** Evaluate a program and render it. Returns the emitted snapshot. */
    async render(compiledDil, constants = {}, appData = {}) {
      started = true;
      sandbox.createRunner({ runnerId: 'test-runner', compiledDil, constants, appData });
      await sandbox.flush();
      const snap = sandbox.latest;
      if (snap && snap.tree) {
        version = snap.version;
        mount(snap.tree, appData);
      }
      return snap;
    },
    /** Push a new compiled revision into the live sandbox (the streaming path). */
    async push(compiledDil, constants = {}, appData = {}) {
      if (!started) {
        started = true;
        sandbox.createRunner({ runnerId: 'test-runner', compiledDil, constants, appData });
      } else {
        sandbox.setCompiledDil({ compiledDil, constants, appData });
      }
      await sandbox.flush();
      const snap = sandbox.latest;
      if (snap && snap.tree) {
        version = snap.version;
        mount(snap.tree, appData);
      }
      return snap;
    },
    /** Simulate a DOM interaction; resolves after the sandbox has re-rendered. */
    async fire(selector, eventName = 'click') {
      const el = document.querySelector(selector);
      if (!el) throw new Error('no element for ' + selector);
      el.dispatchEvent(new window.Event(eventName, { bubbles: true }));
      await sandbox.flush();
      await new Promise((r) => setTimeout(r, 0));
      const snap = sandbox.latest;
      if (snap && snap.tree) {
        version = snap.version;
        mount(snap.tree);
      }
      return snap;
    },
    /**
     * Wait for the sandbox to settle and mount whatever it last emitted. Needed
     * whenever a test drives the DOM directly instead of going through `fire()`.
     */
    async settle() {
      await sandbox.flush();
      await new Promise((r) => setTimeout(r, 0));
      const snap = sandbox.latest;
      if (snap && snap.tree) {
        version = snap.version;
        mount(snap.tree);
      }
      return snap;
    },
    text() {
      return (view && view.host.textContent) || '';
    },
    html() {
      return (view && view.host.innerHTML) || '';
    },
    treeToText,
    collectHandlers,
    close() {
      try { sandbox.close(); } catch (e) {}
    },
  };
  live.push(api);
  return api;
}

module.exports = { createHarness, closeAll };
