// Dashboard page. All agent output is inserted with textContent, never as HTML.
const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

const ACTIVE = new Set(['setting up', 'running', 'waiting', 'stalled']);
const state = {
  me: null, items: [], cursor: 0, filter: localGet('filter') || 'active', search: '', selected: null,
  events: [], evCursor: 0, evConv: null, unseen: 0, flash: new Set(), hideObs: localGet('hideObs') === '1',
};

function localGet(k) { try { return localStorage.getItem(`ohd.${k}`); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(`ohd.${k}`, v); } catch { /* private mode */ } }

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.method && opts.method !== 'GET') headers['X-CSRF-Token'] = state.me?.csrf || '';
  const r = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

const parseTs = t => (t ? Date.parse(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`) : NaN);
function ago(t) {
  const v = parseTs(t);
  if (!Number.isFinite(v)) return '';
  const s = Math.max(0, Math.round((Date.now() - v) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const localTime = t => { const v = parseTs(t); return Number.isFinite(v) ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };
const pill = s => el('span', { class: `pill s-${String(s).replace(/\s+/g, '-')}`, text: s });

// ---------- list ----------
function visibleItems() {
  const day = Date.now() - 86_400_000;
  const s = state.search.toLowerCase();
  return state.items.filter(v => {
    if (state.filter === 'active' && !ACTIVE.has(v.status)) return false;
    if (state.filter === 'recent' && !(ACTIVE.has(v.status) || parseTs(v.last_activity) > day)) return false;
    if (!s) return true;
    return [v.title, v.repo, v.branch, v.id, ...(v.prs || []).map(n => `#${n}`)].join(' ').toLowerCase().includes(s);
  });
}

function renderList() {
  const list = $('#list');
  const items = visibleItems();
  $('#count-active').textContent = `(${state.items.filter(v => ACTIVE.has(v.status)).length})`;
  list.replaceChildren(...items.map(v => {
    const li = el('li', { class: [v.id === state.selected ? 'sel' : '', state.flash.has(v.id) ? 'flash' : ''].join(' '), onclick: () => select(v.id) },
      el('div', { class: 't', title: v.title, text: v.title }),
      el('div', { class: 'meta' },
        pill(v.status),
        v.repo ? el('span', { text: `${v.repo.split('/')[1] || v.repo} @ ${v.branch || '?'}` }) : null,
        ...(v.pr_urls || []).map((u, i) => el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', onclick: e => e.stopPropagation(), text: `PR #${v.prs[i]}` })),
        el('span', { text: ago(v.last_activity) })),
      v.last_step && ACTIVE.has(v.status) ? el('div', { class: 'step', text: v.last_step }) : null,
      v.status === 'error' && v.detail ? el('div', { class: 'step', text: v.detail }) : null);
    return li;
  }));
  if (!items.length) list.append(el('li', { class: 'empty', text: state.filter === 'active' ? 'Nothing running right now.' : 'No conversations.' }));
}

// ---------- detail ----------
function renderHead() {
  const v = state.items.find(x => x.id === state.selected);
  const pane = $('#detail');
  if (!v) { pane.replaceChildren(el('div', { class: 'empty', text: 'Pick a conversation on the left.' })); return; }
  let steps = pane.querySelector('.steps');
  const head = el('div', { class: 'd-head' },
    el('h1', {}, el('button', { class: 'back ghost', onclick: () => select(null), text: '←' }), v.title, pill(v.status)),
    el('div', { class: 'meta' },
      v.repo ? el('span', {}, el('code', { text: `${v.repo} @ ${v.branch || '?'}` })) : null,
      ...(v.pr_urls || []).map((u, i) => el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', text: `PR #${v.prs[i]}` })),
      v.created_at ? el('span', { text: `started ${ago(v.created_at)}` }) : null,
      v.last_activity ? el('span', { text: `last activity ${ago(v.last_activity)}` }) : null,
      v.start_status && v.start_status !== 'READY' ? el('span', { text: `start: ${v.start_status}` }) : null,
      v.cost != null ? el('span', { text: `$${Number(v.cost).toFixed(2)}` }) : null,
      v.event_count != null ? el('span', { text: `${v.event_count} steps` }) : null,
      v.ui_url ? el('a', { href: v.ui_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open in OpenHands' }) : null),
    el('div', { class: 'd-tools' },
      el('label', {}, el('input', { type: 'checkbox', checked: state.hideObs, onchange: e => { state.hideObs = e.target.checked; localSet('hideObs', e.target.checked ? '1' : '0'); steps?.classList.toggle('hide-obs', state.hideObs); } }), 'Hide command output'),
      el('code', { class: 'small muted', text: v.id }),
      v.detail ? el('span', { class: 'error', text: v.detail }) : null));
  const oldHead = pane.querySelector('.d-head');
  if (oldHead && steps) { oldHead.replaceWith(head); return; }
  steps = el('div', { class: `steps${state.hideObs ? ' hide-obs' : ''}` });
  pane.replaceChildren(head, steps);
}

function evNode(e) {
  const cls = ['ev', `k-${e.kind}`];
  if (e.is_error) cls.push('err');
  if (e.title === 'Finished') cls.push('finish');
  if (e.title.startsWith('Status:')) cls.push('status');
  const open = e.kind === 'MessageEvent' || e.title === 'Finished' || (!!e.is_error && e.kind !== 'ObservationEvent');
  return el('details', { class: cls.join(' '), open },
    el('summary', {}, el('span', { class: 'time', text: localTime(e.ts) }), el('span', { class: 'title', text: e.title })),
    e.body ? el('pre', { text: e.body }) : null);
}

function appendEvents(rows) {
  const steps = $('#detail .steps');
  if (!steps) return;
  const atBottom = steps.scrollHeight - steps.scrollTop - steps.clientHeight < 80;
  steps.querySelector('.empty')?.remove();
  for (const r of rows) steps.append(evNode(r));
  if (!steps.children.length) steps.append(el('div', { class: 'empty', text: 'No steps yet.' }));
  if (atBottom) steps.scrollTop = steps.scrollHeight;
}

let evBusy = false;
async function loadEvents(initial) {
  const id = state.selected;
  if (!id || id.startsWith('task:') || evBusy) return;
  evBusy = true;
  try {
    const qs = initial ? 'limit=400' : `since=${state.evCursor}&limit=500`;
    const r = await api(`/api/conversations/${encodeURIComponent(id)}/events?format=json&${qs}`);
    if (state.selected !== id) return;
    if (initial) {
      $('#detail .steps')?.replaceChildren();
      if (r.items.length >= 400) $('#detail .steps')?.append(el('div', { class: 'muted small', text: 'Showing the latest 400 steps.' }));
    }
    state.evCursor = r.cursor;
    appendEvents(r.items);
  } catch (e) {
    if (initial) $('#detail .steps')?.replaceChildren(el('div', { class: 'error', text: `Could not load steps: ${e.message}` }));
  } finally {
    evBusy = false;
  }
}

function select(id) {
  state.selected = id;
  state.evCursor = 0;
  state.flash.delete(id);
  history.replaceState(null, '', id ? `#${id}` : location.pathname);
  $('.layout').classList.toggle('show-detail', !!id);
  $('#detail').replaceChildren();
  renderHead();
  renderList();
  if (id && !id.startsWith('task:')) {
    $('#detail .steps')?.append(el('div', { class: 'empty', text: 'Loading steps…' }));
    loadEvents(true).then(() => { const s = $('#detail .steps'); if (s) s.scrollTop = s.scrollHeight; });
  }
}

// ---------- alerts ----------
function toast(a) {
  const kind = a.what === 'pr' || a.status === 'finished' ? 'ok' : ['error', 'stuck'].includes(a.status) || a.what === 'start' ? 'bad' : 'warn';
  const item = state.items.find(v => v.id === a.id || v.start_task_id === a.id);
  const t = el('div', { class: `toast ${kind}`, onclick: () => { if (item) select(item.id); t.remove(); } },
    el('strong', { text: item?.title || a.id }), el('div', { class: 'small muted', text: a.text.replace(/^\S+\s/, '') }));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 20_000);
  if (item) state.flash.add(item.id);
  if (document.hidden) { state.unseen++; document.title = `(${state.unseen}) OpenHands dashboard`; }
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(item?.title || 'OpenHands', { body: a.text.replace(/^\S+\s/, ''), icon: '/icon.svg', tag: a.id }); } catch { /* some browsers only allow this from a service worker */ }
  }
  beep(kind);
}

let audio;
function beep(kind) {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.frequency.value = kind === 'bad' ? 330 : 660;
    g.gain.setValueAtTime(0.08, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.4);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.4);
  } catch { /* audio blocked until the page is clicked */ }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) { state.unseen = 0; document.title = 'OpenHands dashboard'; } });

function setupNotifications() {
  const btn = $('#notify-btn');
  if (!('Notification' in window) || !window.isSecureContext) {
    btn.hidden = false;
    btn.disabled = true;
    btn.title = 'Browsers only allow notifications on HTTPS or localhost. Alerts still show here, with a sound.';
    btn.textContent = 'Notifications need HTTPS';
    return;
  }
  if (Notification.permission === 'default') {
    btn.hidden = false;
    btn.onclick = async () => { await Notification.requestPermission(); btn.hidden = Notification.permission !== 'default'; };
  }
}

// ---------- polling ----------
let listBusy = false;
async function refresh() {
  if (listBusy) return;
  listBusy = true;
  try {
    const r = await api(`/api/conversations?since=${state.cursor}`);
    const first = !state.cursor;
    state.items = r.items;
    if (!first) for (const a of r.alerts) toast(a);
    state.cursor = r.cursor;
    const h = r.health || {};
    const errNewer = h.lastErrorAt && (!h.lastOk || h.lastErrorAt > h.lastOk);
    $('#poll-state').textContent = errNewer ? `OpenHands poll failing: ${h.lastError}` : h.lastOk ? `synced ${ago(h.lastOk)}` : 'first sync…';
    $('#poll-state').classList.toggle('error', !!errNewer);
    renderList();
    if (state.selected) {
      if (!state.items.some(v => v.id === state.selected)) {
        // A pending start task turned into a conversation: follow it.
        const conv = state.items.find(v => `task:${v.start_task_id}` === state.selected);
        if (conv) select(conv.id);
      } else renderHead();
    }
  } catch (e) {
    $('#poll-state').textContent = `dashboard unreachable: ${e.message}`;
  } finally {
    listBusy = false;
  }
}

// ---------- start dialog ----------
function setupStart() {
  const dlg = $('#start-dialog');
  const form = $('#start-form');
  $('#start-btn').onclick = () => {
    form.repo.value ||= state.me?.defaultRepo || '';
    form.branch.value ||= state.me?.defaultBranch || 'main';
    $('#start-error').textContent = '';
    dlg.showModal();
  };
  $('#start-cancel').onclick = () => dlg.close();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    $('#start-error').textContent = '';
    const data = Object.fromEntries(new FormData(form));
    try {
      const r = await api('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      form.title.value = ''; form.brief.value = '';
      dlg.close();
      await refresh();
      select(r.conversation_id || `task:${r.start_task_id}`);
    } catch (err) {
      $('#start-error').textContent = err.message;
    }
  });
}

// ---------- boot ----------
async function boot() {
  state.me = await api('/api/me');
  document.querySelectorAll('.filters button').forEach(b => {
    b.classList.toggle('on', b.dataset.filter === state.filter);
    b.onclick = () => {
      state.filter = b.dataset.filter; localSet('filter', state.filter);
      document.querySelectorAll('.filters button').forEach(x => x.classList.toggle('on', x === b));
      renderList();
    };
  });
  $('#search').addEventListener('input', e => { state.search = e.target.value; renderList(); });
  $('#logout-btn').onclick = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); location.href = '/login'; };
  setupNotifications();
  setupStart();
  await refresh();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash) select(fromHash);
  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id !== (state.selected || '')) select(id || null);
  });
  setInterval(refresh, 4000);
  setInterval(() => {
    const v = state.items.find(x => x.id === state.selected);
    if (v && (ACTIVE.has(v.status) || Date.now() - parseTs(v.last_activity) < 15 * 60_000)) loadEvents(false);
  }, 3000);
  setInterval(renderList, 30_000); // keep "x minutes ago" fresh
}
boot();
