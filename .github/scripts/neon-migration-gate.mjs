import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const MAX_BASELINE_CANDIDATES = 25
const VERIFY_STEP = "Verify migrations and this shard's integration slice"
const CONFORMANCE_STEP = 'Verify cross-profile conformance matrix (Postgres)'
const HOSTED_GRAPH_STEP = 'Verify Hosted PostgreSQL and Restate graph'

const relevantPaths = new Set([
  '.bun-version',
  '.github/code-foundry.yml',
  '.github/scripts/neon-migration-gate.mjs',
  '.github/workflows/neon_workflow.yml',
  '.mise.toml',
  '.node-version',
  '.npmrc',
  '.nvmrc',
  '.release-please-manifest.json',
  '.tool-versions',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  'mise.toml',
  'package.json',
  'scripts/integration-shards.mjs',
  'scripts/run-cloud-remote-drill.mjs',
  'scripts/run-integration-tests.mjs',
  'scripts/run-hosted-graph-qualification.sh',
  'scripts/provision-restate-identity.mjs',
  'scripts/remove-hosted-compose-fixture.mjs',
  'infrastructure/compose/compose.yaml',
  'tests/cp1-embedded-durable-execution.test.mjs',
  'tests/integration-shards.test.mjs',
  'tsconfig.json',
  'turbo.json',
])

function publishVerification(outputPath, required, reason) {
  appendFileSync(outputPath, `verify=${required}\n`)
  const state = required === 'true' ? 'running' : 'skipped'
  console.log(`::notice title=Neon verify ${state}::${reason}`)
}

function requireVerification(outputPath, reason) {
  publishVerification(outputPath, 'true', reason)
}

function isCommitSha(value) {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
}

function readGitFile(revision, path) {
  return execFileSync('git', ['show', `${revision}:${path}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function isVersion(value) {
  return (
    typeof value === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  )
}

function isVersionOnlyPackageChange(path, baseline, headSha) {
  try {
    const before = JSON.parse(readGitFile(baseline, path))
    const after = JSON.parse(readGitFile(headSha, path))
    if (
      !before ||
      !after ||
      typeof before !== 'object' ||
      typeof after !== 'object' ||
      Array.isArray(before) ||
      Array.isArray(after) ||
      !isVersion(before.version) ||
      !isVersion(after.version)
    ) {
      return false
    }
    const beforeMetadata = { ...before }
    const afterMetadata = { ...after }
    delete beforeMetadata.version
    delete afterMetadata.version
    return JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata)
  } catch {
    return false
  }
}

function isVersionOnlyReleaseManifest(baseline, headSha) {
  try {
    const before = JSON.parse(readGitFile(baseline, '.release-please-manifest.json'))
    const after = JSON.parse(readGitFile(headSha, '.release-please-manifest.json'))
    if (
      !before ||
      !after ||
      typeof before !== 'object' ||
      typeof after !== 'object' ||
      Array.isArray(before) ||
      Array.isArray(after)
    ) {
      return false
    }
    const keys = Object.keys(before).toSorted()
    if (JSON.stringify(keys) !== JSON.stringify(Object.keys(after).toSorted())) return false
    return keys.every((key) => isVersion(before[key]) && isVersion(after[key]))
  } catch {
    return false
  }
}

function isReleaseMetadata(path, baseline, headSha) {
  if (path === '.release-please-manifest.json') {
    return isVersionOnlyReleaseManifest(baseline, headSha)
  }
  if (path === 'CHANGELOG.md' || /^(?:apps|packages)\/[^/]+\/CHANGELOG\.md$/.test(path)) {
    return true
  }
  if (/^(?:package\.json|(?:apps|packages)\/[^/]+\/package\.json)$/.test(path)) {
    return isVersionOnlyPackageChange(path, baseline, headSha)
  }
  return false
}

function hasSuccessfulStep(job, name) {
  if (!Array.isArray(job.steps)) return false
  const matchingSteps = job.steps.filter((step) => step?.name === name)
  return (
    matchingSteps.length === 1 &&
    matchingSteps[0]?.status === 'completed' &&
    matchingSteps[0]?.conclusion === 'success'
  )
}

function hasSuccessfulVerificationJobs(repository, run) {
  if (!Number.isSafeInteger(run?.id) || run.id <= 0) return false

  let response
  try {
    const body = execFileSync(
      'gh',
      ['api', `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    response = JSON.parse(body)
  } catch {
    return false
  }

  if (!Array.isArray(response?.jobs)) return false
  const verifiedShards = new Set()
  for (const job of response.jobs) {
    const match = /^Verify Neon shard ([123]) \(migrations and integration slice\)$/.exec(
      job?.name ?? ''
    )
    if (!match) continue
    const shard = Number(match[1])
    if (
      verifiedShards.has(shard) ||
      job?.status !== 'completed' ||
      job?.conclusion !== 'success' ||
      !hasSuccessfulStep(job, VERIFY_STEP) ||
      (shard === 1 && !hasSuccessfulStep(job, CONFORMANCE_STEP)) ||
      (shard === 3 && !hasSuccessfulStep(job, HOSTED_GRAPH_STEP))
    ) {
      return false
    }
    verifiedShards.add(shard)
  }

  return verifiedShards.size === 3
}

function findVerifiedBaseline(repository, response) {
  if (!Array.isArray(response?.workflow_runs)) return undefined

  for (const run of response.workflow_runs.slice(0, MAX_BASELINE_CANDIDATES)) {
    if (
      run?.status !== 'completed' ||
      run?.conclusion !== 'success' ||
      run?.head_branch !== 'main' ||
      run?.event !== 'push' ||
      !isCommitSha(run?.head_sha) ||
      !Number.isSafeInteger(run?.run_attempt) ||
      run.run_attempt < 1
    ) {
      continue
    }

    if (hasSuccessfulVerificationJobs(repository, run)) return run.head_sha
  }

  return undefined
}

export function isMigrationRelevantPath(path) {
  return (
    path.startsWith('apps/') ||
    path.startsWith('packages/') ||
    path.startsWith('.github/actions/') ||
    relevantPaths.has(path)
  )
}

function main() {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) throw new Error('GITHUB_OUTPUT is unavailable')

  const repository = process.env.REPOSITORY
  const headSha = process.env.GITHUB_SHA
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !isCommitSha(headSha)) {
    requireVerification(outputPath, 'The repository or pushed commit could not be validated.')
    return
  }

  // A push whose own commit only touches release metadata cannot alter the
  // migration-relevant tree, and the anchor race makes the verified-baseline
  // diff unreliable for exactly these pushes: the release merge lands minutes
  // after its feature, while that feature's verification is still running, so
  // the newest successful baseline predates the feature and the baseline diff
  // re-reports the feature's changes as relevant. Judge the pushed commit
  // against its own parent instead; any git failure falls through to the
  // baseline comparison.
  let parentSha
  try {
    parentSha = execFileSync('git', ['rev-parse', `${headSha}^`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    parentSha = undefined
  }
  if (parentSha && isCommitSha(parentSha)) {
    try {
      const pushedDiff = execFileSync(
        'git',
        ['diff', '--no-renames', '--name-only', '-z', parentSha, headSha],
        { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      const pushedPaths = pushedDiff
        .toString('utf8')
        .split('\0')
        .filter((path) => path.length > 0)
      const pushedReleaseMetadata = pushedPaths.filter((path) =>
        isReleaseMetadata(path, parentSha, headSha)
      )
      const pushedRelevant = pushedPaths.find(
        (path) => isMigrationRelevantPath(path) && !isReleaseMetadata(path, parentSha, headSha)
      )
      if (pushedReleaseMetadata.length > 0 && !pushedRelevant) {
        publishVerification(
          outputPath,
          'false',
          'The pushed commit only changes version metadata and changelogs; the migration-relevant tree is unchanged from its parent.'
        )
        return
      }
    } catch {
      // Fall through to the baseline comparison if the parent diff fails.
    }
  }

  let response
  try {
    const body = execFileSync(
      'gh',
      [
        'api',
        `repos/${repository}/actions/workflows/neon_workflow.yml/runs?branch=main&event=push&status=success&per_page=${MAX_BASELINE_CANDIDATES}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    response = JSON.parse(body)
  } catch {
    requireVerification(outputPath, 'The latest successful Neon workflow run could not be queried.')
    return
  }

  const baseline = findVerifiedBaseline(repository, response)
  if (!baseline) {
    requireVerification(
      outputPath,
      'No recent successful Neon shard verification baseline is available.'
    )
    return
  }

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseline, headSha], {
      stdio: 'ignore',
    })
  } catch {
    requireVerification(outputPath, 'The successful baseline is not an ancestor of this push.')
    return
  }

  let changedPaths
  try {
    // Keep rename sources visible too: moving a relevant file out of an
    // included tree must still force a fresh verification.
    const output = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-only', '-z', baseline, headSha],
      {
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    )
    changedPaths = output
      .toString('utf8')
      .split('\0')
      .filter((path) => path.length > 0)
  } catch {
    requireVerification(outputPath, 'The change diff could not be read safely.')
    return
  }

  const relevantChanges = changedPaths.filter(isMigrationRelevantPath)
  const relevant = relevantChanges.find((path) => !isReleaseMetadata(path, baseline, headSha))
  if (relevantChanges.length > 0 && !relevant) {
    publishVerification(
      outputPath,
      'false',
      'Only version metadata and changelogs changed; the migration-relevant baseline is unchanged.'
    )
    return
  }

  if (relevant) {
    publishVerification(
      outputPath,
      'true',
      `Migration-relevant changes since the last successful verification (first: ${relevant}).`
    )
    return
  }

  publishVerification(
    outputPath,
    'false',
    'No migration-relevant changes since the last successful verification.'
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
