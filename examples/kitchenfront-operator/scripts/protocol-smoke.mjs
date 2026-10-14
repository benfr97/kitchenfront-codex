import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import {AppServerRpc, isolatedEngineEnvironment} from '../lib/rpc.mjs';
import {noNetworkSeatbeltProfile} from '../lib/isolation.mjs';

// This script never creates a thread or starts a model turn. A successful
// initialize is protocol proof only, not a sandbox or AI-behaviour proof.
const [binaryInput, expectedHash, kind = 'app-server'] = process.argv.slice(2);
const binary = binaryInput && realpathSync(binaryInput);
if (!binary || !isAbsolute(binary) || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw new Error('Provide an absolute custom-built binary path and its recorded SHA-256.');
const actualHash = createHash('sha256').update(readFileSync(binary)).digest('hex');
if (actualHash !== expectedHash) throw new Error('The binary does not match the recorded custom build.');
if (!['app-server', 'cli'].includes(kind)) throw new Error('Choose the dedicated app-server or CLI entrypoint explicitly.');
if (process.platform !== 'darwin') throw new Error('This no-network smoke requires the reviewed macOS outer sandbox; other hosts need their own containment.');
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kf-codex-protocol-')));
let child; let peer; let closed = false;
const waitForClose = ms => new Promise(resolve => {
  if (!child || closed) { resolve(true); return; }
  const finish = () => { clearTimeout(timer); resolve(true); };
  const timer = setTimeout(() => { child.off('close', finish); resolve(false); }, ms);
  child.once('close', finish);
});
try {
  child = spawn('/usr/bin/sandbox-exec', ['-p', noNetworkSeatbeltProfile(binary, directory), binary, ...(kind === 'cli' ? ['app-server'] : []), '--listen', 'stdio://'], {cwd: directory, env: isolatedEngineEnvironment(directory), stdio: ['pipe', 'pipe', 'pipe']});
  child.once('close', () => { closed = true; });
  // Drain, but never print potential provider/account diagnostics.
  child.stderr.on('data', () => {});
  peer = new AppServerRpc(child);
  const result = await peer.initialize();
  process.stdout.write(`${JSON.stringify({status: 'protocol_checked', binarySha256: actualHash, userAgent: result.userAgent ?? null, modelCalls: 0, inferenceVerified: false, isolationVerified: false})}\n`);
} finally {
  peer?.close();
  if (!await waitForClose(3000)) { child.kill('SIGKILL'); await waitForClose(2000); }
  if (!child || closed) rmSync(directory, {recursive: true});
  else { process.stderr.write(`Owned engine cleanup UNKNOWN for PID ${child.pid}; its temporary runtime directory is preserved.\n`); process.exitCode = 1; }
}
