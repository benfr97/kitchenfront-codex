import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID, timingSafeEqual, createHash} from 'node:crypto';
import {SessionStore} from './lib/store.mjs';
import {DemoError, freshState, replayScenario, decideProposal, CASE_IDS} from './lib/fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BLOCKER = 'Live AI is disabled. The custom fork still needs a compiled, independently reviewed runtime, OS isolation and separate model-test authority. Offline replay only tests the interface.';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const exact = (body, keys) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new DemoError('INVALID_REQUEST', 'The request does not match this demo action.');
};
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicState = session => ({csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString(), generation: session.state.generation,
  engine: {name: 'Codex App Server', version: '0.160.0 protocol target; custom fork unbuilt', status: 'not_verified'},
  liveEnabled: false, liveBlocker: BLOCKER, messages: session.state.messages, proposals: session.state.proposals, activity: session.state.activity});

async function jsonBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw new DemoError('CONTENT_TYPE', 'Send a JSON request.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new DemoError('REQUEST_TOO_LARGE', 'This request is too large.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DemoError('INVALID_JSON', 'The request must contain valid JSON.'); }
}
function json(res, status, value) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }

export function createPrototypeServer({stateDirectory = join(homedir(), '.local', 'state', 'kitchenfront-codex-prototype'), store = new SessionStore(stateDirectory)} = {}) {
  const active = new Map();
  const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']]]);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
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
        json(res, 200, publicState(session)); return;
      }
      if (req.method !== 'POST') throw new DemoError('METHOD_NOT_ALLOWED', 'This API action requires POST.', 405);
      if (!session) throw new DemoError('SESSION_REQUIRED', 'Open the fictional session before continuing.', 401);
      if (req.headers.origin !== `http://${req.headers.host}` || !equal(req.headers['x-csrf-token'], session.csrfToken)) throw new DemoError('CSRF_REJECTED', 'Reload this page before continuing.', 403);
      const body = await jsonBody(req);
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
      if (active.has(session.token)) throw new DemoError('REQUEST_ACTIVE', 'Wait for this fictional request to finish before changing the scenario.', 409);
      if (path === '/api/reset') {
        exact(body, []); store.replaceState(session, freshState()); json(res, 200, publicState(session)); return;
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
      if (!res.headersSent) json(res, error instanceof DemoError ? error.status : 500, {code: error instanceof DemoError ? error.code : 'INTERNAL_ERROR', message: error instanceof DemoError ? error.message : 'The local prototype could not complete this action.'});
      else res.end();
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 40;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 51840);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a valid local port.');
  const server = createPrototypeServer(); server.listen(port, '127.0.0.1', () => process.stdout.write(`Local fictional prototype: http://127.0.0.1:${port}\nLive AI: disabled\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
