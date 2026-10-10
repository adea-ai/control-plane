import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  PiChildContinuationGrantSchema,
  piChildContinuationRequestDigest,
  assertGrantMatchesAuthority,
  assertPiChildContinuationRequest,
  assertPiChildContinuationToolCall,
  assertPiChildContinuationSnapshot,
  assertCurrentPiChildContinuation,
} from './child-continuation.ts'
import { fixture, id, createdAt, expiresAt, deadlineAt } from './child-continuation.fixture.mjs'
const rejected = 'PI_CHILD_CONTINUATION_REJECTED'

test('strict immutable grant pins original child prompt, full allocation and native request/source identities without secrets', async () => {
  const f = await fixture()
  const grant = PiChildContinuationGrantSchema.parse(f.grant)
  expect(Object.isFrozen(grant)).toBe(true)
  expect(Object.isFrozen(grant.child)).toBe(true)
  expect(assertGrantMatchesAuthority(grant, f.authority)).toEqual(grant)
  expect(assertPiChildContinuationRequest(grant, f.request)).toEqual(grant)
  expect(assertPiChildContinuationToolCall(grant, f.request, f.call)).toEqual(grant)
  expect(grant.requestDigest).toBe(
    `sha256:${createHash('sha256').update(canonicalJsonStringify(f.request)).digest('hex')}`
  )
  expect(grant.requestDigest).not.toBe(f.call.requestDigest)
  expect(JSON.stringify(grant)).not.toContain('Original child objective')
  for (const value of [
    { ...f.grant, credential: 'DO_NOT_PERSIST_SECRET' },
    { ...f.grant, child: { ...f.grant.child, prompt: 'secret' } },
    { ...f.grant, approval: { ...f.grant.approval, capability: 'secret' } },
  ])
    expect(PiChildContinuationGrantSchema.safeParse(value).success).toBe(false)
})

test('completed parent is allowed only for retained resume when BOTH exact parent records completed', async () => {
  const f = await fixture()
  expect(
    assertPiChildContinuationSnapshot(f.grant, await f.snapshot(), {
      mode: 'retain',
      now: createdAt,
    })
  ).toEqual(f.grant)
  let parent = await f.repository.getExecution(id('exe'))
  await f.lifecycle.transitionExecution({
    executionId: parent.executionId,
    expectedVersion: parent.version,
    to: 'completed',
    transitionedAt: createdAt,
    terminalResultRef: id('art'),
  })
  const partial = await f.snapshot()
  expect(() =>
    assertPiChildContinuationSnapshot(f.grant, partial, { mode: 'resume', now: createdAt })
  ).toThrow(rejected)
  let attempt = await f.repository.getAttempt(id('att'))
  await f.lifecycle.transitionAttempt({
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    to: 'completed',
    transitionedAt: createdAt,
    terminalResultRef: id('art'),
  })
  const completed = await f.snapshot()
  expect(() =>
    assertPiChildContinuationSnapshot(f.grant, completed, { mode: 'retain', now: createdAt })
  ).toThrow(rejected)
  expect(
    assertPiChildContinuationSnapshot(f.grant, completed, { mode: 'resume', now: createdAt })
  ).toEqual(f.grant)
})

for (const state of ['cancelled', 'failed', 'cancelling', 'reconciliation_required', 'timed_out'])
  test(`parent ${state} never admits historical continuation`, async () => {
    const f = await fixture()
    const execution = await f.repository.getExecution(id('exe'))
    const attempt = await f.repository.getAttempt(id('att'))
    const failure = { classification: 'runtime_error', code: 'TEST_FAILED' }
    await f.lifecycle.transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: state,
      transitionedAt: createdAt,
      ...(['failed', 'timed_out', 'reconciliation_required'].includes(state) ? { failure } : {}),
    })
    await f.lifecycle.transitionAttempt({
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      to: state,
      transitionedAt: createdAt,
      ...(['failed', 'timed_out', 'reconciliation_required'].includes(state) ? { failure } : {}),
    })
    const snapshot = await f.snapshot()
    expect(() =>
      assertPiChildContinuationSnapshot(f.grant, snapshot, { mode: 'resume', now: createdAt })
    ).toThrow(rejected)
  })

test('superseded attempts, changed full lineage/plan or journal handle deny resume', async () => {
  const f = await fixture()
  const snapshot = await f.snapshot()
  for (const value of [
    {
      ...snapshot,
      parentExecution: { ...snapshot.parentExecution, latestAttemptId: id('att', true) },
    },
    { ...snapshot, childExecution: { ...snapshot.childExecution, latestAttemptId: id('att') } },
    {
      ...snapshot,
      childExecution: { ...snapshot.childExecution, parentExecutionId: id('exe', true) },
    },
    {
      ...snapshot,
      parentPlan: { ...snapshot.parentPlan, contentDigest: `sha256:${'f'.repeat(64)}` },
    },
    { ...snapshot, childHandle: { ...snapshot.childHandle, externalSessionId: id('ses') } },
  ])
    expect(() =>
      assertPiChildContinuationSnapshot(f.grant, value, { mode: 'resume', now: createdAt })
    ).toThrow(rejected)
})

test('changed prompt, idempotency, selection, actor, allocation ceilings or reservation cannot reuse an original grant', async () => {
  const f = await fixture()
  for (const authority of [
    { ...f.authority, admission: { ...f.authority.admission, prompt: 'New objective' } },
    {
      ...f.authority,
      admission: { ...f.authority.admission, canonicalActorPrincipalId: 'actor:other' },
    },
    {
      ...f.authority,
      admission: {
        ...f.authority.admission,
        selection: { ...f.authority.admission.selection, selectionRevision: 2 },
      },
    },
    { ...f.authority, request: { ...f.authority.request, idempotencyKey: 'different-child:one' } },
    {
      ...f.authority,
      request: { ...f.authority.request, attemptBudget: { ...f.grant.budget, maximumTokens: 101 } },
    },
    {
      ...f.authority,
      request: {
        ...f.authority.request,
        attemptBudget: { ...f.grant.budget, reservationKey: 'reservation:other' },
      },
    },
  ])
    expect(() => assertGrantMatchesAuthority(f.grant, authority)).toThrow(rejected)
})

test('full request digest binds action/input/target/audit/approval audience and expiration; native source key cannot drift', async () => {
  const f = await fixture()
  for (const change of [
    { operation: 'other-child' },
    { input: { objective: 'other' } },
    { toolVersionId: id('tlv', true) },
    { audit: { ...f.request.audit, traceId: id('trc', true) } },
    { approval: { ...f.request.approval, allowedPrincipalIds: ['actor:other'] } },
    { grant: { ...f.request.grant, expiresAt: expiresAt } },
  ]) {
    expect(piChildContinuationRequestDigest({ ...f.request, ...change })).not.toBe(
      f.grant.requestDigest
    )
    expect(() => assertPiChildContinuationRequest(f.grant, { ...f.request, ...change })).toThrow(
      rejected
    )
  }
  expect(
    PiChildContinuationGrantSchema.safeParse({
      ...f.grant,
      source: { ...f.grant.source, callId: 'other' },
    }).success
  ).toBe(false)
  expect(
    PiChildContinuationGrantSchema.safeParse({ ...f.grant, expiresAt: createdAt }).success
  ).toBe(false)
})

test('succeeded canonical call must match exact projected digest, input, approval, child and session outcome', async () => {
  const f = await fixture()
  for (const call of [
    { ...f.call, status: 'executing' },
    { ...f.call, requestDigest: f.grant.requestDigest },
    { ...f.call, inputDigest: `sha256:${'f'.repeat(64)}` },
    { ...f.call, approvalPrincipalRef: 'actor:other' },
    { ...f.call, policyDecision: { ...f.call.policyDecision, effect: 'deny' } },
    {
      ...f.call,
      result: { ...f.call.result, output: { ...f.call.result.output, childAttemptId: id('att') } },
    },
    {
      ...f.call,
      result: {
        ...f.call.result,
        output: { ...f.call.result.output, externalSessionId: id('ses') },
      },
    },
  ])
    expect(() => assertPiChildContinuationToolCall(f.grant, f.request, call)).toThrow(rejected)
})

for (const fault of [
  'revoked',
  'actorActive',
  'scopeActive',
  'providerActive',
  'spendingActive',
  'authorityRevision',
  'selection',
  'budget',
  'approval',
])
  test(`mandatory current ${fault} read denies continued execution without renewing evidence`, async () => {
    const f = await fixture()
    const current = f.current()
    if (fault === 'revoked') current.revoked = true
    else if (fault.endsWith('Active')) current[fault] = false
    else if (fault === 'authorityRevision') current.authorityRevision++
    else if (fault === 'selection')
      current.selection = { ...current.selection, selectionRevision: 2 }
    else if (fault === 'budget') current.budget = { ...current.budget, maximumMicrounits: 1001 }
    else current.approval = { ...current.approval, grantRevision: 2 }
    const original = canonicalJsonStringify(f.grant)
    await expect(
      assertCurrentPiChildContinuation(
        f.grant,
        f.authority,
        { readCurrent: async () => current },
        () => createdAt
      )
    ).rejects.toThrow(rejected)
    expect(canonicalJsonStringify(f.grant)).toBe(original)
  })

test('fixed expiry is checked again after asynchronous current read and missing host readers never qualify', async () => {
  const f = await fixture()
  const original = canonicalJsonStringify(f.grant)
  expect(
    await assertCurrentPiChildContinuation(
      f.grant,
      f.authority,
      { readCurrent: async () => f.current() },
      () => createdAt
    )
  ).toEqual(f.grant)
  await expect(
    assertCurrentPiChildContinuation(f.grant, f.authority, {}, () => createdAt)
  ).rejects.toThrow(rejected)
  let now = createdAt
  await expect(
    assertCurrentPiChildContinuation(
      f.grant,
      f.authority,
      {
        readCurrent: async () => {
          now = expiresAt
          return f.current()
        },
      },
      () => now
    )
  ).rejects.toThrow(rejected)
  expect(() =>
    assertPiChildContinuationSnapshot(f.grant, {}, { mode: 'resume', now: expiresAt })
  ).toThrow(rejected)
  expect(canonicalJsonStringify(f.grant)).toBe(original)
})

for (const state of ['completed', 'cancelled', 'failed', 'cancelling'])
  test(`child ${state} cannot use continuation to resurrect a terminal or cancelling attempt`, async () => {
    const f = await fixture()
    const execution = await f.repository.getExecution(id('exe', true))
    const attempt = await f.repository.getAttempt(id('att', true))
    const details =
      state === 'completed'
        ? { terminalResultRef: id('art', true) }
        : state === 'failed'
          ? { failure: { classification: 'runtime_error', code: 'TEST_FAILED' } }
          : {}
    await f.lifecycle.transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: state,
      transitionedAt: createdAt,
      ...details,
    })
    await f.lifecycle.transitionAttempt({
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      to: state,
      transitionedAt: createdAt,
      ...details,
    })
    const snapshot = await f.snapshot()
    expect(() =>
      assertPiChildContinuationSnapshot(f.grant, snapshot, { mode: 'resume', now: createdAt })
    ).toThrow(rejected)
  })

test('a changed original child authority during the current-reader await is rejected after the read', async () => {
  const f = await fixture()
  await expect(
    assertCurrentPiChildContinuation(
      f.grant,
      f.authority,
      {
        readCurrent: async () => {
          f.authority.admission.prompt = 'changed during await'
          return f.current()
        },
      },
      () => createdAt
    )
  ).rejects.toThrow(rejected)
})

test('request key ordering is harmless, while current funding cannot renew fixed grant expiry', async () => {
  const f = await fixture()
  const reordered = Object.fromEntries(Object.entries(f.request).toReversed())
  expect(piChildContinuationRequestDigest(reordered)).toBe(f.grant.requestDigest)
  const before = canonicalJsonStringify(f.grant)
  let reads = 0
  await expect(
    assertCurrentPiChildContinuation(
      f.grant,
      f.authority,
      {
        readCurrent: async () => {
          reads++
          return f.current()
        },
      },
      () => expiresAt
    )
  ).rejects.toThrow(rejected)
  expect(reads).toBe(0)
  const current = { ...f.current(), expiresAt: deadlineAt }
  await expect(
    assertCurrentPiChildContinuation(
      f.grant,
      f.authority,
      { readCurrent: async () => current },
      () => createdAt
    )
  ).rejects.toThrow(rejected)
  expect(canonicalJsonStringify(f.grant)).toBe(before)
})

for (const row of ['parentExecution', 'parentAttempt', 'childExecution', 'childAttempt'])
  test(`original ${row} deadline bounds grant even after parent completion`, async () => {
    const f = await fixture()
    const snapshot = await f.snapshot()
    const tooShort = '2026-10-08T00:05:00.000Z'
    snapshot[row] = { ...snapshot[row], deadlineAt: tooShort }
    expect(() =>
      assertPiChildContinuationSnapshot(f.grant, snapshot, { mode: 'resume', now: createdAt })
    ).toThrow(rejected)
    const bounded = { ...f.grant, expiresAt: tooShort }
    expect(
      assertPiChildContinuationSnapshot(bounded, snapshot, { mode: 'resume', now: createdAt })
    ).toEqual(bounded)
    snapshot.parentExecution = {
      ...snapshot.parentExecution,
      state: 'completed',
      terminalAt: createdAt,
      terminalResultRef: id('art'),
    }
    snapshot.parentAttempt = {
      ...snapshot.parentAttempt,
      state: 'completed',
      terminalAt: createdAt,
      terminalResultRef: id('art'),
    }
    expect(() =>
      assertPiChildContinuationSnapshot(f.grant, snapshot, { mode: 'resume', now: createdAt })
    ).toThrow(rejected)
  })

test('canonical parent runtime session must match original native source when retained', async () => {
  const f = await fixture()
  const snapshot = await f.snapshot()
  snapshot.parentAttempt = {
    ...snapshot.parentAttempt,
    runtime: { externalSessionId: id('ses', true) },
  }
  expect(() =>
    assertPiChildContinuationSnapshot(f.grant, snapshot, { mode: 'resume', now: createdAt })
  ).toThrow(rejected)
})

for (const [part, row] of [
  ['parent', 'parentAttempt'],
  ['child', 'childAttempt'],
])
  test(`${part} runtime metadata cannot appear after original absent admission`, async () => {
    const f = await fixture()
    const snapshot = await f.snapshot()
    snapshot[row] = { ...snapshot[row], runtime: { runtimeConnectionId: id('rtc') } }
    expect(() =>
      assertPiChildContinuationSnapshot(f.grant, snapshot, { mode: 'resume', now: createdAt })
    ).toThrow(rejected)
  })

for (const [part, row] of [
  ['parent', 'parentAttempt'],
  ['child', 'childAttempt'],
])
  test(`${part} pins complete runtime connection, node and routing metadata without replacement`, async () => {
    const f = await fixture()
    const snapshot = await f.snapshot()
    const runtime = {
      runtimeDefinitionId: id('rtd'),
      runtimeNodeRefId: id('rnr'),
      runtimeConnectionId: id('rtc'),
      externalSessionId:
        part === 'parent'
          ? f.grant.source.externalSessionId
          : f.grant.child.handle.externalSessionId,
      routingDecision: {
        routingVersion: 1,
        policy: { policyId: 'policy:original', version: 1, digest: `sha256:${'a'.repeat(64)}` },
        evaluatedAt: snapshot[row].queuedAt,
        inputDigest: `sha256:${'b'.repeat(64)}`,
        decisionDigest: `sha256:${'c'.repeat(64)}`,
        selectedRank: 1,
        candidateCount: 2,
        reasonCodes: ['QUALIFIED'],
      },
    }
    snapshot[row] = { ...snapshot[row], runtime }
    const grant = { ...f.grant, [part]: { ...f.grant[part], runtime } }
    const parsed = assertPiChildContinuationSnapshot(grant, snapshot, {
      mode: 'resume',
      now: createdAt,
    })
    expect(parsed).toEqual(grant)
    expect(Object.isFrozen(parsed[part].runtime)).toBe(true)
    expect(Object.isFrozen(parsed[part].runtime.routingDecision.policy)).toBe(true)
    expect(Object.isFrozen(parsed[part].runtime.routingDecision.reasonCodes)).toBe(true)
    for (const changed of [
      { ...runtime, runtimeDefinitionId: id('rtd', true) },
      { ...runtime, runtimeConnectionId: id('rtc', true) },
      { ...runtime, runtimeNodeRefId: id('rnr', true) },
      {
        ...runtime,
        routingDecision: { ...runtime.routingDecision, decisionDigest: `sha256:${'d'.repeat(64)}` },
      },
      { ...runtime, routingDecision: { ...runtime.routingDecision, reasonCodes: ['REPLACED'] } },
      {
        ...runtime,
        routingDecision: {
          ...runtime.routingDecision,
          policy: { ...runtime.routingDecision.policy, version: 2 },
        },
      },
      undefined,
    ]) {
      const drift = { ...snapshot, [row]: { ...snapshot[row], runtime: changed } }
      expect(() =>
        assertPiChildContinuationSnapshot(grant, drift, { mode: 'resume', now: createdAt })
      ).toThrow(rejected)
    }
    expect(
      PiChildContinuationGrantSchema.safeParse({
        ...grant,
        [part]: { ...grant[part], runtime: undefined },
      }).success
    ).toBe(false)
  })
