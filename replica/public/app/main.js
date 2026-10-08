/**
 * Chat page: composer, thread of turns, developer panel.
 *
 * One conversation per page load (or per "new chat"): view_state reported by earlier
 * turns is replayed into later ones as genui_state_snapshots.
 */
import { Turn } from './turn.js';
import { createDevPanel } from './devpanel.js';

const $ = (id) => document.getElementById(id);
const els = {
  main: $('main'),
  thread: $('thread'),
  empty: $('empty'),
  suggestions: $('suggestions'),
  composer: $('composer'),
  prompt: $('prompt'),
  send: $('send'),
  hint: $('hint'),
  modelChip: $('model-chip'),
  newChat: $('new-chat'),
};

const dev = createDevPanel({
  panel: $('devpanel'),
  tabs: $('dev-tabs'),
  body: $('dev-body'),
  meta: $('dev-meta'),
  toggle: $('dev-toggle'),
  close: $('dev-close'),
});

let conversationId = newConversationId();
let turns = [];

function newConversationId() {
  return 'conv_' + Math.random().toString(36).slice(2, 10);
}

const current = () => turns[turns.length - 1];

function syncComposer() {
  const busy = !!current()?.busy;
  els.composer.classList.toggle('busy', busy);
  els.send.setAttribute('aria-label', busy ? '停止生成' : '发送');
  els.send.disabled = !busy && !els.prompt.value.trim();
  els.empty.hidden = turns.length > 0;
}

function autosize() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = Math.min(els.prompt.scrollHeight, 200) + 'px';
}

/** Keep the newest content in view while streaming, unless the user scrolled up. */
let stickToBottom = true;
window.addEventListener('scroll', () => {
  stickToBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
}, { passive: true });
function followScroll() {
  if (stickToBottom) window.scrollTo({ top: document.body.scrollHeight });
}

function send(prompt, source) {
  if (!prompt || current()?.busy) return;
  const turn = new Turn({
    thread: els.thread,
    prompt,
    source,
    conversationId,
    onChange: (t) => {
      dev.refresh(t);
      if (t === current()) {
        syncComposer();
        followScroll();
      }
    },
    onSelect: (t) => dev.show(t),
  });
  turns.push(turn);
  dev.follow(turn);
  stickToBottom = true;
  syncComposer();
  followScroll();
}

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (current()?.busy) {
    current().stop();
    syncComposer();
    return;
  }
  const prompt = els.prompt.value.trim();
  els.prompt.value = '';
  autosize();
  send(prompt);
});

els.prompt.addEventListener('input', () => {
  autosize();
  syncComposer();
});
els.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

els.suggestions.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-prompt]');
  if (b) send(b.dataset.prompt, b.dataset.source);
});

els.newChat.addEventListener('click', () => {
  turns.forEach((t) => t.destroy());
  turns = [];
  conversationId = newConversationId();
  dev.follow(null);
  syncComposer();
  els.prompt.focus();
});

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    if (h.agent === 'mock') {
      els.modelChip.textContent = 'mock agent';
      els.hint.textContent = '当前是 mock agent，会回放固定示例；配置 DIL_LLM_* 环境变量即可接入真实模型。';
    } else {
      els.modelChip.textContent = h.model + (h.thinking ? ' · 思考' : '');
    }
  })
  .catch(() => {
    els.modelChip.textContent = '未连接';
  });

syncComposer();
els.prompt.focus();
