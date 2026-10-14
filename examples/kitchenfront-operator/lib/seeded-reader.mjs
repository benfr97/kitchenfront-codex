import {createHash} from 'node:crypto';
import {EXPECTED_PACKET_AGGREGATE, TIME_ZONE} from './date-snapshot.mjs';

export const SEEDED_READER_CONTRACT = 'proposed-kitchenfront-seed-broker-v1';
export const SEEDED_ADMISSION_EVIDENCE_CONTRACT = 'proposed-kitchenfront-resource-admission-v1';
export const SEEDED_ADMISSION_EVIDENCE_STATUS = 'accepted_independent_resource_admission';
export const EXPECTED_DEMO_ACCOUNT_EMAIL = Object.freeze({
  google: 'hello@kitchenfront.co.uk',
  microsoft: 'kitchenfront@outlook.com',
});
export const SEEDED_READ_LIMITS = Object.freeze({mail: 5, calendar: 30, calendarWindowDays: 14});

const HEX_SHA256 = /^[a-f0-9]{64}$/i;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEMO_RESOURCE_NAME = 'Kitchen Front Demo';
const BINDING_KEYS = Object.freeze([
  'actorId', 'organizationId', 'sessionId', 'provider', 'accountEmail', 'subjectId', 'accountId',
  'clientId', 'grantId', 'grantRevision', 'resource', 'sourceAggregateSha256', 'seedRevision',
]);
const RECEIPT_KEYS = Object.freeze([
  'schema', 'status', 'acceptedAt', 'expiresAt', 'binding', 'seedLedger', 'guards', 'capabilities', 'broker',
]);
const SEED_COMMON_KEYS = Object.freeze(['fixtureId', 'source', 'providerRecordId', 'version', 'contentSha256']);
export const SEEDED_READ_GUARDS = Object.freeze({
  exactApprovedIdsOnly: true,
  exactDedicatedResourceOnly: true,
  noWideQueries: true,
  noPartialBatches: true,
  noFallback: true,
  mailMaxPast: SEEDED_READ_LIMITS.mail,
  calendarMaxEvents: SEEDED_READ_LIMITS.calendar,
  calendarWindowDays: SEEDED_READ_LIMITS.calendarWindowDays,
  timeZone: TIME_ZONE,
});
const SEEDED_READERS = new WeakSet();
const BROKER = Object.freeze({
  contract: SEEDED_READER_CONTRACT,
  requestMode: 'read_exact_approved_provider_ids',
  responseMode: 'complete_exact_provider_records',
  readOnly: true,
  supportsWideQueries: false,
  supportsWrites: false,
  supportsFallback: false,
});
const CAPABILITY_KEYS = Object.freeze(['mailRead', 'calendarRead', 'mailWrite', 'calendarWrite', 'send']);
const ADMISSION_EVIDENCE_KEYS = Object.freeze([
  'schema', 'status', 'binding', 'resources', 'resourceReview', 'guardReview',
  'capabilitiesSha256', 'crossClientCalendarBrokerReview',
]);
const DEFAULT_MAIL_RESOURCE_IDS = new Set([
  'inbox', 'sent', 'sentitems', 'draft', 'drafts', 'trash', 'deleted', 'deleteditems',
  'junk', 'junkemail', 'spam', 'archive', 'archived', 'starred', 'important', 'unread',
  'msgfolderroot', 'categorypersonal', 'categorysocial', 'categorypromotions', 'categoryupdates', 'categoryforums',
]);

export class SeededReaderError extends Error {
  constructor(code) {
    super('The accepted demo seed read could not be safely admitted.');
    this.name = 'SeededReaderError';
    this.code = code;
  }
}

export function isSeededReader(value) {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && SEEDED_READERS.has(value));
}

function reject(condition, code) {
  if (!condition) throw new SeededReaderError(code);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function nonEmpty(value, max = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function trustedSnapshot(value) {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    throw new SeededReaderError('INVALID_CONFIGURATION');
  }
}

function canonical(value) {
  return JSON.stringify(sorted(value)).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function seededContentSha256(content) {
  return sha256(Buffer.from(canonical(content), 'utf8'));
}

function parseJsonBytes(bytes) {
  reject(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 256_000, 'INVALID_RECEIPT_BYTES');
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    throw new SeededReaderError('INVALID_RECEIPT');
  }
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function instant(value) {
  const result = Date.parse(value);
  reject(Number.isFinite(result), 'INVALID_TIMESTAMP');
  return result;
}

function londonParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function londonDay(date) {
  const parts = londonParts(date);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addDays(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + days));
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function londonAt(day, hour) {
  const [year, month, date] = day.split('-').map(Number);
  const targetWall = Date.UTC(year, month - 1, date, hour, 0, 0);
  let candidate = targetWall;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = londonParts(new Date(candidate));
    const observedWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const correction = targetWall - observedWall;
    if (correction === 0) break;
    candidate += correction;
  }
  const dateValue = new Date(candidate);
  const actual = londonParts(dateValue);
  reject(actual.year === year && actual.month === month && actual.day === date && actual.hour === hour, 'INVALID_TIME_WINDOW');
  return dateValue.toISOString();
}

function normalizedResourceId(value) {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function validateResource(resource, provider, accountEmail) {
  reject(exactKeys(resource, ['mail', 'calendar']), 'INVALID_BINDING');
  const mailKind = provider === 'google' ? 'label' : 'folder';
  reject(exactKeys(resource.mail, ['kind', 'id', 'name', 'revision', 'isDefault']), 'INVALID_BINDING');
  reject(resource.mail.kind === mailKind && nonEmpty(resource.mail.id)
    && normalizedResourceId(resource.mail.id) !== normalizedResourceId(accountEmail)
    && !DEFAULT_MAIL_RESOURCE_IDS.has(normalizedResourceId(resource.mail.id))
    && resource.mail.name === DEMO_RESOURCE_NAME && nonEmpty(resource.mail.revision)
    && resource.mail.isDefault === false, 'INVALID_BINDING');
  reject(exactKeys(resource.calendar, ['kind', 'id', 'name', 'revision', 'isDefault']), 'INVALID_BINDING');
  reject(nonEmpty(resource.calendar.id), 'INVALID_BINDING');
  const calendarId = normalizedResourceId(resource.calendar.id);
  reject(resource.calendar.kind === 'app_created_secondary'
    && !['primary', 'default', 'me'].includes(calendarId)
    && calendarId !== normalizedResourceId(accountEmail)
    && resource.calendar.name === DEMO_RESOURCE_NAME && nonEmpty(resource.calendar.revision)
    && resource.calendar.isDefault === false, 'INVALID_BINDING');
}

function validateBinding(binding) {
  reject(exactKeys(binding, BINDING_KEYS), 'INVALID_BINDING');
  reject(nonEmpty(binding.actorId) && nonEmpty(binding.organizationId)
    && typeof binding.sessionId === 'string' && SESSION_UUID.test(binding.sessionId), 'INVALID_BINDING');
  reject(['google', 'microsoft'].includes(binding.provider), 'INVALID_BINDING');
  reject(binding.accountEmail === EXPECTED_DEMO_ACCOUNT_EMAIL[binding.provider], 'INVALID_BINDING');
  reject(nonEmpty(binding.subjectId) && nonEmpty(binding.accountId) && nonEmpty(binding.clientId) && nonEmpty(binding.grantId)
    && nonEmpty(binding.grantRevision) && nonEmpty(binding.seedRevision), 'INVALID_BINDING');
  reject(binding.sourceAggregateSha256 === EXPECTED_PACKET_AGGREGATE, 'SOURCE_AGGREGATE_MISMATCH');
  validateResource(binding.resource, binding.provider, binding.accountEmail);
}

function validateCapabilities(capabilities, provider) {
  reject(exactKeys(capabilities, CAPABILITY_KEYS), 'INVALID_CAPABILITIES');
  reject(capabilities.mailWrite === false && capabilities.calendarWrite === false && capabilities.send === false, 'INVALID_CAPABILITIES');
  reject(exactKeys(capabilities.mailRead, ['enabled', 'reviewRef', 'reviewSha256']) && capabilities.mailRead.enabled === true
    && nonEmpty(capabilities.mailRead.reviewRef) && HEX_SHA256.test(capabilities.mailRead.reviewSha256 ?? ''), 'INVALID_CAPABILITIES');
  reject(exactKeys(capabilities.calendarRead, [
    'enabled', 'reviewRef', 'reviewSha256', 'crossClient', 'crossClientReviewRef', 'crossClientReviewSha256',
  ]) && capabilities.calendarRead.enabled === true && nonEmpty(capabilities.calendarRead.reviewRef)
    && HEX_SHA256.test(capabilities.calendarRead.reviewSha256 ?? ''), 'INVALID_CAPABILITIES');
  reject(capabilities.calendarRead.crossClient === (provider === 'google'), 'INVALID_CAPABILITIES');
  if (provider === 'google') {
    reject(nonEmpty(capabilities.calendarRead.crossClientReviewRef)
      && HEX_SHA256.test(capabilities.calendarRead.crossClientReviewSha256 ?? ''), 'INVALID_CAPABILITIES');
  } else {
    reject(capabilities.calendarRead.crossClientReviewRef === null
      && capabilities.calendarRead.crossClientReviewSha256 === null, 'INVALID_CAPABILITIES');
  }
}

function verifyAdmissionEvidence({admissionEvidenceBytes, expectedAdmissionEvidenceSha256, binding, capabilities}) {
  reject(admissionEvidenceBytes instanceof Uint8Array && admissionEvidenceBytes.byteLength > 0
    && admissionEvidenceBytes.byteLength <= 128_000, 'INVALID_ADMISSION_EVIDENCE_BYTES');
  reject(HEX_SHA256.test(expectedAdmissionEvidenceSha256 ?? ''), 'UNKNOWN_ADMISSION_EVIDENCE');
  const evidenceHash = sha256(admissionEvidenceBytes);
  reject(evidenceHash === expectedAdmissionEvidenceSha256, 'UNKNOWN_ADMISSION_EVIDENCE');
  let evidence;
  try {
    evidence = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(admissionEvidenceBytes));
  } catch {
    throw new SeededReaderError('INVALID_ADMISSION_EVIDENCE');
  }
  reject(exactKeys(evidence, ADMISSION_EVIDENCE_KEYS)
    && evidence.schema === SEEDED_ADMISSION_EVIDENCE_CONTRACT
    && evidence.status === SEEDED_ADMISSION_EVIDENCE_STATUS, 'INVALID_ADMISSION_EVIDENCE');
  reject(canonical(evidence.binding) === canonical(binding)
    && canonical(evidence.resources) === canonical(binding.resource), 'ADMISSION_EVIDENCE_SCOPE_MISMATCH');
  reject(exactKeys(evidence.resourceReview, ['reviewRef', 'sha256', 'resourceSha256'])
    && nonEmpty(evidence.resourceReview.reviewRef)
    && HEX_SHA256.test(evidence.resourceReview.sha256 ?? '')
    && evidence.resourceReview.resourceSha256 === seededContentSha256(binding.resource), 'INVALID_RESOURCE_REVIEW');
  reject(exactKeys(evidence.guardReview, ['reviewRef', 'sha256', 'guardsSha256'])
    && nonEmpty(evidence.guardReview.reviewRef)
    && HEX_SHA256.test(evidence.guardReview.sha256 ?? '')
    && evidence.guardReview.guardsSha256 === seededContentSha256(SEEDED_READ_GUARDS), 'INVALID_GUARD_REVIEW');
  reject(evidence.capabilitiesSha256 === seededContentSha256(capabilities), 'INVALID_CAPABILITY_EVIDENCE');
  if (binding.provider === 'google') {
    const review = evidence.crossClientCalendarBrokerReview;
    reject(exactKeys(review, [
      'reviewRef', 'sha256', 'provider', 'accountEmail', 'subjectId', 'accountId', 'clientId',
      'grantId', 'grantRevision', 'resourceId', 'resourceRevision',
    ]) && nonEmpty(review.reviewRef) && HEX_SHA256.test(review.sha256 ?? '')
      && review.provider === 'google' && review.accountEmail === binding.accountEmail
      && review.subjectId === binding.subjectId && review.accountId === binding.accountId
      && review.clientId === binding.clientId && review.grantId === binding.grantId
      && review.grantRevision === binding.grantRevision
      && review.resourceId === binding.resource.calendar.id
      && review.resourceRevision === binding.resource.calendar.revision
      && review.reviewRef === capabilities.calendarRead.crossClientReviewRef
      && review.sha256 === capabilities.calendarRead.crossClientReviewSha256, 'INVALID_CROSS_CLIENT_REVIEW');
  } else reject(evidence.crossClientCalendarBrokerReview === null, 'INVALID_CROSS_CLIENT_REVIEW');
  return {evidenceHash, evidence};
}

function validateSeeds(seeds, pinnedAt) {
  reject(Array.isArray(seeds) && seeds.length > 0 && seeds.length <= SEEDED_READ_LIMITS.mail + SEEDED_READ_LIMITS.calendar, 'INVALID_SEED_LEDGER');
  const fixtureIds = new Set();
  const providerIds = new Set();
  for (const seed of seeds) {
    reject(seed && ['mail', 'calendar'].includes(seed.source), 'INVALID_SEED_LEDGER');
    const expectedKeys = seed.source === 'mail'
      ? [...SEED_COMMON_KEYS, 'receivedAt']
      : [...SEED_COMMON_KEYS, 'start', 'end'];
    reject(exactKeys(seed, expectedKeys), 'INVALID_SEED_LEDGER');
    reject(nonEmpty(seed.fixtureId) && nonEmpty(seed.providerRecordId) && nonEmpty(seed.version)
      && HEX_SHA256.test(seed.contentSha256), 'INVALID_SEED_LEDGER');
    reject(!fixtureIds.has(seed.fixtureId) && !providerIds.has(seed.providerRecordId), 'DUPLICATE_SEED_ID');
    fixtureIds.add(seed.fixtureId);
    providerIds.add(seed.providerRecordId);
    if (seed.source === 'mail') {
      reject(isTimestamp(seed.receivedAt) && instant(seed.receivedAt) <= Date.parse(pinnedAt), 'FUTURE_OR_INVALID_MAIL');
    } else {
      reject(isTimestamp(seed.start) && isTimestamp(seed.end), 'INVALID_TIMESTAMP');
      const start = instant(seed.start);
      const end = instant(seed.end);
      const windowEnd = instant(safeTimeWindow('calendar', pinnedAt).endExclusive);
      reject(start < windowEnd && end > Date.parse(pinnedAt) && end > start && end <= windowEnd, 'CALENDAR_OUT_OF_WINDOW');
    }
  }
  reject(seeds.filter(seed => seed.source === 'mail').length <= SEEDED_READ_LIMITS.mail
    && seeds.filter(seed => seed.source === 'calendar').length <= SEEDED_READ_LIMITS.calendar, 'SEED_LIMIT');
}

function verifyReceipt({acceptedReceiptBytes, expectedReceiptSha256, binding, capabilities, now}) {
  reject(acceptedReceiptBytes instanceof Uint8Array && acceptedReceiptBytes.byteLength > 0
    && acceptedReceiptBytes.byteLength <= 256_000, 'INVALID_RECEIPT_BYTES');
  reject(HEX_SHA256.test(expectedReceiptSha256 ?? ''), 'UNKNOWN_RECEIPT');
  const receiptHash = sha256(acceptedReceiptBytes);
  reject(receiptHash === expectedReceiptSha256, 'UNKNOWN_RECEIPT');
  const receipt = parseJsonBytes(acceptedReceiptBytes);
  reject(exactKeys(receipt, RECEIPT_KEYS) && receipt.schema === SEEDED_READER_CONTRACT
    && receipt.status === 'accepted_demo_seed', 'INVALID_RECEIPT');
  reject(canonical(receipt.binding) === canonical(binding), 'BINDING_MISMATCH');
  reject(canonical(receipt.guards) === canonical(SEEDED_READ_GUARDS) && canonical(receipt.broker) === canonical(BROKER), 'REVIEW_METADATA_MISMATCH');
  reject(canonical(receipt.capabilities) === canonical(capabilities), 'INVALID_CAPABILITIES');
  validateSeeds(receipt.seedLedger, new Date(now).toISOString());
  reject(isTimestamp(receipt.acceptedAt) && isTimestamp(receipt.expiresAt), 'INVALID_RECEIPT');
  reject(instant(receipt.acceptedAt) <= now && instant(receipt.expiresAt) > now, 'RECEIPT_EXPIRED');
  return {receiptHash, receipt};
}

function safeTimeWindow(source, pinnedAt) {
  if (source === 'mail') return {timeZone: TIME_ZONE, endExclusive: pinnedAt};
  return {
    timeZone: TIME_ZONE,
    startInclusive: pinnedAt,
    endExclusive: londonAt(addDays(londonDay(new Date(pinnedAt)), SEEDED_READ_LIMITS.calendarWindowDays), 9),
  };
}

function validateContent(source, provider, binding, content, pinnedAt, maxBytes) {
  reject(content && typeof content === 'object' && !Array.isArray(content), 'MALFORMED_RECORD');
  reject(Buffer.byteLength(canonical(content), 'utf8') <= maxBytes, 'RECORD_SIZE_LIMIT');
  if (source === 'mail') {
    const keys = provider === 'google'
      ? ['receivedAt', 'direction', 'from', 'to', 'subject', 'body', 'labelIds']
      : ['receivedAt', 'direction', 'from', 'to', 'subject', 'body', 'parentFolderId'];
    reject(exactKeys(content, keys), 'MALFORMED_RECORD');
    reject(isTimestamp(content.receivedAt) && instant(content.receivedAt) <= Date.parse(pinnedAt), 'FUTURE_OR_INVALID_MAIL');
    reject(nonEmpty(content.direction, 32) && nonEmpty(content.from, 320) && nonEmpty(content.to, 320)
      && typeof content.subject === 'string' && content.subject.length <= 500
      && typeof content.body === 'string' && content.body.length <= 12_000, 'MALFORMED_RECORD');
    if (provider === 'google') {
      reject(Array.isArray(content.labelIds) && content.labelIds.length > 0 && content.labelIds.length <= 100
        && content.labelIds.every(labelId => nonEmpty(labelId))
        && new Set(content.labelIds).size === content.labelIds.length
        && content.labelIds.includes(binding.resource.mail.id), 'MAIL_RESOURCE_MISMATCH');
    } else reject(content.parentFolderId === binding.resource.mail.id, 'MAIL_RESOURCE_MISMATCH');
    return;
  }
  reject(exactKeys(content, ['calendarId', 'start', 'end', 'title', 'status', 'busy']), 'MALFORMED_RECORD');
  reject(content.calendarId === binding.resource.calendar.id, 'CALENDAR_RESOURCE_MISMATCH');
  reject(isTimestamp(content.start) && isTimestamp(content.end), 'INVALID_TIMESTAMP');
  const start = instant(content.start);
  const end = instant(content.end);
  const windowEnd = instant(safeTimeWindow('calendar', pinnedAt).endExclusive);
  reject(start < windowEnd && end > Date.parse(pinnedAt) && end > start && end <= windowEnd, 'CALENDAR_OUT_OF_WINDOW');
  reject(nonEmpty(content.title, 500) && nonEmpty(content.status, 64) && typeof content.busy === 'boolean', 'MALFORMED_RECORD');
}

function validateScope(result, binding, receiptHash, capabilities) {
  reject(exactKeys(result, ['status', 'scope', 'coverage', 'records']) && result.status === 'ok', 'BROKER_FAILURE');
  reject(exactKeys(result.scope, ['binding', 'receiptSha256', 'capabilities'])
    && canonical(result.scope.binding) === canonical(binding)
    && result.scope.receiptSha256 === receiptHash
    && canonical(result.scope.capabilities) === canonical(capabilities), 'BROKER_SCOPE_MISMATCH');
}

function validateCoverage(coverage, source, requestedCount, recordCount) {
  reject(exactKeys(coverage, ['source', 'queryMode', 'requestedCount', 'returnedCount', 'hasMore', 'nextCursor'])
    && coverage.source === source && coverage.queryMode === 'exact_approved_ids'
    && coverage.requestedCount === requestedCount && coverage.returnedCount === recordCount
    && typeof coverage.hasMore === 'boolean', 'BROKER_COVERAGE_MISMATCH');
  if (coverage.hasMore) reject(nonEmpty(coverage.nextCursor, 1024), 'BROKER_COVERAGE_MISMATCH');
  else reject(coverage.nextCursor === null, 'BROKER_COVERAGE_MISMATCH');
  reject(recordCount === requestedCount, 'INCOMPLETE_BATCH');
}

function safeCoverage(source, count) {
  return {source, scope: 'exact_approved_ids', requested: count, returned: count, hasMore: false, nextCursor: null};
}

function readSignal(options) {
  if (options === undefined) return null;
  reject(exactKeys(options, ['signal']) && typeof AbortSignal !== 'undefined'
    && options.signal instanceof AbortSignal, 'INVALID_READ_OPTIONS');
  return options.signal;
}

function rejectIfAborted(signal) {
  if (signal?.aborted) throw new SeededReaderError('READ_ABORTED');
}

function validateProviderRecords({result, source, requestedSeeds, binding, receiptHash, capabilities, pinnedAt}) {
  validateScope(result, binding, receiptHash, capabilities);
  const records = result.records;
  reject(Array.isArray(records) && records.length <= (source === 'mail' ? SEEDED_READ_LIMITS.mail : SEEDED_READ_LIMITS.calendar), 'BROKER_COVERAGE_MISMATCH');
  const maxResponseBytes = source === 'mail' ? 81_920 : 245_760;
  reject(Buffer.byteLength(canonical(records), 'utf8') <= maxResponseBytes, 'RESPONSE_SIZE_LIMIT');
  validateCoverage(result.coverage, source, requestedSeeds.length, records.length);
  const byId = new Map(requestedSeeds.map(seed => [seed.providerRecordId, seed]));
  const seen = new Set();
  const validated = [];
  for (const record of records) {
    reject(exactKeys(record, ['providerRecordId', 'version', 'content'])
      && nonEmpty(record.providerRecordId) && nonEmpty(record.version), 'MALFORMED_RECORD');
    const seed = byId.get(record.providerRecordId);
    reject(seed && !seen.has(record.providerRecordId), 'UNEXPECTED_OR_DUPLICATE_RECORD');
    reject(record.version === seed.version, 'RECORD_VERSION_MISMATCH');
    validateContent(source, binding.provider, binding, record.content, pinnedAt,
      source === 'mail' ? 16_384 : 8_192);
    if (source === 'mail') reject(record.content.receivedAt === seed.receivedAt, 'SEED_TIMESTAMP_MISMATCH');
    else reject(record.content.start === seed.start && record.content.end === seed.end, 'SEED_TIMESTAMP_MISMATCH');
    const contentSha256 = seededContentSha256(record.content);
    reject(contentSha256 === seed.contentSha256, 'RECORD_DIGEST_MISMATCH');
    seen.add(record.providerRecordId);
    validated.push({
      fixtureId: seed.fixtureId,
      providerRecordId: seed.providerRecordId,
      providerVersion: seed.version,
      contentSha256,
      content: structuredClone(record.content),
      provenance: {
        sourceKind: 'provider_seed_readback',
        provider: binding.provider,
        accountEmail: binding.accountEmail,
        resourceId: source === 'mail' ? binding.resource.mail.id : binding.resource.calendar.id,
        grantRevision: binding.grantRevision,
        resourceRevision: source === 'mail' ? binding.resource.mail.revision : binding.resource.calendar.revision,
        seedRevision: binding.seedRevision,
        sourceAggregateSha256: binding.sourceAggregateSha256,
        acceptedReceiptSha256: receiptHash,
        sessionId: binding.sessionId,
        actorId: binding.actorId,
        organizationId: binding.organizationId,
        pinnedAt,
        timeZone: TIME_ZONE,
      },
    });
  }
  reject(seen.size === requestedSeeds.length, 'INCOMPLETE_BATCH');
  return validated;
}

/**
 * Server-only proposal port. Its config and broker must come from trusted
 * operator state; callers receive only `readAcceptedSeeds()` with no selectors.
 */
export function createSeededReader({
  binding,
  acceptedReceiptBytes,
  expectedReceiptSha256,
  admissionEvidenceBytes,
  expectedAdmissionEvidenceSha256,
  capabilities,
  broker,
  clock = Date.now,
}) {
  const trustedBinding = trustedSnapshot(binding);
  const trustedCapabilities = trustedSnapshot(capabilities);
  validateBinding(trustedBinding);
  validateCapabilities(trustedCapabilities, trustedBinding.provider);
  reject(typeof broker === 'function' && typeof clock === 'function', 'INVALID_CONFIGURATION');
  const initialNow = clock();
  reject(Number.isFinite(initialNow) && Number.isFinite(new Date(initialNow).getTime()), 'INVALID_CLOCK');
  const pinnedAt = new Date(initialNow).toISOString();
  const {receiptHash, receipt} = verifyReceipt({
    acceptedReceiptBytes,
    expectedReceiptSha256,
    binding: trustedBinding,
    capabilities: trustedCapabilities,
    now: initialNow,
  });
  const {evidenceHash, evidence} = verifyAdmissionEvidence({
    admissionEvidenceBytes,
    expectedAdmissionEvidenceSha256,
    binding: trustedBinding,
    capabilities: trustedCapabilities,
  });
  const ledger = receipt.seedLedger;
  const admissionScope = deepFreeze({
    ...structuredClone(trustedBinding),
    capabilities: structuredClone(trustedCapabilities),
    guardsSha256: seededContentSha256(SEEDED_READ_GUARDS),
    acceptedReceiptSha256: receiptHash,
    admissionEvidenceSha256: evidenceHash,
    admissionEvidenceStatus: evidence.status,
  });

  async function readSource(source, signal) {
    rejectIfAborted(signal);
    const seeds = ledger.filter(seed => seed.source === source);
    if (!seeds.length) return {records: [], coverage: safeCoverage(source, 0)};
    const limit = source === 'mail' ? SEEDED_READ_LIMITS.mail : SEEDED_READ_LIMITS.calendar;
    const currentNow = clock();
    reject(seeds.length <= limit, 'SEED_LIMIT');
    reject(Number.isFinite(currentNow) && Number.isFinite(new Date(currentNow).getTime()), 'INVALID_CLOCK');
    reject(instant(receipt.expiresAt) > currentNow, 'RECEIPT_EXPIRED');
    const request = deepFreeze({
      contract: SEEDED_READER_CONTRACT,
      operation: 'read_exact_approved_provider_ids',
      source,
      binding: structuredClone(trustedBinding),
      capabilities: structuredClone(trustedCapabilities),
      acceptedReceiptSha256: receiptHash,
      resource: structuredClone(source === 'mail' ? trustedBinding.resource.mail : trustedBinding.resource.calendar),
      providerRecordIds: seeds.map(seed => seed.providerRecordId),
      limit: Math.min(limit, seeds.length),
      timeWindow: safeTimeWindow(source, pinnedAt),
      maxRecordBytes: source === 'mail' ? 16_384 : 8_192,
      maxResponseBytes: source === 'mail' ? 81_920 : 245_760,
      guards: SEEDED_READ_GUARDS,
    });
    let result;
    try {
      result = await broker(request, Object.freeze({signal}));
    } catch {
      rejectIfAborted(signal);
      throw new SeededReaderError('BROKER_FAILURE');
    }
    rejectIfAborted(signal);
    let records;
    try {
      records = validateProviderRecords({
        result,
        source,
        requestedSeeds: seeds,
        binding: trustedBinding,
        receiptHash,
        capabilities: trustedCapabilities,
        pinnedAt,
      });
    } catch (error) {
      if (error instanceof SeededReaderError) throw error;
      throw new SeededReaderError('MALFORMED_RESPONSE');
    }
    return {records, coverage: structuredClone(result.coverage)};
  }

  const reader = Object.freeze({
    pinnedAt,
    timeZone: TIME_ZONE,
    admissionScope,
    async readAcceptedSeeds(options) {
      const signal = readSignal(options);
      rejectIfAborted(signal);
      const currentNow = clock();
      reject(Number.isFinite(currentNow) && Number.isFinite(new Date(currentNow).getTime()), 'INVALID_CLOCK');
      reject(instant(receipt.expiresAt) > currentNow, 'RECEIPT_EXPIRED');
      const mail = await readSource('mail', signal);
      rejectIfAborted(signal);
      const calendar = await readSource('calendar', signal);
      rejectIfAborted(signal);
      const beforeRelease = clock();
      reject(Number.isFinite(beforeRelease) && Number.isFinite(new Date(beforeRelease).getTime()), 'INVALID_CLOCK');
      reject(instant(receipt.expiresAt) > beforeRelease, 'RECEIPT_EXPIRED');
      return Object.freeze({
        status: 'provider_seed_readback',
        sourceKind: 'provider_seed_readback',
        coverageBasis: 'bounded_accepted_seed_view',
        overallSourceCoverage: 'UNKNOWN',
        provider: trustedBinding.provider,
        accountEmail: trustedBinding.accountEmail,
        sessionScope: admissionScope,
        pinnedAt,
        timeZone: TIME_ZONE,
        sourceAggregateSha256: trustedBinding.sourceAggregateSha256,
        seedRevision: trustedBinding.seedRevision,
        acceptedReceiptSha256: receiptHash,
        mail: {records: mail.records, coverage: mail.coverage},
        calendar: {records: calendar.records, coverage: calendar.coverage},
      });
    },
  });
  SEEDED_READERS.add(reader);
  return reader;
}
