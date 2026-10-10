import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertCleanPinnedRepository } from './candidate-provenance.fixture.mjs'

// Explicit native repair profile. Requires a clean, pinned source checkout; no dirty override
// exists, so exploratory WIP runs cannot produce a qualified result.
const source = process.env.PI_NATIVE_REPAIR_SOURCE
const qualify = source ? test : test.skip
let createRuntime, governedFixture, createNativeFixture, withUsageContext
if (source) {
  assertCleanPinnedRepository({
    directory: resolve(source),
    expectedHead: process.env.PI_NATIVE_REPAIR_HEAD,
    prefix: 'NATIVE_REPAIR',
  })
  const load = (name) => import(pathToFileURL(resolve(source, name)).href)
  ;({ createNodePiDurableRuntime: createRuntime } = await load('composition.ts'))
  ;({ governedFixture } = await load('governed-delegation.fixture.mjs'))
  ;({ createNativeEngineToolFixture: createNativeFixture } = await load(
    'pi-engine-tools.loopback.fixture.mjs'
  ))
  ;({ withUsageAuthorityContext: withUsageContext } = await load('usage-authority.fixture.mjs'))
}

qualify(
  'physical ledger reopen preserves first receipt idempotency and unknown second-generation send fence at 1100 tokens',
  async () => {
    await withUsageContext(
      async (context) => {
        const governed = await governedFixture(context.directory)
        let native, runtime
        try {
          native = await createNativeFixture({
            firstGenerationUsage: { promptTokens: 8, completionTokens: 3 },
            failGeneration: 2,
          })
          governed.state.approved = true
          const authorizations = [],
            settlements = []
          runtime = await createRuntime({
            ...governed.options,
            engineFactory: undefined,
            resolveProvider: async () => ({
              ...(await governed.options.resolveProvider()),
              provider: 'loopback',
              providerModel: 'loopback-model',
              withModels: native.options.withModels,
            }),
            authorizeInference: async (authority, key) => {
              authorizations.push({ authority: structuredClone(authority), key })
              return context.bridge.authorizeInference(authority, key)
            },
            settleUsage: async (authority, key, usage, counters) => {
              const receipt = await context.bridge.settleUsage(authority, key, usage, counters)
              settlements.push({
                authority: structuredClone(authority),
                key,
                usage: structuredClone(usage),
                counters: structuredClone(counters),
                receipt,
              })
              return receipt
            },
            reconcileInference: async () => 'unresolved',
          })
          const handle = await runtime.adapter.start(context.authority.request)
          await runtime.adapter.drain()
          expect((await runtime.adapter.status(handle)).state).toBe('unknown')
          expect(native.requests).toHaveLength(2)
          expect(governed.state.effects).toBe(1)
          expect(authorizations).toHaveLength(2)
          expect(settlements).toHaveLength(1)
          const committed = settlements[0]
          const pending = authorizations[1]
          expect(committed.key).not.toBe(pending.key)
          const journal = runtime.adapter.journal.get(handle.handleId)
          expect(Object.keys(journal.detail.inferenceReceipts)).toEqual([committed.key])
          const before = await context.ledger.entries(
            context.workspaceId,
            context.authority.request.executionId
          )
          expect(
            before
              .filter((entry) => entry.kind === 'model_usage')
              .map((entry) => entry.quantity.value)
          ).toEqual([11])
          expect(
            before
              .filter((entry) => entry.kind === 'model_reservation')
              .map((entry) => entry.reservedTokens)
          ).toEqual([1056, 1056])
          expect(before.filter((entry) => entry.kind === 'model_release')).toHaveLength(1)
          await runtime.adapter.reconcile(handle)
          await runtime.adapter.drain()
          expect((await runtime.adapter.status(handle)).state).toBe('unknown')
          expect(native.requests).toHaveLength(2)
          await runtime.close()
          runtime = undefined
          // Close the actual SQLite connection, migrate/reopen the same file and reconstruct the bridge.
          const reopened = await context.reopen()
          expect(
            await reopened.bridge.settleUsage(
              committed.authority,
              committed.key,
              committed.usage,
              committed.counters
            )
          ).toEqual(committed.receipt)
          await expect(
            reopened.bridge.authorizeInference(pending.authority, pending.key)
          ).rejects.toThrow('MODEL_REQUEST_DISPATCH_ALREADY_ADMITTED')
          const after = await reopened.ledger.entries(
            context.workspaceId,
            context.authority.request.executionId
          )
          expect(after).toEqual(before)
          expect(native.requests).toHaveLength(2)
          await expect(
            reopened.bridge.settleUsage(
              committed.authority,
              committed.key,
              { ...committed.usage, outputTokens: committed.usage.outputTokens + 1 },
              committed.counters
            )
          ).rejects.toThrow('IDEMPOTENCY_CONFLICT')
          expect(
            await reopened.ledger.entries(
              context.workspaceId,
              context.authority.request.executionId
            )
          ).toEqual(before)
        } finally {
          try {
            if (runtime) await runtime.close()
          } finally {
            try {
              governed.close()
            } finally {
              if (native) await native.close()
            }
          }
        }
      },
      {
        maximumTokens: 1100,
        maximumInputTokens: 1024,
        maximumMicrounits: 10000,
        maximumChildExecutions: 1,
      }
    )
  },
  30000
)
