import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCleanPinnedRepository,
  assertFundingCandidateProvenance,
  CANDIDATE_MANIFEST_SCHEMA,
} from './candidate-provenance.fixture.mjs'

// Regressions for the candidate provenance guards. Each case builds a temporary git host and a
// synthetic candidate set: real tarballs, a manifest in the pack script's shape and an installed
// consumer tree. Mutations keep the manifest digest valid so each guard is tested on its own.
// No network, registry, provider, credential or build step is involved.
const IDENTITY = ['-c', 'user.name=provenance-test', '-c', 'user.email=t@example.invalid']
const git = (directory, args) =>
  execFileSync('git', ['-C', directory, ...IDENTITY, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
  }).trim()

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const HOST_TEXT = 'export const startNodePiDurableCandidateHost = null\n'
const SDK_TEXT = 'export const ControlPlaneClient = class {}\n'
const CONTRACTS_TEXT = 'export const Contract = {}\n'
const RUNTIME_TEXT = 'export const Runtime = {}\n'
const created = []

afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true })
})

function tempDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

function writeFiles(base, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true })
    writeFileSync(join(base, path), text)
  }
}

function hostRepository() {
  const directory = tempDirectory('cp-provenance-host-')
  git(directory, ['init', '-q'])
  writeFiles(directory, { 'host.mjs': HOST_TEXT })
  git(directory, ['add', '.'])
  git(directory, ['commit', '-q', '-m', 'host'])
  return {
    directory,
    file: join(directory, 'host.mjs'),
    head: git(directory, ['rev-parse', 'HEAD']),
  }
}

const packageFiles = (name, version, entry) => ({
  'package.json': JSON.stringify({ name, version }),
  'dist/index.js': entry,
  'dist/index.d.ts': 'export {}\n',
})

// Builds a consistent candidate: packed archives, a pack-script-shaped manifest and an
// installed consumer tree under node_modules/@adea-ai. Returns paths and the manifest digest.
function candidateSet({ head, dirty = false }) {
  const root = tempDirectory('cp-provenance-set-')
  const packDirectory = join(root, 'pack')
  mkdirSync(packDirectory)
  const packages = [
    {
      key: 'sdk',
      name: '@adea-ai/sdk',
      version: '1.14.0',
      files: packageFiles('@adea-ai/sdk', '1.14.0', SDK_TEXT),
    },
    {
      key: 'contracts',
      name: '@adea-ai/contracts',
      version: '1.14.0',
      files: packageFiles('@adea-ai/contracts', '1.14.0', CONTRACTS_TEXT),
    },
    {
      key: 'runtime-sdk',
      name: '@adea-ai/runtime-sdk',
      version: '1.14.0',
      files: packageFiles('@adea-ai/runtime-sdk', '1.14.0', RUNTIME_TEXT),
    },
  ]
  const nodeModules = join(root, 'consumer', 'node_modules', '@adea-ai')
  const artifacts = packages.map(({ key, name, version, files }) => {
    const stage = join(root, `stage-${key}`)
    writeFiles(join(stage, 'package'), files)
    const archive = `${key}.tgz`
    execFileSync('tar', ['-czf', join(packDirectory, archive), '-C', stage, 'package'])
    const bytes = readFileSync(join(packDirectory, archive))
    writeFiles(join(nodeModules, key), files)
    return { name, version, archive, bytes: bytes.length, sha256: sha256(bytes) }
  })
  const manifest = {
    schemaVersion: CANDIDATE_MANIFEST_SCHEMA,
    head,
    dirty,
    sourceDigest: `sha256:${'0'.repeat(64)}`,
    sourceFiles: 0,
    artifacts,
    qualification: 'synthetic provenance fixture',
  }
  const manifestPath = join(packDirectory, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return {
    root,
    packDirectory,
    manifestPath,
    manifestSha256: sha256(readFileSync(manifestPath)),
    installedSdkEntry: join(nodeModules, 'sdk', 'dist', 'index.js'),
    nodeModules,
  }
}

// Rewrites the manifest and re-pins its digest, so only the mutated guard can fail.
function repinManifest(set, mutate) {
  const manifest = JSON.parse(readFileSync(set.manifestPath, 'utf8'))
  mutate(manifest)
  writeFileSync(set.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  set.manifestSha256 = sha256(readFileSync(set.manifestPath))
  return set
}

function provenanceFor(host, set, overrides = {}) {
  return assertFundingCandidateProvenance({
    hostEntry: host.file,
    head: host.head,
    manifestPath: set.manifestPath,
    manifestSha256: set.manifestSha256,
    sdkEntry: set.installedSdkEntry,
    ...overrides,
  })
}

test('clean pinned repository is accepted and returns the pin', () => {
  const host = hostRepository()
  expect(
    assertCleanPinnedRepository({
      directory: host.directory,
      expectedHead: host.head,
      prefix: 'CANDIDATE',
    })
  ).toBe(host.head)
})

test('tracked modification in the pinned source fails closed', () => {
  const host = hostRepository()
  writeFiles(host.directory, { 'host.mjs': 'export const x = 1\n' })
  expect(() =>
    assertCleanPinnedRepository({
      directory: host.directory,
      expectedHead: host.head,
      prefix: 'CANDIDATE',
    })
  ).toThrow('CANDIDATE_SOURCE_DIRTY')
})

test('untracked file in the pinned source fails closed', () => {
  const host = hostRepository()
  writeFiles(host.directory, { 'shadow.mjs': 'export {}\n' })
  expect(() =>
    assertCleanPinnedRepository({
      directory: host.directory,
      expectedHead: host.head,
      prefix: 'NATIVE_REPAIR',
    })
  ).toThrow('NATIVE_REPAIR_SOURCE_DIRTY')
})

test('moved HEAD and missing or malformed pins fail closed', () => {
  const host = hostRepository()
  writeFiles(host.directory, { 'next.mjs': 'export {}\n' })
  git(host.directory, ['add', '.'])
  git(host.directory, ['commit', '-q', '-m', 'next'])
  expect(() =>
    assertCleanPinnedRepository({
      directory: host.directory,
      expectedHead: host.head,
      prefix: 'CANDIDATE',
    })
  ).toThrow('CANDIDATE_HEAD_CHANGED')
  for (const expectedHead of [undefined, 'abc123']) {
    expect(() =>
      assertCleanPinnedRepository({ directory: host.directory, expectedHead, prefix: 'CANDIDATE' })
    ).toThrow('CANDIDATE_HEAD_REQUIRED')
  }
})

test('consistent candidate binds the pinned head, manifest hash and installed SDK', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  const provenance = provenanceFor(host, set)
  expect(provenance.head).toBe(host.head)
  expect(provenance.manifestSha256).toBe(set.manifestSha256)
  expect(provenance.sdk).toMatchObject({ name: '@adea-ai/sdk', version: '1.14.0' })
  expect(provenance.artifacts.map((artifact) => artifact.name).toSorted()).toEqual([
    '@adea-ai/contracts',
    '@adea-ai/runtime-sdk',
    '@adea-ai/sdk',
  ])
})

test('dirty host repository fails before the manifest is considered', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  writeFiles(host.directory, { 'host.mjs': 'export const x = 2\n' })
  expect(() => provenanceFor(host, set)).toThrow('CANDIDATE_SOURCE_DIRTY')
})

test('manifest digest is required and must match the manifest bytes', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  expect(() => provenanceFor(host, set, { manifestSha256: undefined })).toThrow(
    'CANDIDATE_MANIFEST_HASH_REQUIRED'
  )
  expect(() => provenanceFor(host, set, { manifestSha256: 'f'.repeat(64) })).toThrow(
    'CANDIDATE_MANIFEST_HASH_MISMATCH'
  )
  expect(() => provenanceFor(host, set, { manifestPath: undefined })).toThrow(
    'CANDIDATE_MANIFEST_REQUIRED'
  )
})

test('manifest bound to another head or marked dirty fails closed', () => {
  const host = hostRepository()
  const other = candidateSet({ head: 'd'.repeat(40) })
  expect(() => provenanceFor(host, other)).toThrow('CANDIDATE_MANIFEST_HEAD_MISMATCH')
  const dirty = repinManifest(candidateSet({ head: host.head }), (m) => {
    m.dirty = true
  })
  expect(() => provenanceFor(host, dirty)).toThrow('CANDIDATE_MANIFEST_DIRTY')
})

test('malformed manifest schema or unsafe archive path fails closed', () => {
  const host = hostRepository()
  const badSchema = repinManifest(candidateSet({ head: host.head }), (m) => {
    m.schemaVersion = 'other/v1'
  })
  expect(() => provenanceFor(host, badSchema)).toThrow('CANDIDATE_MANIFEST_INVALID')
  const traversal = repinManifest(candidateSet({ head: host.head }), (m) => {
    m.artifacts[0].archive = '../sdk.tgz'
  })
  expect(() => provenanceFor(host, traversal)).toThrow('CANDIDATE_MANIFEST_INVALID')
  const notJson = candidateSet({ head: host.head })
  writeFiles(notJson.packDirectory, { 'manifest.json': '{not json' })
  notJson.manifestSha256 = sha256(readFileSync(notJson.manifestPath))
  expect(() => provenanceFor(host, notJson)).toThrow('CANDIDATE_MANIFEST_INVALID')
})

test('missing SDK artifact in the manifest fails closed', () => {
  const host = hostRepository()
  const set = repinManifest(candidateSet({ head: host.head }), (m) => {
    m.artifacts = m.artifacts.filter((artifact) => artifact.name !== '@adea-ai/sdk')
  })
  expect(() => provenanceFor(host, set)).toThrow('CANDIDATE_SDK_ARTIFACT_MISSING')
})

test('substituted SDK archive fails against the manifest archive digest', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  writeFileSync(join(set.packDirectory, 'sdk.tgz'), 'not the packed archive\n')
  expect(() => provenanceFor(host, set)).toThrow('CANDIDATE_SDK_ARCHIVE_MISMATCH')
})

test('manifest version that differs from the packed identity fails closed', () => {
  const host = hostRepository()
  const set = repinManifest(candidateSet({ head: host.head }), (m) => {
    m.artifacts[0].version = '1.14.1'
  })
  expect(() => provenanceFor(host, set)).toThrow('CANDIDATE_SDK_IDENTITY_MISMATCH')
})

test('substituted installed SDK entry fails against the packed archive', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  writeFiles(join(set.nodeModules, 'sdk'), {
    'dist/index.js': 'export const ControlPlaneClient = null\n',
  })
  expect(() => provenanceFor(host, set)).toThrow('CANDIDATE_SDK_INSTALLED_MISMATCH')
})

test('extra file in the installed SDK package fails closed', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  writeFiles(join(set.nodeModules, 'sdk'), { 'dist/extra.js': 'export {}\n' })
  expect(() => provenanceFor(host, set)).toThrow('CANDIDATE_SDK_INSTALLED_MISMATCH')
})

test('missing installed sibling artifact fails closed', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  rmSync(join(set.nodeModules, 'runtime-sdk'), { recursive: true, force: true })
  expect(() => provenanceFor(host, set)).toThrow('CANDIDATE_SDK_INSTALLED_MISSING')
})

test('substituted installed sibling artifact fails closed', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  writeFiles(join(set.nodeModules, 'contracts'), {
    'dist/index.js': 'export const Contract = null\n',
  })
  expect(() => provenanceFor(host, set)).toThrow('CANDIDATE_SDK_INSTALLED_MISMATCH')
})

test('unscoped or duplicate manifest artifact names fail closed', () => {
  const host = hostRepository()
  const unscoped = repinManifest(candidateSet({ head: host.head }), (m) => {
    m.artifacts[1].name = 'contracts'
  })
  expect(() => provenanceFor(host, unscoped)).toThrow('CANDIDATE_MANIFEST_INVALID')
  const duplicate = repinManifest(candidateSet({ head: host.head }), (m) => {
    m.artifacts[1].name = '@adea-ai/sdk'
  })
  expect(() => provenanceFor(host, duplicate)).toThrow('CANDIDATE_MANIFEST_INVALID')
})

test('SDK installed outside the @adea-ai scope layout fails closed', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  const loose = join(set.root, 'loose', 'sdk')
  writeFiles(loose, packageFiles('@adea-ai/sdk', '1.14.0', SDK_TEXT))
  expect(() => provenanceFor(host, set, { sdkEntry: join(loose, 'dist', 'index.js') })).toThrow(
    'CANDIDATE_SDK_INSTALL_LAYOUT_INVALID'
  )
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

function fundingEnv(host, set, overrides = {}) {
  return {
    PI_FUNDING_CANDIDATE_HOST_ENTRY: host.file,
    PI_FUNDING_CANDIDATE_HEAD: host.head,
    PI_CANDIDATE_MANIFEST: set.manifestPath,
    PI_CANDIDATE_MANIFEST_SHA256: set.manifestSha256,
    PI_CANDIDATE_SDK_ENTRY: set.installedSdkEntry,
    ...overrides,
  }
}

test('funding profile refuses a dirty host source', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  writeFiles(host.directory, { 'host.mjs': 'export const x = 2\n' })
  const run = runProfile(FUNDING_PROFILE, fundingEnv(host, set))
  expect(run.status).not.toBe(0)
  expect(run.output).toContain('CANDIDATE_SOURCE_DIRTY')
})

test('funding profile refuses a run without a manifest digest pin', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  const run = runProfile(
    FUNDING_PROFILE,
    fundingEnv(host, set, { PI_CANDIDATE_MANIFEST_SHA256: '' })
  )
  expect(run.status).not.toBe(0)
  expect(run.output).toContain('CANDIDATE_MANIFEST_HASH_REQUIRED')
})

test('funding profile refuses a substituted installed SDK', () => {
  const host = hostRepository()
  const set = candidateSet({ head: host.head })
  writeFiles(join(set.nodeModules, 'sdk'), {
    'dist/index.js': 'export const ControlPlaneClient = null\n',
  })
  const run = runProfile(FUNDING_PROFILE, fundingEnv(host, set))
  expect(run.status).not.toBe(0)
  expect(run.output).toContain('CANDIDATE_SDK_INSTALLED_MISMATCH')
})

test('native repair profile refuses a dirty source checkout', () => {
  const host = hostRepository()
  writeFiles(host.directory, { 'scratch.mjs': 'export {}\n' })
  const run = runProfile(NATIVE_PROFILE, {
    PI_NATIVE_REPAIR_SOURCE: host.directory,
    PI_NATIVE_REPAIR_HEAD: host.head,
  })
  expect(run.status).not.toBe(0)
  expect(run.output).toContain('NATIVE_REPAIR_SOURCE_DIRTY')
})
