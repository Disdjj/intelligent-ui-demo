#!/usr/bin/env node
'use strict';
/**
 * Real-browser smoke check, driven over the Chrome DevTools Protocol.
 *
 *   node tools/browser-check.js http://127.0.0.1:8787/ [--wait 6000] [--shot out.png]
 *
 * Why this exists: the sandbox is a sandboxed iframe spawning a blob: Worker, and that
 * combination cannot be faithfully tested in Node — CSP, opaque origins and Worker
 * creation are browser policy. So the last mile gets checked in a real browser.
 *
 * Uses Node's built-in WebSocket; no dependencies.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const waitMs = Number((process.argv.includes('--wait') && process.argv[process.argv.indexOf('--wait') + 1]) || 7000);
const shotIdx = process.argv.indexOf('--shot');
const shotPath = shotIdx >= 0 ? process.argv[shotIdx + 1] : null;
const port = 9222 + Math.floor(Math.random() * 500);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bin = findChrome();
  if (!bin) {
    console.error('no Chrome/Chromium found; skipping browser check');
    process.exit(0);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-chrome-'));
  if (process.env.DIL_DEBUG) console.error('[dbg] chrome:', bin);
  const child = spawn(bin, [
    '--headless=old',
    '--disable-gpu',
    // These two are what make headless Chrome survivable in a restricted sandbox:
    // without them it dies with "GPU process isn't usable" before printing anything.
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1280,1600',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    // Required when a non-browser CDP client connects: Chrome rejects the handshake
    // otherwise and the socket closes with 1006.
    '--remote-allow-origins=*',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    // wait for the debugging endpoint
    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch { /* not up yet */ }
    }
    if (!target) {
      console.error('could not reach the DevTools endpoint\n' + stderr.slice(-800));
      process.exit(1);
    }

    if (process.env.DIL_DEBUG) console.error('[dbg] target:', target.webSocketDebuggerUrl);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = (e) => rej(new Error('ws error: ' + (e.message || 'unknown')));
    });

    let id = 0;
    const pending = new Map();
    const consoleLines = [];
    const exceptions = [];
    const failedRequests = [];

    ws.addEventListener('close', (e) => { if (process.env.DIL_DEBUG) console.error('[dbg] ws close', e.code, e.reason); });
    ws.addEventListener('error', (e) => { if (process.env.DIL_DEBUG) console.error('[dbg] ws error', e.message || e.type); });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (process.env.DIL_DEBUG && msg.id) console.error('[dbg] <-', msg.id);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        consoleLines.push({
          type: msg.params.type,
          text: msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
        });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        exceptions.push({
          text: d.text + ' ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : ''),
          url: d.url,
          line: d.lineNumber,
        });
      } else if (msg.method === 'Network.loadingFailed') {
        failedRequests.push(msg.params.errorText);
      }
    });

    const send = (method, params) => new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      if (process.env.DIL_DEBUG) console.error('[dbg] ->', mid, method);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });

    if (process.env.DIL_DEBUG) console.error('[dbg] ws open');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });

    await sleep(waitMs);
    if (process.env.DIL_DEBUG) console.error('[dbg] waited');

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    const probe = await evaluate(`(() => {
      const stats = document.querySelector('[data-dil-stats]');
      const stage = document.querySelector('[data-dil-stage]');
      const sandboxFrame = document.querySelector('iframe[data-dil-sandbox]');
      const result = document.getElementById('result');
      let diag = null;
      if (result) { try { diag = JSON.parse(result.textContent); } catch (e) { diag = result.textContent; } }
      return {
        title: document.title,
        agentPill: (document.getElementById('agent-pill') || {}).textContent || null,
        statsText: stats ? stats.textContent.trim() : null,
        stageHtmlLength: stage ? stage.innerHTML.length : null,
        stageSample: stage ? stage.innerHTML.slice(0, 200) : null,
        sandboxFramePresent: !!sandboxFrame,
        sandboxFrameSandbox: sandboxFrame ? sandboxFrame.getAttribute('sandbox') : null,
        componentCount: document.querySelectorAll('[data-d-component]').length,
        components: [...new Set([...document.querySelectorAll('[data-d-component]')].map(e => e.getAttribute('data-d-component')))].slice(0, 26),
        chartBars: document.querySelectorAll('.dil-chart-bar').length,
        diag,
      };
    })()`);

    let screenshot = null;
    if (shotPath) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      if (r.result && r.result.data) {
        fs.writeFileSync(shotPath, Buffer.from(r.result.data, 'base64'));
        screenshot = shotPath;
      }
    }

    const report = { url, probe, console: consoleLines, exceptions, failedRequests, screenshot };
    console.log(JSON.stringify(report, null, 2));

    ws.close();

    const ok = probe && probe.componentCount > 0 && exceptions.length === 0;
    process.exit(ok ? 0 : 2);
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('browser-check failed:', e.message);
  process.exit(1);
});
