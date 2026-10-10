import { expect, test } from 'bun:test'
import { createNodePiDurableRuntime } from './composition.ts'
import { governedFixture } from './governed-delegation.fixture.mjs'
import { createNativeEngineToolFixture } from './pi-engine-tools.loopback.fixture.mjs'
import { withUsageAuthorityContext } from './usage-authority.fixture.mjs'

async function fixture(run, failGeneration) {
  return withUsageAuthorityContext(
    async (context) => {
      const governed = await governedFixture(context.directory)
      const native = await createNativeEngineToolFixture({
        firstGenerationUsage: { promptTokens: 8, completionTokens: 3 },
        failGeneration,
      })
      governed.state.approved = true
      const runtime = await createNodePiDurableRuntime({
        ...governed.options,
        engineFactory: undefined,
        resolveProvider: async () => ({
          ...(await governed.options.resolveProvider()),
          provider: 'loopback',
          providerModel: 'loopback-model',
          withModels: native.options.withModels,
        }),
        authorizeInference: context.bridge.authorizeInference,
        settleUsage: context.bridge.settleUsage,
        reconcileInference: async () => 'unresolved',
      })
      try {
        const handle = await runtime.adapter.start(context.authority.request)
        await runtime.adapter.drain()
        await run({ ...context, runtime, handle, native, governed })
      } finally {
        await runtime.close()
        governed.close()
        await native.close()
      }
    },
    {
      maximumTokens: 1100,
      maximumInputTokens: 1024,
      maximumMicrounits: 10000,
      maximumChildExecutions: 1,
    }
  )
}

test('actual native delegate_child settles the first generation before reserving another full context under a 1100-token ceiling', async () => {
  await fixture(async ({ runtime, handle, native, ledger, workspaceId, authority, governed }) => {
    const status = await runtime.adapter.status(handle)
    expect(status.state).toBe('completed')
    expect(native.requests).toHaveLength(2)
    expect(governed.state.effects).toBe(1)
    expect(status.result.usage).toMatchObject({ inputTokens: 13, outputTokens: 6 })
    const entries = await ledger.entries(workspaceId, authority.request.executionId)
    expect(entries.filter((entry) => entry.kind === 'model_usage')).toHaveLength(2)
    expect(
      Object.keys(runtime.adapter.journal.get(handle.handleId).detail.inferenceReceipts)
    ).toHaveLength(2)
    expect(entries.filter((entry) => entry.kind === 'model_release')).toHaveLength(2)
    // The attempt allocation remains retained; both per-request context holds are closed.
    expect((await ledger.summary(workspaceId, authority.request.executionId)).reservedTokens).toBe(
      1081
    )
  })
}, 15000)

test('second-generation provider failure retains first committed usage and keeps the unknown generation fenced', async () => {
  await fixture(async ({ runtime, handle, native, ledger, workspaceId, authority }) => {
    expect((await runtime.adapter.status(handle)).state).toBe('unknown')
    expect(native.requests).toHaveLength(2)
    const entries = await ledger.entries(workspaceId, authority.request.executionId)
    expect(
      entries.filter((entry) => entry.kind === 'model_usage').map((entry) => entry.quantity.value)
    ).toEqual([11])
    expect(entries.filter((entry) => entry.kind === 'model_reservation')).toHaveLength(2)
    expect(entries.filter((entry) => entry.kind === 'model_release')).toHaveLength(1)
    expect(
      Object.keys(runtime.adapter.journal.get(handle.handleId).detail.inferenceReceipts)
    ).toHaveLength(1)
    await runtime.adapter.reconcile(handle)
    await runtime.adapter.drain()
    expect((await runtime.adapter.status(handle)).state).toBe('unknown')
    expect(native.requests).toHaveLength(2)
  }, 2)
}, 15000)
