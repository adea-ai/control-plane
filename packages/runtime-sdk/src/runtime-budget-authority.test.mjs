import { expect, test } from 'bun:test'
import { RuntimeStartRequestSchema } from './adapter.ts'

const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const executionPlan = {
  schemaVersion: 1,
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  runtimeRequirements: [],
  correlation: { workspaceId },
  constraints: {
    limits: {
      budget: { currency: 'USD', maximumMicrounits: 10 },
      tokens: { maximumTotal: 20 },
    },
  },
}
const attemptBudget = {
  schemaVersion: 1,
  workspaceId,
  executionId,
  attemptId,
  executionPlanId: executionPlan.executionPlanId,
  executionPlanDigest: executionPlan.contentDigest,
  reservationKey: `runtime-attempt:${attemptId}`,
  currency: 'USD',
  maximumMicrounits: 1,
  maximumTokens: 2,
}

function request() {
  return { attemptId, executionId, idempotencyKey: 'budget:start', executionPlan, attemptBudget }
}

test('runtime start retains a frozen reservation without rewriting the immutable plan', () => {
  const parsed = RuntimeStartRequestSchema.parse(request())
  expect(parsed.attemptBudget).toEqual(attemptBudget)
  expect(Object.isFrozen(parsed.attemptBudget)).toBe(true)
  expect(parsed.executionPlan).toEqual(executionPlan)
  expect(parsed.executionPlan.constraints.limits.tokens.maximumTotal).toBe(20)
})

test('runtime reservation replay cannot mutate the caller or previously parsed ceiling', () => {
  const input = { ...request(), attemptBudget: { ...attemptBudget } }
  const parsed = RuntimeStartRequestSchema.parse(input)
  input.attemptBudget.maximumTokens = 20
  expect(parsed.attemptBudget.maximumTokens).toBe(2)
})

for (const change of [
  { schemaVersion: 2 },
  { workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' },
  { executionId: 'exe_01JBBCDEF0123456789ABCDEFG' },
  { attemptId: 'att_01JBBCDEF0123456789ABCDEFG' },
  { executionPlanId: 'pln_01JBBCDEF0123456789ABCDEFG' },
  { executionPlanDigest: `sha256:${'b'.repeat(64)}` },
  { reservationKey: 'foreign-reservation' },
  { currency: 'EUR' },
  { maximumMicrounits: 11 },
  { maximumTokens: 21 },
  { maximumMicrounits: -1 },
  { maximumTokens: 1.5 },
  { maximumTokens: Number.MAX_SAFE_INTEGER + 1 },
  { unrelated: true },
]) {
  test(`runtime start rejects foreign or unsafe authority: ${JSON.stringify(change)}`, () => {
    expect(
      RuntimeStartRequestSchema.safeParse({
        ...request(),
        attemptBudget: { ...attemptBudget, ...change },
      }).success
    ).toBe(false)
  })
}

test('runtime authority needs explicit execution identity and the pinned plan allowance', () => {
  const { executionId: _executionId, ...missingIdentity } = request()
  expect(RuntimeStartRequestSchema.safeParse(missingIdentity).success).toBe(false)
  for (const plan of [
    { ...executionPlan, correlation: undefined },
    { ...executionPlan, constraints: undefined },
    {
      ...executionPlan,
      constraints: { limits: { budget: { currency: 'USD', maximumMicrounits: 1 } } },
    },
  ])
    expect(RuntimeStartRequestSchema.safeParse({ ...request(), executionPlan: plan }).success).toBe(
      false
    )
})

test('legacy runtime starts retain their original request shape', () => {
  const legacy = { attemptId, idempotencyKey: 'legacy:start', executionPlan }
  expect(RuntimeStartRequestSchema.parse(legacy)).toEqual(legacy)
})
