'use strict';
/**
 * LLM agent — any OpenAI-compatible `/chat/completions` endpoint with `stream: true`,
 * prompted with the reconstructed DIL system prompt.
 *
 * Reasoning models (DeepSeek V4) stream `reasoning_content` before any `content`;
 * that phase is surfaced as `thinking` progress events, never as source.
 */
const config = require('../config');
const { DIL_SYSTEM_PROMPT } = require('./system-prompt');

const THINKING_REPORT_EVERY = 400; // chars of reasoning between progress events

function requestBody(prompt, stateContext) {
  const { llm } = config;
  const body = {
    model: llm.model,
    stream: true,
    temperature: 0.6,
    messages: [
      { role: 'system', content: DIL_SYSTEM_PROMPT },
      ...(stateContext ? [{ role: 'system', content: stateContext }] : []),
      { role: 'user', content: prompt },
    ],
  };
  if (!llm.thinking) body.thinking = { type: 'disabled' };
  else if (llm.effort) body.reasoning_effort = llm.effort;
  return body;
}

/** Parse an SSE byte stream into `data:` payloads. */
async function* sseData(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

async function* llmAgent(prompt, options = {}) {
  const { llm } = config;
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify(requestBody(prompt, options.stateContext)),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`llm request failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  yield { type: 'meta', model: llm.model, mode: 'llm' };

  let thinking = 0;
  let reported = 0;
  for await (const payload of sseData(res.body)) {
    if (payload === '[DONE]') break;
    let delta;
    try {
      delta = JSON.parse(payload).choices?.[0]?.delta;
    } catch {
      continue; // keep-alives and comments
    }
    if (!delta) continue;
    if (delta.reasoning_content) {
      thinking += delta.reasoning_content.length;
      // report the first chunk at once, then every few hundred chars
      if (!reported || thinking - reported >= THINKING_REPORT_EVERY) {
        reported = thinking;
        yield { type: 'thinking', chars: thinking };
      }
    }
    if (delta.content) yield { type: 'text', text: delta.content };
  }
  yield { type: 'done' };
}

module.exports = { llmAgent, requestBody };
