import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'

const at = '2026-10-08T09:00:00.000Z'
export const interactionId = 'int_01JABCDEF0123456789ABCDEFG'
export const effectIdentity = 'effect:persisted-exact-request-digest'
export const processInput = {
  interactionId,
  idempotencyKey: 'input-process:one',
  text: 'Persisted human follow-up',
}

function secondWorkspacePlan() {
  const input = createExecutionPlanTestFixtureInputs({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const workspaceId = 'wsp_01JBBCDEF0123456789ABCDEFG'
  const projectId = 'prj_01JBBCDEF0123456789ABCDEFG'
  // Snapshot of the empty context compiled by ContextPackageCompiler 1.0.0
  // for this workspace/project. The plan compiler verifies its full digest.
  input.contextPackage = {
    ...input.contextPackage,
    canonicalizationVersion: 2,
    contextPackageId: 'ctx_VTTRYDRHQP3MW5Q6H3BG7203TW',
    contentDigest: 'sha256:deb58f3711bd874e16e688d7038803d70b2cf621ceb9a9d76cd328ed829ec6d0',
    projectState: { workspaceId, projectId, revision: 1 },
  }
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...input,
    correlation: { ...input.correlation, workspaceId, projectId },
  })
}

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
export function processAdapterFixture(
  directory,
  mode = 'resume',
  observe = () => {},
  namespace = 'one'
) {
  if (!['one', 'two'].includes(namespace)) throw new Error('UNKNOWN_PROCESS_FIXTURE_NAMESPACE')
  const plan =
    namespace === 'two'
      ? secondWorkspacePlan()
      : createExecutionPlanTestFixture({
          profileCapabilityRequirements: [],
          skillRequiredCapabilities: [],
        })
  const executionId =
    namespace === 'two' ? 'exe_01JBBCDEF0123456789ABCDEFG' : 'exe_01JABCDEF0123456789ABCDEFG'
  const attemptId =
    namespace === 'two' ? 'att_01JBBCDEF0123456789ABCDEFG' : 'att_01JABCDEF0123456789ABCDEFG'
  const request = {
    executionId,
    attemptId,
    idempotencyKey: 'canonical-process-message:one',
    executionPlan: plan,
    attemptBudget: {
      schemaVersion: 1,
      workspaceId: plan.correlation.workspaceId,
      executionId,
      attemptId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: `runtime-attempt:${attemptId}`,
      currency: 'USD',
      maximumMicrounits: 1000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-durable-admission/v1',
    prompt: namespace === 'two' ? 'Workspace two question' : 'Persistent adapter question',
    selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    authority: {
      revision: 1,
      principalRef: namespace === 'two' ? 'principal:second-lead' : 'principal:lead',
      scopeRef: namespace === 'two' ? 'channel:second-process' : 'channel:process',
      expiresAt: '2026-10-08T10:00:00.000Z',
    },
  }
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 64, maxTokens: 24 }] })
  let inferenceKey
  faux.setResponses([
    async (context) => {
      const userInputs = context.messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
        )
      evidence(directory, { boundary: 'native_send', inferenceKey, userInputs })
      if (mode === 'native_send') {
        observe('native_send')
        await new Promise(() => {})
      }
      return fauxAssistantMessage(
        namespace === 'two' ? 'Workspace two answer' : 'Restarted adapter answer'
      )
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
      if (mode === 'before_native_dispatch' || mode === 'input_before_native_dispatch') {
        observe(mode)
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

async function childMain(directory, mode, namespace = 'one') {
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
      `${JSON.stringify({ boundary, state: record.state, record, handle: record.admission.handle, events: adapter.journal.events(record.handleId, 0) })}\n`
    )
  }
  const fixture = processAdapterFixture(directory, mode, emit, namespace)
  adapter = new PiDurableRuntimeAdapter(fixture.options)
  // Keep the child alive while the intentionally hung scripted send is pending.
  const heartbeat = setInterval(() => {}, 1000)
  try {
    const handle = await adapter.start(fixture.request)
    process.stdout.write(`${JSON.stringify({ boundary: 'admitted', handle })}\n`)
    if (mode === 'input_before_native_dispatch') await adapter.submitInput(handle, processInput)
    await adapter.drain()
    if (mode === 'pending_input') {
      await adapter.awaitInput(handle, interactionId)
      emit('pending_input')
      await new Promise(() => {})
    }
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

/** Test-only child handle and bounded committed-boundary handshake. */
export function processAdapterChild(directory, mode, namespace = 'one') {
  const node =
    process.env.CONTROL_PLANE_TEST_NODE ?? (process.versions.bun ? 'node' : process.execPath)
  const child = spawn(
    node,
    ['--experimental-transform-types', fileURLToPath(import.meta.url), directory, mode, namespace],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  let found = false
  const complete = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  const boundary = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Adapter child boundary timeout: ${stderr}`))
    }, 10000)
    child.stdout.on('data', (data) => {
      stdout += data
      for (const line of stdout.split('\n').filter(Boolean)) {
        let value
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        if (value.boundary === mode && !found) {
          found = true
          clearTimeout(timer)
          resolve(value)
        }
      }
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (!found) reject(new Error(stderr || stdout || 'Adapter child ended before boundary'))
    })
  })
  return { child, boundary, complete }
}

/** Never remove retained state until the exact spawned child has exited. */
export async function stopProcessAdapterChild(worker) {
  if (!worker) return
  worker.child.kill('SIGKILL')
  let timer
  try {
    return await Promise.race([
      worker.complete,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Adapter child exit unconfirmed; preserve retained state')),
          10000
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function closeProcessAdapterFixture(adapter, timeoutMs) {
  let timer
  try {
    await Promise.race([
      adapter.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Adapter close unconfirmed; preserve retained state')),
          timeoutMs
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function cleanupProcessAdapterFixtures(
  directory,
  workers,
  adapters,
  { closeTimeoutMs = 10000 } = {}
) {
  const stopped = await Promise.allSettled(workers.map(stopProcessAdapterChild))
  const closed = await Promise.allSettled(
    adapters.filter(Boolean).map((adapter) => closeProcessAdapterFixture(adapter, closeTimeoutMs))
  )
  const failures = [...stopped, ...closed]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length)
    throw new AggregateError(
      failures,
      'Adapter fixture cleanup unconfirmed; retained state preserved'
    )
  await rm(directory, { recursive: true, force: true })
}
