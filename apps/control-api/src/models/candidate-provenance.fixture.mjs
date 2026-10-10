import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse, relative, resolve } from 'node:path'

// Fail-closed provenance for explicit candidate profiles. There is no dirty override, no
// installed-version inference and no ambient SDK fallback. Every guard throws before a
// candidate module is imported. The manifest digest is an operator-supplied pin, so the
// manifest is not self-attesting.
export const CANDIDATE_MANIFEST_SCHEMA = 'pi-durable-candidate-artifacts/v1'
export const SDK_PACKAGE = '@adea-ai/sdk'
const SCOPE = '@adea-ai/'
const COMMIT = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/

const git = (directory, args) =>
  execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Requires the pinned commit to be checked out with a clean tree, including untracked files. */
export function assertCleanPinnedRepository({ directory, expectedHead, prefix }) {
  if (!COMMIT.test(expectedHead ?? '')) throw new Error(`${prefix}_HEAD_REQUIRED`)
  const root = resolve(directory)
  let head
  try {
    head = git(root, ['rev-parse', 'HEAD'])
  } catch {
    throw new Error(`${prefix}_REPOSITORY_UNAVAILABLE`)
  }
  if (head !== expectedHead) throw new Error(`${prefix}_HEAD_CHANGED`)
  if (git(root, ['status', '--porcelain', '--untracked-files=all']) !== '')
    throw new Error(`${prefix}_SOURCE_DIRTY`)
  return expectedHead
}

/**
 * Pins the candidate manifest bytes to an operator-supplied digest, then binds the manifest
 * to the pinned head. The manifest is written by scripts/pack-pi-durable-candidate.mjs.
 */
export function assertCandidateManifest({ manifestPath, manifestSha256, expectedHead }) {
  if (!SHA256.test(manifestSha256 ?? '')) throw new Error('CANDIDATE_MANIFEST_HASH_REQUIRED')
  if (!manifestPath) throw new Error('CANDIDATE_MANIFEST_REQUIRED')
  const bytes = readFileSync(resolve(manifestPath))
  if (sha256(bytes) !== manifestSha256) throw new Error('CANDIDATE_MANIFEST_HASH_MISMATCH')
  let manifest
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('CANDIDATE_MANIFEST_INVALID')
  }
  if (manifest?.schemaVersion !== CANDIDATE_MANIFEST_SCHEMA || !Array.isArray(manifest.artifacts))
    throw new Error('CANDIDATE_MANIFEST_INVALID')
  if (manifest.head !== expectedHead) throw new Error('CANDIDATE_MANIFEST_HEAD_MISMATCH')
  if (manifest.dirty !== false) throw new Error('CANDIDATE_MANIFEST_DIRTY')
  return manifest
}

// Every manifest artifact must be a unique @adea-ai package with a safe archive name and digests.
function validatedArtifacts(manifest) {
  const names = new Set()
  for (const artifact of manifest.artifacts) {
    if (
      typeof artifact?.name !== 'string' ||
      !artifact.name.startsWith(SCOPE) ||
      artifact.name.slice(SCOPE.length).includes('/') ||
      names.has(artifact.name) ||
      typeof artifact.archive !== 'string' ||
      basename(artifact.archive) !== artifact.archive ||
      !artifact.archive.endsWith('.tgz') ||
      typeof artifact.version !== 'string' ||
      !SHA256.test(artifact.sha256 ?? '') ||
      !Number.isSafeInteger(artifact.bytes)
    )
      throw new Error('CANDIDATE_MANIFEST_INVALID')
    names.add(artifact.name)
  }
  if (!names.has(SDK_PACKAGE)) throw new Error('CANDIDATE_SDK_ARTIFACT_MISSING')
  return manifest.artifacts
}

// Map of relative path to bytes for every regular file under root.
function treeBytes(root) {
  const files = new Map()
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.set(relative(root, path), readFileSync(path))
      else throw new Error('CANDIDATE_ARTIFACT_NON_REGULAR_FILE')
    }
  }
  walk(root)
  return files
}

function assertSameTree(expected, actual, failure) {
  if (expected.size !== actual.size) throw new Error(failure)
  for (const [path, bytes] of expected) {
    if (!actual.has(path) || !actual.get(path).equals(bytes)) throw new Error(failure)
  }
}

function packageRootOf(entry) {
  let directory = dirname(resolve(entry))
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory
    if (directory === parse(directory).root) throw new Error('CANDIDATE_SDK_PACKAGE_MISSING')
    directory = dirname(directory)
  }
}

// Extracts the archive into a private directory and returns its packed package files.
function packedTree(archive) {
  const directory = mkdtempSync(join(tmpdir(), 'cp-candidate-archive-'))
  try {
    execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'pipe' })
    return treeBytes(join(directory, 'package'))
  } catch {
    throw new Error('CANDIDATE_SDK_ARCHIVE_INVALID')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function assertInstalledArtifact({ artifact, manifestPath, installedRoot }) {
  const archive = join(dirname(resolve(manifestPath)), artifact.archive)
  if (!existsSync(archive)) throw new Error('CANDIDATE_SDK_ARCHIVE_MISSING')
  const archiveBytes = readFileSync(archive)
  if (archiveBytes.length !== artifact.bytes || sha256(archiveBytes) !== artifact.sha256)
    throw new Error('CANDIDATE_SDK_ARCHIVE_MISMATCH')
  const packed = packedTree(archive)
  const packageJson = packed.get('package.json')
  const packedPackage = packageJson ? JSON.parse(packageJson.toString('utf8')) : null
  if (packedPackage?.name !== artifact.name || packedPackage?.version !== artifact.version)
    throw new Error('CANDIDATE_SDK_IDENTITY_MISMATCH')
  // The installed package must be byte-identical to the packed archive, file for file.
  if (!existsSync(installedRoot)) throw new Error('CANDIDATE_SDK_INSTALLED_MISSING')
  assertSameTree(packed, treeBytes(installedRoot), 'CANDIDATE_SDK_INSTALLED_MISMATCH')
  return { name: artifact.name, version: artifact.version, archiveSha256: artifact.sha256 }
}

/**
 * Verifies the explicit installed SDK entry against the manifest. The SDK package and every
 * sibling artifact in the manifest, installed under the same @adea-ai scope, must equal their
 * archive contents byte for byte. An uninstalled sibling fails closed.
 */
export function assertCandidateArtifacts({ manifest, manifestPath, installedSdkEntry }) {
  const artifacts = validatedArtifacts(manifest)
  const sdkRoot = packageRootOf(installedSdkEntry)
  const scopeRoot = dirname(sdkRoot)
  if (
    basename(scopeRoot) !== SCOPE.slice(0, -1) ||
    basename(sdkRoot) !== SDK_PACKAGE.slice(SCOPE.length)
  )
    throw new Error('CANDIDATE_SDK_INSTALL_LAYOUT_INVALID')
  return artifacts.map((artifact) =>
    assertInstalledArtifact({
      artifact,
      manifestPath,
      installedRoot: join(scopeRoot, artifact.name.slice(SCOPE.length)),
    })
  )
}

/** Single entry point for the funding candidate profile. Throws on the first failed guard. */
export function assertFundingCandidateProvenance({
  hostEntry,
  head,
  manifestPath,
  manifestSha256,
  sdkEntry,
}) {
  const pin = assertCleanPinnedRepository({
    directory: dirname(resolve(hostEntry)),
    expectedHead: head,
    prefix: 'CANDIDATE',
  })
  const manifest = assertCandidateManifest({ manifestPath, manifestSha256, expectedHead: pin })
  if (!sdkEntry) throw new Error('CANDIDATE_SDK_ENTRY_REQUIRED')
  const artifacts = assertCandidateArtifacts({
    manifest,
    manifestPath,
    installedSdkEntry: sdkEntry,
  })
  const sdk = artifacts.find((artifact) => artifact.name === SDK_PACKAGE)
  return { head: pin, manifestSha256, sdk, artifacts }
}
