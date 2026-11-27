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
};
