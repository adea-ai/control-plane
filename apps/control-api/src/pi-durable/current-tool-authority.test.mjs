import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  InMemoryToolCallRepository,
  InMemoryToolRateLimiter,
  InMemoryToolRegistryRepository,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
  ToolGateway,
  ToolRegistry,
  toolInputDigest,
} from '@control-plane/tool-execution'
import {
  PiDurableEffectGate,
  SqliteDurableEffectGateStore,
} from '@control-plane/pi-durable-adapter'
import { fixture, at, expiry } from '../models/canonical-model-host-fixtures.mjs'
import { createPiDurableCurrentToolAuthority } from './current-tool-authority.ts'

const ids = {
  toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
  toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  interactionId: 'int_01JABCDEF0123456789ABCDEFG',
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
}
const toolExecutor = { type: 'internal', reference: 'fixture.executor' }
const input = { action: 'read', target: 'artifact://workspace/document-1' }

async function setup({
  approval,
  state = 'executing',
  grantExpiresAt = expiry,
  intentExpiresAt = expiry,
  requestedAt = at,
  currentTime = at,
} = {}) {
  const f = await fixture()
  const intent = { ...f.intent, expiresAt: intentExpiresAt }
  let helperTime = currentTime
  const request = {
    ...ids,
    executionId: intent.executionId,
    attemptId: intent.attemptId,
    workspaceId: intent.workspaceId,
    profileId: f.plan.profile.profileId,
    operation: 'documents.read',
    input: structuredClone(input),
    grant: {
      workspaceId: f.intent.workspaceId,
      profileId: f.plan.profile.profileId,
      toolDefinitionId: ids.toolDefinitionId,
      toolVersionId: ids.toolVersionId,
      operations: ['documents.read'],
      expiresAt: grantExpiresAt,
    },
    audit: { principalRef: f.intent.canonicalActorPrincipalId, traceId: ids.traceId },
    idempotencyKey: 'pi-tool-call:one',
    requestedAt,
    policySnapshotRef: 'policy://fixture/tool-policy',
    ...(approval ? { approval } : {}),
  }
  let interaction = approval
    ? {
        interactionId: approval.interactionId,
        executionId: request.executionId,
        attemptId: request.attemptId,
        kind: 'approval',
        prompt: {
          title: `Approve ${request.operation}`,
          detailsReference: `artifact://tool-call/${request.toolCallId}`,
        },
        allowedActions: ['approve', 'deny'],
        allowedPrincipalIds: [...approval.allowedPrincipalIds],
        state: 'responded',
        version: 2,
        requestedAt: approval.requestedAt,
        expiresAt: approval.expiresAt,
        response: {
          responseId: ids.commandId,
          action: 'approve',
          respondingPrincipalId: approval.allowedPrincipalIds[0],
          respondedAt: approval.requestedAt,
        },
      }
    : undefined
  const repository = {
    get: async (interactionId) =>
      interaction?.interactionId === interactionId ? structuredClone(interaction) : undefined,
  }
  let call = {
    toolCallId: request.toolCallId,
    requestDigest: `sha256:${'a'.repeat(64)}`,
    executionId: request.executionId,
    attemptId: request.attemptId,
    workspaceId: request.workspaceId,
    profileId: request.profileId,
    principalRef: request.audit.principalRef,
    toolDefinitionId: request.toolDefinitionId,
    toolVersionId: request.toolVersionId,
    operation: request.operation,
    inputDigest: toolInputDigest(request.input),
    policySnapshotRef: request.policySnapshotRef,
    ...(approval ? { approvalInteractionId: approval.interactionId } : {}),
    ...(approval ? { approvalPrincipalRef: approval.allowedPrincipalIds[0] } : {}),
    ...(approval ? { policyDecision: { requiresApproval: true } } : {}),
    executor: toolExecutor,
    idempotencyKey: request.idempotencyKey,
    status: state,
    revision: 2,
    requestedAt: request.requestedAt,
    ...(state === 'executing' || state === 'succeeded' ? { startedAt: at } : {}),
    history: [
      { status: 'requested', at },
      { status: state, at },
    ],
  }
  const marker = {
    state: 'ready',
    actorPrincipalId: 'svc_transport',
    workspaceId: intent.workspaceId,
    intent: structuredClone(intent),
    planPin: {
      executionPlanId: f.plan.executionPlanId,
      contentDigest: f.plan.contentDigest,
      schemaVersion: f.plan.schemaVersion,
    },
  }
  const service = {
    gateway: {
      prepare: async (gatewayRequest) => ({
        request: gatewayRequest,
        version: {
          toolDefinitionId: ids.toolDefinitionId,
          toolVersionId: ids.toolVersionId,
          executor: toolExecutor,
        },
        operation: { name: request.operation, approvalMode: 'never' },
        executor: async () => ({ output: { ok: true } }),
      }),
    },
    calls: { get: async (toolCallId) => (toolCallId === call.toolCallId ? call : undefined) },
    approvals: { repository },
  }
  const createHelper = (boundService = service) =>
    createPiDurableCurrentToolAuthority({
      currentExecutionAuthority: f.host,
      intents: {
        getByAttempt: async (attemptId) =>
          attemptId === intent.attemptId ? structuredClone(intent) : undefined,
        marker: () => structuredClone(marker),
      },
      executions: f.executions,
      plans: f.hostOptions.plans,
      service: boundService,
      interactions: repository,
      now: () => helperTime,
    })
  const helper = createHelper()
  return {
    f,
    request,
    helper,
    createHelper,
    repository,
    getNow: () => currentTime,
    call,
    getInteraction() {
      return structuredClone(interaction)
    },
    setInteraction(value) {
      interaction = structuredClone(value)
    },
    setNow(value) {
      helperTime = value
    },
    setCall(value) {
      call = value
    },
  }
}

test('authority is void-only and validates retained sender, execution, plan, scope and tool call', async () => {
  const f = await setup()
  for (const boundary of ['admission', 'effect', 'publication'])
    expect(await f.helper.assertCurrent(f.request, boundary)).toBeUndefined()
  expect(f.request.audit.principalRef).toBe(f.f.intent.canonicalActorPrincipalId)
  expect(f.f.productInputs.at(-1).principalId).toBe('svc_transport')

  for (const changed of [
    { workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' },
    { executionId: 'exe_01JBBCDEF0123456789ABCDEFG' },
    { attemptId: 'att_01JBBCDEF0123456789ABCDEFG' },
    { profileId: 'prf_01JBBCDEF0123456789ABCDEFG' },
    { audit: { ...f.request.audit, principalRef: 'actor:forged' } },
    { operation: 'documents.delete' },
    { input: { ...f.request.input, target: 'artifact://other-workspace/private' } },
    {
      grant: {
        ...f.request.grant,
        workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG',
      },
    },
  ]) {
    await expect(
      f.helper.assertCurrent({ ...f.request, ...changed }, 'effect')
    ).rejects.toMatchObject({ code: 'PI_TOOL_AUTHORITY_REJECTED' })
  }
})

test('current product or scope revocation denies every guarded boundary', async () => {
  const f = await setup()
  f.f.setScope(false)
  for (const boundary of ['admission', 'effect', 'publication'])
    await expect(f.helper.assertCurrent(f.request, boundary)).rejects.toMatchObject({
      code: 'PI_TOOL_AUTHORITY_REJECTED',
    })
})

test('current actor or service audience revocation denies the original retained tool call', async () => {
  for (const change of [
    { canonicalActorPrincipalId: 'actor:replaced' },
    { allowedPrincipalIds: ['svc_other'] },
  ]) {
    const f = await setup()
    f.f.setCurrent({ ...f.f.intent, ...change })
    await expect(f.helper.assertCurrent(f.request, 'admission')).rejects.toMatchObject({
      code: 'PI_TOOL_AUTHORITY_REJECTED',
    })
  }
})

test('approval guard reads only the retained interaction and binds its audience and response', async () => {
  const approval = {
    interactionId: ids.interactionId,
    allowedPrincipalIds: ['user:11111111-1111-4111-8111-111111111111'],
    requestedAt: at,
    expiresAt: expiry,
  }
  const f = await setup({ approval })
  expect(await f.helper.assertCurrent(f.request, 'approval')).toBeUndefined()
  expect(await f.helper.assertCurrent(f.request, 'effect')).toBeUndefined()

  await expect(
    f.helper.assertCurrent(
      {
        ...f.request,
        approval: {
          ...approval,
          allowedPrincipalIds: ['user:22222222-2222-4222-8222-222222222222'],
        },
      },
      'approval'
    )
  ).rejects.toMatchObject({ code: 'PI_TOOL_AUTHORITY_REJECTED' })
  await expect(
    f.helper.assertCurrent({ ...f.request, approval: undefined }, 'approval')
  ).rejects.toMatchObject({ code: 'PI_TOOL_AUTHORITY_REJECTED' })
})

test('authority cannot create approval and pending approval cannot reach an effect', async () => {
  const approval = {
    interactionId: ids.interactionId,
    allowedPrincipalIds: ['user:11111111-1111-4111-8111-111111111111'],
    requestedAt: at,
    expiresAt: expiry,
  }
  const f = await setup({ approval })
  const pendingRepository = {
    get: async () => ({
      interactionId: approval.interactionId,
      executionId: f.request.executionId,
      attemptId: f.request.attemptId,
      kind: 'approval',
      prompt: {
        title: `Approve ${f.request.operation}`,
        detailsReference: `artifact://tool-call/${f.request.toolCallId}`,
      },
      allowedActions: ['approve', 'deny'],
      allowedPrincipalIds: approval.allowedPrincipalIds,
      state: 'pending',
      version: 1,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
    }),
  }
  const calls = { get: async () => f.call }
  let reviewCalls = 0
  const pending = createPiDurableCurrentToolAuthority({
    currentExecutionAuthority: f.f.host,
    intents: {
      getByAttempt: async () => f.f.intent,
      marker: () => ({
        state: 'ready',
        actorPrincipalId: 'svc_transport',
        workspaceId: f.f.intent.workspaceId,
        intent: f.f.intent,
        planPin: {
          executionPlanId: f.f.plan.executionPlanId,
          contentDigest: f.f.plan.contentDigest,
          schemaVersion: f.f.plan.schemaVersion,
        },
      }),
    },
    executions: f.f.executions,
    plans: f.f.hostOptions.plans,
    service: {
      gateway: {
        prepare: async () => ({
          version: {
            toolDefinitionId: ids.toolDefinitionId,
            toolVersionId: ids.toolVersionId,
            executor: toolExecutor,
          },
          operation: { name: f.request.operation, approvalMode: 'never' },
        }),
      },
      calls,
      approvals: {
        repository: pendingRepository,
        review: async () => {
          reviewCalls += 1
        },
      },
    },
    interactions: pendingRepository,
    now: () => at,
  })
  await expect(pending.assertCurrent(f.request, 'approval')).resolves.toBeUndefined()
  await expect(pending.assertCurrent(f.request, 'effect')).rejects.toMatchObject({
    code: 'PI_TOOL_AUTHORITY_REJECTED',
  })
  expect(reviewCalls).toBe(0)
})

function parkedCurrentAuthority(f) {
  let enteredResolve
  let resumeResolve
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  const resumed = new Promise((resolve) => {
    resumeResolve = resolve
  })
  const current = f.f.host.assertCurrent.bind(f.f.host)
  f.f.host.assertCurrent = async (binding) => {
    enteredResolve()
    await resumed
    await current(binding)
  }
  return { entered, resume: () => resumeResolve() }
}

async function composedToolService(f, effects) {
  const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
  await registry.createDefinition({
    toolDefinitionId: f.request.toolDefinitionId,
    name: 'workspace.documents',
    displayName: 'Workspace documents',
    description: 'Reads a workspace document.',
    ownership: { scope: 'workspace', workspaceId: f.request.workspaceId },
    createdAt: at,
  })
  await registry.publishVersion({
    toolDefinitionId: f.request.toolDefinitionId,
    toolVersionId: f.request.toolVersionId,
    semanticVersion: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: { action: { const: 'read' }, target: { type: 'string' } },
      required: ['action', 'target'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    operations: [
      {
        name: f.request.operation,
        requiredCapabilities: ['documents.read'],
        riskClass: 'high',
        approvalMode: 'always',
        idempotency: 'provider_key',
        retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
      },
    ],
    executor: toolExecutor,
    limits: { maxInputBytes: 1024, maxOutputBytes: 128, timeoutMs: 1000 },
    createdAt: at,
    publishedAt: at,
  })
  const gateway = new ToolGateway(registry)
  gateway.registerExecutor('internal', toolExecutor.reference, {
    async execute() {
      effects.count += 1
      return { output: { ok: true } }
    },
  })
  const calls = new InMemoryToolCallRepository()
  const approvals = {
    repository: f.repository,
    async review({ interactionId }) {
      const interaction = await f.repository.get(interactionId)
      if (!interaction || interaction.state === 'pending')
        return { state: 'pending', interactionId }
      if (interaction.state === 'cancelled') return { state: 'revoked', interactionId }
      if (interaction.state === 'expired') return { state: 'expired', interactionId }
      if (interaction.response?.action === 'approve')
        return {
          state: 'approved',
          interactionId,
          decisionPrincipalRef: interaction.response.respondingPrincipalId,
        }
      return { state: 'denied', interactionId }
    },
  }
  return new PolicyControlledToolExecutionService({
    gateway,
    calls,
    authorizer: new StaticToolPolicyAuthorizer({
      effect: 'allow',
      decisionId: 'fixture-allow',
      policyVersion: 'fixture-policy-v1',
      reasonCode: 'GRANTED',
      requiresApproval: true,
      evaluatedAt: at,
    }),
    approvals,
    rateLimiter: new InMemoryToolRateLimiter(),
    now: () => at,
  })
}

test('effect authority rejects approval revocation while its final current-authority check awaits', async () => {
  const approval = {
    interactionId: ids.interactionId,
    allowedPrincipalIds: ['user:11111111-1111-4111-8111-111111111111'],
    requestedAt: at,
    expiresAt: expiry,
  }
  const f = await setup({ approval })
  const authority = parkedCurrentAuthority(f)
  const checking = f.helper.assertCurrent(f.request, 'effect')
  await authority.entered
  f.setInteraction({ ...f.getInteraction(), state: 'cancelled', version: 3, response: undefined })
  authority.resume()
  await expect(checking).rejects.toMatchObject({ code: 'PI_TOOL_AUTHORITY_REJECTED' })
})

test('effect authority rejects a changed retained approval version and response during its final await', async () => {
  const approval = {
    interactionId: ids.interactionId,
    allowedPrincipalIds: ['user:11111111-1111-4111-8111-111111111111'],
    requestedAt: at,
    expiresAt: expiry,
  }
  const f = await setup({ approval })
  const authority = parkedCurrentAuthority(f)
  const checking = f.helper.assertCurrent(f.request, 'effect')
  await authority.entered
  const retained = f.getInteraction()
  f.setInteraction({
    ...retained,
    version: retained.version + 1,
    response: {
      ...retained.response,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFA',
    },
  })
  authority.resume()
  await expect(checking).rejects.toMatchObject({ code: 'PI_TOOL_AUTHORITY_REJECTED' })
})

for (const deadline of ['approval', 'grant', 'intent']) {
  test(`effect authority rechecks the ${deadline} deadline after its final current-authority check awaits`, async () => {
    const expiresAt = '2026-10-08T12:30:00.000Z'
    const approval =
      deadline === 'approval'
        ? {
            interactionId: ids.interactionId,
            allowedPrincipalIds: ['user:11111111-1111-4111-8111-111111111111'],
            requestedAt: at,
            expiresAt,
          }
        : undefined
    const f = await setup({
      approval,
      ...(deadline === 'grant' ? { grantExpiresAt: expiresAt } : {}),
      ...(deadline === 'intent' ? { intentExpiresAt: expiresAt } : {}),
    })
    const authority = parkedCurrentAuthority(f)
    const checking = f.helper.assertCurrent(f.request, 'effect')
    await authority.entered
    f.setNow(expiresAt)
    authority.resume()
    await expect(checking).rejects.toMatchObject({ code: 'PI_TOOL_AUTHORITY_REJECTED' })
  })
}

for (const race of ['approval-response-change', 'approval-expiry']) {
  test(`real Pi effect gate denies ${race} during authority await and retains the no-effect outcome across reopen`, async () => {
    const approvalExpiresAt = race === 'approval-expiry' ? '2026-10-08T12:30:00.000Z' : expiry
    const approval = {
      interactionId: ids.interactionId,
      allowedPrincipalIds: ['user:11111111-1111-4111-8111-111111111111'],
      requestedAt: at,
      expiresAt: approvalExpiresAt,
    }
    const f = await setup({
      approval,
      grantExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    const effects = { count: 0 }
    const service = await composedToolService(f, effects)
    const gateRequest = structuredClone(f.request)
    delete gateRequest.traceId
    delete gateRequest.interactionId
    delete gateRequest.commandId
    const directory = await mkdtemp(join(tmpdir(), 'pi-current-tool-authority-'))
    const path = join(directory, 'effect-gate.sqlite')
    const key = JSON.stringify([gateRequest.workspaceId, gateRequest.idempotencyKey])
    let database
    try {
      database = new DatabaseSync(path)
      const store = new SqliteDurableEffectGateStore(database)
      const helper = f.createHelper(service)
      let parkCurrent = false
      let enterResolve
      let resumeResolve
      const entered = new Promise((resolve) => {
        enterResolve = resolve
      })
      const resumed = new Promise((resolve) => {
        resumeResolve = resolve
      })
      const currentAuthority = f.f.host.assertCurrent.bind(f.f.host)
      f.f.host.assertCurrent = async (binding) => {
        if (parkCurrent) {
          parkCurrent = false
          enterResolve()
          await resumed
        }
        await currentAuthority(binding)
      }
      const gate = new PiDurableEffectGate({
        store,
        service,
        now: () => at,
        async assertAuthority(request, boundary) {
          if (boundary === 'effect') parkCurrent = true
          await helper.assertCurrent(request, boundary)
          // With the old helper, make the next independent gate review see the
          // original time so only the helper's post-await check can stop this race.
          if (race === 'approval-expiry' && boundary === 'effect') f.setNow(at)
        },
      })
      const execution = gate.execute(gateRequest)
      await entered
      if (race === 'approval-expiry') {
        f.setNow(approvalExpiresAt)
      } else {
        const retainedApproval = f.getInteraction()
        f.setInteraction({
          ...retainedApproval,
          version: retainedApproval.version + 1,
          response: {
            ...retainedApproval.response,
            responseId: 'cmd_01JABCDEF0123456789ABCDEFA',
          },
        })
      }
      resumeResolve()
      if (race === 'approval-expiry') {
        await expect(execution).rejects.toMatchObject({ code: 'PI_EFFECT_AUTHORITY_REJECTED' })
      } else {
        await expect(execution).resolves.toMatchObject({ state: 'denied' })
      }
      expect(effects.count).toBe(0)
      const retained = await store.get(key)
      expect(retained).toMatchObject({
        state: 'settled',
        outcome: {
          state: 'denied',
          reasonCode: 'PI_EFFECT_AUTHORITY_REJECTED',
          toolCallId: gateRequest.toolCallId,
        },
      })

      database.close()
      database = new DatabaseSync(path)
      const reopenedStore = new SqliteDurableEffectGateStore(database)
      const reopenedHelper = f.createHelper(service)
      const reopened = new PiDurableEffectGate({
        store: reopenedStore,
        service,
        now: () => at,
        assertAuthority: (request, boundary) => reopenedHelper.assertCurrent(request, boundary),
      })
      if (race === 'approval-expiry') {
        await expect(reopened.execute(gateRequest)).rejects.toMatchObject({
          code: 'PI_EFFECT_AUTHORITY_REJECTED',
        })
      } else {
        await expect(reopened.execute(gateRequest)).resolves.toEqual(retained.outcome)
      }
      expect(effects.count).toBe(0)
      expect(await reopenedStore.get(key)).toEqual(retained)
    } finally {
      database?.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('publication permits a retained no-effect denial without inventing approval or a started effect', async () => {
  const f = await setup({ state: 'denied' })
  await expect(f.helper.assertCurrent(f.request, 'publication')).resolves.toBeUndefined()
})
