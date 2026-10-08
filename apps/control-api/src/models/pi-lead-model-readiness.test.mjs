import { expect, test } from 'bun:test'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { ManagedModelGateway, ModelRouteRegistry } from '@control-plane/model-gateway'
import { createPiLeadModelAdmissionReadiness } from './pi-lead-model-readiness.ts'

const plan = createExecutionPlanTestFixture()
const requirement = plan.constraints.models[0]
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}
const selection = {
  schemaVersion: 'model-selection/v1',
  selectionRef: `msel_${'2'.repeat(32)}`,
  selectionRevision: 1,
  workspaceId: plan.correlation.workspaceId,
  connectionRef: `mconn_${'1'.repeat(32)}`,
  connectionRevision: 1,
  credentialRef: 'crd_01JABCDEF0123456789ABCDEFG',
  credentialRevision: 1,
  provider: 'openai',
  providerModel: 'gpt-5',
  accountRef: 'account:one',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  ...target,
  workspaceGrant: { grantRef: 'grant:one', revision: 1 },
  configurationRevision: 1,
}
const input = {
  evidence: {
    workspaceId: selection.workspaceId,
    selectionRef: selection.selectionRef,
    selectionRevision: 1,
    allowedPrincipalIds: ['svc_transport'],
    canonicalActorPrincipalId: 'svc_actor',
  },
  plan,
  ids: {
    requestId: plan.correlation.requestId,
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  },
  actorPrincipalId: 'svc_actor',
}
function fixture() {
  let ready = true
  let policyAllowed = true
  let providerCalls = 0
  let policyChecks = 0
  let requestPatch = {}
  const selections = {
    resolveSelection: async (reference) => {
      expect(reference.selectionRef).toBe(selection.selectionRef)
      return structuredClone(selection)
    },
    assertReady: async () => {
      if (!ready) throw new Error('revoked private detail')
    },
  }
  const registry = new ModelRouteRegistry()
  registry.register({
    deploymentId: 'selected-route',
    alias: requirement.alias,
    provider: 'openai',
    providerModel: 'gpt-5',
    providerClass: requirement.providerPolicy.allowedClasses[0],
    dataResidency: requirement.providerPolicy.dataResidency[0],
    capabilities: requirement.requiredCapabilities,
    credentialRef: `vault://${selection.credentialRef}/1`,
    selection,
    adapterRef: 'native-pi',
    enabled: true,
    fundingSource: 'byo_api',
    maxContextTokens: 128000,
    maxOutputTokens: 1000,
    costClass: 'low',
    priority: 1,
    requiredEntitlements: [],
  })
  const gateway = new ManagedModelGateway({
    registry,
    selectionService: selections,
    adapters: new Map([
      [
        'native-pi',
        {
          complete: async () => {
            providerCalls++
            throw new Error('must not invoke')
          },
          stream: async function* () {
            providerCalls++
            yield { delta: 'must not invoke' }
          },
          health: async () => ({ healthy: true, checkedAt: '2026-10-08T12:00:00.000Z' }),
          cancel: async () => false,
        },
      ],
    ]),
    decisionPoint: {
      authorize: async (query) => {
        policyChecks++
        return {
          effect: policyAllowed ? 'allow' : 'deny',
          decisionId: `sha256:${'b'.repeat(64)}`,
          reasonCode: 'FIXTURE',
          policySnapshot: query.policySnapshot,
          evaluatedAt: query.context.requestedAt,
        }
      },
    },
  })
  const callback = createPiLeadModelAdmissionReadiness({
    selections,
    gateway,
    target,
    buildRequest: async (admission, current) => ({
      modelCallId: 'mdc_01JABCDEF0123456789ABCDEFG',
      requestId: admission.ids.requestId,
      executionId: admission.ids.executionId,
      attemptId: admission.ids.attemptId,
      workspaceId: current.workspaceId,
      principalRef: 'svc_runtime',
      alias: requirement.alias,
      messages: [{ role: 'user', content: 'fixture prompt' }],
      settings: { maxOutputTokens: 1, temperature: 0, timeoutMs: 100 },
      requirement,
      policySnapshot: admission.plan.policySnapshot,
      traceId: 'trc_01JABCDEF0123456789ABCDEFG',
      fundingSource: current.fundingSource,
      selection: current,
      routing: { entitlements: [], maxCostClass: 'premium', estimatedInputTokens: 1 },
      ...requestPatch,
    }),
  })
  return {
    callback,
    reads: () => policyChecks,
    sends: () => providerCalls,
    setReady: (value) => {
      ready = value
    },
    setPolicy: (value) => {
      policyAllowed = value
    },
    patch: (value) => {
      requestPatch = value
    },
    registry,
  }
}
test('pre-admission callback reuses routing/policy checks without provider/lease/budget activity', async () => {
  const f = fixture()
  await f.callback(input)
  expect(f.reads()).toBe(1)
  expect(f.sends()).toBe(0)
  f.setPolicy(false)
  await expect(f.callback(input)).rejects.toThrow()
  expect(f.sends()).toBe(0)
})
test('changed actor, selection, policy, plan allowance or request IDs deny before routing', async () => {
  const f = fixture()
  await expect(f.callback({ ...input, actorPrincipalId: 'svc_foreign' })).rejects.toThrow(
    'PROVIDER_POLICY_DENIED'
  )
  for (const patch of [
    { selection: { ...selection, accountRef: 'account:foreign' } },
    { attemptId: 'att_01JABCDEF0123456789ABCDEFH' },
    { policySnapshot: { ...plan.policySnapshot, digest: `sha256:${'e'.repeat(64)}` } },
    {
      settings: {
        maxOutputTokens: plan.constraints.limits.tokens.maximumTotal + 1,
        temperature: 0,
        timeoutMs: 100,
      },
    },
    {
      requirement: {
        ...requirement,
        providerPolicy: { ...requirement.providerPolicy, deniedProviders: [] },
        fallback: 'none',
      },
    },
  ]) {
    f.patch(patch)
    await expect(f.callback(input)).rejects.toThrow()
  }
  expect(f.reads()).toBe(0)
  expect(f.sends()).toBe(0)
})
test('unknown or revoked readiness denies admission before policy evaluation', async () => {
  const f = fixture()
  f.setReady(false)
  await expect(f.callback(input)).rejects.toThrow()
  expect(f.reads()).toBe(0)
  expect(f.sends()).toBe(0)
})

test('pre-admission unexpected source and schema failures expose only bounded readiness reasons', async () => {
  const f = fixture()
  f.setReady(false)
  await expect(f.callback(input)).rejects.toThrow('READINESS_UNAVAILABLE')
  f.setReady(true)
  f.patch({ credential: 'private-canary' })
  await expect(f.callback(input)).rejects.toThrow('READINESS_UNAVAILABLE')
  expect(f.sends()).toBe(0)
})
