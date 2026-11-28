// Local SQLite store (Node's built-in node:sqlite, no extra dependency).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'dashboard.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  start_task_id TEXT,
  title TEXT,
  repo TEXT,
  branch TEXT,
  sandbox_status TEXT,
  execution_status TEXT,
  status TEXT,
  pr_numbers TEXT NOT NULL DEFAULT '[]',
  cost REAL,
  model TEXT,
  ui_url TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_event_at TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  events_cursor TEXT,
  events_done INTEGER NOT NULL DEFAULT 0,
  last_polled INTEGER
);
CREATE TABLE IF NOT EXISTS start_tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  status TEXT,
  detail TEXT,
  repo TEXT,
  branch TEXT,
  title TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id TEXT NOT NULL,
  ev_id TEXT NOT NULL,
  ts TEXT,
  kind TEXT,
  source TEXT,
  tool TEXT,
  title TEXT,
  body TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  UNIQUE (conv_id, ev_id)
);
CREATE INDEX IF NOT EXISTS events_conv ON events (conv_id, seq);
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  what TEXT NOT NULL,
  old TEXT,
  new TEXT
);
CREATE INDEX IF NOT EXISTS changes_task ON changes (task_id, seq);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

export const q = {
  getConv: db.prepare('SELECT * FROM conversations WHERE id = ?'),
  allConvs: db.prepare('SELECT * FROM conversations ORDER BY COALESCE(updated_at, created_at) DESC'),
  getTask: db.prepare('SELECT * FROM start_tasks WHERE id = ?'),
  taskByConv: db.prepare('SELECT * FROM start_tasks WHERE conversation_id = ?'),
  allTasks: db.prepare('SELECT * FROM start_tasks ORDER BY created_at DESC'),
  pendingTasks: db.prepare("SELECT * FROM start_tasks WHERE status NOT IN ('READY', 'ERROR')"),
  insertTask: db.prepare(`INSERT INTO start_tasks (id, conversation_id, status, detail, repo, branch, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,
    status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at`),
  insertEvent: db.prepare(`INSERT OR IGNORE INTO events (conv_id, ev_id, ts, kind, source, tool, title, body, is_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  eventsSince: db.prepare('SELECT seq, ev_id, ts, kind, source, tool, title, body, is_error FROM events WHERE conv_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
  eventsTail: db.prepare('SELECT * FROM (SELECT seq, ev_id, ts, kind, source, tool, title, body, is_error FROM events WHERE conv_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq'),
  eventCount: db.prepare('SELECT COUNT(*) AS n, MAX(ts) AS last FROM events WHERE conv_id = ?'),
  lastEvent: db.prepare("SELECT title, tool, ts FROM events WHERE conv_id = ? AND kind IN ('ActionEvent', 'MessageEvent') ORDER BY seq DESC LIMIT 1"),
  addChange: db.prepare('INSERT INTO changes (task_id, at, what, old, new) VALUES (?, ?, ?, ?, ?)'),
  lastAgentEvent: db.prepare("SELECT MAX(ts) AS ts FROM events WHERE conv_id = ? AND source = 'agent'"),
  maxChange: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes'),
  changesSince: db.prepare('SELECT * FROM changes WHERE seq > ? ORDER BY seq'),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?'),
  addSession: db.prepare('INSERT INTO sessions (id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  delSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

// Upsert a conversation from a partial object; only the given columns change.
const COLS = ['start_task_id', 'title', 'repo', 'branch', 'sandbox_status', 'execution_status', 'status', 'pr_numbers', 'cost', 'model',
  'ui_url', 'created_at', 'updated_at', 'last_event_at', 'event_count', 'events_cursor', 'events_done', 'last_polled'];
export function saveConv(id, fields) {
  const keys = Object.keys(fields).filter(k => COLS.includes(k));
  if (!q.getConv.get(id)) db.prepare('INSERT INTO conversations (id) VALUES (?)').run(id);
  if (!keys.length) return;
  db.prepare(`UPDATE conversations SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => fields[k] ?? null), id);
}
