import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createPrototypeServer} from '../server.mjs';
import {currentStateFactory, publicDateContext} from '../lib/current-session.mjs';
import {SessionStore} from '../lib/store.mjs';
import {EXPECTED_PACKET_AGGREGATE, EXPECTED_SHOWROOM_PACK_SHA256, loadSealedPacket, TIME_ZONE} from '../lib/date-snapshot.mjs';

const SESSION_ID = '01a11111-b111-4111-8111-111111111111';
const PACKET_DIR = process.env.KITCHENFRONT_TWO_YEAR_PACKET_DIR;
const PINNED_TIME = '2027-06-14T08:00:00.000Z';

test('quotation age uses London calendar days across the autumn clock change', () => {
  const snapshot = {pinnedAt: '2026-10-25T23:30:00Z', cases: {quotation: {
    correspondence: [{createdAt: '2026-10-24T23:30:00Z'}], knownMissing: []
  }}};
  assert.equal(publicDateContext({snapshot}).cases.quotation.quoteAgeDays, 0);
});

function fixturePacket() {
  return {
    integrityVerified: true,
    sourceHash: EXPECTED_SHOWROOM_PACK_SHA256,
    aggregateSha256: EXPECTED_PACKET_AGGREGATE,
    manifestSha256: 'c'.repeat(64),
    seedId: 'KF-TEST-FICTIONAL-V1',
    horizon: {startDate: '2026-10-14', endDateExclusive: '2028-10-15'},
    pack: {
      schema: 'two-year-fictional-showroom-v1',
      seedId: 'KF-TEST-FICTIONAL-V1',
      mode: 'demo', simulated: true, sourceKind: 'synthetic_fixture', timezone: TIME_ZONE,
      horizon: {startDate: '2026-10-14', endDateExclusive: '2028-10-15'},
      rules: {weekdayHours: ['09:00', '17:00'], saturdayHours: ['10:00', '14:00'], sundayClosed: true,
        defaultConsultationMinutes: 60, appointmentGridMinutes: 30},
      contacts: [], customers: [], messages: [], events: []
    }
  };
}

async function harness(t, {packet = fixturePacket(), start = PINNED_TIME} = {}) {
  let nowMillis = new Date(start).getTime();
  const directory = mkdtempSync(join(tmpdir(), 'kf-current-session-test-'));
  const store = new SessionStore(directory, {now: () => nowMillis, stateFactory: currentStateFactory(packet)});
  const server = createPrototypeServer({store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, {recursive: true, force: true});
  });
  async function client() {
    const response = await fetch(`${origin}/api/session`);
    const session = await response.json();
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const get = (path = '/api/session') => fetch(`${origin}${path}`, {headers: {cookie}});
    const post = (path, body, headers = {}) => fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {cookie, origin, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, ...headers},
      body: JSON.stringify(body)
    });
    return {session, cookie, get, post};
  }
  return {client, setNow: value => { nowMillis = new Date(value).getTime(); }, store};
}

async function replay(client, scenario, requestId = randomUUID()) {
  const response = await client.post('/api/replay', {scenario, requestId});
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  return {requestId, events, result: events.at(-1)};
}

test('session date is pinned across reload and approval, then reset pins the advanced server clock', async t => {
  const {client, setNow} = await harness(t);
  const c = await client();
  const original = await (await c.get()).json();
  const pinned = original.dateContext;
  assert.equal(pinned.status, 'ready_offline');
  assert.equal(pinned.pinnedAt, PINNED_TIME);
  assert.equal(pinned.timeZone, TIME_ZONE);

  // Stay inside the server's eight-hour session lifetime while advancing its clock.
  setNow('2027-06-14T09:00:00.000Z');
  assert.deepEqual((await (await c.get()).json()).dateContext, pinned);

  const result = (await replay(c, 'reply')).result;
  assert.equal(result.type, 'turn.completed');
  const proposal = result.proposals[0];
  const approved = await c.post(`/api/proposals/${proposal.id}/decision`, {decision: 'approve', revision: proposal.revision});
  assert.equal(approved.status, 200);
  assert.equal((await (await c.get()).json()).dateContext.snapshotDigest, pinned.snapshotDigest);

  const resetResponse = await c.post('/api/reset', {});
  assert.equal(resetResponse.status, 200);
  const reset = await resetResponse.json();
  assert.notEqual(reset.generation, original.generation);
  assert.equal(reset.dateContext.pinnedAt, '2027-06-14T09:00:00.000Z');
  assert.notEqual(reset.dateContext.snapshotDigest, pinned.snapshotDigest);
  assert.deepEqual(reset.messages, []);
  assert.deepEqual(reset.proposals, []);
});

test('HTTP actions reject clock, session and packet overrides without mutating the pin', async t => {
  const {client} = await harness(t);
  const c = await client();
  const before = (await (await c.get()).json()).dateContext;
  const requestId = randomUUID();
  const replayOverride = await c.post('/api/replay', {
    scenario: 'reply', requestId, now: '2028-01-01T00:00:00Z', sessionId: SESSION_ID, packet: {horizon: {}}
  });
  assert.equal(replayOverride.status, 400);
  assert.equal((await replayOverride.json()).code, 'INVALID_REQUEST');

  const resetOverride = await c.post('/api/reset', {now: '2028-01-01T00:00:00Z', sessionId: SESSION_ID, packet: 'other'});
  assert.equal(resetOverride.status, 400);
  assert.equal((await resetOverride.json()).code, 'INVALID_REQUEST');

  const liveOverride = await c.post('/api/turns', {
    requestId: randomUUID(), question: 'Inspect the case', now: '2028-01-01T00:00:00Z', sessionId: SESSION_ID, packet: 'other'
  });
  assert.equal(liveOverride.status, 400);
  assert.equal((await liveOverride.json()).code, 'INVALID_REQUEST');
  assert.deepEqual((await (await c.get()).json()).dateContext, before);
  assert.deepEqual((await (await c.get()).json()).messages, []);
});

test('separate sessions have disjoint case sources and cannot decide each other’s proposals', async t => {
  const {client} = await harness(t);
  const a = await client();
  const b = await client();
  const aState = (await (await a.get()).json());
  const bState = (await (await b.get()).json());
  assert.notEqual(aState.generation, bState.generation);
  assert.equal(aState.dateContext.snapshotDigest, bState.dateContext.snapshotDigest);

  const aResult = (await replay(a, 'reply')).result;
  const bResult = (await replay(b, 'reply')).result;
  const aProposal = aResult.proposals[0];
  const bProposal = bResult.proposals[0];
  assert.equal(aProposal.generation, aState.generation);
  assert.equal(bProposal.generation, bState.generation);
  assert.equal(aProposal.sourceIds.some(id => bProposal.sourceIds.includes(id)), false);

  const foreignDecision = await b.post(`/api/proposals/${aProposal.id}/decision`, {decision: 'approve', revision: aProposal.revision});
  assert.equal(foreignDecision.status, 404);
  assert.equal((await (await a.get()).json()).proposals[0].status, 'pending');
  assert.equal((await (await b.get()).json()).proposals[0].id, bProposal.id);
  const ownDecision = await a.post(`/api/proposals/${aProposal.id}/decision`, {decision: 'approve', revision: aProposal.revision});
  assert.equal(ownDecision.status, 200);
  assert.equal((await ownDecision.json()).proposal.status, 'approved');
  assert.equal((await (await b.get()).json()).proposals[0].status, 'pending');
});

test('horizon exhaustion is visible and replay fails without a fallback case', async t => {
  const {client} = await harness(t, {start: '2028-10-15T08:00:00.000Z'});
  const c = await client();
  const state = await (await c.get()).json();
  assert.equal(state.dateContext.status, 'horizon_exhausted');
  assert.equal(state.dateContext.coverage.noFallback, true);

  const run = await replay(c, 'reply');
  assert.equal(run.result.type, 'turn.failed');
  assert.equal(run.result.code, 'HORIZON_EXHAUSTED');
  const after = await (await c.get()).json();
  assert.equal(after.proposals.length, 0);
  assert.equal(after.messages.some(item => item.role === 'assistant'), false);
});

test('Casey replay selects an available alternative and approval rechecks a newly occupied slot', async t => {
  const {client, store} = await harness(t);
  const c = await client();
  const run = (await replay(c, 'consultation')).result;
  assert.equal(run.type, 'turn.completed');
  const proposal = run.proposals[0];
  assert.equal(proposal.kind, 'consultation');
  assert.equal(proposal.start, '2027-06-16T11:00:00+01:00');

  const token = c.cookie.slice('kf_demo='.length);
  const session = store.get(token);
  session.state.appointments.push({id: randomUUID(), start: proposal.start, end: proposal.end,
    timeZone: proposal.timeZone, calendar: proposal.calendar, simulated: true});
  store.save(session);

  const decision = await c.post(`/api/proposals/${proposal.id}/decision`, {decision: 'approve', revision: proposal.revision});
  assert.equal(decision.status, 200);
  const result = (await decision.json()).proposal;
  assert.equal(result.status, 'conflict');
  assert.match(result.result, /slot became occupied/i);
  const after = await (await c.get()).json();
  assert.equal(after.proposals[0].status, 'conflict');
  assert.equal(store.get(token).state.appointments.length, 1);
});

test('configured sealed packet drives the HTTP snapshot and current case flow', {skip: !PACKET_DIR}, async t => {
  const packet = await loadSealedPacket(PACKET_DIR, EXPECTED_PACKET_AGGREGATE);
  const {client} = await harness(t, {packet, start: new Date().toISOString()});
  const c = await client();
  const state = await (await c.get()).json();
  assert.equal(state.dateContext.sourceHash, packet.sourceHash);
  assert.equal(state.dateContext.timeZone, TIME_ZONE);
  assert.ok(['ready_offline', 'horizon_exhausted'].includes(state.dateContext.status));
  if (state.dateContext.status === 'ready_offline') {
    const run = (await replay(c, 'reply')).result;
    assert.equal(run.type, 'turn.completed');
    assert.equal(run.proposals[0].mode, 'offline_replay');
    assert.ok(run.proposals[0].sourceIds.every(id => id.includes(state.generation)));
  } else {
    const run = (await replay(c, 'reply')).result;
    assert.equal(run.type, 'turn.failed');
    assert.equal(run.code, 'HORIZON_EXHAUSTED');
  }
});
