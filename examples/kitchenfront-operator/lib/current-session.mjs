import {randomUUID} from 'node:crypto';
import {createCurrentSnapshot} from './date-snapshot.mjs';

const londonCalendarDay = value => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric'}).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000;
};

// Operator configuration supplies the sealed packet. Neither HTTP payloads nor
// model arguments can select the clock, packet, session or organisation.
export function currentStateFactory(packet) {
  return nowMillis => {
    const generation = randomUUID();
    const snapshot = createCurrentSnapshot(packet, {now: new Date(nowMillis), sessionId: generation});
    return {generation, messages: [], proposals: [], activity: [], requests: {}, engineThreadId: null,
      appointments: [], snapshot};
  };
}

export function publicDateContext(state) {
  const snapshot = state.snapshot;
  if (!snapshot) return {status: 'historical_protocol_fixture', localDate: '2026-10-13', timeZone: 'Europe/London'};
  return {status: snapshot.status, pinnedAt: snapshot.pinnedAt, localDate: snapshot.localDate,
    timeZone: snapshot.timeZone, sourceHash: snapshot.sourceHash, snapshotDigest: snapshot.snapshotDigest,
    coverage: snapshot.coverage, fictional: true, origin: 'session_synthetic_overlay',
    cases: Object.fromEntries(Object.entries(snapshot.cases).map(([id, value]) => [id, {
      latestMessageAt: value.correspondence.at(-1)?.createdAt,
      requestedStart: value.calendar?.requested?.start,
      knownMissing: value.knownMissing,
      quoteAgeDays: id === 'quotation' ? londonCalendarDay(snapshot.pinnedAt) - londonCalendarDay(value.correspondence.at(-1).createdAt) : undefined
    }]))};
}
