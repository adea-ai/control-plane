import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Repository-owned release pull-request readiness policy (CP #916).
 *
 * On 2026-10-07 a generated release pull request at an unchanged source head
 * was converted back to draft and re-readied by the release preparation step.
 * The draft transition cancelled the pull request's active current-head
 * validation, which forced a replacement run. The cancelled aggregates failed
 * correctly and must not be weakened; the defect was the unconditional reset.
 *
 * The shared Code Foundry release workflow carries the fix. This module is the
 * repository's own copy of that policy: it exists so the behaviour can be
 * proven deterministically, offline, without executing a release and without
 * reading a workflow file to decide what the behaviour is. The module decides;
 * the shared workflow performs the mutation.
 *
 * The decision is fail-closed. An unverified state is never treated as a
 * licence to mutate a pull request, and a failed current-head qualification
 * is never treated as a licence to start another one.
 */

/**
 * The first Code Foundry release that preserves an unchanged ready release
 * head's live current-head validation instead of resetting it.
 *
 * Evidence: the release workflow is byte-identical from v1.46.4 onwards
 * (43028 bytes) and carries the "already has current-head validation;
 * preserving readiness" branch. Every earlier release, including the v1.44.11
 * and v1.45.2 pins named in the issue, carries the unconditional
 * `gh pr ready --undo` instead (37971 bytes).
 */
export const RELEASE_READINESS_FIX_MINIMUM = 'v1.46.4'

/** The head namespace Release Please generates version pull requests in. */
export const GENERATED_RELEASE_HEAD = 'release-please--branches--main'

/** The validation workflows that can own a release pull request's checks. */
export const VALIDATION_WORKFLOWS = [
  '.github/workflows/validation.yml',
  '.github/workflows/validation_self-ci.yml',
]

const HEAD_PATTERN = /^[a-f0-9]{40}$/
const VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/

/** True when the head branch is one Release Please generates. */
export function isGeneratedReleaseHead(headRef) {
  return (
    typeof headRef === 'string' &&
    (headRef === GENERATED_RELEASE_HEAD || headRef.startsWith(`${GENERATED_RELEASE_HEAD}--`))
  )
}

/** Parse a `v1.2.3` tag into a comparable tuple. */
export function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version ?? '')
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** True when `version` is at least `minimum`. */
export function versionAtLeast(version, minimum = RELEASE_READINESS_FIX_MINIMUM) {
  const left = parseVersion(version)
  const right = parseVersion(minimum)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return true
}

function isActiveRun(run) {
  return (
    run.status === 'queued' ||
    run.status === 'in_progress' ||
    run.status === 'waiting' ||
    run.status === 'pending' ||
    run.status === 'requested'
  )
}

function isOwnedConclusion(conclusion) {
  return conclusion === 'success'
}

function isFailedConclusion(conclusion) {
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required'
}

function isMissingConclusion(conclusion) {
  return conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral'
}

/**
 * Classify the run that owns a release pull request's current-head validation.
 *
 * The newest run for the exact head wins, so an older live run cannot mask a
 * newer failed qualification and a newer live run supersedes an older
 * cancelled one.
 *
 * Two things are refused rather than interpreted:
 *
 * - A malformed entry — an unidentifiable run, a nonpositive attempt number, or
 *   a status the Actions API does not define — is an error, never evidence
 *   that validation is missing. An unknown status is not "not running yet": it
 *   is a state this policy does not understand, and guessing at it could hide a
 *   failed qualification behind a readiness transition.
 * - An incomplete page is an error too, but only when the page can be shown to
 *   be incomplete. The Actions API reports the number of runs it holds, and
 *   that count is the completeness witness: without it a truncated page cannot
 *   be told apart from a genuinely absent owner, so the caller must supply it
 *   and this function refuses a page whose count does not match.
 *
 * Returns 'owned', 'failed' or 'missing'. Throws when the ownership cannot be
 * established.
 */
export function classifyValidationOwner(runs, { head, branch, repository, totalCount }) {
  if (!Array.isArray(runs)) throw new Error('Invalid validation owner response')
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new Error('Incomplete validation owner response')
  }
  if (totalCount !== runs.length) throw new Error('Incomplete validation owner response')
  const candidates = runs.filter((run) => {
    if (run === null || typeof run !== 'object') {
      throw new Error('Invalid validation run identity or state')
    }
    if (typeof run.id !== 'number' || !Number.isInteger(run.id) || run.id <= 0) {
      throw new Error('Invalid validation run identity or state')
    }
    if (
      typeof run.run_attempt !== 'number' ||
      !Number.isInteger(run.run_attempt) ||
      run.run_attempt < 1
    ) {
      throw new Error('Invalid validation run identity or state')
    }
    if (typeof run.head_sha !== 'string' || !HEAD_PATTERN.test(run.head_sha)) {
      throw new Error('Invalid validation run identity or state')
    }
    if (typeof run.head_branch !== 'string' || run.head_branch.length === 0) {
      throw new Error('Invalid validation run identity or state')
    }
    if (typeof run.event !== 'string' || run.event.length === 0) {
      throw new Error('Invalid validation run identity or state')
    }
    if (run.repository === null || typeof run.repository !== 'object') {
      throw new Error('Invalid validation run identity or state')
    }
    if (typeof run.repository.full_name !== 'string' || run.repository.full_name.length === 0) {
      throw new Error('Invalid validation run identity or state')
    }
    if (typeof run.path !== 'string' || run.path.length === 0) {
      throw new Error('Invalid validation run identity or state')
    }
    if (typeof run.status !== 'string') {
      throw new Error('Invalid validation run identity or state')
    }
    if (!isActiveRun(run) && run.status !== 'completed') {
      // A status the Actions API does not define is not a run that is merely
      // still going. It is a state this policy does not understand, so it is
      // refused instead of being read as an absent owner.
      throw new Error('Invalid validation run identity or state')
    }
    if (isActiveRun(run) && run.conclusion !== null && run.conclusion !== undefined) {
      throw new Error('Invalid validation run identity or state')
    }
    if (
      run.status === 'completed' &&
      !isOwnedConclusion(run.conclusion) &&
      !isFailedConclusion(run.conclusion) &&
      !isMissingConclusion(run.conclusion)
    ) {
      throw new Error('Invalid validation run identity or state')
    }
    const workflow = run.path.split('@')[0]
    return (
      run.head_sha === head &&
      run.head_branch === branch &&
      run.event === 'pull_request' &&
      run.repository.full_name === repository &&
      VALIDATION_WORKFLOWS.includes(workflow)
    )
  })
  if (candidates.length === 0) return 'missing'
  const newest = candidates.toSorted((left, right) => left.id - right.id).at(-1)
  if (
    isActiveRun(newest) ||
    (newest.status === 'completed' && isOwnedConclusion(newest.conclusion))
  ) {
    return 'owned'
  }
  if (newest.status === 'completed' && isFailedConclusion(newest.conclusion)) return 'failed'
  return 'missing'
}

/**
 * Decide what release preparation must do with a generated release pull
 * request.
 *
 * The states are the ones the acceptance names: an unchanged ready head with
 * valid current-head validation ownership is preserved; a changed head, a
 * newly created draft, missing validation and a failed qualification keep the
 * canonical required-readiness and fail-closed behaviour.
 *
 * Returns `{ action, reason }`. `action` is one of 'preserve', 'ready',
 * 'reset-and-ready', 'reset-to-draft' or 'fail-closed'.
 */
export function decideReleasePrReadiness(state) {
  const { draft, head, headRef, validationOwner, automationTokenValid } = state ?? {}
  if (typeof draft !== 'boolean' || typeof head !== 'string' || !HEAD_PATTERN.test(head)) {
    return { action: 'fail-closed', reason: 'release-pr-state-unverified' }
  }
  if (typeof headRef !== 'string' || headRef.length === 0) {
    return { action: 'fail-closed', reason: 'release-pr-state-unverified' }
  }
  if (!isGeneratedReleaseHead(headRef)) {
    return { action: 'fail-closed', reason: 'release-head-outside-generated-namespace' }
  }
  if (automationTokenValid !== true) {
    // No validated automation credential: the pull request is left in draft and
    // needs manual readiness. It is never merged automatically, and a ready
    // pull request is returned to draft rather than left in a state that
    // implies the automation can proceed.
    return { action: 'reset-to-draft', reason: 'automation-token-unavailable' }
  }
  if (draft) {
    // A new draft receives its first readiness transition; there is no
    // validation owner to look up before it.
    return { action: 'ready', reason: 'new-draft-first-readiness' }
  }
  if (validationOwner === 'owned') {
    // The whole point of the guard: an unchanged ready head keeps its live
    // current-head validation instead of being reset and reallocated.
    return { action: 'preserve', reason: 'current-head-validation-owned' }
  }
  if (validationOwner === 'failed') {
    return { action: 'fail-closed', reason: 'current-head-validation-failed' }
  }
  if (validationOwner === 'missing') {
    return { action: 'reset-and-ready', reason: 'validation-owner-missing' }
  }
  return { action: 'fail-closed', reason: 'validation-owner-unconfirmed' }
}

/**
 * The shared Code Foundry runtime versions this repository's release wiring
 * actually uses.
 *
 * Both the generated configuration and the release workflow are read, because a
 * downgrade in either one reintroduces the reset.
 */
export async function effectiveReleaseRuntime(root) {
  const config = await readFile(join(root, '.github', 'code-foundry.yml'), 'utf8')
  const workflow = await readFile(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  const versions = new Set()
  const configRef = config.match(/^runtime_ref:\s*(\S+)\s*$/m)?.[1]
  if (configRef) versions.add(configRef)
  for (const match of workflow.matchAll(
    /0xPlayerOne\/code-foundry\/\.github\/workflows\/release\.yml@(\S+)/g
  )) {
    versions.add(match[1])
  }
  for (const match of workflow.matchAll(/^\s*runtime-ref:\s*(\S+)\s*$/gm)) {
    versions.add(match[1])
  }
  return [...versions].toSorted()
}

/**
 * Fail closed when the shared runtime in use cannot preserve an unchanged
 * ready release head's validation.
 *
 * This is the executable form of the migration and compatibility limit: a
 * repository pinned below the fix keeps the canonical behaviour of every
 * other release, but repeating preparation for an unchanged ready head
 * resets it and cancels its validation.
 */
export function assertReleaseRuntimeCarriesReadinessFix(versions) {
  if (!Array.isArray(versions) || versions.length === 0) {
    // An empty detected set proves nothing: the release wiring may have moved
    // and the detector may simply no longer recognise it. The floor cannot be
    // shown to be met, so the guard refuses rather than passing vacuously.
    throw new Error(
      'No shared Code Foundry release runtime was detected in the release wiring, so the ' +
        `unchanged-ready-head fix (${RELEASE_READINESS_FIX_MINIMUM}) cannot be shown to be present.`
    )
  }
  const stale = versions.filter((version) => !versionAtLeast(version))
  if (stale.length > 0) {
    throw new Error(
      `The shared Code Foundry release runtime ${stale.join(', ')} predates ${RELEASE_READINESS_FIX_MINIMUM} ` +
        'and resets an unchanged ready release pull request instead of preserving its current-head validation. ' +
        'Upgrade the runtime_ref and the release workflow runtime-ref, or keep the release pull request in draft ' +
        'until the shared runtime carries the fix.'
    )
  }
  return versions
}

/** Check this repository's own release wiring. Returns the versions in use. */
export async function checkRepositoryReleaseReadiness(root) {
  const versions = await effectiveReleaseRuntime(root)
  assertReleaseRuntimeCarriesReadinessFix(versions)
  return versions
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

if (import.meta.main) {
  const [command] = process.argv.slice(2)
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
  try {
    if (command === 'check') {
      const versions = await checkRepositoryReleaseReadiness(repositoryRoot)
      console.log(
        `Release readiness policy: shared runtime ${versions.join(', ')} carries the unchanged-ready-head fix ` +
          `(minimum ${RELEASE_READINESS_FIX_MINIMUM}).`
      )
    } else if (command === 'decide') {
      const state = JSON.parse(await readStdin())
      const decision = decideReleasePrReadiness(state)
      console.log(JSON.stringify(decision))
      if (decision.action === 'fail-closed') process.exitCode = 1
    } else {
      console.error('Usage: release-pr-readiness.mjs <check|decide>')
      process.exitCode = 2
    }
  } catch (error) {
    console.error(
      `::error title=Release readiness policy failed::${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
