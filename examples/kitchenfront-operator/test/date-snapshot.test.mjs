import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  createCurrentSnapshot,
  getNextCalendarPage,
  EXPECTED_PACKET_AGGREGATE,
  EXPECTED_SHOWROOM_PACK_SHA256,
  loadSealedPacket,
  TIME_ZONE
} from '../lib/date-snapshot.mjs';

const SESSION_ID = '01a11111-b111-4111-8111-111111111111';
const OTHER_SESSION_ID = '01a12222-b222-4222-8222-222222222222';
const PACKET_DIR = process.env.KITCHENFRONT_TWO_YEAR_PACKET_DIR;

function mail(id, at, contactId = 'contact-alex') {
  return {
    id,
    contactId,
    direction: 'incoming',
    from: 'guest@example.test',
    to: 'showroom@example.test',
    at,
    subject: 'Fictional kitchen enquiry',
    body: 'A compact fictional message for a selector test.',
    synthetic: true
  };
}

function event(id, start, end, contactId = null) {
  return {
    id,
    contactId,
    title: 'Fictional diary block',
    start,
    end,
    status: 'confirmed',
    busy: true,
    synthetic: true
  };
}

function fixturePacket({messages = [], events = [], customers = []} = {}) {
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
      mode: 'demo',
      simulated: true,
      sourceKind: 'synthetic_fixture',
      timezone: TIME_ZONE,
      horizon: {startDate: '2026-10-14', endDateExclusive: '2028-10-15'},
      rules: {
        weekdayHours: ['09:00', '17:00'],
        saturdayHours: ['10:00', '14:00'],
        sundayClosed: true,
        defaultConsultationMinutes: 60,
        appointmentGridMinutes: 30
      },
      contacts: [],
      customers,
      messages,
      events
    }
  };
}

function snapshot(packet, now = new Date('2027-06-14T08:00:00.000Z'), sessionId = SESSION_ID) {
  return createCurrentSnapshot(packet, {now, sessionId});
}

test('fixed mail, customer facts and event coverage stay within the pinned bounds', () => {
  const now = new Date('2027-06-14T08:00:00.000Z');
  const messages = Array.from({length: 7}, (_, index) => mail('mail-' + (index + 1), new Date(now.getTime() - (index + 1) * 60000).toISOString()));
  messages.push(mail('future-mail', '2027-06-14T08:01:00.000Z'));
  const events = Array.from({length: 31}, (_, index) => {
    const start = new Date(now.getTime() + (index + 1) * 60000);
    return event('event-' + String(index + 1).padStart(2, '0'), start.toISOString(), new Date(start.getTime() + 30 * 60000).toISOString(), 'contact-alex');
  });
  const customers = [
    {
      id: 'contact-alex',
      name: 'Alex Example',
      email: 'alex@example.test',
      projectId: 'project-alex',
      budgetMinPence: 1000000,
      budgetMaxPence: 2000000,
      budgetEvidenceMessageId: 'mail-7',
      quoteRef: 'DEMO-Q-TEST',
      messageIds: messages.map((item) => item.id),
      lifecycle: [
        {at: '2027-06-01T09:00:00.000Z', stage: 'new_enquiry', evidenceMessageId: 'mail-7'},
        {at: '2027-06-14T08:01:00.000Z', stage: 'quote_requested', evidenceMessageId: 'future-mail'},
        {at: '2027-06-14T08:01:00.000Z', stage: 'draft_quote_available', evidenceMessageId: 'future-mail'}
      ]
    },
    {
      id: 'contact-future',
      name: 'Future Example',
      email: 'future@example.test',
      projectId: 'project-future',
      budgetMinPence: 900000,
      budgetMaxPence: 1900000,
      budgetEvidenceMessageId: 'future-only',
      messageIds: ['future-only'],
      lifecycle: [{at: '2027-06-15T09:00:00.000Z', stage: 'qualified', evidenceMessageId: 'future-only'}]
    }
  ];
  messages.push(mail('future-only', '2027-06-15T09:00:00.000Z', 'contact-future'));

  const result = snapshot(fixturePacket({messages, events, customers}), now);
  assert.equal(result.status, 'ready_offline');
  assert.equal(result.timeZone, 'Europe/London');
  assert.equal(result.pinnedAt, now.toISOString());
  assert.equal(result.fixedEmails.length, 5);
  assert.equal(result.fixedEmails.some((item) => item.id === 'future-mail' || item.id === 'future-only'), false);
  assert.equal(result.upcomingEvents.length, 30);
  assert.equal(result.coverage.upcomingEvents.matchingTotal, 31);
  assert.equal(result.coverage.upcomingEvents.hasMore, true);
  assert.ok(result.coverage.upcomingEvents.nextPageCursor);
  assert.equal(result.fixedCustomers.length, 1);
  const alex = result.fixedCustomers[0];
  assert.equal(alex.stage, 'new_enquiry');
  assert.equal(alex.budgetMinPence, 1000000);
  assert.equal(alex.quoteRef, null);
  assert.ok(alex.supportIds.includes('mail-7'));
  assert.equal(alex.supportIds.includes('future-mail'), false);
});

test('calendar pagination is pinned to the same snapshot and session', () => {
  const now = new Date('2027-06-14T08:00:00.000Z');
  const events = Array.from({length: 31}, (_, index) => {
    const start = new Date(now.getTime() + (index + 1) * 60000);
    return event('event-' + String(index + 1).padStart(2, '0'), start.toISOString(), new Date(start.getTime() + 30000).toISOString());
  });
  const packet = fixturePacket({events});
  const first = snapshot(packet, now);
  const page = getNextCalendarPage(packet, first, first.coverage.upcomingEvents.nextPageCursor);
  assert.deepEqual(page.events.map((item) => item.id), ['event-31']);
  assert.equal(page.coverage.hasMore, false);
  const other = snapshot(packet, now, OTHER_SESSION_ID);
  assert.throws(() => getNextCalendarPage(packet, other, first.coverage.upcomingEvents.nextPageCursor), {code: 'SESSION_BINDING_MISMATCH'});
});

test('session overlays have isolated case and source fences with no provider identifiers', () => {
  const result = snapshot(fixturePacket(), new Date('2027-06-14T08:00:00.000Z'));
  assert.deepEqual(Object.keys(result.cases), ['quotation', 'reply', 'consultation']);
  const sourceSets = Object.values(result.cases).map((item) => new Set(item.sourceIds));
  for (let left = 0; left < sourceSets.length; left += 1) {
    for (let right = left + 1; right < sourceSets.length; right += 1) {
      assert.equal([...sourceSets[left]].some((id) => sourceSets[right].has(id)), false);
    }
  }
  for (const [id, item] of Object.entries(result.cases)) {
    assert.equal(item.caseId, id);
    assert.equal(item.sessionId, SESSION_ID);
    assert.ok(item.namespace.includes(SESSION_ID));
    assert.ok(item.sourceIds.includes(item.lead.id));
    assert.ok(item.correspondence.every((message) => message.caseId === id && item.sourceIds.includes(message.id)));
    assert.equal(JSON.stringify(item).toLowerCase().includes('providerrecordid'), false);
    assert.equal(JSON.stringify(item).toLowerCase().includes('providerids'), false);
  }
});

test('Casey alternatives check the full fixed diary and overlay, including events beyond page one', () => {
  const now = new Date('2027-06-14T08:00:00.000Z');
  const earlier = Array.from({length: 30}, (_, index) => event(
    'early-' + String(index + 1).padStart(2, '0'),
    '2027-06-14T10:' + String(index).padStart(2, '0') + ':00.000Z',
    '2027-06-14T10:' + String(index + 30).padStart(2, '0') + ':00.000Z'
  ));
  const lateConflict = event('full-diary-block', '2027-06-16T11:00:00+01:00', '2027-06-16T12:00:00+01:00');
  const result = snapshot(fixturePacket({events: [...earlier, lateConflict]}), now);
  assert.equal(result.coverage.upcomingEvents.returned, 30);
  assert.equal(result.upcomingEvents.some((item) => item.id === 'full-diary-block'), false);
  const calendar = result.cases.consultation.calendar;
  assert.equal(calendar.checkedEntireFixedDiary, true);
  assert.equal(calendar.checkedFixedDiaryEventCount, 31);
  assert.equal(calendar.requested.status, 'conflict');
  assert.equal(calendar.blockedReservations.some((item) => item.id === 'full-diary-block'), true);
  assert.equal(calendar.candidates[0].start, '2027-06-16T12:00:00+01:00');
  assert.equal(calendar.candidates.some((candidate) => candidate.start < lateConflict.end && candidate.end > lateConflict.start), false);
});

test('London date controls horizon and the horizon fails closed without overlays', () => {
  const packet = fixturePacket();
  const inLondonTomorrow = snapshot(packet, new Date('2027-06-14T23:30:00.000Z'));
  assert.equal(inLondonTomorrow.localDate, '2027-06-15');
  const exhausted = snapshot(packet, new Date('2028-10-15T08:00:00.000Z'));
  assert.equal(exhausted.status, 'horizon_exhausted');
  assert.deepEqual(exhausted.fixedEmails, []);
  assert.deepEqual(exhausted.fixedCustomers, []);
  assert.deepEqual(exhausted.upcomingEvents, []);
  assert.deepEqual(exhausted.cases, {});
  assert.equal(exhausted.coverage.noFallback, true);
});

test('snapshot requires a trusted Date, a session UUID and a hash-verified packet', () => {
  const packet = fixturePacket();
  assert.throws(() => createCurrentSnapshot({...packet, integrityVerified: false}, {now: new Date(), sessionId: SESSION_ID}), {code: 'UNVERIFIED_PACKET'});
  assert.throws(() => snapshot(packet, '2027-06-14T08:00:00.000Z'), {code: 'INVALID_CLOCK'});
  assert.throws(() => createCurrentSnapshot(packet, {now: new Date(), sessionId: 'demo-session'}), {code: 'SESSION_BINDING_REQUIRED'});
});

test('loader rejects a different aggregate before resolving a packet path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kf-date-empty-'));
  try {
    await assert.rejects(loadSealedPacket(directory, 'f'.repeat(64)), {code: 'AGGREGATE_NOT_APPROVED'});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('configured same-host packet matches the exact 21-file seal', {skip: !PACKET_DIR}, async () => {
  const packet = await loadSealedPacket(PACKET_DIR, EXPECTED_PACKET_AGGREGATE);
  assert.equal(packet.integrityVerified, true);
  assert.equal(packet.aggregateSha256, EXPECTED_PACKET_AGGREGATE);
  assert.equal(packet.sourceHash, EXPECTED_SHOWROOM_PACK_SHA256);
  assert.equal(packet.pack.events.length, 800);
  assert.equal(packet.pack.messages.length, 471);
  assert.equal(packet.pack.customers.length, 77);
});
