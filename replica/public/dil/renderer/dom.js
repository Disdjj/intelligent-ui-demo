/**
 * Shared helpers for component factories.
 *
 * A factory is `(props, ctx) => handle`, where a handle is
 *
 *   { node, update(props), childHost?, events?, readValue? }
 *
 *   node       the DOM node inserted into the tree
 *   update     called on every patch with the latest props (keep DOM state in sync)
 *   childHost  where children are patched (defaults to `node`)
 *   events     { domEvent: 'propName' } — overrides the default event for a prop
 *   readValue  (event) => value passed to the sandbox handler
 */

export function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** Numeric scale (`gap={2}`) and size tokens (`gap="lg"`) both resolve to px. */
const SPACING = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 };
const SPACING_TOKENS = { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32 };

export function space(v) {
  if (v == null || v === false) return '';
  if (typeof v === 'number') return (SPACING[v] ?? v * 4) + 'px';
  if (/^\d+$/.test(v)) return (SPACING[v] ?? Number(v) * 4) + 'px';
  if (v in SPACING_TOKENS) return SPACING_TOKENS[v] + 'px';
  return String(v);
}

export function length(v) {
  if (v == null || v === '') return '';
  return typeof v === 'number' ? v + 'px' : String(v);
}

/** `justify="space-between"` (CSS spelling) → the `between` token. */
export function justifyToken(v) {
  return String(v).replace(/^space-/, '').replace(/^flex-/, '');
}

/** Build a className from a base and `[condition, class]` pairs. */
export function cls(base, ...pairs) {
  let out = base;
  for (const [on, name] of pairs) if (on) out += ' ' + name;
  return out;
}

/** Applied to every component: the stable marker plus universal sizing props. */
export function applyCommon(node, props) {
  node.setAttribute('data-d-component', props.__tag);
  node.style.width = length(props.width);
  node.style.display = props.hidden ? 'none' : '';
}

export function activeElement() {
  try {
    return document.activeElement || null;
  } catch {
    return null;
  }
}

/** Options as models write them: `[{label,value}]`, or bare strings. */
export function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((o) =>
    o != null && typeof o === 'object'
      ? { label: String(o.label ?? o.value ?? ''), value: o.value ?? o.label }
      : { label: String(o), value: o }
  );
}
