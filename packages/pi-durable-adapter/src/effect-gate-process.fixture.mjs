import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { InteractionService } from '@control-plane/domain'
import {
  InMemoryToolRateLimiter,
  InMemoryToolRegistryRepository,
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
  ToolGateway,
  ToolRegistry,
} from '@control-plane/tool-execution'
import { PiDurableEffectGate, SqliteDurableEffectGateStore } from './effect-gate.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const keyFor = (request) => JSON.stringify([request.workspaceId, request.idempotencyKey])

// Fixture repositories retain real service transitions; no gate row or call status is fabricated.
function records(database, table, identifier, revision) {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, revision INTEGER, record TEXT)`
  )
  return {
    async get(recordId) {
      const row = database.prepare(`SELECT record FROM ${table} WHERE id = ?`).get(recordId)
      return row ? JSON.parse(row.record) : undefined
    },
    async insert(record) {
      return (
        database
          .prepare(`INSERT OR IGNORE INTO ${table} VALUES (?, ?, ?)`)
          .run(record[identifier], record[revision], JSON.stringify(record)).changes === 1
      )
    },
    async compareAndSet(expected, record) {
      return (
        database
          .prepare(`UPDATE ${table} SET revision = ?, record = ? WHERE id = ? AND revision = ?`)
          .run(record[revision], JSON.stringify(record), record[identifier], expected).changes === 1
      )
    },
    async getByIdempotencyKey(workspaceId, idempotencyKey) {
      return database
        .prepare(`SELECT record FROM ${table}`)
        .all()
        .map((row) => JSON.parse(row.record))
        .find(
          (record) => record.workspaceId === workspaceId && record.idempotencyKey === idempotencyKey
        )
    },
    async listByExecution(executionId) {
      return database
        .prepare(`SELECT record FROM ${table}`)
        .all()
        .map((row) => JSON.parse(row.record))
        .filter((record) => record.executionId === executionId)
    },
    async listForAttempt(executionId, attemptId) {
      return (await this.listByExecution(executionId)).filter(
        (record) => record.attemptId === attemptId
      )
    },
  }
}

function openStores(directory) {
  const journal = new DatabaseSync(join(directory, 'journal.sqlite'))
  const effects = new DatabaseSync(join(directory, 'external-effects.sqlite'))
  for (const database of [journal, effects]) {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
  }
  effects.exec(
    'CREATE TABLE IF NOT EXISTS effects (sequence INTEGER PRIMARY KEY, identity TEXT NOT NULL)'
  )
  return {
    journal,
    effects,
    calls: records(journal, 'calls', 'toolCallId', 'revision'),
    interactions: records(journal, 'interactions', 'interactionId', 'version'),
    store: new SqliteDurableEffectGateStore(journal),
    close() {
      effects.close()
      journal.close()
    },
  }
}

async function seedEffectGateProcessFixture(directory, { approved = true } = {}) {
  const at = new Date().toISOString()
  const expiresAt = new Date(Date.parse(at) + 60 * 60 * 1000).toISOString()
  const request = {
    requestId: id('req'),
    toolCallId: id('tlc'),
    executionId: id('exe'),
    attemptId: id('att'),
    workspaceId: id('wsp'),
    profileId: id('prf'),
    toolDefinitionId: id('tld'),
    toolVersionId: id('tlv'),
    operation: 'write',
    input: { value: 'hello' },
    idempotencyKey: '935-process-effect',
    requestedAt: at,
    policySnapshotRef: 'policy://workspace/v1',
    grant: {
      workspaceId: id('wsp'),
      profileId: id('prf'),
      toolDefinitionId: id('tld'),
      toolVersionId: id('tlv'),
      operations: ['write'],
      expiresAt,
    },
    audit: { principalRef: 'service:runtime-worker', traceId: id('trc') },
    approval: {
      interactionId: id('int'),
      allowedPrincipalIds: ['principal:owner'],
      requestedAt: at,
      expiresAt,
    },
  }
  await writeFile(join(directory, 'request.json'), JSON.stringify(request))
  const stores = openStores(directory)
  try {
    const interactions = new InteractionService(stores.interactions)
    await interactions.request({
      ...request.approval,
      executionId: request.executionId,
      attemptId: request.attemptId,
      kind: 'approval',
      prompt: {
        title: 'Write record',
        detailsReference: `artifact://tool-call/${request.toolCallId}`,
      },
      allowedActions: ['approve', 'deny'],
    })
    if (approved)
      await interactions.respond({
        interactionId: request.approval.interactionId,
        executionId: request.executionId,
        attemptId: request.attemptId,
        expectedVersion: 1,
        responseId: id('cmd'),
        respondingPrincipalId: 'principal:owner',
        action: 'approve',
        respondedAt: at,
      })
    return request
  } finally {
    stores.close()
  }
}

async function run(directory, mode) {
  // Seed through Node too: the proof never mixes Bun's SQLite shim with the Node store owner.
  if (mode === 'seed' || mode === 'seed_pending') {
    const request = await seedEffectGateProcessFixture(directory, { approved: mode === 'seed' })
    process.stdout.write(`${JSON.stringify({ boundary: 'finished', request })}\n`)
    return
  }
  const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'))
  const stores = openStores(directory)
  const authorityChecks = []
  let keepAlive
  const snapshot = async () => ({
    gateRecord: await stores.store.get(keyFor(request)),
    call: await stores.calls.get(request.toolCallId),
    approval: await stores.interactions.get(request.approval.interactionId),
    effects: stores.effects
      .prepare('SELECT sequence, identity FROM effects ORDER BY sequence')
      .all()
      .map((row) => ({ sequence: row.sequence, identity: JSON.parse(row.identity) })),
    authorityChecks,
  })
  const emit = (evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`)
  try {
    const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
    await registry.createDefinition({
      toolDefinitionId: request.toolDefinitionId,
      name: 'records.write',
      displayName: 'Write record',
      description: 'Durable local test effect.',
      ownership: { scope: 'workspace', workspaceId: request.workspaceId },
      createdAt: request.requestedAt,
    })
    await registry.publishVersion({
      toolDefinitionId: request.toolDefinitionId,
      toolVersionId: request.toolVersionId,
      semanticVersion: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { saved: { type: 'boolean' } },
        required: ['saved'],
        additionalProperties: false,
      },
      operations: [
        {
          name: 'write',
          requiredCapabilities: ['records.write'],
          riskClass: 'high',
          approvalMode: 'always',
          idempotency: 'provider_key',
          retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
        },
      ],
      executor: { type: 'connector', reference: '935-local-effect' },
      limits: { maxInputBytes: 256, maxOutputBytes: 256, timeoutMs: 30000 },
      createdAt: request.requestedAt,
      publishedAt: request.requestedAt,
    })
    const gateway = new ToolGateway(registry)
    gateway.registerExecutor('connector', '935-local-effect', {
      async execute(input) {
        // Every invocation appends a row: no executor-side deduplication can hide a replay.
        stores.effects
          .prepare('INSERT INTO effects (identity) VALUES (?)')
          .run(JSON.stringify(input))
        if (mode === 'crash') {
          emit({ boundary: 'effect_committed', ...(await snapshot()) })
          keepAlive = setInterval(() => {}, 1000)
          await new Promise(() => {})
        }
        return { output: { saved: true } }
      },
    })
    const service = new PolicyControlledToolExecutionService({
      gateway,
      calls: stores.calls,
      authorizer: new StaticToolPolicyAuthorizer({
        effect: 'allow',
        decisionId: 'decision-935',
        policyVersion: 'v1',
        reasonCode: 'GRANTED',
        requiresApproval: true,
        evaluatedAt: request.requestedAt,
      }),
      approvals: new InteractionToolApprovalCoordinator(
        new InteractionService(stores.interactions),
        stores.interactions
      ),
      rateLimiter: new InMemoryToolRateLimiter(),
    })
    const gate = new PiDurableEffectGate({
      store: stores.store,
      service,
      assertAuthority: async (current, boundary) => {
        authorityChecks.push(boundary)
        if (
          mode === 'revoked' ||
          canonicalJsonStringify(current) !== canonicalJsonStringify(request)
        )
          throw new Error('authority-rejected')
      },
    })
    let outcome, error
    try {
      outcome = await gate.execute(
        mode === 'changed' ? { ...request, input: { value: 'changed' } } : request
      )
    } catch (caught) {
      error = caught.code ?? caught.message
    }
    emit({ boundary: 'finished', ...(outcome ? { outcome } : { error }), ...(await snapshot()) })
  } finally {
    clearInterval(keepAlive)
    stores.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run(process.argv[2], process.argv[3])
}
