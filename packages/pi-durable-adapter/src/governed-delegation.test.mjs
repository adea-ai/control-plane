import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodePiDurableRuntime } from './composition.ts'
import { governedFixture, id } from './governed-delegation.fixture.mjs'
import { createNativeEngineToolFixture } from './pi-engine-tools.loopback.fixture.mjs'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'

async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-governed-adapter-'))
  const setup = await governedFixture(directory)
  let runtime
  const open = async (options) => {
    runtime = await createNodePiDurableRuntime(options ?? setup.options)
    return runtime
  }
  const close = async () => {
    if (runtime) await runtime.close()
    runtime = undefined
  }
  try {
    await run({ ...setup, directory, open, close })
  } finally {
    await close()
    setup.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

test('governed child tool remains absent without explicit host compiler configuration', () =>
  fixture(async ({ options, open, request, state }) => {
    const { governedDelegateChild: _governedDelegateChild, ...disabled } = options
    const runtime = await open(disabled)
    const handle = await runtime.adapter.start(request)
    await runtime.adapter.drain()
    expect(state.ports[0].governedDelegateChild).toBeUndefined()
    expect((await runtime.adapter.status(handle)).state).toBe('completed')
    expect(state.effects).toBe(0)
    expect(
      (await runtime.adapter.inspect()).capabilities.some((item) => item.name === 'execution.child')
    ).toBe(false)
  }))

test('a plan outside the single-child bound receives no native delegation port', () =>
  fixture(async ({ request, open, state }) => {
    const inputs = createExecutionPlanTestFixtureInputs({
      profileCapabilityRequirements: [],
      skillRequiredCapabilities: [],
    })
    inputs.constraints.limits.childExecutions.maximumTotal = 0
    inputs.profile.definition.executionConstraints.limits.childExecutions.maximumTotal = 0
    const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
    const runtime = await open()
    const handle = await runtime.adapter.start({
      ...request,
      executionPlan: plan,
      attemptBudget: {
        ...request.attemptBudget,
        executionPlanId: plan.executionPlanId,
        executionPlanDigest: plan.contentDigest,
      },
    })
    await runtime.adapter.drain()
    expect(state.ports[0].governedDelegateChild).toBeUndefined()
    expect(state.preparations).toHaveLength(0)
    expect(state.effects).toBe(0)
    expect((await runtime.adapter.status(handle)).state).toBe('completed')
  }))

test('adapter binds exact native source to original actor and whitelists canonical child references', () =>
  fixture(async ({ open, request, state, database }) => {
    state.approved = true
    const runtime = await open()
    const handle = await runtime.adapter.start(request)
    await runtime.adapter.drain()
    expect((await runtime.adapter.status(handle)).state).toBe('completed')
    expect(state.effects).toBe(1)
    const prepared = state.preparations[0]
    expect(prepared.verified.source).toMatchObject({
      runtimeHandleId: handle.handleId,
      externalSessionId: handle.externalSessionId,
      parentExecutionId: request.executionId,
      parentAttemptId: request.attemptId,
      admittedTurnKey: `pi-turn:${request.attemptId}:initial`,
    })
    expect(prepared.authority.admission.canonicalActorPrincipalId).toBe('principal:original-actor')
    expect(prepared.authority.admission.authority.principalRef).toBe('lease:transport-service')
    expect(state.outcomes[0]).toMatchObject({
      state: 'succeeded',
      toolCallId: id('tlc'),
      delegationId: id('dlg'),
      childAttemptId: id('att').replace(/G$/, 'H'),
    })
    expect(JSON.stringify(state.outcomes)).not.toContain('opaque-private-diagnostic')
    const status = await runtime.adapter.status(handle)
    expect(status.result.usage).toMatchObject({
      inputTokens: 6,
      outputTokens: 8,
      cost: { amount: '0.000014', currency: 'USD' },
      accounting: { fundingSource: 'byo_api', chargedMicrounits: 14 },
    })
    expect(database.prepare('SELECT key FROM settlements').all()).toHaveLength(2)
    expect(
      Object.keys(runtime.adapter.journal.get(handle.handleId).detail.inferenceReceipts)
    ).toHaveLength(2)
  }))

test('pending approval retains native source and original full request across restart; ack alone admits no child', () =>
  fixture(async ({ open, close, request, state, database }) => {
    let runtime = await open()
    const handle = await runtime.adapter.start(request)
    await runtime.adapter.drain()
    expect((await runtime.adapter.status(handle)).state).toBe('awaiting_input')
    expect(state.effects).toBe(0)
    const retained = runtime.adapter.journal.get(handle.handleId)
    expect(retained.detail.nativeToolBlocked.source.parentAttemptId).toBe(request.attemptId)
    expect(retained.detail.pendingApproval.interactionId).toBe(id('int'))
    expect(database.prepare('SELECT key FROM settlements').all()).toHaveLength(1)
    const originalRequest = database.prepare('SELECT request FROM compiled').get().request
    await close()
    runtime = await open()
    expect(await runtime.adapter.start(request)).toEqual(handle)
    const acknowledgement = {
      interactionId: id('int'),
      idempotencyKey: 'approval:one',
      decision: 'approve',
    }
    await expect(runtime.adapter.submitApproval(handle, acknowledgement)).rejects.toThrow(
      'PI_APPROVAL_NOT_AUTHORITATIVE'
    )
    state.approved = true
    expect((await runtime.adapter.submitApproval(handle, acknowledgement)).state).toBe(
      'awaiting_input'
    )
    expect(state.effects).toBe(0)
    await runtime.adapter.reconcile(handle)
    await runtime.adapter.drain()
    expect(state.ports).toHaveLength(2)
    expect(state.effects).toBe(1)
    expect((await runtime.adapter.status(handle)).state).toBe('completed')
    expect(state.effects).toBe(1)
    expect(database.prepare('SELECT request FROM compiled').get().request).toBe(originalRequest)
    expect(state.preparations[1].verified).toEqual(state.preparations[0].verified)
    expect(database.prepare('SELECT key FROM settlements').all()).toHaveLength(2)
  }))

test.each(['foreign_turn', 'actor', 'objective', 'abort', 'revoked', 'native_abort_during_policy'])(
  'adapter rejects %s before a child effect',
  (fault) =>
    fixture(async ({ open, request, state }) => {
      state.approved = true
      if (fault === 'foreign_turn')
        state.beforeNative = (source) => {
          source.admittedTurnKey += ':forged'
        }
      if (fault === 'actor')
        state.forgeRequest = (full) => ({
          audit: { ...full.audit, principalRef: 'lease:transport-service' },
        })
      if (fault === 'objective')
        state.forgeRequest = () => ({ input: { objective: 'Forged child objective' } })
      if (fault === 'abort')
        state.beforePrepare = () => {
          state.controller.abort(new Error('secret-abort-reason'))
        }
      if (fault === 'revoked')
        state.beforePrepare = () => {
          state.revoked = true
        }
      if (fault === 'native_abort_during_policy')
        state.onReview = () => {
          if (state.calls === 2) state.currentTask.abortRequested = true
        }
      const runtime = await open()
      const handle = await runtime.adapter.start(request)
      await runtime.adapter.drain()
      expect((await runtime.adapter.status(handle)).state).toBe('unknown')
      expect(state.effects).toBe(0)
      expect(JSON.stringify(runtime.adapter.journal.get(handle.handleId))).not.toContain('secret-')
    })
)

test('uncertain governed effect retains reconciliation and native replay never dispatches again', () =>
  fixture(async ({ open, close, request, state }) => {
    state.approved = true
    state.afterEffect = () => {
      throw new Error('secret-uncertain-effect')
    }
    let runtime = await open()
    const handle = await runtime.adapter.start(request)
    await runtime.adapter.drain()
    expect((await runtime.adapter.status(handle)).state).toBe('unknown')
    expect(state.outcomes[0].state).toBe('reconciliation_required')
    expect(state.effects).toBe(1)
    await close()
    runtime = await open()
    await runtime.adapter.drain()
    expect((await runtime.adapter.status(handle)).state).toBe('unknown')
    expect(state.effects).toBe(1)
  }))

test('mixed funding receipts cannot be published as a single aggregate accounting scope', () =>
  fixture(async ({ open, request, state }) => {
    state.approved = true
    state.mixedFunding = true
    const runtime = await open()
    const handle = await runtime.adapter.start(request)
    await runtime.adapter.drain()
    expect((await runtime.adapter.status(handle)).state).toBe('unknown')
    expect(
      Object.keys(runtime.adapter.journal.get(handle.handleId).detail.inferenceReceipts)
    ).toHaveLength(2)
    expect(state.effects).toBe(1)
  }))

test(
  'default Pi engine preserves governed approval intent through adapter/store restart without another first generation',
  () =>
    fixture(async ({ open, close, options, request, state, database }) => {
      const native = await createNativeEngineToolFixture()
      const { engineFactory: _engineFactory, ...defaults } = options
      const ready = {
        ...defaults,
        resolveProvider: async (...args) => ({
          ...(await options.resolveProvider(...args)),
          provider: 'loopback',
          providerModel: 'loopback-model',
          withModels: native.options.withModels,
        }),
        authorizeInference: async (_authority, key) =>
          native.options.authorizeInference({
            sessionId: 'actual-adapter-session',
            inferenceId: key,
            provider: 'loopback',
            modelId: 'loopback-model',
          }),
      }
      const admitted = {
        ...request,
        attemptBudget: { ...request.attemptBudget, maximumTokens: 2000 },
      }
      try {
        let runtime = await open(ready)
        const handle = await runtime.adapter.start(admitted)
        await runtime.adapter.drain()
        expect((await runtime.adapter.status(handle)).state).toBe('awaiting_input')
        expect(native.requests).toHaveLength(1)
        expect(state.effects).toBe(0)
        const pending = runtime.adapter.journal.get(handle.handleId)
        expect(pending.detail.nativeToolBlocked.source).toMatchObject({
          runtimeHandleId: handle.handleId,
          externalSessionId: handle.externalSessionId,
          parentAttemptId: admitted.attemptId,
          admittedTurnKey: `pi-turn:${admitted.attemptId}:initial`,
        })
        const retainedKey = pending.detail.nativeToolBlocked.sourceKey
        const original = database.prepare('SELECT request FROM compiled').get().request
        expect(database.prepare('SELECT key FROM settlements').all()).toHaveLength(1)
        await close()

        runtime = await open(ready)
        expect(await runtime.adapter.start(admitted)).toEqual(handle)
        expect(native.requests).toHaveLength(1)
        state.approved = true
        await runtime.adapter.submitApproval(handle, {
          interactionId: id('int'),
          idempotencyKey: 'native-approval:one',
          decision: 'approve',
        })
        expect(state.effects).toBe(0)
        await runtime.adapter.reconcile(handle)
        await runtime.adapter.drain()
        const result = await runtime.adapter.status(handle)
        expect(result.state).toBe('completed')
        expect(result.result.output.text).toBe('Child delegation receipt received.')
        expect(result.result.usage).toMatchObject({
          inputTokens: 10,
          outputTokens: 6,
          accounting: { chargedMicrounits: 14, fundingSource: 'byo_api' },
        })
        expect(native.requests).toHaveLength(2)
        expect(state.effects).toBe(1)
        expect(state.preparations[1].verified.sourceKey).toBe(retainedKey)
        expect(database.prepare('SELECT request FROM compiled').get().request).toBe(original)
        expect(database.prepare('SELECT key FROM settlements').all()).toHaveLength(2)
        const toolMessage = native.requests[1].messages.find((item) => item.role === 'tool')
        expect(JSON.parse(toolMessage.content)).toMatchObject({
          schemaVersion: 'pi-delegate-child-outcome/v1',
          state: 'succeeded',
          toolCallId: id('tlc'),
          delegationId: id('dlg'),
        })
        expect(toolMessage.content).not.toContain('opaque-private-diagnostic')
        expect(JSON.stringify(runtime.adapter.journal.get(handle.handleId))).not.toContain(
          'fixture-no-paid-account'
        )
      } finally {
        await close()
        await native.close()
      }
    }),
  30000
)
