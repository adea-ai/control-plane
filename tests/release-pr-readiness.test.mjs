import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  RELEASE_READINESS_FIX_MINIMUM,
  assertReleaseRuntimeCarriesReadinessFix,
  classifyValidationOwner,
  decideReleasePrReadiness,
  effectiveReleaseRuntime,
  isGeneratedReleaseHead,
  versionAtLeast,
} from '../scripts/release-pr-readiness.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const HEAD = 'a'.repeat(40)
const BRANCH = 'release-please--branches--main--components-adea'
const REPOSITORY = 'adea-ai/control-plane'
const VALIDATION_PATH = '.github/workflows/validation.yml'

function run(overrides = {}) {
  return {
    id: 1,
    run_attempt: 1,
    head_sha: HEAD,
    head_branch: BRANCH,
    event: 'pull_request',
    repository: { full_name: REPOSITORY },
    path: VALIDATION_PATH,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}

function owner(runs, overrides = {}) {
  return classifyValidationOwner(runs, {
    head: HEAD,
    branch: BRANCH,
    repository: REPOSITORY,
    totalCount: runs.length,
    ...overrides,
  })
}

function state(overrides = {}) {
  return {
    draft: false,
    head: HEAD,
    headRef: BRANCH,
    validationOwner: 'owned',
    automationTokenValid: true,
    ...overrides,
  }
}

test('an unchanged ready release preserves its current-head validation', () => {
  assert.deepEqual(decideReleasePrReadiness(state()), {
    action: 'preserve',
    reason: 'current-head-validation-owned',
  })
  // The no-op path is the incident: it must not ask for a readiness transition.
  const decision = decideReleasePrReadiness(state({ validationOwner: 'owned' }))
  assert.equal(decision.action, 'preserve')
  assert.notEqual(decision.action, 'reset-and-ready')
})

test('a missing validation owner still needs the explicit readiness transition', () => {
  assert.deepEqual(decideReleasePrReadiness(state({ validationOwner: 'missing' })), {
    action: 'reset-and-ready',
    reason: 'validation-owner-missing',
  })
})

test('a failed current-head qualification is never reallocated', () => {
  assert.deepEqual(decideReleasePrReadiness(state({ validationOwner: 'failed' })), {
    action: 'fail-closed',
    reason: 'current-head-validation-failed',
  })
})

test('a new draft receives its first readiness transition without an ownership lookup', () => {
  assert.deepEqual(decideReleasePrReadiness(state({ draft: true, validationOwner: 'missing' })), {
    action: 'ready',
    reason: 'new-draft-first-readiness',
  })
})

test('an unavailable automation credential leaves the release pull request in draft', () => {
  assert.deepEqual(decideReleasePrReadiness(state({ automationTokenValid: false })), {
    action: 'reset-to-draft',
    reason: 'automation-token-unavailable',
  })
  assert.deepEqual(decideReleasePrReadiness(state({ draft: true, automationTokenValid: false })), {
    action: 'reset-to-draft',
    reason: 'automation-token-unavailable',
  })
})

test('an unverified release pull request state fails closed', () => {
  for (const overrides of [
    { draft: null },
    { draft: 'false' },
    { head: 'not-a-sha' },
    { head: undefined },
    { headRef: '' },
    { headRef: undefined },
  ]) {
    assert.deepEqual(
      decideReleasePrReadiness(state(overrides)),
      { action: 'fail-closed', reason: 'release-pr-state-unverified' },
      `state ${JSON.stringify(overrides)} must fail closed`
    )
  }
})

test('a release head outside the generated namespace is never mutated', () => {
  assert.deepEqual(decideReleasePrReadiness(state({ headRef: 'feature/some-branch' })), {
    action: 'fail-closed',
    reason: 'release-head-outside-generated-namespace',
  })
  assert.equal(isGeneratedReleaseHead('feature/some-branch'), false)
  assert.equal(isGeneratedReleaseHead('release-please--branches--main'), true)
  assert.equal(isGeneratedReleaseHead('release-please--branches--main--components-adea'), true)
})

test('an unconfirmed validation owner fails closed', () => {
  assert.deepEqual(decideReleasePrReadiness(state({ validationOwner: 'unconfirmed' })), {
    action: 'fail-closed',
    reason: 'validation-owner-unconfirmed',
  })
})

test('the current-head validation owner is the newest run for the exact head', () => {
  const older = run({ id: 10, status: 'completed', conclusion: 'cancelled' })
  const newer = run({ id: 11, status: 'in_progress', conclusion: null })
  assert.equal(owner([older, newer]), 'owned')
  const newerFailed = run({ id: 12, status: 'completed', conclusion: 'failure' })
  assert.equal(owner([newer, newerFailed]), 'failed')
})

test('a cancelled or skipped owner is missing, not owned', () => {
  for (const conclusion of ['cancelled', 'skipped', 'neutral']) {
    assert.equal(owner([run({ conclusion })]), 'missing')
  }
})

test('a run for another head, branch, event, repository or workflow is not an owner', () => {
  const foreign = [
    run({ head_sha: 'b'.repeat(40) }),
    run({ head_branch: 'feature/other' }),
    run({ event: 'push' }),
    run({ repository: { full_name: 'adea-ai/adea' } }),
    run({ path: '.github/workflows/release.yml' }),
  ]
  assert.equal(owner(foreign), 'missing')
})

test('a malformed ownership entry fails before any readiness write', () => {
  for (const malformed of [
    run({ id: 0 }),
    run({ id: 1.5 }),
    run({ run_attempt: 0 }),
    run({ run_attempt: -1 }),
    run({ run_attempt: 1.5 }),
    run({ head_sha: 'short' }),
    run({ head_branch: '' }),
    run({ event: '' }),
    run({ repository: null }),
    run({ path: '' }),
    run({ status: 'completed', conclusion: 'weird' }),
  ]) {
    assert.throws(() => owner([malformed]), /Invalid validation run identity or state/)
  }
  assert.throws(() => owner('not-an-array'), /Invalid validation owner response/)
})

test('a run status the Actions API does not define is refused, not read as missing', () => {
  // An unknown status is not "not running yet". It is a state this policy does
  // not understand, and reading it as an absent owner would let a readiness
  // transition proceed past a qualification whose real outcome is unknown.
  for (const status of ['unknown', 'weird', '', 'Completed', 'pending_review', 'timed_out']) {
    assert.throws(
      () => owner([run({ status, conclusion: null })]),
      /Invalid validation run identity or state/,
      `status ${JSON.stringify(status)} must be refused`
    )
  }
  // An active run that already carries a conclusion is equally untrustworthy.
  assert.throws(
    () => owner([run({ status: 'in_progress', conclusion: 'success' })]),
    /Invalid validation run identity or state/
  )
})

test('an incomplete Actions page is refused when the page says it is incomplete', () => {
  // The API's total count is the completeness witness: a page that reports
  // more runs than it returned cannot prove that an owner is absent.
  assert.throws(() => owner([run()], { totalCount: 2 }), /Incomplete validation owner response/)
  assert.throws(
    () => owner([run(), run({ id: 2 })], { totalCount: 5 }),
    /Incomplete validation owner response/
  )
})

test('an Actions page without a completeness witness is refused', () => {
  // Without the API's total count a truncated page cannot be told apart from
  // a genuinely absent owner, so the owner cannot be established at all.
  assert.throws(
    () => owner([run()], { totalCount: undefined }),
    /Incomplete validation owner response/
  )
  assert.throws(
    () => owner([run()], { totalCount: Number.NaN }),
    /Incomplete validation owner response/
  )
})

test('the shared runtime that carries the fix is identified by version, not by name', () => {
  assert.equal(RELEASE_READINESS_FIX_MINIMUM, 'v1.46.4')
  assert.equal(versionAtLeast('v1.46.4'), true)
  assert.equal(versionAtLeast('v1.46.3'), false)
  assert.equal(versionAtLeast('v1.45.2'), false)
  assert.equal(versionAtLeast('v1.44.11'), false)
  assert.equal(versionAtLeast('v1.48.1'), true)
  assert.equal(versionAtLeast('v1.49.0'), true)
  assert.equal(versionAtLeast('not-a-version'), false)
})

test('an empty detected runtime set is refused instead of passing vacuously', () => {
  // Nothing detected proves nothing. The floor cannot be shown to be met, so
  // the guard refuses rather than passing an empty comparison.
  assert.throws(
    () => assertReleaseRuntimeCarriesReadinessFix([]),
    /No shared Code Foundry release runtime was detected/
  )
  assert.throws(
    () => assertReleaseRuntimeCarriesReadinessFix(undefined),
    /No shared Code Foundry release runtime was detected/
  )
})

test('a shared runtime below the fix floor is refused', () => {
  assert.throws(() => assertReleaseRuntimeCarriesReadinessFix(['v1.45.2']), /predates v1\.46\.4/)
  assert.deepEqual(assertReleaseRuntimeCarriesReadinessFix(['v1.46.4', 'v1.48.1']), [
    'v1.46.4',
    'v1.48.1',
  ])
})

test('this repository release wiring uses a shared runtime that carries the fix', async () => {
  const versions = await effectiveReleaseRuntime(root)
  assert.ok(versions.length > 0, 'the release wiring must name a shared runtime')
  for (const version of versions) {
    assert.equal(
      versionAtLeast(version),
      true,
      `shared runtime ${version} predates ${RELEASE_READINESS_FIX_MINIMUM} and resets an unchanged ready release head`
    )
  }
  assert.deepEqual(assertReleaseRuntimeCarriesReadinessFix(versions), versions)
})

test('the release workflow keeps the serialized, non-cancelling release flow', async () => {
  const { readFile } = await import('node:fs/promises')
  const release = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8'
  )
  // One owner for the release lane, and an active release is never cancelled.
  assert.match(release, /concurrency:\n\s+group: code-foundry-qualified-release-/)
  assert.match(release, /cancel-in-progress: false/)
})
