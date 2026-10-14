import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import {AppServerRpc, isolatedEngineEnvironment} from '../lib/rpc.mjs';

// This script never creates a thread or starts a model turn. A successful
// initialize is protocol proof only, not a sandbox or AI-behaviour proof.
const [binary, expectedHash] = process.argv.slice(2);
if (!binary || !isAbsolute(binary) || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw new Error('Provide an absolute custom-built binary path and its recorded SHA-256.');
const actualHash = createHash('sha256').update(readFileSync(binary)).digest('hex');
if (actualHash !== expectedHash) throw new Error('The binary does not match the recorded custom build.');
const directory = mkdtempSync(join(tmpdir(), 'kf-codex-protocol-'));
let child; let peer;
try {
  child = spawn(binary, ['app-server', '--listen', 'stdio://'], {cwd: directory, env: isolatedEngineEnvironment(directory, {HOME: directory}), stdio: ['pipe', 'pipe', 'pipe']});
  // Drain, but never print potential provider/account diagnostics.
  child.stderr.on('data', () => {});
  peer = new AppServerRpc(child);
  const result = await peer.initialize();
  process.stdout.write(`${JSON.stringify({status: 'protocol_checked', binarySha256: actualHash, userAgent: result.userAgent ?? null, modelCalls: 0, inferenceVerified: false, isolationVerified: false})}\n`);
} finally {
  peer?.close();
  if (child && child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (!child || child.exitCode !== null) rmSync(directory, {recursive: true});
  else process.stderr.write('The owned engine did not confirm exit; its temporary runtime directory is preserved.\n');
}
