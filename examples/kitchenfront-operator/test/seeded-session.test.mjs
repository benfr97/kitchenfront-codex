import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedSeedOperation} from '../lib/seeded-session.mjs';

test('read deadline returns promptly without claiming an ignored callback has settled', async () => {
  const controller = new AbortController(); let release; let cleaned = 0;
  const operation = boundedSeedOperation(() => new Promise(resolve => { release = resolve; }), {controller, timeoutMs: 15, onSettled: () => { cleaned += 1; }});
  try {
    await assert.rejects(operation.response, {code: 'SEED_READ_INTERRUPTED_UNKNOWN'});
    assert.equal(controller.signal.aborted, true);
    assert.equal(operation.settled, false);
    assert.equal(cleaned, 0);
  } finally { release(); await operation.completion; }
  assert.equal(operation.settled, true); assert.equal(cleaned, 1);
});

test('an already aborted read never invokes its factory', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const operation = boundedSeedOperation(() => { calls += 1; }, {controller, timeoutMs: 15, onSettled: () => {}});
  await assert.rejects(operation.response, {code: 'SEED_READ_INTERRUPTED_UNKNOWN'});
  await operation.completion; assert.equal(calls, 0); assert.equal(operation.settled, true);
});

test('a completed read clears its deadline and reports settlement exactly once', async () => {
  const controller = new AbortController(); let cleaned = 0;
  const operation = boundedSeedOperation(async () => 'bounded result', {controller, timeoutMs: 30, onSettled: () => { cleaned += 1; }});
  assert.equal(await operation.response, 'bounded result'); await operation.completion;
  assert.equal(controller.signal.aborted, false); assert.equal(cleaned, 1);
});
