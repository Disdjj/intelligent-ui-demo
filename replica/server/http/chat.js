'use strict';
/**
 * `GET /api/chat` — one conversation turn as a stream of patches.
 *
 * Shaped like the captured protocol (ANALYSIS.md §3): a single `delta` event type
 * carrying `{p,o,v}` operations. The compiled program arrives as a full `replace` on
 * every recompile rather than an incremental diff — intermediate source is usually
 * invalid, so incremental compilation would cost more correctness than it saves.
 *
 * Other events: `meta` (ids, agent), `thinking` (reasoning progress), `note`
 * (developer log), `error`, and a final `data: [DONE]`.
 */
const fs = require('node:fs');
const config = require('../config');
const { compile, genuiComponentPatches } = require('../compiler');
const { createAgent, describeAgent, mockAgent, DEMO_SOURCE } = require('../agent');
const { snapshotsToContext } = require('../view-state');

const DEFAULT_CONVERSATION = 'conv_demo_0001';
const ID = /^[\w-]{1,64}$/;

function readCapturedSource() {
  return fs.existsSync(config.capturedSourcePath) ? fs.readFileSync(config.capturedSourcePath, 'utf8') : null;
}

/**
 * The metadata patches for one compile. Order matters: the client pushes a program
 * into the sandbox when `code` lands, so everything the program reads (constants,
 * appData) must arrive first.
 */
function compilePatches(source, revision) {
  const result = compile(source);
  const base = '/message/metadata/model_dil_v2';
  return {
    result,
    patches: [
      { p: `${base}/constants`, o: 'replace', v: result.constants },
      { p: `${base}/appData`, o: 'replace', v: result.appData },
      { p: `${base}/fallbackMarkdown`, o: 'replace', v: result.fallbackMarkdown },
      { p: `${base}/diagnostics`, o: 'replace', v: result.diagnostics },
      { p: `${base}/requiredComponents`, o: 'replace', v: result.requiredComponents },
      {
        p: `${base}/stats`,
        o: 'replace',
        v: {
          revision,
          sourceLength: result.sourceLength,
          codeLength: result.codeLength,
          constantCount: result.constantCount,
          diagnosticSummary: result.diagnosticSummary,
          durationMs: result.durationMs,
        },
      },
      { p: `${base}/code`, o: 'replace', v: result.code },
    ],
  };
}

/** Which source the mock agent replays: `?source=captured`, inline text, or the demo. */
function resolveSource(param) {
  if (param === 'captured') return readCapturedSource() || DEMO_SOURCE;
  return param || DEMO_SOURCE;
}

function openEventStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const stream = { closed: false };
  req.on('close', () => { stream.closed = true; });
  stream.event = (event, data) => {
    if (stream.closed) return;
    res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  };
  stream.patch = (p) => stream.event('delta', p);
  stream.note = (label, detail) => stream.event('note', { label, detail, at: Date.now() });
  return stream;
}

/**
 * Accumulates source and decides when to recompile: on a time budget *or* once
 * enough new bytes arrived (a pure time budget degenerates when a stream is replayed
 * faster than the wall clock). The real system recompiled ~134 times for ~7 KB.
 */
function createCompileLoop(stream) {
  let source = '';
  let revision = 0;
  let compiles = 0;
  let lastAt = 0;
  let lastLength = 0;
  let components = [];
  let last = null;

  const run = () => {
    revision += 1;
    compiles += 1;
    const { result, patches } = compilePatches(source, revision);
    patches.forEach(stream.patch);
    genuiComponentPatches(components, result.genuiComponents).forEach(stream.patch);
    components = result.genuiComponents;
    last = result;
    return result;
  };

  return {
    append(text) {
      source += text;
      const now = Date.now();
      if (now - lastAt < config.recompile.intervalMs && source.length - lastLength < config.recompile.minBytes) return null;
      lastAt = now;
      lastLength = source.length;
      return run();
    },
    final: run,
    get compiles() { return compiles; },
    get revision() { return revision; },
    get last() { return last; },
  };
}

async function streamChat(req, res, url, viewState) {
  const params = url.searchParams;
  const conversationId = ID.test(params.get('conversation_id') || '') ? params.get('conversation_id') : DEFAULT_CONVERSATION;
  const prompt = params.get('q') || '生成一个可交互的示例界面';
  const speed = params.get('speed');
  // Replay what the user did to earlier interfaces into this turn's context.
  const snapshots = viewState.snapshots(conversationId);
  const stateContext = snapshotsToContext(snapshots);

  const stream = openEventStream(req, res);
  const messageId = 'msg_' + Math.random().toString(36).slice(2, 10);
  const startedAt = Date.now();
  const agentInfo = describeAgent();

  stream.event('meta', {
    conversation_id: conversationId,
    message_id: messageId,
    genui_state_snapshots: snapshots.length,
    ...agentInfo,
    protocolVersion: 1,
  });
  stream.note('request', `agent=${agentInfo.agent} recompile_interval=${config.recompile.intervalMs}ms`);
  if (stateContext) stream.note('genui_state_snapshots', stateContext);

  const loop = createCompileLoop(stream);
  // An explicit `source` is a replay request: always the mock agent, never the model.
  const agent = params.get('source') ? mockAgent : createAgent();
  try {
    const options = { speed: speed == null ? undefined : Number(speed), source: resolveSource(params.get('source')), stateContext };
    for await (const item of agent(prompt, options)) {
      if (stream.closed) break;
      if (item.type === 'meta') stream.note('agent', `${item.mode} · ${item.model}`);
      if (item.type === 'thinking') {
        stream.event('thinking', { chars: item.chars, elapsedMs: Date.now() - startedAt });
      }
      if (item.type !== 'text') continue;
      stream.patch({ p: '/message/content/parts/0', o: 'append', v: item.text });
      const result = loop.append(item.text);
      if (result) {
        stream.note('compile', `#${loop.revision} source=${result.sourceLength}B code=${result.codeLength}B consts=${result.constantCount} diag=${result.diagnosticSummary}`);
      }
    }
  } catch (err) {
    stream.event('error', { message: String((err && err.message) || err) });
  }

  if (!stream.closed) {
    const result = loop.final();
    stream.patch({ p: '/message/status', o: 'replace', v: 'finished_successfully' });
    stream.patch({ p: '/message/metadata/model_dil_v2/durationMs', o: 'replace', v: Date.now() - startedAt });
    stream.note('compile', `#${loop.revision} final source=${result.sourceLength}B code=${result.codeLength}B compiles=${loop.compiles}`);
    stream.event('delta', {
      type: 'message_stream_complete',
      conversation_id: conversationId,
      message_id: messageId,
      stats: {
        sourceLength: result.sourceLength,
        codeLength: result.codeLength,
        constantCount: result.constantCount,
        compiles: loop.compiles,
        diagnostics: result.diagnostics.length,
        elapsedMs: Date.now() - startedAt,
      },
    });
    res.write('data: [DONE]\n\n');
  }
  res.end();
}

module.exports = { streamChat, compilePatches, readCapturedSource };
