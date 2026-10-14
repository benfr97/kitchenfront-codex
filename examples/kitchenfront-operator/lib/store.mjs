import {randomBytes, createHash} from 'node:crypto';
import {mkdirSync, lstatSync, chmodSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {DemoError, freshState} from './fixtures.mjs';

const TTL = 8 * 60 * 60 * 1000;
const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
const hash = value => createHash('sha256').update(value).digest('hex');

// One local server owns this directory. It is outside the source checkout.
export class SessionStore {
  constructor(directory, {now = Date.now, maxSessions = 32} = {}) {
    this.directory = directory; this.now = now; this.maxSessions = maxSessions;
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('The session directory must be owned by this server user.');
    chmodSync(directory, 0o700);
    this.sessions = new Map();
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(directory, name); const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000) throw new Error('Unexpected session file. Preserve it and inspect before continuing.');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (!validToken(value.token) || `${hash(value.token)}.json` !== name || !value.state?.generation || !validToken(value.csrfToken) || !Number.isFinite(value.expiresAt)) throw new Error('Invalid session file. Preserve it before continuing.');
      if (value.expiresAt <= this.now()) { unlinkSync(path); continue; }
      // A restart never turns an unfinished request into a success or retries it.
      for (const request of Object.values(value.state.requests)) {
        if (request.status === 'running') request.status = 'unknown';
      }
      for (const item of value.state.activity) if (item.kind === 'turn' && item.status === 'running') item.status = 'unknown';
      this.sessions.set(value.token, value); this.save(value);
    }
  }
  path(session) { return join(this.directory, `${hash(session.token)}.json`); }
  save(session) {
    const destination = this.path(session); const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
    const payload = JSON.stringify(session);
    if (Buffer.byteLength(payload) > 512_000) throw new DemoError('CAPACITY', 'This fictional session is full. Reset it before continuing.', 409);
    writeFileSync(temporary, payload, {mode: 0o600, flag: 'wx'}); renameSync(temporary, destination);
  }
  get(token) {
    if (!validToken(token)) return null;
    const value = this.sessions.get(token);
    if (!value || value.expiresAt <= this.now()) return null;
    return value;
  }
  create() {
    for (const [token, session] of this.sessions) if (session.expiresAt <= this.now()) { unlinkSync(this.path(session)); this.sessions.delete(token); }
    if (this.sessions.size >= this.maxSessions) throw new DemoError('CAPACITY', 'This local prototype has reached its session limit.', 503);
    const session = {token: randomBytes(32).toString('hex'), csrfToken: randomBytes(32).toString('hex'), expiresAt: this.now() + TTL, state: freshState()};
    this.save(session); this.sessions.set(session.token, session); return session;
  }
  replaceState(session, state) {
    const next = {...session, state}; this.save(next); session.state = state;
  }
}
