'use strict';
/**
 * The "agent" — whatever produces DIL source. Two interchangeable implementations
 * behind one async-iterable interface yielding
 *
 *   { type:'meta' } · { type:'thinking', chars } · { type:'text', text } · { type:'done' }
 *
 * Both yield *source text*, never JSON. Compilation happens downstream on every
 * chunk — the model emits source, the server makes programs.
 */
const config = require('../config');
const { mockAgent, chunkSource } = require('./mock');
const { llmAgent } = require('./llm');
const { DEMO_SOURCE } = require('./demo-source');
const { DIL_SYSTEM_PROMPT } = require('./system-prompt');

function createAgent() {
  return config.llm.enabled ? llmAgent : mockAgent;
}

/** What `/api/health` and the UI show about the active agent. */
function describeAgent() {
  const { llm } = config;
  return llm.enabled
    ? { agent: 'llm', model: llm.model, thinking: llm.thinking }
    : { agent: 'mock', model: null, thinking: false };
}

module.exports = { createAgent, describeAgent, mockAgent, llmAgent, chunkSource, DEMO_SOURCE, DIL_SYSTEM_PROMPT };
