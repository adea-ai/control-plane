import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'

const at = '2026-10-08T09:00:00.000Z'
export const interactionId = 'int_01JABCDEF0123456789ABCDEFG'
export const effectIdentity = 'effect:persisted-exact-request-digest'

function evidence(directory, value) {
  const descriptor = openSync(join(directory, 'process-evidence.jsonl'), 'a', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/** Scripted Models only: adapter, default Pi engine and both SQLite stores are real. */
export function processAdapterFixture(directory, mode = 'resume', observe = () => {}) {
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const request = {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'canonical-process-message:one',
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
      maximumMicrounits: 1000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-durable-admission/v1',
    prompt: 'Persistent adapter question',
    selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    authority: {
      revision: 1,
      principalRef: 'principal:lead',
      scopeRef: 'channel:process',
      expiresAt: '2026-10-08T10:00:00.000Z',
    },
  }
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 64, maxTokens: 24 }] })
  let inferenceKey
  faux.setResponses([
    async () => {
      evidence(directory, { boundary: 'native_send', inferenceKey })
      if (mode === 'native_send') {
        observe('native_send')
        await new Promise(() => {})
      }
      return fauxAssistantMessage('Restarted adapter answer')
    },
  ])
  const options = {
    directory,
    now: () => at,
    resolveAdmission: async () => admission,
    assertAuthority: async (authority) => {
      if (
        authority.request.attemptId !== request.attemptId ||
        authority.request.executionPlan.contentDigest !== plan.contentDigest ||
        authority.admission.authority.scopeRef !== admission.authority.scopeRef
      )
        throw new Error('STALE_AUTHORITY')
    },
    resolveProvider: async () => ({
      ...admission.selection,
      workspaceId: plan.correlation.workspaceId,
      provider: 'faux',
      providerModel: 'faux-1',
      location: 'remote_host',
      harness: 'pi_durable',
      harnessVersion: '1.1.0',
      providerBinding: 'pi_durable_models',
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(faux.provider)
        return use(models)
      },
    }),
    authorizeInference: async (_authority, key) => {
      inferenceKey = key
      evidence(directory, { boundary: 'before_native_dispatch', inferenceKey: key })
      if (mode === 'before_native_dispatch') {
        observe('before_native_dispatch')
        await new Promise(() => {})
      }
      return { maxOutputTokens: 24, maximumInputTokens: 64, assertActive: async () => {} }
    },
    settleUsage: async (_authority, key, usage) => {
      evidence(directory, { boundary: 'settlement', inferenceKey: key })
      return usage
    },
    // Only the test's proven pre-send mode declares replay safe. Unknown send stays blocked.
    reconcileInference: async () => (mode === 'safe_resume' ? 'safe_to_resume' : 'unresolved'),
    verifyApproval: async (authority, identity, submitted) => {
      const path = join(directory, 'canonical-approval.json')
      if (!existsSync(path)) return false
      const decision = JSON.parse(readFileSync(path, 'utf8'))
      return (
        decision.executionId === authority.request.executionId &&
        decision.attemptId === authority.request.attemptId &&
        decision.effectIdentity === identity &&
        decision.effectIdentity === effectIdentity &&
        decision.interactionId === submitted.interactionId &&
        decision.principalRef === 'principal:owner' &&
        decision.decision === submitted.decision
      )
    },
  }
  return { request, options }
}

async function childMain(directory, mode) {
  // Node transforms the current adapter source. Map only this package's source
  // .js specifiers to .ts; external workspace/package imports keep normal resolution.
  const { registerHooks } = await import('node:module')
  const sourceRoot = new URL('./', import.meta.url).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (
          error.code !== 'ERR_MODULE_NOT_FOUND' ||
          !context.parentURL?.startsWith(sourceRoot) ||
          !specifier.startsWith('./') ||
          !specifier.endsWith('.js')
        )
          throw error
        return nextResolve(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context)
      }
    },
  })
  const { PiDurableRuntimeAdapter } = await import('./adapter.ts')
  let adapter
  const emit = (boundary) => {
    const record = adapter.journal.list()[0]
    process.stdout.write(
      `${JSON.stringify({ boundary, state: record.state, handle: record.admission.handle, events: adapter.journal.events(record.handleId, 0) })}\n`
    )
  }
  const fixture = processAdapterFixture(directory, mode, emit)
  adapter = new PiDurableRuntimeAdapter(fixture.options)
  // Keep the child alive while the intentionally hung scripted send is pending.
  const heartbeat = setInterval(() => {}, 1000)
  try {
    const handle = await adapter.start(fixture.request)
    process.stdout.write(`${JSON.stringify({ boundary: 'admitted', handle })}\n`)
    await adapter.drain()
    if (mode === 'pending_approval') {
      await adapter.awaitApproval(handle, interactionId, effectIdentity)
      emit('pending_approval')
      await new Promise(() => {})
    }
    emit('completed')
  } finally {
    clearInterval(heartbeat)
    await adapter.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await childMain(...process.argv.slice(2))
