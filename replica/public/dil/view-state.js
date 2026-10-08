/**
 * View-state reporting: keyed sandbox state → `POST …/dil/view_state`.
 *
 * Rapid changes (typing, dragging a slider) collapse into one request carrying the
 * latest full state. The server dedupes by `client_update_id` and counts only real
 * changes; the next turn replays the snapshot to the model.
 */

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** One id per page load, like the captured `client_session_id`. */
export const CLIENT_SESSION_ID = uuid();

/**
 * @param {object} o
 * @param {() => ({conversationId, messageId} | null)} o.target  null until ids are known
 * @param {number} [o.delayMs]
 * @param {(body, response) => void} [o.onReport]
 * @param {(error) => void} [o.onError]
 */
export function createStateReporter({ target, delayMs = 600, onReport, onError }) {
  let pending = null;
  let timer = null;

  async function flush() {
    timer = null;
    const ids = target();
    if (!pending || !ids) return null; // retried by the caller once ids are known
    const { scope, state } = pending;
    pending = null;
    const body = { client_session_id: CLIENT_SESSION_ID, updates: [{ scope, state, client_update_id: uuid() }] };
    const url = `/api/conversation/${encodeURIComponent(ids.conversationId)}/message/${encodeURIComponent(ids.messageId)}/dil/view_state`;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      onReport?.(body, json);
      return json;
    } catch (err) {
      onError?.(err);
      return null;
    }
  }

  return {
    queue(state, scope = 'root') {
      pending = { scope, state };
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    flush,
    get hasPending() {
      return !!pending;
    },
    cancel() {
      clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
