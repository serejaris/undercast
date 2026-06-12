// OBS overlay server: serves the ticker page, holds state, pushes updates via SSE.
// Zero dependencies — node server.mjs
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './lib/config.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
mkdirSync(config.stateDir, { recursive: true });
const STATE_FILE = join(config.stateDir, 'state.json');
// one-time migration from the legacy in-repo location; the source is then marked
// .migrated so a future empty state dir does not silently inherit it again
const LEGACY_STATE_FILE = join(ROOT, 'state.json');
if (config.stateDirIsDefault && !existsSync(STATE_FILE) && existsSync(LEGACY_STATE_FILE)) {
  copyFileSync(LEGACY_STATE_FILE, STATE_FILE);
  renameSync(LEGACY_STATE_FILE, `${LEGACY_STATE_FILE}.migrated`);
  console.log(`migrated state.json to ${STATE_FILE} (legacy file renamed to state.json.migrated)`);
}
const PORT = config.port;
const MAX_PER_TYPE = { news: 5, chat: 5 }; // keep the line readable

const DEFAULT_STATE = {
  label: 'stream',
  items: [{ type: 'note', text: 'undercast is live — try: undercast ticker set "hello"' }],
  speed: 90, // px per second
  visible: true,
  screen: { mode: 'off', title: '', sub: '', until: null, since: null },
  plan: null, // { steps: [{text, status: pending|current|done, started_at, done_at}], started_at }
  mode: 'off', // 'plan' | 'message' | 'off' — off keeps the legacy flat ribbon
  queue: [], // FIFO of not-yet-shown chat messages {author, text, ts}
  message: null, // message on screen right now {author, text, shown_at}
};

let state = loadState();
const sseClients = new Set();
let flashSeq = 0; // invalidates pending flash auto-off when a newer screen mode arrives
let msgSeq = 0; // invalidates pending message-advance timers when mode changes or a newer message starts
const TYPE_MS_PER_CHAR = 35; // client typing speed — contract with ticker.html
const QUEUE_CAP = 10;

// prompt widget: transient, deliberately not persisted — a prompt is a moment, not state
let lastPrompt = null; // { text, ts }
const promptClients = new Set();

function broadcastPrompt() {
  const payload = `event: prompt\ndata: ${JSON.stringify(lastPrompt)}\n\n`;
  for (const res of promptClients) res.write(payload);
}

// items are {type: 'now'|'news'|'chat'|'note', text}; bare strings become notes
function normalizeItem(it) {
  if (typeof it === 'string') return { type: 'note', text: it };
  if (it && typeof it.text === 'string' && it.text) {
    const type = ['now', 'news', 'chat', 'note'].includes(it.type) ? it.type : 'note';
    return { type, text: it.text };
  }
  return null;
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const s = { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
      s.items = (s.items || []).map(normalizeItem).filter(Boolean);
      if (!['plan', 'message', 'off'].includes(s.mode)) s.mode = 'off';
      s.queue = Array.isArray(s.queue)
        ? s.queue.filter((m) => m && typeof m.text === 'string' && m.text)
        : [];
      // an in-flight message was already on screen — count it as shown
      if (s.mode === 'message') s.mode = 'plan';
      s.message = null;
      return s;
    } catch {
      // corrupted state file — fall back to defaults
    }
  }
  return structuredClone(DEFAULT_STATE);
}

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// pull the next queued message on screen; a timer advances the queue once the
// client has typed it out (TYPE_MS_PER_CHAR per char) plus an 8s hold
function showNext() {
  const next = state.queue.shift();
  if (!next) return;
  state.message = { author: next.author, text: next.text, shown_at: Date.now() };
  state.mode = 'message';
  saveState();
  broadcast();
  const displayLen = ((next.author ? `${next.author}: ` : '') + next.text).length;
  const token = ++msgSeq;
  setTimeout(() => {
    if (state.mode !== 'message' || msgSeq !== token) return;
    if (state.queue.length) {
      showNext();
    } else {
      state.message = null;
      state.mode = 'plan';
      saveState();
      broadcast();
    }
  }, displayLen * TYPE_MS_PER_CHAR + 8000);
}

function capByType(items) {
  const seen = {};
  // walk from the end so the freshest entries of each capped type survive
  const kept = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const cap = MAX_PER_TYPE[it.type];
    seen[it.type] = (seen[it.type] || 0) + 1;
    if (!cap || seen[it.type] <= cap) kept.unshift(it);
  }
  return kept;
}

function apply(patch) {
  if (typeof patch.label === 'string') state.label = patch.label;
  if (typeof patch.speed === 'number' && patch.speed > 0) state.speed = patch.speed;
  if (typeof patch.visible === 'boolean') state.visible = patch.visible;
  if (Array.isArray(patch.items)) state.items = patch.items.map(normalizeItem).filter(Boolean);
  state.items = capByType(state.items);
  saveState();
  broadcast();
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;
  console.log(`${new Date().toISOString().slice(11, 19)} ${route}`);

  try {
    if (route === 'GET /' || route === 'GET /ticker') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(join(ROOT, 'public', 'ticker.html')));
      return;
    }

    if (route === 'GET /state') return json(res, 200, state);

    if (route === 'GET /screens') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(join(ROOT, 'public', 'screens.html')));
      return;
    }

    // full-screen interstitials: start countdown / brb / end / flash (transient) / off
    if (route === 'POST /screen') {
      const body = await readBody(req);
      if (!['off', 'start', 'brb', 'end', 'flash'].includes(body.mode)) {
        return json(res, 400, { error: 'mode must be off|start|brb|end|flash' });
      }
      const minutes = Number(body.minutes);
      state.screen = {
        mode: body.mode,
        title: String(body.title || ''),
        sub: String(body.sub || ''),
        until: body.until ? Number(body.until) : minutes > 0 ? Date.now() + minutes * 60000 : null,
        since: Date.now(),
      };
      if (body.mode === 'flash') {
        const seconds = Number(body.seconds) > 0 ? Number(body.seconds) : 8;
        const token = ++flashSeq;
        setTimeout(() => {
          if (state.screen.mode === 'flash' && flashSeq === token) {
            state.screen = { mode: 'off', title: '', sub: '', until: null, since: Date.now() };
            saveState();
            broadcast();
          }
        }, seconds * 1000);
      }
      saveState();
      broadcast();
      return json(res, 200, state.screen);
    }

    // stream plan: steps with done/current/pending + timestamps for later export
    if (route === 'POST /plan') {
      const body = await readBody(req);
      const steps = (body.steps || []).map(String).filter(Boolean);
      if (!steps.length) {
        state.plan = null;
      } else {
        const now = Date.now();
        state.plan = {
          started_at: now,
          steps: steps.map((text, i) => ({
            text,
            status: i === 0 ? 'current' : 'pending',
            started_at: i === 0 ? now : null,
            done_at: null,
          })),
        };
      }
      saveState();
      broadcast();
      return json(res, 200, state.plan ?? {});
    }

    if (route === 'POST /plan/current') {
      const body = await readBody(req);
      const i = Number(body.index);
      if (!state.plan || !(i >= 0 && i < state.plan.steps.length)) {
        return json(res, 400, { error: 'no plan or index out of range' });
      }
      const now = Date.now();
      state.plan.steps.forEach((s, k) => {
        if (k < i) {
          if (s.status !== 'done') {
            s.status = 'done';
            s.started_at ??= state.plan.started_at;
            s.done_at ??= now;
          }
        } else if (k === i) {
          s.status = 'current';
          s.started_at ??= now;
          s.done_at = null;
        } else {
          s.status = 'pending';
        }
      });
      saveState();
      broadcast();
      return json(res, 200, state.plan);
    }

    if (route === 'POST /plan/done') {
      if (!state.plan) return json(res, 400, { error: 'no plan' });
      const now = Date.now();
      const cur = state.plan.steps.findIndex((s) => s.status === 'current');
      if (cur === -1) return json(res, 400, { error: 'no current step' });
      state.plan.steps[cur].status = 'done';
      state.plan.steps[cur].done_at = now;
      const next = state.plan.steps[cur + 1];
      if (next) {
        next.status = 'current';
        next.started_at ??= now;
      }
      saveState();
      broadcast();
      return json(res, 200, state.plan);
    }

    // auto-history: close the current step, open a new one (companion drives this from the live transcript)
    if (route === 'POST /plan/append') {
      const body = await readBody(req);
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { error: 'text required' });
      const now = Date.now();
      if (!state.plan) state.plan = { started_at: now, steps: [] };
      const cur = state.plan.steps.find((s) => s.status === 'current');
      if (cur) {
        cur.status = 'done';
        cur.done_at = now;
      }
      state.plan.steps.push({ text, status: 'current', started_at: now, done_at: null });
      saveState();
      broadcast();
      return json(res, 200, state.plan);
    }

    if (route === 'GET /plan/export') {
      if (!state.plan) return json(res, 400, { error: 'no plan' });
      const fmtOffset = (ms) => {
        const s = Math.max(0, Math.round((ms - state.plan.started_at) / 1000));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
      };
      const format = url.searchParams.get('format') || 'chapters';
      let out;
      if (format === 'chapters') {
        // YouTube chapters: offset from plan start
        out = state.plan.steps
          .filter((s) => s.started_at)
          .map((s) => `${fmtOffset(s.started_at)} ${s.text}`)
          .join('\n');
      } else {
        out = state.plan.steps
          .map((s) => {
            const mark = s.status === 'done' ? 'x' : ' ';
            const span = s.started_at
              ? ` (${fmtOffset(s.started_at)}${s.done_at ? `–${fmtOffset(s.done_at)}` : '–…'})`
              : '';
            return `- [${mark}] ${s.text}${span}`;
          })
          .join('\n');
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(out + '\n');
      return;
    }

    if (route === 'GET /prompt-widget') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(join(ROOT, 'public', 'prompt-widget.html')));
      return;
    }

    if (route === 'GET /prompt') return json(res, 200, lastPrompt ?? {});

    if (route === 'GET /prompt-events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // replay last prompt with its ts — the client decides whether it is stale
      res.write(`event: prompt\ndata: ${JSON.stringify(lastPrompt)}\n\n`);
      promptClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        promptClients.delete(res);
      });
      return;
    }

    if (route === 'POST /prompt') {
      const body = await readBody(req);
      lastPrompt = body.text ? { text: String(body.text), ts: Date.now() } : null;
      broadcastPrompt();
      return json(res, 200, lastPrompt ?? {});
    }

    if (route === 'GET /events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    if (route === 'POST /set') {
      const body = await readBody(req);
      apply({ items: body.items ?? (body.text != null ? [body.text] : undefined), visible: true });
      return json(res, 200, state);
    }

    if (route === 'POST /add') {
      const body = await readBody(req);
      if (body.text == null) return json(res, 400, { error: 'text required' });
      apply({ items: [...state.items, { type: body.type, text: String(body.text) }] });
      return json(res, 200, state);
    }

    // "what we are doing right now" — single slot, replace semantics
    if (route === 'POST /now') {
      const body = await readBody(req);
      const rest = state.items.filter((it) => it.type !== 'now');
      const items = body.text
        ? [{ type: 'now', text: String(body.text) }, ...rest]
        : rest;
      apply({ items, visible: true });
      return json(res, 200, state);
    }

    if (route === 'POST /news') {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'text required' });
      apply({ items: [...state.items, { type: 'news', text: String(body.text) }] });
      return json(res, 200, state);
    }

    if (route === 'POST /chat') {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'text required' });
      if (state.mode === 'off') {
        // legacy behavior: chat goes straight into the flat ribbon
        const text = body.author ? `${body.author}: ${body.text}` : String(body.text);
        apply({ items: [...state.items, { type: 'chat', text }] });
        return json(res, 200, state);
      }
      // modes on: messages go to the FIFO queue, not the ribbon
      state.queue.push({ author: String(body.author || ''), text: String(body.text), ts: Date.now() });
      while (state.queue.length > QUEUE_CAP) state.queue.shift(); // drop oldest
      if (state.message === null) {
        showNext(); // saves + broadcasts
      } else {
        saveState();
        broadcast();
      }
      return json(res, 200, state);
    }

    // manual mode switch: plan (modes on) | off (legacy flat ribbon)
    if (route === 'POST /mode') {
      const body = await readBody(req);
      if (!['plan', 'off'].includes(body.mode)) {
        return json(res, 400, { error: 'mode must be plan|off' });
      }
      msgSeq++; // orphan any pending message-advance timer
      state.message = null;
      state.mode = body.mode;
      if (body.mode === 'off') state.queue = [];
      if (state.mode === 'plan' && state.queue.length) {
        showNext(); // saves + broadcasts
      } else {
        saveState();
        broadcast();
      }
      return json(res, 200, { mode: state.mode });
    }

    if (route === 'POST /clear') {
      const body = await readBody(req);
      const items = body.type ? state.items.filter((it) => it.type !== body.type) : [];
      if (!body.type || body.type === 'chat') {
        // clearing chat also drops the message queue and whatever is on screen
        msgSeq++; // orphan any pending message-advance timer
        state.queue = [];
        state.message = null;
        if (state.mode === 'message') state.mode = 'plan';
      }
      apply({ items });
      return json(res, 200, state);
    }

    if (route === 'POST /config') {
      apply(await readBody(req));
      return json(res, 200, state);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`undercast: http://127.0.0.1:${PORT}/ticker`);
  // resume queued messages that survived a restart
  if (state.mode !== 'off' && state.queue.length) showNext();
});
