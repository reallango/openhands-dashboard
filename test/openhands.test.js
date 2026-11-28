import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENHANDS_API_BASE = 'https://api.example.test/api/v1';
process.env.OPENHANDS_API_KEY = 'test-key';
const { oh } = await import('../src/openhands.js');

const CONV = '50cbebe492564ea7899d24a87d57ff53';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const conv = extra => ({ id: CONV, sandbox_id: 'sb1', sandbox_status: 'RUNNING', conversation_url: `https://sandbox.test/api/conversations/${CONV}`, session_api_key: 'session-secret', ...extra });

// A fetch stub at the network boundary: each route answers by path.
function stub(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    calls.push({ method, path: u.pathname, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    const r = routes.find(x => x.method === method && x.path === u.pathname);
    if (!r) return new Response('not stubbed', { status: 404 });
    return json(typeof r.reply === 'function' ? r.reply(calls.length) : r.reply, r.status || 200);
  };
  return calls;
}

test('sendMessage posts through the app-server proxy when the sandbox is running', async () => {
  const calls = stub([
    { method: 'GET', path: '/api/v1/app-conversations', reply: [conv()] },
    { method: 'POST', path: `/api/v1/app-conversations/${CONV}/send-message`, reply: { success: true, sandbox_status: 'RUNNING' } },
  ]);
  assert.deepEqual(await oh.sendMessage(CONV, 'commit and push'), { conversation_id: CONV, resumed: false });
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST']);
  assert.equal(calls[1].body.role, 'user');
  assert.deepEqual(calls[1].body.content, [{ type: 'text', text: 'commit and push' }]);
  assert.equal(calls[1].body.run, true);
  assert.equal(calls[1].headers.Authorization, 'Bearer test-key');
  assert.equal(calls[1].headers['X-Session-API-Key'], undefined);
});

test('sendMessage resumes a paused sandbox and waits for it to run', async () => {
  let gets = 0;
  const calls = stub([
    { method: 'GET', path: '/api/v1/app-conversations', reply: () => [gets++ === 0 ? conv({ sandbox_status: 'PAUSED' }) : conv()] },
    { method: 'POST', path: '/api/v1/sandboxes/sb1/resume', reply: { success: true } },
    { method: 'POST', path: `/api/v1/app-conversations/${CONV}/send-message`, reply: { success: true, sandbox_status: 'RUNNING' } },
  ]);
  assert.deepEqual(await oh.sendMessage(CONV, 'hello'), { conversation_id: CONV, resumed: true });
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), [
    'GET /api/v1/app-conversations',
    'POST /api/v1/sandboxes/sb1/resume',
    'GET /api/v1/app-conversations',
    'POST /api/v1/app-conversations/' + CONV + '/send-message',
  ]);
});

test('sendMessage falls back to the agent server with the session key on the returned https URL', async () => {
  let gets = 0;
  const calls = stub([
    { method: 'GET', path: '/api/v1/app-conversations', reply: () => [gets++ === 0 ? conv({ conversation_url: null }) : conv()] },
    { method: 'POST', path: `/api/v1/app-conversations/${CONV}/send-message`, reply: 'no such route', status: 404 },
    { method: 'POST', path: `/api/conversations/${CONV}/events`, reply: { success: true } },
  ]);
  assert.deepEqual(await oh.sendMessage(CONV, 'hello'), { conversation_id: CONV, resumed: false });
  const direct = calls.find(c => c.path === `/api/conversations/${CONV}/events`);
  assert.equal(direct.headers['X-Session-API-Key'], 'session-secret');
  assert.deepEqual(calls[calls.length - 1].body.content, [{ type: 'text', text: 'hello' }]);
});

test('sendMessage refuses a non-https agent-server URL', async () => {
  const calls = stub([
    { method: 'GET', path: '/api/v1/app-conversations', reply: [conv({ conversation_url: `http://sandbox.test/api/conversations/${CONV}` })] },
    { method: 'POST', path: `/api/v1/app-conversations/${CONV}/send-message`, reply: 'no such route', status: 404 },
  ]);
  await assert.rejects(oh.sendMessage(CONV, 'hello'), /non-https conversation URL/);
  assert.equal(calls.some(c => c.path === `/api/conversations/${CONV}/events`), false);
});

test('sendMessage carries on when the resume request times out but the sandbox comes up', async () => {
  let gets = 0;
  const calls = stub([
    { method: 'GET', path: '/api/v1/app-conversations', reply: () => [gets++ === 0 ? conv({ sandbox_status: 'PAUSED' }) : conv()] },
    { method: 'POST', path: `/api/v1/app-conversations/${CONV}/send-message`, reply: { success: true, sandbox_status: 'RUNNING' } },
  ]);
  const stubbed = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (new URL(String(url)).pathname === '/api/v1/sandboxes/sb1/resume') {
      calls.push({ method: 'POST', path: '/api/v1/sandboxes/sb1/resume' });
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    return stubbed(url, opts);
  };
  assert.deepEqual(await oh.sendMessage(CONV, 'hello'), { conversation_id: CONV, resumed: true });
  assert.equal(calls[calls.length - 1].path, `/api/v1/app-conversations/${CONV}/send-message`);
});

test('a timed-out request names the call', async () => {
  globalThis.fetch = async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
  await assert.rejects(oh.sendMessage(CONV, 'hello'), /OpenHands GET \/app-conversations timed out after 30 s/);
});

test('a sandbox that fails while resuming says the message was not sent', async () => {
  let gets = 0;
  stub([
    { method: 'GET', path: '/api/v1/app-conversations', reply: () => [gets++ === 0 ? conv({ sandbox_status: 'PAUSED' }) : conv({ sandbox_status: 'ERROR' })] },
    { method: 'POST', path: '/api/v1/sandboxes/sb1/resume', reply: { success: true } },
  ]);
  await assert.rejects(oh.sendMessage(CONV, 'hello'), /went to ERROR while starting; the message was not sent/);
});
