/**
 * Host-side renderer: the sandbox produces a serializable element tree; this turns
 * it into DOM and keeps it patched.
 *
 *   const view = mount(container, tree, { onEvent, appData });
 *   view.update(nextTree);
 *
 * Every rendered element carries `data-d-component="<tag>"` — the marker the real
 * client uses, and the hook tests and tooling attach to. Nothing here is generated:
 * this is the host's fixed vocabulary, and the model can only *describe* a UI in it.
 */
import layout from './components/layout.js';
import text from './components/text.js';
import controls from './components/controls.js';
import data from './components/data.js';
import charts from './components/charts.js';
import { defineHost } from './components/host.js';
import { createPatcher, flatten } from './patch.js';
import { iconSvg, ICON_NAMES } from './icons.js';

export const FACTORIES = { ...layout, ...text, ...controls, ...data, ...charts };

function componentResults(appData) {
  return (appData && appData.opGenui && appData.opGenui.componentResults) || {};
}

export function mount(container, tree, options = {}) {
  const ctx = {
    onEvent: options.onEvent || (() => {}),
    onMissingComponent: options.onMissingComponent,
    componentResults: componentResults(options.appData),
  };
  const { patchChildren } = createPatcher(FACTORIES, ctx);
  const records = [];
  let current = null;

  const view = {
    update(nextTree) {
      current = nextTree;
      patchChildren(container, records, flatten(nextTree ? [nextTree] : []));
      container.setAttribute('data-dil-ready', 'true');
    },
    /** New appData (componentResults arriving mid-stream) applies to future mounts. */
    setAppData(appData) {
      ctx.componentResults = componentResults(appData);
    },
    get tree() {
      return current;
    },
    destroy() {
      container.textContent = '';
      records.length = 0;
    },
  };
  if (tree) view.update(tree);
  return view;
}

export { defineHost, flatten, iconSvg, ICON_NAMES };
