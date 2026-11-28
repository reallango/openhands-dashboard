// Minimal OpenHands Cloud API client. The key stays in this module: it is sent only to the configured
// OpenHands base URL and never logged or returned.
import { config } from './config.js';

const headers = () => ({ Authorization: `Bearer ${config.openhandsKey}`, Accept: 'application/json' });

async function call(method, p, body) {
  const res = await fetch(config.openhandsBase + p, {
    method,
    headers: body ? { ...headers(), 'Content-Type': 'application/json' } : headers(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`OpenHands ${method} ${p.split('?')[0]} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  try { return JSON.parse(text); } catch { return null; }
}

const list = j => (Array.isArray(j) ? j : j?.items ?? []);
const idsQuery = ids => ids.map(id => `ids=${encodeURIComponent(id)}`).join('&');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sending to an existing conversation. Verified 2026-11 in the OpenHands source: the V1 app
// server (OpenHands/legacy, openhands/app_server/) has a Bearer-key proxy
// POST /app-conversations/{id}/send-message (app_conversation_router.py), which forwards to the
// agent server's POST /api/conversations/{id}/events (OpenHands/software-agent-sdk,
// openhands-agent-server/openhands/agent_server/event_router.py) with
// {role, content: [{type: 'text', text}], run}. A paused sandbox is woken with
// POST /sandboxes/{id}/resume (sandbox_router.py). The direct agent-server call below is only a
// fallback for app servers without the proxy; the session key then goes only to the https
// conversation_url that the app server itself returned.

async function getConv(id) {
  const [c] = list(await call('GET', `/app-conversations?${idsQuery([id])}`));
  return c || null;
}

async function waitRunning(id, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const c = await getConv(id);
    if (!c) throw Object.assign(new Error(`Conversation ${id} not found`), { status: 404 });
    if (c.sandbox_status === 'RUNNING' && c.conversation_url) return c;
    if (c.sandbox_status === 'ERROR' || c.sandbox_status === 'MISSING') {
      throw Object.assign(new Error(`Sandbox is ${c.sandbox_status}`), { status: c.sandbox_status === 'MISSING' ? 410 : 503 });
    }
    if (Date.now() >= end) throw Object.assign(new Error('timed out waiting for the sandbox to start'), { status: 504 });
    await sleep(2000);
  }
}

async function sendDirect(conv, text) {
  const base = String(conv.conversation_url || '').replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error('OpenHands did not return a conversation URL'), { status: 503 });
  const url = new URL(`${base}/events`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.openhandsBase.startsWith('http:'))) {
    throw Object.assign(new Error('OpenHands returned a non-https conversation URL'), { status: 502 });
  }
  if (!conv.session_api_key) throw Object.assign(new Error('OpenHands did not return a session key'), { status: 502 });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Session-API-Key': conv.session_api_key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ role: 'user', content: [{ type: 'text', text }], run: true }),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!res.ok) {
    // Do not include the response body: this request carries the session key.
    const err = new Error(`OpenHands POST ${url.pathname} -> HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

export const oh = {
  search: (pageId, limit = 50) => call('GET', `/app-conversations/search?limit=${limit}${pageId ? `&page_id=${encodeURIComponent(pageId)}` : ''}`),
  conversations: async ids => (ids.length ? list(await call('GET', `/app-conversations?${idsQuery(ids)}`)).filter(Boolean) : []),
  startTasks: async ids => (ids.length ? list(await call('GET', `/app-conversations/start-tasks?${idsQuery(ids)}`)).filter(Boolean) : []),
  events: (convId, { pageId, since, limit = 100 } = {}) => {
    const qs = new URLSearchParams({ limit: String(limit), sort_order: 'TIMESTAMP' });
    if (pageId) qs.set('page_id', pageId);
    if (since) qs.set('timestamp__gte', since);
    return call('GET', `/conversation/${encodeURIComponent(convId)}/events/search?${qs}`);
  },
  start: ({ repo, branch, brief, title }) => call('POST', '/app-conversations', {
    initial_message: { content: [{ type: 'text', text: brief }], run: true },
    selected_repository: repo,
    selected_branch: branch,
    git_provider: 'github',
    title: title || undefined,
  }),
  sendMessage: async (conversationId, text) => {
    const id = String(conversationId);
    let conv = await getConv(id);
    if (!conv) throw Object.assign(new Error(`Conversation ${id} not found`), { status: 404 });
    if (conv.sandbox_status === 'MISSING') throw Object.assign(new Error('Conversation is archived (its sandbox no longer exists)'), { status: 410 });
    if (conv.sandbox_status === 'ERROR') throw Object.assign(new Error('Sandbox is in an error state'), { status: 503 });
    let resumed = false;
    if (conv.sandbox_status !== 'RUNNING') {
      if (conv.sandbox_status === 'PAUSED') {
        if (!conv.sandbox_id) throw Object.assign(new Error('OpenHands did not return a sandbox id'), { status: 502 });
        await call('POST', `/sandboxes/${encodeURIComponent(conv.sandbox_id)}/resume`);
        resumed = true;
      }
      conv = await waitRunning(id);
    }
    const post = () => call('POST', `/app-conversations/${encodeURIComponent(id)}/send-message`,
      { role: 'user', content: [{ type: 'text', text }], run: true });
    try {
      await post();
    } catch (e) {
      if (e.status === 409 && !resumed) {
        // The sandbox went down between the check and the send: wake it and retry once.
        if (!conv.sandbox_id) throw e;
        await call('POST', `/sandboxes/${encodeURIComponent(conv.sandbox_id)}/resume`);
        resumed = true;
        conv = await waitRunning(id);
        await post();
      } else if (e.status === 404 || e.status === 405) {
        // Older app server without the proxy route: call the agent server directly.
        await sendDirect(await waitRunning(id), text);
      } else {
        throw e;
      }
    }
    return { conversation_id: id, resumed };
  },
};
