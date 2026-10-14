import {EventEmitter} from 'node:events';

const ALLOWED_METHODS = new Set(['initialize', 'thread/start', 'thread/resume', 'thread/read', 'turn/start', 'turn/interrupt', 'thread/unsubscribe']);
export class ProtocolError extends Error { constructor(code, message) { super(message); this.code = code; } }

export class AppServerRpc extends EventEmitter {
  #child; #pending = new Map(); #seen = new Map(); #nextId = 1; #closed = false; #handler; #buffer = Buffer.alloc(0); #onData;
  constructor(child, {requestHandler, timeoutMs = 15000} = {}) {
    super(); this.#child = child; this.#handler = requestHandler; this.timeoutMs = timeoutMs;
    this.#onData = chunk => this.#consume(Buffer.from(chunk));
    child.stdout.on('data', this.#onData);
    child.on('error', () => this.#fail(new ProtocolError('ENGINE_PROCESS_ERROR', 'The isolated engine process could not start.')));
    child.on('exit', () => this.#fail(new ProtocolError('ENGINE_EXITED', 'The engine stopped before a complete result was confirmed.')));
  }
  #send(message) {
    if (this.#closed || this.#child.stdin.destroyed) throw new ProtocolError('ENGINE_CLOSED', 'The engine connection is closed.');
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > 1_000_000) throw new ProtocolError('MESSAGE_LIMIT', 'The engine message exceeds this prototype’s limit.');
    this.#child.stdin.write(`${line}\n`);
  }
  request(method, params) {
    if (!ALLOWED_METHODS.has(method)) return Promise.reject(new ProtocolError('RPC_NOT_ALLOWED', 'That engine method is not exposed by the phone bridge.'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new ProtocolError('ENGINE_TIMEOUT', 'No complete engine receipt arrived. Do not retry this request automatically.')); }, this.timeoutMs);
      this.#pending.set(id, {resolve, reject, timer});
      try { this.#send({method, id, params}); } catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    const result = await this.request('initialize', {clientInfo: {name: 'kitchenfront_codex_prototype', title: 'Kitchen Front Codex prototype', version: '0.1.0'}, capabilities: {experimentalApi: true}});
    this.#send({method: 'initialized', params: {}}); return result;
  }
  setRequestHandler(handler) { this.#handler = handler; }
  #consume(chunk) {
    let offset = 0;
    while (!this.#closed && offset < chunk.length) {
      const end = chunk.indexOf(10, offset); const segment = chunk.subarray(offset, end === -1 ? chunk.length : end);
      if (this.#buffer.length + segment.length > 1_000_000) { this.#fail(new ProtocolError('MESSAGE_LIMIT', 'The engine message exceeds this prototype’s limit.')); return; }
      this.#buffer = Buffer.concat([this.#buffer, segment]);
      if (end === -1) return;
      const line = this.#buffer.toString('utf8'); this.#buffer = Buffer.alloc(0);
      void this.#receive(line).catch(() => this.#fail(new ProtocolError('ENGINE_PROTOCOL_ERROR', 'The engine protocol could not complete this operation.')));
      offset = end + 1;
    }
  }
  async #receive(line) {
    if (this.#closed) return;
    let message;
    try { if (line.length > 1_000_000) throw new Error(); message = JSON.parse(line); if (!message || typeof message !== 'object') throw new Error(); }
    catch { this.#fail(new ProtocolError('INVALID_ENGINE_MESSAGE', 'The engine sent an invalid protocol message.')); return; }
    if (message.id != null && typeof message.method !== 'string') {
      const pending = this.#pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.#pending.delete(message.id);
      if (message.error) pending.reject(new ProtocolError('ENGINE_REJECTED', 'The engine rejected this operation.'));
      else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
      else pending.reject(new ProtocolError('INVALID_ENGINE_MESSAGE', 'The engine response has no result.'));
      return;
    }
    if (message.id != null) {
      const fingerprint = JSON.stringify([message.method, message.params]);
      const previous = this.#seen.get(message.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) { this.#fail(new ProtocolError('RPC_ID_CONFLICT', 'An engine request ID changed its payload.')); return; }
        const response = await previous.response; if (!this.#closed) this.#send(response); return;
      }
      if (this.#seen.size >= 128) { this.#fail(new ProtocolError('RPC_LIMIT', 'The engine request limit was reached.')); return; }
      const response = (async () => {
        try {
          if (message.method !== 'item/tool/call' || !this.#handler) throw new ProtocolError('RPC_NOT_ALLOWED', 'Only the fixed fictional tool-call method is allowed.');
          return {id: message.id, result: await this.#handler(message.params)};
        } catch { return {id: message.id, error: {code: -32601, message: 'This operation is not available in the fictional phone prototype.'}}; }
      })();
      this.#seen.set(message.id, {fingerprint, response});
      const value = await response; if (!this.#closed) this.#send(value); return;
    }
    if (typeof message.method !== 'string') { this.#fail(new ProtocolError('INVALID_ENGINE_MESSAGE', 'The engine notification is invalid.')); return; }
    this.emit('notification', message);
  }
  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear(); this.#buffer = Buffer.alloc(0); this.#child.stdout.off('data', this.#onData); this.#child.kill('SIGTERM'); this.emit('closed', error);
  }
  close() { this.#fail(new ProtocolError('ENGINE_CLOSED', 'The engine connection was closed.')); }
}

export function isolatedEngineEnvironment(runtimeHome) {
  const allowed = {};
  for (const name of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot']) if (process.env[name]) allowed[name] = process.env[name];
  // This is scoped to the child. It does not change Codex Desktop's environment or files.
  // The dedicated development build supports this upstream test switch. Outer
  // containment still denies host config access; this is not a release-build guarantee.
  return {...allowed, HOME: runtimeHome, TMPDIR: runtimeHome, CODEX_HOME: runtimeHome, KITCHENFRONT_CODEX_DYNAMIC_ONLY: '1', CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1'};
}
