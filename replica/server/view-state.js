'use strict';
/**
 * View state: what the user did to a generated UI, kept server-side so the *next*
 * turn can see it.
 *
 * Mirrors the captured contract (ANALYSIS.md §8):
 *
 *   POST /backend-api/conversation/{cid}/message/{mid}/dil/view_state
 *   { client_session_id, updates: [{ scope: "root", state: {…}, client_update_id }] }
 *   → { status: "success", updated_scopes: n, message_id, conversation_id }
 *
 * `state` keys are the semantic `useState` keys the compiler derived from variable
 * names. On the next turn the latest snapshot of every message is replayed into the
 * model's context as `genui_state_snapshots`, which is how "I switched to the audit
 * tab and filtered for risky events" reaches the model without the user typing it.
 *
 * In-memory only; a real deployment would put this next to the conversation store.
 */

const MAX_STATE_BYTES = 16 * 1024;
const MAX_UPDATE_IDS = 256;
const SCOPE = /^[A-Za-z0-9_:.-]{1,64}$/;

/** Plain JSON only — functions, cycles, NaN and oversize payloads are rejected. */
function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'state must be an object';
  let json;
  try {
    json = JSON.stringify(state);
  } catch {
    return 'state is not serialisable';
  }
  if (json.length > MAX_STATE_BYTES) return 'state too large';
  const roundTrip = JSON.parse(json);
  for (const k of Object.keys(state)) {
    if (!(k in roundTrip)) return `state.${k} is not JSON`;
  }
  return null;
}

function createViewStateStore() {
  // messageId → { conversationId, scopes: Map<scope, {state, updatedAt}>, seen: string[] }
  const messages = new Map();

  function entry(conversationId, messageId) {
    let e = messages.get(messageId);
    if (!e) {
      e = { conversationId, scopes: new Map(), seen: [] };
      messages.set(messageId, e);
    }
    return e;
  }

  return {
    /**
     * Apply a `/dil/view_state` body. Updates are idempotent per `client_update_id`
     * and a scope is only counted as updated when its value actually changed — which
     * is the most plausible reading of the captured `updated_scopes: 0` for a POST
     * that only re-stated the initial values.
     */
    apply(conversationId, messageId, body) {
      if (!body || !Array.isArray(body.updates)) return { error: 'updates[] required' };
      const e = entry(conversationId, messageId);
      let updated = 0;
      for (const u of body.updates) {
        const scope = u && typeof u.scope === 'string' ? u.scope : 'root';
        if (!SCOPE.test(scope)) return { error: `invalid scope ${JSON.stringify(scope)}` };
        const bad = validateState(u.state);
        if (bad) return { error: bad };
        if (u.client_update_id) {
          if (e.seen.includes(u.client_update_id)) continue;
          e.seen.push(u.client_update_id);
          if (e.seen.length > MAX_UPDATE_IDS) e.seen.shift();
        }
        const prev = e.scopes.get(scope);
        const next = JSON.stringify(u.state);
        if (prev && JSON.stringify(prev.state) === next) continue;
        // The first report of a scope establishes a baseline (the initial render), it
        // is not a user change; only subsequent differing reports count.
        if (prev) updated += 1;
        e.scopes.set(scope, { state: JSON.parse(next), updatedAt: Date.now(), initial: !prev });
      }
      return {
        status: 'success',
        updated_scopes: updated,
        message_id: messageId,
        conversation_id: conversationId,
      };
    },

    get(messageId, scope = 'root') {
      const e = messages.get(messageId);
      const s = e && e.scopes.get(scope);
      return s ? s.state : null;
    },

    /**
     * Every snapshot of a conversation, oldest first — the `genui_state_snapshots`
     * field submitted with the next turn.
     */
    snapshots(conversationId) {
      const out = [];
      for (const [messageId, e] of messages) {
        if (e.conversationId !== conversationId) continue;
        for (const [scope, s] of e.scopes) {
          out.push({ message_id: messageId, scope, state: s.state, user_modified: !s.initial, updated_at: s.updatedAt });
        }
      }
      return out;
    },

    clear() {
      messages.clear();
    },
  };
}

/**
 * Render snapshots as a context block for the model. Only scopes the user actually
 * touched are worth the tokens; untouched initial state is what the model wrote.
 */
function snapshotsToContext(snapshots) {
  const touched = snapshots.filter((s) => s.user_modified);
  if (!touched.length) return '';
  const lines = touched.map(
    (s) => `- message ${s.message_id} (scope ${s.scope}): ${JSON.stringify(s.state)}`
  );
  return [
    'genui_state_snapshots — the current state of interfaces you generated earlier in',
    'this conversation, after the user interacted with them. Keys are the useState',
    'variable names you chose. Treat these as facts about what the user is looking at:',
    ...lines,
  ].join('\n');
}

module.exports = { createViewStateStore, snapshotsToContext, validateState, MAX_STATE_BYTES };
