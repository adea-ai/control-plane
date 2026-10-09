import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'

const at = '2026-10-08T00:00:00.000Z'
export function fixture(directory, overrides = {}) {
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const request = {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'message:one',
    executionPlan: plan,
    attemptBudget: {
      schemaVersion: 1,
      workspaceId: plan.correlation.workspaceId,
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: 'runtime-attempt:att_01JABCDEF0123456789ABCDEFG',
      currency: 'USD',
      maximumMicrounits: 10000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-durable-admission/v1',
    prompt: 'hello',
    selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    authority: {
      revision: 1,
      principalRef: 'principal:one',
      scopeRef: 'scope:one',
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
  }
  const options = {
    directory,
    now: () => at,
    resolveAdmission: async () => admission,
    assertAuthority: async () => {},
    resolveProvider: async () => ({
      selectionRef: admission.selection.selectionRef,
      selectionRevision: 1,
      workspaceId: plan.correlation.workspaceId,
      provider: 'test',
      providerModel: 'mock',
      location: 'remote_host',
      harness: 'pi_durable',
      harnessVersion: '1.1.0',
      providerBinding: 'pi_durable_models',
      withModels: async (use) => use({}),
    }),
    authorizeInference: async () => ({
      maxOutputTokens: 10,
      maximumInputTokens: 64,
      assertActive: async () => {},
    }),
    settleUsage: async (_authority, _key, usage) => usage,
    reconcileInference: async () => 'unresolved',
    engineFactory: async () => ({
      run: async () => ({
        text: 'answer',
        submissionId: 'submission',
        usage: { inputTokens: 3, outputTokens: 4, costUsd: '0.000007', durationMs: 2 },
        inferences: [
          {
            inferenceId: 'pi-generation:1',
            usage: {
              inputTokens: 3,
              outputTokens: 4,
              durationMs: 2,
              cachedInputTokens: 0,
              reasoningTokens: 0,
            },
          },
        ],
      }),
      close: async () => {},
      cancel: async () => {},
    }),
    ...overrides,
  }
  return { options, request, admission }
}
