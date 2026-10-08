import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'
import {
  SqliteContextPackageRepository,
  SqliteExecutionEventRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqliteInteractionRepository,
  SqlitePersistenceProvider,
  SqliteRuntimeChannelSequenceRepository,
  SqliteRuntimeCommandRepository,
  SqliteRuntimeDiscoveryRepository,
} from '@control-plane/sqlite-persistence'
import {
  createSqliteRecordReader,
  hasWalSidecar,
  inspectStuckJobs,
  openReadOnlyInspectionDatabase,
} from './operator-inspection.ts'

// Deterministic clock: every seeded timestamp is written at 12:00-12:19 and the
// inspection reads at 12:20 with the default 15 minute staleness threshold.
const T0 = '2026-08-30T12:00:00.000Z'
const INSPECT_AT = '2026-08-30T12:20:00.000Z'
const DEADLINE = '2026-08-30T13:00:00.000Z'

const plan = createExecutionPlanTestFixture()
// The compiled fixture correlation owns the primary workspace.
const W1 = plan.correlation.workspaceId
const W2 = 'wsp_01BRZ3NDEKTSV4RRFFQ69G5FAW'
const W3 = 'wsp_01CRZ3NDEKTSV4RRFFQ69G5FAW'
const PRJ1 = plan.correlation.projectId
const PRJ_Z = 'prj_01ZRZ3NDEKTSV4RRFFQ69G5FAW'

// A second profile pinned by a second plan in the same workspace, so profile
// filtering must provably separate executions (and their human waits) instead
// of aggregating them.
const PROFILE_B = {
  profileId: 'prf_01BRZ3NDEKTSV4RRFFQ69G5FAW',
  profileVersionId: 'pfv_01BRZ3NDEKTSV4RRFFQ69G5FAW',
}
const planBInputs = createExecutionPlanTestFixtureInputs()
planBInputs.profile = { ...planBInputs.profile, ...PROFILE_B }
const planB = new ExecutionPlanCompiler('1.0.0').compile(planBInputs)

const SAFE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // 32 chars, no I/L/O/U
const id = (prefix, letter) => `${prefix}_01${letter}RZ3NDEKTSV4RRFFQ69G5FAV`
const idN = (prefix, n) => {
  if (!Number.isInteger(n) || n < 0 || n > SAFE_ALPHABET.length ** 2 - 1)
    throw new Error(`idN out of range: ${n}`)
  const high = SAFE_ALPHABET[Math.floor(n / SAFE_ALPHABET.length)]
  const low = SAFE_ALPHABET[n % SAFE_ALPHABET.length]
  return `${prefix}_01${high}${low}RZ3NDEKTSV4RRFFQ69G5FA`
}
const recordId = (value) => `r-${createHash('sha256').update(value).digest('hex')}`

const EXE = {
  stuck: id('exe', 'A'),
  human: id('exe', 'B'),
  effects: id('exe', 'C'),
  generation: id('exe', 'D'),
  revoked: id('exe', 'E'),
  missing: id('exe', 'F'),
  healthy: id('exe', 'G'),
  humanProfileB: id('exe', 'H'),
  ghostAttempt: id('exe', 'J'),
  otherWorkspace: id('exe', 'K'),
}
const ATT = {
  stuck: id('att', 'A'),
  human: id('att', 'B'),
  effects: id('att', 'C'),
  generation: id('att', 'D'),
  revoked: id('att', 'E'),
  missing: id('att', 'F'),
  healthy: id('att', 'G'),
  humanProfileB: id('att', 'H'),
}
const CMD = {
  stuck: id('cmd', 'A'),
  generation: id('cmd', 'D'),
  healthy: id('cmd', 'G'),
  currentGeneration: id('cmd', 'F'),
}
const RTC = {
  stuck: id('rtc', 'A'),
  revoked: id('rtc', 'E'),
  missing: id('rtc', 'F'),
  commandOnly: id('rtc', 'B'),
}
const SES = {
  stuck: id('ses', 'A'),
  revoked: id('ses', 'E'),
  missing: id('ses', 'F'),
}
// Runtime nodes own the channels; gateway channel connection ids are
// transport-local gwc_ values and never equal any rtc_ runtime connection id.
const NODE = id('rnr', 'A')
const NODE_B = id('rnr', 'B')
const CHANNELS = {
  nodeAGeneration1: { gatewayInstanceId: 'gateway-instance-01', connectionId: 'gwc_5c1e2a7b-0001' },
  nodeAGeneration2: { gatewayInstanceId: 'gateway-instance-01', connectionId: 'gwc_5c1e2a7b-0002' },
  nodeBGeneration1: { gatewayInstanceId: 'gateway-instance-02', connectionId: 'gwc_9d4f8e0c-0001' },
}
const INT = { human: id('int', 'B'), humanProfileB: id('int', 'H') }
const EVT = { effects: id('evt', 'C') }
const RTD = id('rtd', 'A')
const ART = id('art', 'G')
const PRF_Z = 'prf_01ZRZ3NDEKTSV4RRFFQ69G5FAW'

const EVENT_CANARY = 'sqlinspect-canary-secret-9153'
const PROMPT_CANARY = 'Private approval context canary-9271'

const LARGE_OTHER_WORKSPACE_EXECUTIONS = 900
const LIMIT_FIXTURE_EXECUTIONS = 25

let directory
let databasePath

async function seed() {
  directory = await mkdtemp(join(tmpdir(), 'cp-operator-inspection-'))
  databasePath = join(directory, 'control-plane.sqlite')
  const provider = new SqlitePersistenceProvider({ path: databasePath })
  await provider.migrate()

  await new SqliteContextPackageRepository(provider).put(
    contextPackageSerializationFixtures.futurePi
  )
  await new SqliteExecutionPlanRepository(provider).put(plan)
  await new SqliteExecutionPlanRepository(provider).put(planB)

  const lifecycle = new ExecutionLifecycleService(new SqliteExecutionRepository(provider))
  const commands = new SqliteRuntimeCommandRepository(provider)
  const discovery = new SqliteRuntimeDiscoveryRepository(provider)
  const interactions = new SqliteInteractionRepository(provider)
  const events = new SqliteExecutionEventRepository(provider)
  const planPin = (compiledPlan) => ({
    executionPlanId: compiledPlan.executionPlanId,
    contentDigest: compiledPlan.contentDigest,
    schemaVersion: compiledPlan.schemaVersion,
  })

  const createExecution = (executionId, at, compiledPlan = plan) =>
    lifecycle.createExecution({
      executionId,
      correlation: compiledPlan.correlation,
      executionPlan: planPin(compiledPlan),
      acceptedAt: at,
      deadlineAt: DEADLINE,
    })
  const createAttempt = async (executionId, attemptId, queuedAt, runtime) => {
    const execution = await lifecycle.getExecution(executionId)
    return lifecycle.createAttempt({
      executionId,
      attemptId,
      expectedExecutionVersion: execution.version,
      queuedAt,
      ...(runtime === undefined ? {} : { runtime }),
    })
  }

  // Stuck cluster: expired queued job, stale running attempt, resolved session
  // and connection projections that have themselves gone quiet.
  await createExecution(EXE.stuck, T0)
  await createAttempt(EXE.stuck, ATT.stuck, '2026-08-30T12:00:01.000Z', {
    runtimeConnectionId: RTC.stuck,
    externalSessionId: SES.stuck,
  })
  await commands.create({
    commandId: CMD.stuck,
    executionId: EXE.stuck,
    attemptId: ATT.stuck,
    nodeId: NODE,
    runtimeConnectionId: RTC.stuck,
    workspaceId: W1,
    idempotencyKey: 'inspection:stuck:command:1',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: { operation: 'run' },
    issuedAt: '2026-08-30T12:00:03.000Z',
    expiresAt: '2026-08-30T12:05:00.000Z',
    status: 'queued',
    version: 1,
    deliveryAttempts: 0,
    createdAt: T0,
    updatedAt: T0,
  })

  // Human wait: pending approval older than the staleness threshold.
  await createExecution(EXE.human, T0)
  await createAttempt(EXE.human, ATT.human, '2026-08-30T12:00:02.000Z')
  await interactions.insert({
    interactionId: INT.human,
    executionId: EXE.human,
    attemptId: ATT.human,
    kind: 'approval',
    prompt: { title: PROMPT_CANARY },
    allowedActions: ['approve', 'deny', 'cancel'],
    allowedPrincipalIds: ['svc-operator'],
    state: 'pending',
    version: 1,
    requestedAt: '2026-08-30T12:00:05.000Z',
    expiresAt: '2026-08-30T12:30:00.000Z',
  })

  // Effects backlog: one unarchived event still pending publication, written
  // with a secret in the payload (the write path redacts it; the inspection
  // must never surface payload content either way).
  await createExecution(EXE.effects, T0)
  await createAttempt(EXE.effects, ATT.effects, '2026-08-30T12:00:02.000Z')
  await events.append({
    eventId: EVT.effects,
    executionId: EXE.effects,
    type: 'execution.progressed',
    schemaVersion: 1,
    correlation: { ...plan.correlation, traceId: id('trc', 'A') },
    payload: { progress: 25, state: 'running', apiKey: EVENT_CANARY },
    occurredAt: '2026-08-30T12:00:04.000Z',
    recordedAt: '2026-08-30T12:00:04.000Z',
    retentionExpiresAt: '2099-01-01T00:00:00.000Z',
  })

  // Stale generation + delivery stall: node A's channel has moved to
  // generation 2 on a new gwc_ gateway channel while a dispatched command
  // still reports generation 1 after four attempts. Correlation is per node,
  // never by joining rtc_ runtime connection ids to gwc_ channel ids.
  await createExecution(EXE.generation, T0)
  await createAttempt(EXE.generation, ATT.generation, '2026-08-30T12:00:02.000Z', {
    runtimeConnectionId: RTC.stuck,
  })
  const sequenceRepository = new SqliteRuntimeChannelSequenceRepository(provider)
  const reserveChannel = (node, channel, channelGeneration) =>
    sequenceRepository.reserve({
      channel: {
        workspaceId: W1,
        nodeId: node,
        gatewayInstanceId: channel.gatewayInstanceId,
        connectionId: channel.connectionId,
        channelGeneration,
        protocolVersion: { major: 1, minor: 0 },
        connectedAt: T0,
        lastHeartbeatAt: T0,
      },
      count: 1,
      minimum: 1,
    })
  await reserveChannel(NODE, CHANNELS.nodeAGeneration1, 1)
  await reserveChannel(NODE, CHANNELS.nodeAGeneration2, 2)
  await reserveChannel(NODE_B, CHANNELS.nodeBGeneration1, 1)
  await commands.create({
    commandId: CMD.generation,
    executionId: EXE.generation,
    attemptId: ATT.generation,
    nodeId: NODE,
    runtimeConnectionId: RTC.stuck,
    workspaceId: W1,
    idempotencyKey: 'inspection:generation:command:1',
    payloadHash: `sha256:${'b'.repeat(64)}`,
    commandEnvelope: { operation: 'run' },
    issuedAt: '2026-08-30T12:00:03.000Z',
    expiresAt: DEADLINE,
    status: 'dispatched',
    version: 1,
    deliveryAttempts: 4,
    lastChannelGeneration: 1,
    lastSequence: 7,
    firstDispatchedAt: '2026-08-30T12:00:04.000Z',
    lastDispatchedAt: '2026-08-30T12:00:04.000Z',
    createdAt: T0,
    updatedAt: '2026-08-30T12:00:04.000Z',
  })

  // Revoked access: connection and session projections report revocation.
  await createExecution(EXE.revoked, T0)
  await createAttempt(EXE.revoked, ATT.revoked, '2026-08-30T12:00:02.000Z', {
    runtimeConnectionId: RTC.revoked,
    externalSessionId: SES.revoked,
  })
  await discovery.putRuntimeConnection(
    W1,
    connectionModel(RTC.revoked, '2026-08-30T12:00:00.000Z', 'revoked')
  )
  await discovery.putExternalSession(
    { workspaceId: W1 },
    sessionModel(SES.revoked, RTC.revoked, '2026-08-30T12:00:00.000Z', 'revoked', false)
  )

  // Missing access: the attempt references a connection and session the local
  // store has no projection for, plus a healthy recent execution that must not
  // be reported as stuck, and a command already on its node's current
  // generation (which must not be flagged stale).
  await createExecution(EXE.missing, T0)
  await createAttempt(EXE.missing, ATT.missing, '2026-08-30T12:00:02.000Z', {
    runtimeConnectionId: RTC.missing,
    externalSessionId: SES.missing,
  })
  await commands.create({
    commandId: CMD.currentGeneration,
    executionId: EXE.missing,
    attemptId: ATT.missing,
    nodeId: NODE_B,
    runtimeConnectionId: RTC.commandOnly,
    workspaceId: W1,
    idempotencyKey: 'inspection:current-generation:command:1',
    payloadHash: `sha256:${'e'.repeat(64)}`,
    commandEnvelope: { operation: 'run' },
    issuedAt: '2026-08-30T12:19:00.000Z',
    expiresAt: DEADLINE,
    status: 'dispatched',
    version: 1,
    deliveryAttempts: 1,
    lastChannelGeneration: 1,
    lastSequence: 1,
    firstDispatchedAt: '2026-08-30T12:19:00.000Z',
    lastDispatchedAt: '2026-08-30T12:19:00.000Z',
    createdAt: '2026-08-30T12:19:00.000Z',
    updatedAt: '2026-08-30T12:19:00.000Z',
  })
  await createExecution(EXE.healthy, T0)
  await createAttempt(EXE.healthy, ATT.healthy, '2026-08-30T12:19:30.000Z')
  await commands.create({
    commandId: CMD.healthy,
    executionId: EXE.healthy,
    attemptId: ATT.healthy,
    nodeId: NODE,
    runtimeConnectionId: RTC.stuck,
    workspaceId: W1,
    idempotencyKey: 'inspection:healthy:command:1',
    payloadHash: `sha256:${'c'.repeat(64)}`,
    commandEnvelope: { operation: 'run' },
    issuedAt: '2026-08-30T12:19:31.000Z',
    expiresAt: DEADLINE,
    status: 'succeeded',
    version: 1,
    deliveryAttempts: 1,
    lastChannelGeneration: 1,
    lastSequence: 1,
    firstDispatchedAt: '2026-08-30T12:19:31.000Z',
    lastDispatchedAt: '2026-08-30T12:19:31.000Z',
    resultReference: ART,
    resultStatus: 'succeeded',
    resultRecordedAt: '2026-08-30T12:19:32.000Z',
    createdAt: '2026-08-30T12:19:31.000Z',
    updatedAt: '2026-08-30T12:19:32.000Z',
  })
  await discovery.putRuntimeConnection(W1, connectionModel(RTC.stuck, '2026-08-30T12:00:00.000Z'))
  await discovery.putExternalSession(
    { workspaceId: W1 },
    sessionModel(SES.stuck, RTC.stuck, '2026-08-30T12:00:00.000Z')
  )

  // Profile isolation: a second pending approval on a plan that pins the other
  // profile, so an empty profile selection must not report this workspace-wide
  // human wait (and vice versa).
  await createExecution(EXE.humanProfileB, T0, planB)
  await createAttempt(EXE.humanProfileB, ATT.humanProfileB, '2026-08-30T12:00:03.000Z')
  await interactions.insert({
    interactionId: INT.humanProfileB,
    executionId: EXE.humanProfileB,
    attemptId: ATT.humanProfileB,
    kind: 'approval',
    prompt: { title: PROMPT_CANARY },
    allowedActions: ['approve', 'deny', 'cancel'],
    allowedPrincipalIds: ['svc-operator'],
    state: 'pending',
    version: 1,
    requestedAt: '2026-08-30T12:00:06.000Z',
    expiresAt: '2026-08-30T12:30:00.000Z',
  })

  // Raw records: an execution whose latest attempt and plan do not exist, an
  // execution in another workspace, a large unrelated cross-workspace block
  // that the scan must continue through, deterministic limit fixtures, and
  // malformed records that must be counted but never emitted.
  await provider.transaction(async (transaction) => {
    const put = (namespace, id_, value) => transaction.put({ namespace, id: recordId(id_), value })
    await put(
      'executions',
      EXE.ghostAttempt,
      rawExecution({
        executionId: EXE.ghostAttempt,
        acceptedAt: T0,
        updatedAt: T0,
        attemptCount: 1,
        latestAttemptId: id('att', 'Z'),
        executionPlan: {
          executionPlanId: id('pln', 'Z'),
          contentDigest: `sha256:${'d'.repeat(64)}`,
          schemaVersion: plan.schemaVersion,
        },
      })
    )
    await put(
      'executions',
      EXE.otherWorkspace,
      rawExecution({
        executionId: EXE.otherWorkspace,
        workspaceId: W2,
        projectId: PRJ_Z,
        taskId: id('tsk', 'J'),
        agentId: id('agt', 'J'),
        requestId: id('req', 'J'),
        acceptedAt: T0,
        updatedAt: T0,
      })
    )
    for (let index = 0; index < LARGE_OTHER_WORKSPACE_EXECUTIONS; index += 1) {
      const executionId = idN('exe', 100 + index)
      await put(
        'executions',
        executionId,
        rawExecution({
          executionId,
          workspaceId: W2,
          projectId: PRJ_Z,
          taskId: id('tsk', 'J'),
          agentId: id('agt', 'J'),
          requestId: id('req', 'J'),
          acceptedAt: T0,
          updatedAt: T0,
        })
      )
    }
    for (let index = 0; index < LIMIT_FIXTURE_EXECUTIONS; index += 1) {
      const executionId = idN('exe', index)
      await put(
        'executions',
        executionId,
        rawExecution({
          executionId,
          acceptedAt: T0,
          updatedAt: `2026-08-30T12:0${Math.floor(index / 5)}:${String((index % 5) * 11).padStart(2, '0')}.000Z`,
        })
      )
    }
    await put('executions', 'malformed-execution', { broken: true })
    await put('runtime-commands', 'malformed-command', { broken: 'command' })
  })

  provider.close()
}

beforeAll(async () => {
  await seed()
})

afterAll(async () => {
  if (readOnlyDatabase !== undefined) readOnlyDatabase.close()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
})

function connectionModel(runtimeConnectionId, observedAt, status = 'available') {
  const revoked = status === 'revoked'
  return {
    runtimeConnectionId,
    runtimeDefinitionId: RTD,
    family: 'codex',
    connectionType: 'managed_local',
    location: 'local_device',
    status,
    node: {
      runtimeNodeRefId: NODE,
      location: 'local_device',
      status: revoked ? 'revoked' : 'online',
      health: revoked ? 'revoked' : 'online',
      observedAt,
    },
    connection: {
      status: revoked ? 'revoked' : 'connected',
      health: revoked ? 'unavailable' : 'healthy',
      availability: revoked ? 'revoked' : 'healthy',
    },
    freshness: { state: revoked ? 'expired' : 'fresh', observedAt },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '1.0.0' },
    capabilities: ['session.resume'],
    capabilityDetails: [{ name: 'session.resume', support: 'supported' }],
    compatibility: { state: revoked ? 'revoked' : 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: false, state: 'not_required' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    observedAt,
    limitations: [],
  }
}

function sessionModel(
  externalSessionId,
  runtimeConnectionId,
  observedAt,
  state = 'active',
  recoverable = true
) {
  const revoked = state === 'revoked'
  return {
    externalSessionId,
    runtimeConnectionId,
    state,
    recoverable,
    display: { origin: 'native_discovery' },
    freshness: { state: revoked ? 'expired' : 'fresh', observedAt },
    capabilitySummary: {
      version: 1,
      operations: ['session.resume'],
      controls: {
        reference: { available: true },
        resume: revoked ? { available: false, reason: 'SESSION_REVOKED' } : { available: true },
        load: revoked ? { available: false, reason: 'SESSION_REVOKED' } : { available: true },
        close: revoked ? { available: false, reason: 'SESSION_REVOKED' } : { available: true },
        history: revoked ? { available: false, reason: 'SESSION_REVOKED' } : { available: true },
      },
    },
    limitations: revoked ? ['SESSION_REVOKED'] : [],
  }
}

function rawExecution({
  executionId,
  workspaceId = W1,
  projectId = PRJ1,
  taskId = plan.correlation.taskId,
  agentId = plan.correlation.agentId,
  requestId = plan.correlation.requestId,
  acceptedAt,
  updatedAt,
  state = 'accepted',
  attemptCount = 0,
  latestAttemptId,
  executionPlan = {
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
  },
}) {
  return {
    executionId,
    state,
    version: 1,
    correlation: { workspaceId, projectId, taskId, agentId, requestId },
    executionPlan,
    attemptCount,
    ...(latestAttemptId === undefined ? {} : { latestAttemptId }),
    acceptedAt,
    deadlineAt: DEADLINE,
    createdAt: acceptedAt,
    updatedAt,
  }
}

let readOnlyDatabase
async function openReadOnly() {
  if (readOnlyDatabase === undefined)
    readOnlyDatabase = await openReadOnlyInspectionDatabase(databasePath)
  return readOnlyDatabase
}

const sha256File = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

const listSnapshotDirectories = async () =>
  (await readdir(tmpdir()))
    .toSorted()
    .filter((entry) => entry.startsWith('operator-inspection-snapshot-'))

/**
 * A store double that returns raw rows the way SQLite would, so the real
 * reader (and its pagination and parsing) can be exercised over damaged
 * records without a database file.
 */
function rawRowStore(rowsByNamespace) {
  return {
    prepare() {
      return {
        all(...parameters) {
          const rows = rowsByNamespace[parameters[0]] ?? []
          if (parameters.length === 2) return rows.slice(0, parameters[1])
          const afterId = parameters[1]
          const limit = parameters[2]
          let start = rows.length
          for (let index = 0; index < rows.length; index += 1) {
            if (String(rows[index].id) > afterId) {
              start = index
              break
            }
          }
          return rows.slice(start, start + limit)
        },
      }
    },
  }
}

/**
 * Commits one extra in-scope execution into a copied store so the record
 * lives only in the write-ahead log, then detaches the shared-memory index
 * so a driver-level read-only open cannot attach to the live writer and the
 * byte-copy fallback path must serve the inspection. The copied store keeps
 * the fixture's own sidecar state: pages may still live in the source -wal.
 */
async function copyFixtureStoreWithLiveWriter(statePath) {
  await copyFile(databasePath, statePath)
  if (await hasWalSidecar(databasePath)) await copyFile(`${databasePath}-wal`, `${statePath}-wal`)
  const writer = new DatabaseSync(statePath)
  const walOnlyExecutionId = id('exe', 'M')
  writer
    .prepare(
      `INSERT INTO control_plane_records (namespace, id, revision, value, updated_at)
       VALUES ('executions', ?, 1, ?, ?)`
    )
    .run(
      recordId(walOnlyExecutionId),
      JSON.stringify(
        rawExecution({ executionId: walOnlyExecutionId, acceptedAt: T0, updatedAt: T0 })
      ),
      T0
    )
  rmSync(`${statePath}-shm`, { force: true })
  return writer
}

async function inspect(options) {
  const reader = createSqliteRecordReader(await openReadOnly())
  return inspectStuckJobs(reader, {
    workspaceId: W1,
    now: INSPECT_AT,
    ...options,
  })
}

test('pages namespaces with continuation until exhausted', async () => {
  const reader = createSqliteRecordReader(await openReadOnly())
  const seen = []
  let unparseable = 0
  let afterId
  for (let pages = 0; ; pages += 1) {
    const page = reader.pageRecords('executions', 7, afterId)
    unparseable += page.unparseableJsonCount
    for (const record of page.records) {
      seen.push(record.id)
      expect(record.id > (afterId ?? '')).toBe(true)
    }
    if (page.nextAfterId === null) {
      expect(pages).toBeGreaterThan(100)
      break
    }
    afterId = page.nextAfterId
  }
  expect(new Set(seen).size).toBe(seen.length)
  // 34 in-scope + 900 large unrelated + 1 other-workspace + 1 malformed row.
  expect(seen.length + unparseable).toBe(936)
})

test('correlates stuck executions with explicit states, ages and availability', async () => {
  const report = await inspect()
  expect(report.readOnly).toBe(true)
  expect(report.scope).toEqual({ workspaceId: W1, projectId: null, profileId: null })
  expect(report.thresholds).toEqual({
    staleAfterSeconds: 900,
    limit: 20,
    maxScanMatches: 10000,
    maxScanRows: 100000,
    scanPageSize: 512,
  })
  expect(report.summary.complete).toBe(true)
  expect(report.summary.incompleteScans).toEqual([])
  const byId = new Map(report.executions.map((view) => [view.executionId, view]))

  // Healthy execution is counted in scope but never reported as stuck.
  expect(report.summary.inScope.executions).toBe(34)
  expect(report.summary.inScope.stuckCandidates).toBe(33)
  expect(report.summary.selected.stuckCandidates).toBe(33)
  expect(byId.has(EXE.healthy)).toBe(false)

  // Stuck cluster: expired job, stalled dispatch, interrupted attempt, stale
  // execution.
  const stuck = byId.get(EXE.stuck)
  expect(stuck.stuckReasons).toEqual([
    'attempt_interrupted',
    'command_expired',
    'dispatch_stalled',
    'execution_stale',
  ])
  expect(stuck.reconciliationAgeMs).toBeGreaterThan(15 * 60 * 1000)
  expect(stuck.attempt).toMatchObject({
    availability: 'resolved',
    attemptId: ATT.stuck,
    state: 'queued',
    interrupted: true,
  })
  expect(stuck.jobs.listed).toHaveLength(1)
  expect(stuck.jobs.listed[0]).toMatchObject({
    commandId: CMD.stuck,
    status: 'queued',
    expired: true,
    staleGeneration: null,
  })
  expect(stuck.session).toMatchObject({
    availability: 'resolved',
    externalSessionId: SES.stuck,
    state: 'active',
    stale: true,
  })
  expect(stuck.connection).toMatchObject({
    availability: 'resolved',
    runtimeConnectionId: RTC.stuck,
    status: 'available',
    stale: true,
  })
  expect(stuck.profile).toMatchObject({
    availability: 'resolved',
    profileId: plan.profile.profileId,
    profileVersionId: plan.profile.profileVersionId,
  })

  // Human wait surfaces the pending approval without its prompt content.
  const human = byId.get(EXE.human)
  expect(human.stuckReasons).toContain('awaiting_human')
  expect(human.approvals.pendingCount).toBe(1)
  expect(human.approvals.pending[0]).toMatchObject({
    interactionId: INT.human,
    kind: 'approval',
    state: 'pending',
    pastExpiry: false,
  })
  expect(human.approvals.pending[0].pendingAgeMs).toBeGreaterThan(15 * 60 * 1000)

  // Effects backlog surfaces pending publication age. This is a backlog
  // signal only, never complete settlement evidence.
  const effects = byId.get(EXE.effects)
  expect(effects.stuckReasons).toContain('effects_pending')
  expect(effects.effects).toMatchObject({
    pendingCount: 1,
    failedCount: 0,
    publishedCount: 0,
    publicationBacklog: true,
  })
  expect(effects.effects.oldestPendingAgeMs).toBeGreaterThan(15 * 60 * 1000)

  // Stale generation and delivery stall, correlated per node even though every
  // gwc_ gateway channel id differs from every rtc_ runtime connection id.
  const generation = byId.get(EXE.generation)
  expect(generation.stuckReasons).toContain('delivery_stalled')
  expect(generation.stuckReasons).toContain('stale_generation')
  expect(generation.jobs.listed[0]).toMatchObject({
    commandId: CMD.generation,
    status: 'dispatched',
    deliveryAttempts: 4,
    expired: false,
    staleGeneration: true,
  })

  // A command already on its node's current generation is not flagged stale.
  const missing = byId.get(EXE.missing)
  expect(missing.jobs.listed).toHaveLength(1)
  expect(missing.jobs.listed[0]).toMatchObject({
    commandId: CMD.currentGeneration,
    staleGeneration: false,
  })

  // Revoked access is surfaced explicitly, never blanked.
  const revoked = byId.get(EXE.revoked)
  expect(revoked.connection).toMatchObject({
    availability: 'resolved',
    status: 'revoked',
    connectionStatus: 'revoked',
    nodeStatus: 'revoked',
    stale: true,
  })
  expect(revoked.session).toMatchObject({
    availability: 'resolved',
    state: 'revoked',
    recoverable: false,
  })

  // Missing projections stay explicit.
  expect(missing.connection).toMatchObject({
    availability: 'missing',
    runtimeConnectionId: RTC.missing,
  })
  expect(missing.session).toMatchObject({
    availability: 'reference_only',
    externalSessionId: SES.missing,
  })

  // Ghost attempt and ghost plan remain explicit instead of blank.
  const ghost = byId.get(EXE.ghostAttempt)
  expect(ghost.attempt).toMatchObject({ availability: 'missing' })
  expect(ghost.profile).toMatchObject({
    availability: 'missing',
    reason: 'plan_missing_or_out_of_scope',
  })

  // Aggregates: workspace-wide totals live in inScope; with no profile filter
  // the selected totals mirror them.
  expect(report.summary.selected.stuckCandidates).toBe(
    report.executions.length + report.summary.selected.remainingStuckCandidates
  )
  expect(report.summary.inScope.awaitingHumanPendingCount).toBe(2)
  expect(report.summary.inScope.oldestPendingInteractionAgeMs).toBeGreaterThan(15 * 60 * 1000)
  expect(report.summary.inScope.oldestStuckAgeMs).toBeGreaterThan(15 * 60 * 1000)
  expect(report.summary.selected.oldestStuckAgeMs).toBe(report.summary.inScope.oldestStuckAgeMs)
})

test('keeps workspaces isolated and never emits out-of-scope identifiers', async () => {
  const report = await inspect()
  expect(report.summary.inScope.outOfScopeExecutions).toBe(1 + LARGE_OTHER_WORKSPACE_EXECUTIONS)
  const serialized = JSON.stringify(report)
  expect(serialized).not.toContain(W2)
  expect(serialized).not.toContain(EXE.otherWorkspace)

  const other = await inspect({ workspaceId: W2 })
  expect(other.summary.complete).toBe(true)
  expect(other.summary.inScope.executions).toBe(1 + LARGE_OTHER_WORKSPACE_EXECUTIONS)
  expect(other.summary.inScope.stuckCandidates).toBe(1 + LARGE_OTHER_WORKSPACE_EXECUTIONS)
  expect(other.executions).toHaveLength(20)
  expect(other.executions.map((view) => view.executionId)).not.toContain(EXE.stuck)
  expect(other.executions[0].stuckReasons).toEqual(['execution_stale'])
})

test('continues through a large unrelated cross-workspace block', async () => {
  // The default scan must keep walking through more than two full pages of
  // unrelated workspace records and still find every in-scope execution.
  const report = await inspect({ limit: 100 })
  expect(report.summary.complete).toBe(true)
  expect(report.summary.inScope.executions).toBe(34)
  expect(report.summary.inScope.stuckCandidates).toBe(33)
})

test('reports an explicit empty state for a workspace without records', async () => {
  const report = await inspect({ workspaceId: W3 })
  expect(report.summary.complete).toBe(true)
  // Out-of-scope records are counted explicitly even for an empty selection;
  // they are never identified.
  expect(report.summary.inScope).toEqual({
    executions: 0,
    outOfScopeExecutions: 34 + 1 + LARGE_OTHER_WORKSPACE_EXECUTIONS,
    stuckCandidates: 0,
    oldestStuckAgeMs: null,
    awaitingHumanPendingCount: 0,
    oldestPendingInteractionAgeMs: null,
  })
  expect(report.summary.selected).toEqual({
    stuckCandidates: 0,
    remainingStuckCandidates: 0,
    executionsListed: 0,
    oldestStuckAgeMs: null,
  })
  expect(report.executions).toEqual([])
})

test('narrows to a project scope only when selected', async () => {
  const inProject = await inspect({ projectId: PRJ1 })
  expect(inProject.summary.inScope.executions).toBeGreaterThan(0)
  const otherProject = await inspect({ projectId: PRJ_Z })
  expect(otherProject.summary.inScope.executions).toBe(0)
  expect(otherProject.executions).toEqual([])
})

test('bounds results and orders stuck candidates oldest first', async () => {
  const report = await inspect({ limit: 5 })
  expect(report.thresholds.limit).toBe(5)
  expect(report.executions).toHaveLength(5)
  expect(report.summary.selected.stuckCandidates).toBe(33)
  expect(report.summary.selected.remainingStuckCandidates).toBe(28)
  const ages = report.executions.map((view) => view.oldestEvidenceAgeMs)
  for (let index = 1; index < ages.length; index += 1)
    expect(ages[index - 1] >= ages[index]).toBe(true)
})

test('leaves the database bytes untouched', async () => {
  const before = createHash('sha256')
    .update(await readFile(databasePath))
    .digest('hex')
  await inspect()
  const after = createHash('sha256')
    .update(await readFile(databasePath))
    .digest('hex')
  expect(after).toBe(before)
})

test('inspects a copy whose WAL header has no shared-memory sidecar', async () => {
  // After a graceful launcher stop the -wal/-shm sidecars are gone while the
  // database header stays in WAL mode; a driver-level read-only open cannot
  // create the shared-memory file in that state, so the helper falls back to a
  // verified byte-copy. Simulate that state deterministically on an isolated
  // copy (main database plus any live -wal, never the -shm) instead of
  // touching the shared fixture.
  const snapshotDirectoriesBefore = await listSnapshotDirectories()
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cp-operator-inspection-wal-'))
  try {
    const statePath = join(stateDirectory, 'control-plane.sqlite')
    await copyFile(databasePath, statePath)
    const copiedWal = await hasWalSidecar(databasePath)
    if (copiedWal) await copyFile(`${databasePath}-wal`, `${statePath}-wal`)
    const before = await sha256File(statePath)
    const handle = await openReadOnlyInspectionDatabase(statePath)
    try {
      const report = inspectStuckJobs(createSqliteRecordReader(handle), {
        workspaceId: W1,
        now: INSPECT_AT,
      })
      expect(report.summary.inScope.executions).toBe(34)
    } finally {
      handle.close()
    }
    expect(await sha256File(statePath)).toBe(before)
    // The inspected database file is byte-identical, and the directory holds
    // only the SQLite-owned set: the database, the -wal we reproduced, and at
    // most the -shm SQLite itself maintains for WAL reads. The private
    // snapshot directory is always removed.
    const entries = (await readdir(stateDirectory)).toSorted()
    const allowed = ['control-plane.sqlite', 'control-plane.sqlite-shm', 'control-plane.sqlite-wal']
    expect(entries.every((entry) => allowed.includes(entry))).toBe(true)
    if (!copiedWal) expect(entries).not.toContain('control-plane.sqlite-wal')
    const snapshotDirectoriesAfter = await listSnapshotDirectories()
    expect(snapshotDirectoriesAfter).toEqual(snapshotDirectoriesBefore)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test('surfaces committed WAL-only records through the snapshot fallback', async () => {
  // The fallback exists so committed records that still live only in the
  // write-ahead log are never lost to the report: a copyable sidecar must be
  // carried into the snapshot and recovered.
  const snapshotDirectoriesBefore = await listSnapshotDirectories()
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cp-operator-inspection-wal-live-'))
  let writer
  try {
    const statePath = join(stateDirectory, 'control-plane.sqlite')
    writer = await copyFixtureStoreWithLiveWriter(statePath)
    const databaseBefore = await sha256File(statePath)
    const walBefore = await sha256File(`${statePath}-wal`)
    const handle = await openReadOnlyInspectionDatabase(statePath)
    try {
      const report = inspectStuckJobs(createSqliteRecordReader(handle), {
        workspaceId: W1,
        now: INSPECT_AT,
      })
      expect(report.summary.complete).toBe(true)
      expect(report.summary.inScope.executions).toBe(34 + 1)
    } finally {
      handle.close()
    }
    // The inspected source files stay byte-identical, including the WAL that
    // still belongs to the live writer.
    expect(await sha256File(statePath)).toBe(databaseBefore)
    expect(await sha256File(`${statePath}-wal`)).toBe(walBefore)
    expect(await listSnapshotDirectories()).toEqual(snapshotDirectoriesBefore)
  } finally {
    writer?.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test('fails closed when an existing WAL sidecar cannot be copied', async () => {
  // An unreadable but existing sidecar carries committed records; proceeding
  // without it would drop them from the report while it still claimed
  // completeness, so the open must fail instead.
  const snapshotDirectoriesBefore = await listSnapshotDirectories()
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cp-operator-inspection-wal-denied-'))
  let writer
  try {
    const statePath = join(stateDirectory, 'control-plane.sqlite')
    const walPath = `${statePath}-wal`
    writer = await copyFixtureStoreWithLiveWriter(statePath)
    const databaseBefore = await sha256File(statePath)
    const walBefore = await sha256File(walPath)
    await chmod(walPath, 0o000)
    try {
      await expect(openReadOnlyInspectionDatabase(statePath)).rejects.toThrow(
        'INSPECTION_WAL_SIDECAR_UNAVAILABLE'
      )
    } finally {
      await chmod(walPath, 0o600)
    }
    // The failure never leaked a partial snapshot and never touched the
    // operator's files.
    expect(await sha256File(walPath)).toBe(walBefore)
    expect(await sha256File(statePath)).toBe(databaseBefore)
    expect(await listSnapshotDirectories()).toEqual(snapshotDirectoriesBefore)
  } finally {
    writer?.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test('fails closed when the WAL sidecar exists but is not a regular file', async () => {
  const snapshotDirectoriesBefore = await listSnapshotDirectories()
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cp-operator-inspection-wal-dir-'))
  try {
    const statePath = join(stateDirectory, 'control-plane.sqlite')
    await copyFile(databasePath, statePath)
    await mkdir(`${statePath}-wal`)
    const databaseBefore = await sha256File(statePath)
    await expect(openReadOnlyInspectionDatabase(statePath)).rejects.toThrow(
      'INSPECTION_WAL_SIDECAR_INVALID'
    )
    expect(await sha256File(statePath)).toBe(databaseBefore)
    expect(await listSnapshotDirectories()).toEqual(snapshotDirectoriesBefore)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test('keys page continuation on raw record ids so damaged pages cannot truncate the walk', () => {
  const reader = createSqliteRecordReader(
    rawRowStore({
      executions: [
        { id: 'r-001', value: '{"broken": true' },
        { id: 'r-002', value: '{broken' },
        { id: 'r-003', value: '{also-broken' },
        { id: 'r-004', value: '{still-broken' },
        { id: 'r-005', value: '{last-broken' },
      ],
    })
  )
  const first = reader.pageRecords('executions', 2)
  expect(first.records).toEqual([])
  expect(first.rawRowCount).toBe(2)
  expect(first.unparseableJsonCount).toBe(2)
  expect(first.nextAfterId).toBe('r-002')
  const second = reader.pageRecords('executions', 2, first.nextAfterId)
  expect(second.rawRowCount).toBe(2)
  expect(second.unparseableJsonCount).toBe(2)
  expect(second.nextAfterId).toBe('r-004')
  const third = reader.pageRecords('executions', 2, second.nextAfterId)
  expect(third.rawRowCount).toBe(1)
  expect(third.unparseableJsonCount).toBe(1)
  expect(third.nextAfterId).toBe(null)
})

test('fails a walk loudly when a page cannot produce a usable continuation id', () => {
  const reader = createSqliteRecordReader(
    rawRowStore({
      executions: [
        { id: 7, value: '{}' },
        { id: 8, value: '{}' },
        { id: 9, value: '{}' },
      ],
    })
  )
  expect(() => reader.pageRecords('executions', 2)).toThrow('INSPECTION_SCAN_CONTINUATION_UNUSABLE')
})

test('stops scans at the raw-row budget on damaged namespaces', () => {
  // A namespace flooded with unparseable rows must still consume the raw-row
  // budget: before raw rows were counted, the walk paged through every row
  // with a zeroed budget and reported the damaged store as complete.
  const damagedRows = Array.from({ length: 150_000 }, (_, index) => ({
    id: `damaged-${String(index).padStart(6, '0')}`,
    value: '{broken',
  }))
  const reader = createSqliteRecordReader(rawRowStore({ executions: damagedRows }))
  const report = inspectStuckJobs(reader, { workspaceId: W1, now: INSPECT_AT })
  expect(report.summary.complete).toBe(false)
  const scan = report.summary.incompleteScans.find((entry) => entry.namespace === 'executions')
  expect(scan).toMatchObject({ reason: 'row_budget_reached' })
  expect(scan.lastSeenRecordId).toMatch(/^damaged-\d{6}$/)
  expect(report.summary.malformedRecords['executions']).toBeGreaterThanOrEqual(100_000)
  expect(report.summary.inScope.executions).toBe(0)
})

test('never emits record payload content or secrets', async () => {
  const serialized = JSON.stringify(await inspect())
  expect(serialized).not.toContain(EVENT_CANARY)
  expect(serialized).not.toContain(PROMPT_CANARY)
  // The seeded plan definition carries this instruction; only its digest may
  // ever appear in report form.
  expect(serialized).not.toContain('Complete the assigned task safely.')
  expect(serialized).not.toContain('apiKey')
  expect(serialized).not.toContain('payload')
})

test('filters by profile while reporting unattributed executions explicitly', async () => {
  const filtered = await inspect({ profileId: plan.profile.profileId, limit: 100 })
  expect(filtered.profileResolution.filtered).toBe(true)
  expect(
    filtered.executions.every(
      (view) =>
        view.profile.availability === 'resolved' &&
        view.profile.profileId === plan.profile.profileId
    )
  ).toBe(true)
  expect(filtered.profileResolution.unattributedExecutionIds).toContain(EXE.ghostAttempt)

  const none = await inspect({ profileId: PRF_Z, limit: 100 })
  expect(none.executions).toEqual([])
  expect(none.profileResolution.unattributedExecutionIds).toContain(EXE.ghostAttempt)
})

test('separates profile-scoped totals from workspace-wide totals', async () => {
  // Selecting profile A: the other profile's execution and human wait stay in
  // the workspace-wide totals but never enter the selected totals or listing;
  // the plan-less ghost execution is reported as unattributed instead.
  const profileA = await inspect({ profileId: plan.profile.profileId, limit: 100 })
  expect(profileA.summary.inScope.stuckCandidates).toBe(33)
  expect(profileA.summary.inScope.awaitingHumanPendingCount).toBe(2)
  expect(profileA.summary.selected.stuckCandidates).toBe(31)
  expect(profileA.executions.some((view) => view.executionId === EXE.humanProfileB)).toBe(false)

  // Selecting profile B: the selection contains only profile B's execution,
  // while the workspace-wide totals stay whole and explicitly reported.
  const profileB = await inspect({ profileId: PROFILE_B.profileId, limit: 100 })
  expect(profileB.summary.inScope.stuckCandidates).toBe(33)
  expect(profileB.summary.inScope.awaitingHumanPendingCount).toBe(2)
  expect(profileB.summary.selected.stuckCandidates).toBe(1)
  expect(profileB.executions.map((view) => view.executionId)).toEqual([EXE.humanProfileB])
  expect(profileB.executions[0].stuckReasons).toContain('awaiting_human')

  // Without a filter the selected totals mirror the workspace-wide ones.
  const unfiltered = await inspect({ limit: 100 })
  expect(unfiltered.profileResolution.filtered).toBe(false)
  expect(unfiltered.summary.selected.stuckCandidates).toBe(
    unfiltered.summary.inScope.stuckCandidates
  )
})

test('counts malformed records without emitting them', async () => {
  const report = await inspect()
  expect(report.summary.malformedRecords['executions']).toBeGreaterThanOrEqual(1)
  expect(report.summary.malformedRecords['runtime-commands']).toBeGreaterThanOrEqual(1)
  expect(JSON.stringify(report)).not.toContain('"broken"')
})

test('reports incomplete scans instead of confidently narrow results', async () => {
  const report = await inspect({ maxScanMatches: 2, limit: 100 })
  expect(report.summary.complete).toBe(false)
  expect(report.thresholds.maxScanMatches).toBe(2)
  const executionsScan = report.summary.incompleteScans.find(
    (scan) => scan.namespace === 'executions'
  )
  expect(executionsScan).toMatchObject({ reason: 'match_budget_reached' })
  expect(executionsScan.lastSeenRecordId).toMatch(/^r-[0-9a-f]{64}$/)
  // The walk stopped at the budget: the report counts exactly what it walked,
  // and the incompleteness is explicit rather than an unnoticed shortfall.
  expect(report.summary.inScope.executions).toBe(2)
  expect(report.summary.selected.stuckCandidates).toBe(report.summary.inScope.stuckCandidates)
  expect(report.executions).toHaveLength(2)
})

async function runCli(arguments_, timeoutMs = 10000) {
  const ledger = process.env['CONTROL_PLANE_LOCAL_RESOURCE_LEDGER']
  if (ledger)
    await appendFile(
      ledger,
      `operator-inspection test child planned; owner=root/inspection-tests; data=${databasePath}; no ports\n`
    )
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('../dist/operator-inspection-cli.js', import.meta.url)),
      ...arguments_,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  if (ledger)
    await appendFile(
      ledger,
      `operator-inspection test child PID=${child.pid}; owner=root/inspection-tests\n`
    )
  const timeout = setTimeout(() => child.kill(), timeoutMs)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    if (ledger)
      await appendFile(
        ledger,
        `operator-inspection test child PID=${child.pid} settled; exit=${child.exitCode}\n`
      )
  }
}

test('packaged operator command inspects a private data directory read-only', async () => {
  const { code, stdout, stderr } = await runCli([
    '--data-dir',
    directory,
    '--workspace',
    W1,
    '--limit',
    '5',
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  const report = JSON.parse(stdout)
  expect(report).toMatchObject({
    schemaVersion: 1,
    command: 'local.operator.inspection.stuck-jobs',
    readOnly: true,
  })
  expect(report.executions.length).toBeLessThanOrEqual(5)
  expect(stdout).not.toContain(EVENT_CANARY)
  expect(stdout).not.toContain(PROMPT_CANARY)
})

test('packaged operator command fails closed without a scope', async () => {
  const missingScope = await runCli(['--data-dir', directory])
  expect(missingScope.code).toBe(1)
  expect(missingScope.stderr).toBe('LOCAL_OPERATOR_INSPECTION_FAILED\n')
  expect(missingScope.stdout).toBe('')

  const invalidScope = await runCli(['--data-dir', directory, '--workspace', 'wsp_not-canonical'])
  expect(invalidScope.code).toBe(1)
  expect(invalidScope.stderr).toBe('LOCAL_OPERATOR_INSPECTION_FAILED\n')
})

test('packaged operator command refuses unprotected targets', async () => {
  const openDirectory = await mkdtemp(join(tmpdir(), 'cp-operator-inspection-open-'))
  try {
    const unprotected = join(openDirectory, 'unprotected.sqlite')
    await writeFile(unprotected, 'not a database', { mode: 0o644 })
    const { code, stderr } = await runCli(['--data-dir', openDirectory, '--workspace', W1])
    expect(code).toBe(1)
    expect(stderr).toBe('LOCAL_OPERATOR_INSPECTION_FAILED\n')
    await chmod(unprotected, 0o600)
  } finally {
    await rm(openDirectory, { recursive: true, force: true })
  }
})
