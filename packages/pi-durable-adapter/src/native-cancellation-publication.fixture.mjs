import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { fixture } from './adapter.fixture.mjs'

const at = '2026-10-08T00:00:00.000Z'
function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

// These commit actual SDK native N to SQLite; the executing host is the test runner. Only the adapter's subsequent
// journal publication is faulted; no SDK transaction/receipt or journal state is
// fabricated. Holding run's return prevents unrelated terminal adapter writes
// until assertions finish; it does not delay native abort/drain processing.
export async function withPublicationFault(
  mode,
  use,
  { Adapter, createEngine, directory: suppliedDirectory, afterNativeCommit }
) {
  const directory = suppliedDirectory ?? (await mkdtemp(join(tmpdir(), 'pi-native-publication-')))
  const providerEntered = deferred()
  const releaseProvider = deferred()
  const releaseAdapterRun = deferred()
  const nativeRunSettled = deferred()
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 64, maxTokens: 32 }] })
  let streamAborts = 0
  faux.setResponses([
    async (_transcript, options) => {
      providerEntered.resolve()
      await new Promise((resolve) => {
        releaseProvider.promise.then(resolve)
        options?.signal?.addEventListener(
          'abort',
          () => {
            streamAborts += 1
            resolve()
          },
          { once: true }
        )
      })
      return fauxAssistantMessage('', { stopReason: 'aborted' })
    },
  ])
  let nativeRunError
  let adapter,
    engine,
    nativePins,
    nativeReceipt,
    publicationCut,
    faultCalls = 0
  let originalClaim, originalUpdate, originalGet
  const { options, request, admission } = fixture(directory)
  options.authorizeInference = async () => ({
    maxOutputTokens: 10,
    maximumInputTokens: faux.getModel().contextWindow,
    assertActive: async () => {},
  })
  const originalProvider = options.resolveProvider
  options.resolveProvider = async (...args) => ({
    ...(await originalProvider(...args)),
    provider: 'faux',
    providerModel: 'faux-1',
    withModels: async (callback) => {
      const models = createModels()
      models.setProvider(faux.provider)
      return callback(models)
    },
  })
  options.engineFactory = async (engineOptions) => {
    engine = createEngine({
      ...engineOptions,
      nativeCancellationQualification: {
        now: () => at,
        onOwnerReady: () => {},
        onOwnerClosed: () => {},
      },
    })
    const guarded = engine.guardedCancellation
    return {
      ...engine,
      run: async (...args) => {
        try {
          return await engine.run(...args)
        } catch (error) {
          nativeRunError = error
          throw error
        } finally {
          nativeRunSettled.resolve()
          await releaseAdapterRun.promise
        }
      },
      guardedCancellation: {
        ...guarded,
        commit: async (preparation) => {
          const committed = await guarded.commit(preparation)
          // Validate the actual persisted SDK receipt before admitting the fault.
          assert.deepEqual(await guarded.readReceipt(preparation), committed)
          assert.ok(committed.taskIds.length > 0)
          nativePins = structuredClone(preparation)
          nativeReceipt = structuredClone(committed)
          await afterNativeCommit?.({
            adapter,
            nativePins,
            nativeReceipt,
            providerRequests: faux.state.callCount,
            streamAborts,
          })
          const handleId = adapter.journal.list()[0].handleId
          if (mode === 'successor') {
            const before = adapter.journal.get(handleId)
            const successorEpoch = originalClaim(handleId, before)
            originalUpdate(handleId, successorEpoch, {
              detail: {
                ...before.detail,
                turn: { requestId: 'newer-journal-turn', input: 'retained successor' },
              },
            })
            publicationCut = adapter.journal.get(handleId)
          } else {
            const method = mode === 'read' ? 'get' : mode === 'claim' ? 'claim' : 'update'
            const original =
              mode === 'read' ? originalGet : mode === 'claim' ? originalClaim : originalUpdate
            adapter.journal[method] = () => {
              faultCalls += 1
              publicationCut = originalGet(handleId)
              adapter.journal[method] = original
              throw new Error(`SCRIPTED_POST_NATIVE_${mode.toUpperCase()}_FAILURE`)
            }
          }
          return committed
        },
      },
    }
  }
  let primaryFailure
  const cleanup = async () => {
    // If construction never returned a handle, preserve its state rather than
    // assume any partially initialized SQLite owner has closed.
    if (adapter) {
      try {
        if (originalGet) adapter.journal.get = originalGet
        if (originalClaim) adapter.journal.claim = originalClaim
        if (originalUpdate) adapter.journal.update = originalUpdate
        await adapter.close()
        if (suppliedDirectory === undefined) await rm(directory, { recursive: true, force: true })
      } catch (error) {
        if (primaryFailure !== undefined)
          throw new AggregateError(
            [primaryFailure, error],
            'Native publication test cleanup failed',
            {
              cause: error,
            }
          )
        throw error
      }
    }
  }
  try {
    adapter = new Adapter(options)
    originalGet = adapter.journal.get.bind(adapter.journal)
    originalClaim = adapter.journal.claim.bind(adapter.journal)
    originalUpdate = adapter.journal.update.bind(adapter.journal)
    const handle = await adapter.start(request)
    await Promise.race([
      providerEntered.promise,
      nativeRunSettled.promise.then(() => {
        throw nativeRunError ?? new Error('NATIVE_ENDED_BEFORE_STREAM')
      }),
    ])
    assert.equal(adapter.journal.get(handle.handleId).state, 'running')
    let failure
    try {
      await adapter.cancelFenced(
        handle,
        { idempotencyKey: `publication:${mode}`, requestedAt: at },
        async () => ({ earliestAuthorityExpiresAt: admission.authority.expiresAt })
      )
    } catch (error) {
      failure = error
    }
    releaseProvider.resolve()
    await nativeRunSettled.promise
    await use({
      adapter,
      engine,
      handle,
      failure,
      nativePins,
      nativeReceipt,
      publicationCut,
      faultCalls,
      providerRequests: () => faux.state.callCount,
      streamAborts: () => streamAborts,
    })
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    releaseProvider.resolve()
    releaseAdapterRun.resolve()
    await cleanup()
  }
}
