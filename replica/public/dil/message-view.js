/**
 * A live DIL message: one SSE turn, one sandbox, one rendered view.
 *
 *   SSE patches ─► message model ─► compiled program ─► sandbox ─► tree ─► DOM
 *                                                        ▲                  │
 *                                   fnId + value ────────┴── click/input ◄──┘
 *                                   keyed state ─► POST /dil/view_state
 *
 * Everything a UI needs to *explain* the pipeline is surfaced through `on*`
 * callbacks, so the same class powers the chat page, `<dil-embed>` and diagnostics.
 */
import { mount } from './renderer/index.js';
import { DilSandbox } from './sandbox.js';
import { emptyMessage, applyPatch, openTurn } from './stream.js';
import { createStateReporter } from './view-state.js';

const noop = () => {};

export class DilMessageView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container          where the interface renders
   * @param {Node}   [o.sandboxContainer]       where the iframe lives
   * @param {string} [o.conversationId]
   * @param {object} [o.appData]                embedder data, merged over the server's
   * @param {number} [o.stateReportMs]
   * @param {(u)=>void} [o.onUpdate]            { message, meta?, thinking?, rendered?, complete?, done?, error? }
   * @param {(entry)=>void} [o.onProtocol]
   * @param {(error, stage)=>void} [o.onError]
   * @param {(body, response)=>void} [o.onStateReport]
   */
  constructor(o) {
    this.container = o.container;
    this.conversationId = o.conversationId || null;
    this.localAppData = o.appData || {};
    this.onUpdate = o.onUpdate || noop;
    this.onProtocol = o.onProtocol || noop;
    this.onError = o.onError || noop;
    this.message = emptyMessage();
    this.meta = null;
    this.view = null;
    this.runnerCreated = false;
    this.closeStream = null;
    this.destroyed = false;

    this.reporter = createStateReporter({
      delayMs: o.stateReportMs ?? 600,
      target: () => {
        const conversationId = this.conversationId || this.meta?.conversation_id;
        const messageId = this.meta?.message_id;
        return conversationId && messageId ? { conversationId, messageId } : null;
      },
      onReport: (body, res) => {
        this.onProtocol({ dir: 'server→host', kind: 'view_state', detail: { updated_scopes: res?.updated_scopes }, at: Date.now() });
        o.onStateReport?.(body, res);
      },
      onError: (err) => this.onError({ name: 'ViewStateError', message: String(err?.message || err) }, 'view_state'),
    });

    this.sandbox = new DilSandbox({
      frameUrl: o.frameUrl,
      container: o.sandboxContainer,
      onProtocol: this.onProtocol,
      onSnapshot: (msg) => this.handleSnapshot(msg),
      onStateChange: (state, scope) => !this.destroyed && this.reporter.queue(state, scope),
      onFailure: (error, stage) => this.onError(error, stage),
    });
  }

  emit(extra) {
    if (!this.destroyed) this.onUpdate({ message: this.message, ...extra });
  }

  /** Server appData (componentResults, modelDataBindings) under the embedder's. */
  appData() {
    const server = this.message.metadata.model_dil_v2.appData || {};
    const local = this.localAppData;
    return { ...server, ...local, opGenui: { ...(server.opGenui || {}), ...(local.opGenui || {}) } };
  }

  handleSnapshot(msg) {
    if (this.destroyed) return;
    if (msg.error) {
      // keep the last good tree on screen: a mid-stream error must not blank the UI
      this.onError(msg.error, 'render');
      this.emit({ error: msg.error });
      return;
    }
    if (!msg.tree) return;
    if (!this.view) {
      this.view = mount(this.container, msg.tree, {
        appData: this.appData(),
        onEvent: (fnId, args) => this.sandbox.trigger(fnId, args),
      });
    } else {
      this.view.update(msg.tree);
    }
    this.emit({ rendered: true, stats: msg.stats });
  }

  /** Push the current compiled program into the sandbox. */
  pushProgram() {
    const meta = this.message.metadata.model_dil_v2;
    if (!meta.code) return;
    const payload = { compiledDil: meta.code, constants: meta.constants || {}, appData: this.appData() };
    this.view?.setAppData(payload.appData);
    if (!this.runnerCreated) {
      this.runnerCreated = true;
      this.sandbox.createRunner(this.message.id, payload);
    } else {
      this.sandbox.setCompiledDil(payload);
    }
  }

  applyPatch(patch) {
    applyPatch(this.message, patch);
    if (patch.p.endsWith('/model_dil_v2/code')) this.pushProgram();
    this.emit({ patched: patch.p });
  }

  /** Stream a conversation turn. */
  async run(prompt, opts = {}) {
    try {
      await this.sandbox.connect();
    } catch (err) {
      this.onError({ name: 'SandboxError', message: String(err?.message || err) }, 'connect');
      return;
    }
    if (this.destroyed) return;
    this.closeStream = openTurn(
      { q: prompt, conversation_id: this.conversationId, source: opts.source, speed: opts.speed },
      {
        meta: (meta) => {
          this.meta = meta;
          this.message.id = meta.message_id;
          this.emit({ meta });
        },
        thinking: (thinking) => this.emit({ thinking }),
        note: (n) => this.onProtocol({ dir: 'server', kind: n.label, detail: n.detail, at: n.at }),
        patch: (p) => this.applyPatch(p),
        complete: (stats) => this.emit({ complete: stats }),
        error: (err) => {
          this.onError({ name: 'StreamError', message: err.message }, 'stream');
          this.emit({ error: { name: 'StreamError', message: err.message } });
        },
        done: () => {
          this.closeStream = null;
          this.message.status = 'finished_successfully';
          this.emit({ done: true });
          // state reported before the message id was known goes out now
          if (this.reporter.hasPending) this.reporter.flush();
        },
      }
    );
  }

  /** Compile a source through the server (no agent) and render it. */
  async loadSource(source) {
    await this.sandbox.connect();
    const res = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    this.message.content.parts[0] = source;
    Object.assign(this.message.metadata.model_dil_v2, {
      code: result.code,
      constants: result.constants,
      appData: result.appData,
      fallbackMarkdown: result.fallbackMarkdown,
      diagnostics: result.diagnostics,
      requiredComponents: result.requiredComponents,
      stats: result,
    });
    this.message.status = 'finished_successfully';
    this.emit({ compiled: result });
    this.pushProgram();
    return result;
  }

  stop() {
    this.closeStream?.();
    this.closeStream = null;
    this.emit({ done: true, stopped: true });
  }

  destroy() {
    this.destroyed = true;
    this.closeStream?.();
    this.reporter.cancel();
    this.sandbox.dispose();
    this.view?.destroy();
    this.view = null;
  }
}
