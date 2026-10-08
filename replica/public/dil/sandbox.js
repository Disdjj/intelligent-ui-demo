/**
 * Sandbox host — the browser side of the iframe contract.
 *
 *   host ──postMessage──► sandboxed iframe (opaque origin, CSP default-src 'none')
 *                              └──► blob: Worker that runs the compiled program
 *
 * Creates the invisible iframe, waits for `ready`, pushes compiled revisions in and
 * receives element-tree snapshots and keyed-state reports out. It knows nothing about
 * rendering: pair it with `mount()` from the renderer.
 */

export const PROTOCOL_VERSION = 1;
const BOOT_TIMEOUT_MS = 5000;

const noop = () => {};

export class DilSandbox {
  /**
   * @param {object} o
   * @param {string} [o.frameUrl]
   * @param {Node}   [o.container]   where the iframe lives (a shadow root keeps it scoped)
   * @param {(msg)=>void} [o.onSnapshot]       { tree, version, error, stats }
   * @param {(state, scope, reason)=>void} [o.onStateChange]
   * @param {(error, stage)=>void} [o.onFailure]
   * @param {(entry)=>void} [o.onProtocol]     everything that crossed the boundary
   */
  constructor(o = {}) {
    this.frameUrl = o.frameUrl || '/sandbox/runner.html';
    this.container = o.container || null;
    this.onSnapshot = o.onSnapshot || noop;
    this.onStateChange = o.onStateChange || noop;
    this.onFailure = o.onFailure || noop;
    this.onProtocol = o.onProtocol || noop;
    this.frame = null;
    this.ready = null;
    this.connected = false;
    this.runnerId = null;
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.src = this.frameUrl;
      // no allow-same-origin: the frame gets an opaque origin (the real runner's
      // requests carry `Origin: null`)
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('data-dil-sandbox', 'true');
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      this.frame = frame;

      const timer = setTimeout(() => {
        this.log('frame', 'boot_timeout', { ms: BOOT_TIMEOUT_MS });
        reject(new Error('sandbox frame did not become ready'));
      }, BOOT_TIMEOUT_MS);

      this.onWindowMessage = (event) => {
        if (event.source !== frame.contentWindow) return;
        const msg = event.data;
        if (!msg || msg.__dilFrame !== true) return;
        if (msg.protocolVersion !== undefined && msg.protocolVersion !== PROTOCOL_VERSION) {
          this.log('frame', 'protocol_mismatch', { got: msg.protocolVersion });
          return;
        }
        if (msg.kind === 'ready') {
          if (this.connected) return;
          this.connected = true;
          clearTimeout(timer);
          this.log('frame', 'ready', { protocolVersion: msg.protocolVersion });
          resolve(this);
          return;
        }
        this.handle(msg);
      };
      window.addEventListener('message', this.onWindowMessage);
      (this.container || document.body).appendChild(frame);
    });
    return this.ready;
  }

  log(dir, kind, detail) {
    this.onProtocol({ dir, kind, detail, at: Date.now() });
  }

  handle(msg) {
    switch (msg.kind) {
      case 'diagnostic':
        this.log('frame:diag', `${msg.stage}:${msg.phase}`, msg.detail);
        break;
      case 'snapshot':
        this.log('frame→host', 'snapshot', { version: msg.version, reason: msg.reason, hasError: !!msg.error });
        this.onSnapshot(msg);
        break;
      case 'stateChanged':
        this.log('frame→host', 'stateChanged', { reason: msg.reason, keys: Object.keys(msg.state || {}).length });
        this.onStateChange(msg.state, msg.scope || 'root', msg.reason);
        break;
      case 'failure':
        this.log('frame→host', 'failure', { stage: msg.stage, message: msg.error?.message });
        this.onFailure(msg.error, msg.stage);
        break;
      case 'timeout':
        this.log('frame→host', 'timeout', { stage: msg.stage });
        this.onFailure({ name: 'Timeout', message: `sandbox exceeded its render budget (${msg.stage})` }, 'timeout');
        break;
      case 'quarantined':
        this.log('frame→host', 'quarantined', { reason: msg.reason });
        this.onFailure({ name: 'Quarantined', message: msg.reason }, 'quarantine');
        break;
      case 'ack':
        this.log('frame→host', 'ack', { id: msg.id, ok: msg.ok });
        break;
      default:
        break;
    }
  }

  send(msg) {
    if (!this.frame?.contentWindow) return false;
    this.frame.contentWindow.postMessage({ __dilFrame: true, protocolVersion: PROTOCOL_VERSION, ...msg }, '*');
    return true;
  }

  /** First program for a message: spawns the worker. */
  createRunner(runnerId, { compiledDil, constants = {}, appData = {}, initialState = null }) {
    this.runnerId = runnerId;
    this.log('host→frame', 'createRunner', { runnerId, bytes: compiledDil.length });
    this.send({ kind: 'createRunner', runnerId, compiledDil, constants, appData, initialState });
  }

  /** Later revisions while streaming: state is kept, only the program changes. */
  setCompiledDil({ compiledDil, constants = {}, appData = {} }) {
    this.log('host→frame', 'setCompiledDil', { bytes: compiledDil.length });
    this.send({ kind: 'setCompiledDil', compiledDil, constants, appData });
  }

  trigger(fnId, args = []) {
    this.log('host→frame', 'trigger', { fnId });
    this.send({ kind: 'trigger', fnId, args });
  }

  dispose() {
    this.send({ kind: 'dispose' });
    if (this.onWindowMessage) window.removeEventListener('message', this.onWindowMessage);
    this.frame?.remove();
    this.frame = null;
    this.connected = false;
    this.ready = null;
  }
}
