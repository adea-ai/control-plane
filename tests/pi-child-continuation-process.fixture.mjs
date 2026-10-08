// Test-only OS process fixture. All provider, payer and approval ports are scripted.
// Parent-owned HTTP survives the initial Bun worker and subsequent Node 24 recovery.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function appendProcessEvidence(directory, value) {
  const descriptor = openSync(join(directory, 'process-evidence.jsonl'), 'a', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function writeProcessDescriptor(directory, value) {
  const descriptor = openSync(join(directory, 'child-descriptor.json'), 'w', 0o600)
  try {
    writeFileSync(descriptor, JSON.stringify(value))
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function readProcessEvidence(directory) {
  const path = join(directory, 'process-evidence.jsonl')
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
}

// Emitted recovery uses explicit compiled module paths and ordinary package exports.
// Initial Bun admission still imports a test fixture with direct production source imports.
const emittedProcessProduction = process.env.PI_CHILD_PROCESS_EMITTED === 'true'
const usedProcessProductionModules = new Set()
let processSourceHooksRegistered = false
const processProductionModules = new Map([
  [
    '../packages/pi-durable-adapter/src/child-continuation-authority.ts',
    '../packages/pi-durable-adapter/dist/child-continuation-authority.js',
  ],
  [
    '../packages/pi-durable-adapter/src/child-continuation.ts',
    '../packages/pi-durable-adapter/dist/child-continuation.js',
  ],
  [
    '../packages/pi-durable-adapter/src/composition.ts',
    '../packages/pi-durable-adapter/dist/composition.js',
  ],
  [
    '../packages/pi-durable-adapter/src/pi-engine.ts',
    '../packages/pi-durable-adapter/dist/pi-engine.js',
  ],
  [
    '../packages/pi-durable-adapter/src/journal.ts',
    '../packages/pi-durable-adapter/dist/journal.js',
  ],
  [
    '../packages/pi-durable-adapter/src/usage-authority.ts',
    '../packages/pi-durable-adapter/dist/usage-authority.js',
  ],
  [
    '../apps/control-api/src/pi-durable/sqlite-child-continuations.ts',
    '../apps/control-api/dist/pi-durable/sqlite-child-continuations.js',
  ],
  [
    '../apps/control-api/src/pi-durable/child-progress-scanner.ts',
    '../apps/control-api/dist/pi-durable/child-progress-scanner.js',
  ],
])

export async function importProcessProduction(source) {
  const emitted = processProductionModules.get(source)
  assert.ok(emitted, 'Unknown process production module')
  const target = emittedProcessProduction ? emitted : source
  const url = new URL(target, import.meta.url)
  assert.ok(existsSync(fileURLToPath(url)), `Missing process production module: ${target}`)
  const module = await import(url.href)
  usedProcessProductionModules.add(target.slice(3))
  return module
}

export function processProductionEvidence() {
  return {
    productionMode:
      emittedProcessProduction && !processSourceHooksRegistered ? 'emitted' : 'source',
    productionModulePaths: [...usedProcessProductionModules].toSorted(),
    productionSourceHooksRegistered: processSourceHooksRegistered,
  }
}

/** Node strip/transform-types must load this worktree, including emitted .js source imports. */
export async function registerProcessSourceHooks() {
  assert.equal(emittedProcessProduction, false, 'Emitted worker cannot install source hooks')
  const { registerHooks } = await import('node:module')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const packages = join(root, 'packages')
  const aliases = new Map()
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(packages, entry.name)
    const manifest = join(path, 'package.json')
    if (!existsSync(manifest)) continue
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
    if (!metadata.name?.startsWith('@control-plane/')) continue
    for (const [subpath, conditions] of Object.entries(metadata.exports ?? {})) {
      const target =
        typeof conditions === 'string' ? conditions : (conditions.default ?? conditions.node)
      if (typeof target !== 'string' || !target.startsWith('./dist/') || !target.endsWith('.js'))
        continue
      const source = join(path, target.replace('./dist/', 'src/').replace(/\.js$/, '.ts'))
      if (existsSync(source))
        aliases.set(
          subpath === '.' ? metadata.name : `${metadata.name}/${subpath.slice(2)}`,
          source
        )
    }
  }
  processSourceHooksRegistered = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (aliases.has(specifier))
        return nextResolve(pathToFileURL(aliases.get(specifier)).href, context)
      if (
        context.parentURL?.startsWith(new URL('../', import.meta.url).href) &&
        specifier.startsWith('.') &&
        specifier.endsWith('.js')
      ) {
        const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
        if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context)
      }
      return nextResolve(specifier, context)
    },
  })
}

export async function createChildProcessTransport({ ambiguous = false } = {}) {
  const requests = []
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.model, 'separate-child-model')
    requests.push(body)
    if (ambiguous) await pending
    if (response.destroyed) return
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunks = [
      {
        id: 'process_child',
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Restart-safe child evidence.' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'process_child',
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    ]
    response.end(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    )
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      release()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export async function withChildProcessModels(baseUrl, use) {
  const { createModels, createProvider } = await import('@earendil-works/pi-ai/models')
  const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
  const models = createModels()
  models.setProvider(
    createProvider({
      id: 'child-loopback',
      baseUrl,
      auth: {
        apiKey: {
          name: 'Synthetic child process fixture',
          resolve: async () => ({ auth: { apiKey: 'fixture-child-no-account' } }),
        },
      },
      models: [
        {
          id: 'separate-child-model',
          provider: 'child-loopback',
          name: 'Child process fixture',
          api: 'openai-completions',
          baseUrl,
          reasoning: false,
          input: ['text'],
          contextWindow: 1024,
          maxTokens: 32,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      api: openAICompletionsApi(),
    })
  )
  try {
    return await use(models)
  } finally {
    models.clearProviders()
  }
}

export const processRecordId = (value) => `r-${createHash('sha256').update(value).digest('hex')}`

export const defaultProcessClock = '2026-08-25T18:03:00.000Z'
const clock = defaultProcessClock
export function processClock(directory) {
  const path = join(directory, 'current-time.json')
  if (!existsSync(path)) return clock
  const value = JSON.parse(readFileSync(path, 'utf8'))
  return typeof value === 'string' ? value : value.now
}
const expiresAt = '2026-08-25T18:09:00.000Z'
const pin = (plan) => ({
  executionPlanId: plan.executionPlanId,
  contentDigest: plan.contentDigest,
  schemaVersion: plan.schemaVersion,
})
const actor = 'user:original-canonical-actor'

export async function continuationPorts(directory, journal) {
  const sqlite = await import('@control-plane/sqlite-persistence')
  const { createPiChildContinuationAuthority, readPiChildContinuationJournal } =
    await importProcessProduction(
      '../packages/pi-durable-adapter/src/child-continuation-authority.ts'
    )
  const { assertCurrentPiChildContinuation } = await importProcessProduction(
    '../packages/pi-durable-adapter/src/child-continuation.ts'
  )
  const { SqlitePiChildContinuationRepository } = await importProcessProduction(
    '../apps/control-api/src/pi-durable/sqlite-child-continuations.ts'
  )
  const provider = new sqlite.SqlitePersistenceProvider({
    path: join(directory, 'canonical.sqlite'),
  })
  await provider.migrate()
  const executions = new sqlite.SqliteExecutionRepository(provider)
  const plans = new sqlite.SqliteExecutionPlanRepository(provider)
  const descriptor = () =>
    JSON.parse(readFileSync(join(directory, 'child-descriptor.json'), 'utf8'))
  const current = {
    readCurrent: async () =>
      JSON.parse(readFileSync(join(directory, 'current-authority.json'), 'utf8')),
  }
  const repository = new SqlitePiChildContinuationRepository({
    provider,
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    now: () => processClock(directory),
    scopeAuthority: () => ({
      readCurrent: async (input) => ({
        ...input,
        principalActive: true,
        grantActive: true,
        allowedPrincipalIds: [actor],
        expiresAt: '2026-09-01T00:00:00.000Z',
        ...(input.executionScope.kind === 'project'
          ? { projectWorkspaceId: input.workspaceId }
          : {}),
      }),
    }),
    readChildMetadata: async ({ grant }) =>
      readPiChildContinuationJournal(journal(), grant.child.handle),
    assertCurrent: async ({ grant }) => {
      const metadata = readPiChildContinuationJournal(journal(), grant.child.handle)
      await assertCurrentPiChildContinuation(grant, metadata, current, () =>
        processClock(directory)
      )
    },
  })
  const snapshot = async (grant) => ({
    parentExecution: await executions.getExecution(grant.parent.executionId),
    parentAttempt: await executions.getAttempt(grant.parent.attemptId),
    childExecution: await executions.getExecution(grant.child.executionId),
    childAttempt: await executions.getAttempt(grant.child.attemptId),
    parentPlan: await plans.get(grant.parent.executionPlan),
    childPlan: await plans.get(grant.child.executionPlan),
    childHandle: readPiChildContinuationJournal(journal(), grant.child.handle).handle,
  })
  const assertSendAuthority = async (_grant, authority) => {
    const metadata = descriptor()
    const { canonicalJsonStringify } = await import('@control-plane/contracts')
    assert.equal(
      canonicalJsonStringify(authority.request),
      canonicalJsonStringify(metadata.request)
    )
    assert.equal(
      canonicalJsonStringify(authority.admission),
      canonicalJsonStringify(metadata.admission)
    )
    const facts = await current.readCurrent()
    assert.equal(facts.providerActive, true)
    assert.equal(facts.spendingActive, true)
  }
  const authority = createPiChildContinuationAuthority({
    repository,
    readSnapshot: snapshot,
    current,
    now: () => processClock(directory),
    assertFreshAuthority: async (input) => {
      const parent = await executions.getExecution('exe_01JABCDEF0123456789ABCDEFG')
      const attempt = await executions.getAttempt('att_01JABCDEF0123456789ABCDEFG')
      assert.ok(['running', 'awaiting_input'].includes(parent.state))
      assert.ok(['running', 'awaiting_input'].includes(attempt.state))
      assert.equal(input.admission.canonicalActorPrincipalId, actor)
    },
    assertSendAuthority,
    assertPublicationAuthority: async (grant) => {
      const metadata = descriptor()
      assert.equal(grant.canonicalActorPrincipalId, actor)
      assert.equal(metadata.publicationAudience, actor)
    },
  })
  return { provider, executions, plans, repository, authority, sqlite, current, descriptor }
}

export async function initialWorker(directory, mode, baseUrl) {
  const { createGovernedChildCompositionFixture } =
    await import('./pi-durable-governed-child-composition.fixture.mjs')
  const { createNodePiDurableRuntime } = await importProcessProduction(
    '../packages/pi-durable-adapter/src/composition.ts'
  )
  const { createPiDurableEngine } = await importProcessProduction(
    '../packages/pi-durable-adapter/src/pi-engine.ts'
  )
  const {
    piChildContinuationAdmissionDigest,
    piChildContinuationStartRequestDigest,
    piChildContinuationRequestDigest,
    PiChildContinuationGrantSchema,
  } = await importProcessProduction('../packages/pi-durable-adapter/src/child-continuation.ts')
  const { InteractionService } = await import('@control-plane/domain')
  let childRuntime,
    childEngine,
    ports,
    f,
    fastTerminalSnapshot,
    fastNativeInspection,
    physicalSendCount = 0,
    childModelCallbacks = 0,
    metadata = { publicationAudience: actor }
  const heartbeat = setInterval(() => {}, 1000)
  try {
    f = await createGovernedChildCompositionFixture(directory, {
      childRuntimeFactory: async (options) => {
        ports = await continuationPorts(directory, () => childRuntime.adapter.journal)
        const originalResolve = options.resolveAdmission
        childRuntime = await createNodePiDurableRuntime({
          ...options,
          resolveAdmission: async (request) => {
            metadata = { ...metadata, request, admission: await originalResolve(request) }
            writeProcessDescriptor(directory, metadata)
            return metadata.admission
          },
          assertAuthority: async (authority) => {
            await options.assertAuthority(authority)
            await ports.authority.assertAuthority(authority)
          },
          resolveProvider: async (...args) => {
            const { withModels: _unused, ...binding } = await options.resolveProvider(...args)
            metadata = { ...metadata, binding, baseUrl }
            writeProcessDescriptor(directory, metadata)
            appendProcessEvidence(directory, { stage: 'child_binding_retained', pid: process.pid })
            return { ...binding, withModels: (use) => withChildProcessModels(baseUrl, use) }
          },
          engineFactory: async (engineOptions) => {
            appendProcessEvidence(directory, { stage: 'child_engine_create', pid: process.pid })
            const observedOptions = {
              ...engineOptions,
              withModels: async (use) => {
                const sequence = ++childModelCallbacks
                appendProcessEvidence(directory, { stage: 'child_models_enter', sequence })
                try {
                  const result = await engineOptions.withModels(async (models) => {
                    appendProcessEvidence(directory, { stage: 'child_models_use_enter', sequence })
                    const value = await use(models)
                    appendProcessEvidence(directory, { stage: 'child_models_use_return', sequence })
                    return value
                  })
                  appendProcessEvidence(directory, { stage: 'child_models_return', sequence })
                  return result
                } catch (error) {
                  appendProcessEvidence(directory, {
                    stage: 'child_models_rejected',
                    sequence,
                    errorType: error instanceof Error ? error.name : 'NonError',
                  })
                  throw error
                }
              },
            }
            if (mode !== 'fast_child_terminal_before_grant') {
              childEngine = createPiDurableEngine(observedOptions)
              return childEngine
            }
            // This synchronous fixture scope supplies the engine's captured transport.
            const originalFetch = globalThis.fetch
            globalThis.fetch = async (...args) => {
              const response = await originalFetch(...args)
              physicalSendCount++
              return response
            }
            try {
              childEngine = createPiDurableEngine(observedOptions)
              const close = childEngine.close.bind(childEngine)
              childEngine.close = async () => {
                try {
                  if (!fastNativeInspection) {
                    const row = childRuntime.adapter.journal.list()[0]
                    if (row) {
                      fastNativeInspection = await childEngine.inspect(
                        row.admission.handle.externalSessionId
                      )
                    }
                  }
                } finally {
                  await close()
                }
              }
              return childEngine
            } finally {
              globalThis.fetch = originalFetch
            }
          },
          authorizeInference: async (authority, key) => {
            appendProcessEvidence(directory, {
              stage: 'child_authorization_enter',
              pid: process.pid,
            })
            await ports.authority.assertAuthority(authority)
            const row = childRuntime.adapter.journal.list()[0]
            const native = await childEngine.inspect(row.admission.handle.externalSessionId)
            const task = native.tasks.find((item) => item.record.kind === 'pi.generation').record
            assert.equal(task.state.checkpoint.phase, 'request')
            assert.ok(key.endsWith(`pi-generation:${task.id}`))
            appendProcessEvidence(directory, {
              stage: 'before_reservation',
              pid: process.pid,
              key,
              task,
              handle: row.admission.handle,
            })
            if (mode === 'before_reservation' || mode === 'before_grant_retention')
              await new Promise(() => {})
            return options.authorizeInference(authority, key)
          },
        })
        return childRuntime
      },
      retainContinuation: async (input) => {
        appendProcessEvidence(directory, {
          stage: 'continuation_retention_enter',
          pid: process.pid,
        })
        const deadline = Date.now() + 5000
        let childRow
        let childReady = false
        do {
          childRow = childRuntime.adapter.journal.list()[0]
          childReady = Boolean(
            childRow &&
            metadata.binding &&
            (childRow.state === 'running' || mode === 'fast_child_terminal_before_grant')
          )
          if (childReady) break
          assert.ok(Date.now() < deadline, 'actual child running journal deadline')
          await new Promise((resolve) => setTimeout(resolve, 10))
        } while (!childReady)
        if (mode !== 'fast_child_terminal_before_grant') assert.equal(childRow.state, 'running')
        const request = input.request
        const interactions = new InteractionService(
          new ports.sqlite.SqliteInteractionRepository(ports.provider)
        )
        const pending = await interactions.request({
          interactionId: request.approval.interactionId,
          executionId: request.executionId,
          attemptId: request.attemptId,
          kind: 'approval',
          prompt: { title: 'Scripted original child approval' },
          allowedActions: ['approve', 'deny'],
          allowedPrincipalIds: request.approval.allowedPrincipalIds,
          requestedAt: request.approval.requestedAt,
          expiresAt: request.approval.expiresAt,
        })
        await interactions.respond({
          interactionId: pending.interactionId,
          executionId: request.executionId,
          attemptId: request.attemptId,
          expectedVersion: pending.version,
          responseId: 'cmd_01JABCDEF0123456789ABCDEFG',
          action: 'approve',
          respondingPrincipalId: actor,
          respondedAt: clock,
        })
        const approval = {
          interactionId: pending.interactionId,
          principalRef: actor,
          grantRef: 'approval:scripted-original',
          grantRevision: 1,
        }
        writeFileSync(
          join(directory, 'current-authority.json'),
          JSON.stringify({
            revoked: false,
            actorActive: true,
            scopeActive: true,
            providerActive: true,
            spendingActive: true,
            canonicalActorPrincipalId: actor,
            authorityRevision: metadata.admission.authority.revision,
            approval,
            selection: metadata.admission.selection,
            budget: metadata.request.attemptBudget,
          }),
          { mode: 0o600 }
        )
        const grant = PiChildContinuationGrantSchema.parse({
          schemaVersion: 'pi-child-continuation/v1',
          grantRef: `pcc_${'c'.repeat(32)}`,
          workspaceId: metadata.request.executionPlan.correlation.workspaceId,
          canonicalActorPrincipalId: actor,
          parent: {
            executionId: input.authority.request.executionId,
            attemptId: input.authority.request.attemptId,
            executionPlan: pin(input.authority.request.executionPlan),
            runtime:
              (await ports.executions.getAttempt(input.authority.request.attemptId)).runtime ??
              null,
          },
          child: {
            executionId: metadata.request.executionId,
            attemptId: metadata.request.attemptId,
            executionPlan: pin(metadata.request.executionPlan),
            handle: childRow.admission.handle,
            runtime:
              (await ports.executions.getAttempt(metadata.request.attemptId)).runtime ?? null,
            admissionDigest: piChildContinuationAdmissionDigest(metadata.admission),
            startRequestDigest: piChildContinuationStartRequestDigest(metadata.request),
          },
          source: input.source.source,
          sourceKey: input.source.sourceKey,
          requestDigest: piChildContinuationRequestDigest(request),
          admittedToolCallId: request.toolCallId,
          approval,
          selection: metadata.admission.selection,
          budget: metadata.request.attemptBudget,
          authorityRevision: metadata.admission.authority.revision,
          createdAt: clock,
          expiresAt,
        })
        if (mode === 'before_grant_retention') {
          appendProcessEvidence(directory, {
            stage: 'before_grant_retention',
            pid: process.pid,
            handle: childRow.admission.handle,
          })
          process.stdout.write(`${JSON.stringify({ stage: 'before_grant_retention' })}\n`)
          await new Promise(() => {})
        }
        if (mode === 'fast_child_terminal_before_grant') {
          await childRuntime.adapter.drain()
          const terminalRow = childRuntime.adapter.journal.list()[0]
          assert.ok(fastNativeInspection, 'native terminal metadata was not captured before close')
          const generation = fastNativeInspection.tasks.find(
            (item) => item.record.kind === 'pi.generation'
          )
          let grantDenied = false
          let grantDenialCode
          try {
            await ports.repository.retain(grant)
          } catch (error) {
            grantDenied = true
            grantDenialCode = error instanceof Error ? error.message : 'NON_ERROR_RETENTION_FAILURE'
          }
          fastTerminalSnapshot = {
            ...(await inspectProcessSnapshot(directory, childRuntime.adapter.journal, ports)),
            stage: 'fast_terminal_snapshot',
            childNativeState: terminalRow.state,
            childNativeTask: generation?.record ?? null,
            grantDenied,
            ...(grantDenialCode ? { grantDenialCode } : {}),
            physicalSendCount,
            source: input.source,
            sourceRequestDigest: piChildContinuationRequestDigest(request),
          }
          appendProcessEvidence(directory, fastTerminalSnapshot)
          process.stdout.write(`${JSON.stringify(fastTerminalSnapshot)}\n`)
          return
        }
        await ports.repository.retain(grant)
        metadata = { ...metadata, grant }
        writeProcessDescriptor(directory, metadata)
        appendProcessEvidence(directory, { stage: 'grant_retained', grant })
      },
    })
    appendProcessEvidence(directory, { stage: 'lead_start_enter', pid: process.pid })
    const leadHandle = await f.leadRuntime.adapter.start(f.leadRequest)
    appendProcessEvidence(directory, { stage: 'lead_start_return', pid: process.pid })
    await f.leadRuntime.adapter.drain()
    assert.equal((await f.leadRuntime.adapter.status(leadHandle)).state, 'completed')
    if (mode === 'fast_child_terminal_before_grant') {
      assert.ok(fastTerminalSnapshot, 'fast child retention observation missing')
      return fastTerminalSnapshot
    }
    assert.ok(metadata.grant)
    for (const item of ['attempt', 'execution']) {
      const row =
        item === 'attempt'
          ? await f.storage.executions.getAttempt(f.leadRequest.attemptId)
          : await f.storage.executions.getExecution(f.ids.parentExecutionId)
      await f.host.lifecycle[item === 'attempt' ? 'transitionAttempt' : 'transitionExecution']({
        ...(item === 'attempt' ? { attemptId: row.attemptId } : { executionId: row.executionId }),
        expectedVersion: row.version,
        to: 'completed',
        transitionedAt: clock,
      })
    }
    appendProcessEvidence(directory, { stage: 'parent_completed', leadHandle })
    process.stdout.write(`${JSON.stringify({ stage: 'parent_completed' })}\n`)
    await new Promise(() => {})
  } finally {
    clearInterval(heartbeat)
    await f?.close()
    await ports?.provider.close()
  }
}

/** Read-only metadata; this does not qualify a grant for sending or resuming. */
export async function readProcessGrantMetadata(ports, attemptId) {
  const { PiChildContinuationGrantSchema } = await importProcessProduction(
    '../packages/pi-durable-adapter/src/child-continuation.ts'
  )
  return ports.provider.transaction(async (tx) => {
    const row = await tx.get('pi-child-continuations', processRecordId(attemptId))
    if (!row) return null
    const grant = PiChildContinuationGrantSchema.parse(row.value)
    assert.equal(grant.child.attemptId, attemptId)
    assert.equal(grant.workspaceId, 'wsp_01JABCDEF0123456789ABCDEFG')
    return grant
  })
}

export async function inspectProcessSnapshot(directory, journal, ports) {
  const { DurableUsageLedger } = await import('@control-plane/usage-ledger')
  const descriptor = ports.descriptor()
  const row = journal.list()[0]
  const grant = await readProcessGrantMetadata(ports, row.attemptId)
  if (grant && descriptor.grant) assert.deepEqual(grant, descriptor.grant)
  const ledger = new DurableUsageLedger({
    store: new ports.sqlite.SqliteDurableUsageStore(ports.provider),
    now: () => processClock(directory),
  })
  const entries = await ledger.entries(
    descriptor.request.attemptBudget.workspaceId,
    descriptor.request.executionId
  )
  const released = new Set(
    entries.filter((entry) => entry.kind === 'model_release').map((entry) => entry.modelCallId)
  )
  const inbox = new ports.sqlite.SqliteDelegationEventPublisher(
    ports.provider,
    'exe_01JABCDEF0123456789ABCDEFG'
  )
  const events = await inbox.list()
  return {
    stage: 'recovery_snapshot',
    ...processProductionEvidence(),
    pid: process.pid,
    state: row.state,
    handle: row.admission.handle,
    grant,
    parentState: (await ports.executions.getExecution('exe_01JABCDEF0123456789ABCDEFG')).state,
    childState: (await ports.executions.getExecution(descriptor.request.executionId)).state,
    modelUsageCount: entries.filter((entry) => entry.kind === 'model_usage').length,
    openHoldCount: entries.filter(
      (entry) => entry.kind === 'model_reservation' && !released.has(entry.modelCallId)
    ).length,
    inboxTerminalCount: events.filter((event) =>
      ['completed', 'failed', 'cancelled'].includes(event.type?.split('.').at(-1) ?? event.state)
    ).length,
    journalReceipts: row.detail.inferenceReceipts ?? {},
    ...(row.detail.result ? { result: row.detail.result } : {}),
  }
}

/** Exact no-send proof for this test worker; unknown physical dispatch never qualifies. */
export async function assertProcessNoSend(directory, authority, engine, ledger) {
  const evidence = readProcessEvidence(directory).filter(
    (event) => event.stage === 'before_reservation'
  )
  assert.equal(evidence.length, 1, 'exact one pre-reservation checkpoint')
  const retained = evidence[0]
  try {
    process.kill(retained.pid, 0)
    assert.fail('original process is still alive')
  } catch (error) {
    assert.equal(error.code, 'ESRCH', 'original process death must be authoritative')
  }
  assert.equal(retained.handle.attemptId, authority.request.attemptId)
  const native = await engine.inspect(retained.handle.externalSessionId)
  const tasks = native.tasks.filter((item) => item.record.kind === 'pi.generation')
  assert.equal(tasks.length, 1)
  for (const field of ['id', 'kind', 'input', 'conversationId', 'owner']) {
    assert.deepEqual(tasks[0].record[field], retained.task[field], `same native ${field}`)
  }
  assert.deepEqual(
    tasks[0].record.state.checkpoint,
    retained.task.state.checkpoint,
    'same retained native request checkpoint'
  )
  assert.equal(tasks[0].record.state.checkpoint.phase, 'request')
  assert.equal(
    retained.key,
    `pi-turn:${authority.request.attemptId}:initial:pi-generation:${retained.task.id}`
  )
  const entries = await ledger.entries(
    authority.request.attemptBudget.workspaceId,
    authority.request.executionId
  )
  assert.equal(
    entries.filter((entry) => entry.kind === 'model_reservation').length,
    0,
    'any dispatch history denies safe resend'
  )
  assert.equal(entries.filter((entry) => entry.kind === 'model_usage').length, 0)
}

export async function completeProcessParent(ports, directory) {
  const { ExecutionLifecycleService } = await import('@control-plane/domain')
  const lifecycle = new ExecutionLifecycleService(ports.executions)
  for (const item of ['attempt', 'execution']) {
    const row =
      item === 'attempt'
        ? await ports.executions.getAttempt('att_01JABCDEF0123456789ABCDEFG')
        : await ports.executions.getExecution('exe_01JABCDEF0123456789ABCDEFG')
    if (row.state === 'completed') continue
    await lifecycle[item === 'attempt' ? 'transitionAttempt' : 'transitionExecution']({
      ...(item === 'attempt' ? { attemptId: row.attemptId } : { executionId: row.executionId }),
      expectedVersion: row.version,
      to: 'completed',
      transitionedAt: processClock(directory),
    })
  }
}

export async function publishProcessTerminal(directory, ports, runtime) {
  const { DelegationService, CanonicalDelegationRuntimeBridge } =
    await import('@control-plane/orchestration')
  const { ExecutionLifecycleService } = await import('@control-plane/domain')
  const { PiDurableChildProgressScanner } = await importProcessProduction(
    '../apps/control-api/src/pi-durable/child-progress-scanner.ts'
  )
  const descriptor = ports.descriptor()
  const grant = await readProcessGrantMetadata(ports, descriptor.request.attemptId)
  assert.ok(grant)
  const records = new ports.sqlite.SqliteDelegationRepository(ports.provider)
  const events = new ports.sqlite.SqliteDelegationEventPublisher(
    ports.provider,
    grant.parent.executionId
  )
  const lifecycle = new ExecutionLifecycleService(ports.executions)
  const delegations = new DelegationService({
    delegations: records,
    lifecycle,
    plans: ports.plans,
    events,
  })
  const forbidden = async () => {
    throw new Error('PROCESS_RECOVERY_FRESH_START_FORBIDDEN')
  }
  const bridge = new CanonicalDelegationRuntimeBridge({
    records,
    lifecycle,
    plans: ports.plans,
    delegations,
    runtime: { start: forbidden },
    runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG',
    assertAuthority: forbidden,
    reserveBudget: forbidden,
  })
  const scanner = new PiDurableChildProgressScanner({
    now: () => processClock(directory),
    bridge,
    listRetainedChildren: async () => [
      {
        identity: {
          schemaVersion: 'delegation-runtime-admission/v1',
          parentExecutionId: grant.parent.executionId,
          parentAttemptId: grant.parent.attemptId,
          delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
          childAttemptId: grant.child.attemptId,
        },
        handle: grant.child.handle,
        canonicalState: (await ports.executions.getAttempt(grant.child.attemptId)).state,
      },
    ],
    assertCurrent: async (retained) => {
      await ports.authority.assertPublication(grant)
      const record = await records.get(retained.identity.delegationId)
      assert.equal(record.parentExecutionId, grant.parent.executionId)
      assert.equal(record.parentAttemptId, grant.parent.attemptId)
      assert.equal(record.childAttemptId, grant.child.attemptId)
      const row = runtime.adapter.journal.get(retained.handle.handleId)
      assert.deepEqual(row.admission.handle, grant.child.handle)
      assert.deepEqual(row.admission.request, descriptor.request)
    },
    retainTerminalResult: async (retained, result) => {
      await ports.provider.transaction(async (tx) => {
        const existing = await tx.get('pi-child-terminal-results', retained.identity.childAttemptId)
        if (existing) assert.deepEqual(existing.value, result)
        else
          await tx.put({
            namespace: 'pi-child-terminal-results',
            id: retained.identity.childAttemptId,
            value: JSON.parse(JSON.stringify(result)),
          })
      })
      return 'art_01JBBCDEF0123456789ABCDEFG'
    },
  })
  return scanner.scan(runtime.adapter)
}

export async function recoveryWorker(directory, mode, baseUrl) {
  const { SqliteDurableJournal } = await importProcessProduction(
    '../packages/pi-durable-adapter/src/journal.ts'
  )
  const { createNodePiDurableRuntime } = await importProcessProduction(
    '../packages/pi-durable-adapter/src/composition.ts'
  )
  const { createPiDurableEngine } = await importProcessProduction(
    '../packages/pi-durable-adapter/src/pi-engine.ts'
  )
  const { createPiDurableUsageAuthority } = await importProcessProduction(
    '../packages/pi-durable-adapter/src/usage-authority.ts'
  )
  const { DurableUsageLedger, PinnedModelPrice } = await import('@control-plane/usage-ledger')
  const observer = new SqliteDurableJournal(join(directory, 'child-runtime', 'authority.sqlite'))
  let runtime, probe, ports
  try {
    ports = await continuationPorts(directory, () => runtime?.adapter.journal ?? observer)
    const descriptor = ports.descriptor()
    const row = observer.list()[0]
    const authority = { request: descriptor.request, admission: descriptor.admission }
    assert.deepEqual(row.admission.request, authority.request)
    assert.deepEqual(row.admission.admission, authority.admission)
    if (mode === 'recover_without_grant' || mode === 'complete_parent')
      await completeProcessParent(ports, directory)
    if (
      mode === 'complete_parent' ||
      (mode === 'inspect' && !['completed', 'failed', 'cancelled', 'timed_out'].includes(row.state))
    ) {
      const snapshot = await inspectProcessSnapshot(directory, observer, ports)
      process.stdout.write(`${JSON.stringify(snapshot)}\n`)
      return snapshot
    }
    if (mode === 'replay_grant') {
      const grant = await readProcessGrantMetadata(ports, descriptor.request.attemptId)
      assert.ok(grant)
      assert.deepEqual(grant, descriptor.grant)
      const originalReplay = await ports.repository.retain(grant)
      assert.equal(originalReplay.replayed, true)
      assert.deepEqual(originalReplay.grant, grant)
      assert.deepEqual(await readProcessGrantMetadata(ports, descriptor.request.attemptId), grant)
      let replayChangedDenied = true
      for (const changed of [
        { ...grant, expiresAt: '2026-08-25T18:09:01.000Z' },
        { ...grant, requestDigest: `sha256:${'d'.repeat(64)}` },
        {
          ...grant,
          child: {
            ...grant.child,
            handle: { ...grant.child.handle, externalSessionId: 'changed-session' },
          },
        },
      ]) {
        try {
          await ports.repository.retain(changed)
          replayChangedDenied = false
        } catch {
          /* Real immutable repository rejects replacement. */
        }
      }
      assert.deepEqual(await readProcessGrantMetadata(ports, descriptor.request.attemptId), grant)
      const snapshot = {
        ...(await inspectProcessSnapshot(directory, observer, ports)),
        replayOriginalRetained: true,
        replayChangedDenied,
      }
      appendProcessEvidence(directory, snapshot)
      process.stdout.write(`${JSON.stringify(snapshot)}\n`)
      return snapshot
    }
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(row.state)) {
      // Receipt replay uses actual adapter readers and publication authority only.
      // No native engine, inference reconciliation or grant refresh is constructed.
      const forbidden = async () => {
        throw new Error('PROCESS_TERMINAL_INFERENCE_FORBIDDEN')
      }
      runtime = await createNodePiDurableRuntime({
        directory: join(directory, 'child-runtime'),
        now: () => processClock(directory),
        resolveAdmission: forbidden,
        assertAuthority: (input) => ports.authority.assertAuthority(input),
        resolveProvider: forbidden,
        authorizeInference: forbidden,
        settleUsage: forbidden,
        reconcileInference: forbidden,
      })
      const publication = await publishProcessTerminal(directory, ports, runtime)
      const snapshot = {
        ...(await inspectProcessSnapshot(directory, runtime.adapter.journal, ports)),
        publication,
      }
      appendProcessEvidence(directory, snapshot)
      process.stdout.write(`${JSON.stringify(snapshot)}\n`)
      return snapshot
    }
    const ledger = new DurableUsageLedger({
      store: new ports.sqlite.SqliteDurableUsageStore(ports.provider),
      now: () => '2026-08-25T18:01:00.000Z',
    })
    const assertAuthority = (input) => ports.authority.assertAuthority(input)
    const price = new PinnedModelPrice(
      {
        schemaVersion: 1,
        deploymentId: 'pi-child-fixture',
        provider: 'child-loopback',
        model: 'separate-child-model',
        version: 'price:child:1',
        currency: 'USD',
        fundingSource: 'byo_api',
        validFrom: '2026-08-25T18:01:00.000Z',
        validUntil: '2026-09-01T00:00:00.000Z',
        maximumInputTokens: 1024,
        maximumOutputTokens: 32,
        ratesMicrounitsPerMillionTokens: { input: 1000000, cachedInput: 500000, output: 2000000 },
      },
      { now: () => processClock(directory) }
    )
    const usage = createPiDurableUsageAuthority({
      ledger,
      resolvePrice: async (input) => {
        await assertAuthority(input)
        return { price, maximumOutputTokens: 32 }
      },
      assertSpendingAuthorized: async (input) => {
        await assertAuthority(input)
        return {
          authorizationRef: 'model-spend:child:fixture',
          evidenceDigest: `sha256:${'b'.repeat(64)}`,
          assertActive: () => assertAuthority(input),
        }
      },
    })
    probe = createPiDurableEngine({
      directory: join(directory, 'child-runtime', 'sessions'),
      model: { provider: 'child-loopback', modelId: 'separate-child-model' },
      maxOutputTokens: 32,
      assertAuthority: () => assertAuthority(authority),
      withModels: (use) => withChildProcessModels(baseUrl, use),
    })
    let reconciled = false
    // No grant means strict fresh admission remains authoritative and denies a completed parent.
    await ports.authority.assertResume(authority, row.admission.handle)
    runtime = await createNodePiDurableRuntime({
      directory: join(directory, 'child-runtime'),
      now: () => processClock(directory),
      resolveAdmission: async (request) => {
        assert.deepEqual(request, descriptor.request)
        return descriptor.admission
      },
      assertAuthority,
      scopeAuthority: {
        readCurrent: async (input) => ({
          ...input,
          principalActive: true,
          grantActive: true,
          allowedPrincipalIds: [actor],
          expiresAt: '2026-09-01T00:00:00.000Z',
          ...(input.executionScope.kind === 'project'
            ? { projectWorkspaceId: input.workspaceId }
            : {}),
        }),
      },
      resolveProvider: async (selection, input) => {
        await assertAuthority(input)
        assert.deepEqual(selection, descriptor.admission.selection)
        return { ...descriptor.binding, withModels: (use) => withChildProcessModels(baseUrl, use) }
      },
      authorizeInference: usage.authorizeInference,
      settleUsage: usage.settleUsage,
      reconcileInference: async (input) => {
        try {
          await ports.authority.assertResume(input, row.admission.handle)
          await assertProcessNoSend(directory, input, probe, ledger)
          reconciled = true
          return 'safe_to_resume'
        } catch {
          return 'unresolved'
        }
      },
    })
    await runtime.adapter.drain()
    const status = await runtime.adapter.status(row.admission.handle)
    let publication
    if (status.state === 'completed')
      publication = await publishProcessTerminal(directory, ports, runtime)
    const snapshot = {
      ...(await inspectProcessSnapshot(directory, runtime.adapter.journal, ports)),
      reconciled,
      ...(publication ? { publication } : {}),
    }
    appendProcessEvidence(directory, snapshot)
    process.stdout.write(`${JSON.stringify(snapshot)}\n`)
    return snapshot
  } catch (error) {
    const snapshot = {
      ...(await inspectProcessSnapshot(directory, runtime?.adapter.journal ?? observer, ports)),
      blocked: true,
      reason: error.message,
    }
    appendProcessEvidence(directory, snapshot)
    process.stdout.write(`${JSON.stringify(snapshot)}\n`)
    return snapshot
  } finally {
    await runtime?.close()
    await probe?.close()
    observer.close()
    await ports?.provider.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory, mode, baseUrl] = process.argv.slice(2)
  if (!globalThis.Bun && !emittedProcessProduction) await registerProcessSourceHooks()
  if (
    [
      'before_reservation',
      'ambiguous_send',
      'before_grant_retention',
      'fast_child_terminal_before_grant',
    ].includes(mode)
  )
    await initialWorker(directory, mode, baseUrl)
  else await recoveryWorker(directory, mode, baseUrl)
}
