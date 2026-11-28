import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcp, TOOLS } from '../src/mcp.js';

const CONV = '50cbebe492564ea7899d24a87d57ff53';

function fakeOps(overrides = {}) {
  const sent = [];
  const ops = {
    summary: () => ({ text: 'no tasks\ncursor=0' }),
    wait: async () => ({ text: 'timeout (no change)\ncursor=0', cursor: 0, reason: 'timeout' }),
    steps: async () => ({ text: 'no steps' }),
    start: async () => ({ start_task_id: 'task-1', status: 'WORKING', repo: 'a/b', branch: 'main' }),
    send: async (id, message) => { sent.push({ id, message }); return { conversation_id: CONV, resumed: true, cursor: 42 }; },
    ...overrides,
  };
  return { ops, sent };
}

const call = async (mcp, msg) => (await mcp.handlePost(JSON.stringify(msg))).body;

test('tools/list includes send_message with the documented schema', async () => {
  const { ops } = fakeOps();
  const body = await call(createMcp(ops), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tool = body.result.tools.find(t => t.name === 'send_message');
  assert.ok(tool, 'send_message is listed');
  assert.deepEqual(tool.inputSchema.required, ['id', 'message']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(TOOLS.filter(t => t.name === 'send_message').length, 1);
});

test('tools/call send_message forwards the args and formats the reply', async () => {
  const { ops, sent } = fakeOps();
  const body = await call(createMcp(ops), {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'send_message', arguments: { id: CONV.slice(0, 8), message: 'commit and push, open the PR' } },
  });
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(sent, [{ id: CONV.slice(0, 8), message: 'commit and push, open the PR' }]);
  assert.equal(body.result.content[0].text,
    `sent to ${CONV} (resumed the sandbox first)\nNext: wait_for_tasks with ids=["${CONV}"] since=42`);
});

test('tools/call send_message without a message is an error', async () => {
  const { ops, sent } = fakeOps();
  const body = await call(createMcp(ops), {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'send_message', arguments: { id: CONV } },
  });
  assert.equal(body.result.isError, true);
  assert.equal(body.result.content[0].text, 'message is required');
  assert.equal(sent.length, 0);
});

test('tools/call send_message without an id is an error', async () => {
  const { ops } = fakeOps();
  const body = await call(createMcp(ops), {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'send_message', arguments: { message: 'hello' } },
  });
  assert.equal(body.result.isError, true);
  assert.equal(body.result.content[0].text, 'id is required');
});
