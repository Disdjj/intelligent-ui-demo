/**
 * Developer panel — what crossed each boundary for the selected turn.
 *
 * Tabs read straight from the turn's message model and log; the panel holds no
 * state of its own beyond which tab is open.
 */

const TABS = [
  { id: 'log', label: '协议' },
  { id: 'source', label: '源码' },
  { id: 'code', label: '编译产物' },
  { id: 'constants', label: '常量池' },
  { id: 'components', label: '组件通道' },
  { id: 'state', label: '视图状态' },
  { id: 'diagnostics', label: '诊断' },
  { id: 'fallback', label: '降级' },
];

const pad = (n, w = 2) => String(n).padStart(w, '0');
function clock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const VIEWS = {
  log(turn) {
    const rows = turn.log.filter((l) => l.dir !== 'frame:diag' || l.err);
    return {
      html: rows
        .map((l) => {
          const detail = l.detail == null ? '' : typeof l.detail === 'string' ? l.detail : JSON.stringify(l.detail);
          return `<span class="log${l.err ? ' err' : ''}"><i>${clock(l.at)}</i><em>${esc(l.dir)}</em><b>${esc(l.kind)}</b>${esc(detail.slice(0, 400))}</span>`;
        })
        .join(''),
      meta: `${rows.length} 条（已隐藏沙箱启动探针）`,
      scrollEnd: true,
    };
  },
  source: (turn) => ({ text: turn.message.content.parts[0] || '', meta: '模型输出的 DIL 源码' }),
  code: (turn) => ({ text: turn.message.metadata.model_dil_v2.code || '', meta: '送进沙箱执行的 JavaScript' }),
  constants: (turn) => ({ text: JSON.stringify(turn.message.metadata.model_dil_v2.constants || {}, null, 2), meta: '字符串常量池' }),
  components(turn) {
    const list = turn.message.metadata.genui_components || [];
    return {
      text: list.length
        ? list
            .map((c) => `${c.type.padEnd(18)} tree ${c.tree_range.join('–').padEnd(9)} src ${c.start_index}–${c.end_index}${c.streaming ? '  ⟳ 生成中' : '  ✓'}` +
              (c.component_resolution_id ? `\n${' '.repeat(19)}resolution ${c.component_resolution_id}` : ''))
            .join('\n')
        : '本条消息没有走组件通道的组件',
      meta: 'genui_components：源码区间按 Unicode 码点计',
    };
  },
  state(turn) {
    const r = turn.lastReport;
    return {
      text: r
        ? `POST …/dil/view_state\n${JSON.stringify(r.body, null, 2)}\n\n← ${JSON.stringify(r.response, null, 2)}`
        : '还没有上报。和界面交互后，这里会出现请求体与服务端响应。',
      meta: '下一轮对话会把用户改动过的状态交给模型',
    };
  },
  diagnostics(turn) {
    const d = turn.message.metadata.model_dil_v2.diagnostics || [];
    return {
      text: d.length
        ? d.map((x) => `${x.code}  ${x.line}:${x.column}${x.action ? `  [${x.action}]` : ''}${x.tag ? `  <${x.tag}>` : ''}${x.directive ? `  {${x.directive}}` : ''}`).join('\n')
        : '最终编译没有恢复诊断',
      meta: '解析器从不合法输入中恢复的记录',
    };
  },
  fallback: (turn) => ({ text: turn.message.metadata.model_dil_v2.fallbackMarkdown || '', meta: '没有沙箱时显示的 Markdown' }),
};

export function createDevPanel({ panel, tabs, body, meta, toggle, close }) {
  let active = 'log';
  let turn = null;

  tabs.innerHTML = TABS.map((t) => `<button type="button" data-tab="${t.id}">${t.label}</button>`).join('');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    active = b.dataset.tab;
    render();
  });

  const setOpen = (open) => {
    panel.hidden = !open;
    document.body.classList.toggle('dev-open', open);
    toggle.setAttribute('aria-pressed', String(open));
    if (open) render();
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));

  function render() {
    if (panel.hidden) return;
    tabs.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === active));
    if (!turn) {
      meta.textContent = '';
      body.textContent = '还没有对话。';
      return;
    }
    const v = VIEWS[active](turn);
    meta.textContent = `「${turn.prompt.slice(0, 24)}${turn.prompt.length > 24 ? '…' : ''}」 · ${v.meta}`;
    const nearEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    if (v.html != null) body.innerHTML = v.html;
    else if (body.textContent !== v.text) body.textContent = v.text;
    if (v.scrollEnd && nearEnd) body.scrollTop = body.scrollHeight;
  }

  return {
    show(t) {
      turn = t;
      setOpen(true);
    },
    follow(t) {
      turn = t;
      render();
    },
    refresh(t) {
      if (t === turn) render();
    },
  };
}
