'use strict';
/**
 * DIL compiler — turns model-authored "Intelligent UI" source into a program.
 *
 *   source ─ parser ──► AST + recovery diagnostics          (never throws)
 *            ├ repair      undeclared state, code fences (reported as diagnostics)
 *            ├ markdown    prose → title / text / list elements
 *            ├ statements  {@body} → keyed / guarded statements
 *            ├ codegen     tree → __dil.jsx(...) + constant pool
 *            ├ fallback    static markdown projection
 *            └ genui-components   widget source spans for the stream
 *
 * Output shape mirrors the captured artifact:
 *
 *   function __dilSafe(evaluate,failureValue){try{return evaluate()}catch{return failureValue}}
 *   DIL.render(__dil.jsx(()=>{
 *     const __dilConstants=DIL.useConstants();
 *     const [tab,setTab] = DIL.useState("overview",{key:"tab"});
 *     return __dil.jsx("box",{gap:2},__dilConstants["0"], …);
 *   },{"key":"body:0"}));
 */
const { parse } = require('./parser');
const { createGenerator } = require('./codegen');
const { splitStatements, rewriteStatement, stateKeysOf } = require('./statements');
const { toFallback, tidyFallback } = require('./fallback');
const { genuiComponents, genuiComponentPatches } = require('./genui-components');
const { readBalanced, splitEachClause } = require('./scanner');
const { lowerMarkdown } = require('./markdown');
const { repairUndeclaredState, findFences } = require('./repair');
const { lineCol } = require('./scanner');
const { isStatement, isProgram } = require('./validate');
const { INTRINSIC, resolutionId } = require('./components');

const PROTOCOL_VERSION = 1;
const SAFE_PRELUDE = 'function __dilSafe(evaluate,failureValue){try{return evaluate()}catch{return failureValue}}';

/** `clean`, or `code×n` pairs — the one-line form the UI shows. */
function summarize(diagnostics) {
  if (!diagnostics.length) return 'clean';
  const counts = new Map();
  for (const d of diagnostics) counts.set(d.code, (counts.get(d.code) || 0) + 1);
  return [...counts].map(([k, v]) => `${k}×${v}`).join(' ');
}

function compile(source, options = {}) {
  const t0 = Date.now();
  const { nodes, diagnostics: parseDiagnostics } = parse(source);
  const diagnostics = [...parseDiagnostics];
  // Prose is lowered to title/text/list elements for the program; the fallback keeps
  // the original markdown, which is what a non-sandbox client should show anyway.
  const lowered = lowerMarkdown(nodes);
  const { tree, constants, components, shimSources, resolutions, invalid } = createGenerator().generate(lowered);
  const declared = nodes.filter((n) => n.type === 'stmt').flatMap((n) => splitStatements(n.code));
  // Repairs for common model mistakes; each is reported next to the parse diagnostics.
  const implicit = repairUndeclaredState(nodes, declared.filter((c) => isStatement(rewriteStatement(c))));
  // A statement that does not parse is dropped (its names then fall to
  // implicit-state repair or to the per-element guards) rather than failing the program.
  const stmtNodes = nodes.filter((n) => n.type === 'stmt');
  const dropped = [];
  const valid = declared.filter((code) => {
    if (isStatement(rewriteStatement(code))) return true;
    const owner = stmtNodes.find((n) => n.code.includes(code.slice(0, 40))) || stmtNodes[0];
    dropped.push({ code: 'invalid_statement', action: 'dropped', pos: owner ? owner.pos : 0, snippet: code.slice(0, 80) });
    return false;
  });
  const statements = [...implicit.statements, ...valid];
  for (const r of [...implicit.repairs, ...findFences(nodes), ...dropped, ...invalid]) {
    const { pos, ...rest } = r;
    diagnostics.push({ ...rest, ...lineCol(source, pos) });
  }

  const body = [
    'const __dilConstants=DIL.useConstants();',
    'const __dilModelDataBindings=DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});',
    ...statements.map((s) => `${rewriteStatement(s)};`),
    `return ${tree};`,
  ].join('\n');

  let code = [SAFE_PRELUDE, ...shimSources, `DIL.render(__dil.jsx(()=>{\n${body}\n},{"key":"body:0"}));`].join('\n\n');
  // Last line of defence: every fragment was checked, but if their composition still
  // does not parse, ship the fallback as plain text rather than a program that throws.
  if (!isProgram(code)) {
    diagnostics.push({ code: 'invalid_program', action: 'fallback', line: 1, column: 1 });
    code = `${SAFE_PRELUDE}\n\nDIL.render(__dil.jsx(()=>__dil.jsx("text",null,${JSON.stringify(tidyFallback(toFallback(nodes)))}),{"key":"body:0"}));`;
  }

  return {
    ok: diagnostics.length === 0,
    protocolVersion: PROTOCOL_VERSION,
    source,
    sourceLength: source.length,
    code,
    codeLength: code.length,
    constants,
    constantCount: Object.keys(constants).length,
    requiredComponents: components,
    // Shipped next to the code: one entry per host component occurrence, keyed by the
    // id the compiled code passes as `__resolutionId`.
    appData: { opGenui: { componentResults: resolutions, modelDataBindings: options.modelDataBindings || {} } },
    genuiComponents: genuiComponents(lowered, source, Object.keys(resolutions)),
    stateKeys: stateKeysOf(statements),
    fallbackMarkdown: tidyFallback(toFallback(nodes)),
    diagnostics,
    diagnosticSummary: summarize(diagnostics),
    durationMs: Date.now() - t0,
    compiledAt: new Date().toISOString(),
  };
}

module.exports = {
  compile,
  parse,
  genuiComponentPatches,
  // exposed for tests and tooling
  readBalanced,
  splitEachClause,
  splitStatements,
  rewriteStatement,
  resolutionId,
  toFallback,
  tidyFallback,
  PROTOCOL_VERSION,
  INTRINSIC,
};
