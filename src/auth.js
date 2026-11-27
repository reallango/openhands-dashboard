// Login (scrypt password hash from the environment), server-side sessions, CSRF tokens and the API token.
import crypto from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';

// Hash format: scrypt:N:r:p:<salt base64url>:<hash base64url>. No "$", so it is safe in compose files and .env.
export function hashPassword(password, { N = 32768, r = 8, p = 1 } = {}) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  let got;
  try {
    got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2 });
  } catch { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export function validHashFormat(stored) {
  return /^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(String(stored || ''));
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b)); // equal-length digests, constant time
}

// Sessions: the cookie holds a random token; the database keeps only its SHA-256.
export const COOKIE = 'ohd_session';
const sessionId = token => sha(token).toString('hex');

export function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const t = Date.now();
  q.pruneSessions.run(t);
  q.addSession.run(sessionId(token), csrf, t, t + config.sessionDays * 86_400_000);
  return { token, csrf };
}

export function getSession(token) {
  if (!token) return null;
  return q.getSession.get(sessionId(token), Date.now()) || null;
}

export function destroySession(token) {
  if (token) q.delSession.run(sessionId(token));
}

export function sessionCookie(token, maxAgeSec) {
  return [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`, config.cookieSecure ? 'Secure' : ''].filter(Boolean).join('; ');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Login throttling per client address: after 5 failures, wait an increasing time (max 15 minutes).
const failures = new Map();
export function loginBlockedFor(ip) {
  const f = failures.get(ip);
  if (!f || f.count < 5) return 0;
  const wait = Math.min(15 * 60_000, 2 ** (f.count - 5) * 30_000);
  return Math.max(0, f.last + wait - Date.now());
}
export function noteLoginFailure(ip) {
  const f = failures.get(ip) || { count: 0, last: 0 };
  f.count++;
  f.last = Date.now();
  failures.set(ip, f);
  if (failures.size > 10_000) failures.clear();
}
export function noteLoginSuccess(ip) { failures.delete(ip); }
