/** Text and chrome: text / title / caption / bold / label / code / icon / badge / link / image. */
import { el, cls, length, applyCommon } from '../dom.js';
import { iconSvg } from '../icons.js';

function textLike(tag, base) {
  return (props) => {
    const node = el(tag);
    function update(p) {
      applyCommon(node, p);
      node.className = cls(
        base,
        [p.size, `dil-size-${p.size}`],
        [p.color, `dil-color-${p.color}`],
        [p.weight, `dil-weight-${p.weight}`],
        [p.tabularNums, 'dil-tabular'],
        [p.lineThrough, 'dil-line-through'],
        [p.block, 'dil-block'],
        [p.truncate, 'dil-truncate']
      );
      node.style.textAlign = p.textAlign || '';
    }
    update(props);
    return { node, update };
  };
}

export default {
  // `text` is a block (a paragraph) unless it sits inside another text-like element,
  // which CSS handles with `.dil-text .dil-text { display: inline }`.
  text: textLike('span', 'dil-text'),
  caption: textLike('span', 'dil-text dil-caption'),
  label: textLike('span', 'dil-text dil-label'),
  bold: textLike('strong', 'dil-bold'),
  code: textLike('code', 'dil-code'),

  title(props) {
    const node = el('div');
    function update(p) {
      applyCommon(node, p);
      node.className = cls('dil-title', [true, `dil-title-${p.size || 'md'}`], [p.color, `dil-color-${p.color}`], [p.tabularNums, 'dil-tabular']);
      node.style.textAlign = p.textAlign || '';
    }
    update(props);
    return { node, update };
  },

  icon(props) {
    const node = el('span');
    let sig = null;
    function update(p) {
      applyCommon(node, p);
      node.className = cls('dil-icon', [p.inline, 'dil-inline'], [p.color, `dil-color-${p.color}`]);
      const next = `${p.name}|${p.size}`;
      if (next !== sig) {
        sig = next;
        node.innerHTML = iconSvg(p.name, p.size);
      }
    }
    update(props);
    return { node, update };
  },

  badge(props) {
    const node = el('span');
    function update(p) {
      applyCommon(node, p);
      node.className = cls('dil-badge', [p.color, `dil-badge-${p.color}`], [p.size, `dil-size-${p.size}`]);
    }
    update(props);
    return { node, update };
  },

  link(props) {
    const node = el('a', 'dil-link');
    node.target = '_blank';
    node.rel = 'noreferrer noopener';
    function update(p) {
      applyCommon(node, p);
      // only http(s) — a model must not be able to emit `javascript:` links
      if (p.href && /^https?:\/\//i.test(p.href)) node.setAttribute('href', p.href);
      else node.removeAttribute('href');
    }
    update(props);
    return { node, update };
  },

  image(props) {
    const node = el('img', 'dil-image');
    node.loading = 'lazy';
    function update(p) {
      applyCommon(node, p);
      if (p.src && /^(https?:|data:image\/)/i.test(p.src)) node.src = p.src;
      node.alt = p.alt || '';
      node.style.height = length(p.height) || 'auto';
      node.style.borderRadius = p.radius === 'full' ? '999px' : '';
    }
    update(props);
    return { node, update };
  },

  spinner(props) {
    const node = el('span', 'dil-spinner');
    node.innerHTML = iconSvg('loader');
    return { node, update: (p) => applyCommon(node, p) };
  },
};
