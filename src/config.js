// Configuration from the environment. Secrets can come from a variable or from a file (<NAME>_FILE),
// for example a Docker secret. Secret values are never logged.
import fs from 'node:fs';

function secret(name) {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { throw new Error(`${name}_FILE could not be read: ${e.code || e.message}`); }
  }
  return (process.env[name] || '').trim();
}

const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

export const config = {
  port: num('PORT', 3077),
  dataDir: process.env.DATA_DIR || '/data',
  openhandsBase: (process.env.OPENHANDS_API_BASE || 'https://app.all-hands.dev/api/v1').replace(/\/+$/, ''),
  openhandsKey: secret('OPENHANDS_API_KEY'),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPasswordHash: secret('ADMIN_PASSWORD_HASH'),
  apiToken: secret('API_TOKEN'),
  cookieSecure: /^(1|true|yes)$/i.test(process.env.COOKIE_SECURE || ''),
  sessionDays: num('SESSION_DAYS', 14),
  activeIntervalSec: num('ACTIVE_POLL_SEC', 20),
  listIntervalSec: num('LIST_POLL_SEC', 60),
  idleListIntervalSec: num('IDLE_LIST_POLL_SEC', 300),
  stalledMinutes: num('STALLED_MINUTES', 20),
  recentHours: num('RECENT_HOURS', 24),
  defaultRepo: process.env.DEFAULT_REPO || '',
  defaultBranch: process.env.DEFAULT_BRANCH || 'main',
};

export function checkConfig() {
  const missing = [];
  if (!config.openhandsKey) missing.push('OPENHANDS_API_KEY (or OPENHANDS_API_KEY_FILE)');
  if (!config.adminPasswordHash) missing.push('ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD_HASH_FILE)');
  if (!config.apiToken) missing.push('API_TOKEN (or API_TOKEN_FILE)');
  else if (config.apiToken.length < 24) missing.push('API_TOKEN must be at least 24 characters');
  return missing;
}
