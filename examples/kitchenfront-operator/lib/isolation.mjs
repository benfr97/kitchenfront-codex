import {realpathSync, statSync} from 'node:fs';
import {dirname, isAbsolute, relative, sep} from 'node:path';
import {tmpdir} from 'node:os';

// Outer process containment for a no-network protocol smoke on macOS. This is
// separate from Codex's per-tool sandbox. Never broaden this into host-home access.
export function noNetworkSeatbeltProfile(binaryPath, runtimePath) {
  if (!isAbsolute(binaryPath) || !isAbsolute(runtimePath)) throw new Error('Isolation paths must be absolute.');
  const binary = realpathSync(binaryPath); const runtime = realpathSync(runtimePath);
  const temporaryRoot = realpathSync(tmpdir());
  const isWithin = (parent, child, allowEqual = false) => {
    const rel = relative(parent, child);
    return (allowEqual && rel === '') || (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const systemTempRoot = isWithin('/private/var/folders', temporaryRoot, true) || isWithin('/private/tmp', temporaryRoot, true);
  const runtimeStat = statSync(runtime);
  const runtimeRelativePath = relative(temporaryRoot, runtime);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const privateRuntime = runtimeStat.isDirectory() && currentUid !== null && runtimeStat.uid === currentUid && (runtimeStat.mode & 0o077) === 0;
  const directTempChild = runtimeRelativePath !== '' && runtimeRelativePath !== '..' && !runtimeRelativePath.startsWith(`..${sep}`) && !runtimeRelativePath.includes(sep) && !isAbsolute(runtimeRelativePath);
  if (!statSync(binary).isFile() || !systemTempRoot || !directTempChild || !privateRuntime) throw new Error('Use a private mode-700 task directory directly under the macOS temporary root and one executable.');
  const literal = value => JSON.stringify(value);
  const runtimeParents = [];
  for (let parent = dirname(runtime); parent !== '/'; parent = dirname(parent)) runtimeParents.push(parent);
  return `(version 1)
(deny default)
(allow process-exec (literal ${literal(binary)}))
(allow file-map-executable (literal ${literal(binary)}) (subpath "/System/Library") (subpath "/usr/lib"))
; This Mac stores the dyld shared cache in the system Cryptex, rather than
; /System/Library/dyld. Own probe crash receipts identify dyld CacheFinder.
(allow file-read* file-map-executable
  (subpath "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld"))
(allow mach-lookup (global-name "com.apple.secinitd"))
(allow signal (target same-sandbox))
(allow sysctl-read)
; Upstream's minimal platform policy permits the root directory itself for
; startup/getcwd. This is a literal directory, never its descendants.
(allow file-read* (literal "/"))
; realpath needs ancestor metadata, without directory contents or file access.
(allow file-read-metadata ${runtimeParents.map(parent => `(literal ${literal(parent)})`).join(' ')})
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall
  (require-all
    (mac-policy-name "Sandbox")
    (mac-syscall-number 67)))
(allow file-read*
  (literal ${literal(binary)})
  (subpath "/System/Library")
  (subpath "/usr/lib")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (literal "/dev/random")
  (subpath ${literal(runtime)}))
(allow file-write* (subpath ${literal(runtime)}))
(allow file-write-data (literal "/dev/null"))
(allow file-read* (regex "^/dev/fd/(0|1|2)$"))
(allow file-write* (regex "^/dev/fd/(1|2)$"))
(allow file-read-metadata
  (literal "/dev")
  (literal "/dev/fd")
  (regex "^/dev/fd/(0|1|2)$"))
`;
}

// Test-only transport to a single owned deterministic fixture provider. This
// does not allow an external model endpoint, DNS, arbitrary localhost or ports.
export function loopbackFixtureSeatbeltProfile(binaryPath, runtimePath, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Provide one exact task-owned fixture port.');
  return `${noNetworkSeatbeltProfile(binaryPath, runtimePath)}\n(allow network-outbound (remote ip "localhost:${port}"))\n`;
}
