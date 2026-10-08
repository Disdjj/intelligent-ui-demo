/**
 * Controls. All are *controlled*: the value shown is always the prop the sandbox
 * sent, and user input travels to the sandbox as a handler call. Nothing is kept
 * locally except what prevents the caret from jumping while the user types.
 */
import { el, cls, applyCommon, activeElement, normalizeOptions } from '../dom.js';
import { iconSvg } from '../icons.js';

function radioItem(name, value) {
  const node = el('label', 'dil-radio');
  const input = el('input');
  input.type = 'radio';
  input.name = name;
  const dot = el('span', 'dil-radio-dot');
  const body = el('span', 'dil-radio-body');
  node.append(input, dot, body);
  node.dilValue = value;
  return { node, input, body };
}

function syncRadio(item, group) {
  const on = String(item.dilValue) === group.dataset.value;
  const input = item.querySelector('input');
  if (input.checked !== on) input.checked = on;
  item.classList.toggle('dil-checked', on);
}

/** Set a value without fighting the user: skip while this element has focus. */
function syncValue(input, next) {
  if (activeElement() === input) return;
  if (input.value !== next) input.value = next;
}

const controls = {
  button(props) {
    const node = el('button');
    node.type = 'button';
    function update(p) {
      applyCommon(node, p);
      node.className = cls(
        'dil-button',
        [true, `dil-variant-${p.variant || 'solid'}`],
        [p.color, `dil-tone-${p.color}`],
        [p.size, `dil-size-${p.size}`],
        [p.block, 'dil-block']
      );
      node.disabled = !!p.disabled;
    }
    update(props);
    return { node, update };
  },

  input(props) {
    const node = el('input', 'dil-input');
    function update(p) {
      applyCommon(node, p);
      node.type = ['number', 'email', 'search', 'date', 'time'].includes(p.type) ? p.type : 'text';
      node.placeholder = p.placeholder || '';
      node.disabled = !!p.disabled;
      syncValue(node, p.value == null ? '' : String(p.value));
    }
    update(props);
    return { node, update, readValue: () => (node.type === 'number' ? Number(node.value) : node.value) };
  },

  textarea(props) {
    const node = el('textarea', 'dil-input dil-textarea');
    function update(p) {
      applyCommon(node, p);
      node.placeholder = p.placeholder || '';
      node.rows = Number(p.rows) || 3;
      node.disabled = !!p.disabled;
      syncValue(node, p.value == null ? '' : String(p.value));
    }
    update(props);
    return { node, update };
  },

  checkbox(props) {
    const wrap = el('label', 'dil-checkbox');
    const input = el('input');
    input.type = 'checkbox';
    const box = el('span', 'dil-checkbox-box');
    box.innerHTML = iconSvg('check', 12);
    const body = el('span', 'dil-checkbox-body');
    const fallbackLabel = el('span');
    wrap.append(input, box, body);
    function update(p) {
      applyCommon(wrap, p);
      // `checked` is the dialect; `value` is a common model slip — accept both
      const on = !!(p.checked !== undefined ? p.checked : p.value);
      input.checked = on;
      input.disabled = !!p.disabled;
      wrap.className = cls('dil-checkbox', [on, 'dil-checked'], [p.disabled, 'dil-disabled'], [p.lineThrough && on, 'dil-done']);
      // children are the label; a `label` prop is accepted too
      if (p.label != null) {
        fallbackLabel.textContent = String(p.label);
        if (!fallbackLabel.parentNode) body.append(fallbackLabel);
      } else fallbackLabel.remove();
    }
    update(props);
    return { node: wrap, childHost: body, update, events: { change: 'onChange' }, readValue: () => input.checked };
  },

  switch(props) {
    const made = controls.checkbox(props);
    const update = made.update;
    made.update = (p) => {
      update(p);
      made.node.classList.add('dil-switch');
    };
    made.update(props);
    return made;
  },

  select(props) {
    const wrap = el('div', 'dil-select');
    const node = el('select');
    const chevron = el('span', 'dil-select-chevron');
    chevron.innerHTML = iconSvg('chevron-down', 14);
    wrap.append(node, chevron);
    let sig = null;
    let options = [];
    function update(p) {
      applyCommon(wrap, p);
      options = normalizeOptions(p.options);
      const next = JSON.stringify(options);
      if (next !== sig) {
        sig = next;
        node.textContent = '';
        for (const o of options) {
          const opt = el('option');
          opt.value = String(o.value);
          opt.textContent = o.label;
          node.append(opt);
        }
      }
      node.disabled = !!p.disabled;
      // select via the option: works everywhere, including DOM shims where
      // `HTMLSelectElement.value` is getter-only
      const v = String(p.value ?? '');
      for (const opt of node.options) if (opt.selected !== (opt.value === v)) opt.selected = opt.value === v;
    }
    update(props);
    // hand back the original (possibly non-string) option value
    const readValue = () => (options.find((o) => String(o.value) === node.value) || { value: node.value }).value;
    return { node: wrap, update, events: { change: 'onChange' }, readValue };
  },

  'segmented-control'(props) {
    const node = el('div');
    let sig = null;
    let options = [];
    function update(p) {
      applyCommon(node, p);
      node.className = cls('dil-segmented', [p.block, 'dil-block'], [p.size, `dil-size-${p.size}`]);
      options = normalizeOptions(p.options);
      const next = JSON.stringify(options);
      if (next !== sig) {
        sig = next;
        node.textContent = '';
        options.forEach((o, i) => {
          const b = el('button', 'dil-segmented-item');
          b.type = 'button';
          b.textContent = o.label;
          b.dataset.index = String(i);
          node.append(b);
        });
      }
      const v = String(p.value ?? '');
      node.querySelectorAll('.dil-segmented-item').forEach((b, i) => {
        const active = options[i] && String(options[i].value) === v;
        b.classList.toggle('dil-active', !!active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
        b.disabled = !!p.disabled;
      });
    }
    update(props);
    const readValue = (ev) => {
      const b = ev.target.closest && ev.target.closest('.dil-segmented-item');
      return b ? options[Number(b.dataset.index)]?.value : undefined;
    };
    return { node, update, events: { click: 'onChange' }, readValue };
  },

  /**
   * Two dialects:
   *   options  `<radio-group options={[…]} value onChange/>`
   *   children `<radio-group value onChange><radio value="a">…</radio></radio-group>`
   *            (the captured artifact's form; each <radio> renders itself below)
   * Both end up as `.dil-radio` items with a real radio input, so one `change`
   * listener on the group reads the chosen item's original value.
   */
  'radio-group'(props) {
    const node = el('div', 'dil-radio-group');
    node.dataset.name = 'dil-radio-' + Math.random().toString(36).slice(2, 8);
    const items = el('div', 'dil-radio-items');
    const children = el('div', 'dil-radio-items');
    node.append(items, children);
    let sig = null;
    function update(p) {
      applyCommon(node, p);
      node.classList.toggle('dil-row', p.direction === 'row');
      // children read this during their own update, which runs right after ours
      node.dataset.value = String(p.value ?? '');
      node.dilValue = p.value;
      const options = normalizeOptions(p.options);
      const next = JSON.stringify(options);
      if (next !== sig) {
        sig = next;
        items.textContent = '';
        for (const o of options) {
          const item = radioItem(node.dataset.name, o.value);
          item.body.textContent = o.label;
          items.append(item.node);
        }
      }
      for (const item of items.children) syncRadio(item, node);
    }
    update(props);
    const readValue = (ev) => ev.target.closest?.('.dil-radio')?.dilValue;
    return { node, childHost: children, update, events: { change: 'onChange' }, readValue };
  },

  radio(props) {
    const item = radioItem('', props.value);
    function update(p) {
      applyCommon(item.node, p);
      item.node.dilValue = p.value;
      const group = item.node.closest?.('.dil-radio-group');
      if (group) {
        item.input.name = group.dataset.name;
        syncRadio(item.node, group);
      } else {
        // standalone: `checked` like a checkbox
        item.input.checked = !!p.checked;
        item.node.classList.toggle('dil-checked', !!p.checked);
      }
      item.input.disabled = !!p.disabled;
    }
    update(props);
    return { node: item.node, childHost: item.body, update };
  },

  slider(props) {
    const wrap = el('div', 'dil-slider');
    const head = el('div', 'dil-slider-head');
    const label = el('span', 'dil-slider-label');
    const value = el('span', 'dil-slider-value');
    head.append(label, value);
    const input = el('input');
    input.type = 'range';
    wrap.append(head, input);
    function update(p) {
      applyCommon(wrap, p);
      const min = Number(p.min ?? 0);
      const max = Number(p.max ?? 100);
      const v = Number(p.value ?? min);
      input.min = String(min);
      input.max = String(max);
      input.step = String(p.step ?? 1);
      input.disabled = !!p.disabled;
      if (activeElement() !== input && Number(input.value) !== v) input.value = String(v);
      // filled track: CSS reads the percentage
      wrap.style.setProperty('--fill', `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`);
      label.textContent = p.label != null ? String(p.label) : '';
      value.textContent = p.showValue === false ? '' : String(v);
      head.style.display = p.label != null ? '' : 'none';
    }
    update(props);
    return { node: wrap, update, events: { input: 'onChange' }, readValue: () => Number(input.value) };
  },
};

export default controls;
