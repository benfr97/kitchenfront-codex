import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID, timingSafeEqual, createHash} from 'node:crypto';
import {SessionStore} from './lib/store.mjs';
import {DemoError, replayScenario, decideProposal, CASE_IDS} from './lib/fixtures.mjs';
import {loadSealedPacket} from './lib/date-snapshot.mjs';
import {currentStateFactory, publicDateContext} from './lib/current-session.mjs';
import {SeededReaderError} from './lib/seeded-reader.mjs';
import {assertSeedReaders, assertSeedReadback, boundedSeedOperation} from './lib/seeded-session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BLOCKER = 'Live AI is disabled until the credential, external-network policy and bounded model-test budget are approved and checked. Offline replay only tests the interface.';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const exact = (body, keys) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new DemoError('INVALID_REQUEST', 'The request does not match this demo action.');
};
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicState = session => ({csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString(), generation: session.state.generation,
  engine: {name: 'Codex App Server', version: 'custom fork 0.0.0', status: 'not_verified'}, dateContext: publicDateContext(session.state),
  liveEnabled: false, liveBlocker: BLOCKER, messages: session.state.messages, proposals: session.state.proposals, activity: session.state.activity});

async function jsonBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw new DemoError('CONTENT_TYPE', 'Send a JSON request.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new DemoError('REQUEST_TOO_LARGE', 'This request is too large.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DemoError('INVALID_JSON', 'The request must contain valid JSON.'); }
}
function json(res, status, value) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }

export function createPrototypeServer({store, seededReadersForSession = null, seededPrincipal = null, seedReadTimeoutMs = 15000} = {}) {
  if (!(store instanceof SessionStore)) throw new Error('Provide an explicit owned session store with its reviewed state factory.');
  if (!Number.isInteger(seedReadTimeoutMs) || seedReadTimeoutMs < 10 || seedReadTimeoutMs > 30000) throw new Error('Use a bounded seed-read deadline.');
  const principal = seededPrincipal && Object.freeze(structuredClone(seededPrincipal));
  const principalReady = principal && Object.keys(principal).sort().join(',') === 'actorId,organizationId' && [principal.actorId, principal.organizationId].every(value => typeof value === 'string' && value.trim() && value.length <= 256);
  const active = new Map();
  const seedReaders = new Map();
  const pendingSeedOperations = new Set();
  let cleanupPromise = Promise.resolve();
  const dropReaders = generation => {
    const cached = seedReaders.get(generation);
    if (cached) clearTimeout(cached.expiryTimer);
    seedReaders.delete(generation);
  };
  const pruneReaders = () => { for (const [key, value] of seedReaders) if (value.expiresAt <= store.now()) dropReaders(key); };
  const requireIdle = token => {
    const current = active.get(token);
    if (current) throw new DemoError(current.status === 'blocked_unknown' ? 'READ_CLEANUP_UNKNOWN' : 'REQUEST_ACTIVE', current.status === 'blocked_unknown' ? 'The owned account read has not settled after interruption. Further actions remain held for reconciliation.' : 'Wait for the current request to finish.', 409);
  };
  const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']]]);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      pruneReaders();
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) throw new DemoError('HOST_REJECTED', 'Use this prototype’s local address.', 403);
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new DemoError('ORIGIN_REJECTED', 'A different site cannot use this prototype.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new DemoError('ORIGIN_REJECTED', 'A different site cannot use this prototype.', 403);
      const path = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (req.method === 'GET' && files.has(path)) {
        const [name, type] = files.get(path); res.writeHead(200, {'Content-Type': `${type}; charset=utf-8`}); res.end(readFileSync(join(here, 'public', name))); return;
      }
      if (!path.startsWith('/api/')) throw new DemoError('NOT_FOUND', 'This route is not part of the prototype.', 404);
      const token = /(?:^|;\s*)kf_demo=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
      let session = store.get(token);
      if (req.method === 'GET' && path === '/api/session') {
        if (!session) { session = store.create(); res.setHeader('Set-Cookie', `kf_demo=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`); }
        json(res, 200, {...publicState(session), providerReadState: active.get(session.token)?.status ?? null}); return;
      }
      if (req.method !== 'POST') throw new DemoError('METHOD_NOT_ALLOWED', 'This API action requires POST.', 405);
      if (!session) throw new DemoError('SESSION_REQUIRED', 'Open the fictional session before continuing.', 401);
      if (req.headers.origin !== `http://${req.headers.host}` || !equal(req.headers['x-csrf-token'], session.csrfToken)) throw new DemoError('CSRF_REJECTED', 'Reload this page before continuing.', 403);
      const body = await jsonBody(req);
      if (path === '/api/seeded-records') {
        exact(body, []);
        if (typeof seededReadersForSession !== 'function') throw new DemoError('SHARED_CONNECTION_NOT_ADMITTED', 'The shared demo accounts are awaiting the accepted restricted broker and seed receipts.', 503);
        if (!principalReady) throw new DemoError('SHARED_CONNECTION_NOT_ADMITTED', 'The independently approved demo principal is missing.', 503);
        requireIdle(session.token);
        const generation = session.state.generation;
        if (session.state.snapshot?.status !== 'ready_offline') throw new DemoError('SNAPSHOT_REQUIRED', 'A current server-pinned demo session is required.', 409);
        const controller = new AbortController();
        const entry = {controller, status: 'running'};
        active.set(session.token, entry);
        const ensureCurrent = () => {
          if (controller.signal.aborted) throw new DemoError('SEED_READ_INTERRUPTED_UNKNOWN', 'The account read was interrupted. No records are released.', 503);
          if (store.get(session.token) !== session || session.expiresAt <= store.now() || session.state.generation !== generation) throw new DemoError('SESSION_EXPIRED_DURING_READ', 'This session expired or changed while the account records were being read.', 401);
        };
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnected);
        const sessionExpiryTimer = setTimeout(() => controller.abort(new DemoError('SESSION_EXPIRED_DURING_READ', 'This session expired while the account records were being read.', 401)), Math.max(1, session.expiresAt - store.now()));
        sessionExpiryTimer.unref();
        const operation = boundedSeedOperation(async () => {
          ensureCurrent();
          if (!seedReaders.has(generation)) {
            // Only server configuration supplies principal, broker and receipts.
            const readers = await seededReadersForSession(Object.freeze({sessionId: generation, clock: store.now, principal, signal: controller.signal}));
            ensureCurrent();
            assertSeedReaders(readers, generation, principal);
            const cached = {expiresAt: session.expiresAt, readers: Object.freeze([...readers])};
            cached.expiryTimer = setTimeout(() => dropReaders(generation), Math.max(1, session.expiresAt - store.now()));
            cached.expiryTimer.unref();
            seedReaders.set(generation, cached);
          }
          const readers = seedReaders.get(generation).readers;
          assertSeedReaders(readers, generation, principal);
          const reads = await Promise.allSettled(readers.map(reader => reader.readAcceptedSeeds({signal: controller.signal})));
          ensureCurrent();
          const failure = reads.find(read => read.status === 'rejected');
          if (failure) throw failure.reason;
          const snapshots = reads.map((read, index) => { assertSeedReadback(read.value, readers[index]); return read.value; });
          ensureCurrent();
          return {status: 'provider_seed_readback', generation, snapshots};
        }, {controller, timeoutMs: seedReadTimeoutMs, onSettled: () => { if (active.get(session.token) === entry) active.delete(session.token); }});
        pendingSeedOperations.add(operation.completion);
        operation.completion.then(() => { clearTimeout(sessionExpiryTimer); pendingSeedOperations.delete(operation.completion); });
        try {
          const result = await operation.response;
          ensureCurrent(); json(res, 200, result); return;
        } finally {
          res.off('close', disconnected);
          if (!operation.settled) entry.status = 'blocked_unknown';
        }
      }
      if (path === '/api/turns') {
        exact(body, ['requestId', 'question']);
        if (!uuid(body.requestId) || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2400) throw new DemoError('INVALID_REQUEST', 'Provide a new request ID and a short question.');
        throw new DemoError('LIVE_AI_DISABLED', BLOCKER, 503);
      }
      if (path === '/api/stop') {
        exact(body, ['requestId']); if (!uuid(body.requestId)) throw new DemoError('INVALID_REQUEST', 'Provide the exact request ID.');
        // No inference is started in this build. A missing task is not proof of provider cancellation.
        json(res, 200, {status: 'not_running', providerCancellation: 'not_applicable', message: 'No live AI request is running in this build.'}); return;
      }
      requireIdle(session.token);
      if (path === '/api/reset') {
        exact(body, []); const priorGeneration = session.state.generation; store.replaceState(session, store.freshState()); dropReaders(priorGeneration); json(res, 200, publicState(session)); return;
      }
      const decision = /^\/api\/proposals\/([0-9a-f-]+)\/decision$/.exec(path);
      if (decision) {
        exact(body, ['decision', 'revision']);
        const working = structuredClone(session.state); const result = decideProposal(working, decision[1], body.decision, body.revision);
        store.replaceState(session, working); json(res, 200, result); return;
      }
      if (path !== '/api/replay') throw new DemoError('NOT_FOUND', 'This route is not part of the prototype.', 404);
      exact(body, ['scenario', 'requestId']);
      if (!CASE_IDS.includes(body.scenario) || !uuid(body.requestId)) throw new DemoError('INVALID_REQUEST', 'Choose one of the three fictional cases and a new request ID.');
      const previous = session.state.requests[body.requestId];
      if (previous) {
        if (previous.fingerprint !== fingerprint(body)) throw new DemoError('REQUEST_CONFLICT', 'That request ID already belongs to different content.', 409);
        json(res, 409, {code: 'REQUEST_ALREADY_RECORDED', message: 'This request is already recorded. Reload the saved session; it was not repeated.', status: previous.status}); return;
      }
      if (Object.keys(session.state.requests).length >= 24) throw new DemoError('CAPACITY', 'Reset this fictional session before replaying more requests.', 409);
      const working = structuredClone(session.state); const turnId = randomUUID(); const createdAt = new Date().toISOString();
      working.requests[body.requestId] = {fingerprint: fingerprint(body), status: 'running', mode: 'offline_replay'};
      working.activity.push({id: turnId, kind: 'turn', label: `Offline ${body.scenario} replay`, status: 'running', createdAt, mode: 'offline_replay', requestId: body.requestId});
      working.messages.push({id: randomUUID(), role: 'user', text: `Replay the fictional ${body.scenario} case.`, createdAt, mode: 'offline_replay', requestId: body.requestId});
      store.replaceState(session, working); active.set(session.token, body.requestId);
      res.writeHead(200, {'Content-Type': 'application/x-ndjson; charset=utf-8'});
      const emit = event => { if (!res.destroyed) res.write(`${JSON.stringify({...event, requestId: body.requestId, mode: 'offline_replay'})}\n`); };
      try {
        emit({type: 'turn.started', turnId});
        const completed = structuredClone(working); const result = await replayScenario(completed, body.scenario, body.requestId, emit);
        completed.requests[body.requestId].status = 'completed'; completed.activity.find(item => item.id === turnId).status = 'completed';
        completed.messages.push({id: randomUUID(), role: 'assistant', text: result.answer, createdAt: new Date().toISOString(), mode: 'offline_replay', requestId: body.requestId});
        store.replaceState(session, completed); emit({type: 'turn.completed', turnId, ...result});
      } catch (error) {
        const failed = structuredClone(working); failed.requests[body.requestId].status = 'failed'; failed.activity.find(item => item.id === turnId).status = 'failed';
        store.replaceState(session, failed); emit({type: 'turn.failed', code: error instanceof DemoError ? error.code : 'REPLAY_FAILED', message: error instanceof DemoError ? error.message : 'This offline replay failed. No proposal was committed.', status: 'failed'});
      } finally { active.delete(session.token); res.end(); }
    } catch (error) {
      if (res.destroyed) return;
      if (!res.headersSent) json(res, error instanceof DemoError ? error.status : error instanceof SeededReaderError ? 503 : 500, {code: error instanceof DemoError || error instanceof SeededReaderError ? error.code : 'INTERNAL_ERROR', message: error instanceof DemoError || error instanceof SeededReaderError ? error.message : 'The local prototype could not complete this action.'});
      else res.end();
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 40;
  server.waitForSeededCleanup = () => cleanupPromise;
  server.seededReaderCacheSize = () => seedReaders.size;
  server.once('close', () => {
    for (const entry of active.values()) entry?.controller?.abort();
    for (const key of seedReaders.keys()) dropReaders(key);
    // Socket closure is not evidence that callbacks stopped. Keep the exact
    // state-owner lock until every owned factory/read has actually settled.
    if (!pendingSeedOperations.size) { store.close(); return; }
    cleanupPromise = Promise.allSettled([...pendingSeedOperations]).then(() => store.close());
    cleanupPromise.catch(() => {}); // The preserved owner lock is the recovery fence.
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 51840);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a valid local port.');
  const packet = await loadSealedPacket(process.env.KITCHENFRONT_TWO_YEAR_PACKET_DIR);
  const stateDirectory = join(homedir(), '.local', 'state', 'kitchenfront-codex-current-date');
  const store = new SessionStore(stateDirectory, {stateFactory: currentStateFactory(packet)});
  const server = createPrototypeServer({store}); server.listen(port, '127.0.0.1', () => process.stdout.write(`Local fictional prototype: http://127.0.0.1:${port}\nLive AI: disabled\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
