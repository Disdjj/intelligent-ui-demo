'use strict';
/**
 * Mock agent — replays a fixed DIL document in small random chunks, so the whole
 * streaming pipeline (compile → patch → sandbox → render) runs with no credentials.
 */
const { DEMO_SOURCE } = require('./demo-source');

const CHUNK_MIN = 12;
const CHUNK_MAX = 34;

/** Random-sized chunks that never split a surrogate pair. */
function* chunkSource(source, size) {
  let i = 0;
  while (i < source.length) {
    const n = size || CHUNK_MIN + Math.floor(Math.random() * (CHUNK_MAX - CHUNK_MIN));
    let end = Math.min(source.length, i + n);
    const code = source.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff && end < source.length) end += 1;
    yield source.slice(i, end);
    i = end;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function* mockAgent(prompt, options = {}) {
  const speed = options.speed == null ? 9 : options.speed; // ms between chunks
  yield { type: 'meta', model: 'mock-dil-author', mode: 'mock' };
  for (const chunk of chunkSource(options.source || DEMO_SOURCE)) {
    if (speed) await sleep(speed);
    yield { type: 'text', text: chunk };
  }
  yield { type: 'done' };
}

module.exports = { mockAgent, chunkSource };
