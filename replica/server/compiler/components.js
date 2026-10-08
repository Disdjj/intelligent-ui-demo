'use strict';
/**
 * The compiler's view of the component vocabulary.
 *
 *   intrinsic  lowercase tags rendered by the host renderer (`box`, `chart`, …)
 *   shim       PascalCase tags the compiler lowers itself (`<Chart content>`)
 *   host       any other PascalCase tag: resolved by the host through
 *              `appData.opGenui.componentResults[__resolutionId]`
 */

const INTRINSIC = new Set([
  'box', 'row', 'column', 'grid', 'grid-item', 'card', 'divider', 'spacer',
  'text', 'title', 'caption', 'bold', 'label', 'code', 'icon', 'badge',
  'button', 'input', 'textarea', 'checkbox', 'radio', 'radio-group', 'select',
  'slider', 'segmented-control', 'table', 'table-row', 'table-cell',
  'list', 'list-item', 'progress', 'chart', 'pie-chart', 'image', 'link',
]);

function isIntrinsic(name) {
  return INTRINSIC.has(name) || /^[a-z][a-z0-9-]*$/.test(name);
}

/**
 * `<Chart content={…}/>` is not a host widget: the compiler swaps it for a shim that
 * validates the model's chart spec and lowers it to intrinsic `chart` / `pie-chart`
 * (the artifact calls it `DilChartContentPropShim`; the stream labels it
 * `charts_widget_v2`). Written fresh for the replica — same contract, smaller body.
 */
const CHART_SHIM = `function DilChartContentPropShim({content=undefined,fallback=null}){
const c = __dilSafe(()=>(content ?? {}),{});
const data = __dilSafe(()=>(Array.isArray(c.data) && c.data.every(r=>r && typeof r==="object" && !Array.isArray(r)) ? c.data : []),[]);
const valid = __dilSafe(()=>(["bar","line","pie","scatter"].includes(c.chartType) && data.length>0),false);
const raw = __dilSafe(()=>(Array.isArray(c.series) ? c.series.filter(s=>s && typeof s.dataKey==="string") : []),[]);
const series = __dilSafe(()=>((raw.length ? raw : [{dataKey:"value"}]).map(s=>({type:c.chartType,dataKey:s.dataKey,label:s.label ?? s.dataKey,stack:s.stack,valuePrefix:s.valuePrefix,valueSuffix:s.valueSuffix}))),[]);
const xKey = __dilSafe(()=>(typeof c.xKey==="string" ? c.xKey : "name"),"name");
const vertical = __dilSafe(()=>(c.chartType==="bar" && c.layout==="vertical"),false);
if (!valid) return fallback;
const meta = c.meta || {};
return __dil.jsx("card",{"gap":3},
typeof meta.title==="string" ? __dil.jsx("title",{"size":"sm"},meta.title) : null,
typeof meta.description==="string" ? __dil.jsx("text",{"size":"sm","color":"secondary"},meta.description) : null,
c.chartType==="pie"
  ? __dil.jsx("pie-chart",{"data":data,"series":[{dataKey:typeof c.valueKey==="string"?c.valueKey:"value",label:(raw[0]||{}).label,valuePrefix:(raw[0]||{}).valuePrefix}],"xAxis":typeof c.nameKey==="string"?c.nameKey:xKey,"height":240})
  : __dil.jsx("chart",{"data":data,"series":series,"xAxis":{dataKey:xKey},"layout":vertical?"vertical":"horizontal","height":vertical&&data.length>9?64+data.length*24:240,"showDots":c.chartType==="line"&&data.length<=40}),
typeof meta.footer==="string" ? __dil.jsx("text",{"size":"sm","color":"tertiary"},meta.footer) : null);
}`;

/** Tags the compiler rewrites itself → the function the generated code calls. */
const SHIMS = { Chart: { fn: 'DilChartContentPropShim', source: CHART_SHIM } };

function kindOf(name) {
  if (SHIMS[name]) return 'shim';
  return isIntrinsic(name) ? 'intrinsic' : 'host';
}

/** `genui_components[].type` as labelled in the captured stream. */
const WIDGET_TYPES = { Chart: 'charts_widget_v2', MemoryCite: 'memory_cite' };

function widgetType(name) {
  return WIDGET_TYPES[name] || name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * A deterministic, UUID-shaped resolution id for the n-th host component. The real
 * server mints one when it resolves the component (`component_resolution_id`).
 */
function resolutionId(name, index) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = `${name}#${index}`;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

module.exports = { INTRINSIC, SHIMS, isIntrinsic, kindOf, widgetType, resolutionId };
