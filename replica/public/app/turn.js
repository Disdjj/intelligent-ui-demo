/**
 * One conversation turn: the user bubble, the assistant message, and the
 * DilMessageView that streams, compiles, sandboxes and renders it.
 *
 * The turn keeps everything the developer panel needs (protocol log, last
 * view_state report) so the panel can show any turn, not just the latest.
 */
import { DilMessageView } from '../dil/message-view.js';

const LOG_LIMIT = 500;

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class Turn {
  /**
   * @param {object} o
   * @param {HTMLElement} o.thread
   * @param {string} o.prompt
   * @param {string} o.conversationId
   * @param {string} [o.source]       `captured` replays the ChatGPT document
   * @param {(turn)=>void} o.onChange  status / log changed
   * @param {(turn)=>void} o.onSelect  user asked to inspect this turn
   */
  constructor(o) {
    this.prompt = o.prompt;
    this.onChange = o.onChange;
    this.log = [];
    this.lastReport = null;
    this.status = 'waiting'; // waiting → thinking → streaming → done | error
    this.thinking = null;
    this.error = null;
    this.startedAt = Date.now();
    this.firstPaintMs = null;

    const user = h('div', 'turn-user');
    user.append(h('div', 'bubble', o.prompt));

    const assistant = h('div', 'turn-assistant');
    this.statusEl = h('div', 'turn-status');
    this.stage = h('div', 'turn-stage');
    this.foot = h('div', 'turn-foot');
    this.metaEl = h('span', 'turn-meta');
    const inspect = h('button', 'link-button', '查看管线');
    inspect.type = 'button';
    inspect.addEventListener('click', () => o.onSelect(this));
    this.foot.append(this.metaEl, inspect);
    assistant.append(this.statusEl, this.stage, this.foot);

    this.root = h('article', 'turn');
    this.root.append(user, assistant);
    o.thread.append(this.root);

    this.view = new DilMessageView({
      container: this.stage,
      sandboxContainer: document.body,
      conversationId: o.conversationId,
      onUpdate: (u) => this.handleUpdate(u),
      onProtocol: (entry) => this.pushLog(entry),
      onError: (error, stage) => {
        this.pushLog({ dir: 'error', kind: stage, detail: error, at: Date.now(), err: true });
        if (stage === 'stream' || stage === 'connect') this.fail(error);
      },
      onStateReport: (body, response) => {
        this.lastReport = { body, response, at: Date.now() };
        this.onChange(this);
      },
    });
    this.render();
    this.view.run(o.prompt, { source: o.source, speed: o.source ? 4 : undefined });
  }

  get message() {
    return this.view.message;
  }

  get busy() {
    return this.status === 'waiting' || this.status === 'thinking' || this.status === 'streaming';
  }

  pushLog(entry) {
    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.onChange(this);
  }

  handleUpdate(u) {
    if (u.meta) this.meta = u.meta;
    if (u.thinking && this.status !== 'streaming') {
      this.status = 'thinking';
      this.thinking = u.thinking;
    }
    if (u.patched === '/message/content/parts/0' && this.status !== 'streaming') this.status = 'streaming';
    if (u.rendered && this.firstPaintMs == null) this.firstPaintMs = Date.now() - this.startedAt;
    if (u.complete) this.complete = u.complete;
    if (u.done && this.status !== 'error') this.status = 'done';
    this.render();
    this.onChange(this);
  }

  fail(error) {
    this.status = 'error';
    this.error = error;
    this.render();
    this.onChange(this);
  }

  stop() {
    if (!this.busy) return;
    this.view.stop();
    this.status = 'done';
    this.stopped = true;
    this.render();
  }

  render() {
    this.root.dataset.status = this.status;
    const s = this.statusEl;
    if (this.status === 'waiting') s.innerHTML = '<span class="pulse"></span>正在连接模型…';
    else if (this.status === 'thinking') s.innerHTML = `<span class="pulse"></span>思考中 · ${Math.round(this.thinking.elapsedMs / 1000)}s`;
    else if (this.status === 'error') s.textContent = `出错了：${this.error?.message || '未知错误'}`;
    else s.textContent = '';
    s.hidden = !s.textContent;

    const stats = this.message.metadata.model_dil_v2.stats;
    const parts = [];
    if (this.status === 'streaming') parts.push('生成中');
    if (this.stopped) parts.push('已停止');
    if (stats?.sourceLength != null) parts.push(`${stats.sourceLength} 字符`, `${stats.revision ?? 1} 次编译`);
    if (stats && stats.diagnosticSummary !== 'clean' && this.status === 'done') parts.push('有恢复诊断');
    if (this.firstPaintMs != null) parts.push(`首屏 ${(this.firstPaintMs / 1000).toFixed(1)}s`);
    if (this.complete) parts.push(`共 ${(this.complete.elapsedMs / 1000).toFixed(1)}s`);
    this.metaEl.textContent = parts.join(' · ');
    this.foot.hidden = !parts.length;
  }

  destroy() {
    this.view.destroy();
    this.root.remove();
  }
}
