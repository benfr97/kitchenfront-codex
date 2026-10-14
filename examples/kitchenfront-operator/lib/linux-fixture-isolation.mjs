import {fstatSync, readFileSync, readlinkSync, statfsSync} from 'node:fs';

const NETWORK_NAMESPACE = /^net:\[\d+\]$/;
const PROC_NET_DEV_MAX_CHARS = 16_384;
const NETDEV_RECORD = /^\s*([A-Za-z0-9_.:-]{1,15}):\s+((?:\d+\s+){15}\d+)\s*$/;
export const NSFS_MAGIC = 0x6e736673;

export class LinuxFixtureIsolationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LinuxFixtureIsolationError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new LinuxFixtureIsolationError(code, message);
}

// Parse every interface from the current network namespace's proc view. Keep
// the accepted input small and strict so missing or malformed kernel data
// cannot be mistaken for loopback-only isolation.
export function parseProcNetDevInterfaces(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > PROC_NET_DEV_MAX_CHARS ||
      text.includes('\0') || text.includes('\r') || !text.endsWith('\n')) {
    reject('LINUX_NETDEV_UNVERIFIED', 'The current network interface list could not be verified.');
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 3 || lines[0].split('|').length !== 3 || lines[1].split('|').length !== 3 ||
      !/^Inter-\|\s*Receive\b.*\|\s*Transmit\b/.test(lines[0]) ||
      !/^\s*face\s*\|\s*bytes\b.*\|\s*bytes\b/.test(lines[1])) {
    reject('LINUX_NETDEV_UNVERIFIED', 'The current network interface list has an invalid header.');
  }
  const interfaces = [];
  const seen = new Set();
  for (const line of lines.slice(2)) {
    const record = NETDEV_RECORD.exec(line);
    if (!record) reject('LINUX_NETDEV_UNVERIFIED', 'The current network interface list contains a malformed record.');
    const name = record[1];
    if (seen.has(name)) reject('LINUX_NETDEV_UNVERIFIED', 'The current network interface list contains a duplicate record.');
    seen.add(name);
    interfaces.push(name);
  }
  if (interfaces.length === 0) reject('LINUX_NETDEV_UNVERIFIED', 'The current network interface list is empty.');
  return interfaces.sort();
}

// Pure admission logic so CI can exercise fail-closed cases without trusting
// environment flags or requiring namespace privileges in the unit tests.
export function validateLinuxNetworkIsolationFacts({uid, effectiveUid, selfNamespace, hostNamespace, hostNamespaceFsMagic, hostNamespaceInode, interfaces}) {
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(effectiveUid)) {
    reject('LINUX_UID_UNVERIFIED', 'The process identity could not be verified.');
  }
  if (uid < 1 || effectiveUid < 1) {
    reject('LINUX_ROOT_FORBIDDEN', 'Run the fixture engine as a non-root user.');
  }
  if (typeof selfNamespace !== 'string' || !NETWORK_NAMESPACE.test(selfNamespace) ||
      typeof hostNamespace !== 'string' || !NETWORK_NAMESPACE.test(hostNamespace)) {
    reject('LINUX_NETNS_UNVERIFIED', 'The current and launcher network namespaces could not be verified.');
  }
  const hostInode = /^net:\[(\d+)\]$/.exec(hostNamespace)?.[1];
  if (hostNamespaceFsMagic !== NSFS_MAGIC || typeof hostNamespaceInode !== 'string' || hostNamespaceInode !== hostInode) {
    reject('LINUX_HOST_NETNS_FD_UNVERIFIED', 'The inherited host namespace descriptor is not a verified network namespace.');
  }
  if (selfNamespace === hostNamespace) {
    reject('LINUX_NETNS_NOT_ISOLATED', 'Run the fixture engine in a network namespace distinct from the launcher namespace.');
  }
  if (!Array.isArray(interfaces) || interfaces.length !== 1 || interfaces[0] !== 'lo') {
    reject('LINUX_EXTERNAL_INTERFACE_PRESENT', 'The isolated network namespace must contain only the loopback interface.');
  }
  return Object.freeze({
    scope: 'LINUX_NETWORK_NAMESPACE_ONLY',
    established: true,
    filesystemIsolation: false,
    nonRoot: true,
    onlyLoopback: true,
  });
}

// The trusted launcher opens its current network namespace on fd 3 before
// unshare, then preserves that descriptor through the non-root transition.
// Production facts come directly from the OS; callers cannot supply them.
export function assertCurrentLinuxNetworkIsolation() {
  if (process.platform !== 'linux') {
    reject('LINUX_REQUIRED', 'Linux network-namespace isolation is available only on Linux.');
  }
  if (typeof process.getuid !== 'function' || typeof process.geteuid !== 'function') {
    reject('LINUX_UID_UNVERIFIED', 'The process identity could not be verified.');
  }
  try {
    return validateLinuxNetworkIsolationFacts({
      uid: process.getuid(),
      effectiveUid: process.geteuid(),
      selfNamespace: readlinkSync('/proc/self/ns/net'),
      hostNamespace: readlinkSync('/proc/self/fd/3'),
      hostNamespaceFsMagic: statfsSync('/proc/self/fd/3').type,
      hostNamespaceInode: String(fstatSync(3).ino),
      interfaces: parseProcNetDevInterfaces(readFileSync('/proc/self/net/dev', 'utf8')),
    });
  } catch (error) {
    if (error instanceof LinuxFixtureIsolationError) throw error;
    reject('LINUX_NETNS_UNVERIFIED', 'Linux network namespace facts could not be read from the OS.');
  }
}
