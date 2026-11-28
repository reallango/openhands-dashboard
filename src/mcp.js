// MCP endpoint (Streamable HTTP transport, stateless, JSON replies only). It exposes the dashboard's operations as
// tools so Claude can use them without writing HTTP calls. Authentication (the API token) is checked by the router.

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'openhands-dashboard', title: 'OpenHands dashboard', version: '0.3.1' };

const INSTRUCTIONS = `Tools for following OpenHands Cloud agent conversations through the owner's dashboard. Replies are short text.
- list_tasks: one line per active or recent task (id, status, age, repo@branch, PR, title, latest step). Ends with cursor=N.
- wait_for_tasks: blocks until a listed task finishes, errors, gets stuck or stalled, waits for input, or opens a PR (or the timeout passes). One call replaces repeated polling. To keep waiting after it returned, pass the cursor it returned as since.
- get_steps: the steps of one conversation, when something looks wrong.
- start_task: starts a new OpenHands conversation (spends credits); pass its start_task_id to wait_for_tasks.
- send_message: sends a follow-up user message to an existing conversation (resumes it if paused), e.g. to ask it to commit, push and open the PR; then wait_for_tasks with the returned since.
IDs can be conversation ids, start-task ids, or their first 8+ characters.`;

const SILENT_MAX_SEC = 280;

const READ_ONLY ={ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'list_tasks',
    title: 'List OpenHands tasks',
    description: 'One line per active OpenHands task, plus finished or failed ones from the last day. Statuses: setting up, running, waiting, stalled, stuck, error, finished, paused. Ends with cursor=N for wait_for_tasks.',
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'List every known conversation instead of only active and recent ones.' } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'wait_for_tasks',
    title: 'Wait for OpenHands tasks',
    description: 'Long-poll: returns as soon as one of the given tasks finishes, errors, gets stuck or stalled, starts waiting for input, or opens a PR; otherwise after timeout_sec. Without since, a task that is already in such a state answers at once. With since (the cursor from a previous reply), only later changes count.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Conversation or start-task ids (or 8+ character prefixes). Empty: any task.' },
        timeout_sec: { type: 'integer', minimum: 1, maximum: 1800, description: 'Give up after this many seconds (default 600). Clients that send no progress token are limited to 280.' },
        since: { type: 'integer', minimum: 0, description: 'Cursor from a previous list_tasks or wait_for_tasks reply.' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_steps',
    title: 'Get conversation steps',
    description: 'The steps of one conversation (messages, commands, edits, outputs), one per line, oldest first. Without since: the latest `limit` steps. Each reply ends with cursor=N; pass it as since to get only newer steps.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation id, start-task id, or an 8+ character prefix.' },
        since: { type: 'integer', minimum: 0, description: 'Only steps after this cursor.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum number of steps (default 50).' },
        full: { type: 'boolean', description: 'Include the full output of each step instead of the first 300 characters.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'start_task',
    title: 'Start an OpenHands task',
    description: 'Starts a new OpenHands Cloud conversation on a GitHub repository with the given brief. This spends OpenHands credits. Returns the start_task_id to pass to wait_for_tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repository as owner/name (default: the dashboard\'s DEFAULT_REPO).' },
        branch: { type: 'string', description: 'Branch to start from (default: DEFAULT_BRANCH).' },
        title: { type: 'string', description: 'Conversation title.' },
        brief: { type: 'string', description: 'The full task description for the agent.' },
      },
      required: ['brief'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'send_message',
    title: 'Send a message to a conversation',
    description: 'Sends a follow-up user message to an existing conversation and starts the agent again (resuming a paused sandbox first). Use it to ask an agent to commit, push and open the PR after it stopped. Returns the conversation id and a cursor for wait_for_tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation id, start-task id, or an 8+ character prefix.' },
        message: { type: 'string', description: 'The message to send to the agent.' },
      },
      required: ['id', 'message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

// ops: { summary({all}), wait({ids, timeoutSec, since}, signal), steps(id, {since, limit, full}), start(body), send(id, message) } -> { text }
export function createMcp(ops) {
  const inflight = new Map(); // request id -> AbortController, for notifications/cancelled

  async function callTool(name, args, signal, ctx) {
    switch (name) {
      case 'list_tasks':
        return ops.summary({ all: !!args.all }).text;
      case 'wait_for_tasks': {
        const ids = Array.isArray(args.ids) ? args.ids.map(String) : typeof args.ids === 'string' ? args.ids.split(',') : [];
        let timeoutSec = Math.min(Math.max(Number(args.timeout_sec) || 600, 1), 1800);
        // MCP clients abort a call that stays silent too long (Claude Code: 5 minutes over HTTP). With an event stream and a
        // progress token we send progress every 25 s and can wait the full time; without, stay under that limit.
        const stream = ctx.progressToken != null ? ctx.openStream?.() : null;
        let capped = false;
        if (!stream && timeoutSec > SILENT_MAX_SEC) { timeoutSec = SILENT_MAX_SEC; capped = true; }
        const t0 = Date.now();
        const timer = stream && setInterval(() => stream.send({
          jsonrpc: '2.0', method: 'notifications/progress',
          params: { progressToken: ctx.progressToken, progress: Math.round((Date.now() - t0) / 1000), total: timeoutSec, message: 'waiting for a task to change' },
        }), 25_000);
        try {
          const r = await ops.wait({ ids: ids.map(s => s.trim()).filter(Boolean), timeoutSec, since: args.since }, signal);
          return r.text + (capped && r.reason === 'timeout' ? `\n(waited ${SILENT_MAX_SEC}s, the most this client allows without progress; call again with since=${r.cursor})` : '');
        } finally {
          if (timer) clearInterval(timer);
        }
      }
      case 'get_steps':
        if (!args.id) throw Object.assign(new Error('id is required'), { status: 400 });
        return (await ops.steps(String(args.id), { since: args.since, limit: args.limit ?? 50, full: !!args.full })).text;
      case 'start_task': {
        const r = await ops.start(args);
        return `started: start_task_id=${r.start_task_id} status=${r.status}${r.conversation_id ? ` conversation_id=${r.conversation_id}` : ''} on ${r.repo}@${r.branch}\nNext: wait_for_tasks with ids=["${r.start_task_id}"]`;
      }
      case 'send_message': {
        if (!args.id) throw Object.assign(new Error('id is required'), { status: 400 });
        if (args.message == null || args.message === '') throw Object.assign(new Error('message is required'), { status: 400 });
        const r = await ops.send(String(args.id), String(args.message));
        return `sent to ${r.conversation_id}${r.resumed ? ' (resumed the sandbox first)' : ''}\nNext: wait_for_tasks with ids=["${r.conversation_id}"] since=${r.cursor}`;
      }
      default:
        return null;
    }
  }

  async function handleMessage(msg, signal, ctx = {}) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // A response from the client (we never send requests) or garbage.
      return msg && ('result' in msg || 'error' in msg) ? null : rpcError(msg?.id, -32600, 'Invalid request');
    }
    const isNotification = msg.id === undefined || msg.id === null;
    const params = msg.params || {};
    if (isNotification) {
      if (msg.method === 'notifications/cancelled') inflight.get(params.requestId)?.abort();
      return null;
    }
    switch (msg.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return ok(msg.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(msg.id, {});
      case 'tools/list':
        return ok(msg.id, { tools: TOOLS });
      case 'tools/call': {
        const name = params.name;
        if (!TOOLS.some(t => t.name === name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        signal?.addEventListener('abort', onAbort);
        inflight.set(msg.id, ac);
        try {
          const toolCtx = { progressToken: params._meta?.progressToken, openStream: ctx.openStream };
          return ok(msg.id, textResult(await callTool(name, params.arguments || {}, ac.signal, toolCtx)));
        } catch (e) {
          if (!e.status) console.error(`[mcp] ${name}: ${e.message}`);
          return ok(msg.id, textResult(e.status ? e.message : `Internal error: ${e.message}`, true));
        } finally {
          inflight.delete(msg.id);
          signal?.removeEventListener('abort', onAbort);
        }
      }
      case 'resources/list':
        return ok(msg.id, { resources: [] });
      case 'prompts/list':
        return ok(msg.id, { prompts: [] });
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  // Returns { status, body, stream } for the HTTP layer. body null = 202 Accepted with no body. stream is set when the
  // reply was switched to an event stream (only for a single request, when the client accepts text/event-stream);
  // the HTTP layer then sends body on that stream and closes it.
  async function handlePost(raw, signal, { openStream } = {}) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { status: 400, body: rpcError(null, -32700, 'Parse error') }; }
    if (Array.isArray(parsed)) {
      const replies = (await Promise.all(parsed.map(m => handleMessage(m, signal)))).filter(Boolean);
      return replies.length ? { status: 200, body: replies } : { status: 202, body: null };
    }
    let stream = null;
    const open = openStream && (() => (stream ||= openStream()));
    const reply = await handleMessage(parsed, signal, { openStream: open });
    return reply ? { status: 200, body: reply, stream } : { status: 202, body: null, stream };
  }

  return { handlePost };
}
