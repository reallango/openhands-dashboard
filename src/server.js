// OpenHands dashboard: HTTP server, web UI and the token-protected API for Claude.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, checkConfig } from './config.js';
import { q } from './db.js';
import { oh } from './openhands.js';
import { createMcp } from './mcp.js';
import { ACTIVE, ALERT, bus, health, refreshSoon, startPoller, syncEvents, trackStartTask } from './poller.js';
import {
  COOKIE, createSession, destroySession, getSession, loginBlockedFor, noteLoginFailure, noteLoginSuccess,
  parseCookies, safeEqual, sessionCookie, validHashFormat, verifyPassword,
} from './auth.js';

const missing = checkConfig();
if (missing.length) {
  console.error(`Missing or invalid configuration:\n  - ${missing.join('\n  - ')}\nSee .env.example and the README.`);
  process.exit(1);
}
if (!validHashFormat(config.adminPasswordHash)) {
  console.error('ADMIN_PASSWORD_HASH is not in the expected format (scrypt:N:r:p:salt:hash). Create one with: node scripts/hash-password.js');
  process.exit(1);
}

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/login': ['login.html', 'text/html; charset=utf-8', false],
  '/': ['index.html', 'text/html; charset=utf-8', true],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8', false],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8', false],
  '/style.css': ['style.css', 'text/css; charset=utf-8', false],
  '/icon.svg': ['icon.svg', 'image/svg+xml', false],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}
const text = (res, status, body) => send(res, status, body.endsWith('\n') ? body : `${body}\n`, 'text/plain; charset=utf-8');
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

// Same-origin check for browser requests that change state (defence in depth next to the CSRF token).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// Who is calling: { kind: 'token' } for Claude, { kind: 'session', session } for the browser, or null.
function identify(req) {
  const auth = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(auth)) {
    return safeEqual(auth.replace(/^Bearer\s+/i, '').trim(), config.apiToken) ? { kind: 'token' } : { kind: 'bad-token' };
  }
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const session = getSession(token);
  return session ? { kind: 'session', session, token } : null;
}

// ---------- formatting ----------
const ms = t => (t ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`) : NaN);
function ago(t) {
  const v = ms(t);
  if (!Number.isFinite(v)) return '-';
  const s = Math.max(0, Math.round((Date.now() - v) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function convView(r) {
  const prs = JSON.parse(r.pr_numbers || '[]');
  const task = r.start_task_id ? q.getTask.get(r.start_task_id) : null;
  return {
    id: r.id,
    start_task_id: r.start_task_id,
    title: r.title || '(untitled)',
    repo: r.repo,
    branch: r.branch,
    status: r.status || 'setting up',
    execution_status: r.execution_status,
    sandbox_status: r.sandbox_status,
    prs,
    pr_urls: r.repo ? prs.map(n => `https://github.com/${r.repo}/pull/${n}`) : [],
    ui_url: r.ui_url,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_event_at: r.last_event_at,
    last_activity: [r.last_event_at, r.updated_at].filter(Boolean).sort((a, b) => ms(b) - ms(a))[0] || r.created_at,
    event_count: r.event_count,
    cost: r.cost,
    model: r.model,
    last_step: q.lastEvent.get(r.id)?.title ?? null,
    start_status: task?.status ?? null,
  };
}

function taskView(t) {
  return {
    id: `task:${t.id}`,
    start_task_id: t.id,
    title: t.title || '(starting)',
    repo: t.repo,
    branch: t.branch,
    status: t.status === 'ERROR' ? 'error' : 'setting up',
    start_status: t.status,
    detail: t.detail,
    prs: [],
    pr_urls: [],
    created_at: t.created_at,
    updated_at: t.updated_at,
    last_activity: t.updated_at || t.created_at,
  };
}

// Pending start tasks (no conversation yet) plus all conversations, newest activity first.
function allTasks() {
  const convs = q.allConvs.all().map(convView);
  const pending = q.allTasks.all().filter(t => !t.conversation_id || !q.getConv.get(t.conversation_id)).map(taskView);
  return [...pending, ...convs].sort((a, b) => (ms(b.last_activity) || 0) - (ms(a.last_activity) || 0));
}

function line(v) {
  const pr = v.prs?.length ? ` PR#${v.prs.join(',#')}` : '';
  const where = v.repo ? ` ${v.repo}@${v.branch || '?'}` : '';
  const start = v.status === 'setting up' && v.start_status && v.start_status !== 'READY' ? ` (${v.start_status})` : '';
  const last = v.last_step && ACTIVE.has(v.status) ? ` | ${v.last_step.slice(0, 90)}` : '';
  const err = v.detail && v.status === 'error' ? ` | ${String(v.detail).slice(0, 120)}` : '';
  return `${v.id} ${v.status}${start} ${ago(v.last_activity)}${where}${pr} "${String(v.title).slice(0, 70)}"${last}${err}`;
}

// ---------- lookups for /api/wait ----------
function resolveId(raw) {
  const id = String(raw).trim().replace(/^task:/, '');
  if (!id) return null;
  const task = q.getTask.get(id);
  if (task) return { taskId: task.id, convId: task.conversation_id };
  if (q.getConv.get(id)) return { convId: id, taskId: q.taskByConv.get(id)?.id };
  if (id.length >= 8) {
    const c = q.allConvs.all().find(r => r.id.startsWith(id));
    if (c) return { convId: c.id, taskId: c.start_task_id };
    const t = q.allTasks.all().find(r => r.id.startsWith(id));
    if (t) return { taskId: t.id, convId: t.conversation_id };
  }
  return { unknown: id };
}

function viewFor(ref) {
  if (ref.unknown) return { id: ref.unknown, status: 'unknown', title: 'not known to the dashboard yet', prs: [] };
  const convId = ref.convId || (ref.taskId && q.getTask.get(ref.taskId)?.conversation_id);
  const c = convId && q.getConv.get(convId);
  if (c) return convView(c);
  const t = ref.taskId && q.getTask.get(ref.taskId);
  return t ? taskView(t) : { id: ref.taskId || ref.convId, status: 'unknown', title: '', prs: [] };
}

function isAlertChange(ch) {
  if (ch.what === 'status') return ALERT.has(ch.new);
  if (ch.what === 'pr') return true;
  if (ch.what === 'start') return ch.new === 'ERROR';
  return false;
}

function matchingChanges(refs, since) {
  const ids = new Set();
  for (const r of refs) {
    if (r.unknown) ids.add(r.unknown);
    if (r.taskId) ids.add(r.taskId);
    const convId = r.convId || (r.taskId && q.getTask.get(r.taskId)?.conversation_id);
    if (convId) ids.add(convId);
  }
  return q.changesSince.all(since).filter(ch => isAlertChange(ch) && (!refs.length || ids.has(ch.task_id)));
}

function describeChange(ch) {
  const ref = resolveId(ch.task_id);
  const v = viewFor(ref);
  if (ch.what === 'pr') {
    const added = JSON.parse(ch.new || '[]').filter(n => !JSON.parse(ch.old || '[]').includes(n));
    return `${v.id} PR opened #${added.join(',#')} "${String(v.title).slice(0, 70)}"`;
  }
  if (ch.what === 'start') return `${v.id} start failed${v.detail ? `: ${String(v.detail).slice(0, 150)}` : ''}`;
  return `${v.id} ${ch.old || 'new'} -> ${ch.new} "${String(v.title).slice(0, 70)}"`;
}

// ---------- core operations (shared by the HTTP API and the MCP endpoint) ----------
class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function summaryText({ all = false } = {}) {
  const cutoff = Date.now() - config.recentHours * 3_600_000;
  // Active tasks, outcomes (finished, error, ...) from the last RECENT_HOURS, and anything else touched in the last 2 hours.
  const quietCutoff = Date.now() - 2 * 3_600_000;
  const items = allTasks().filter(v => all || ACTIVE.has(v.status)
    || ((ms(v.last_activity) || 0) > cutoff && !['paused', 'idle', 'deleted'].includes(v.status))
    || (ms(v.last_activity) || 0) > quietCutoff);
  const cursor = q.maxChange.get().seq;
  const lines = items.map(line);
  const stale = health.lastErrorAt && (!health.lastOk || health.lastErrorAt > health.lastOk) ? `\nWARNING poller: ${health.lastError}` : '';
  return { cursor, items, text: `${lines.length ? lines.join('\n') : 'no active or recent tasks'}\ncursor=${cursor}${stale}` };
}

// Resolves when one of the tasks reaches an alert state (or on timeout / abort).
function waitFor({ ids = [], timeoutSec = 600, since } = {}, signal) {
  const refs = ids.map(resolveId);
  const timeout = Math.min(Math.max(Number(timeoutSec) || 600, 1), 1800) * 1000;
  const hasSince = since != null && since !== '';
  const from = hasSince ? Number(since) || 0 : q.maxChange.get().seq;

  const result = (reason, changes) => {
    const cursor = q.maxChange.get().seq;
    const views = refs.map(viewFor);
    const head = reason === 'timeout' ? 'timeout (no change)' : reason === 'aborted' ? 'aborted'
      : changes.length ? changes.map(c => `changed: ${describeChange(c)}`).join('\n') : `already ${reason}`;
    return { reason, cursor, changes: changes.map(describeChange), tasks: views, text: `${head}\ncursor=${cursor}${views.length ? `\n${views.map(line).join('\n')}` : ''}` };
  };

  // Without `since`, a task that is already in an alert state answers at once, so a wait never hangs on a finished task.
  if (!hasSince && refs.length) {
    const done = refs.map(viewFor).filter(v => ALERT.has(v.status));
    if (done.length) return Promise.resolve(result(done.map(v => v.status).join(','), []));
  }
  const now = matchingChanges(refs, from);
  if (now.length) return Promise.resolve(result('changed', now));

  return new Promise(resolve => {
    let finished = false;
    const finish = (reason, ch) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      bus.off('change', check);
      signal?.removeEventListener('abort', onAbort);
      resolve(result(reason, ch));
    };
    const check = () => { const ch = matchingChanges(refs, from); if (ch.length) finish('changed', ch); };
    const onAbort = () => finish('aborted', []);
    const timer = setTimeout(() => finish('timeout', []), timeout);
    bus.on('change', check);
    signal?.addEventListener('abort', onAbort);
  });
}

const lastOnDemand = new Map();
async function eventsData(rawId, { since, limit = 200, full = false } = {}) {
  const id = resolveId(rawId)?.convId || rawId;
  const conv = q.getConv.get(id);
  if (!conv) throw new UserError('Unknown conversation (a start task that is still setting up has no steps yet)', 404);
  // Conversations the poller is not following (old or finished) are filled in when someone looks at them.
  if (!conv.events_done && !ACTIVE.has(conv.status) && Date.now() - (lastOnDemand.get(id) || 0) > 15_000) {
    lastOnDemand.set(id, Date.now());
    try { await syncEvents(id, 30); } catch (e) { console.error(`[events] ${e.message}`); }
  }
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const hasSince = since != null && since !== '';
  const rows = hasSince ? q.eventsSince.all(id, Number(since) || 0, n) : q.eventsTail.all(id, n);
  const cursor = rows.length ? rows[rows.length - 1].seq : Number(since) || 0;
  const view = convView(q.getConv.get(id));
  const out = rows.map(r => {
    const time = (r.ts || '').slice(11, 19);
    const body = r.body ? (full ? r.body : r.body.slice(0, 300).replace(/\s+/g, ' ')) : '';
    return `#${r.seq} ${time} ${r.is_error ? '!! ' : ''}${r.title}${body ? `\n    ${body}` : ''}`;
  });
  return { conversation: view, cursor, items: rows, text: `${line(view)}\n${out.join('\n') || '(no steps yet)'}\ncursor=${cursor}` };
}

async function startTask(body = {}) {
  const repo = String(body.repo || body.repository || config.defaultRepo || '').trim();
  const branch = String(body.branch || config.defaultBranch).trim();
  const brief = String(body.brief || body.text || '').trim();
  const title = body.title ? String(body.title).trim().slice(0, 200) : undefined;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UserError('repo must look like owner/name');
  if (!/^[\w./-]{1,200}$/.test(branch)) throw new UserError('branch is not valid');
  if (!brief || brief.length > 200_000) throw new UserError('brief is required (max 200000 characters)');
  let task;
  try { task = await oh.start({ repo, branch, brief, title }); } catch (e) { throw new UserError(e.message, 502); }
  if (!task?.id) throw new UserError('OpenHands did not return a start task', 502);
  trackStartTask(task, { repo, branch, title });
  return { start_task_id: task.id, status: task.status, conversation_id: task.app_conversation_id ?? null, repo, branch };
}

async function sendMessage(rawId, text) {
  const ref = resolveId(rawId);
  if (ref?.taskId && !ref.convId) throw new UserError('That start task has no conversation yet', 409);
  const id = ref?.convId || ref?.unknown;
  if (!id) throw new UserError('Unknown conversation', 404);
  const msg = typeof text === 'string' ? text : '';
  if (!msg.trim() || msg.length > 200_000) throw new UserError('text is required (max 200000 characters)');
  let r;
  try { r = await oh.sendMessage(id, msg); } catch (e) { throw new UserError(e.message, 502); }
  refreshSoon(id);
  return { conversation_id: r.conversation_id, resumed: !!r.resumed, cursor: q.maxChange.get().seq };
}

// ---------- HTTP API handlers ----------
const wantsJson = url => url.searchParams.get('format') === 'json';
const sendErr = (res, e) => { if (e instanceof UserError) return fail(res, e.status, e.message); throw e; };

function summary(req, res, url) {
  const r = summaryText({ all: url.searchParams.get('all') === '1' });
  return wantsJson(url) ? send(res, 200, { cursor: r.cursor, items: r.items }) : text(res, 200, r.text);
}

async function wait(req, res, url) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const r = await waitFor({
    ids: (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean),
    timeoutSec: url.searchParams.get('timeout'),
    since: url.searchParams.get('since'),
  }, ac.signal);
  if (r.reason === 'aborted' || res.destroyed) return;
  const { text: body, ...json } = r;
  return wantsJson(url) ? send(res, 200, json) : text(res, 200, body);
}

async function events(req, res, url, id) {
  try {
    const r = await eventsData(id, { since: url.searchParams.get('since'), limit: url.searchParams.get('limit'), full: url.searchParams.get('full') === '1' });
    const { text: body, ...json } = r;
    return wantsJson(url) ? send(res, 200, json) : text(res, 200, body);
  } catch (e) { return sendErr(res, e); }
}

async function start(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return fail(res, e.status || 400, e.status ? e.message : 'Body must be JSON'); }
  try { send(res, 200, await startTask(body)); } catch (e) { return sendErr(res, e); }
}

async function message(req, res, id) {
  let body;
  try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch (e) { return fail(res, e.status || 400, e.status ? e.message : 'Body must be JSON'); }
  try { send(res, 200, await sendMessage(id, body?.text)); } catch (e) { return sendErr(res, e); }
}

async function login(req, res) {
  if (!sameOrigin(req)) return fail(res, 403, 'Cross-origin request refused');
  const ip = req.socket.remoteAddress || '?';
  const blocked = loginBlockedFor(ip);
  if (blocked) return fail(res, 429, `Too many failed attempts. Try again in ${Math.ceil(blocked / 1000)} s.`);
  let raw;
  try { raw = await readBody(req, 16 * 1024); } catch (e) { return fail(res, e.status || 400, e.message); }
  let user; let password;
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { ({ user, password } = JSON.parse(raw)); } catch { return fail(res, 400, 'Bad JSON'); }
  } else {
    const p = new URLSearchParams(raw);
    user = p.get('user');
    password = p.get('password');
  }
  const ok = safeEqual(String(user || ''), config.adminUser) & verifyPassword(String(password || ''), config.adminPasswordHash);
  if (!ok) {
    noteLoginFailure(ip);
    console.warn(`[auth] failed login from ${ip}`);
    return fail(res, 401, 'Wrong user name or password');
  }
  noteLoginSuccess(ip);
  const s = createSession();
  send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sessionCookie(s.token, config.sessionDays * 86400) });
}

// ---------- MCP ----------
const mcp = createMcp({
  summary: summaryText,
  wait: waitFor,
  steps: eventsData,
  start: startTask,
  send: sendMessage,
});

// The MCP endpoint takes only the API token (no browser session, so no CSRF exposure) and refuses cross-origin
// browser requests (DNS rebinding protection, as the MCP specification asks).
async function mcpEndpoint(req, res, who) {
  if (!sameOrigin(req)) return fail(res, 403, 'Cross-origin request refused');
  if (who?.kind !== 'token') {
    return send(res, 401, { error: who?.kind === 'bad-token' ? 'Invalid API token' : 'Authorization: Bearer <API_TOKEN> required' }, undefined, { 'WWW-Authenticate': 'Bearer' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'This MCP endpoint only takes POST (no server-sent event stream)' }, undefined, { Allow: 'POST' });
  let raw;
  try { raw = await readBody(req, 1024 * 1024); } catch (e) { return fail(res, e.status || 400, e.message); }
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const sseOk = String(req.headers.accept || '').includes('text/event-stream');
  const openStream = sseOk ? () => {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    return { send: obj => { if (!res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`); } };
  } : undefined;
  const { status, body, stream } = await mcp.handlePost(raw, ac.signal, { openStream });
  if (res.destroyed) return;
  if (stream) { if (body) stream.send(body); return res.end(); }
  if (!body) { res.writeHead(202, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' }); return res.end(); }
  send(res, status, body);
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const method = req.method === 'HEAD' ? 'GET' : req.method; // Node leaves out the body of a HEAD reply

  if (p === '/healthz') return text(res, 200, 'ok');

  if (method === 'GET' && STATIC[p] && !STATIC[p][2]) {
    const [file, type] = STATIC[p];
    return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), type);
  }
  if (p === '/login' && method === 'POST') return login(req, res);
  // No OAuth here: MCP clients that probe for it get a plain 404 instead of the login redirect.
  if (p.startsWith('/.well-known/')) return fail(res, 404, 'Not found');

  const who = identify(req);
  if (p === '/mcp') return mcpEndpoint(req, res, who);
  if (who?.kind === 'bad-token') return fail(res, 401, 'Invalid API token');
  if (!who) {
    if (p.startsWith('/api/')) return fail(res, 401, 'Login or API token required');
    res.writeHead(302, { ...SECURITY_HEADERS, Location: '/login', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (who.kind === 'token' && !p.startsWith('/api/')) return fail(res, 403, 'The API token only works for /api/ and /mcp');

  // Browser requests that change state need the session's CSRF token and a same-origin request.
  if (who.kind === 'session' && !['GET', 'HEAD'].includes(method)) {
    const header = req.headers['x-csrf-token'];
    if (!sameOrigin(req) || !header || !safeEqual(header, who.session.csrf)) return fail(res, 403, 'CSRF check failed');
  }

  if (method === 'GET' && p === '/') return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8');
  if (method === 'POST' && p === '/logout') {
    destroySession(who.token);
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (method === 'GET' && p === '/api/me') {
    return send(res, 200, who.kind === 'session' ? { user: config.adminUser, csrf: who.session.csrf, defaultRepo: config.defaultRepo, defaultBranch: config.defaultBranch } : { user: 'api-token' });
  }
  if (method === 'GET' && p === '/api/summary') return summary(req, res, url);
  if (method === 'GET' && p === '/api/wait') return wait(req, res, url);
  if (method === 'GET' && p === '/api/health') return send(res, 200, health);
  if (method === 'GET' && p === '/api/conversations') {
    const since = Number(url.searchParams.get('since')) || 0;
    const cursor = q.maxChange.get().seq;
    const alerts = since ? q.changesSince.all(since).filter(isAlertChange).map(ch => ({ seq: ch.seq, id: ch.task_id, text: describeChange(ch), what: ch.what, status: ch.new })) : [];
    return send(res, 200, { cursor, items: allTasks(), alerts, health });
  }
  // A conversation id, a start-task id, or a prefix of 8+ characters of either.
  const convIdOf = raw => { const r = resolveId(raw); return r?.convId || raw; };
  let m = p.match(/^\/api\/conversations\/([\w-]{8,64})\/events$/);
  if (m && method === 'GET') return events(req, res, url, convIdOf(m[1]));
  m = p.match(/^\/api\/conversations\/([\w-]{8,64})\/messages$/);
  if (m && method === 'POST') return message(req, res, m[1]);
  m = p.match(/^\/api\/conversations\/([\w-]{8,64})$/);
  if (m && method === 'GET') {
    const c = q.getConv.get(convIdOf(m[1]));
    return c ? send(res, 200, convView(c)) : fail(res, 404, 'Unknown conversation');
  }
  if (method === 'POST' && p === '/api/start') return start(req, res);
  fail(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(`[http] ${req.method} ${req.url.split('?')[0]}: ${e.message}`);
    if (!res.headersSent) fail(res, 500, 'Internal error');
  });
});
server.requestTimeout = 60_000; // receiving the request; long-poll responses are not limited by this
server.listen(config.port, () => {
  console.log(`OpenHands dashboard listening on port ${config.port} (data in ${config.dataDir})`);
  startPoller();
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });
