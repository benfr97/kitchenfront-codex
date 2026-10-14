import {isDeepStrictEqual} from 'node:util';
import {isSeededReader, EXPECTED_DEMO_ACCOUNT_EMAIL} from './seeded-reader.mjs';
import {EXPECTED_PACKET_AGGREGATE} from './date-snapshot.mjs';
import {DemoError} from './fixtures.mjs';

export function assertSeedReaders(readers, sessionId, principal) {
  if (!principal || typeof principal.actorId !== 'string' || !principal.actorId || typeof principal.organizationId !== 'string' || !principal.organizationId) throw new DemoError('SHARED_CONNECTION_NOT_ADMITTED', 'The independently approved demo principal is missing.', 503);
  if (!Array.isArray(readers) || readers.length !== 2) throw new DemoError('SHARED_CONNECTION_NOT_ADMITTED', 'Both approved account readers are required.', 503);
  const expected = new Set(['google', 'microsoft']);
  for (const reader of readers) {
    if (!isSeededReader(reader)) throw new DemoError('UNBRANDED_READER', 'The account reader has not passed the restricted admission boundary.', 503);
    const scope = reader.admissionScope;
    if (!scope || scope.sessionId !== sessionId || scope.actorId !== principal.actorId || scope.organizationId !== principal.organizationId || !expected.delete(scope.provider) || scope.accountEmail !== EXPECTED_DEMO_ACCOUNT_EMAIL[scope.provider] || scope.sourceAggregateSha256 !== EXPECTED_PACKET_AGGREGATE) throw new DemoError('PROVIDER_SCOPE_MISMATCH', 'The account readers do not match this approved session and principal.', 503);
  }
}

export function assertSeedReadback(result, reader) {
  if (result?.status !== 'provider_seed_readback' || result.sourceKind !== 'provider_seed_readback' || result.coverageBasis !== 'bounded_accepted_seed_view' || result.overallSourceCoverage !== 'UNKNOWN' || result.provider !== reader.admissionScope.provider || result.accountEmail !== reader.admissionScope.accountEmail || !isDeepStrictEqual(result.sessionScope, reader.admissionScope)) throw new DemoError('PROVIDER_SCOPE_MISMATCH', 'The returned records do not match the independently admitted reader scope.', 503);
}

// This is a response deadline, never a claim that a remote provider cancelled.
// Callers retain their active guard until `settled` confirms both owned readers.
export function boundedSeedOperation(operation, {controller, timeoutMs, onSettled}) {
  let settled = false;
  const interruption = () => controller.signal.reason instanceof DemoError ? controller.signal.reason : new DemoError('SEED_READ_INTERRUPTED_UNKNOWN', 'The read was interrupted. No partial records are released; further actions remain held until owned reads settle.', 503);
  const work = Promise.resolve().then(() => { if (controller.signal.aborted) throw interruption(); return operation(); }).finally(() => { settled = true; onSettled(); });
  work.catch(() => {});
  let timer;
  let abortListener;
  const interrupted = new Promise((_, reject) => {
    abortListener = () => reject(interruption());
    controller.signal.addEventListener('abort', abortListener, {once: true});
    if (controller.signal.aborted) abortListener();
    timer = setTimeout(() => controller.abort(), timeoutMs);
  });
  return {
    response: Promise.race([work, interrupted]).finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', abortListener); }),
    completion: work.then(() => undefined, () => undefined),
    get settled() { return settled; },
  };
}
