'use strict';
/**
 * All environment configuration, read once. Nothing else in the server touches
 * `process.env`, so this file is the complete list of knobs.
 *
 *   PORT / HOST                 where the HTTP server listens (8787 / 127.0.0.1)
 *   DIL_LLM_BASE_URL            OpenAI-compatible endpoint, e.g. https://api.deepseek.com
 *   DIL_LLM_API_KEY             bearer token; with BASE_URL this switches mock → llm
 *   DIL_LLM_MODEL               e.g. deepseek-flash, deepseek-v4-pro
 *   DIL_LLM_THINKING=off        skip the reasoning phase (first token ~0.5s, not ~30s)
 *   DIL_LLM_EFFORT=low|high     reasoning effort when thinking is on
 *   DIL_RECOMPILE_MS / _BYTES   streaming recompile cadence (70 ms / 320 B)
 */
const path = require('node:path');

const env = process.env;

const llm = {
  baseUrl: (env.DIL_LLM_BASE_URL || '').replace(/\/$/, ''),
  apiKey: env.DIL_LLM_API_KEY || '',
  model: env.DIL_LLM_MODEL || 'deepseek-flash',
  thinking: env.DIL_LLM_THINKING !== 'off',
  effort: env.DIL_LLM_EFFORT || null,
};
llm.enabled = !!(llm.baseUrl && llm.apiKey);

module.exports = {
  port: Number(env.PORT || 8787),
  host: env.HOST || '127.0.0.1',
  publicDir: path.join(__dirname, '..', 'public'),
  /** The captured ChatGPT document, when the repo's artifacts/ sits next to replica/. */
  capturedSourcePath: path.join(__dirname, '..', '..', 'artifacts', 'genui-source.dil.md'),
  recompile: {
    intervalMs: Number(env.DIL_RECOMPILE_MS || 70),
    minBytes: Number(env.DIL_RECOMPILE_BYTES || 320),
  },
  llm,
};
