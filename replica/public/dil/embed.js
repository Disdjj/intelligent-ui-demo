/**
 * `<dil-embed>` — drop a live, agent-authored interface into any page.
 *
 *   <script type="module" src="/dil/embed.js"></script>
 *   <dil-embed prompt="做一个番茄钟" height="560"></dil-embed>
 *   <dil-embed source="{@body const [n,setN]=DIL.useState(0)} <button onClick={()=>setN(n+1)}>{n}</button>"></dil-embed>
 *
 * Everything lives in a shadow root, and the sandbox iframe is scoped to this
 * element — an embedded interface can neither style the host page nor reach into it.
 */
import { DilMessageView } from './message-view.js';

const STYLE = `
:host { display: block; contain: content; }
.shell { border: 1px solid var(--dil-border); border-radius: 20px; background: var(--dil-bg); overflow: hidden; }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--dil-border); font-size: 12.5px; color: var(--dil-text-secondary); }
.head b { color: var(--dil-text); font-weight: 600; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dil-text-tertiary); }
.dot.live { background: var(--dil-chart-2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dil-chart-2) 25%, transparent); }
.dot.err { background: var(--dil-danger); }
.grow { flex: 1; }
.stage { padding: 18px; overflow: auto; }
.err { margin: 0 16px 12px; padding: 9px 12px; border-radius: 10px; background: color-mix(in srgb, var(--dil-danger) 12%, transparent); color: var(--dil-danger); font-size: 12px; white-space: pre-wrap; display: none; }
`;

class DilEmbed extends HTMLElement {
  connectedCallback() {
    if (this.view) return;
    const root = this.attachShadow({ mode: 'open' });
    const height = Number(this.getAttribute('height')) || 0;
    root.innerHTML = `
      <link rel="stylesheet" href="/dil/dil.css">
      <style>${STYLE}</style>
      <div class="shell dil-root">
        <div class="head"><span class="dot"></span><b></b><span class="grow"></span><span class="mode"></span></div>
        <div class="err"></div>
        <div class="stage"${height ? ` style="max-height:${height}px"` : ''}></div>
      </div>`;
    root.querySelector('b').textContent = this.getAttribute('title') || '生成的界面';
    this.$ = (s) => root.querySelector(s);

    this.view = new DilMessageView({
      container: this.$('.stage'),
      sandboxContainer: root,
      onUpdate: (u) => this.onUpdate(u),
      onError: (error, stage) => this.showError(error, stage),
    });

    const source = this.getAttribute('source');
    this.$('.dot').classList.add('live');
    if (source) {
      this.view.loadSource(source).then(() => this.$('.dot').classList.remove('live'), (e) => this.showError(e, 'compile'));
    } else {
      this.view.run(this.getAttribute('prompt') || '生成一个可交互的示例界面', { speed: this.hasAttribute('speed') ? Number(this.getAttribute('speed')) : 0 });
    }
  }

  onUpdate(u) {
    if (u.meta) this.$('.mode').textContent = u.meta.model || u.meta.agent;
    if (u.done) this.$('.dot').classList.remove('live');
  }

  showError(error, stage) {
    const dot = this.$('.dot');
    dot.classList.remove('live');
    dot.classList.add('err');
    const box = this.$('.err');
    box.style.display = 'block';
    box.textContent = `[${stage}] ${error?.name ? error.name + ': ' : ''}${error?.message || error}`;
  }

  disconnectedCallback() {
    this.view?.destroy();
    this.view = null;
  }
}

if (!customElements.get('dil-embed')) customElements.define('dil-embed', DilEmbed);

export { DilEmbed };
