/**
 * Host components — PascalCase tags the model can reference but not define.
 *
 * The compiler stamps each occurrence with `__resolutionId`; the server ships the
 * outcome in `appData.opGenui.componentResults[id] = { status, componentName }`.
 * A host widget mounts only when that indirection says `resolved` *and* the name is
 * registered here — the model cannot name its way into an arbitrary component.
 * Anything else renders a quiet placeholder.
 */
import { el, esc } from '../dom.js';
import { iconSvg } from '../icons.js';

const HOST = {
  MemoryCite() {
    const node = el('span', 'dil-memory-cite');
    node.innerHTML = iconSvg('sparkles', 12) + '<span>记忆</span>';
    node.title = '这段回答引用了已保存的记忆';
    node.setAttribute('role', 'note');
    return { node, update() {} };
  },
};

export function defineHost(name, factory) {
  HOST[name] = factory;
}

export function createHostComponent(tag, props, ctx) {
  const id = props && props.__resolutionId;
  const result = id && ctx.componentResults ? ctx.componentResults[id] : null;
  const factory = HOST[tag];
  if (factory && result && result.status === 'resolved' && result.componentName === tag) {
    const handle = factory(props, result);
    handle.node.setAttribute('data-d-resolution', id);
    return handle;
  }
  ctx.onMissingComponent?.(tag, result);
  const node = el('div', 'dil-widget dil-widget-unresolved');
  node.innerHTML =
    `<span class="dil-widget-icon">${iconSvg('layers', 16)}</span>` +
    `<span class="dil-widget-body"><b>${esc(tag)}</b><small>${result ? '组件状态：' + esc(result.status) : '宿主未提供该组件'}</small></span>`;
  return { node, update() {} };
}
