import { expect, test } from 'bun:test'
import {
  assertChildAdmissionReceiptMatches,
  ChildAdmissionReceiptSchema,
  childAdmissionRequestDigest,
} from './child-admission.ts'

const digest = (value) => `sha256:${value.repeat(64)}`
const request = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  parentIntentId: 'intent:lead-01',
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  parentAttemptId: 'att_01JABCDEF0123456789ABCDEFG',
  parentExecutionVersion: 3,
  parentPlan: {
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: digest('a'),
    schemaVersion: 2,
  },
  admittedToolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  childRequestId: 'req_01JBBCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
  childDispatch: {
    delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
    childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
    runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
    dispatchedAt: '2026-10-09T12:00:05.000Z',
  },
  childPlan: {
    executionPlanId: 'pln_01JBBCDEF0123456789ABCDEFG',
    contentDigest: digest('b'),
    schemaVersion: 2,
  },
  role: 'researcher',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  originalActorPrincipalId: 'usr_01JABCDEF0123456789ABCDEFG',
  childRequestDigest: digest('c'),
  acceptedAt: '2026-10-09T12:00:00.000Z',
}
const receipt = {
  schemaVersion: 'pi-child-admission/v1',
  ...request,
  authorityRevision: 19,
  productRevision: 'product:rev-42',
  productReaderPrincipalId: 'svc_product-reader',
  selectionRef: 'selection:workspace-child',
  selectionRevision: 7,
  expiresAt: '2026-10-09T12:00:30.000Z',
}

test('child admission receipt binds exact actor, parent attempt, plans, and request digest', () => {
  expect(assertChildAdmissionReceiptMatches(request, receipt, '2026-10-09T12:00:10.000Z')).toEqual(
    receipt
  )
  expect(childAdmissionRequestDigest(request)).toMatch(/^sha256:[a-f0-9]{64}$/)
})

for (const [name, altered] of [
  ['parent intent', { parentIntentId: 'intent:another-parent' }],
  ['actor', { originalActorPrincipalId: 'usr_01JBBCDEF0123456789ABCDEFG' }],
  ['parent attempt', { parentAttemptId: 'att_01JBBCDEF0123456789ABCDEFG' }],
  ['child attempt', { childAttemptId: 'att_01JDBCDEF0123456789ABCDEFG' }],
  [
    'dispatch connection',
    {
      childDispatch: {
        ...request.childDispatch,
        runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
      },
    },
  ],
  ['parent plan', { parentPlan: { ...request.parentPlan, contentDigest: digest('d') } }],
  ['child plan', { childPlan: { ...request.childPlan, contentDigest: digest('e') } }],
  ['request digest', { childRequestDigest: digest('f') }],
]) {
  test(`child admission receipt rejects a changed ${name} pin`, () => {
    expect(() =>
      assertChildAdmissionReceiptMatches(
        request,
        { ...receipt, ...altered },
        '2026-10-09T12:00:10.000Z'
      )
    ).toThrow('CHILD_ADMISSION_RECEIPT_MISMATCH')
  })
}

test('child admission receipt expires against the current check time', () => {
  expect(() =>
    assertChildAdmissionReceiptMatches(request, receipt, '2026-10-09T12:00:30.000Z')
  ).toThrow('CHILD_ADMISSION_RECEIPT_MISMATCH')
})

test('child admission receipt rejects secret-bearing or unrecognized fields', () => {
  expect(
    ChildAdmissionReceiptSchema.safeParse({ ...receipt, accessToken: 'must-not-be-retained' })
      .success
  ).toBe(false)
})
