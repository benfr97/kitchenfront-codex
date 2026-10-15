#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024;
const FILES = Object.freeze({
  binary: 'codex-app-server',
  modelCatalog: 'models.json',
  license: 'LICENSE',
  notice: 'NOTICE',
  manifest: 'manifest.json',
});

function fail(message) {
  throw new Error(message);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args, cwd = REPO_ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with status ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function requireRegularFile(path, label) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    fail(`Required ${label} is missing.`);
  }
  if (!info.isFile() || info.isSymbolicLink()) fail(`Required ${label} must be a regular file.`);
  return info;
}

function normalizedLibraryReadback(lddOutput) {
  const lines = lddOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) fail('ldd returned no required-library readback.');
  if (lines.some(line => /\bnot found\b/.test(line))) fail('The engine has an unresolved dynamic library.');
  return lines.map(line => line.replace(/\s+\(0x[0-9a-f]+\)$/i, ''));
}

function enforceCompressedSize(byteCount, maximum = MAX_COMPRESSED_BYTES) {
  if (!Number.isSafeInteger(byteCount) || byteCount < 1) fail('The compressed artifact is empty or has an invalid size.');
  if (byteCount > maximum) {
    fail(`The compressed artifact exceeds the ${maximum}-byte limit.`);
  }
}

function makeManifest({repoRoot, binaryPath, catalogPath, licensePath, noticePath, binaryInfo, runCommand}) {
  const sourceHead = runCommand('git', ['rev-parse', 'HEAD'], repoRoot).trim();
  const rustTree = runCommand('git', ['rev-parse', 'HEAD:codex-rs'], repoRoot).trim();
  if (!/^[0-9a-f]{40}$/i.test(sourceHead) || !/^[0-9a-f]{40}$/i.test(rustTree)) {
    fail('Git source identities are not full commit hashes.');
  }

  const binaryBytes = readFileSync(binaryPath);
  const catalogBytes = readFileSync(catalogPath);
  const licenseBytes = readFileSync(licensePath);
  const noticeBytes = readFileSync(noticePath);
  const lddOutput = runCommand('ldd', [binaryPath], repoRoot);
  return {
    formatVersion: 1,
    sourceHead,
    rustTree,
    engine: {
      file: FILES.binary,
      sha256: digest(binaryBytes),
      sizeBytes: binaryInfo.size,
    },
    modelCatalog: {
      file: FILES.modelCatalog,
      sha256: digest(catalogBytes),
      sizeBytes: catalogBytes.length,
    },
    license: {
      file: FILES.license,
      sha256: digest(licenseBytes),
      sizeBytes: licenseBytes.length,
    },
    notice: {
      file: FILES.notice,
      sha256: digest(noticeBytes),
      sizeBytes: noticeBytes.length,
    },
    requiredLibraryReadback: normalizedLibraryReadback(lddOutput),
  };
}

function sameFileIdentity(path, expected) {
  if (!expected) return false;
  try {
    const current = lstatSync(path);
    return current.isFile() && current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

function copyFileToDescriptor(sourcePath, targetFd) {
  const sourceFd = openSync(sourcePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let sourcePosition = 0;
  let copiedBytes = 0;
  try {
    while (true) {
      const readBytes = readSync(sourceFd, buffer, 0, buffer.length, sourcePosition);
      if (readBytes === 0) break;
      sourcePosition += readBytes;
      let writtenBytes = 0;
      while (writtenBytes < readBytes) {
        const count = writeSync(targetFd, buffer, writtenBytes, readBytes - writtenBytes);
        if (count < 1) fail('The compressed artifact could not be written completely.');
        writtenBytes += count;
      }
      copiedBytes += readBytes;
    }
  } finally {
    closeSync(sourceFd);
  }
  return copiedBytes;
}

function packageEngine({repoRoot, binaryPath, outputPath, runCommand = run, copyArchive = copyFileToDescriptor, maximumBytes = MAX_COMPRESSED_BYTES}) {
  const absoluteRepo = resolve(repoRoot);
  const absoluteBinary = resolve(binaryPath);
  const absoluteOutput = resolve(outputPath);
  requireRegularFile(absoluteBinary, 'engine binary');
  const catalogPath = join(absoluteRepo, 'codex-rs/models-manager/models.json');
  const licensePath = join(absoluteRepo, 'LICENSE');
  const noticePath = join(absoluteRepo, 'NOTICE');
  requireRegularFile(catalogPath, 'model catalog');
  requireRegularFile(licensePath, 'Apache LICENSE');
  requireRegularFile(noticePath, 'NOTICE');

  const stage = mkdtempSync(join(tmpdir(), 'codex-linux-engine-package-'));
  let outputFd = null;
  let outputIdentity = null;
  let outputSizeBytes = 0;
  try {
    const outputParent = lstatSync(dirname(absoluteOutput));
    if (!outputParent.isDirectory() || outputParent.isSymbolicLink()) fail('The artifact output directory must already exist as a real directory.');
    const stagedBinary = join(stage, FILES.binary);
    const stagedCatalog = join(stage, FILES.modelCatalog);
    const stagedLicense = join(stage, FILES.license);
    const stagedNotice = join(stage, FILES.notice);
    copyFileSync(absoluteBinary, stagedBinary);
    chmodSync(stagedBinary, 0o755);
    copyFileSync(catalogPath, stagedCatalog);
    copyFileSync(licensePath, stagedLicense);
    copyFileSync(noticePath, stagedNotice);

    const manifest = makeManifest({
      repoRoot: absoluteRepo,
      binaryPath: stagedBinary,
      catalogPath: stagedCatalog,
      licensePath: stagedLicense,
      noticePath: stagedNotice,
      binaryInfo: requireRegularFile(stagedBinary, 'staged engine binary'),
      runCommand,
    });
    writeFileSync(join(stage, FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o644});

    const stagedArchive = join(stage, 'compressed-bundle.tar.gz');
    runCommand('tar', ['-czf', stagedArchive, '-C', stage, ...Object.values(FILES)], absoluteRepo);
    const archiveSize = statSync(stagedArchive).size;
    enforceCompressedSize(archiveSize, maximumBytes);

    outputFd = openSync(absoluteOutput, 'wx', 0o644);
    outputIdentity = fstatSync(outputFd);
    outputSizeBytes = copyArchive(stagedArchive, outputFd);
    if (outputSizeBytes !== archiveSize) fail('The written artifact size does not match the compressed staged bundle.');
    fsyncSync(outputFd);
    closeSync(outputFd);
    outputFd = null;
    if (!sameFileIdentity(absoluteOutput, outputIdentity)) fail('The reserved artifact path changed identity while packaging.');
    return {path: absoluteOutput, sizeBytes: outputSizeBytes, manifest};
  } catch (error) {
    if (outputFd !== null) {
      try {
        closeSync(outputFd);
      } catch {
        // Continue only with identity-checked cleanup below.
      }
      outputFd = null;
    }
    if (sameFileIdentity(absoluteOutput, outputIdentity)) unlinkSync(absoluteOutput);
    throw error;
  } finally {
    rmSync(stage, {recursive: true, force: true});
  }
}

function selfTest() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-linux-engine-package-test-'));
  const binaryPath = join(fixtureRoot, 'fixture-engine');
  const catalogPath = join(fixtureRoot, 'codex-rs/models-manager/models.json');
  const outputPath = join(fixtureRoot, 'kitchenfront-linux-engine.tar.gz');
  const fakeHead = '0123456789abcdef0123456789abcdef01234567';
  const fakeRustTree = '89abcdef0123456789abcdef0123456789abcdef';
  const fakeLdd = [
    'linux-vdso.so.1 (0x00007ffd12340000)',
    'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f1234000000)',
  ].join('\n');

  try {
    mkdirSync(join(fixtureRoot, 'codex-rs/models-manager'), {recursive: true});
    writeFileSync(binaryPath, 'synthetic engine bytes\n', {mode: 0o755});
    writeFileSync(catalogPath, '{"models":[]}\n');
    writeFileSync(join(fixtureRoot, 'LICENSE'), 'Apache License fixture\n');
    writeFileSync(join(fixtureRoot, 'NOTICE'), 'NOTICE fixture\n');
    const fixtureRunner = (command, args, cwd) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return `${fakeHead}\n`;
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD:codex-rs') return `${fakeRustTree}\n`;
      if (command === 'ldd') return `${fakeLdd}\n`;
      return run(command, args, cwd);
    };

    const packed = packageEngine({
      repoRoot: fixtureRoot,
      binaryPath,
      outputPath,
      runCommand: fixtureRunner,
    });
    const entries = run('tar', ['-tzf', outputPath], fixtureRoot).trim().split(/\r?\n/).sort();
    assert.deepEqual(entries, Object.values(FILES).slice().sort());

    const archiveEntry = name => run('tar', ['-xOzf', outputPath, name], fixtureRoot);
    const archivedBinary = Buffer.from(archiveEntry(FILES.binary));
    const archivedCatalog = Buffer.from(archiveEntry(FILES.modelCatalog));
    const archivedLicense = Buffer.from(archiveEntry(FILES.license));
    const archivedNotice = Buffer.from(archiveEntry(FILES.notice));
    assert.deepEqual(archivedBinary, readFileSync(binaryPath));
    assert.deepEqual(archivedCatalog, readFileSync(catalogPath));
    assert.deepEqual(archivedLicense, readFileSync(join(fixtureRoot, FILES.license)));
    assert.deepEqual(archivedNotice, readFileSync(join(fixtureRoot, FILES.notice)));

    const manifestText = archiveEntry(FILES.manifest);
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.sourceHead, fakeHead);
    assert.equal(manifest.rustTree, fakeRustTree);
    assert.equal(manifest.engine.sha256, digest(archivedBinary));
    assert.equal(manifest.engine.sizeBytes, archivedBinary.length);
    assert.equal(manifest.modelCatalog.sha256, digest(archivedCatalog));
    assert.equal(manifest.modelCatalog.sizeBytes, archivedCatalog.length);
    assert.deepEqual(manifest.license, {
      file: FILES.license,
      sha256: digest(archivedLicense),
      sizeBytes: archivedLicense.length,
    });
    assert.deepEqual(manifest.notice, {
      file: FILES.notice,
      sha256: digest(archivedNotice),
      sizeBytes: archivedNotice.length,
    });
    assert.deepEqual(manifest.requiredLibraryReadback, [
      'linux-vdso.so.1',
      'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6',
    ]);
    assert.ok(packed.sizeBytes <= MAX_COMPRESSED_BYTES);

    const preexistingOutputPath = join(fixtureRoot, 'pre-existing.tar.gz');
    const preservedBytes = Buffer.from('preserve this pre-existing output\n');
    writeFileSync(preexistingOutputPath, preservedBytes);
    assert.throws(() => packageEngine({
      repoRoot: fixtureRoot,
      binaryPath,
      outputPath: preexistingOutputPath,
      runCommand: fixtureRunner,
    }), {code: 'EEXIST'});
    assert.deepEqual(readFileSync(preexistingOutputPath), preservedBytes);

    const symlinkTarget = join(fixtureRoot, 'symlink-target.txt');
    const symlinkOutputPath = join(fixtureRoot, 'pre-existing-symlink.tar.gz');
    const symlinkTargetBytes = Buffer.from('preserve symlink target\n');
    writeFileSync(symlinkTarget, symlinkTargetBytes);
    symlinkSync(symlinkTarget, symlinkOutputPath);
    assert.throws(() => packageEngine({
      repoRoot: fixtureRoot,
      binaryPath,
      outputPath: symlinkOutputPath,
      runCommand: fixtureRunner,
    }), {code: 'EEXIST'});
    assert.ok(lstatSync(symlinkOutputPath).isSymbolicLink());
    assert.deepEqual(readFileSync(symlinkTarget), symlinkTargetBytes);

    const partialOutputPath = join(fixtureRoot, 'partial-output.tar.gz');
    assert.throws(() => packageEngine({
      repoRoot: fixtureRoot,
      binaryPath,
      outputPath: partialOutputPath,
      runCommand: fixtureRunner,
      copyArchive: (_archive, outputFd) => {
        writeSync(outputFd, Buffer.from('partial artifact'));
        throw new Error('synthetic copy failure');
      },
    }), /synthetic copy failure/);
    assert.throws(() => statSync(partialOutputPath), {code: 'ENOENT'});

    const replacementOutputPath = join(fixtureRoot, 'replacement-output.tar.gz');
    const replacementBytes = Buffer.from('preserve replacement at reserved path\n');
    assert.throws(() => packageEngine({
      repoRoot: fixtureRoot,
      binaryPath,
      outputPath: replacementOutputPath,
      runCommand: fixtureRunner,
      copyArchive: (_archive, outputFd) => {
        unlinkSync(replacementOutputPath);
        writeFileSync(replacementOutputPath, replacementBytes);
        writeSync(outputFd, Buffer.from('partial artifact'));
        throw new Error('synthetic replacement failure');
      },
    }), /synthetic replacement failure/);
    assert.deepEqual(readFileSync(replacementOutputPath), replacementBytes);

    const rejectedOutputPath = join(fixtureRoot, 'oversize-must-be-removed.tar.gz');
    assert.throws(() => packageEngine({
      repoRoot: fixtureRoot,
      binaryPath,
      outputPath: rejectedOutputPath,
      runCommand: fixtureRunner,
      maximumBytes: 1,
    }), /exceeds/);
    assert.throws(() => statSync(rejectedOutputPath), {code: 'ENOENT'});
    process.stdout.write('package-linux-engine self-test passed (synthetic binary; no engine build or provider call).\n');
  } finally {
    rmSync(fixtureRoot, {recursive: true, force: true});
  }
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--binary', '--output'].includes(key) || values.has(key) || index + 1 >= args.length) {
      fail('Usage: package-linux-engine.mjs --binary PATH --output PATH | --self-test');
    }
    values.set(key, args[index + 1]);
    index += 1;
  }
  if (values.size !== 2) fail('Usage: package-linux-engine.mjs --binary PATH --output PATH | --self-test');
  return values;
}

function main(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    selfTest();
    return;
  }
  const values = parseArgs(args);
  const binaryPath = isAbsolute(values.get('--binary'))
    ? values.get('--binary')
    : resolve(REPO_ROOT, values.get('--binary'));
  const outputPath = isAbsolute(values.get('--output'))
    ? values.get('--output')
    : resolve(REPO_ROOT, values.get('--output'));
  const packed = packageEngine({repoRoot: REPO_ROOT, binaryPath, outputPath});
  process.stdout.write(`Created ${packed.path} (${packed.sizeBytes} bytes); manifest contains pinned source, binary, catalog, and library readback.\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Linux engine packaging failed: ${error.message}\n`);
  process.exitCode = 1;
}
