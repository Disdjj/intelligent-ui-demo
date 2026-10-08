/** Layout: box / row / column / grid / card / divider / spacer. */
import { el, cls, space, length, justifyToken, applyCommon } from '../dom.js';

/** The flex containers share one implementation; only the default direction differs. */
function flexBox(direction) {
  return (props) => {
    const node = el('div');
    function update(p) {
      applyCommon(node, p);
      node.className = cls(
        `dil-box dil-${direction}`,
        [p.border, 'dil-border'],
        [p.radius, `dil-radius-${p.radius}`],
        [p.background, `dil-bg-${p.background}`],
        [p.align, `dil-align-${p.align}`],
        [p.justify, `dil-justify-${justifyToken(p.justify)}`],
        [p.wrap, 'dil-wrap'],
        [p.flex, 'dil-flex'],
        [p.clip, 'dil-clip']
      );
      node.style.gap = space(p.gap);
      node.style.padding = space(p.padding);
      node.style.flex = p.flex && p.flex !== true ? String(p.flex) : '';
      node.style.height = length(p.height);
    }
    update(props);
    return { node, update };
  };
}

export default {
  box: flexBox('column'),
  column: flexBox('column'),
  row: flexBox('row'),

  grid(props) {
    const node = el('div', 'dil-grid');
    function update(p) {
      applyCommon(node, p);
      const cols = Number(p.columns) || 2;
      // collapse to one column on narrow screens: auto-fit with a floor per column
      node.style.gridTemplateColumns = `repeat(auto-fit, minmax(min(100%, max(160px, calc((100% - ${cols - 1} * var(--gap, 12px)) / ${cols}))), 1fr))`;
      node.style.setProperty('--gap', space(p.gap) || '12px');
      node.style.gap = space(p.gap) || '12px';
    }
    update(props);
    return { node, update };
  },

  'grid-item'(props) {
    const node = el('div', 'dil-grid-item');
    function update(p) {
      applyCommon(node, p);
      node.style.gridColumn = p.span ? `span ${p.span}` : '';
    }
    update(props);
    return { node, update };
  },

  card(props) {
    const node = el('div');
    function update(p) {
      applyCommon(node, p);
      node.className = cls('dil-card', [p.background, `dil-bg-${p.background}`]);
      node.style.gap = space(p.gap);
      node.style.padding = space(p.padding);
    }
    update(props);
    return { node, update };
  },

  divider(props) {
    const node = el('hr');
    function update(p) {
      applyCommon(node, p);
      node.className = cls('dil-divider', [p.color === 'subtle', 'dil-divider-subtle']);
    }
    update(props);
    return { node, update };
  },

  spacer(props) {
    const node = el('div', 'dil-spacer');
    return { node, update: (p) => applyCommon(node, p) };
  },
};
