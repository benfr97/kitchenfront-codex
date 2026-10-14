import test from 'node:test';
import assert from 'node:assert/strict';
import {LinuxFixtureIsolationError, NSFS_MAGIC, parseProcNetDevInterfaces, validateLinuxNetworkIsolationFacts} from '../lib/linux-fixture-isolation.mjs';

const procNetDev = rows => [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  ...rows,
  '',
].join('\n');

const isolatedLoopback = () => ({
  uid: 1001,
  effectiveUid: 1001,
  selfNamespace: 'net:[4026532999]',
  hostNamespace: 'net:[4026531840]',
  hostNamespaceFsMagic: NSFS_MAGIC,
  hostNamespaceInode: '4026531840',
  interfaces: ['lo'],
});

function rejectsWithCode(facts, code) {
  assert.throws(() => validateLinuxNetworkIsolationFacts(facts), error => {
    assert.ok(error instanceof LinuxFixtureIsolationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('Linux fixture admission requires a distinct namespace, non-root identity and loopback only', () => {
  assert.deepEqual(validateLinuxNetworkIsolationFacts(isolatedLoopback()), {
    scope: 'LINUX_NETWORK_NAMESPACE_ONLY',
    established: true,
    filesystemIsolation: false,
    nonRoot: true,
    onlyLoopback: true,
  });
});

test('proc netdev parser accepts the current namespace loopback record', () => {
  const counters = Array(16).fill('0').join(' ');
  assert.deepEqual(parseProcNetDevInterfaces(procNetDev([` lo: ${counters}`])), ['lo']);
});

test('proc netdev parser includes zero-counter extra interfaces for admission to reject', () => {
  const counters = Array(16).fill('0').join(' ');
  const interfaces = parseProcNetDevInterfaces(procNetDev([` lo: ${counters}`, `eth0: ${counters}`]));
  assert.deepEqual(interfaces, ['eth0', 'lo']);
  rejectsWithCode({...isolatedLoopback(), interfaces}, 'LINUX_EXTERNAL_INTERFACE_PRESENT');
});

test('proc netdev parser rejects empty, malformed, oversized and duplicate data', () => {
  const counters = Array(16).fill('0').join(' ');
  assert.throws(() => parseProcNetDevInterfaces(''), error => error.code === 'LINUX_NETDEV_UNVERIFIED');
  assert.throws(() => parseProcNetDevInterfaces(procNetDev([])), error => error.code === 'LINUX_NETDEV_UNVERIFIED');
  assert.throws(() => parseProcNetDevInterfaces(procNetDev([`lo: ${Array(15).fill('0').join(' ')}`])), error => error.code === 'LINUX_NETDEV_UNVERIFIED');
  assert.throws(() => parseProcNetDevInterfaces(procNetDev([`lo: ${counters}`, `lo: ${counters}`])), error => error.code === 'LINUX_NETDEV_UNVERIFIED');
  assert.throws(() => parseProcNetDevInterfaces(`${'x'.repeat(16_385)}\n`), error => error.code === 'LINUX_NETDEV_UNVERIFIED');
});

test('Linux fixture admission rejects root and effective-root processes', () => {
  rejectsWithCode({...isolatedLoopback(), uid: 0}, 'LINUX_ROOT_FORBIDDEN');
  rejectsWithCode({...isolatedLoopback(), effectiveUid: 0}, 'LINUX_ROOT_FORBIDDEN');
});

test('Linux fixture admission rejects the launcher network namespace', () => {
  const facts = isolatedLoopback();
  rejectsWithCode({...facts, selfNamespace: facts.hostNamespace}, 'LINUX_NETNS_NOT_ISOLATED');
});

test('Linux fixture admission rejects missing or malformed namespace identifiers', () => {
  rejectsWithCode({...isolatedLoopback(), selfNamespace: undefined}, 'LINUX_NETNS_UNVERIFIED');
  rejectsWithCode({...isolatedLoopback(), hostNamespace: 'net:[unknown]'}, 'LINUX_NETNS_UNVERIFIED');
});

test('Linux fixture admission validates the inherited host namespace file descriptor', () => {
  rejectsWithCode({...isolatedLoopback(), hostNamespaceFsMagic: 0}, 'LINUX_HOST_NETNS_FD_UNVERIFIED');
  rejectsWithCode({...isolatedLoopback(), hostNamespaceInode: '1'}, 'LINUX_HOST_NETNS_FD_UNVERIFIED');
});

test('Linux fixture admission rejects any non-loopback or missing interface', () => {
  rejectsWithCode({...isolatedLoopback(), interfaces: ['lo', 'eth0']}, 'LINUX_EXTERNAL_INTERFACE_PRESENT');
  rejectsWithCode({...isolatedLoopback(), interfaces: ['lo', 'veth-fixture']}, 'LINUX_EXTERNAL_INTERFACE_PRESENT');
  rejectsWithCode({...isolatedLoopback(), interfaces: []}, 'LINUX_EXTERNAL_INTERFACE_PRESENT');
});

test('Linux fixture admission rejects an unverifiable process identity', () => {
  rejectsWithCode({...isolatedLoopback(), uid: null}, 'LINUX_UID_UNVERIFIED');
  rejectsWithCode({...isolatedLoopback(), uid: -1}, 'LINUX_ROOT_FORBIDDEN');
});
