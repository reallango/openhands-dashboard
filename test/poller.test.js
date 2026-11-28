import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ohd-test-'));
process.env.OPENHANDS_API_BASE = 'https://api.example.test/api/v1';
process.env.OPENHANDS_API_KEY = 'test-key';
const { q } = await import('../src/db.js');
const { applyConv, noteMessageSent } = await import('../src/poller.js');

const finished = id => ({ id, sandbox_status: 'RUNNING', execution_status: 'finished', updated_at: '2026-01-01T00:00:00Z' });
const statusChanges = (id, since) => q.changesSince.all(since).filter(c => c.task_id === id && c.what === 'status').map(c => `${c.old}->${c.new}`);
const iso = ms => new Date(ms).toISOString();

test('a follow-up that runs and finishes between two polls still records running -> finished', () => {
  const id = 'aaaaaaaa000000000000000000000001';
  applyConv(finished(id));
  const before = q.maxChange.get().seq;
  noteMessageSent(id);
  const cursor = q.maxChange.get().seq;
  assert.deepEqual(statusChanges(id, before), ['finished->running']);
  assert.equal(q.getConv.get(id).status, 'running');

  // The next poll still sees "finished" and no agent event after the message yet: the old state, keep "running".
  applyConv(finished(id));
  assert.equal(q.getConv.get(id).status, 'running');
  assert.deepEqual(statusChanges(id, cursor), []);

  // The agent answered: now "finished" is real and is a change after the cursor.
  q.insertEvent.run(id, 'ev1', iso(Date.now()), 'MessageEvent', 'agent', null, 'Agent message', 'ack', 0);
  applyConv(finished(id));
  assert.equal(q.getConv.get(id).status, 'finished');
  assert.deepEqual(statusChanges(id, cursor), ['running->finished']);
});

test('an error from OpenHands is not held back', () => {
  const id = 'aaaaaaaa000000000000000000000002';
  applyConv(finished(id));
  noteMessageSent(id);
  const cursor = q.maxChange.get().seq;
  applyConv({ ...finished(id), sandbox_status: 'ERROR' });
  assert.deepEqual(statusChanges(id, cursor), ['running->error']);
});

test('an agent event from before the message does not end the hold', () => {
  const id = 'aaaaaaaa000000000000000000000003';
  applyConv(finished(id));
  q.insertEvent.run(id, 'old', iso(Date.now() - 60_000), 'MessageEvent', 'agent', null, 'Agent message', 'done', 0);
  noteMessageSent(id);
  applyConv(finished(id));
  assert.equal(q.getConv.get(id).status, 'running');
});
