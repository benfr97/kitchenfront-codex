import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createPrototypeServer} from '../server.mjs';
import {currentStateFactory} from '../lib/current-session.mjs';
import {SessionStore} from '../lib/store.mjs';
import {
  createSeededReader,
  isSeededReader,
  EXPECTED_DEMO_ACCOUNT_EMAIL,
  SEEDED_ADMISSION_EVIDENCE_CONTRACT,
  SEEDED_ADMISSION_EVIDENCE_STATUS,
  SEEDED_READ_LIMITS,
  SEEDED_READ_GUARDS,
  SEEDED_READER_CONTRACT,
  SeededReaderError,
  seededContentSha256,
} from '../lib/seeded-reader.mjs';
import {
  EXPECTED_PACKET_AGGREGATE,
  EXPECTED_SHOWROOM_PACK_SHA256,
  TIME_ZONE,
} from '../lib/date-snapshot.mjs';

const PINNED = Date.parse('2026-10-14T08:00:00.000Z');
const RECEIPT_EXPIRY = '2026-10-15T08:00:00.000Z';
const REVIEW = Object.freeze({
  mailRead: {enabled: true, reviewRef: 'review:fictional-mail-read-v1', reviewSha256: 'a'.repeat(64)},
  calendarRead: {
    enabled: true,
    reviewRef: 'review:fictional-google-calendar-read-v1',
    reviewSha256: 'b'.repeat(64),
    crossClient: true,
    crossClientReviewRef: 'review:fictional-google-cross-client-calendar-v1',
    crossClientReviewSha256: 'c'.repeat(64),
  },
  mailWrite: false,
  calendarWrite: false,
  send: false,
});

function canonical(value) {
  const sort = item => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item;
  return JSON.stringify(sort(value)).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeFixture({
  provider = 'google',
  expiry = RECEIPT_EXPIRY,
  acceptedAt = '2026-10-14T07:00:00.000Z',
  mutateReceipt,
  sessionId = '00000000-0000-4000-8000-000000000014',
  clock = () => PINNED,
  actorId = 'fixture-actor-ben-demo',
  organizationId = 'fixture-org-kitchen-front',
  mailResourceId,
  calendarResourceId,
  mailIsDefault = false,
  calendarIsDefault = false,
  calendarStart = '2026-10-15T10:00:00.000Z',
  calendarEnd = '2026-10-15T10:30:00.000Z',
  mutateAdmissionEvidence,
} = {}) {
  const accountEmail = EXPECTED_DEMO_ACCOUNT_EMAIL[provider];
  const resource = provider === 'google'
    ? {
      mail: {kind: 'label', id: mailResourceId ?? 'fixture-label-kf-demo', name: 'Kitchen Front Demo', revision: 'label-r7', isDefault: mailIsDefault},
      calendar: {kind: 'app_created_secondary', id: calendarResourceId ?? 'fixture-calendar-kf-demo', name: 'Kitchen Front Demo', revision: 'calendar-r4', isDefault: calendarIsDefault},
    }
    : {
      mail: {kind: 'folder', id: mailResourceId ?? 'fixture-folder-kf-demo', name: 'Kitchen Front Demo', revision: 'folder-r3', isDefault: mailIsDefault},
      calendar: {kind: 'app_created_secondary', id: calendarResourceId ?? 'fixture-calendar-outlook-kf-demo', name: 'Kitchen Front Demo', revision: 'calendar-r2', isDefault: calendarIsDefault},
    };
  const binding = {
    actorId,
    organizationId,
    sessionId,
    provider,
    accountEmail,
    subjectId: `fixture-${provider}-subject`,
    accountId: `fixture-${provider}-account`,
    clientId: `fixture-${provider}-client`,
    grantId: `fixture-${provider}-grant`,
    grantRevision: 'grant-r5',
    resource,
    sourceAggregateSha256: EXPECTED_PACKET_AGGREGATE,
    seedRevision: 'fixture-seed-r12',
  };
  const capabilities = provider === 'google' ? REVIEW : {
    ...REVIEW,
    calendarRead: {
      enabled: true,
      reviewRef: 'review:fictional-outlook-calendar-v1',
      reviewSha256: 'b'.repeat(64),
      crossClient: false,
      crossClientReviewRef: null,
      crossClientReviewSha256: null,
    },
  };
  const content = provider === 'google'
    ? {
      mail: [
        {
          receivedAt: '2026-10-13T15:30:00.000Z', direction: 'incoming',
          from: 'robin@example.test', to: accountEmail, subject: 'Shaker kitchen quotation',
          body: 'Could you follow up on the quotation?', labelIds: [resource.mail.id, 'fixture-secondary-label'],
        },
        {
          receivedAt: '2026-10-13T16:10:00.000Z', direction: 'incoming',
          from: 'alex@example.test', to: accountEmail, subject: 'Kitchen enquiry with an island',
          body: 'Please reply about our island enquiry.', labelIds: [resource.mail.id, 'fixture-secondary-label'],
        },
      ],
      calendar: [{
        calendarId: resource.calendar.id,
        start: calendarStart, end: calendarEnd,
        title: 'Casey consultation', status: 'confirmed', busy: true,
      }],
    }
    : {
      mail: [{
        receivedAt: '2026-10-13T15:30:00.000Z', direction: 'incoming',
        from: 'robin@example.test', to: accountEmail, subject: 'Shaker kitchen quotation',
        body: 'Could you follow up on the quotation?', parentFolderId: resource.mail.id,
      }],
      calendar: [{
        calendarId: resource.calendar.id,
        start: calendarStart, end: calendarEnd,
        title: 'Casey consultation', status: 'confirmed', busy: true,
      }],
    };
  const allSeeds = [
    ...content.mail.map((row, index) => ({
      fixtureId: ['robin-quotation-followup', 'alex-customer-reply'][index],
      source: 'mail', providerRecordId: `fixture-${provider}-mail-${index + 1}`,
      version: `message-v${index + 2}`, contentSha256: seededContentSha256(row), receivedAt: row.receivedAt,
    })),
    ...content.calendar.map((row, index) => ({
      fixtureId: 'casey-consultation-availability', source: 'calendar',
      providerRecordId: `fixture-${provider}-event-${index + 1}`,
      version: 'event-v3', contentSha256: seededContentSha256(row), start: row.start, end: row.end,
    })),
  ];
  const receipt = {
    schema: SEEDED_READER_CONTRACT,
    status: 'accepted_demo_seed',
    acceptedAt,
    expiresAt: expiry,
    binding,
    seedLedger: allSeeds,
    guards: structuredClone(SEEDED_READ_GUARDS),
    capabilities,
    broker: {
      contract: SEEDED_READER_CONTRACT,
      requestMode: 'read_exact_approved_provider_ids',
      responseMode: 'complete_exact_provider_records',
      readOnly: true,
      supportsWideQueries: false,
      supportsWrites: false,
      supportsFallback: false,
    },
  };
  if (mutateReceipt) mutateReceipt(receipt);
  const acceptedReceiptBytes = Buffer.from(JSON.stringify(receipt), 'utf8');
  const admissionEvidence = {
    schema: SEEDED_ADMISSION_EVIDENCE_CONTRACT,
    status: SEEDED_ADMISSION_EVIDENCE_STATUS,
    binding,
    resources: binding.resource,
    resourceReview: {
      reviewRef: 'review:fictional-dedicated-resources-v1',
      sha256: 'd'.repeat(64),
      resourceSha256: seededContentSha256(binding.resource),
    },
    guardReview: {
      reviewRef: 'review:fictional-restricted-guards-v1',
      sha256: 'e'.repeat(64),
      guardsSha256: seededContentSha256(SEEDED_READ_GUARDS),
    },
    capabilitiesSha256: seededContentSha256(capabilities),
    crossClientCalendarBrokerReview: provider === 'google' ? {
      reviewRef: capabilities.calendarRead.crossClientReviewRef,
      sha256: capabilities.calendarRead.crossClientReviewSha256,
      provider: 'google',
      accountEmail,
      subjectId: binding.subjectId,
      accountId: binding.accountId,
      clientId: binding.clientId,
      grantId: binding.grantId,
      grantRevision: binding.grantRevision,
      resourceId: binding.resource.calendar.id,
      resourceRevision: binding.resource.calendar.revision,
    } : null,
  };
  if (mutateAdmissionEvidence) mutateAdmissionEvidence(admissionEvidence);
  const admissionEvidenceBytes = Buffer.from(JSON.stringify(admissionEvidence), 'utf8');
  const bySource = {
    mail: content.mail.map((row, index) => ({
      providerRecordId: allSeeds.filter(seed => seed.source === 'mail')[index].providerRecordId,
      version: allSeeds.filter(seed => seed.source === 'mail')[index].version,
      content: row,
    })),
    calendar: content.calendar.map((row, index) => ({
      providerRecordId: allSeeds.filter(seed => seed.source === 'calendar')[index].providerRecordId,
      version: allSeeds.filter(seed => seed.source === 'calendar')[index].version,
      content: row,
    })),
  };
  const brokerCalls = [];
  const broker = async request => {
    brokerCalls.push(request);
    const records = structuredClone(bySource[request.source]);
    return {
      status: 'ok',
      scope: {binding: structuredClone(binding), receiptSha256: hash(acceptedReceiptBytes), capabilities: structuredClone(capabilities)},
      coverage: {
        source: request.source,
        queryMode: 'exact_approved_ids',
        requestedCount: request.providerRecordIds.length,
        returnedCount: records.length,
        hasMore: false,
        nextCursor: null,
      },
      records,
    };
  };
  const create = (overrides = {}) => createSeededReader({
    binding: structuredClone(binding),
    acceptedReceiptBytes,
    expectedReceiptSha256: hash(acceptedReceiptBytes),
    admissionEvidenceBytes,
    expectedAdmissionEvidenceSha256: hash(admissionEvidenceBytes),
    capabilities: structuredClone(capabilities),
    broker,
    clock,
    ...overrides,
  });
  return {binding, capabilities, acceptedReceiptBytes, admissionEvidenceBytes, receipt, bySource, broker, brokerCalls, create};
}

function brokerResult(request, fixture, records, overrides = {}) {
  return {
    status: 'ok',
    scope: {
      binding: structuredClone(fixture.binding),
      receiptSha256: hash(fixture.acceptedReceiptBytes),
      capabilities: structuredClone(fixture.capabilities),
    },
    coverage: {
      source: request.source,
      queryMode: 'exact_approved_ids',
      requestedCount: request.providerRecordIds.length,
      returnedCount: records.length,
      hasMore: false,
      nextCursor: null,
    },
    records: structuredClone(records),
    ...overrides,
  };
}

function currentPacket() {
  const horizon = {startDate: '2026-10-14', endDateExclusive: '2028-10-15'};
  return {
    integrityVerified: true,
    sourceHash: EXPECTED_SHOWROOM_PACK_SHA256,
    aggregateSha256: EXPECTED_PACKET_AGGREGATE,
    manifestSha256: 'c'.repeat(64),
    seedId: 'KF-TEST-FICTIONAL-V1',
    horizon,
    pack: {
      schema: 'two-year-fictional-showroom-v1',
      seedId: 'KF-TEST-FICTIONAL-V1',
      mode: 'demo',
      simulated: true,
      sourceKind: 'synthetic_fixture',
      timezone: TIME_ZONE,
      horizon,
      rules: {
        weekdayHours: ['09:00', '17:00'],
        saturdayHours: ['10:00', '14:00'],
        sundayClosed: true,
        defaultConsultationMinutes: 60,
        appointmentGridMinutes: 30,
      },
      contacts: [],
      customers: [],
      messages: [],
      events: [],
    },
  };
}

async function seededHttpHarness(t, {
  seededReadersForSession,
  seededPrincipal = {actorId: 'fixture-actor-ben-demo', organizationId: 'fixture-org-kitchen-front'},
  seedReadTimeoutMs = 15_000,
} = {}) {
  let nowMillis = PINNED;
  const directory = mkdtempSync(join(tmpdir(), 'kf-seeded-reader-test-'));
  const store = new SessionStore(directory, {
    now: () => nowMillis,
    stateFactory: currentStateFactory(currentPacket()),
  });
  const server = createPrototypeServer({store, seededReadersForSession, seededPrincipal, seedReadTimeoutMs});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let closePromise;
  async function closeServer() {
    if (!closePromise) {
      server.closeAllConnections();
      closePromise = new Promise(resolve => server.close(resolve));
    }
    await closePromise;
  }
  async function finishCleanup() {
    await closeServer();
    await server.waitForSeededCleanup();
    rmSync(directory, {recursive: true, force: true});
  }
  t.after(async () => {
    await finishCleanup();
  });
  async function client() {
    const response = await fetch(`${origin}/api/session`);
    const state = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const get = () => fetch(`${origin}/api/session`, {headers: {cookie}}).then(value => value.json());
    const post = (path, body, headers = {}) => fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {cookie, origin, 'content-type': 'application/json', 'x-csrf-token': state.csrfToken, ...headers},
      body: JSON.stringify(body),
    });
    return {state, cookie, get, post};
  }
  const createStore = () => new SessionStore(directory, {
    now: () => nowMillis,
    stateFactory: currentStateFactory(currentPacket()),
  });
  function expireSessionSoon(token, delayMs) {
    const session = store.get(token);
    assert.ok(session, 'test session must still be current before shortening its local expiry');
    session.expiresAt = store.now() + delayMs;
    store.save(session);
  }
  return {
    client,
    directory,
    createStore,
    closeServer,
    finishCleanup,
    expireSessionSoon,
    cacheSize: () => server.seededReaderCacheSize(),
    waitForCleanup: () => server.waitForSeededCleanup(),
    setNow: value => { nowMillis = new Date(value).getTime(); },
  };
}

async function waitForProviderReadState(client, expected, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await client.get();
    if (state.providerReadState === expected) return state;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`Provider read state did not become ${expected}.`);
}

async function waitForReaderCacheSize(harness, expected, attempts = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (harness.cacheSize() === expected) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`Seeded reader cache did not reach size ${expected}.`);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function readersForSession({sessionId, clock, principal}, {wrongMicrosoftSession = false, failingProvider = null, brokerOverride} = {}) {
  return ['google', 'microsoft'].map(provider => {
    const bindingSession = provider === 'microsoft' && wrongMicrosoftSession
      ? '00000000-0000-4000-8000-000000000099'
      : sessionId;
    const fixture = makeFixture({
      provider,
      sessionId: bindingSession,
      clock,
      actorId: principal?.actorId,
      organizationId: principal?.organizationId,
    });
    let broker = fixture.broker;
    if (provider === failingProvider) broker = async () => { throw new Error('synthetic provider transport failure'); };
    if (brokerOverride) broker = brokerOverride({provider, fixture, original: broker});
    return fixture.create({broker, clock});
  });
}

test('reads only the three fictional demo seeds through exact bounded Google requests', async () => {
  const fixture = makeFixture();
  const result = await fixture.create().readAcceptedSeeds();
  assert.equal(result.status, 'provider_seed_readback');
  assert.equal(result.sourceKind, 'provider_seed_readback');
  assert.equal(result.coverageBasis, 'bounded_accepted_seed_view');
  assert.equal(result.overallSourceCoverage, 'UNKNOWN');
  assert.equal(result.provider, 'google');
  assert.equal(result.accountEmail, EXPECTED_DEMO_ACCOUNT_EMAIL.google);
  assert.equal(result.sourceAggregateSha256, EXPECTED_PACKET_AGGREGATE);
  assert.deepEqual(result.mail.records.map(record => record.fixtureId), ['robin-quotation-followup', 'alex-customer-reply']);
  assert.deepEqual(result.calendar.records.map(record => record.fixtureId), ['casey-consultation-availability']);
  assert.equal(result.mail.records[0].provenance.sourceKind, 'provider_seed_readback');
  assert.equal(result.mail.records[0].provenance.resourceId, fixture.binding.resource.mail.id);
  assert.equal(result.sessionScope.sessionId, fixture.binding.sessionId);
  assert.equal(result.sessionScope.actorId, fixture.binding.actorId);
  assert.equal(result.sessionScope.grantRevision, fixture.binding.grantRevision);
  assert.equal(result.sessionScope.subjectId, fixture.binding.subjectId);
  assert.equal(result.sessionScope.clientId, fixture.binding.clientId);
  assert.deepEqual(result.sessionScope, fixture.create().admissionScope);
  assert.equal(result.sessionScope.admissionEvidenceStatus, SEEDED_ADMISSION_EVIDENCE_STATUS);
  assert.equal(isSeededReader(fixture.create()), true);
  assert.equal(isSeededReader({readAcceptedSeeds: async () => ({})}), false);
  assert.equal(fixture.brokerCalls.length, 2);
  assert.deepEqual(fixture.brokerCalls.map(call => call.source), ['mail', 'calendar']);
  assert.equal(fixture.brokerCalls[0].operation, 'read_exact_approved_provider_ids');
  assert.deepEqual(fixture.brokerCalls[0].providerRecordIds, ['fixture-google-mail-1', 'fixture-google-mail-2']);
  assert.deepEqual(fixture.brokerCalls[0].resource, fixture.binding.resource.mail);
  assert.equal(fixture.brokerCalls[0].limit, 2);
  assert.deepEqual(fixture.brokerCalls[0].timeWindow, {timeZone: 'Europe/London', endExclusive: result.pinnedAt});
  assert.equal(fixture.brokerCalls[1].limit, 1);
  assert.equal(fixture.brokerCalls[1].timeWindow.timeZone, 'Europe/London');
  assert.equal(fixture.brokerCalls[1].timeWindow.startInclusive, result.pinnedAt);
  assert.equal(fixture.brokerCalls[1].guards.noWideQueries, true);
  assert.equal(fixture.brokerCalls[1].capabilities.calendarRead.crossClient, true);
  assert.equal(typeof fixture.brokerCalls[1].capabilities.calendarRead.reviewRef, 'string');
});

test('snapshots trusted scope at construction and freezes each exact broker request', async () => {
  const fixture = makeFixture();
  const callerBinding = structuredClone(fixture.binding);
  const callerCapabilities = structuredClone(fixture.capabilities);
  const seenRequests = [];
  const broker = async request => {
    seenRequests.push(request);
    return fixture.broker(request);
  };
  const reader = fixture.create({binding: callerBinding, capabilities: callerCapabilities, broker});

  callerBinding.actorId = 'fixture-switched-actor';
  callerBinding.sessionId = '00000000-0000-4000-8000-000000000099';
  callerBinding.grantRevision = 'grant-r999';
  callerBinding.resource.mail.id = 'fixture-switched-label';
  callerCapabilities.calendarRead.reviewRef = 'review:changed-after-construction';
  callerCapabilities.calendarRead.crossClient = false;

  const result = await reader.readAcceptedSeeds();
  assert.equal(result.sessionScope.actorId, fixture.binding.actorId);
  assert.equal(result.sessionScope.sessionId, fixture.binding.sessionId);
  assert.equal(result.sessionScope.grantRevision, fixture.binding.grantRevision);
  assert.equal(result.mail.records[0].content.labelIds[0], fixture.binding.resource.mail.id);
  assert.deepEqual(seenRequests[0].binding, fixture.binding);
  assert.deepEqual(seenRequests[1].capabilities, fixture.capabilities);
  assert.equal(Object.isFrozen(seenRequests[0]), true);
  assert.equal(Object.isFrozen(seenRequests[0].binding.resource.mail), true);
  assert.equal(Object.isFrozen(seenRequests[0].providerRecordIds), true);
  assert.equal(Object.isFrozen(seenRequests[1].timeWindow), true);
});

test('uses the configured Microsoft demo account and exact folder binding', async () => {
  const fixture = makeFixture({provider: 'microsoft'});
  const result = await fixture.create().readAcceptedSeeds();
  assert.equal(result.accountEmail, EXPECTED_DEMO_ACCOUNT_EMAIL.microsoft);
  assert.equal(result.mail.records.length, 1);
  assert.equal(result.mail.records[0].content.parentFolderId, fixture.binding.resource.mail.id);
  assert.equal(fixture.brokerCalls[0].resource.kind, 'folder');
  assert.equal(fixture.brokerCalls[1].capabilities.calendarRead.crossClient, false);
});

test('rejects mailbox aliases, default resources, primary calendars and account-address calendars before the broker', () => {
  for (const options of [
    {mailResourceId: 'INBOX'},
    {mailResourceId: 'Sent Items'},
    {mailIsDefault: true},
    {calendarResourceId: 'primary'},
    {calendarResourceId: EXPECTED_DEMO_ACCOUNT_EMAIL.google},
    {calendarIsDefault: true},
  ]) {
    const fixture = makeFixture(options);
    assert.throws(() => fixture.create(), {code: 'INVALID_BINDING'});
    assert.equal(fixture.brokerCalls.length, 0);
  }
});

test('requires independently pinned resource, guard, capability and exact cross-client evidence', () => {
  const unknownHash = makeFixture();
  assert.throws(() => unknownHash.create({expectedAdmissionEvidenceSha256: '0'.repeat(64)}), {code: 'UNKNOWN_ADMISSION_EVIDENCE'});

  const unacceptedProposal = makeFixture({mutateAdmissionEvidence: evidence => {
    evidence.status = 'configuration_proposal';
  }});
  assert.throws(() => unacceptedProposal.create(), {code: 'INVALID_ADMISSION_EVIDENCE'});

  const badResourceEvidence = makeFixture({mutateAdmissionEvidence: evidence => {
    evidence.resourceReview.resourceSha256 = 'f'.repeat(64);
  }});
  assert.throws(() => badResourceEvidence.create(), {code: 'INVALID_RESOURCE_REVIEW'});

  const badGuardEvidence = makeFixture({mutateAdmissionEvidence: evidence => {
    evidence.guardReview.guardsSha256 = 'f'.repeat(64);
  }});
  assert.throws(() => badGuardEvidence.create(), {code: 'INVALID_GUARD_REVIEW'});

  const badCapabilityEvidence = makeFixture({mutateAdmissionEvidence: evidence => {
    evidence.capabilitiesSha256 = 'f'.repeat(64);
  }});
  assert.throws(() => badCapabilityEvidence.create(), {code: 'INVALID_CAPABILITY_EVIDENCE'});

  const wrongCrossClientBinding = makeFixture({mutateAdmissionEvidence: evidence => {
    evidence.crossClientCalendarBrokerReview.clientId = 'fixture-other-client';
  }});
  assert.throws(() => wrongCrossClientBinding.create(), {code: 'INVALID_CROSS_CLIENT_REVIEW'});
  for (const fixture of [unknownHash, unacceptedProposal, badResourceEvidence, badGuardEvidence, badCapabilityEvidence, wrongCrossClientBinding]) {
    assert.equal(fixture.brokerCalls.length, 0);
  }
});

test('accepts a current event that overlaps the pinned clock without claiming future-only coverage', async () => {
  const fixture = makeFixture({calendarStart: '2026-10-14T07:45:00.000Z', calendarEnd: '2026-10-14T08:30:00.000Z'});
  const result = await fixture.create().readAcceptedSeeds();
  assert.equal(result.calendar.records[0].content.start, '2026-10-14T07:45:00.000Z');
  assert.equal(result.calendar.records[0].content.end, '2026-10-14T08:30:00.000Z');
});

test('preserves a bounded-view cursor without following it or claiming source completeness', async () => {
  const fixture = makeFixture();
  let calls = 0;
  const broker = async request => {
    calls += 1;
    const result = brokerResult(request, fixture, fixture.bySource[request.source]);
    if (request.source === 'calendar') {
      result.coverage.hasMore = true;
      result.coverage.nextCursor = 'fixture-next-view-cursor';
    }
    return result;
  };
  const result = await fixture.create({broker}).readAcceptedSeeds();
  assert.equal(result.overallSourceCoverage, 'UNKNOWN');
  assert.equal(result.calendar.coverage.hasMore, true);
  assert.equal(result.calendar.coverage.nextCursor, 'fixture-next-view-cursor');
  assert.equal(calls, 2);
});

test('rejects an unknown receipt before invoking the broker', () => {
  const fixture = makeFixture();
  assert.throws(() => fixture.create({expectedReceiptSha256: '0'.repeat(64)}), {code: 'UNKNOWN_RECEIPT'});
  assert.equal(fixture.brokerCalls.length, 0);
});

test('rejects absent or oversized receipt bytes as a contract error', () => {
  const fixture = makeFixture();
  assert.throws(() => fixture.create({acceptedReceiptBytes: undefined}), {code: 'INVALID_RECEIPT_BYTES'});
  assert.throws(() => fixture.create({acceptedReceiptBytes: Buffer.alloc(256_001)}), {code: 'INVALID_RECEIPT_BYTES'});
  assert.equal(fixture.brokerCalls.length, 0);
});

test('read accepts only an internal abort signal and returns no records after abort acknowledgement', async () => {
  const fixture = makeFixture();
  const malformed = new AbortController();
  await assert.rejects(fixture.create().readAcceptedSeeds({signal: malformed.signal, account: 'google'}), {code: 'INVALID_READ_OPTIONS'});
  assert.equal(fixture.brokerCalls.length, 0);

  const controller = new AbortController();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let calls = 0;
  const broker = async (request, {signal}) => {
    calls += 1;
    assert.equal(signal, controller.signal);
    markStarted();
    await new Promise(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, {once: true});
    });
    return brokerResult(request, fixture, fixture.bySource[request.source]);
  };
  const reader = fixture.create({broker});
  const pending = reader.readAcceptedSeeds({signal: controller.signal});
  await started;
  controller.abort();
  await assert.rejects(pending, {code: 'READ_ABORTED'});
  assert.equal(calls, 1);
});

test('rejects a receipt whose actor or resource binding differs from trusted server configuration', () => {
  const fixture = makeFixture();
  const wrongBinding = {...fixture.binding, actorId: 'fixture-other-actor'};
  assert.throws(() => fixture.create({binding: wrongBinding}), {code: 'BINDING_MISMATCH'});
  const wrongResource = structuredClone(fixture.binding);
  wrongResource.resource.mail.id = 'fixture-another-label';
  assert.throws(() => fixture.create({binding: wrongResource}), {code: 'BINDING_MISMATCH'});
  assert.equal(fixture.brokerCalls.length, 0);
});

test('rejects expired and not-yet-accepted receipts before any provider lookup', () => {
  const expired = makeFixture({expiry: '2026-10-14T07:59:59.000Z'});
  assert.throws(() => expired.create(), {code: 'RECEIPT_EXPIRED'});
  const future = makeFixture({acceptedAt: '2026-10-14T08:00:01.000Z'});
  assert.throws(() => future.create(), {code: 'RECEIPT_EXPIRED'});
  assert.equal(expired.brokerCalls.length + future.brokerCalls.length, 0);
});

test('rejects a receipt view containing future mail before invoking the broker', () => {
  const fixture = makeFixture({mutateReceipt: receipt => {
    receipt.seedLedger[0].receivedAt = '2026-10-15T09:00:00.000Z';
  }});
  assert.throws(() => fixture.create(), {code: 'FUTURE_OR_INVALID_MAIL'});
  assert.equal(fixture.brokerCalls.length, 0);
});

test('rechecks receipt expiry between exact-source broker calls', async () => {
  const fixture = makeFixture({expiry: '2026-10-14T08:00:01.000Z'});
  let ticks = 0;
  const clock = () => (++ticks < 4 ? PINNED : PINNED + 2_000);
  await assert.rejects(fixture.create({clock}).readAcceptedSeeds(), {code: 'RECEIPT_EXPIRED'});
  assert.equal(fixture.brokerCalls.length, 1);
  assert.equal(fixture.brokerCalls[0].source, 'mail');
});

test('does not release completed bounded results if the receipt expires before return', async () => {
  const fixture = makeFixture({expiry: '2026-10-14T08:00:01.000Z'});
  let ticks = 0;
  const clock = () => (++ticks < 5 ? PINNED : PINNED + 2_000);
  await assert.rejects(fixture.create({clock}).readAcceptedSeeds(), {code: 'RECEIPT_EXPIRED'});
  assert.equal(fixture.brokerCalls.length, 2);
});

test('rejects changed grant revision or another session echoed by the broker', async t => {
  for (const [name, mutate] of [
    ['grant revision', scope => { scope.binding.grantRevision = 'grant-r6'; }],
    ['session', scope => { scope.binding.sessionId = '00000000-0000-4000-8000-000000000099'; }],
    ['source aggregate', scope => { scope.binding.sourceAggregateSha256 = 'f'.repeat(64); }],
  ]) {
    await t.test(name, async () => {
      const fixture = makeFixture();
      const broker = async request => {
        const result = brokerResult(request, fixture, fixture.bySource[request.source]);
        mutate(result.scope);
        return result;
      };
      await assert.rejects(fixture.create({broker}).readAcceptedSeeds(), {code: 'BROKER_SCOPE_MISMATCH'});
    });
  }
});

test('rejects a label removed from the returned message even when IDs and digest were approved', async () => {
  const fixture = makeFixture();
  const broker = async request => {
    const records = structuredClone(fixture.bySource[request.source]);
    if (request.source === 'mail') records[0].content.labelIds = ['fixture-other-label'];
    return brokerResult(request, fixture, records);
  };
  await assert.rejects(fixture.create({broker}).readAcceptedSeeds(), {code: 'MAIL_RESOURCE_MISMATCH'});
});

test('rejects a record returned from a different dedicated calendar', async () => {
  const fixture = makeFixture();
  const broker = async request => {
    const records = structuredClone(fixture.bySource[request.source]);
    if (request.source === 'calendar') records[0].content.calendarId = 'fixture-primary-calendar';
    return brokerResult(request, fixture, records);
  };
  await assert.rejects(fixture.create({broker}).readAcceptedSeeds(), {code: 'CALENDAR_RESOURCE_MISMATCH'});
});

test('rejects changed versions, content digests, seed timestamps and duplicate IDs', async t => {
  const cases = [
    ['changed version', records => { records[0].version = 'message-v999'; }, 'RECORD_VERSION_MISMATCH'],
    ['changed body', records => { records[0].content.body = 'Altered after acceptance'; }, 'RECORD_DIGEST_MISMATCH'],
    ['changed accepted timestamp', records => { records[0].content.receivedAt = '2026-10-13T15:31:00.000Z'; }, 'SEED_TIMESTAMP_MISMATCH'],
    ['duplicate provider id', records => { records[1].providerRecordId = records[0].providerRecordId; }, 'UNEXPECTED_OR_DUPLICATE_RECORD'],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, async () => {
      const fixture = makeFixture();
      const broker = async request => {
        const records = structuredClone(fixture.bySource[request.source]);
        if (request.source === 'mail') mutate(records);
        return brokerResult(request, fixture, records);
      };
      await assert.rejects(fixture.create({broker}).readAcceptedSeeds(), {code});
    });
  }
});

test('rejects incomplete, unexpected and malformed batches without releasing partial records', async t => {
  const cases = [
    ['incomplete', (request, records) => records.slice(0, 1), 'INCOMPLETE_BATCH'],
    ['unexpected ID', (request, records) => [{...records[0], providerRecordId: 'fixture-unapproved-id'}, records[1]], 'UNEXPECTED_OR_DUPLICATE_RECORD'],
    ['wrong callback response source', (request, records) => records, 'BROKER_COVERAGE_MISMATCH', {coverageSource: 'calendar'}],
  ];
  for (const [name, transform, code, extra = {}] of cases) {
    await t.test(name, async () => {
      const fixture = makeFixture();
      const broker = async request => {
        const records = transform(request, structuredClone(fixture.bySource[request.source]));
        const result = brokerResult(request, fixture, records);
        if (extra.coverageSource) result.coverage.source = extra.coverageSource;
        return result;
      };
      await assert.rejects(fixture.create({broker}).readAcceptedSeeds(), {code});
    });
  }
});

test('provider failure returns no partial source result and has no synthetic fallback', async () => {
  const fixture = makeFixture();
  const broker = async request => {
    if (request.source === 'calendar') throw new Error('provider details are not exposed');
    return brokerResult(request, fixture, fixture.bySource.mail);
  };
  await assert.rejects(fixture.create({broker}).readAcceptedSeeds(), error => {
    assert(error instanceof SeededReaderError);
    assert.equal(error.code, 'BROKER_FAILURE');
    assert.doesNotMatch(error.message, /provider details/);
    return true;
  });
});

test('rejects an oversized batch response and invalid clock without invoking an unbounded query', async t => {
  await t.test('response exceeds aggregate byte cap', async () => {
    const fixture = makeFixture();
    const broker = async request => {
      const records = structuredClone(fixture.bySource[request.source]);
      records[0].content.body = 'x'.repeat(90_000);
      return brokerResult(request, fixture, records);
    };
    await assert.rejects(fixture.create({broker}).readAcceptedSeeds(), {code: 'RESPONSE_SIZE_LIMIT'});
  });
  await t.test('invalid trusted clock', async () => {
    const fixture = makeFixture();
    assert.throws(() => fixture.create({clock: () => Number.NaN}), {code: 'INVALID_CLOCK'});
    assert.equal(fixture.brokerCalls.length, 0);
  });
});

test('HTTP port stays disabled by default until a trusted reader factory is supplied', async t => {
  const harness = await seededHttpHarness(t);
  const client = await harness.client();
  assert.equal(client.state.dateContext.status, 'ready_offline');
  const response = await client.post('/api/seeded-records', {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'SHARED_CONNECTION_NOT_ADMITTED');
});

test('HTTP integration reads both fake account readers for exactly the current session', async t => {
  const factorySessions = [];
  const harness = await seededHttpHarness(t, {
    seededReadersForSession: context => {
      factorySessions.push(context.sessionId);
      return readersForSession(context);
    },
  });
  const client = await harness.client();
  const response = await client.post('/api/seeded-records', {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 'provider_seed_readback');
  assert.equal(payload.generation, client.state.generation);
  assert.deepEqual(factorySessions, [client.state.generation]);
  assert.equal(payload.snapshots.length, 2);
  assert.deepEqual(payload.snapshots.map(snapshot => snapshot.accountEmail).sort(), [
    EXPECTED_DEMO_ACCOUNT_EMAIL.google,
    EXPECTED_DEMO_ACCOUNT_EMAIL.microsoft,
  ].sort());
  for (const snapshot of payload.snapshots) {
    assert.equal(snapshot.sessionScope.sessionId, client.state.generation);
    assert.equal(snapshot.coverageBasis, 'bounded_accepted_seed_view');
    assert.equal(snapshot.overallSourceCoverage, 'UNKNOWN');
  }
});

test('HTTP auth and exact empty-body gates reject CSRF and caller-selected accounts before the factory', async t => {
  let factoryCalls = 0;
  const harness = await seededHttpHarness(t, {
    seededReadersForSession: context => {
      factoryCalls += 1;
      return readersForSession(context);
    },
  });
  const client = await harness.client();
  const csrf = await client.post('/api/seeded-records', {}, {'x-csrf-token': 'wrong-fixture-token'});
  assert.equal(csrf.status, 403);
  assert.equal((await csrf.json()).code, 'CSRF_REJECTED');
  const selector = await client.post('/api/seeded-records', {account: 'google'});
  assert.equal(selector.status, 400);
  assert.equal((await selector.json()).code, 'INVALID_REQUEST');
  assert.equal(factoryCalls, 0);
});

test('HTTP rejects a reader scoped to another session without returning either account', async t => {
  const harness = await seededHttpHarness(t, {
    seededReadersForSession: context => readersForSession(context, {wrongMicrosoftSession: true}),
  });
  const client = await harness.client();
  const response = await client.post('/api/seeded-records', {});
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.match(body, /PROVIDER_SCOPE_MISMATCH/);
  assert.doesNotMatch(body, /robin@example\.test|casey@example\.test|hello@kitchenfront|kitchenfront@outlook/);
});

test('HTTP rejects an unbranded method-shaped reader before invoking either reader', async t => {
  let methodCalls = 0;
  let brokerCalls = 0;
  const harness = await seededHttpHarness(t, {
    seededReadersForSession: context => {
      const firstFixture = makeFixture({
        provider: 'google', sessionId: context.sessionId, clock: context.clock,
        actorId: context.principal.actorId, organizationId: context.principal.organizationId,
      });
      const secondFixture = makeFixture({
        provider: 'microsoft', sessionId: context.sessionId, clock: context.clock,
        actorId: context.principal.actorId, organizationId: context.principal.organizationId,
      });
      const realGoogle = firstFixture.create({broker: async request => {
        brokerCalls += 1;
        return firstFixture.broker(request);
      }});
      const realMicrosoft = secondFixture.create({broker: async request => {
        brokerCalls += 1;
        return secondFixture.broker(request);
      }});
      return [{admissionScope: realGoogle.admissionScope, readAcceptedSeeds: async () => { methodCalls += 1; return realGoogle.readAcceptedSeeds(); }}, realMicrosoft];
    },
  });
  const client = await harness.client();
  const response = await client.post('/api/seeded-records', {});
  assert.equal(response.status, 503);
  assert.match((await response.text()), /UNBRANDED_READER/);
  assert.equal(methodCalls, 0);
  assert.equal(brokerCalls, 0);
});

test('HTTP checks the independently configured principal before reading provider records', async t => {
  let brokerCalls = 0;
  const harness = await seededHttpHarness(t, {
    seededReadersForSession: context => readersForSession(
      {...context, principal: {actorId: 'fixture-other-actor', organizationId: context.principal.organizationId}},
      {brokerOverride: ({original}) => async request => {
        brokerCalls += 1;
        return original(request);
      }},
    ),
  });
  const client = await harness.client();
  const response = await client.post('/api/seeded-records', {});
  assert.equal(response.status, 503);
  assert.match((await response.text()), /PROVIDER_SCOPE_MISMATCH/);
  assert.equal(brokerCalls, 0);
});

test('HTTP withholds a successful account result when the peer provider fails', async t => {
  const harness = await seededHttpHarness(t, {
    seededReadersForSession: context => readersForSession(context, {failingProvider: 'microsoft'}),
  });
  const client = await harness.client();
  const response = await client.post('/api/seeded-records', {});
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.match(body, /BROKER_FAILURE/);
  assert.doesNotMatch(body, /snapshots|robin@example\.test|hello@kitchenfront/);
});

test('HTTP reset creates a new generation and obtains new session readers', async t => {
  const factorySessions = [];
  const harness = await seededHttpHarness(t, {
    seededReadersForSession: context => {
      factorySessions.push(context.sessionId);
      return readersForSession(context);
    },
  });
  const client = await harness.client();
  const first = await client.post('/api/seeded-records', {});
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  harness.setNow('2026-10-14T09:00:00.000Z');
  const reset = await client.post('/api/reset', {});
  assert.equal(reset.status, 200);
  const resetBody = await reset.json();
  assert.notEqual(resetBody.generation, firstBody.generation);
  const second = await client.post('/api/seeded-records', {});
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.generation, resetBody.generation);
  assert.deepEqual(factorySessions, [firstBody.generation, resetBody.generation]);
  assert.notEqual(secondBody.snapshots[0].sessionScope.sessionId, firstBody.snapshots[0].sessionScope.sessionId);
});

test('HTTP keeps reset and replay blocked until both in-flight source readers settle', async t => {
  let releaseReads;
  let markStarted;
  const blocked = new Promise(resolve => { releaseReads = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  let callCount = 0;
  const harness = await seededHttpHarness(t, {
    seededReadersForSession: context => readersForSession(context, {
      brokerOverride: ({original}) => async request => {
        callCount += 1;
        if (callCount === 1) markStarted();
        await blocked;
        return original(request);
      },
    }),
  });
  const client = await harness.client();
  const inFlight = client.post('/api/seeded-records', {});
  await started;
  const reset = await client.post('/api/reset', {});
  assert.equal(reset.status, 409);
  assert.equal((await reset.json()).code, 'REQUEST_ACTIVE');
  const secondRead = await client.post('/api/seeded-records', {});
  assert.equal(secondRead.status, 409);
  assert.equal((await secondRead.json()).code, 'REQUEST_ACTIVE');
  releaseReads();
  const completed = await inFlight;
  assert.equal(completed.status, 200);
  assert.equal(callCount, 4);
});

test('HTTP deadline abort is acknowledged by both callbacks before the active guard clears', async t => {
  const started = deferred();
  const callbacksSettled = deferred();
  let callbackCount = 0;
  let settledCount = 0;
  const signals = [];
  const harness = await seededHttpHarness(t, {
    seedReadTimeoutMs: 60,
    seededReadersForSession: context => readersForSession(context, {
      brokerOverride: ({original}) => async (request, {signal}) => {
        signals.push(signal);
        callbackCount += 1;
        if (callbackCount === 2) started.resolve();
        try {
          await new Promise(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, {once: true});
          });
          return original(request);
        } finally {
          settledCount += 1;
          if (settledCount === 2) callbacksSettled.resolve();
        }
      },
    }),
  });
  const client = await harness.client();
  const pending = client.post('/api/seeded-records', {});
  await started.promise;
  const response = await pending;
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.match(body, /SEED_READ_INTERRUPTED_UNKNOWN/);
  assert.doesNotMatch(body, /snapshots|robin@example\.test|hello@kitchenfront/);
  await callbacksSettled.promise;
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  const state = await waitForProviderReadState(client, null);
  assert.equal(state.providerReadState, null);
  assert.equal((await client.post('/api/reset', {})).status, 200);
});

test('HTTP timeout keeps reset and store ownership held until an ignored abort actually settles', async t => {
  const started = deferred();
  const release = deferred();
  let callbackCount = 0;
  const harness = await seededHttpHarness(t, {
    seedReadTimeoutMs: 60,
    seededReadersForSession: context => readersForSession(context, {
      brokerOverride: ({original}) => async request => {
        callbackCount += 1;
        if (callbackCount === 2) started.resolve();
        await release.promise;
        return original(request);
      },
    }),
  });
  const client = await harness.client();
  const pending = client.post('/api/seeded-records', {});
  await started.promise;
  const response = await pending;
  assert.equal(response.status, 503);
  assert.match(await response.text(), /SEED_READ_INTERRUPTED_UNKNOWN/);
  assert.equal(callbackCount, 2);
  assert.equal((await client.get()).providerReadState, 'blocked_unknown');
  const reset = await client.post('/api/reset', {});
  assert.equal(reset.status, 409);
  assert.equal((await reset.json()).code, 'READ_CLEANUP_UNKNOWN');
  const replay = await client.post('/api/seeded-records', {});
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).code, 'READ_CLEANUP_UNKNOWN');

  try {
    await harness.closeServer();
    assert.throws(() => harness.createStore(), /already has an owner/);
  } finally {
    release.resolve();
    await harness.waitForCleanup();
  }
  const successor = harness.createStore();
  successor.close();
});

test('HTTP bounds a hung reader factory, signals it and retains the hold until factory completion', async t => {
  const started = deferred();
  const release = deferred();
  let factorySignal;
  let brokerCalls = 0;
  const harness = await seededHttpHarness(t, {
    seedReadTimeoutMs: 60,
    seededReadersForSession: async context => {
      factorySignal = context.signal;
      started.resolve();
      await release.promise;
      return readersForSession(context, {
        brokerOverride: ({original}) => async request => {
          brokerCalls += 1;
          return original(request);
        },
      });
    },
  });
  const client = await harness.client();
  const pending = client.post('/api/seeded-records', {});
  await started.promise;
  const response = await pending;
  assert.equal(response.status, 503);
  assert.match(await response.text(), /SEED_READ_INTERRUPTED_UNKNOWN/);
  assert.equal(factorySignal.aborted, true);
  assert.equal((await client.get()).providerReadState, 'blocked_unknown');
  const reset = await client.post('/api/reset', {});
  assert.equal(reset.status, 409);
  assert.equal((await reset.json()).code, 'READ_CLEANUP_UNKNOWN');
  release.resolve();
  const state = await waitForProviderReadState(client, null);
  assert.equal(state.providerReadState, null);
  assert.equal(brokerCalls, 0);
  assert.equal((await client.post('/api/reset', {})).status, 200);
});

test('HTTP rejects a fake-clock session expiry after awaited reads and releases no partial records', async t => {
  const started = deferred();
  const release = deferred();
  let callbacks = 0;
  const harness = await seededHttpHarness(t, {
    seedReadTimeoutMs: 1000,
    seededReadersForSession: context => readersForSession(context, {
      brokerOverride: ({original}) => async request => {
        callbacks += 1;
        if (callbacks === 2) started.resolve();
        await release.promise;
        return original(request);
      },
    }),
  });
  const client = await harness.client();
  const pending = client.post('/api/seeded-records', {});
  await started.promise;
  harness.setNow(PINNED + 8 * 60 * 60 * 1000 + 1);
  release.resolve();
  const response = await pending;
  const body = await response.text();
  assert.equal(response.status, 401);
  assert.match(body, /SESSION_EXPIRED_DURING_READ/);
  assert.doesNotMatch(body, /snapshots|robin@example\.test|hello@kitchenfront/);
  assert.equal(callbacks, 4);
});

test('HTTP session-expiry timer aborts a blocked read and evicts its cached readers', async t => {
  const started = deferred();
  const release = deferred();
  let callbackCount = 0;
  const harness = await seededHttpHarness(t, {
    seedReadTimeoutMs: 1000,
    seededReadersForSession: context => readersForSession(context, {
      brokerOverride: ({original}) => async request => {
        callbackCount += 1;
        if (callbackCount === 2) started.resolve();
        await release.promise;
        return original(request);
      },
    }),
  });
  const client = await harness.client();
  harness.expireSessionSoon(client.cookie.split('=')[1], 120);
  const pending = client.post('/api/seeded-records', {});
  await started.promise;
  const response = await pending;
  const body = await response.text();
  assert.equal(response.status, 401);
  assert.match(body, /SESSION_EXPIRED_DURING_READ/);
  assert.doesNotMatch(body, /snapshots|robin@example\.test|hello@kitchenfront/);
  assert.equal(callbackCount, 2);
  await waitForReaderCacheSize(harness, 0);
  release.resolve();
});
