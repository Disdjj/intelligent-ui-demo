'use strict';
/**
 * HTTP entry point: routes only. The work lives in
 *
 *   http/chat.js        GET  /api/chat                      streamed turn (patches)
 *   compiler/           POST /api/compile                   one-shot compile
 *   view-state.js       POST /api/conversation/{c}/message/{m}/dil/view_state
 *                       GET  /api/conversation/{c}/state_snapshots
 *   sandbox/frame.js    GET  /sandbox/runner.html           the sandboxed iframe
 *
 * plus static files from public/.
 */
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const config = require('./config');
const { compile } = require('./compiler');
const { buildFrameHtml } = require('./sandbox/frame');
const { describeAgent, DEMO_SOURCE, DIL_SYSTEM_PROMPT } = require('./agent');
const { createViewStateStore, snapshotsToContext } = require('./view-state');
const { streamChat, compilePatches, readCapturedSource } = require('./http/chat');
const { sendJson, sendText, readJson, serveFile, serveStatic } = require('./http/respond');
const { genuiComponentPatches } = require('./compiler');

const viewState = createViewStateStore();
const FRAME_HTML = buildFrameHtml();
// The frame declares its CSP in a <meta>; sending it as a header too means the
// policy is in force before the parser reaches the inline script.
const FRAME_CSP = (FRAME_HTML.match(/content="([^"]+)"/) || [])[1] || '';

const PAGES = { '/': 'index.html', '/embed': 'embed.html', '/diag': 'diag.html' };

/** [method, pattern, handler(req, res, match, url)] — first match wins. */
const ROUTES = [
  ['GET', '/api/health', (req, res) =>
    sendJson(res, 200, {
      ok: true,
      protocolVersion: 1,
      ...describeAgent(),
      recompileIntervalMs: config.recompile.intervalMs,
    })],

  ['GET', '/api/demo', (req, res) =>
    sendJson(res, 200, { source: DEMO_SOURCE, capturedSource: readCapturedSource(), systemPrompt: DIL_SYSTEM_PROMPT })],

  ['POST', '/api/compile', async (req, res) => {
    const payload = await readJson(req);
    if (typeof payload.source !== 'string') return sendJson(res, 400, { error: 'source (string) required' });
    if (payload.source.length > 256 * 1024) return sendJson(res, 413, { error: 'source too large' });
    return sendJson(res, 200, compile(payload.source));
  }],

  ['POST', /^\/api\/conversation\/([\w-]{1,64})\/message\/([\w-]{1,64})\/dil\/view_state$/, async (req, res, m) => {
    const out = viewState.apply(m[1], m[2], await readJson(req, 64 * 1024));
    return sendJson(res, out.error ? 400 : 200, out);
  }],

  ['GET', /^\/api\/conversation\/([\w-]{1,64})\/state_snapshots$/, (req, res, m) => {
    const snapshots = viewState.snapshots(m[1]);
    return sendJson(res, 200, { conversation_id: m[1], genui_state_snapshots: snapshots, context: snapshotsToContext(snapshots) });
  }],

  ['GET', '/api/chat', (req, res, m, url) => streamChat(req, res, url, viewState)],

  ['GET', '/sandbox/runner.html', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': FRAME_CSP });
    res.end(FRAME_HTML);
  }],
];

function matchRoute(method, pathname) {
  for (const [m, pattern, handler] of ROUTES) {
    if (m !== method) continue;
    if (typeof pattern === 'string' ? pattern === pathname : pattern.test(pathname)) {
      return { handler, match: typeof pattern === 'string' ? null : pattern.exec(pathname) };
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    const route = matchRoute(req.method, pathname);
    if (route) return await route.handler(req, res, route.match, url);
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    if (PAGES[pathname]) return serveFile(res, path.join(config.publicDir, PAGES[pathname]));
    return serveStatic(res, config.publicDir, pathname);
  } catch (err) {
    if (res.headersSent) return res.end();
    sendJson(res, err.status || 500, { error: String((err && err.message) || err) });
  }
});

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    const { address, port } = server.address();
    const agent = describeAgent();
    const base = `http://${address}:${port}`;
    console.log(`DIL replica listening on ${base}`);
    console.log(`  chat UI        ${base}/`);
    console.log(`  embed demo     ${base}/embed`);
    console.log(`  sandbox frame  ${base}/sandbox/runner.html`);
    console.log(`  agent          ${agent.agent === 'llm' ? `llm (${agent.model}, thinking ${agent.thinking ? 'on' : 'off'})` : 'mock (no credentials needed)'}`);
  });
}

module.exports = { server, viewState, compilePatches, genuiComponentPatches };
