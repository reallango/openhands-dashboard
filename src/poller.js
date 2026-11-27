// Background sync from OpenHands into the local store. Active conversations are polled often, the list
// less often (and even less when nothing is running). Status changes go to the `changes` table and wake
// /api/wait listeners through `bus`.
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { db, q, saveConv } from './db.js';
import { oh } from './openhands.js';
import { summarize } from './summarize.js';

export const bus = new EventEmitter();
bus.setMaxListeners(1000);

export const ACTIVE = new Set(['setting up', 'running', 'waiting', 'stalled']);
export const ALERT = new Set(['finished', 'error', 'stuck', 'waiting', 'stalled']);
const TERMINAL = new Set(['finished', 'error', 'stuck']);

export const health = { lastOk: null, lastError: null, lastErrorAt: null, polls: 0 };

const now = () => Date.now();
const ms = t => (t ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`) : NaN);
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function hasAgentActivity(id) {
  return !!db.prepare("SELECT 1 FROM events WHERE conv_id = ? AND kind = 'ActionEvent' LIMIT 1").get(id);
}

export function deriveStatus(row) {
  const ex = row.execution_status;
  const sb = row.sandbox_status;
  if (sb === 'ERROR' || ex === 'error') return 'error';
  if (ex === 'stuck') return 'stuck';
  if (ex === 'finished') return 'finished';
  if (ex === 'deleting') return 'deleted';
  if (ex === 'waiting_for_confirmation') return 'waiting';
  if (ex === 'paused') return 'paused';
  if (ex === 'running') {
    const last = Math.max(ms(row.updated_at) || 0, ms(row.last_event_at) || 0);
    return last && now() - last > config.stalledMinutes * 60_000 ? 'stalled' : 'running';
  }
  if (sb === 'STARTING') return 'setting up';
  if (ex === 'idle') return hasAgentActivity(row.id) ? 'waiting' : 'setting up';
  if (sb === 'PAUSED' || sb === 'MISSING') return 'paused';
  return 'idle';
}

function record(taskId, what, oldV, newV) {
  q.addChange.run(taskId, now(), what, oldV ?? null, newV ?? null);
}

// Apply a conversation object from the OpenHands API to the store and record what changed.
function applyConv(c, { quiet = false } = {}) {
  const old = q.getConv.get(c.id);
  const prs = JSON.stringify((c.pr_number || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b));
  const fields = {
    title: c.title ?? old?.title ?? null,
    repo: c.selected_repository ?? null,
    branch: c.selected_branch ?? null,
    sandbox_status: c.sandbox_status ?? null,
    execution_status: c.execution_status ?? null,
    pr_numbers: prs,
    cost: c.metrics?.accumulated_cost ?? null,
    model: c.llm_model ?? null,
    ui_url: c.conversation_ui_url || `https://app.all-hands.dev/conversations/${c.id}`,
    created_at: c.created_at ?? null,
    updated_at: c.updated_at ?? null,
    last_polled: now(),
  };
  saveConv(c.id, fields);
  const row = q.getConv.get(c.id);
  let status = deriveStatus(row);
  // A finished sandbox is later paused by OpenHands and reports no execution status; keep the outcome.
  if (status === 'paused' && TERMINAL.has(old?.status)) status = old.status;
  saveConv(c.id, { status });
  if (quiet || !old) {
    if (!old && !quiet) record(c.id, 'status', null, status);
    return { changed: !old, row: q.getConv.get(c.id) };
  }
  let changed = false;
  if (old.status !== status) { record(c.id, 'status', old.status, status); changed = true; }
  const oldPrs = JSON.parse(old.pr_numbers || '[]');
  const newPrs = JSON.parse(prs).filter(n => !oldPrs.includes(n));
  if (newPrs.length) { record(c.id, 'pr', JSON.stringify(oldPrs), JSON.stringify(JSON.parse(prs))); changed = true; }
  return { changed, row: q.getConv.get(c.id) };
}

// Fetch new events for one conversation. Bounded per call; the next call continues from the cursor.
export async function syncEvents(id, maxPages = 10) {
  const row = q.getConv.get(id);
  if (!row) return 0;
  // The filter stays fixed while paging: next_page_id is an offset into this exact query.
  const from = row.events_cursor || undefined;
  let since = from;
  let pageId;
  let added = 0;
  let pages = 0;
  for (;;) {
    const page = await oh.events(id, { since: from, pageId });
    pages++;
    for (const ev of page?.items ?? []) {
      const s = summarize(ev);
      if (ev.timestamp && (!since || ev.timestamp > since)) since = ev.timestamp;
      if (!s) continue;
      const r = q.insertEvent.run(id, s.ev_id, s.ts, s.kind, s.source, s.tool, s.title, s.body, s.is_error);
      added += Number(r.changes);
    }
    pageId = page?.next_page_id;
    if (!pageId || pages >= maxPages) break;
  }
  const { n, last } = q.eventCount.get(id);
  const done = !pageId && !ACTIVE.has(row.status) && now() - (ms(row.updated_at) || 0) > 10 * 60_000 ? 1 : 0;
  saveConv(id, { events_cursor: since ?? null, event_count: n, last_event_at: last ?? row.last_event_at, events_done: done });
  if (added) bus.emit('events', id);
  return added;
}

async function syncStartTasks() {
  const pending = q.pendingTasks.all();
  if (!pending.length) return false;
  let changed = false;
  for (const t of await oh.startTasks(pending.map(p => p.id))) {
    const old = q.getTask.get(t.id);
    q.insertTask.run(t.id, t.app_conversation_id ?? null, t.status ?? null, t.detail ?? null, old?.repo ?? null, old?.branch ?? null,
      old?.title ?? null, t.created_at ?? old?.created_at ?? null, t.updated_at ?? null);
    if (old?.status !== t.status) { record(t.id, 'start', old?.status, t.status); changed = true; }
    if (t.app_conversation_id) {
      saveConv(t.app_conversation_id, { start_task_id: t.id });
      if (t.status === 'READY' && old?.status !== 'READY') record(t.id, 'conversation', null, t.app_conversation_id);
    }
  }
  return changed;
}

function activeIds() {
  const recent = now() - 10 * 60_000;
  return q.allConvs.all()
    .filter(r => ACTIVE.has(r.status) || (r.last_polled && (ms(r.updated_at) || 0) > recent) || q.taskByConv.get(r.id)?.status === 'READY' && !r.status)
    .map(r => r.id);
}

async function syncActive() {
  let changed = await syncStartTasks();
  // Conversations a start task just produced, plus everything still active.
  const ids = new Set(activeIds());
  for (const t of q.allTasks.all()) if (t.conversation_id && !q.getConv.get(t.conversation_id)?.status) ids.add(t.conversation_id);
  for (const part of chunk([...ids], 25)) {
    for (const c of await oh.conversations(part)) {
      const r = applyConv(c);
      changed ||= r.changed;
    }
  }
  for (const id of ids) {
    try {
      await syncEvents(id);
      // Re-derive after events: "idle" becomes "waiting" once the agent has acted, "running" may go "stalled".
      const row = q.getConv.get(id);
      if (!row) continue;
      let st = deriveStatus(row);
      if (st === 'paused' && TERMINAL.has(row.status)) st = row.status;
      if (st !== row.status) { record(id, 'status', row.status, st); saveConv(id, { status: st }); changed = true; }
    } catch (e) { noteError(e); }
  }
  return changed;
}

let listedOnce = false;
async function syncList() {
  let pageId;
  let pages = 0;
  let changed = false;
  const maxPages = listedOnce ? 1 : 4;
  do {
    const page = await oh.search(pageId, 50);
    for (const c of page?.items ?? []) {
      // The first full listing fills the store quietly so old conversations do not raise alerts.
      const r = applyConv(c, { quiet: !listedOnce });
      changed ||= r.changed;
    }
    pageId = page?.next_page_id;
  } while (pageId && ++pages < maxPages);
  listedOnce = true;
  return changed;
}

function noteError(e) {
  health.lastError = String(e.message || e).slice(0, 300);
  health.lastErrorAt = new Date().toISOString();
  console.error(`[poller] ${health.lastError}`);
}

let lastActive = 0;
let lastList = 0;
let running = false;
export function kick() { lastActive = 0; }

async function tick() {
  if (running) return;
  running = true;
  try {
    const t = now();
    const anyActive = activeIds().length > 0 || q.pendingTasks.all().length > 0;
    let changed = false;
    if (t - lastList >= (anyActive ? config.listIntervalSec : config.idleListIntervalSec) * 1000) {
      lastList = t;
      changed = (await syncList()) || changed;
    }
    if (t - lastActive >= config.activeIntervalSec * 1000) {
      lastActive = t;
      changed = (await syncActive()) || changed;
    }
    health.lastOk = new Date().toISOString();
    health.polls++;
    if (changed) bus.emit('change');
  } catch (e) {
    noteError(e);
  } finally {
    running = false;
  }
}

export function startPoller() {
  tick();
  setInterval(tick, 5000).unref?.();
}

// A start task created through /api/start: remember it and poll right away.
export function trackStartTask(task, { repo, branch, title }) {
  q.insertTask.run(task.id, task.app_conversation_id ?? null, task.status ?? 'WORKING', task.detail ?? null, repo, branch, title ?? null,
    task.created_at ?? new Date().toISOString(), task.updated_at ?? null);
  record(task.id, 'start', null, task.status ?? 'WORKING');
  bus.emit('change');
  kick();
}
