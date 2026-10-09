import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCleanPinnedRepository,
  assertSdkArtifactAgainstManifest,
} from './candidate-provenance.fixture.mjs'

// Regressions for the candidate provenance guards. Temporary repositories and SDK artifacts
// are created per test; no network, registry, provider or build step is involved.
const IDENTITY = ['-c', 'user.name=provenance-test', '-c', 'user.email=t@example.invalid']
const git = (directory, args) =>
  execFileSync('git', ['-C', directory, ...IDENTITY, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
  }).trim()

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const SOURCE_COMMIT = 'b'.repeat(40)
const SDK_ENTRY_TEXT = 'export const ControlPlaneClient = class {}\n'
const HOST_TEXT = 'export const startNodePiDurableCandidateHost = null\n'
const created = []

afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true })
})

function tempDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

function hostRepository() {
  const directory = tempDirectory('cp-provenance-host-')
  git(directory, ['init', '-q'])
  writeFileSync(join(directory, 'host.mjs'), HOST_TEXT)
  git(directory, ['add', '.'])
  git(directory, ['commit', '-q', '-m', 'host'])
  return { directory, head: git(directory, ['rev-parse', 'HEAD']) }
}

const SUBSTITUTED_TEXT = 'export const ControlPlaneClient = null\n'

function sdkArtifact({
  hostCommit,
  version = '1.14.0',
  gitHead = SOURCE_COMMIT,
  text = SDK_ENTRY_TEXT,
}) {
  const directory = tempDirectory('cp-provenance-sdk-')
  mkdirSync(join(directory, 'dist'))
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@control-plane/sdk', version, gitHead })
  )
  const entry = join(directory, 'dist', 'index.js')
  writeFileSync(entry, text)
  const manifestPath = join(directory, 'candidate-manifest.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      hostCommit,
      sdk: {
        packageName: '@control-plane/sdk',
        version: '1.14.0',
        sourceCommit: SOURCE_COMMIT,
        entrySha256: sha256(SDK_ENTRY_TEXT),
      },
    })
  )
  return { entry, manifestPath }
}

const clean = (host, prefix = 'CANDIDATE') =>
  assertCleanPinnedRepository({ directory: host.directory, expectedHead: host.head, prefix })

const checkSdk = (sdk, hostCommit) =>
  assertSdkArtifactAgainstManifest({
    sdkEntry: sdk.entry,
    manifestPath: sdk.manifestPath,
    hostCommit,
  })

test('clean pinned repository is accepted and returns the pin', () => {
  const host = hostRepository()
  expect(clean(host)).toBe(host.head)
})

test('tracked modification in the pinned source fails closed', () => {
  const host = hostRepository()
  writeFileSync(join(host.directory, 'host.mjs'), 'export const x = 1\n')
  expect(() => clean(host)).toThrow('CANDIDATE_SOURCE_DIRTY')
})

test('untracked file in the pinned source fails closed', () => {
  const host = hostRepository()
  writeFileSync(join(host.directory, 'shadow.mjs'), 'export {}\n')
  expect(() => clean(host, 'NATIVE_REPAIR')).toThrow('NATIVE_REPAIR_SOURCE_DIRTY')
})

test('moved HEAD and missing or malformed pins fail closed', () => {
  const host = hostRepository()
  writeFileSync(join(host.directory, 'next.mjs'), 'export {}\n')
  git(host.directory, ['add', '.'])
  git(host.directory, ['commit', '-q', '-m', 'next'])
  expect(() => clean(host)).toThrow('CANDIDATE_HEAD_CHANGED')
  for (const expectedHead of [undefined, 'abc123']) {
    expect(() =>
      assertCleanPinnedRepository({ directory: host.directory, expectedHead, prefix: 'CANDIDATE' })
    ).toThrow('CANDIDATE_HEAD_REQUIRED')
  }
})

test('matching SDK artifact and manifest are accepted', () => {
  const host = hostRepository()
  expect(checkSdk(sdkArtifact({ hostCommit: host.head }), host.head)).toEqual({
    packageName: '@control-plane/sdk',
    version: '1.14.0',
    sourceCommit: SOURCE_COMMIT,
  })
})

test('substituted SDK entry bytes fail closed', () => {
  const host = hostRepository()
  const sdk = sdkArtifact({ hostCommit: host.head, text: SUBSTITUTED_TEXT })
  expect(() => checkSdk(sdk, host.head)).toThrow('CANDIDATE_SDK_ARTIFACT_MISMATCH')
})

test('SDK version that differs from the manifest fails closed', () => {
  const host = hostRepository()
  const sdk = sdkArtifact({ hostCommit: host.head, version: '1.14.1' })
  expect(() => checkSdk(sdk, host.head)).toThrow('CANDIDATE_SDK_IDENTITY_MISMATCH')
})

test('SDK package without matching gitHead provenance fails closed', () => {
  const host = hostRepository()
  const sdk = sdkArtifact({ hostCommit: host.head, gitHead: 'c'.repeat(40) })
  expect(() => checkSdk(sdk, host.head)).toThrow('CANDIDATE_SDK_PROVENANCE_MISMATCH')
})

test('manifest bound to a different host commit fails closed', () => {
  const host = hostRepository()
  const sdk = sdkArtifact({ hostCommit: 'd'.repeat(40) })
  expect(() => checkSdk(sdk, host.head)).toThrow('CANDIDATE_MANIFEST_HOST_MISMATCH')
})

test('missing or malformed manifest fails closed', () => {
  const host = hostRepository()
  const sdk = sdkArtifact({ hostCommit: host.head })
  expect(() =>
    assertSdkArtifactAgainstManifest({
      sdkEntry: sdk.entry,
      manifestPath: undefined,
      hostCommit: host.head,
    })
  ).toThrow('CANDIDATE_MANIFEST_REQUIRED')
  writeFileSync(
    sdk.manifestPath,
    JSON.stringify({ hostCommit: host.head, sdk: { packageName: '@control-plane/sdk' } })
  )
  expect(() => checkSdk(sdk, host.head)).toThrow('CANDIDATE_MANIFEST_INVALID')
})

// End-to-end: the real profile files must refuse to run, not merely skip or pass.
const profileDirectory = fileURLToPath(new URL('.', import.meta.url))
const runProfile = (file, env) => {
  const result = spawnSync(process.execPath, ['test', join(profileDirectory, file)], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}
const FUNDING_PROFILE = 'pi-confirmed-funding-candidate.test.mjs'
const NATIVE_PROFILE = 'pi-inference-reopen-candidate.test.mjs'

test('funding candidate profile refuses a dirty host source', () => {
  const host = hostRepository()
  writeFileSync(join(host.directory, 'host.mjs'), 'export const x = 2\n')
  const sdk = sdkArtifact({ hostCommit: host.head })
  const run = runProfile(FUNDING_PROFILE, {
    PI_FUNDING_CANDIDATE_HOST_ENTRY: join(host.directory, 'host.mjs'),
    PI_FUNDING_CANDIDATE_HEAD: host.head,
    PI_CANDIDATE_SDK_ENTRY: sdk.entry,
    PI_CANDIDATE_MANIFEST: sdk.manifestPath,
  })
  expect(run.status).not.toBe(0)
  expect(run.output).toContain('CANDIDATE_SOURCE_DIRTY')
})

test('funding candidate profile refuses a substituted SDK artifact', () => {
  const host = hostRepository()
  const sdk = sdkArtifact({ hostCommit: host.head, text: SUBSTITUTED_TEXT })
  const run = runProfile(FUNDING_PROFILE, {
    PI_FUNDING_CANDIDATE_HOST_ENTRY: join(host.directory, 'host.mjs'),
    PI_FUNDING_CANDIDATE_HEAD: host.head,
    PI_CANDIDATE_SDK_ENTRY: sdk.entry,
    PI_CANDIDATE_MANIFEST: sdk.manifestPath,
  })
  expect(run.status).not.toBe(0)
  expect(run.output).toContain('CANDIDATE_SDK_ARTIFACT_MISMATCH')
})

test('native repair profile refuses a dirty source checkout', () => {
  const host = hostRepository()
  writeFileSync(join(host.directory, 'scratch.mjs'), 'export {}\n')
  const run = runProfile(NATIVE_PROFILE, {
    PI_NATIVE_REPAIR_SOURCE: host.directory,
    PI_NATIVE_REPAIR_HEAD: host.head,
  })
  expect(run.status).not.toBe(0)
  expect(run.output).toContain('NATIVE_REPAIR_SOURCE_DIRTY')
})
