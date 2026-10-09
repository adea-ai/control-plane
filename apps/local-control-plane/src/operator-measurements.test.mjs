import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createOperationsMetricEmitter, operationsMetricNames } from '@control-plane/telemetry'
import { operationalMetrics } from '@control-plane/telemetry/catalog'
import { createSqliteMeasurementReader, measureOperations } from './operator-measurements.ts'
import { openReadOnlyInspectionDatabase as openReadOnly } from './operator-inspection.ts'

// Deterministic clock: seeded rows are written between 12:00 and 12:19 and the
// measurement reads at 12:20 with the default 24 hour window.
const NOW = '2026-08-30T12:20:00.000Z'
const OLD = '2026-08-01T00:00:00.000Z'

const id = (prefix, letter) => `${prefix}_01${letter}RZ3NDEKTSV4RRFFQ69G5FAV`
const recordId = (value) => `r-${createHash('sha256').update(value).digest('hex')}`

const W1 = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const W2 = 'wsp_01BRZ3NDEKTSV4RRFFQ69G5FAV'
const W3 = 'wsp_01CRZ3NDEKTSV4RRFFQ69G5FAV'
const PRJ1 = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const NODE = id('rnr', 'A')

const EXE = {
  queue: id('exe', 'A'),
  human: id('exe', 'B'),
  retry: id('exe', 'C'),
  recon: id('exe', 'D'),
  done: id('exe', 'E'),
  ghost: id('exe', 'F'),
  attemptDone: id('exe', 'G'),
  other: id('exe', 'H'),
  missing: id('exe', 'J'),
}
const ATT = {
  queue: id('att', 'A'),
  human: id('att', 'B'),
  retry1: id('att', 'C'),
  retry2: id('att', 'D'),
  done: id('att', 'E'),
  attemptDone: id('att', 'G'),
  orphan: id('att', 'H'),
}
const CMD = { dispatched: id('cmd', 'A'), waiting: id('cmd', 'B'), other: id('cmd', 'C') }
const SES = id('ses', 'A')
const RTC = id('rtc', 'A')
const ART = id('art', 'A')
const ART2 = id('art', 'B')
const INT = {
  responded: id('int', 'A'),
  pending: id('int', 'B'),
  expired: id('int', 'C'),
  orphan: id('int', 'D'),
}
const EVT = {
  pending: id('evt', 'A'),
  published: id('evt', 'B'),
  archived: id('evt', 'C'),
  other: id('evt', 'D'),
}
const USG = {
  model: id('usg', 'A'),
  tool: id('usg', 'B'),
  old: id('usg', 'C'),
  other: id('usg', 'D'),
}

const CMD_CANARY = 'measurement-command-canary-4471'
const PROMPT_CANARY = 'measurement-prompt-canary-5582'
const EVT_CANARY = 'measurement-event-canary-6693'

const correlation = (workspaceId = W1, projectId = PRJ1, letter = 'A') => ({
  workspaceId,
  projectId,
  taskId: id('tsk', letter),
  agentId: id('agt', letter),
  requestId: id('req', letter),
})

const planPin = {
  executionPlanId: id('pln', 'A'),
  contentDigest: `sha256:${'a'.repeat(64)}`,
  schemaVersion: 1,
}

function rawExecution({
  executionId,
  workspaceId = W1,
  projectId = PRJ1,
  letter = 'A',
  state,
  updatedAt,
  attemptCount = 0,
  latestAttemptId,
  acceptedAt = '2026-08-30T12:00:00.000Z',
  terminalAt,
  terminalResultRef,
  reconciliationRequiredAt,
}) {
  return {
    executionId,
    state,
    version: 1,
    correlation: correlation(workspaceId, projectId, letter),
    executionPlan: planPin,
    attemptCount,
    ...(latestAttemptId === undefined ? {} : { latestAttemptId }),
    ...(terminalAt === undefined ? {} : { terminalAt }),
    ...(terminalResultRef === undefined ? {} : { terminalResultRef }),
    ...(reconciliationRequiredAt === undefined ? {} : { reconciliationRequiredAt }),
    acceptedAt,
    createdAt: acceptedAt,
    updatedAt,
  }
}

function rawAttempt({
  attemptId,
  executionId,
  sequence,
  state,
  updatedAt,
  queuedAt,
  terminalAt,
  failure,
  terminalResultRef,
  runtime,
}) {
  return {
    attemptId,
    executionId,
    sequence,
    state,
    version: 1,
    acceptedAt: queuedAt ?? updatedAt,
    ...(queuedAt === undefined ? {} : { queuedAt }),
    ...(terminalAt === undefined ? {} : { terminalAt }),
    ...(failure === undefined ? {} : { failure }),
    ...(terminalResultRef === undefined ? {} : { terminalResultRef }),
    ...(runtime === undefined ? {} : { runtime }),
    createdAt: queuedAt ?? updatedAt,
    updatedAt,
  }
}

function rawCommand({
  commandId,
  executionId,
  attemptId,
  workspaceId = W1,
  nodeId = NODE,
  status,
  issuedAt,
  expiresAt,
  updatedAt,
  deliveryAttempts = 0,
  firstDispatchedAt,
  lastChannelGeneration,
}) {
  return {
    commandId,
    executionId,
    attemptId,
    nodeId,
    runtimeConnectionId: RTC,
    workspaceId,
    idempotencyKey: `measurement:${commandId}:command:1`,
    payloadHash: `sha256:${'b'.repeat(64)}`,
    commandEnvelope: { operation: 'run', apiKey: CMD_CANARY },
    issuedAt,
    expiresAt,
    status,
    version: 1,
    deliveryAttempts,
    ...(firstDispatchedAt === undefined
      ? {}
      : { firstDispatchedAt, lastDispatchedAt: firstDispatchedAt }),
    ...(lastChannelGeneration === undefined ? {} : { lastChannelGeneration, lastSequence: 1 }),
    correlation: { traceId: id('trc', 'A') },
    createdAt: issuedAt,
    updatedAt,
  }
}

function rawInteraction({
  interactionId,
  executionId,
  attemptId,
  state,
  requestedAt,
  resolvedAt,
  response,
}) {
  return {
    interactionId,
    executionId,
    attemptId,
    kind: 'approval',
    prompt: { title: PROMPT_CANARY },
    allowedActions: ['approve', 'deny', 'cancel'],
    allowedPrincipalIds: ['svc-operator'],
    state,
    version: 1,
    requestedAt,
    expiresAt: '2026-08-30T12:30:00.000Z',
    ...(response === undefined ? {} : { response }),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
  }
}

function rawEvent({
  eventId,
  executionId,
  sequence,
  status,
  occurredAt,
  archivedAt,
  workspaceId = W1,
  projectId = PRJ1,
  letter = 'A',
}) {
  return {
    eventId,
    executionId,
    sequence,
    type: 'execution.progressed',
    schemaVersion: 1,
    correlation: { ...correlation(workspaceId, projectId, letter), traceId: id('trc', 'A') },
    payload: { progress: 25, apiKey: EVT_CANARY },
    payloadBytes: 48,
    payloadHash: 'c'.repeat(64),
    occurredAt,
    recordedAt: occurredAt,
    retentionExpiresAt: '2099-01-01T00:00:00.000Z',
    ...(archivedAt === undefined ? {} : { archivedAt }),
    publication: {
      status,
      attempts: status === 'pending' ? 0 : 1,
      version: 1,
      ...(status === 'published' ? { publishedAt: occurredAt } : {}),
    },
  }
}

function rawUsageEntry({
  entryId,
  sequence,
  executionId,
  workspaceId = W1,
  kind,
  quantity,
  costMicrounits,
  costExact,
  fundingSource,
  recordedAt,
  model,
  attemptId,
}) {
  return {
    entryId,
    sequence,
    workspaceId,
    executionId,
    ...(attemptId === undefined ? {} : { attemptId }),
    kind,
    source: { sourceId: `source:${entryId}`, idempotencyKey: `idem:${entryId}:0000000000` },
    ...(model === undefined
      ? {}
      : { reservationKey: `runtime-attempt:${attemptId}`, modelCallId: id('mdc', 'A') }),
    fundingSource,
    quantity,
    currency: 'USD',
    costMicrounits,
    costExact,
    recordedAt,
  }
}

const sessionModel = {
  externalSessionId: SES,
  runtimeConnectionId: RTC,
  state: 'active',
  recoverable: true,
  display: { origin: 'native_discovery' },
  freshness: { state: 'fresh', observedAt: '2026-08-30T12:00:00.000Z' },
  capabilitySummary: {
    version: 1,
    operations: ['session.resume'],
    controls: {
      reference: { available: true },
      resume: { available: true },
      load: { available: true },
      close: { available: true },
      history: { available: true },
    },
  },
  limitations: [],
}

let directory
let databasePath
let databaseBytesBefore

async function seed() {
  directory = await mkdtemp(join(tmpdir(), 'cp-operator-measurements-'))
  databasePath = join(directory, 'control-plane.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec(`CREATE TABLE control_plane_records (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    value TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace, id)
  ) STRICT`)
  const insert = database.prepare(
    'INSERT INTO control_plane_records (namespace, id, revision, value, updated_at) VALUES (?, ?, 1, ?, ?)'
  )
  const put = (namespace, key, value, updatedAt) =>
    insert.run(namespace, recordId(key), JSON.stringify(value), updatedAt)

  // Executions: five non-terminal and two completed, plus one other-workspace
  // execution and one malformed record that must be counted but never emitted.
  put(
    'executions',
    EXE.queue,
    rawExecution({
      executionId: EXE.queue,
      state: 'running',
      attemptCount: 1,
      latestAttemptId: ATT.queue,
      updatedAt: '2026-08-30T12:19:00.000Z',
    }),
    '2026-08-30T12:19:00.000Z'
  )
  put(
    'executions',
    EXE.human,
    rawExecution({
      executionId: EXE.human,
      letter: 'B',
      state: 'awaiting_input',
      attemptCount: 1,
      latestAttemptId: ATT.human,
      updatedAt: '2026-08-30T12:05:00.000Z',
    }),
    '2026-08-30T12:05:00.000Z'
  )
  put(
    'executions',
    EXE.retry,
    rawExecution({
      executionId: EXE.retry,
      letter: 'C',
      state: 'running',
      attemptCount: 2,
      latestAttemptId: ATT.retry2,
      updatedAt: '2026-08-30T12:00:20.000Z',
    }),
    '2026-08-30T12:00:20.000Z'
  )
  put(
    'executions',
    EXE.recon,
    rawExecution({
      executionId: EXE.recon,
      letter: 'D',
      state: 'reconciliation_required',
      reconciliationRequiredAt: '2026-08-30T12:05:00.000Z',
      updatedAt: '2026-08-30T12:05:00.000Z',
    }),
    '2026-08-30T12:05:00.000Z'
  )
  put(
    'executions',
    EXE.done,
    rawExecution({
      executionId: EXE.done,
      letter: 'E',
      state: 'completed',
      attemptCount: 1,
      latestAttemptId: ATT.done,
      acceptedAt: '2026-08-30T12:00:00.000Z',
      terminalAt: '2026-08-30T12:18:00.000Z',
      terminalResultRef: ART,
      updatedAt: '2026-08-30T12:18:00.000Z',
    }),
    '2026-08-30T12:18:00.000Z'
  )
  put(
    'executions',
    EXE.ghost,
    rawExecution({
      executionId: EXE.ghost,
      letter: 'F',
      state: 'queued',
      acceptedAt: OLD,
      updatedAt: OLD,
    }),
    OLD
  )
  put(
    'executions',
    EXE.attemptDone,
    rawExecution({
      executionId: EXE.attemptDone,
      letter: 'G',
      state: 'completed',
      attemptCount: 1,
      latestAttemptId: ATT.attemptDone,
      terminalAt: '2026-08-30T12:19:30.000Z',
      updatedAt: '2026-08-30T12:19:30.000Z',
    }),
    '2026-08-30T12:19:30.000Z'
  )
  put(
    'executions',
    EXE.other,
    rawExecution({
      executionId: EXE.other,
      workspaceId: W2,
      projectId: id('prj', 'Z'),
      letter: 'H',
      state: 'running',
      updatedAt: '2026-08-30T12:19:00.000Z',
    }),
    '2026-08-30T12:19:00.000Z'
  )
  // Damaged-source cases (malformed records, corrupted generation rows,
  // overflowing totals, budget-bound scans) are exercised through focused
  // reader doubles below, so this fixture stays a clean, complete store.

  // Attempts, including a completed attempt carrying the artifact reference and
  // an orphan whose execution record does not exist (unattributed, not counted).
  put(
    'execution-attempts',
    ATT.queue,
    rawAttempt({
      attemptId: ATT.queue,
      executionId: EXE.queue,
      sequence: 1,
      state: 'running',
      queuedAt: '2026-08-30T12:00:01.000Z',
      updatedAt: '2026-08-30T12:00:01.000Z',
      runtime: { externalSessionId: SES, runtimeConnectionId: RTC },
    }),
    '2026-08-30T12:00:01.000Z'
  )
  put(
    'execution-attempts',
    ATT.human,
    rawAttempt({
      attemptId: ATT.human,
      executionId: EXE.human,
      sequence: 1,
      state: 'awaiting_input',
      queuedAt: '2026-08-30T12:00:02.000Z',
      updatedAt: '2026-08-30T12:05:00.000Z',
    }),
    '2026-08-30T12:05:00.000Z'
  )
  put(
    'execution-attempts',
    ATT.retry1,
    rawAttempt({
      attemptId: ATT.retry1,
      executionId: EXE.retry,
      sequence: 1,
      state: 'failed',
      queuedAt: '2026-08-30T12:00:00.000Z',
      terminalAt: '2026-08-30T12:00:10.000Z',
      failure: { classification: 'runtime_error', code: 'RUNTIME_ERROR' },
      updatedAt: '2026-08-30T12:00:10.000Z',
    }),
    '2026-08-30T12:00:10.000Z'
  )
  put(
    'execution-attempts',
    ATT.retry2,
    rawAttempt({
      attemptId: ATT.retry2,
      executionId: EXE.retry,
      sequence: 2,
      state: 'running',
      queuedAt: '2026-08-30T12:00:20.000Z',
      updatedAt: '2026-08-30T12:00:20.000Z',
    }),
    '2026-08-30T12:00:20.000Z'
  )
  put(
    'execution-attempts',
    ATT.done,
    rawAttempt({
      attemptId: ATT.done,
      executionId: EXE.done,
      sequence: 1,
      state: 'completed',
      queuedAt: '2026-08-30T12:00:00.000Z',
      terminalAt: '2026-08-30T12:18:00.000Z',
      updatedAt: '2026-08-30T12:18:00.000Z',
    }),
    '2026-08-30T12:18:00.000Z'
  )
  put(
    'execution-attempts',
    ATT.attemptDone,
    rawAttempt({
      attemptId: ATT.attemptDone,
      executionId: EXE.attemptDone,
      sequence: 1,
      state: 'completed',
      queuedAt: '2026-08-30T12:19:00.000Z',
      terminalAt: '2026-08-30T12:19:30.000Z',
      terminalResultRef: ART2,
      updatedAt: '2026-08-30T12:19:30.000Z',
    }),
    '2026-08-30T12:19:30.000Z'
  )
  put(
    'execution-attempts',
    ATT.orphan,
    rawAttempt({
      attemptId: ATT.orphan,
      executionId: EXE.missing,
      sequence: 1,
      state: 'running',
      queuedAt: '2026-08-30T12:00:00.000Z',
      updatedAt: '2026-08-30T12:00:00.000Z',
    }),
    '2026-08-30T12:00:00.000Z'
  )

  // Jobs: one dispatched with a two-second queue latency on a stale generation,
  // one still queued and already expired, one in the other workspace.
  put(
    'runtime-commands',
    CMD.dispatched,
    rawCommand({
      commandId: CMD.dispatched,
      executionId: EXE.queue,
      attemptId: ATT.queue,
      status: 'dispatched',
      issuedAt: '2026-08-30T12:00:03.000Z',
      expiresAt: '2026-08-30T13:00:00.000Z',
      updatedAt: '2026-08-30T12:00:05.000Z',
      deliveryAttempts: 1,
      firstDispatchedAt: '2026-08-30T12:00:05.000Z',
      lastChannelGeneration: 5,
    }),
    '2026-08-30T12:00:05.000Z'
  )
  put(
    'runtime-commands',
    CMD.waiting,
    rawCommand({
      commandId: CMD.waiting,
      executionId: EXE.queue,
      attemptId: ATT.queue,
      status: 'queued',
      issuedAt: '2026-08-30T12:10:00.000Z',
      expiresAt: '2026-08-30T12:15:00.000Z',
      updatedAt: '2026-08-30T12:10:00.000Z',
    }),
    '2026-08-30T12:10:00.000Z'
  )
  put(
    'runtime-commands',
    CMD.other,
    rawCommand({
      commandId: CMD.other,
      executionId: EXE.other,
      attemptId: ATT.orphan,
      workspaceId: W2,
      status: 'queued',
      issuedAt: '2026-08-30T12:10:00.000Z',
      expiresAt: '2026-08-30T13:00:00.000Z',
      updatedAt: '2026-08-30T12:10:00.000Z',
    }),
    '2026-08-30T12:10:00.000Z'
  )

  // Current channel generation 6 on this node makes generation 5 stale.
  put(
    'runtime-channel-sequences',
    'seq-node-a',
    { identity: JSON.stringify([W1, NODE, 'gwc_measure_0001', 1, 6]), next: 7 },
    '2026-08-30T12:00:00.000Z'
  )

  // Discovery session projection.
  put(
    'runtime-discovery-sessions',
    SES,
    { workspaceId: W1, model: sessionModel },
    '2026-08-30T12:00:00.000Z'
  )

  // Approvals: responded after 60s, pending for 15 minutes, expired, orphan.
  put(
    'interaction-requests',
    INT.responded,
    rawInteraction({
      interactionId: INT.responded,
      executionId: EXE.human,
      attemptId: ATT.human,
      state: 'responded',
      requestedAt: '2026-08-30T12:00:05.000Z',
      resolvedAt: '2026-08-30T12:01:05.000Z',
      response: {
        responseId: id('cmd', 'R'),
        action: 'approve',
        respondingPrincipalId: 'svc-operator',
        respondedAt: '2026-08-30T12:01:05.000Z',
      },
    }),
    '2026-08-30T12:01:05.000Z'
  )
  put(
    'interaction-requests',
    INT.pending,
    rawInteraction({
      interactionId: INT.pending,
      executionId: EXE.human,
      attemptId: ATT.human,
      state: 'pending',
      requestedAt: '2026-08-30T12:05:00.000Z',
    }),
    '2026-08-30T12:05:00.000Z'
  )
  put(
    'interaction-requests',
    INT.expired,
    rawInteraction({
      interactionId: INT.expired,
      executionId: EXE.human,
      attemptId: ATT.human,
      state: 'expired',
      requestedAt: '2026-08-30T12:00:06.000Z',
      resolvedAt: '2026-08-30T12:10:00.000Z',
    }),
    '2026-08-30T12:10:00.000Z'
  )
  put(
    'interaction-requests',
    INT.orphan,
    rawInteraction({
      interactionId: INT.orphan,
      executionId: EXE.missing,
      attemptId: ATT.orphan,
      state: 'pending',
      requestedAt: '2026-08-30T12:05:00.000Z',
    }),
    '2026-08-30T12:05:00.000Z'
  )

  // Effects: one pending, one published, one archived, one other workspace.
  put(
    'execution-events',
    EVT.pending,
    rawEvent({
      eventId: EVT.pending,
      executionId: EXE.queue,
      sequence: 1,
      status: 'pending',
      occurredAt: '2026-08-30T12:00:04.000Z',
    }),
    '2026-08-30T12:00:04.000Z'
  )
  put(
    'execution-events',
    EVT.published,
    rawEvent({
      eventId: EVT.published,
      executionId: EXE.queue,
      sequence: 2,
      status: 'published',
      occurredAt: '2026-08-30T12:01:00.000Z',
    }),
    '2026-08-30T12:01:00.000Z'
  )
  put(
    'execution-events',
    EVT.archived,
    rawEvent({
      eventId: EVT.archived,
      executionId: EXE.queue,
      sequence: 3,
      status: 'published',
      occurredAt: '2026-08-30T12:02:00.000Z',
      archivedAt: '2026-08-30T12:02:30.000Z',
    }),
    '2026-08-30T12:02:30.000Z'
  )
  put(
    'execution-events',
    EVT.other,
    rawEvent({
      eventId: EVT.other,
      executionId: EXE.other,
      sequence: 1,
      status: 'pending',
      occurredAt: '2026-08-30T12:00:04.000Z',
      workspaceId: W2,
      projectId: id('prj', 'Z'),
      letter: 'H',
    }),
    '2026-08-30T12:00:04.000Z'
  )

  // Usage: two entries inside the window, one older entry outside it, one in
  // the other workspace, and one budget whose open reservation is the only
  // reserved authority in this workspace.
  put(
    'usage-ledger-entries',
    USG.model,
    rawUsageEntry({
      entryId: USG.model,
      sequence: 1,
      executionId: EXE.retry,
      attemptId: ATT.retry2,
      kind: 'model_usage',
      model: true,
      quantity: { unit: 'tokens', value: 1000 },
      costMicrounits: 1234,
      costExact: true,
      fundingSource: 'hq_managed',
      recordedAt: '2026-08-30T12:00:00.000Z',
    }),
    '2026-08-30T12:00:00.000Z'
  )
  put(
    'usage-ledger-entries',
    USG.tool,
    rawUsageEntry({
      entryId: USG.tool,
      sequence: 1,
      executionId: EXE.queue,
      kind: 'tool_charge',
      quantity: { unit: 'calls', value: 3 },
      costMicrounits: 500,
      costExact: false,
      fundingSource: 'external_subscription',
      recordedAt: '2026-08-30T12:00:10.000Z',
    }),
    '2026-08-30T12:00:10.000Z'
  )
  put(
    'usage-ledger-entries',
    USG.old,
    rawUsageEntry({
      entryId: USG.old,
      sequence: 2,
      executionId: EXE.retry,
      attemptId: ATT.retry2,
      kind: 'model_usage',
      model: true,
      quantity: { unit: 'tokens', value: 9999 },
      costMicrounits: 999,
      costExact: true,
      fundingSource: 'hq_managed',
      recordedAt: '2026-01-01T00:00:00.000Z',
    }),
    '2026-01-01T00:00:00.000Z'
  )
  put(
    'usage-ledger-entries',
    USG.other,
    rawUsageEntry({
      entryId: USG.other,
      sequence: 1,
      executionId: EXE.other,
      workspaceId: W2,
      kind: 'tool_charge',
      quantity: { unit: 'calls', value: 7 },
      costMicrounits: 700,
      costExact: true,
      fundingSource: 'hq_managed',
      recordedAt: '2026-08-30T12:00:11.000Z',
    }),
    '2026-08-30T12:00:11.000Z'
  )
  put(
    'usage-budgets',
    EXE.retry,
    {
      schemaVersion: 1,
      workspaceId: W1,
      executionId: EXE.retry,
      currency: 'USD',
      maximumMicrounits: 10000,
      maximumTokens: 100000,
      status: 'open',
      nextSequence: 3,
      reservations: [
        {
          reservationKey: `runtime-attempt:${ATT.retry2}`,
          attemptId: ATT.retry2,
          maximumMicrounits: 10000,
          maximumTokens: 100000,
          chargedMicrounits: 4000,
          chargedTokens: 5000,
          status: 'open',
        },
      ],
    },
    '2026-08-30T12:00:00.000Z'
  )

  // A workspace-scoped plan row and a namespace outside the measured set.
  put(
    'execution-plans',
    planPin.executionPlanId,
    { correlation: { workspaceId: W1, projectId: PRJ1 }, contentDigest: planPin.contentDigest },
    '2026-08-30T11:00:00.000Z'
  )
  put(
    'command-inbox',
    'inbox-1',
    { workspaceId: W1, operation: 'accept' },
    '2026-08-30T12:00:00.000Z'
  )

  database.close()
  // Match the production store's permissions so the packaged command's
  // protected-target checks accept the fixture exactly as they accept a real
  // Local or Hosted Simple data directory.
  await chmod(databasePath, 0o600)
  databaseBytesBefore = createHash('sha256')
    .update(await readFile(databasePath))
    .digest('hex')
}

async function measure(options = {}) {
  const database = await openReadOnly(databasePath)
  try {
    return measureOperations(createSqliteMeasurementReader(database), {
      workspaceId: W1,
      now: NOW,
      ...options,
    })
  } finally {
    database.close()
  }
}

beforeAll(async () => {
  await seed()
})

afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
})

test('correlates conversation, job, attempt, session, approval, effect and artifact state', async () => {
  const report = await measure()
  expect(report.readOnly).toBe(true)
  expect(report.command).toBe('local.operator.telemetry.operations')
  expect(report.scope).toEqual({ workspaceId: W1 })
  expect(report.summary.complete).toBe(true)
  expect(report.summary.sourceQuality).toEqual({
    scansComplete: true,
    recordsClean: true,
    totalsSafe: true,
  })
  expect(report.summary.incompleteSources).toEqual([])
  expect(report.summary.incompleteScans).toEqual([])
  expect(report.summary.executions).toBe(7)
  expect(report.summary.outOfScopeExecutions).toBe(1)

  const byId = new Map(report.correlation.map((view) => [view.executionId, view]))

  // Conversation anchors and the live job cluster on the running execution.
  const queue = byId.get(EXE.queue)
  expect(queue.conversation).toEqual({
    availability: 'reference_only',
    authority: 'agent_hq_reference',
    taskId: id('tsk', 'A'),
    agentId: id('agt', 'A'),
    requestId: id('req', 'A'),
  })
  expect(queue.job).toEqual({
    availability: 'resolved',
    active: 2,
    queued: 1,
    settled: 0,
    staleGeneration: true,
    generationScanComplete: true,
    oldestActiveAgeMs: 1195000,
  })
  expect(queue.attempt).toMatchObject({
    availability: 'resolved',
    attemptId: ATT.queue,
    state: 'running',
    retryCount: 0,
  })
  expect(queue.session).toEqual({
    availability: 'resolved',
    externalSessionId: SES,
    state: 'active',
    recoverable: true,
    observedAt: '2026-08-30T12:00:00.000Z',
  })
  expect(queue.approval).toMatchObject({ availability: 'resolved', pending: 0 })
  expect(queue.effect).toMatchObject({
    availability: 'resolved',
    pending: 1,
    published: 1,
    oldestPendingAgeMs: 1196000,
  })
  expect(queue.artifact).toEqual({
    availability: 'unreferenced',
    authority: 'product_artifact_reference',
    artifactId: null,
    source: null,
  })
  expect(queue.reconciliationAgeMs).toBe(60000)

  // Artifact references resolve as references only, from execution or attempt.
  expect(byId.get(EXE.done).artifact).toEqual({
    availability: 'reference_only',
    authority: 'product_artifact_reference',
    artifactId: ART,
    source: 'execution',
  })
  expect(byId.get(EXE.attemptDone).artifact).toMatchObject({
    availability: 'reference_only',
    artifactId: ART2,
    source: 'attempt',
  })

  // A record with no attempt, job, session or artifact is explicit, not blank.
  const ghost = byId.get(EXE.ghost)
  expect(ghost.attempt.availability).toBe('not_established')
  expect(ghost.job.availability).toBe('unreferenced')
  expect(ghost.session.availability).toBe('not_established')
  expect(ghost.artifact.availability).toBe('unreferenced')
  expect(ghost.reconciliationAgeMs).toBe(2550000000)

  // Approvals and retries on their own executions.
  expect(byId.get(EXE.human).approval).toMatchObject({
    availability: 'resolved',
    pending: 1,
    responded: 1,
    expired: 1,
    oldestPendingAgeMs: 900000,
  })
  expect(byId.get(EXE.retry).attempt).toMatchObject({
    availability: 'resolved',
    attemptId: ATT.retry2,
    sequence: 2,
    retryCount: 1,
  })
  expect(byId.get(EXE.recon).reconciliationAgeMs).toBe(900000)
})

test('measures queue and human latency', async () => {
  const { queueLatency, humanLatency } = (await measure()).measurements
  expect(queueLatency.dispatch).toEqual({ samples: 1, minMs: 2000, medianMs: 2000, maxMs: 2000 })
  expect(queueLatency.waiting).toEqual({
    samples: 1,
    minMs: 600000,
    medianMs: 600000,
    maxMs: 600000,
  })
  expect(queueLatency.waitingExpiredCount).toBe(1)
  expect(humanLatency.responded).toEqual({
    samples: 1,
    minMs: 60000,
    medianMs: 60000,
    maxMs: 60000,
  })
  expect(humanLatency.waiting).toEqual({
    samples: 1,
    minMs: 900000,
    medianMs: 900000,
    maxMs: 900000,
  })
  expect(humanLatency.expiredCount).toBe(1)
  expect(humanLatency.cancelledCount).toBe(0)
})

test('measures retry and reconciliation age', async () => {
  const { retryAge, reconciliationAge } = (await measure()).measurements
  expect(retryAge.retriedExecutions).toBe(1)
  expect(retryAge.gap).toEqual({ samples: 1, minMs: 10000, medianMs: 10000, maxMs: 10000 })
  expect(retryAge.current).toEqual({
    samples: 1,
    minMs: 1180000,
    medianMs: 1180000,
    maxMs: 1180000,
  })
  expect(reconciliationAge.nonTerminal.samples).toBe(5)
  expect(reconciliationAge.awaitingReconciliation).toEqual({
    executions: 1,
    oldestMs: 900000,
  })
})

test('measures usage, storage growth, active objects and operating cost', async () => {
  const report = await measure()
  const { usage, storage, activeObjects, operatingCost } = report.measurements

  // Windowed usage excludes the older entry and the other workspace's entry.
  expect(usage.windowEntryCount).toBe(2)
  expect(usage.byUnit).toEqual({ tokens: 1000, calls: 3, milliseconds: 0, bytes: 0, microunits: 0 })
  expect(usage.byCurrency).toEqual({
    USD: { costMicrounits: 1734, exactCostMicrounits: 1234, inexactCostMicrounits: 500 },
  })
  expect(usage.byKind).toEqual({
    model_usage: { count: 1, byCurrency: { USD: 1234 } },
    tool_charge: { count: 1, byCurrency: { USD: 500 } },
  })
  expect(usage.complete).toBe(true)
  expect(usage.unsafeTotals).toBe(false)
  expect(usage.budgets).toMatchObject({
    records: 1,
    open: 1,
    settled: 0,
    byCurrency: { USD: { spentMicrounits: 4000, reservedMicrounits: 6000 } },
    unsafeTotals: false,
  })

  // Storage: scoped bytes per namespace, rewritten churn inside the window,
  // explicit per-namespace completeness, and true growth only from a baseline
  // (absent here, so growth is unavailable rather than estimated).
  expect(storage.totals.bytes).toBeGreaterThan(0)
  expect(storage.totals.records).toBeGreaterThan(0)
  expect(storage.complete).toBe(true)
  expect(storage.baseline).toEqual({ availability: 'absent', generatedAt: null })
  expect(storage.totals.growthBytes).toBeNull()
  const executionsStorage = storage.namespaces.find((row) => row.namespace === 'executions')
  expect(executionsStorage.records).toBe(7)
  expect(executionsStorage.complete).toBe(true)
  expect(executionsStorage.growthBytes).toBeNull()
  expect(executionsStorage.bytesRewrittenInWindow).toBeLessThan(executionsStorage.bytes)
  expect(storage.totals.bytesRewrittenInWindow).toBeLessThan(storage.totals.bytes)
  expect(storage.unmeasuredNamespaces).toEqual(['command-inbox'])

  expect(activeObjects).toEqual({
    complete: true,
    executions: {
      active: 5,
      byState: {
        awaiting_input: 1,
        completed: 2,
        queued: 1,
        reconciliation_required: 1,
        running: 2,
      },
    },
    jobs: { active: 2, byState: { dispatched: 1, queued: 1 } },
    attempts: { active: 3, byState: { awaiting_input: 1, completed: 2, failed: 1, running: 2 } },
    sessions: { active: 1, byState: { active: 1 } },
    approvals: { active: 1, byState: { expired: 1, pending: 1, responded: 1 } },
    effects: { active: 1, byState: { pending: 1, published: 1 } },
  })

  // Operating cost is never inferred: without a rate, storage is unpriced and
  // no total exists.
  expect(operatingCost.usage).toEqual({
    availability: 'measured',
    byCurrency: { USD: { spentMicrounits: 4000, reservedMicrounits: 6000 } },
  })
  expect(operatingCost.storage).toEqual({
    bytes: storage.totals.bytes,
    rateUsdPerGiBMonth: null,
    costMicrounits: null,
    availability: 'rate_not_configured',
  })
  expect(operatingCost.totalMicrounits).toBeNull()
  expect(operatingCost.totalAvailability).toBe('storage_rate_not_configured')

  // With an explicit operator rate the storage run-rate and the total exist.
  const priced = await measure({ storageUsdPerGiBMonth: 2.5 })
  const expectedStorageMicrounits = Math.round(
    (storage.totals.bytes / (1024 * 1024 * 1024)) * 2.5 * 1_000_000
  )
  expect(priced.measurements.operatingCost.storage).toEqual({
    bytes: storage.totals.bytes,
    rateUsdPerGiBMonth: 2.5,
    costMicrounits: expectedStorageMicrounits,
    availability: 'priced',
  })
  expect(priced.measurements.operatingCost.totalMicrounits).toBe(4000 + expectedStorageMicrounits)
  expect(priced.measurements.operatingCost.totalAvailability).toBe('measured')
})

test('scopes every measurement to the selected workspace', async () => {
  const report = await measure()
  expect(report.summary.unattributedRecords).toEqual({
    'execution-attempts': 1,
    'interaction-requests': 1,
  })
  expect(report.summary.malformedRecords).toEqual({})
  expect(report.summary.sourceQuality).toEqual({
    scansComplete: true,
    recordsClean: true,
    totalsSafe: true,
  })
  expect(JSON.stringify(report)).not.toContain(EXE.other)
  expect(JSON.stringify(report)).not.toContain(W2)
  expect(report.measurements.usage.byUnit.calls).toBe(3)
  const executionsStorage = report.measurements.storage.namespaces.find(
    (row) => row.namespace === 'executions'
  )
  expect(executionsStorage.records).toBe(7)
  // The other workspace's execution row is counted only as out of scope.
  expect(report.summary.outOfScopeExecutions).toBe(1)
})

test('emits only cataloged, bounded, secret-free telemetry points', async () => {
  const report = await measure({ storageUsdPerGiBMonth: 1 })
  const serialized = JSON.stringify(report)
  expect(serialized).not.toContain(CMD_CANARY)
  expect(serialized).not.toContain(PROMPT_CANARY)
  expect(serialized).not.toContain(EVT_CANARY)
  expect(serialized).not.toContain('apiKey')
  expect(serialized).not.toContain('payload')

  expect(report.telemetry.length).toBeGreaterThan(0)
  for (const point of report.telemetry) {
    expect(operationalMetrics).toContain(point.name)
    expect(point.value).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(point.value)).toBe(true)
    for (const [key, value] of Object.entries(point.labels ?? {})) {
      expect([
        'stage',
        'outcome',
        'kind',
        'statistic',
        'exactness',
        'namespace',
        'object_kind',
        'component',
      ]).toContain(key)
      expect(value).not.toBe('other')
      expect(value).not.toContain(W1)
      expect(value).not.toContain('exe_')
    }
  }

  // The report's points pass straight through the shared emission contract.
  const added = []
  const emitter = createOperationsMetricEmitter(
    {
      add: (name, value, attributes) => added.push({ method: 'add', name, value, attributes }),
      record: (name, value, attributes) =>
        added.push({ method: 'record', name, value, attributes }),
      recordGauge: (name, value, attributes) =>
        added.push({ method: 'recordGauge', name, value, attributes }),
    },
    'local-control-plane'
  )
  for (const point of report.telemetry) emitter.record(point)
  expect(added).toHaveLength(report.telemetry.length)
  // Snapshot sizes, active counts and latency summaries are observations and
  // signed growth is a gauge observation: nothing ever takes the counter
  // path, and every growth point takes the gauge path.
  expect(added.every(({ method }) => method === 'record' || method === 'recordGauge')).toBe(true)
  expect(
    added
      .filter(({ name }) => name === operationsMetricNames.storageGrowthBytes)
      .every(({ method }) => method === 'recordGauge')
  ).toBe(true)
  expect(added.every(({ name }) => operationalMetrics.includes(name))).toBe(true)
  expect(
    added.every(({ attributes }) => attributes['service.name'] === 'local-control-plane')
  ).toBe(true)
  expect(JSON.stringify(added)).not.toContain(CMD_CANARY)
  expect(
    report.telemetry.some((point) => point.name === operationsMetricNames.operatingCostUsd)
  ).toBe(true)
})

test('bounds the correlation listing and reports incompleteness honestly', async () => {
  const limited = await measure({ limit: 2 })
  expect(limited.summary.correlationsListed).toBe(2)
  expect(limited.summary.correlationsUnlisted).toBe(5)
  expect(limited.correlation).toHaveLength(2)

  const incomplete = await measure({ maxScanMatches: 2 })
  expect(incomplete.summary.complete).toBe(false)
  expect(incomplete.summary.sourceQuality.scansComplete).toBe(false)
  expect(incomplete.summary.incompleteSources).toContain('executions')
  expect(incomplete.summary.executions).toBe(2)
  expect(incomplete.summary.incompleteScans.map((scan) => scan.namespace)).toContain('executions')
  // The budget-bound usage walk makes the usage section itself admit partiality.
  expect(incomplete.measurements.usage.complete).toBe(false)
  expect(incomplete.measurements.storage.complete).toBe(false)
  const [first] = incomplete.correlation
  expect(first.conversation.availability).toBe('scan_incomplete')
  expect(JSON.stringify(incomplete.summary.incompleteScans)).toContain('match_budget_reached')
})

test('reports an explicit empty workspace instead of a blank one', async () => {
  const report = await measure({ workspaceId: W3 })
  expect(report.summary.complete).toBe(true)
  expect(report.summary.executions).toBe(0)
  expect(report.correlation).toEqual([])
  expect(report.measurements.storage.totals).toEqual({
    records: 0,
    bytes: 0,
    bytesRewrittenInWindow: 0,
    growthBytes: null,
  })
  expect(report.measurements.storage.baseline.availability).toBe('absent')
  expect(report.measurements.usage.windowEntryCount).toBe(0)
  expect(report.measurements.activeObjects.executions.active).toBe(0)
  expect(report.measurements.queueLatency.dispatch.samples).toBe(0)
})

test('never opens the operator database writable', async () => {
  await measure()
  const after = createHash('sha256')
    .update(await readFile(databasePath))
    .digest('hex')
  expect(after).toBe(databaseBytesBefore)
})

async function runCli(arguments_, timeoutMs = 10000) {
  const ledger = process.env['CONTROL_PLANE_LOCAL_RESOURCE_LEDGER']
  if (ledger)
    await appendFile(
      ledger,
      `operator-measurements test child planned; owner=root/measurements-tests; data=${databasePath}; no ports\n`
    )
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('../dist/operator-measurements-cli.js', import.meta.url)),
      ...arguments_,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  if (ledger)
    await appendFile(
      ledger,
      `operator-measurements test child PID=${child.pid}; owner=root/measurements-tests\n`
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
        `operator-measurements test child PID=${child.pid} settled; exit=${child.exitCode}\n`
      )
  }
}

test('packaged operator command measures a private data directory read-only', async () => {
  const { code, stdout, stderr } = await runCli([
    '--data-dir',
    directory,
    '--workspace',
    W1,
    '--limit',
    '3',
    '--storage-usd-per-gib-month',
    '1.5',
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  const report = JSON.parse(stdout)
  expect(report).toMatchObject({
    schemaVersion: 1,
    command: 'local.operator.telemetry.operations',
    readOnly: true,
  })
  expect(report.correlation.length).toBeLessThanOrEqual(3)
  expect(report.thresholds.storageUsdPerGiBMonth).toBe(1.5)
  expect(stdout).not.toContain(CMD_CANARY)
  expect(stdout).not.toContain(PROMPT_CANARY)
})

test('packaged operator command fails closed without a scope', async () => {
  const missingScope = await runCli(['--data-dir', directory])
  expect(missingScope.code).toBe(1)
  expect(missingScope.stderr).toBe('LOCAL_OPERATOR_MEASUREMENTS_FAILED\n')
  expect(missingScope.stdout).toBe('')

  const invalidWindow = await runCli([
    '--data-dir',
    directory,
    '--workspace',
    W1,
    '--window-seconds',
    '1',
  ])
  expect(invalidWindow.code).toBe(1)
  expect(invalidWindow.stderr).toBe('LOCAL_OPERATOR_MEASUREMENTS_FAILED\n')
})

// ---------------------------------------------------------------------------
// Source-quality propagation: corrupted, truncated and overflowing sources are
// marked and their dependent telemetry suppressed instead of asserted.
// ---------------------------------------------------------------------------

/** In-memory `MeasurementRecordReader` double over plain rows. */
function fakeReader(rows) {
  return {
    pageRecords(namespace, pageSize, afterId) {
      const all = (rows[namespace] ?? [])
        .filter((row) => afterId === undefined || row.id > afterId)
        .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      const page = all.slice(0, pageSize)
      const records = []
      let unparseableJsonCount = 0
      for (const row of page) {
        const raw = row.raw ?? JSON.stringify(row.value)
        try {
          records.push({
            id: row.id,
            value: JSON.parse(raw),
            bytes: Buffer.byteLength(raw, 'utf8'),
            updatedAt: row.updatedAt ?? NOW,
          })
        } catch {
          unparseableJsonCount += 1
        }
      }
      const hasMore = all.length > pageSize
      return {
        records,
        unparseableJsonCount,
        rawRowCount: page.length,
        nextAfterId: hasMore ? page.at(-1).id : null,
      }
    },
    namespaces: () => Object.keys(rows),
  }
}

function fakeMeasure(rows, options = {}) {
  return measureOperations(fakeReader(rows), { workspaceId: W1, now: NOW, ...options })
}

function rawBudget({ executionId, currency, spent, settled = false }) {
  return {
    schemaVersion: 1,
    workspaceId: W1,
    executionId,
    currency,
    maximumMicrounits: spent,
    maximumTokens: 0,
    status: settled ? 'settled' : 'open',
    nextSequence: 1,
    reservations: [
      {
        reservationKey: `runtime-attempt:${ATT.queue}`,
        maximumMicrounits: spent,
        maximumTokens: 0,
        chargedMicrounits: spent,
        chargedTokens: 0,
        status: settled ? 'settled' : 'open',
      },
    ],
  }
}

test('computes true growth only against a baseline and marks it absent otherwise', async () => {
  const first = await measure()
  expect(first.measurements.storage.baseline).toEqual({
    availability: 'absent',
    generatedAt: null,
  })
  expect(first.measurements.storage.totals.growthBytes).toBeNull()
  expect(
    first.telemetry.some((point) => point.name === operationsMetricNames.storageGrowthBytes)
  ).toBe(false)

  // Snapshot against itself: every namespace and the totals show a true
  // zero delta, and growth points become emit-able observations.
  const second = await measure({ baselineReport: first })
  expect(second.measurements.storage.baseline).toEqual({
    availability: 'complete',
    generatedAt: first.generatedAt,
  })
  expect(second.measurements.storage.totals.growthBytes).toBe(0)
  for (const row of second.measurements.storage.namespaces) expect(row.growthBytes).toBe(0)
  const growthPoints = second.telemetry.filter(
    (point) => point.name === operationsMetricNames.storageGrowthBytes
  )
  expect(growthPoints.length).toBeGreaterThan(0)
  expect(growthPoints.every((point) => point.value === 0)).toBe(true)

  // Deletions shrink: a baseline that retained 500 more bytes in one
  // namespace yields a negative delta — rewritten-bytes churn can never
  // express this, which is exactly why it is no longer called growth.
  const shrunken = structuredClone(first)
  const executionsRow = shrunken.measurements.storage.namespaces.find(
    (row) => row.namespace === 'executions'
  )
  executionsRow.bytes += 500
  const third = await measure({ baselineReport: shrunken })
  const thirdExecutions = third.measurements.storage.namespaces.find(
    (row) => row.namespace === 'executions'
  )
  expect(thirdExecutions.growthBytes).toBe(-500)
  expect(third.measurements.storage.totals.growthBytes).toBe(-500)
  const executionsGrowthPoint = third.telemetry.find(
    (point) =>
      point.name === operationsMetricNames.storageGrowthBytes &&
      point.labels.namespace === 'executions'
  )
  expect(executionsGrowthPoint.value).toBe(-500)

  // The signed shrinkage point survives the shared emission contract through
  // the gauge path — never the histogram/counter paths.
  const emitted = []
  const emitter = createOperationsMetricEmitter(
    {
      add: (name, value, attributes) => emitted.push({ method: 'add', name, value, attributes }),
      record: (name, value, attributes) =>
        emitted.push({ method: 'record', name, value, attributes }),
      recordGauge: (name, value, attributes) =>
        emitted.push({ method: 'recordGauge', name, value, attributes }),
    },
    'local-control-plane'
  )
  for (const point of third.telemetry) emitter.record(point)
  const emittedGrowth = emitted.filter(
    ({ name }) => name === operationsMetricNames.storageGrowthBytes
  )
  expect(emittedGrowth).toHaveLength(
    third.telemetry.filter((point) => point.name === operationsMetricNames.storageGrowthBytes)
      .length
  )
  expect(emittedGrowth.every(({ method }) => method === 'recordGauge')).toBe(true)
  expect(emittedGrowth.some(({ value }) => value === -500)).toBe(true)
  expect(emitted.every(({ method }) => method !== 'add')).toBe(true)

  // A baseline from another workspace or an unparsable one fails closed
  // instead of producing a misleading delta.
  const foreign = structuredClone(first)
  foreign.scope.workspaceId = W2
  expect(() => measure({ baselineReport: foreign })).toThrow('BASELINE_SCOPE_MISMATCH')
  expect(() => measure({ baselineReport: { nope: true } })).toThrow('BASELINE_REPORT_INVALID')
})

test('marks a corrupted generation source and refuses current verdicts from it', () => {
  const nodeB = id('rnr', 'B')
  const report = fakeMeasure({
    executions: [
      {
        id: recordId(EXE.queue),
        value: rawExecution({ executionId: EXE.queue, state: 'running', updatedAt: NOW }),
        updatedAt: NOW,
      },
      {
        id: recordId(EXE.human),
        value: rawExecution({
          executionId: EXE.human,
          letter: 'B',
          state: 'running',
          updatedAt: NOW,
        }),
        updatedAt: NOW,
      },
    ],
    'runtime-commands': [
      {
        id: recordId(CMD.dispatched),
        value: rawCommand({
          commandId: CMD.dispatched,
          executionId: EXE.queue,
          attemptId: ATT.queue,
          status: 'dispatched',
          issuedAt: '2026-08-30T12:00:03.000Z',
          expiresAt: '2026-08-30T13:00:00.000Z',
          updatedAt: '2026-08-30T12:00:05.000Z',
          deliveryAttempts: 1,
          firstDispatchedAt: '2026-08-30T12:00:05.000Z',
          lastChannelGeneration: 1,
        }),
        updatedAt: '2026-08-30T12:00:05.000Z',
      },
      {
        id: recordId(CMD.waiting),
        value: rawCommand({
          commandId: CMD.waiting,
          executionId: EXE.human,
          attemptId: ATT.human,
          nodeId: nodeB,
          status: 'dispatched',
          issuedAt: '2026-08-30T12:00:03.000Z',
          expiresAt: '2026-08-30T13:00:00.000Z',
          updatedAt: '2026-08-30T12:00:05.000Z',
          deliveryAttempts: 1,
          firstDispatchedAt: '2026-08-30T12:00:05.000Z',
          lastChannelGeneration: 1,
        }),
        updatedAt: '2026-08-30T12:00:05.000Z',
      },
    ],
    'runtime-channel-sequences': [
      {
        id: 'seq-node-a',
        value: { identity: JSON.stringify([W1, NODE, 'gwc_measure_0001', 1, 1]), next: 2 },
        updatedAt: NOW,
      },
      // Corrupted reservation row: the walk completes, but the source is not
      // clean, so no non-stale verdict may be asserted from it.
      { id: 'seq-node-a-broken', raw: '{corrupted-identity', updatedAt: NOW },
      {
        id: 'seq-node-b',
        value: { identity: JSON.stringify([W1, nodeB, 'gwc_measure_0002', 1, 2]), next: 3 },
        updatedAt: NOW,
      },
    ],
  })

  expect(report.summary.complete).toBe(false)
  expect(report.summary.sourceQuality).toEqual({
    scansComplete: true,
    recordsClean: false,
    totalsSafe: true,
  })
  expect(report.summary.incompleteSources).toEqual(['runtime-channel-sequences'])
  expect(report.summary.malformedRecords['runtime-channel-sequences']).toBeGreaterThanOrEqual(1)

  const byId = new Map(report.correlation.map((view) => [view.executionId, view]))
  // Would look current against the walked generation, but the source is
  // dirty: verdict collapses to unknown with the completeness made explicit.
  expect(byId.get(EXE.queue).job).toMatchObject({
    staleGeneration: null,
    generationScanComplete: false,
    active: 1,
  })
  // A positive stale verdict survives the damaged source: the walked
  // reservation already proves the lag.
  expect(byId.get(EXE.human).job).toMatchObject({
    staleGeneration: true,
    generationScanComplete: false,
  })

  const storage = report.measurements.storage
  expect(storage.complete).toBe(false)
  expect(
    storage.namespaces.find((row) => row.namespace === 'runtime-channel-sequences').complete
  ).toBe(false)

  // A partial storage snapshot cannot produce an ordinary priced cost.
  const priced = fakeMeasure(
    {
      executions: [
        {
          id: recordId(EXE.queue),
          value: rawExecution({ executionId: EXE.queue, state: 'running', updatedAt: NOW }),
          updatedAt: NOW,
        },
      ],
      'runtime-channel-sequences': [{ id: 'seq-broken', raw: '{corrupted', updatedAt: NOW }],
    },
    { storageUsdPerGiBMonth: 1.5 }
  )
  expect(priced.measurements.operatingCost.storage).toMatchObject({
    availability: 'source_partial',
  })
  expect(priced.measurements.operatingCost.storage.costMicrounits).not.toBeNull()
  expect(
    priced.telemetry.some((point) => point.name === operationsMetricNames.operatingCostUsd)
  ).toBe(false)
})

test('marks budget-bound usage scans partial and suppresses their USD cost points', () => {
  const rows = {
    executions: [
      {
        id: recordId(EXE.queue),
        value: rawExecution({ executionId: EXE.queue, state: 'running', updatedAt: NOW }),
        updatedAt: NOW,
      },
    ],
    'runtime-commands': [
      {
        id: recordId(CMD.dispatched),
        value: rawCommand({
          commandId: CMD.dispatched,
          executionId: EXE.queue,
          attemptId: ATT.queue,
          status: 'dispatched',
          issuedAt: '2026-08-30T12:00:03.000Z',
          expiresAt: '2026-08-30T13:00:00.000Z',
          updatedAt: '2026-08-30T12:00:05.000Z',
          deliveryAttempts: 1,
          firstDispatchedAt: '2026-08-30T12:00:05.000Z',
          lastChannelGeneration: 1,
        }),
        updatedAt: '2026-08-30T12:00:05.000Z',
      },
    ],
    'usage-ledger-entries': [
      {
        id: recordId(USG.model),
        value: rawUsageEntry({
          entryId: USG.model,
          sequence: 1,
          executionId: EXE.retry,
          attemptId: ATT.retry2,
          kind: 'model_usage',
          model: true,
          quantity: { unit: 'tokens', value: 1000 },
          costMicrounits: 1234,
          costExact: true,
          fundingSource: 'hq_managed',
          recordedAt: '2026-08-30T12:00:00.000Z',
        }),
        updatedAt: NOW,
      },
      {
        id: recordId(USG.tool),
        value: rawUsageEntry({
          entryId: USG.tool,
          sequence: 1,
          executionId: EXE.queue,
          kind: 'tool_charge',
          quantity: { unit: 'calls', value: 3 },
          costMicrounits: 500,
          costExact: true,
          fundingSource: 'hq_managed',
          recordedAt: '2026-08-30T12:00:10.000Z',
        }),
        updatedAt: NOW,
      },
      {
        id: recordId(USG.old),
        value: rawUsageEntry({
          entryId: USG.old,
          sequence: 2,
          executionId: EXE.retry,
          attemptId: ATT.retry2,
          kind: 'model_usage',
          model: true,
          quantity: { unit: 'tokens', value: 9999 },
          costMicrounits: 999,
          costExact: true,
          fundingSource: 'hq_managed',
          recordedAt: '2026-08-30T12:01:00.000Z',
        }),
        updatedAt: NOW,
      },
    ],
    'usage-budgets': [
      {
        id: recordId(EXE.retry),
        value: rawBudget({ executionId: EXE.retry, currency: 'USD', spent: 4000 }),
        updatedAt: NOW,
      },
    ],
  }
  // One in-scope match per namespace: single-record namespaces stay complete,
  // the three-entry usage namespace is cut off at the budget.
  const report = fakeMeasure(rows, { maxScanMatches: 1 })

  expect(report.summary.complete).toBe(false)
  expect(report.summary.sourceQuality).toEqual({
    scansComplete: false,
    recordsClean: true,
    totalsSafe: true,
  })
  expect(report.summary.incompleteSources).toContain('usage-ledger-entries')
  expect(report.measurements.usage.complete).toBe(false)
  expect(report.measurements.storage.complete).toBe(false)
  expect(
    report.measurements.storage.namespaces.find((row) => row.namespace === 'usage-ledger-entries')
      .complete
  ).toBe(false)
  expect(report.telemetry.some((point) => point.name === operationsMetricNames.usageCostUsd)).toBe(
    false
  )

  // Sections whose own sources are clean stay complete and keep their points:
  // partiality is attributed per source, not smeared over the whole report.
  expect(report.measurements.queueLatency.complete).toBe(true)
  expect(report.telemetry.some((point) => point.name === operationsMetricNames.queueLatency)).toBe(
    true
  )
  // The budget snapshot itself is complete, so the operating-cost usage
  // component remains measured; the total is still blocked by the rate rule.
  expect(report.measurements.operatingCost.usage.availability).toBe('measured')
  expect(report.measurements.operatingCost.totalAvailability).toBe('storage_rate_not_configured')
})

test('marks overflowed totals unsafe instead of reporting them as measured cost', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const rows = {
    executions: [
      {
        id: recordId(EXE.queue),
        value: rawExecution({ executionId: EXE.queue, state: 'running', updatedAt: NOW }),
        updatedAt: NOW,
      },
    ],
    'usage-ledger-entries': [
      {
        id: recordId(USG.model),
        value: rawUsageEntry({
          entryId: USG.model,
          sequence: 1,
          executionId: EXE.retry,
          attemptId: ATT.retry2,
          kind: 'model_usage',
          model: true,
          quantity: { unit: 'tokens', value: 1000 },
          costMicrounits: MAX,
          costExact: true,
          fundingSource: 'hq_managed',
          recordedAt: '2026-08-30T12:00:00.000Z',
        }),
        updatedAt: NOW,
      },
      {
        id: recordId(USG.old),
        value: rawUsageEntry({
          entryId: USG.old,
          sequence: 2,
          executionId: EXE.retry,
          attemptId: ATT.retry2,
          kind: 'model_usage',
          model: true,
          quantity: { unit: 'tokens', value: 500 },
          costMicrounits: MAX,
          costExact: true,
          fundingSource: 'hq_managed',
          recordedAt: '2026-08-30T12:01:00.000Z',
        }),
        updatedAt: NOW,
      },
    ],
    'usage-budgets': [
      {
        id: recordId(EXE.retry),
        value: rawBudget({ executionId: EXE.retry, currency: 'USD', spent: MAX, settled: true }),
        updatedAt: NOW,
      },
      {
        id: recordId(EXE.done),
        value: rawBudget({ executionId: EXE.done, currency: 'USD', spent: MAX, settled: true }),
        updatedAt: NOW,
      },
    ],
  }
  const report = fakeMeasure(rows)

  expect(report.summary.complete).toBe(false)
  expect(report.summary.sourceQuality).toEqual({
    scansComplete: true,
    recordsClean: true,
    totalsSafe: false,
  })
  expect(report.summary.incompleteSources).toEqual(
    expect.arrayContaining(['usage-ledger-entries', 'usage-budgets'])
  )
  expect(report.measurements.usage.unsafeTotals).toBe(true)
  expect(report.measurements.usage.budgets.unsafeTotals).toBe(true)
  expect(report.measurements.usage.complete).toBe(false)
  // Affected totals hold their last safe value and are explicitly unsafe.
  expect(report.measurements.usage.byCurrency.USD.costMicrounits).toBe(MAX)
  expect(report.measurements.operatingCost.usage.availability).toBe('unsafe_totals')
  expect(report.measurements.operatingCost.totalAvailability).toBe('usage_unsafe_totals')
  expect(report.measurements.operatingCost.totalMicrounits).toBeNull()
  expect(report.telemetry.some((point) => point.name === operationsMetricNames.usageCostUsd)).toBe(
    false
  )
})

test('keeps currencies separated in every derived total (USD + EUR regression)', () => {
  const rows = {
    executions: [
      {
        id: recordId(EXE.queue),
        value: rawExecution({ executionId: EXE.queue, state: 'running', updatedAt: NOW }),
        updatedAt: NOW,
      },
    ],
    'usage-ledger-entries': [
      {
        id: recordId(USG.tool),
        value: rawUsageEntry({
          entryId: USG.tool,
          sequence: 1,
          executionId: EXE.queue,
          kind: 'tool_charge',
          quantity: { unit: 'calls', value: 1 },
          costMicrounits: 100,
          costExact: true,
          fundingSource: 'hq_managed',
          recordedAt: '2026-08-30T12:00:00.000Z',
        }),
        updatedAt: NOW,
      },
      {
        id: recordId(USG.other),
        value: {
          ...rawUsageEntry({
            entryId: USG.other,
            sequence: 2,
            executionId: EXE.queue,
            kind: 'tool_charge',
            quantity: { unit: 'calls', value: 2 },
            costMicrounits: 500,
            costExact: false,
            fundingSource: 'external_subscription',
            recordedAt: '2026-08-30T12:00:01.000Z',
          }),
          currency: 'EUR',
        },
        updatedAt: NOW,
      },
      {
        id: recordId(USG.model),
        value: rawUsageEntry({
          entryId: USG.model,
          sequence: 3,
          executionId: EXE.retry,
          attemptId: ATT.retry2,
          kind: 'model_usage',
          model: true,
          quantity: { unit: 'tokens', value: 1000 },
          costMicrounits: 1234,
          costExact: true,
          fundingSource: 'hq_managed',
          recordedAt: '2026-08-30T12:00:02.000Z',
        }),
        updatedAt: NOW,
      },
    ],
    'usage-budgets': [
      {
        id: recordId(EXE.retry),
        value: rawBudget({ executionId: EXE.retry, currency: 'USD', spent: 4000, settled: true }),
        updatedAt: NOW,
      },
      {
        id: recordId(EXE.done),
        value: rawBudget({ executionId: EXE.done, currency: 'EUR', spent: 250, settled: true }),
        updatedAt: NOW,
      },
    ],
  }
  const report = fakeMeasure(rows)

  // Per-kind costs stay separated: summing USD and EUR microunits together
  // would be a meaningless number.
  expect(report.measurements.usage.byKind).toEqual({
    model_usage: { count: 1, byCurrency: { USD: 1234 } },
    tool_charge: { count: 2, byCurrency: { EUR: 500, USD: 100 } },
  })
  expect(report.measurements.usage.byCurrency).toEqual({
    EUR: { costMicrounits: 500, exactCostMicrounits: 0, inexactCostMicrounits: 500 },
    USD: { costMicrounits: 1334, exactCostMicrounits: 1334, inexactCostMicrounits: 0 },
  })
  expect(report.measurements.operatingCost.usage).toEqual({
    availability: 'measured',
    byCurrency: {
      EUR: { spentMicrounits: 250, reservedMicrounits: 0 },
      USD: { spentMicrounits: 4000, reservedMicrounits: 0 },
    },
  })
  // Mixed currencies can never combine into one total.
  expect(report.measurements.operatingCost.totalMicrounits).toBeNull()
  expect(report.measurements.operatingCost.totalAvailability).toBe('usage_currency_unsupported')

  // usage.cost.usd is USD-denominated by name: EUR cost never joins it.
  const usdCostPoints = report.telemetry.filter(
    (point) => point.name === operationsMetricNames.usageCostUsd
  )
  expect(usdCostPoints.length).toBeGreaterThan(0)
  expect(usdCostPoints.map((point) => point.value).toSorted()).toEqual([0, 1334 / 1_000_000])
})

test('packaged operator command computes growth against a baseline report', async () => {
  const first = await runCli(['--data-dir', directory, '--workspace', W1])
  expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: '' })
  const baselineReport = JSON.parse(first.stdout)
  expect(baselineReport.measurements.storage.complete).toBe(true)

  const baselinePath = join(directory, 'baseline-report.json')
  await writeFile(baselinePath, first.stdout, { mode: 0o600 })
  const second = await runCli([
    '--data-dir',
    directory,
    '--workspace',
    W1,
    '--baseline-report',
    baselinePath,
  ])
  expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: '' })
  const report = JSON.parse(second.stdout)
  expect(report.measurements.storage.baseline).toEqual({
    availability: 'complete',
    generatedAt: baselineReport.generatedAt,
  })
  expect(report.measurements.storage.totals.growthBytes).toBe(0)

  // A baseline file that is not a report fails closed.
  const invalid = await runCli([
    '--data-dir',
    directory,
    '--workspace',
    W1,
    '--baseline-report',
    databasePath,
  ])
  expect(invalid.code).toBe(1)
  expect(invalid.stderr).toBe('LOCAL_OPERATOR_MEASUREMENTS_FAILED\n')
  expect(invalid.stdout).toBe('')
}, 30_000)

test('forces generation verdicts unknown when the reservation walk is budget-bound', () => {
  // The first walked reservation matches the job's generation (a `false`
  // verdict without truncation), but a later reservation the budget cut off
  // could hold a higher generation: the verdict must collapse to unknown.
  const rows = {
    executions: [
      {
        id: recordId(EXE.queue),
        value: rawExecution({ executionId: EXE.queue, state: 'running', updatedAt: NOW }),
        updatedAt: NOW,
      },
    ],
    'runtime-commands': [
      {
        id: recordId(CMD.dispatched),
        value: rawCommand({
          commandId: CMD.dispatched,
          executionId: EXE.queue,
          attemptId: ATT.queue,
          status: 'dispatched',
          issuedAt: '2026-08-30T12:00:03.000Z',
          expiresAt: '2026-08-30T13:00:00.000Z',
          updatedAt: '2026-08-30T12:00:05.000Z',
          deliveryAttempts: 1,
          firstDispatchedAt: '2026-08-30T12:00:05.000Z',
          lastChannelGeneration: 1,
        }),
        updatedAt: '2026-08-30T12:00:05.000Z',
      },
    ],
    'runtime-channel-sequences': [
      {
        id: 'seq-1',
        value: { identity: JSON.stringify([W1, NODE, 'gwc_measure_0001', 1, 1]), next: 2 },
        updatedAt: NOW,
      },
      {
        id: 'seq-2',
        value: { identity: JSON.stringify([W1, NODE, 'gwc_measure_0001', 2, 4]), next: 5 },
        updatedAt: NOW,
      },
    ],
  }
  const full = fakeMeasure(rows)
  expect(full.correlation[0].job).toMatchObject({
    staleGeneration: true,
    generationScanComplete: true,
  })

  const truncated = fakeMeasure(rows, { maxScanMatches: 1 })
  expect(truncated.summary.sourceQuality.scansComplete).toBe(false)
  expect(truncated.summary.incompleteSources).toContain('runtime-channel-sequences')
  expect(truncated.correlation[0].job).toMatchObject({
    staleGeneration: null,
    generationScanComplete: false,
  })
})
