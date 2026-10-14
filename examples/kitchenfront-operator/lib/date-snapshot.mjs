import {createHash} from 'node:crypto';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';

export const EXPECTED_PACKET_AGGREGATE = '505aa0aebccc5476a5eed8a1e5dfad464c06dc8e12220a1ef5239c2e45bad611';
export const EXPECTED_SHOWROOM_PACK_SHA256 = 'af29cce57d15ea27e5c1dec6fb89c173ebca89b500c838b950bbefff5e7f0b9f';
export const TIME_ZONE = 'Europe/London';
export const MAIL_PAGE_SIZE = 5;
export const EVENT_PAGE_SIZE = 30;
export const EVENT_WINDOW_DAYS = 14;

const EXPECTED_FILE_COUNT = 21;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const CASES = Object.freeze({
  quotation: Object.freeze({name: 'Robin Sample', email: 'robin@example.test', title: 'Shaker kitchen quotation', knownMissing: ['quotation total', 'quotation attachment']}),
  reply: Object.freeze({name: 'Alex Example', email: 'alex@example.test', title: 'Kitchen enquiry with an island', knownMissing: ['customer budget', 'customer timing']}),
  consultation: Object.freeze({name: 'Casey Demo', email: 'casey@example.test', title: 'Consultation availability', knownMissing: []})
});
const CORE_CASE_BY_CONTACT = Object.freeze({
  'demo-customer-robin': 'quotation',
  'demo-customer-alex': 'reply',
  'demo-customer-casey': 'consultation'
});

export class DateSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DateSnapshotError';
    this.code = code;
  }
}

function assert(condition, code, message) {
  if (!condition) throw new DateSnapshotError(code, message);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value)).replace(/[^\x00-\x7f]/g, (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function assertPack(pack) {
  assert(pack && typeof pack === 'object' && !Array.isArray(pack), 'INVALID_PACKET', 'The sealed packet does not contain an object.');
  assert(pack.schema === 'two-year-fictional-showroom-v1', 'INVALID_PACKET', 'The packet schema is not the accepted fictional showroom version.');
  assert(pack.mode === 'demo' && pack.simulated === true && pack.sourceKind === 'synthetic_fixture', 'INVALID_PACKET', 'The packet must remain fictional and simulated.');
  assert(pack.timezone === TIME_ZONE, 'INVALID_PACKET', 'The packet timezone does not match the accepted London clock.');
  assert(typeof pack.seedId === 'string' && pack.seedId.length > 0, 'INVALID_PACKET', 'The packet is missing its seed revision.');
  assert(pack.horizon && validDateString(pack.horizon.startDate) && validDateString(pack.horizon.endDateExclusive), 'INVALID_PACKET', 'The packet horizon is invalid.');
  assert(Array.isArray(pack.contacts) && Array.isArray(pack.customers) && Array.isArray(pack.messages) && Array.isArray(pack.events), 'INVALID_PACKET', 'The packet is missing a required dataset.');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function readPacketFile(root, relativePath) {
  assert(typeof relativePath === 'string' && relativePath.length > 0, 'INVALID_MANIFEST', 'The manifest contains an invalid path.');
  const fullPath = resolve(root, relativePath);
  const rel = relative(root, fullPath);
  assert(rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'INVALID_MANIFEST', 'The manifest path escapes its configured packet directory.');
  let info;
  try {
    info = await lstat(fullPath);
  } catch {
    throw new DateSnapshotError('PACKET_FILE_MISSING', 'A sealed packet file is missing: ' + relativePath);
  }
  assert(info.isFile() && !info.isSymbolicLink(), 'INVALID_MANIFEST', 'A sealed packet entry is not a regular file: ' + relativePath);
  let actualPath;
  try {
    actualPath = await realpath(fullPath);
  } catch {
    throw new DateSnapshotError('PACKET_FILE_MISSING', 'A sealed packet file cannot be resolved: ' + relativePath);
  }
  const actualRel = relative(root, actualPath);
  assert(actualRel !== '..' && !actualRel.startsWith('..' + sep) && !isAbsolute(actualRel), 'INVALID_MANIFEST', 'A manifest file resolves outside its configured packet directory.');
  return readFile(actualPath);
}

export async function loadSealedPacket(directory, expectedAggregate = EXPECTED_PACKET_AGGREGATE) {
  assert(typeof directory === 'string' && directory.trim().length > 0, 'PACKET_PATH_REQUIRED', 'Configure the same-host packet directory explicitly.');
  assert(expectedAggregate === EXPECTED_PACKET_AGGREGATE, 'AGGREGATE_NOT_APPROVED', 'The configured packet aggregate does not match the accepted content version.');
  let root;
  try {
    root = await realpath(resolve(directory));
  } catch {
    throw new DateSnapshotError('PACKET_PATH_UNAVAILABLE', 'The configured same-host packet directory cannot be read.');
  }
  const manifestBytes = await readPacketFile(root, 'artifact-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new DateSnapshotError('INVALID_MANIFEST', 'The packet manifest is not valid JSON.');
  }
  assert(manifest.schema === 'two-year-content-manifest-v1', 'INVALID_MANIFEST', 'The packet manifest schema is not accepted.');
  assert(Array.isArray(manifest.files) && manifest.files.length === EXPECTED_FILE_COUNT, 'INVALID_MANIFEST', 'The packet manifest must list exactly 21 sealed files.');
  assert(manifest.aggregateSha256 === expectedAggregate, 'AGGREGATE_MISMATCH', 'The packet manifest aggregate does not match the accepted content version.');

  const seen = new Set();
  const verifiedBytes = new Map();
  const aggregateRows = [];
  let previousPath = '';
  for (const entry of manifest.files) {
    assert(entry && typeof entry === 'object' && !Array.isArray(entry), 'INVALID_MANIFEST', 'The packet manifest contains a malformed file entry.');
    assert(Object.keys(entry).sort().join(',') === 'bytes,path,sha256', 'INVALID_MANIFEST', 'A manifest entry contains unexpected fields.');
    assert(typeof entry.path === 'string' && entry.path > previousPath, 'INVALID_MANIFEST', 'Manifest paths must be unique and sorted.');
    assert(!seen.has(entry.path), 'INVALID_MANIFEST', 'The packet manifest contains a duplicate path.');
    assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && SHA256.test(entry.sha256), 'INVALID_MANIFEST', 'The packet manifest contains an invalid size or digest.');
    previousPath = entry.path;
    seen.add(entry.path);
    const bytes = await readPacketFile(root, entry.path);
    assert(bytes.byteLength === entry.bytes, 'PACKET_SIZE_MISMATCH', 'The sealed packet file has an unexpected size: ' + entry.path);
    assert(hashBytes(bytes) === entry.sha256, 'PACKET_HASH_MISMATCH', 'The sealed packet file hash does not match: ' + entry.path);
    verifiedBytes.set(entry.path, bytes);
    aggregateRows.push({bytes: entry.bytes, path: entry.path, sha256: entry.sha256});
  }
  assert(seen.has('showroom-pack.json'), 'INVALID_MANIFEST', 'The sealed packet does not contain the showroom source.');
  const computedAggregate = digest(aggregateRows);
  assert(computedAggregate === expectedAggregate, 'AGGREGATE_MISMATCH', 'The computed 21-file packet aggregate does not match the accepted content version.');

  const packBytes = verifiedBytes.get('showroom-pack.json');
  const packHash = hashBytes(packBytes);
  assert(packHash === EXPECTED_SHOWROOM_PACK_SHA256, 'SOURCE_HASH_MISMATCH', 'The showroom source does not match its pinned digest.');
  let pack;
  try {
    pack = JSON.parse(packBytes.toString('utf8'));
  } catch {
    throw new DateSnapshotError('INVALID_PACKET', 'The showroom source is not valid JSON.');
  }
  assertPack(pack);
  return Object.freeze({
    pack: deepFreeze(pack),
    sourceHash: packHash,
    aggregateSha256: computedAggregate,
    manifestSha256: hashBytes(manifestBytes),
    seedId: pack.seedId,
    horizon: deepFreeze({...pack.horizon}),
    integrityVerified: true
  });
}

function londonParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function londonDate(date) {
  const part = londonParts(date);
  return String(part.year).padStart(4, '0') + '-' + String(part.month).padStart(2, '0') + '-' + String(part.day).padStart(2, '0');
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function requireTimestamp(value, field) {
  const timestamp = parseTimestamp(value);
  assert(timestamp !== null, 'INVALID_PACKET', 'The packet contains an invalid ' + field + ' timestamp.');
  return timestamp;
}

function addDays(day, amount) {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + amount));
  return String(next.getUTCFullYear()).padStart(4, '0') + '-' + String(next.getUTCMonth() + 1).padStart(2, '0') + '-' + String(next.getUTCDate()).padStart(2, '0');
}

function weekdayFor(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date, 12)).getUTCDay();
}

function weekdayOffset(day, offset) {
  let current = day;
  while (weekdayFor(current) > 5) current = addDays(current, 1);
  let count = 0;
  while (count < offset) {
    current = addDays(current, 1);
    if (weekdayFor(current) < 6) count += 1;
  }
  return current;
}

function londonWallTime(day, hour, minute = 0) {
  const [year, month, date] = day.split('-').map(Number);
  const target = Date.UTC(year, month - 1, date, hour, minute, 0, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = londonParts(new Date(candidate));
    const observedWall = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second, 0);
    const correction = target - observedWall;
    if (correction === 0) break;
    candidate += correction;
  }
  const result = new Date(candidate);
  const actual = londonParts(result);
  assert(actual.year === year && actual.month === month && actual.day === date && actual.hour === hour && actual.minute === minute, 'INVALID_LOCAL_TIME', 'The requested local clock time does not exist in Europe/London.');
  return result;
}

function londonIso(date) {
  const part = londonParts(date);
  const localAsUtc = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
  const offsetMinutes = Math.round((localAsUtc - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const offset = sign + String(Math.floor(absolute / 60)).padStart(2, '0') + ':' + String(absolute % 60).padStart(2, '0');
  return String(part.year).padStart(4, '0') + '-' + String(part.month).padStart(2, '0') + '-' + String(part.day).padStart(2, '0')
    + 'T' + String(part.hour).padStart(2, '0') + ':' + String(part.minute).padStart(2, '0') + ':' + String(part.second).padStart(2, '0') + offset;
}

function formatLondonDateTime(date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return values.weekday + ' ' + values.day + ' ' + values.month + ' ' + values.year + ' at ' + values.hour + ':' + values.minute;
}

function eventInterval(event) {
  return {start: requireTimestamp(event.start, 'event start'), end: requireTimestamp(event.end, 'event end')};
}

function sanitizedEmail(message) {
  return {
    id: message.id,
    caseId: CORE_CASE_BY_CONTACT[message.contactId] || null,
    contactId: message.contactId,
    direction: message.direction,
    from: message.from,
    to: message.to,
    at: message.at,
    subject: message.subject,
    body: message.body,
    mode: 'demo',
    simulated: true,
    sourceKind: 'synthetic_fixture',
    origin: 'fixed_dataset',
    trust: 'untrusted_message_content'
  };
}

function sanitizedEvent(event) {
  return {
    id: event.id,
    caseId: CORE_CASE_BY_CONTACT[event.contactId] || null,
    contactId: event.contactId || null,
    title: event.title,
    date: event.date || null,
    start: event.start,
    end: event.end,
    allDay: event.allDay === true,
    category: event.category || null,
    status: event.status,
    busy: event.busy === true,
    notes: event.notes || '',
    mode: 'demo',
    simulated: true,
    sourceKind: 'synthetic_fixture',
    origin: 'fixed_dataset'
  };
}

function eligibleEmails(pack, nowMillis) {
  return pack.messages.filter((message) => requireTimestamp(message.at, 'email') <= nowMillis)
    .sort((left, right) => requireTimestamp(right.at, 'email') - requireTimestamp(left.at, 'email') || right.id.localeCompare(left.id));
}

function boundedEvents(pack, nowMillis, cutoffMillis) {
  return pack.events.filter((event) => {
    const interval = eventInterval(event);
    return interval.end > nowMillis && interval.start < cutoffMillis;
  }).sort((left, right) => eventInterval(left).start - eventInterval(right).start || left.id.localeCompare(right.id));
}

function fixedCustomerFacts(pack, allEligibleEmails, selectedEmails, selectedEvents, nowMillis) {
  const relevant = new Set([...selectedEmails.map((message) => message.contactId), ...selectedEvents.map((event) => event.contactId).filter(Boolean)]);
  const eligibleIds = new Map();
  for (const message of allEligibleEmails) {
    if (!eligibleIds.has(message.contactId)) eligibleIds.set(message.contactId, new Set());
    eligibleIds.get(message.contactId).add(message.id);
  }
  const eventIds = new Map();
  for (const event of selectedEvents) {
    if (!event.contactId) continue;
    if (!eventIds.has(event.contactId)) eventIds.set(event.contactId, []);
    eventIds.get(event.contactId).push(event.id);
  }
  return pack.customers.filter((customer) => relevant.has(customer.id)).flatMap((customer) => {
    const visibleIds = eligibleIds.get(customer.id) || new Set();
    if (!visibleIds.size) return [];
    const lifecycle = (Array.isArray(customer.lifecycle) ? customer.lifecycle : [])
      .filter((item) => parseTimestamp(item.at) !== null && parseTimestamp(item.at) <= nowMillis && visibleIds.has(item.evidenceMessageId))
      .sort((left, right) => parseTimestamp(left.at) - parseTimestamp(right.at));
    const latestStage = lifecycle.at(-1) || null;
    const budgetKnown = typeof customer.budgetEvidenceMessageId === 'string' && visibleIds.has(customer.budgetEvidenceMessageId);
    const quoteEvidence = lifecycle.findLast((item) => item.stage === 'draft_quote_available') || null;
    const supportIds = new Set(visibleIds);
    for (const id of eventIds.get(customer.id) || []) supportIds.add(id);
    if (latestStage?.evidenceMessageId) supportIds.add(latestStage.evidenceMessageId);
    if (budgetKnown) supportIds.add(customer.budgetEvidenceMessageId);
    if (quoteEvidence?.evidenceMessageId) supportIds.add(quoteEvidence.evidenceMessageId);
    return [{
      id: customer.id,
      contactId: customer.id,
      projectId: customer.projectId,
      name: customer.name,
      email: customer.email,
      caseId: CORE_CASE_BY_CONTACT[customer.id] || null,
      stage: latestStage?.stage || 'retained_context_unknown',
      stageSupportIds: latestStage?.evidenceMessageId ? [latestStage.evidenceMessageId] : [],
      budgetMinPence: budgetKnown ? customer.budgetMinPence : null,
      budgetMaxPence: budgetKnown ? customer.budgetMaxPence : null,
      budgetSupportIds: budgetKnown ? [customer.budgetEvidenceMessageId] : [],
      quoteRef: quoteEvidence ? customer.quoteRef || null : null,
      quoteTotalPence: null,
      quoteSupportIds: quoteEvidence?.evidenceMessageId ? [quoteEvidence.evidenceMessageId] : [],
      supportIds: [...supportIds].sort(),
      mode: 'demo',
      simulated: true,
      sourceKind: 'synthetic_fixture',
      origin: 'fixed_dataset'
    }];
  });
}

function selectFixedSnapshot(pack, now, sourceHash) {
  const pinnedAt = now.toISOString();
  const nowMillis = now.getTime();
  const localDate = londonDate(now);
  const base = {pinnedAt, timeZone: TIME_ZONE, localDate, horizon: {...pack.horizon}, seedId: pack.seedId};
  if (localDate < pack.horizon.startDate || localDate >= pack.horizon.endDateExclusive) {
    return {
      ...base,
      status: 'horizon_exhausted',
      fixedEmails: [],
      fixedCustomers: [],
      upcomingEvents: [],
      eventRows: [],
      eventWindowEndExclusive: null,
      eventTotal: 0,
      moreEvents: false,
      snapshotDigest: digest({status: 'horizon_exhausted', sourceHash, ...base})
    };
  }
  const allEligible = eligibleEmails(pack, nowMillis);
  const selectedEmails = allEligible.slice(0, MAIL_PAGE_SIZE);
  const cutoffDay = [addDays(localDate, EVENT_WINDOW_DAYS), pack.horizon.endDateExclusive].sort()[0];
  const cutoff = londonWallTime(cutoffDay, 9);
  const eventRows = boundedEvents(pack, nowMillis, cutoff.getTime());
  const selectedEvents = eventRows.slice(0, EVENT_PAGE_SIZE);
  const fixedEmails = selectedEmails.map(sanitizedEmail);
  const upcomingEvents = selectedEvents.map(sanitizedEvent);
  const fixedCustomers = fixedCustomerFacts(pack, allEligible, selectedEmails, selectedEvents, nowMillis);
  const mailCoverage = {scope: 'fixed_dataset_as_of_pinned_time', pageSize: MAIL_PAGE_SIZE, returned: fixedEmails.length, eligibleTotal: allEligible.length, hasMore: allEligible.length > MAIL_PAGE_SIZE};
  const calendarCoverage = {
    scope: 'fixed_dataset_next_14_local_days',
    windowStart: pinnedAt,
    windowEndExclusive: cutoff.toISOString(),
    timeZone: TIME_ZONE,
    pageSize: EVENT_PAGE_SIZE,
    returned: upcomingEvents.length,
    matchingTotal: eventRows.length,
    hasMore: eventRows.length > EVENT_PAGE_SIZE,
    nextOffset: eventRows.length > EVENT_PAGE_SIZE ? EVENT_PAGE_SIZE : null
  };
  const snapshotDigest = digest({sourceHash, ...base, mailCoverage, calendarCoverage, fixedEmails, fixedCustomers, upcomingEvents});
  return {
    ...base,
    status: 'ready_offline',
    fixedEmails,
    fixedCustomers,
    upcomingEvents,
    eventRows,
    eventWindowEndExclusive: cutoff.toISOString(),
    eventTotal: eventRows.length,
    moreEvents: eventRows.length > EVENT_PAGE_SIZE,
    mailCoverage,
    calendarCoverage,
    snapshotDigest
  };
}

function caseId(namespace, type, part) {
  return namespace + '-' + type + '-' + part;
}

function overlayMessage({id, caseId: sourceCaseId, contactId, from, to, subject, body, at, direction}) {
  return {
    id, caseId: sourceCaseId, contactId, from, to, direction, subject, body, createdAt: at,
    mode: 'demo', simulated: true, sourceKind: 'synthetic_fixture',
    origin: 'session_synthetic_overlay', trust: 'untrusted_message_content'
  };
}

function lead({id, caseId: sourceCaseId, name, email, budget, budgetMinPence, budgetMaxPence, timescale, quoteRef = null}) {
  return {
    id, caseId: sourceCaseId, name, email, budget, budgetMinPence, budgetMaxPence, timescale,
    quoteRef, quoteTotalPence: null, qualified: Boolean(budget),
    mode: 'demo', simulated: true, sourceKind: 'synthetic_fixture', origin: 'session_synthetic_overlay'
  };
}

function makeCoreCase({id, namespace, sessionId, sourceHash, pinnedAt, snapshotDigest, currentLead, correspondence, calendar = null}) {
  const sourceIds = [currentLead.id, ...correspondence.map((message) => message.id)];
  const revision = digest({caseId: id, namespace, sessionId, sourceHash, pinnedAt, snapshotDigest, sourceIds});
  return {
    id, caseId: id, label: CASES[id].title, lead: currentLead, correspondence, sourceIds,
    knownMissing: [...CASES[id].knownMissing],
    businessFacts: {services: 'Not supplied for this fictional case.', pricing: 'Unknown.', installationTiming: 'Unknown.'},
    calendar, namespace: namespace + '-' + id, sessionId, revision, snapshotDigest, sourceHash,
    scenarioDate: londonDate(new Date(pinnedAt)), timeZone: TIME_ZONE,
    fictional: true, mode: 'demo', simulated: true,
    sourceKind: 'synthetic_fixture', origin: 'session_synthetic_overlay'
  };
}

function eventConflicts(start, end, fixedBusy, overlayBusy) {
  const conflicts = [];
  for (const event of fixedBusy) {
    const interval = eventInterval(event);
    if (interval.start < end && interval.end > start) conflicts.push(event);
  }
  for (const event of overlayBusy) {
    const interval = eventInterval(event);
    if (interval.start < end && interval.end > start) conflicts.push(event);
  }
  return conflicts;
}

function isBusy(event) {
  return event.busy === true && String(event.status || '').toLowerCase() !== 'cancelled';
}

function reservation(event) {
  return {
    id: event.id,
    caseId: 'consultation',
    title: event.title,
    start: event.start,
    end: event.end,
    status: event.status,
    busy: event.busy === true,
    timeZone: TIME_ZONE,
    mode: 'demo',
    simulated: true,
    sourceKind: 'synthetic_fixture',
    origin: event.origin || 'fixed_dataset'
  };
}

function localClock(date) {
  const part = londonParts(date);
  const day = londonDate(date);
  return {day, weekday: weekdayFor(day), minute: part.hour * 60 + part.minute};
}

function nextOpening(date) {
  let day = addDays(londonDate(date), 1);
  while (weekdayFor(day) === 0) day = addDays(day, 1);
  return londonWallTime(day, weekdayFor(day) === 6 ? 10 : 9);
}

function caseyCalendar(pack, namespace, sessionId, now, localDate) {
  const requestedDay = weekdayOffset(localDate, 2);
  const requestedStart = londonWallTime(requestedDay, 10);
  const requestedEnd = new Date(requestedStart.getTime() + 60 * 60 * 1000);
  const review = {
    id: caseId(namespace, 'consultation', 'internal-review'),
    title: 'Internal design review',
    start: londonIso(requestedStart),
    end: londonIso(requestedEnd),
    status: 'confirmed',
    busy: true,
    caseId: 'consultation',
    sessionId,
    mode: 'demo',
    simulated: true,
    sourceKind: 'synthetic_fixture',
    origin: 'session_synthetic_overlay'
  };
  const overlayBusy = [review];
  const fixedBusy = pack.events.filter(isBusy);
  const observed = new Map();
  const record = (items) => items.forEach((item) => observed.set(item.id, item));
  record(eventConflicts(requestedStart.getTime(), requestedEnd.getTime(), fixedBusy, overlayBusy));

  const horizonEnd = londonWallTime(pack.horizon.endDateExclusive, 9);
  const durationMinutes = Number(pack.rules?.defaultConsultationMinutes) || 60;
  const stepMinutes = Number(pack.rules?.appointmentGridMinutes) || 30;
  const weekdayOpen = Number(String(pack.rules?.weekdayHours?.[0] || '09:00').slice(0, 2)) * 60;
  const weekdayClose = Number(String(pack.rules?.weekdayHours?.[1] || '17:00').slice(0, 2)) * 60;
  const saturdayOpen = Number(String(pack.rules?.saturdayHours?.[0] || '10:00').slice(0, 2)) * 60;
  const saturdayClose = Number(String(pack.rules?.saturdayHours?.[1] || '14:00').slice(0, 2)) * 60;
  const candidates = [];
  let cursor = new Date(requestedEnd);
  const searchLimit = 70;
  for (let attempt = 0; attempt < searchLimit && candidates.length < 3 && cursor < horizonEnd; attempt += 1) {
    const local = localClock(cursor);
    if (local.weekday === 0) {
      cursor = nextOpening(cursor);
      continue;
    }
    const opening = local.weekday === 6 ? saturdayOpen : weekdayOpen;
    const closing = local.weekday === 6 ? saturdayClose : weekdayClose;
    const end = new Date(cursor.getTime() + durationMinutes * 60000);
    const endLocal = localClock(end);
    if (local.minute < opening) {
      cursor = londonWallTime(local.day, Math.floor(opening / 60), opening % 60);
      continue;
    }
    if (endLocal.day !== local.day || endLocal.minute > closing) {
      cursor = nextOpening(cursor);
      continue;
    }
    const conflicts = eventConflicts(cursor.getTime(), end.getTime(), fixedBusy, overlayBusy);
    record(conflicts);
    if (!conflicts.length) {
      const number = candidates.length + 1;
      candidates.push({
        id: caseId(namespace, 'consultation', 'candidate-' + number),
        caseId: 'consultation',
        start: londonIso(cursor),
        end: londonIso(end),
        timeZone: TIME_ZONE,
        status: 'proposal_only',
        available: true,
        simulated: true,
        mode: 'demo',
        sourceKind: 'synthetic_fixture',
        origin: 'session_synthetic_overlay'
      });
    }
    cursor = new Date(cursor.getTime() + stepMinutes * 60000);
  }

  const blockedReservations = [...observed.values()]
    .map(reservation)
    .sort((left, right) => requireTimestamp(left.start, 'reservation start') - requireTimestamp(right.start, 'reservation start') || left.id.localeCompare(right.id))
    .slice(0, 12);
  const requested = {
    id: caseId(namespace, 'consultation', 'requested-slot'),
    caseId: 'consultation',
    start: londonIso(requestedStart),
    end: londonIso(requestedEnd),
    timeZone: TIME_ZONE,
    status: 'conflict',
    available: false,
    sourceIds: [review.id],
    mode: 'demo',
    simulated: true,
    sourceKind: 'synthetic_fixture',
    origin: 'session_synthetic_overlay'
  };
  return {
    calendar: 'demo-consultations',
    timeZone: TIME_ZONE,
    requested,
    blockedReservations,
    blockedReservationCount: observed.size,
    blockedReservationsTruncated: observed.size > blockedReservations.length,
    candidates,
    slots: candidates.map((item) => ({...item})),
    calendarSourceIds: blockedReservations.map((item) => item.id),
    checkedFixedDiaryEventCount: pack.events.length,
    checkedOverlayReservationCount: overlayBusy.length,
    checkedEntireFixedDiary: true,
    searchLimit,
    status: candidates.length ? 'bounded_proposal_available' : 'unknown_unavailable',
    horizonEnd: londonIso(horizonEnd),
    pinnedNow: now.toISOString(),
    mode: 'demo',
    simulated: true,
    sourceKind: 'synthetic_fixture',
    origin: 'session_synthetic_overlay'
  };
}

function createCases(pack, {now, sessionId, localDate, sourceHash, snapshotDigest}) {
  const namespace = 'session-' + sessionId + '-' + localDate;
  const alexId = caseId(namespace, 'reply', 'lead');
  const robinId = caseId(namespace, 'quotation', 'lead');
  const caseyId = caseId(namespace, 'consultation', 'lead');
  const alexMessage = overlayMessage({
    id: caseId(namespace, 'reply', 'enquiry'), caseId: 'reply', contactId: alexId,
    from: CASES.reply.email, to: 'showroom@example.test', subject: CASES.reply.title,
    body: 'We are planning a kitchen with an island. What are the next steps? We have not decided our budget or timing yet.',
    at: new Date(now.getTime() - 10 * 60000).toISOString(), direction: 'incoming'
  });
  const robinEnquiry = overlayMessage({
    id: caseId(namespace, 'quotation', 'enquiry'), caseId: 'quotation', contactId: robinId,
    from: CASES.quotation.email, to: 'showroom@example.test', subject: CASES.quotation.title,
    body: 'Please prepare a quotation. Our budget is £35,000–£45,000; installation timing is still unconfirmed.',
    at: londonIso(londonWallTime(addDays(localDate, -11), 9)), direction: 'incoming'
  });
  const robinQuote = overlayMessage({
    id: caseId(namespace, 'quotation', 'draft-quote'), caseId: 'quotation', contactId: robinId,
    from: 'showroom@example.test', to: CASES.quotation.email, subject: 'Quotation DEMO-Q017',
    body: 'The draft reference for our cabinetry scope discussion is DEMO-Q017. No total or attachment is supplied. Please let us know which parts of the proposed scope you would like to review.',
    at: londonIso(londonWallTime(addDays(localDate, -10), 9)), direction: 'historical_outgoing'
  });
  const requestedStart = londonWallTime(weekdayOffset(localDate, 2), 10);
  const caseyMessage = overlayMessage({
    id: caseId(namespace, 'consultation', 'request'), caseId: 'consultation', contactId: caseyId,
    from: CASES.consultation.email, to: 'showroom@example.test', subject: CASES.consultation.title,
    body: 'Could we discuss our kitchen plans on ' + formatLondonDateTime(requestedStart) + '? Our budget is £40,000–£50,000. No installation date is confirmed.',
    at: new Date(now.getTime() - 30 * 60000).toISOString(), direction: 'incoming'
  });
  const cases = {
    quotation: makeCoreCase({
      id: 'quotation', namespace, sessionId, sourceHash, pinnedAt: now.toISOString(), snapshotDigest,
      currentLead: lead({
        id: robinId, caseId: 'quotation', name: CASES.quotation.name, email: CASES.quotation.email,
        budget: '£35,000–£45,000 (fictional customer estimate)', budgetMinPence: 3500000,
        budgetMaxPence: 4500000, timescale: 'Installation timing is unconfirmed.', quoteRef: 'DEMO-Q017'
      }),
      correspondence: [robinEnquiry, robinQuote]
    }),
    reply: makeCoreCase({
      id: 'reply', namespace, sessionId, sourceHash, pinnedAt: now.toISOString(), snapshotDigest,
      currentLead: lead({
        id: alexId, caseId: 'reply', name: CASES.reply.name, email: CASES.reply.email,
        budget: '', budgetMinPence: null, budgetMaxPence: null, timescale: ''
      }),
      correspondence: [alexMessage]
    }),
    consultation: makeCoreCase({
      id: 'consultation', namespace, sessionId, sourceHash, pinnedAt: now.toISOString(), snapshotDigest,
      currentLead: lead({
        id: caseyId, caseId: 'consultation', name: CASES.consultation.name, email: CASES.consultation.email,
        budget: '£40,000–£50,000 (fictional customer estimate)', budgetMinPence: 4000000,
        budgetMaxPence: 5000000, timescale: 'No installation date is confirmed.'
      }),
      correspondence: [caseyMessage],
      calendar: caseyCalendar(pack, namespace, sessionId, now, localDate)
    })
  };
  return Object.freeze(cases);
}

function encodeCursor(value) {
  return Buffer.from(canonicalJson(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length < 2048, 'INVALID_PAGE_CURSOR', 'The calendar page cursor is invalid.');
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new DateSnapshotError('INVALID_PAGE_CURSOR', 'The calendar page cursor is not valid.');
  }
}

export function createCurrentSnapshot(packet, {now, sessionId} = {}) {
  assert(packet && packet.integrityVerified === true, 'UNVERIFIED_PACKET', 'Load the date packet from its configured same-host path before selecting a snapshot.');
  assertPack(packet.pack);
  assert(SHA256.test(packet.sourceHash) && packet.sourceHash === EXPECTED_SHOWROOM_PACK_SHA256, 'SOURCE_HASH_MISMATCH', 'The packet source hash does not match the accepted showroom content.');
  assert(packet.aggregateSha256 === EXPECTED_PACKET_AGGREGATE, 'AGGREGATE_MISMATCH', 'The packet aggregate does not match the accepted content version.');
  assert(now instanceof Date && Number.isFinite(now.getTime()), 'INVALID_CLOCK', 'Use the trusted server Date object for the pinned snapshot.');
  assert(typeof sessionId === 'string' && SESSION_UUID.test(sessionId), 'SESSION_BINDING_REQUIRED', 'Bind the snapshot to the existing version-4 session UUID.');
  const trustedNow = new Date(now.getTime());
  const fixed = selectFixedSnapshot(packet.pack, trustedNow, packet.sourceHash);
  const result = {
    status: fixed.status,
    mode: 'demo',
    simulated: true,
    sourceKind: 'synthetic_fixture',
    seedId: packet.seedId,
    horizon: fixed.horizon,
    sourceHash: packet.sourceHash,
    aggregateSha256: packet.aggregateSha256,
    manifestSha256: packet.manifestSha256,
    snapshotDigest: fixed.snapshotDigest,
    pinnedAt: fixed.pinnedAt,
    timeZone: TIME_ZONE,
    localDate: fixed.localDate,
    sessionId
  };
  if (fixed.status === 'horizon_exhausted') {
    return Object.freeze({
      ...result,
      coverage: {status: 'horizon_exhausted', noFallback: true, fixedEmails: 0, fixedCustomers: 0, upcomingEvents: 0},
      fixedEmails: [], fixedCustomers: [], upcomingEvents: [], cases: Object.freeze({}), overlayDigest: null
    });
  }
  const cases = createCases(packet.pack, {
    now: trustedNow, sessionId, localDate: fixed.localDate, sourceHash: packet.sourceHash,
    snapshotDigest: fixed.snapshotDigest
  });
  const overlayDigest = digest(cases);
  const eventCursor = fixed.moreEvents ? encodeCursor({
    version: 1, offset: EVENT_PAGE_SIZE, sessionId, pinnedAt: fixed.pinnedAt,
    sourceHash: packet.sourceHash, snapshotDigest: fixed.snapshotDigest
  }) : null;
  const coverage = {
    status: 'bounded_presentation_snapshot',
    fixedEmails: fixed.mailCoverage,
    fixedCustomers: {scope: 'current_facts_with_support_ids', returned: fixed.fixedCustomers.length},
    upcomingEvents: {...fixed.calendarCoverage, nextPageCursor: eventCursor}
  };
  return Object.freeze({
    ...result, coverage, fixedEmails: fixed.fixedEmails, fixedCustomers: fixed.fixedCustomers,
    upcomingEvents: fixed.upcomingEvents, cases, overlayDigest
  });
}

export function getNextCalendarPage(packet, snapshot, pageCursor) {
  assert(packet && packet.integrityVerified === true, 'UNVERIFIED_PACKET', 'Load the date packet from its configured same-host packet path before paging.');
  assert(snapshot && snapshot.status === 'ready_offline', 'INVALID_SNAPSHOT', 'Calendar pages require a ready pinned snapshot.');
  assert(packet.sourceHash === snapshot.sourceHash && packet.aggregateSha256 === snapshot.aggregateSha256, 'SOURCE_MISMATCH', 'The page request belongs to a different sealed packet.');
  const cursor = decodeCursor(pageCursor);
  assert(cursor.version === 1 && cursor.sessionId === snapshot.sessionId, 'SESSION_BINDING_MISMATCH', 'The calendar page cursor belongs to a different session.');
  assert(cursor.pinnedAt === snapshot.pinnedAt && cursor.sourceHash === snapshot.sourceHash && cursor.snapshotDigest === snapshot.snapshotDigest, 'SNAPSHOT_BINDING_MISMATCH', 'The calendar page cursor belongs to a different pinned snapshot.');
  assert(Number.isSafeInteger(cursor.offset) && cursor.offset >= EVENT_PAGE_SIZE && cursor.offset % EVENT_PAGE_SIZE === 0, 'INVALID_PAGE_CURSOR', 'The calendar page offset is invalid.');
  const pinnedNow = new Date(snapshot.pinnedAt);
  assert(Number.isFinite(pinnedNow.getTime()), 'INVALID_SNAPSHOT', 'The pinned time is invalid.');
  const fixed = selectFixedSnapshot(packet.pack, pinnedNow, packet.sourceHash);
  assert(fixed.status === 'ready_offline' && fixed.snapshotDigest === snapshot.snapshotDigest, 'SNAPSHOT_BINDING_MISMATCH', 'The pinned fixed-data snapshot no longer matches its source.');
  const events = fixed.eventRows.slice(cursor.offset, cursor.offset + EVENT_PAGE_SIZE).map(sanitizedEvent);
  const nextOffset = cursor.offset + EVENT_PAGE_SIZE;
  const hasMore = fixed.eventRows.length > nextOffset;
  const nextPageCursor = hasMore ? encodeCursor({...cursor, offset: nextOffset}) : null;
  return Object.freeze({
    events,
    coverage: {
      scope: 'fixed_dataset_next_14_local_days',
      windowStart: fixed.pinnedAt,
      windowEndExclusive: fixed.eventWindowEndExclusive,
      timeZone: TIME_ZONE,
      pageSize: EVENT_PAGE_SIZE,
      offset: cursor.offset,
      returned: events.length,
      matchingTotal: fixed.eventTotal,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
      nextPageCursor
    },
    pinnedAt: snapshot.pinnedAt,
    timeZone: TIME_ZONE,
    sourceHash: snapshot.sourceHash,
    snapshotDigest: snapshot.snapshotDigest,
    sessionId: snapshot.sessionId,
    mode: 'demo',
    simulated: true,
    sourceKind: 'synthetic_fixture',
    origin: 'fixed_dataset'
  });
}
