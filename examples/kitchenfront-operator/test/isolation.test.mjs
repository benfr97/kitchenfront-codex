import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {noNetworkSeatbeltProfile, loopbackFixtureSeatbeltProfile} from '../lib/isolation.mjs';

test('macOS runtime path is limited to a task-owned temporary subdirectory', {skip: process.platform !== 'darwin'}, t => {
  const runtime = mkdtempSync(join(tmpdir(), 'kf-isolation-path-test-'));
  t.after(() => rmSync(runtime, {recursive: true}));
  assert.doesNotThrow(() => noNetworkSeatbeltProfile('/bin/sh', runtime));
  for (const runtime of ['/', '/private', '/var', tmpdir()]) {
    assert.throws(() => noNetworkSeatbeltProfile('/bin/sh', runtime));
  }
});

test('outer macOS sandbox denies reading outside its runtime and allows only runtime writes', {skip: process.platform !== 'darwin'}, t => {
  const root = mkdtempSync(join(tmpdir(), 'kf-isolation-test-fixtures-'));
  const runtime = realpathSync(mkdtempSync(join(tmpdir(), 'kf-isolation-test-runtime-'))); const outside = join(root, 'outside-fixture');
  t.after(() => { rmSync(root, {recursive: true}); rmSync(runtime, {recursive: true}); });
  writeFileSync(outside, 'FICTIONAL-PRIVATE-CANARY\n'); writeFileSync(join(runtime, 'inside'), 'FICTIONAL-ALLOWED\n');
  const profile = noNetworkSeatbeltProfile('/bin/bash', runtime);
  const script = 'if IFS= read -r line < "$1"; then printf "OUTSIDE_READ_ALLOWED\\n"; else printf "OUTSIDE_READ_DENIED\\n"; fi; if IFS= read -r line < "$2/inside"; then printf "INSIDE_READ_ALLOWED\\n"; fi; printf "saved" > "$2/result"; if printf "changed" > "$1"; then printf "OUTSIDE_WRITE_ALLOWED\\n"; else printf "OUTSIDE_WRITE_DENIED\\n"; fi';
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/bash', '-c', script, 'probe', outside, runtime], {cwd: runtime, env: {HOME: runtime, PATH: '/usr/bin:/bin'}, encoding: 'utf8', timeout: 5000});
  assert.equal(result.status, 0, JSON.stringify({signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr}));
  assert.match(result.stdout, /OUTSIDE_READ_DENIED/); assert.match(result.stdout, /INSIDE_READ_ALLOWED/);
  assert.match(result.stdout, /OUTSIDE_WRITE_DENIED/); assert.doesNotMatch(result.stdout, /OUTSIDE_(?:READ|WRITE)_ALLOWED/);
  assert.equal(readFileSync(join(runtime, 'result'), 'utf8'), 'saved'); assert.equal(readFileSync(outside, 'utf8'), 'FICTIONAL-PRIVATE-CANARY\n');
  assert.match(profile, /\(deny default\)/); assert.doesNotMatch(profile, /allow network/);
});

test('outer macOS sandbox refuses a real connection to an available task-owned loopback listener', {skip: process.platform !== 'darwin'}, async t => {
  const runtime = realpathSync(mkdtempSync(join(tmpdir(), 'kf-isolation-network-')));
  const server = createServer(socket => socket.end()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(runtime, {recursive: true}); });
  const script = 'if exec 3<>"/dev/tcp/127.0.0.1/$1"; then printf "CONNECTED\\n"; else printf "DENIED\\n"; fi';
  const options = {cwd: runtime, env: {HOME: runtime, PATH: '/usr/bin:/bin'}, encoding: 'utf8', timeout: 5000};
  const port = String(server.address().port);
  const control = spawnSync('/bin/bash', ['-c', script, 'probe', port], options);
  assert.equal(control.status, 0); assert.equal(control.stdout.trim(), 'CONNECTED');
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', noNetworkSeatbeltProfile('/bin/bash', runtime), '/bin/bash', '-c', script, 'probe', port], options);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'DENIED'); assert.match(result.stderr, /Operation not permitted/);
});

test('fixture transport grants only its exact loopback endpoint, not another available port', {skip: process.platform !== 'darwin'}, async t => {
  const runtime = realpathSync(mkdtempSync(join(tmpdir(), 'kf-isolation-fixture-')));
  const allowed = createServer(socket => socket.end()); const denied = createServer(socket => socket.end());
  await Promise.all([allowed, denied].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  t.after(async () => { await Promise.all([allowed, denied].map(server => new Promise(resolve => server.close(resolve)))); rmSync(runtime, {recursive: true}); });
  const profile = loopbackFixtureSeatbeltProfile('/bin/bash', runtime, allowed.address().port);
  for (const invalid of [0, 80, 65536, '1234', 1234.5]) assert.throws(() => loopbackFixtureSeatbeltProfile('/bin/bash', runtime, invalid));
  const script = 'if exec 3<>"/dev/tcp/127.0.0.1/$1"; then printf "CONNECTED\\n"; else printf "DENIED\\n"; fi';
  for (const [server, expected] of [[allowed, 'CONNECTED'], [denied, 'DENIED']]) {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/bash', '-c', script, 'probe', String(server.address().port)], {cwd: runtime, env: {HOME: runtime, PATH: '/usr/bin:/bin'}, encoding: 'utf8', timeout: 5000});
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), expected);
  }
});
