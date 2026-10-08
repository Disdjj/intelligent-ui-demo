/**
 * Patch engine: serialized tree → DOM, updated in place.
 *
 * Tree nodes from the sandbox:
 *   { t:'#text', v }   text
 *   { t:'#frag', c }   fragment (flattened away here)
 *   { t, p, c }        element: tag, props, children
 *
 * Children are matched by index and replaced only when the node kind or tag changes,
 * so element identity survives updates — an <input> keeps focus while the model is
 * still streaming a new revision of its own UI.
 *
 * Handlers never cross the boundary as functions: an `on*` prop is a
 * `{__dilFn:"fnN"}` reference, and firing it sends the id (plus the value read from
 * the DOM) back to the sandbox.
 */
import { createHostComponent } from './components/host.js';

/** prop → default DOM event. `onChange` listens to `input` so typing updates live. */
const EVENTS = {
  onClick: 'click',
  onChange: 'input',
  onInput: 'input',
  onBlur: 'blur',
  onFocus: 'focus',
  onKeyDown: 'keydown',
  onKeyUp: 'keyup',
  onSubmit: 'submit',
};

const isText = (n) => n && n.t === '#text';
const isFrag = (n) => n && n.t === '#frag';

export function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    if (!n) continue;
    if (isFrag(n)) flatten(n.c, out);
    else out.push(n);
  }
  return out;
}

export function createPatcher(factories, ctx) {
  function createHandle(tag, props) {
    const withTag = { ...props, __tag: tag };
    const handle = factories[tag] ? factories[tag](withTag, ctx) : createHostComponent(tag, withTag, ctx);
    handle.node.setAttribute('data-d-component', tag);
    handle.tag = tag;
    return handle;
  }

  /** Wire `on*` props to DOM listeners, reusing listeners whose fnId is unchanged. */
  function bindEvents(handle, props) {
    const bound = handle.bound || (handle.bound = {});
    const override = {};
    for (const [domType, prop] of Object.entries(handle.events || {})) override[prop] = domType;

    for (const prop of Object.keys(EVENTS)) {
      const fnId = props[prop] && props[prop].__dilFn;
      const type = override[prop] || EVENTS[prop];
      const prev = bound[prop];
      if (prev && prev.fnId === fnId) continue;
      if (prev) handle.node.removeEventListener(prev.type, prev.listener);
      delete bound[prop];
      if (!fnId) continue;

      const listener = (ev) => {
        // the handler lives in the sandbox, so the *value* travels with the event:
        // `setChannel` must be called as `setChannel(newValue)`
        const value = handle.readValue ? handle.readValue(ev) : ev.target && 'value' in ev.target ? ev.target.value : undefined;
        if (handle.readValue && value === undefined && type === 'click' && prop === 'onChange') return; // click between segments
        ctx.onEvent(fnId, [value], { type: ev.type, value });
      };
      handle.node.addEventListener(type, listener);
      bound[prop] = { fnId, type, listener };
    }
  }

  function create(entry) {
    if (isText(entry)) return { text: true, node: document.createTextNode(entry.v), children: [] };
    const handle = createHandle(entry.t, entry.p || {});
    return { text: false, handle, node: handle.node, children: [] };
  }

  function update(rec, entry) {
    if (isText(entry)) {
      if (rec.node.nodeValue !== entry.v) rec.node.nodeValue = entry.v;
      return;
    }
    const props = entry.p || {};
    rec.handle.update({ ...props, __tag: rec.handle.tag });
    bindEvents(rec.handle, props);
    patchChildren(rec.handle.childHost || rec.node, rec.children, flatten(entry.c));
  }

  function sameShape(rec, entry) {
    return isText(entry) ? rec.text : !rec.text && rec.handle.tag === entry.t;
  }

  function patchChildren(container, records, entries) {
    const next = [];
    entries.forEach((entry, i) => {
      const old = records[i];
      if (old && sameShape(old, entry)) {
        update(old, entry);
        next.push(old);
        return;
      }
      const made = create(entry);
      if (old) container.replaceChild(made.node, old.node);
      else container.appendChild(made.node);
      update(made, entry);
      next.push(made);
    });
    for (let j = entries.length; j < records.length; j++) container.removeChild(records[j].node);
    records.length = 0;
    records.push(...next);
  }

  return { patchChildren };
}
