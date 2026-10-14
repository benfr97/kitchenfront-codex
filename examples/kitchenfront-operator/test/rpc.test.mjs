import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {AppServerRpc, isolatedEngineEnvironment} from '../lib/rpc.mjs';
import {runCodexTurn, startDemoThread, MODEL} from '../lib/codex-turn.mjs';
import {freshState, getCase} from '../lib/fixtures.mjs';

class FakeProcess extends EventEmitter {
  constructor(handler = () => {}) {
    super(); this.stdout = new PassThrough(); this.sent = [];
    this.stdin = new Writable({write: (chunk, encoding, callback) => {
      for (const line of chunk.toString().trim().split('\n')) { const message = JSON.parse(line); this.sent.push(message); queueMicrotask(() => handler(message, this)); }
      callback();
    }});
  }
  send(message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill() { this.killed = true; this.emit('exit', 0); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('oversized unterminated input is bounded before JSON parsing and closes only its owned child', () => {
  const child = new FakeProcess(); const peer = new AppServerRpc(child); let error;
  peer.on('closed', value => { error = value; }); child.stdout.write(Buffer.alloc(1_000_001, 65));
  assert.equal(error.code, 'MESSAGE_LIMIT'); assert.equal(child.killed, true);
});
test('phone RPC allowlist refuses arbitrary shell and process methods before writing to engine', async () => {
  const child = new FakeProcess(); const peer = new AppServerRpc(child);
  for (const method of ['thread/shellCommand', 'command/exec', 'process/spawn', 'account/login/start']) await assert.rejects(peer.request(method, {}), {code: 'RPC_NOT_ALLOWED'});
  assert.equal(child.sent.length, 0); peer.close();
});
test('fragmented JSONL initialization is parsed, followed by exactly one initialized notification', async () => {
  const child = new FakeProcess((message, process) => {
    if (message.method === 'initialize') { const text = JSON.stringify({id: message.id, result: {userAgent: 'mock-only'}}); process.stdout.write(text.slice(0, 8)); process.stdout.write(`${text.slice(8)}\n`); }
  });
  const peer = new AppServerRpc(child); assert.equal((await peer.initialize()).userAgent, 'mock-only'); await tick();
  assert.equal(child.sent.filter(item => item.method === 'initialized').length, 1); peer.close();
});
test('server request replay does not run a tool twice; changed payload under same ID closes connection', async () => {
  const child = new FakeProcess(); let calls = 0;
  const peer = new AppServerRpc(child, {requestHandler: async () => { calls++; return {contentItems: [], success: true}; }});
  const message = {id: 90, method: 'item/tool/call', params: {tool: 'get_demo_case'}};
  child.send(message); child.send(message); await tick(); assert.equal(calls, 1); assert.equal(child.sent.length, 2);
  let error; peer.on('closed', value => { error = value; }); child.send({...message, params: {tool: 'exec_command'}}); await tick();
  assert.equal(error.code, 'RPC_ID_CONFLICT'); peer.close();
});
test('server-initiated shell API is refused without calling the application handler', async () => {
  let calls = 0; const child = new FakeProcess(); const peer = new AppServerRpc(child, {requestHandler: async () => { calls++; }});
  child.send({id: 5, method: 'thread/shellCommand', params: {command: 'pwd'}}); await tick();
  assert.equal(calls, 0); assert.equal(child.sent[0].error.code, -32601); peer.close();
});
test('isolated child environment omits existing credentials and desktop configuration variables', () => {
  const result = isolatedEngineEnvironment('/tmp/fictional-codex-runtime');
  assert.equal(result.CODEX_HOME, '/tmp/fictional-codex-runtime'); assert.equal(result.KITCHENFRONT_CODEX_DYNAMIC_ONLY, '1');
  assert.equal(result.OPENAI_API_KEY, undefined); assert.equal(result.HOME, undefined); assert.equal(result.CODEX_THREAD_ID, undefined);
});
test('thread setup binds the fixed catalogue and exact model; mismatched model rejects', async () => {
  let sent;
  const peer = {request: async (method, params) => { sent = {method, params}; return {thread: {id: 'owned-thread'}, model: MODEL}; }};
  assert.equal(await startDemoThread(peer, '/tmp/fixture'), 'owned-thread');
  assert.deepEqual(sent.params.dynamicTools.map(item => item.name), ['get_demo_case', 'prepare_demo_proposal']);
  assert.equal(sent.params.allowProviderModelFallback, false);
  await assert.rejects(startDemoThread({request: async () => ({thread: {id: 'other'}, model: 'other'})}, '/tmp/fixture'), {code: 'ENGINE_BINDING'});
});

class TurnPeer extends EventEmitter {
  constructor() { super(); this.calls = []; }
  setRequestHandler(handler) { this.handler = handler; }
  async request(method, params) { this.calls.push({method, params}); return method === 'turn/start' ? {turn: {id: 'turn-owned'}} : {}; }
  event(method, params = {}) { this.emit('notification', {method, params: {threadId: 'thread-owned', turnId: 'turn-owned', ...params}}); }
}
const launch = (peer, state, extra = {}) => runCodexTurn(peer, {threadId: 'thread-owned', state, requestId: 'request-owned', question: 'Prepare Alex’s fictional reply.', ...extra});
test('mock wire run stages source-bound proposals without mutating committed session; accepts only completed turn', async () => {
  const peer = new TurnPeer(); const state = freshState(); const events = []; const result = launch(peer, state, {emit: item => events.push(item)}); await tick();
  await assert.rejects(peer.handler({threadId: 'other-thread', turnId: 'turn-owned', tool: 'get_demo_case', arguments: {caseId: 'reply'}}), {code: 'TOOL_SCOPE'});
  const source = await peer.handler({threadId: 'thread-owned', turnId: 'turn-owned', callId: 'read', tool: 'get_demo_case', arguments: {caseId: 'reply'}});
  assert.equal(source.success, true); const fixture = getCase(state, 'reply');
  const prepared = await peer.handler({threadId: 'thread-owned', turnId: 'turn-owned', callId: 'proposal', tool: 'prepare_demo_proposal', arguments: {caseId: 'reply', recipient: fixture.lead.email, subject: 'Your kitchen enquiry', body: 'Hello Alex, what budget and timing do you have in mind?', sourceIds: fixture.sourceIds}});
  assert.equal(prepared.success, true); assert.equal(state.proposals.length, 0);
  peer.event('item/agentMessage/delta', {delta: 'Your fictional reply is ready for review.'}); peer.event('turn/completed', {turn: {id: 'turn-owned', status: 'completed'}});
  const completed = await result; assert.equal(completed.proposals.length, 1); assert.equal(completed.proposals[0].status, 'pending'); assert.equal(completed.usage, null);
  assert.equal(state.proposals.length, 0); assert.equal(events.filter(item => item.type === 'tool.completed').length, 2);
});
test('Stop retains uncertainty and interrupts exact turn; partial staged work does not commit', async () => {
  const peer = new TurnPeer(); const state = freshState(); const controller = new AbortController(); const result = launch(peer, state, {signal: controller.signal}); await tick();
  controller.abort(); await assert.rejects(result, {code: 'TURN_STOPPED_UNKNOWN'});
  assert.deepEqual(peer.calls.find(item => item.method === 'turn/interrupt').params, {threadId: 'thread-owned', turnId: 'turn-owned'});
  assert.equal(state.proposals.length, 0);
});
test('unexpected native tool, missing completion and time limit never become a successful answer', async () => {
  const forbidden = new TurnPeer(); const attempt = launch(forbidden, freshState()); await tick(); forbidden.event('item/started', {item: {type: 'commandExecution'}}); await assert.rejects(attempt, {code: 'UNEXPECTED_ENGINE_TOOL'});
  const missing = new TurnPeer(); const incomplete = launch(missing, freshState()); await tick(); missing.event('turn/completed', {turn: {id: 'turn-owned', status: 'completed'}}); await assert.rejects(incomplete, {code: 'INCOMPLETE_ENGINE_RESULT'});
  const timeout = new TurnPeer(); await assert.rejects(launch(timeout, freshState(), {maxDurationMs: 5}), {code: 'TURN_TIMEOUT_UNKNOWN'});
});
