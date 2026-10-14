import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {AppServerRpc, isolatedEngineEnvironment} from '../lib/rpc.mjs';
import {loopbackFixtureSeatbeltProfile} from '../lib/isolation.mjs';
import {assertCurrentLinuxNetworkIsolation} from '../lib/linux-fixture-isolation.mjs';
import {
  createFixtureResponsesProvider,
  FIXTURE_CASE_IDS,
  FIXTURE_CASE_REQUESTS,
  FIXTURE_REQUESTS_ARE_MODEL_FREE,
  FIXTURE_TOOL_NAMES,
} from '../lib/fixture-provider.mjs';
import {runCodexTurn, startDemoThread, MODEL} from '../lib/codex-turn.mjs';
import {freshState} from '../lib/fixtures.mjs';

// This runner is intentionally a local-protocol fixture. Its output cannot be
// read by or stored as the product's live-AI conversation state.
const [binaryInput, expectedHash, ...extraArgs] = process.argv.slice(2);
if (extraArgs.length || !binaryInput || !isAbsolute(binaryInput) || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) {
  throw new Error('Provide only an absolute dedicated app-server binary path and its recorded SHA-256.');
}
const binary = realpathSync(binaryInput);
if (!statSync(binary).isFile()) throw new Error('The selected app-server binary is not a regular file.');
const actualHash = createHash('sha256').update(readFileSync(binary)).digest('hex');
assert.equal(actualHash, expectedHash, 'The selected binary must match its recorded build hash.');

const runtime = realpathSync(mkdtempSync(join(tmpdir(), 'kf-codex-fixture-engine-')));
chmodSync(runtime, 0o700);
let containmentReport = process.platform === 'linux'
  ? {scope: 'LINUX_NETWORK_NAMESPACE_ONLY', established: false, filesystemIsolation: false}
  : null;
let provider;
let child;
let peer;
let childClosed = false;
let resolveChildClose;
let failedCaseId = null;
const safeEvents = [];
const childClose = new Promise(resolve => { resolveChildClose = resolve; });

function recordSafeEvent(event) {
  if (safeEvents.length >= 64) return;
  if (event?.type === 'tool.started' || event?.type === 'tool.completed') {
    safeEvents.push({type: event.type, tool: FIXTURE_TOOL_NAMES.includes(event.name) ? event.name : 'unknown', ...(event.type === 'tool.completed' ? {success: event.success === true} : {})});
  } else if (event?.type === 'message.delta') {
    safeEvents.push({type: event.type, textLength: typeof event.text === 'string' ? event.text.length : 0});
  } else if (event?.type === 'turn.started') {
    safeEvents.push({type: event.type});
  }
}

function recordSafeNotification(message) {
  if (safeEvents.length >= 64) return;
  const params = message?.params ?? {};
  if (message.method === 'turn/started') safeEvents.push({type: message.method});
  else if (message.method === 'item/started') safeEvents.push({type: message.method, itemType: params.item?.type ?? 'unknown'});
  else if (message.method === 'item/agentMessage/delta') safeEvents.push({type: message.method, textLength: typeof params.delta === 'string' ? params.delta.length : 0});
  else if (message.method === 'turn/completed') safeEvents.push({type: message.method, status: params.turn?.status ?? 'unknown'});
  else if (message.method === 'thread/tokenUsage/updated') safeEvents.push({type: message.method, total: Number.isFinite(params.tokenUsage?.total) ? params.tokenUsage.total : null});
}

function waitForChildClose(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    childClose.then(() => { clearTimeout(timer); resolve(true); });
  });
}

try {
  if (process.platform === 'linux') containmentReport = assertCurrentLinuxNetworkIsolation();
  else if (process.platform !== 'darwin') throw new Error('This fixture engine check requires the reviewed macOS sandbox or an isolated Linux network namespace.');

  provider = await createFixtureResponsesProvider();
  const port = provider.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The fixture provider returned an invalid loopback port.');

  const config = [
    'model_provider = "fixture"',
    `model = "${MODEL}"`,
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[features]',
    'enable_request_compression = false',
    '',
    '[model_providers.fixture]',
    'name = "Kitchen Front deterministic protocol fixture"',
    `base_url = "${provider.baseUrl}"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n');
  writeFileSync(join(runtime, 'config.toml'), config, {mode: 0o600});

  if (process.platform === 'darwin') {
    const profile = loopbackFixtureSeatbeltProfile(binary, runtime, port);
    child = spawn('/usr/bin/sandbox-exec', ['-p', profile, binary, '--listen', 'stdio://'], {
      cwd: runtime,
      env: isolatedEngineEnvironment(runtime),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    child = spawn(binary, ['--listen', 'stdio://'], {
      cwd: runtime,
      env: isolatedEngineEnvironment(runtime),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  child.once('close', (code, signal) => {
    childClosed = true;
    resolveChildClose({code, signal});
  });
  child.stderr.on('data', () => {}); // Never surface configuration or provider diagnostics.
  peer = new AppServerRpc(child, {timeoutMs: 20000});
  peer.on('notification', recordSafeNotification);
  const initialized = await peer.initialize();
  const threadId = await startDemoThread(peer, runtime);
  const outcomes = [];

  for (const caseId of FIXTURE_CASE_IDS) {
    failedCaseId = caseId;
    const state = freshState();
    const result = await runCodexTurn(peer, {
      threadId,
      state,
      requestId: `fixture-${caseId}`,
      question: FIXTURE_CASE_REQUESTS[caseId],
      emit: recordSafeEvent,
      maxDurationMs: 45000,
    });
    assert.equal(result.mode, 'live_ai'); // Internal helper mode only; this result remains ephemeral and is never emitted or saved.
    assert.match(result.answer, /ready for review/i);
    assert.doesNotMatch(result.answer, /(?<!no )email was sent|(?<!no real )appointment was booked/i);
    assert.equal(state.proposals.length, 0, 'the isolated base fixture state must remain uncommitted');
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].caseId, caseId);
    assert.equal(result.proposals[0].status, 'pending');
    outcomes.push({caseId, answerConfirmed: true, pendingProposalCount: result.proposals.length});
  }
  failedCaseId = null;

  const report = provider.report();
  assert.equal(report.errors.length, 0, 'the local fixture accepted every request without protocol errors');
  assert.equal(report.requestCount, 9, 'three tool-orchestration responses per fictional case');
  assert.equal(report.verifiedCatalogues, report.requestCount);
  assert.deepEqual(report.sequence.map(item => item.caseId), FIXTURE_CASE_IDS.flatMap(caseId => [caseId, caseId, caseId]));
  assert.deepEqual(report.sequence.map(item => item.stage), [0, 1, 2, 0, 1, 2, 0, 1, 2]);
  assert.ok(report.sequence.filter(item => item.outputType === 'function_call').every(item => FIXTURE_TOOL_NAMES.includes(item.toolName)));

  process.stdout.write(`${JSON.stringify({
    status: 'PROTOCOL_FIXTURE_ONLY',
    genuineAI: false,
    realModelCalls: 0,
    appServerBinarySha256: actualHash,
    userAgent: initialized.userAgent ?? null,
    cases: outcomes,
    localFixtureResponses: report.requestCount,
    exactToolCatalogueVerifiedForEveryResponse: report.verifiedCatalogues === report.requestCount,
    externalProviderContact: false,
    resultsPersisted: false,
    ...(containmentReport ? {containment: containmentReport} : {}),
  })}\n`);
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.code) ? error.code : null;
  process.stderr.write(`${JSON.stringify({
    status: 'PROTOCOL_FIXTURE_FAILED',
    genuineAI: false,
    realModelCalls: 0,
    failedCaseId,
    error: {name: typeof error?.name === 'string' ? error.name : 'Error', code},
    ...(containmentReport ? {containment: containmentReport} : {}),
    localFixture: provider?.report() ?? null,
    safeEvents,
  })}\n`);
  process.exitCode = 1;
} finally {
  peer?.off('notification', recordSafeNotification);
  peer?.close();
  if (child && !childClosed) {
    child.kill('SIGTERM');
    if (!await waitForChildClose(3000)) {
      child.kill('SIGKILL');
      await waitForChildClose(2000);
    }
  }
  if (provider) await provider.close();
  if (!child || childClosed) rmSync(runtime, {recursive: true});
  else {
    process.stderr.write(`Owned app-server cleanup remains UNKNOWN for PID ${child.pid}; its private temporary runtime is preserved.\n`);
    process.exitCode = 1;
  }
}
