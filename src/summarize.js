// Turn a raw OpenHands event into a short, readable step. Only known, safe fields are copied: raw events
// (for example ConversationStateUpdateEvent) can contain the agent's LLM API key, so they are never stored.

const SKIP = new Set(['SystemPromptEvent', 'SecurityAnalysisEvent', 'TokenEvent', 'StreamingDeltaEvent',
  'LLMCompletionLogEvent', 'CondensationRequest', 'CondensationSummaryEvent']);
const SECRETISH = /key|token|secret|password|authorization|cookie/i;

const cap = (s, n) => {
  s = String(s ?? '');
  if (s.length <= n) return s;
  const half = Math.floor(n / 2);
  return `${s.slice(0, half)}\n… [${s.length - n} characters cut] …\n${s.slice(-half)}`;
};
const firstLine = (s, n = 140) => {
  const line = String(s ?? '').trim().split('\n')[0];
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
};
const textOf = c => (Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : typeof c === 'string' ? c : '');

function safeJson(v, n = 4000) {
  const clean = (x, d) => {
    if (x === null || typeof x !== 'object') return x;
    if (d > 4) return '…';
    if (Array.isArray(x)) return x.slice(0, 50).map(y => clean(y, d + 1));
    const o = {};
    for (const [k, y] of Object.entries(x)) if (!SECRETISH.test(k) && k !== 'kind') o[k] = clean(y, d + 1);
    return o;
  };
  return cap(JSON.stringify(clean(v, 0), null, 2), n);
}

function action(ev) {
  const a = ev.action || {};
  const thought = textOf(ev.thought).trim();
  const tool = ev.tool_name || a.kind || '';
  let title; let body = '';
  switch (a.kind) {
    case 'TerminalAction':
    case 'CmdRunAction':
    case 'ExecuteBashAction':
      title = `$ ${firstLine(a.command)}`;
      body = title === `$ ${String(a.command ?? '').trim()}` ? '' : a.command || '';
      break;
    case 'FileEditorAction':
    case 'StrReplaceEditorAction':
    case 'FileEditAction': {
      title = `${a.command || 'edit'} ${a.path || ''}`.trim();
      if (a.command === 'create') body = cap(a.file_text, 3000);
      else if (a.command === 'str_replace') body = `--- old\n${cap(a.old_str, 1500)}\n+++ new\n${cap(a.new_str, 1500)}`;
      else if (a.command === 'insert') body = `insert at line ${a.insert_line}:\n${cap(a.new_str, 2000)}`;
      else if (a.view_range) body = `lines ${JSON.stringify(a.view_range)}`;
      break;
    }
    case 'FinishAction':
      title = 'Finished';
      body = a.message || '';
      break;
    case 'ThinkAction':
      title = 'Thinking';
      body = a.thought || '';
      break;
    case 'TaskTrackerAction':
      title = `Task list (${a.command || 'update'})`;
      body = Array.isArray(a.task_list) ? a.task_list.map(t => `[${t.status || ' '}] ${t.title || ''}`).join('\n') : '';
      break;
    case 'MCPToolAction':
      title = `${tool}${ev.summary && !ev.summary.startsWith(tool) ? `: ${firstLine(ev.summary)}` : ''}`;
      body = safeJson(a.data);
      break;
    default:
      title = `${tool}${ev.summary ? `: ${firstLine(ev.summary)}` : ''}`;
      body = safeJson(a);
  }
  if (ev.summary && !['MCPToolAction'].includes(a.kind) && !title.includes(ev.summary)) title += `  · ${firstLine(ev.summary, 80)}`;
  return { tool, title, body: [thought && `💭 ${thought}`, cap(body, 6000)].filter(Boolean).join('\n\n'), is_error: 0 };
}

function observation(ev) {
  const o = ev.observation || {};
  const text = textOf(o.content);
  const exit = o.exit_code ?? o.metadata?.exit_code;
  const isErr = o.is_error || (typeof exit === 'number' && exit !== 0 && exit !== -1);
  let title = ev.tool_name || o.kind || 'result';
  if (typeof exit === 'number' && exit !== -1) title += ` · exit ${exit}`;
  if (o.timeout) title += ' · timed out';
  if (isErr) title += ' · error';
  return { tool: ev.tool_name || '', title, body: cap(text, 6000), is_error: isErr ? 1 : 0 };
}

export function summarize(ev) {
  const k = ev.kind;
  if (!k || SKIP.has(k)) return null;
  let s;
  switch (k) {
    case 'MessageEvent': {
      const role = ev.llm_message?.role || ev.source;
      s = { tool: '', title: role === 'user' ? 'User message' : 'Agent message', body: cap(textOf(ev.llm_message?.content), 20000), is_error: 0 };
      break;
    }
    case 'ActionEvent': s = action(ev); break;
    case 'ObservationEvent':
      // These only echo the action (the finish message, a thought), which is already shown.
      if (['FinishObservation', 'ThinkObservation'].includes(ev.observation?.kind)) return null;
      s = observation(ev);
      break;
    case 'ConversationStateUpdateEvent':
      if (ev.key !== 'execution_status' || typeof ev.value !== 'string') return null;
      s = { tool: '', title: `Status: ${ev.value}`, body: '', is_error: ['error', 'stuck'].includes(ev.value) ? 1 : 0 };
      break;
    case 'AgentErrorEvent':
      s = { tool: ev.tool_name || '', title: `Agent error${ev.tool_name ? ` (${ev.tool_name})` : ''}`, body: cap(ev.error, 6000), is_error: 1 };
      break;
    case 'ServerErrorEvent':
    case 'ConversationErrorEvent':
      s = { tool: '', title: `${k.replace('Event', '')}${ev.code ? ` ${ev.code}` : ''}`, body: cap(ev.detail, 6000), is_error: 1 };
      break;
    case 'UserRejectObservation':
      s = { tool: '', title: 'Action rejected', body: cap(ev.rejection_reason, 2000), is_error: 1 };
      break;
    case 'Condensation':
      s = { tool: '', title: 'Context condensed', body: '', is_error: 0 };
      break;
    case 'PauseEvent':
    case 'InterruptEvent':
      s = { tool: '', title: k.replace('Event', ''), body: '', is_error: 0 };
      break;
    case 'HookExecutionEvent':
      s = { tool: '', title: `Hook ${ev.hook_event_type || ''} ${ev.success ? 'ok' : 'failed'}`.trim(), body: cap([ev.hook_command, ev.stdout, ev.stderr].filter(Boolean).join('\n'), 3000), is_error: ev.success ? 0 : 1 };
      break;
    default:
      s = { tool: '', title: k, body: '', is_error: 0 };
  }
  return { ev_id: String(ev.id), ts: ev.timestamp || null, kind: k, source: ev.source || '', ...s };
}
