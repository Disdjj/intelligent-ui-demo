/**
 * The streamed message model.
 *
 * The server sends `{p,o,v}` patches against a document whose root is `message`;
 * applying them in order reproduces the message exactly as the server built it.
 * `openTurn()` wraps the SSE connection and turns events into callbacks.
 */

export function emptyMessage(id) {
  return {
    id: id || 'msg_' + Math.random().toString(36).slice(2, 8),
    status: 'in_progress',
    content: { content_type: 'text', parts: [''] },
    metadata: {
      model_dil_v2: {
        code: '',
        constants: {},
        appData: {},
        fallbackMarkdown: '',
        diagnostics: [],
        requiredComponents: [],
        stats: null,
      },
      genui_components: [],
    },
  };
}

/** Apply one patch. Paths are rooted at the stream document: `/message/content/…`. */
export function applyPatch(message, patch) {
  const tokens = (patch.p || '')
    .split('/')
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? Number(t) : t));
  if (tokens[0] === 'message') tokens.shift();
  if (!tokens.length) return message;

  let cur = message;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (cur[t] == null) cur[t] = typeof tokens[i + 1] === 'number' ? [] : {};
    cur = cur[t];
  }
  const last = tokens[tokens.length - 1];

  switch (patch.o) {
    case 'append': {
      const base = cur[last];
      if (typeof base === 'string' && typeof patch.v === 'string') cur[last] = base + patch.v;
      else if (Array.isArray(base) && Array.isArray(patch.v)) cur[last] = base.concat(patch.v);
      else cur[last] = patch.v;
      break;
    }
    case 'remove':
      if (Array.isArray(cur)) cur.splice(last, 1);
      else delete cur[last];
      break;
    default: // replace / add
      cur[last] = patch.v;
  }
  return message;
}

/**
 * Open one conversation turn.
 *
 * @param {object} params   q, conversation_id, source, speed
 * @param {object} on       { meta, thinking, patch, note, complete, error, done }
 * @returns {() => void}    close
 */
export function openTurn(params, on) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') query.set(k, String(v));
  const es = new EventSource('/api/chat?' + query);
  const json = (fn) => (e) => fn && fn(JSON.parse(e.data));

  es.addEventListener('meta', json(on.meta));
  es.addEventListener('thinking', json(on.thinking));
  es.addEventListener('note', json(on.note));
  es.addEventListener('delta', (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'message_stream_complete') on.complete?.(d.stats);
    else if (!d.type) on.patch?.(d);
  });
  es.addEventListener('error', (e) => {
    if (e.data) on.error?.(JSON.parse(e.data));
  });
  es.onmessage = (e) => {
    if (e.data !== '[DONE]') return;
    es.close();
    on.done?.();
  };
  es.onerror = () => {
    // a dropped connection before [DONE] is a failure, not a reconnect: the turn is gone
    if (es.readyState === EventSource.CLOSED) return;
    es.close();
    on.error?.({ message: '连接中断' });
    on.done?.();
  };
  return () => es.close();
}
