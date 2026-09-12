import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pinnedCodexNativeBuild } from '../packages/acp-adapter/src/pinned-codex-build.ts'
import {
  createAcpBuildEnvironment,
  reserveInstallDirectory,
  validateInstallDestination,
} from './install-m11-codex-acp.mjs'
import { createPinnedBuildCommand } from './pinned-build-command.mjs'
import { packageNativeExecutable } from './package-m11-codex-native.mjs'
import { verifyPinnedCodexNativeBinary } from '../packages/acp-adapter/src/native-installation.ts'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function nativeBuildJobCount(platform) {
  if (platform === 'linux') return '1'
  if (platform === 'darwin') return '4'
  throw new Error('CODEX_NATIVE_PLATFORM_UNSUPPORTED')
}
export function nativeReleaseBuildTimeoutMs(platform) {
  if (platform === 'linux') return 7_200_000
  if (platform === 'darwin') return 3_600_000
  throw new Error('CODEX_NATIVE_PLATFORM_UNSUPPORTED')
}
export function normalizeCodexReleaseLock(input) {
  if (digest(input) !== pinnedCodexNativeBuild.lockSha256)
    throw new Error('CODEX_NATIVE_LOCK_MISMATCH')
  const normalized = input.toString().replaceAll('version = "0.0.0"', 'version = "0.148.0"')
  if (digest(normalized) !== pinnedCodexNativeBuild.normalizedLockSha256)
    throw new Error('CODEX_NATIVE_NORMALIZED_LOCK_MISMATCH')
  return normalized
}

export async function installPinnedCodexNative(destinationInput, rustBin, testBin) {
  const destination = validateInstallDestination(destinationInput)
  if (![rustBin, testBin].every((path) => typeof path === 'string' && isAbsolute(path)))
    throw new Error('CODEX_NATIVE_EXPLICIT_TOOL_DIRECTORIES_REQUIRED')
  if (process.versions.node.split('.')[0] !== '24') throw new Error('CODEX_NATIVE_NODE_24_REQUIRED')
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('CODEX_NATIVE_PLATFORM_UNSUPPORTED')
  const patch = fileURLToPath(
    new URL('../docs/evidence/fixtures/codex-0.148.0-sse-cancellation.patch', import.meta.url)
  )
  if (digest(await readFile(patch)) !== pinnedCodexNativeBuild.patchSha256)
    throw new Error('CODEX_NATIVE_PATCH_MISMATCH')
  await reserveInstallDirectory(destination)
  const environment = await createAcpBuildEnvironment(join(destination, '.build-home'))
  environment.PATH = `${rustBin}:${testBin}:${environment.PATH}`
  environment.RUSTC = join(rustBin, 'rustc')
  environment.RUSTDOC = join(rustBin, 'rustdoc')
  environment.CARGO_HOME = join(destination, '.cargo')
  environment.CARGO_BUILD_JOBS = nativeBuildJobCount(process.platform)
  const run = createPinnedBuildCommand(environment, 3600000)
  const source = join(destination, 'source')
  for (const [command, expected] of [
    [join(rustBin, 'rustc'), pinnedCodexNativeBuild.rustVersion],
    [join(rustBin, 'cargo'), pinnedCodexNativeBuild.cargoVersion],
    [join(testBin, 'just'), pinnedCodexNativeBuild.justVersion],
    [join(testBin, 'cargo-nextest'), pinnedCodexNativeBuild.nextestVersion],
  ]) {
    if ((await run(command, ['--version'], destination)).split('\n')[0] !== expected)
      throw new Error('CODEX_NATIVE_TOOL_VERSION_MISMATCH')
  }
  await run(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      pinnedCodexNativeBuild.tag,
      '--no-checkout',
      pinnedCodexNativeBuild.repository,
      source,
    ],
    destination
  )
  if ((await run('git', ['rev-parse', 'HEAD'], source)) !== pinnedCodexNativeBuild.commit)
    throw new Error('CODEX_NATIVE_COMMIT_MISMATCH')
  await run('git', ['checkout', '--detach', pinnedCodexNativeBuild.commit], source)
  const workspace = join(source, 'codex-rs')
  const lock = join(workspace, 'Cargo.lock')
  await writeFile(lock, normalizeCodexReleaseLock(await readFile(lock)))
  await run('git', ['apply', '--check', patch], source)
  await run('git', ['apply', patch], source)
  await run(
    join(testBin, 'just'),
    ['test', '-p', 'codex-api', '--locked', '--retries', '0'],
    workspace
  )
  await createPinnedBuildCommand(environment, nativeReleaseBuildTimeoutMs(process.platform))(
    join(rustBin, 'cargo'),
    ['build', '--release', '--locked', '-p', 'codex-cli', '--bin', 'codex'],
    workspace
  )
  const packaging = await packageNativeExecutable({
    source: join(workspace, 'target/release/codex'),
    destination,
    platform: process.platform,
    run,
  })
  const executable = join(destination, 'bin/codex')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(executable)) hash.update(chunk)
  if ((await run(executable, ['--version'], destination)) !== 'codex-cli 0.148.0')
    throw new Error('CODEX_NATIVE_EXECUTABLE_VERSION_MISMATCH')
  const manifest = {
    schemaVersion: 1,
    status: 'built',
    ...pinnedCodexNativeBuild,
    platform: process.platform,
    arch: process.arch,
    profile: 'release',
    executable: 'bin/codex',
    executableSha256: hash.digest('hex'),
    packaging,
    nativeCertification: 'required-before-promotion',
  }
  await verifyPinnedCodexNativeBinary(executable, manifest)
  await writeFile(
    join(destination, 'installation.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: 0o600,
      flag: 'wx',
    }
  )
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5)
    throw new Error(
      'Usage: node scripts/install-m11-codex-native.mjs /absolute/new/directory /absolute/rust-toolchain/bin /absolute/test-tools/bin'
    )
  console.log(JSON.stringify(await installPinnedCodexNative(...process.argv.slice(2)), null, 2))
}
