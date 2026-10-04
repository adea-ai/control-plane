import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlApiFixtures } from '@control-plane/contracts'
import { ExecutionSchema, ExecutionAttemptSchema, InteractionService } from '@control-plane/domain'
import {
  PostgresInteractionRepository,
  PostgresMemoryWriteProposalRepository,
  executions,
  executionAttempts,
} from '@control-plane/database'
import { SqliteMemoryWriteProposalRepository } from '@control-plane/sqlite-persistence'

const marker = 'M11_MEMORY_EFFECT_COMMITTED'
const fixturePath = fileURLToPath(import.meta.url)
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const content = 'A bounded crash recovery preference'
const input = {
  proposalId: 'mwp_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  providerId: 'ctp_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  connectionId: 'ctc_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  workspaceId: ControlApiFixtures.executionAcceptance.request.workspaceId,
  scopeDigest: `sha256:${'a'.repeat(64)}`,
  memoryType: 'preference',
  content,
  contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  retention: 'project',
  dedupeHint: 'memory-process-loss',
  provenance: {
    sourceExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
    sourceAttemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
    confidence: 0.9,
    importance: 0.8,
    sensitivity: 'internal',
    evidenceRefs: [],
    artifactRefs: [],
  },
}
const policy = {
  mode: 'approval_required',
  maximumBytes: 1024,
  allowedSensitivities: ['internal'],
  approvalPrincipalIds: ['svc_agent-hq'],
}

async function readLedger(directory) {
  return JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8'))
}
async function writeLedger(directory, value) {
  const temporary = join(directory, 'provider.json.tmp')
  const file = await open(temporary, 'w', 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, join(directory, 'provider.json'))
}
function provider(directory, interrupted) {
  return {
    providerId: input.providerId,
    connectionId: input.connectionId,
    workspaceId: input.workspaceId,
    scopeDigest: input.scopeDigest,
    capabilities: { writeCommit: interrupted, idempotentStatus: true },
    async write(request) {
      const ledger = await readLedger(directory)
      ledger.writeCalls++
      ledger.records[request.idempotencyKey] ??= 'memory://process-loss-fixture'
      await writeLedger(directory, ledger)
      if (interrupted) {
        // Signal only after both the root's commit intent and external fixture effect are durable.
        process.stdout.write(`${marker}\n`)
        await new Promise(() => {})
      }
      return { status: 'committed', providerMemoryRef: ledger.records[request.idempotencyKey] }
    },
    async status(key) {
      const ledger = await readLedger(directory)
      ledger.statusCalls++
      await writeLedger(directory, ledger)
      return ledger.records[key]
        ? { status: 'committed', providerMemoryRef: ledger.records[key] }
        : { status: 'unknown' }
    },
  }
}
async function openRoot(profile, directory, databaseUrl, interrupted, operations) {
  const writer = provider(directory, interrupted)
  const authority = {
    authorize: async (scope, operation) => {
      assert.deepEqual(scope, {
        providerId: input.providerId,
        connectionId: input.connectionId,
        workspaceId: input.workspaceId,
        scopeDigest: input.scopeDigest,
      })
      if (!interrupted && operation !== 'status')
        throw new Error('MEMORY_FIXTURE_FRESH_AUTHORITY_REVOKED')
      operations.push(operation)
    },
  }
  const memoryWriteback = {
    policy: interrupted ? policy : { ...policy, mode: 'disabled' },
    provider: writer,
    authority,
  }
  if (profile === 'local' || profile === 'hosted-simple') {
    const { LocalControlPlaneComposition } =
      await import('../../apps/local-control-plane/src/composition.ts')
    return new LocalControlPlaneComposition({ profile, dataDirectory: directory, memoryWriteback })
  }
  assert(databaseUrl, 'PostgreSQL fixture URL is required')
  if (profile === 'cloud') {
    const { createManagedCloudControlApiComposition } =
      await import('../../apps/control-api/src/cloud-composition.ts')
    const { publicKey } = generateKeyPairSync('ed25519')
    return createManagedCloudControlApiComposition(
      {
        service: 'control-api',
        database: { role: 'application', url: databaseUrl },
        serviceAuthentication: {
          audience: 'control-plane',
          issuer: 'https://memory-fixture.test',
          trustedKeys: [
            { keyId: 'memory-fixture', publicKey: publicKey.export({ format: 'jwk' }).x },
          ],
          revokedCredentialIds: [],
        },
        restate: { role: 'caller', ingressUrl: 'http://127.0.0.1:1' },
      },
      { write() {} },
      undefined,
      undefined,
      undefined,
      memoryWriteback
    )
  }
  assert.equal(profile, 'hosted-server')
  const { HostedServerControlPlaneComposition } =
    await import('../../apps/hosted-control-plane/src/composition.ts')
  return new HostedServerControlPlaneComposition({
    databaseUrl,
    dataDirectory: directory,
    endpointFactory: {
      create: async () => {
        throw new Error('MEMORY_FIXTURE_UNEXPECTED_ENDPOINT')
      },
    },
    memoryWriteback,
  })
}
function repositories(root) {
  return root.persistence
    ? {
        proposals: new SqliteMemoryWriteProposalRepository(root.persistence),
        interactions: root.interactions,
      }
    : {
        proposals: new PostgresMemoryWriteProposalRepository(root.connection.database),
        interactions: new PostgresInteractionRepository(root.connection.database),
      }
}
async function seedOwner(root) {
  const acceptedAt = new Date().toISOString()
  const request = ControlApiFixtures.executionAcceptance.request
  const executionId = input.provenance.sourceExecutionId
  const attemptId = input.provenance.sourceAttemptId
  if (root.persistence) {
    await root.persistence.migrate()
    const key = (id) => `r-${createHash('sha256').update(id).digest('hex')}`
    await root.persistence.transaction(async (transaction) => {
      await transaction.put({
        namespace: 'executions',
        id: key(executionId),
        value: ExecutionSchema.parse({
          executionId,
          state: 'queued',
          version: 2,
          correlation: {
            workspaceId: input.workspaceId,
            projectId: request.projectId,
            taskId: request.payload.taskId,
            agentId: request.payload.agentId,
            requestId: request.requestId,
          },
          executionPlan: request.payload.executionPlan,
          attemptCount: 1,
          latestAttemptId: attemptId,
          acceptedAt,
          queuedAt: acceptedAt,
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        }),
      })
      await transaction.put({
        namespace: 'execution-attempts',
        id: key(attemptId),
        value: ExecutionAttemptSchema.parse({
          attemptId,
          executionId,
          sequence: 1,
          state: 'queued',
          version: 1,
          acceptedAt,
          queuedAt: acceptedAt,
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        }),
      })
    })
  } else {
    await root.connection.check()
    await root.connection.database.insert(executions).values({
      executionId,
      state: 'completed',
      version: 2,
      workspaceId: input.workspaceId,
      projectId: request.projectId,
      taskId: request.payload.taskId,
      agentId: request.payload.agentId,
      requestId: request.requestId,
      executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      executionPlanDigest: `sha256:${'b'.repeat(64)}`,
      executionPlanSchemaVersion: 1,
      attemptCount: 1,
      latestAttemptId: attemptId,
      acceptedAt: new Date(acceptedAt),
      terminalAt: new Date(acceptedAt),
      createdAt: new Date(acceptedAt),
      updatedAt: new Date(acceptedAt),
    })
    await root.connection.database.insert(executionAttempts).values({
      attemptId,
      executionId,
      sequence: 1,
      state: 'completed',
      version: 1,
      acceptedAt: new Date(acceptedAt),
      terminalAt: new Date(acceptedAt),
      createdAt: new Date(acceptedAt),
      updatedAt: new Date(acceptedAt),
    })
  }
}
async function runChild() {
  // A bounded timer keeps the interrupted write alive; the parent kills this exact PID.
  const deadline = setTimeout(() => process.exit(2), 10_000)
  try {
    const root = await openRoot(
      process.env.MEMORY_LOSS_PROFILE,
      process.env.MEMORY_LOSS_DIRECTORY,
      process.env.MEMORY_LOSS_DATABASE_URL,
      true,
      []
    )
    await seedOwner(root)
    const requestedAt = new Date().toISOString()
    const pending = await root.memoryWrites.propose(input, {
      interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      requestedAt,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })
    await new InteractionService(repositories(root).interactions).respond({
      interactionId: pending.approvalInteractionId,
      executionId: input.provenance.sourceExecutionId,
      attemptId: input.provenance.sourceAttemptId,
      responseId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      action: 'approve',
      respondingPrincipalId: 'svc_agent-hq',
      expectedVersion: 1,
      respondedAt: new Date().toISOString(),
    })
    await root.memoryWrites.applyApproval(pending.proposalId)
    await root.memoryWrites.commit(pending.proposalId)
    throw new Error('MEMORY_FIXTURE_DID_NOT_INTERRUPT')
  } finally {
    clearTimeout(deadline)
  }
}

export async function disposeMemoryRootProcessLoss({ child, closed, root, directory, profile }) {
  try {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (closed) await closed
  } finally {
    try {
      await root?.persistence?.close()
    } finally {
      try {
        await root?.connection?.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
        console.info(
          JSON.stringify({ fixture: 'memory-process-loss', event: 'removed', profile, directory })
        )
      }
    }
  }
}

/** One disposable child and directory. Never starts a workflow runtime, HTTP listener or Docker. */
export async function exerciseMemoryRootProcessLoss(profile, databaseUrl) {
  const directory = await mkdtemp(join(tmpdir(), 'cp-m11-memory-loss-'))
  let child, closed, root, readyTimer
  let receipt
  try {
    await writeLedger(directory, { writeCalls: 0, statusCalls: 0, records: {} })
    console.info(
      JSON.stringify({
        fixture: 'memory-process-loss',
        event: 'planned',
        profile,
        directory,
        cwd: repositoryRoot,
        port: null,
      })
    )
    child = spawn(process.execPath, [fixturePath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MEMORY_LOSS_PROFILE: profile,
        MEMORY_LOSS_DIRECTORY: directory,
        ...(databaseUrl ? { MEMORY_LOSS_DATABASE_URL: databaseUrl } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.info(
      JSON.stringify({
        fixture: 'memory-process-loss',
        event: 'started',
        profile,
        pid: child.pid,
        directory,
        port: null,
      })
    )
    closed = new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal }))
    )
    await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      readyTimer = setTimeout(() => reject(new Error('MEMORY_FIXTURE_READY_TIMEOUT')), 8_000)
      child.stdout.on('data', (data) => {
        stdout = (stdout + data).slice(-8192)
        if (stdout.includes(marker)) resolve()
      })
      child.stderr.on('data', (data) => {
        stderr = (stderr + data).slice(-1024)
      })
      child.once('error', reject)
      void closed.then(() => reject(new Error(`MEMORY_FIXTURE_EARLY_EXIT: ${stderr}`)))
    })
    clearTimeout(readyTimer)
    assert.equal(child.kill('SIGKILL'), true)
    const exit = await closed
    assert.equal(exit.signal, 'SIGKILL')
    console.info(
      JSON.stringify({
        fixture: 'memory-process-loss',
        event: 'reaped',
        profile,
        pid: child.pid,
        signal: exit.signal,
      })
    )
    const operations = []
    root = await openRoot(profile, directory, databaseUrl, false, operations)
    if (root.persistence) await root.persistence.migrate()
    const before = await repositories(root).proposals.get(input.proposalId)
    assert.equal(before.state, 'committing')
    assert.equal((await readLedger(directory)).writeCalls, 1)
    await assert.rejects(root.memoryWrites.propose(input), { code: 'MEMORY_WRITE_DISABLED' })
    const recovered = await root.memoryWrites.commit(input.proposalId)
    assert.equal(recovered.state, 'committed')
    assert.equal(recovered.outcome.code, 'reconciled')
    const {
      state: _state,
      version: _version,
      updatedAt: _updatedAt,
      outcome: _outcome,
      ...intent
    } = before
    const {
      state: _newState,
      version: _newVersion,
      updatedAt: _newUpdatedAt,
      outcome: _newOutcome,
      ...recoveredIntent
    } = recovered
    assert.deepEqual(recoveredIntent, intent)
    assert.equal(recovered.version, before.version + 1)
    assert.deepEqual(await root.memoryWrites.commit(input.proposalId), recovered)
    assert.deepEqual(operations, ['status'])
    const ledger = await readLedger(directory)
    assert.equal(ledger.writeCalls, 1)
    assert.equal(ledger.statusCalls, 1)
    assert.equal(Object.keys(ledger.records).length, 1)
    receipt = {
      profile,
      signal: exit.signal,
      persistedState: before.state,
      recoveredState: recovered.state,
      writeCalls: ledger.writeCalls,
      statusCalls: ledger.statusCalls,
      records: Object.keys(ledger.records).length,
      operations,
    }
  } finally {
    clearTimeout(readyTimer)
    await disposeMemoryRootProcessLoss({ child, closed, root, directory, profile })
  }
  return { ...receipt, fixtureRemoved: true, childReaped: true }
}
if (import.meta.main)
  runChild().catch(() => {
    process.stderr.write('MEMORY_LOSS_CHILD_FAILED\n')
    process.exit(1)
  })
