import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

// Test-profile provenance guards. They fail closed: no dirty override, no installed-version
// inference, no ambient host or SDK fallback. The manifest is an owner-supplied identity pin,
// not an authentication mechanism.
const COMMIT = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/

const git = (directory, args) =>
  execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Requires the pinned commit to be checked out with a clean tree, including untracked files. */
export function assertCleanPinnedRepository({ directory, expectedHead, prefix }) {
  if (!COMMIT.test(expectedHead ?? '')) throw new Error(`${prefix}_HEAD_REQUIRED`)
  const root = resolve(directory)
  if (git(root, ['rev-parse', 'HEAD']) !== expectedHead) throw new Error(`${prefix}_HEAD_CHANGED`)
  if (git(root, ['status', '--porcelain', '--untracked-files=all']) !== '')
    throw new Error(`${prefix}_SOURCE_DIRTY`)
  return expectedHead
}

function nearestPackageJson(start) {
  let directory = resolve(start)
  for (;;) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate)) return candidate
    if (directory === parse(directory).root) throw new Error('CANDIDATE_SDK_PACKAGE_MISSING')
    directory = dirname(directory)
  }
}

/**
 * Binds the explicit SDK entry to the candidate manifest: host commit, package identity,
 * source provenance (package gitHead) and entry bytes. Any mismatch throws.
 */
export function assertSdkArtifactAgainstManifest({ sdkEntry, manifestPath, hostCommit }) {
  if (!manifestPath) throw new Error('CANDIDATE_MANIFEST_REQUIRED')
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'))
  const sdk = manifest?.sdk
  if (
    !COMMIT.test(manifest?.hostCommit ?? '') ||
    !COMMIT.test(sdk?.sourceCommit ?? '') ||
    !SHA256.test(sdk?.entrySha256 ?? '') ||
    typeof sdk?.packageName !== 'string' ||
    typeof sdk?.version !== 'string'
  )
    throw new Error('CANDIDATE_MANIFEST_INVALID')
  if (manifest.hostCommit !== hostCommit) throw new Error('CANDIDATE_MANIFEST_HOST_MISMATCH')

  const entry = resolve(sdkEntry)
  const pkg = JSON.parse(readFileSync(nearestPackageJson(dirname(entry)), 'utf8'))
  if (pkg.name !== sdk.packageName || pkg.version !== sdk.version)
    throw new Error('CANDIDATE_SDK_IDENTITY_MISMATCH')
  if (pkg.gitHead !== sdk.sourceCommit) throw new Error('CANDIDATE_SDK_PROVENANCE_MISMATCH')
  if (sha256(readFileSync(entry)) !== sdk.entrySha256)
    throw new Error('CANDIDATE_SDK_ARTIFACT_MISMATCH')
  return { packageName: pkg.name, version: pkg.version, sourceCommit: pkg.gitHead }
}
