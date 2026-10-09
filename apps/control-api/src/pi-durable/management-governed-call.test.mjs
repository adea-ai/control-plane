import { expect, test } from 'bun:test'
import {
  createPiDurableGovernedManagementCall,
  piDurableManagementRequestDigest,
} from './management-governed-call.ts'
import { managementCanonicalRequestDigest } from './management-decision-issuer.ts'

const WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'
const PRINCIPAL = 'user:0f3a2e1c-0000-4000-8000-0000000000bb'

const approval = {
  allowedPrincipalIds: [PRINCIPAL],
  expiresAt: '2026-10-09T12:02:00.000Z',
  interactionId: 'int_01JABCDEF0123456789ABCDEFG',
  requestedAt: '2026-10-09T11:59:00.000Z',
}
const baseRequest = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  audit: { principalRef: PRINCIPAL, traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  grant: {
    operations: ['project.update'],
    profileId: 'prf_01JABCDEF0123456789ABCDEFG',
    toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
    toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
    workspaceId: WORKSPACE,
  },
  idempotencyKey: 'lead:management:project.update:1',
  input: { name: 'Renamed' },
  operation: 'project.update',
  policySnapshotRef: 'policy://fixture',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  requestedAt: '2026-10-09T12:00:00.000Z',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
  toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
  toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
  workspaceId: WORKSPACE,
}

function harness(options = {}) {
  const boundaries = []
  const issued = []
  const calls = []
  let counter = 0
  const caller = createPiDurableGovernedManagementCall({
    authority: {
      async assertCurrent(request, boundary) {
        boundaries.push(boundary)
        if (options.failBoundary === boundary) throw new Error('TEST_AUTHORITY_DENIED')
      },
    },
    async issue({ request, targetId }) {
      counter += 1
      issued.push({ request, targetId })
      const digest = options.wrongDigest
        ? `sha256:${'0'.repeat(64)}`
        : piDurableManagementRequestDigest(request)
      return {
        canonicalRequestDigest: digest,
        decision: `header.${counter}.signature`,
        decisionId: `decision-${counter}`,
        expiresAt: '2026-10-09T12:02:00.000Z',
      }
    },
    async callAdea(input) {
      calls.push(input)
      if (options.transportThrows) throw new Error('TEST_TRANSPORT_UNKNOWN')
      return options.refusal ?? { ok: true, value: { id: 'prj_01JABCDEF0123456789ABCDEFG' } }
    },
    resolveTargetId: () => 'prj_01JABCDEF0123456789ABCDEFG',
  })
  return { boundaries, caller, calls, issued }
}

test('binds the exact immutable request, validates every boundary, and calls Adea exactly once', async () => {
  const request = { ...baseRequest, approval }
  const run = harness()
  const outcome = await run.caller.execute(request)
  expect(outcome).toEqual({ state: 'succeeded', value: { id: 'prj_01JABCDEF0123456789ABCDEFG' } })
  expect(run.boundaries).toEqual(['admission', 'approval', 'effect'])
  expect(run.issued).toHaveLength(1)
  expect(run.issued[0].request).toEqual(request)
  expect(run.issued[0].request).not.toBe(request)
  expect(piDurableManagementRequestDigest(request)).toBe(managementCanonicalRequestDigest(request))
  expect(run.issued[0].targetId).toBe('prj_01JABCDEF0123456789ABCDEFG')
  expect(run.calls).toHaveLength(1)
  expect(run.calls[0].canonicalRequest).toEqual(request)
  expect(run.calls[0].decision).toBe('header.1.signature')
  expect(run.calls[0].operation).toBe('project.update')
  expect(run.calls[0].workspaceId).toBe(WORKSPACE)
  expect(run.calls[0].input).toEqual({ name: 'Renamed' })
})

test('repeated validation across calls never consumes approval or mints a grant', async () => {
  const request = { ...baseRequest, approval }
  const run = harness()
  await run.caller.execute(request)
  await run.caller.execute(request)
  expect(run.boundaries).toEqual([
    'admission',
    'approval',
    'effect',
    'admission',
    'approval',
    'effect',
  ])
  expect(run.calls).toHaveLength(2)
  expect(run.calls[0].decision).not.toBe(run.calls[1].decision)
})

test('skips the approval boundary when the retained request has no approval', async () => {
  const run = harness()
  await run.caller.execute(baseRequest)
  expect(run.boundaries).toEqual(['admission', 'effect'])
})

test('a decision that does not bind the exact request digest never reaches Adea', async () => {
  const run = harness({ wrongDigest: true })
  expect(await run.caller.execute(baseRequest)).toEqual({
    code: 'authority_binding_mismatch',
    state: 'refused',
  })
  expect(run.calls).toHaveLength(0)
})

test('an authority failure refuses before the decision or any Adea call', async () => {
  const run = harness({ failBoundary: 'admission' })
  expect(await run.caller.execute(baseRequest)).toEqual({
    code: 'authority_unavailable',
    state: 'refused',
  })
  expect(run.issued).toHaveLength(0)
  expect(run.calls).toHaveLength(0)
})

test('an ambiguous effect is never resent and never mints a fresh decision', async () => {
  const run = harness({ transportThrows: true })
  const first = await run.caller.execute(baseRequest)
  expect(first).toEqual({
    code: 'PI_MANAGEMENT_EFFECT_UNKNOWN',
    state: 'reconciliation_required',
  })
  expect(run.calls).toHaveLength(1)
  expect(run.issued).toHaveLength(1)
  const second = await run.caller.execute(baseRequest)
  expect(second).toEqual(first)
  expect(run.calls).toHaveLength(1)
  expect(run.issued).toHaveLength(1)
})

test('maps a typed Adea refusal without masking the reason', async () => {
  const run = harness({
    refusal: {
      code: 'LEAD_MANAGEMENT_REFUSED',
      ok: false,
      operation: 'project.update',
      reason: 'authority_replay',
    },
  })
  expect(await run.caller.execute(baseRequest)).toEqual({
    code: 'LEAD_MANAGEMENT_REFUSED',
    reason: 'authority_replay',
    state: 'refused',
  })
})

test('rejects a malformed retained request before any authority or transport call', async () => {
  const run = harness()
  await expect(run.caller.execute({ operation: 'project.update' })).rejects.toThrow(
    'PI_MANAGEMENT_CALL_INVALID'
  )
  expect(run.boundaries).toEqual([])
  expect(run.calls).toHaveLength(0)
})
