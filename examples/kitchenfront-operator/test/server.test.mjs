import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, statSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {createPrototypeServer} from '../server.mjs';
import {SessionStore} from '../lib/store.mjs';

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kf-fork-test-'));
  const store = new SessionStore(directory); const server = createPrototypeServer({store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, {recursive: true}); });
  async function client() {
    const response = await fetch(`${origin}/api/session`); const session = await response.json(); const cookie = response.headers.get('set-cookie').split(';')[0];
    const get = () => fetch(`${origin}/api/session`, {headers: {cookie}}).then(r => r.json());
    const post = (path, body, headers = {}) => fetch(`${origin}${path}`, {method: 'POST', headers: {cookie, origin, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, ...headers}, body: JSON.stringify(body)});
    return {session, cookie, get, post};
  }
  return {directory, store, origin, client};
}
const replay = async (client, scenario, requestId = randomUUID()) => {
  const response = await client.post('/api/replay', {scenario, requestId}); assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  return {events, requestId, result: events.at(-1)};
};
test('local API rejects cross-origin, wrong CSRF and arbitrary RPC; never starts live inference', async t => {
  const {client, origin} = await harness(t); const c = await client();
  assert.equal(c.session.liveEnabled, false); assert.equal(c.session.engine.status, 'not_verified');
  assert.equal((await c.post('/api/reset', {}, {origin: 'https://evil.example'})).status, 403);
  assert.equal((await c.post('/api/reset', {}, {'x-csrf-token': 'wrong'})).status, 403);
  assert.equal((await c.post('/api/reset', {}, {origin: ''})).status, 403);
  assert.equal((await c.post('/api/rpc', {method: 'thread/shellCommand'})).status, 404);
  const live = await c.post('/api/turns', {question: 'Run a live test', requestId: randomUUID()});
  assert.equal(live.status, 503); assert.equal((await live.json()).code, 'LIVE_AI_DISABLED'); assert.deepEqual((await c.get()).messages, []);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = request(`${origin}/api/session`, {headers: {host: 'untrusted.example'}}, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${origin}/server.mjs`)).status, 404);
});
test('HTTP replay is labelled, persisted and deduplicated; exact approvals affect only its own session', async t => {
  const {client, store, directory} = await harness(t); const a = await client(); const b = await client();
  const {events, result, requestId} = await replay(a, 'reply');
  assert.equal(result.type, 'turn.completed'); assert.ok(events.every(item => item.mode === 'offline_replay'));
  assert.equal(result.usage, null); assert.equal(events.filter(item => item.type === 'tool.completed').length, 2);
  const p = result.proposals[0]; assert.equal((await b.post(`/api/proposals/${p.id}/decision`, {decision: 'approve', revision: p.revision})).status, 404);
  assert.equal((await a.post(`/api/proposals/${p.id}/decision`, {decision: 'approve', revision: 'old'})).status, 409);
  const approve = () => a.post(`/api/proposals/${p.id}/decision`, {decision: 'approve', revision: p.revision}).then(r => r.json());
  assert.equal((await approve()).proposal.status, 'approved'); assert.equal((await approve()).replayed, true);
  assert.equal((await a.get()).activity.filter(x => x.kind === 'decision').length, 1);
  const duplicate = await a.post('/api/replay', {scenario: 'reply', requestId}); assert.equal(duplicate.status, 409);
  assert.equal((await a.get()).messages.length, 2); assert.equal((await b.get()).messages.length, 0);
  const restarted = new SessionStore(directory); const token = a.cookie.split('=')[1];
  assert.equal(restarted.get(token).state.proposals[0].status, 'approved'); assert.equal(restarted.get(token).state.messages.length, 2);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const file of readdirSync(directory)) assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
  assert.equal(store.get(token).state.proposals[0].recipient, 'alex@example.com');
});
test('reset invalidates old proposals and approval rechecks occupied fictional slots', async t => {
  const {client} = await harness(t); const c = await client();
  const first = (await replay(c, 'consultation')).result.proposals[0];
  assert.equal((await c.post(`/api/proposals/${first.id}/decision`, {decision: 'approve', revision: first.revision})).status, 200);
  const second = await replay(c, 'consultation'); assert.equal(second.result.type, 'turn.failed'); assert.equal(second.result.code, 'SLOT_CONFLICT');
  assert.equal((await c.get()).proposals.length, 1);
  const reset = await c.post('/api/reset', {}); assert.equal(reset.status, 200);
  assert.equal((await c.get()).proposals.length, 0);
  assert.equal((await c.post(`/api/proposals/${first.id}/decision`, {decision: 'approve', revision: first.revision})).status, 404);
});
test('invalid payloads and oversized requests do not change saved state', async t => {
  const {client} = await harness(t); const c = await client();
  for (const payload of [{scenario: 'reply'}, {scenario: 'reply', requestId: randomUUID(), tools: []}, {scenario: 'real-mailbox', requestId: randomUUID()}]) assert.equal((await c.post('/api/replay', payload)).status, 400);
  assert.equal((await c.post('/api/reset', {}, {'content-type': 'text/plain'})).status, 415);
  assert.equal((await c.post('/api/turns', {requestId: randomUUID(), question: 'x'.repeat(9000)})).status, 413);
  assert.equal((await c.get()).messages.length, 0);
});
test('unfinished persisted request is UNKNOWN after restart, not retried or declared complete', async t => {
  const {store, directory} = await harness(t); const session = store.create();
  session.state.requests.run = {status: 'running'}; session.state.activity.push({kind: 'turn', status: 'running'}); store.save(session);
  const restarted = new SessionStore(directory); const saved = restarted.get(session.token);
  assert.equal(saved.state.requests.run.status, 'unknown'); assert.equal(saved.state.activity[0].status, 'unknown');
  const file = readdirSync(directory).find(name => JSON.parse(readFileSync(join(directory, name))).token === session.token);
  assert.equal(JSON.parse(readFileSync(join(directory, file))).state.requests.run.status, 'unknown');
});
