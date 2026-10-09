import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChildProgressEvidenceBuffer,
  ChildProgressLeadDispatcher,
  ChildProgressLeadFeed,
  ChildUsageLedger,
  resolveEvidenceReferences,
} from '@control-plane/orchestration'
import { SqliteDelegationEventPublisher } from './delegation-event-publisher.js'
import { SqlitePersistenceProvider } from './provider.js'
import { json, recordId } from './record-storage.js'

// Actual durable composition: the lead feed runs over the canonical
// SqliteDelegationEventPublisher inside a real SQLite store, survives a real
// close/reopen restart through replay, and the child usage cost states are
// persisted through the same store and restored with their dedup horizons.
const PARENT = 'exe_01JABCDEF0123456789ABCDEFG'
const CHILD_A = 'exe_01JBBCDEF0123456789ABCDEFG'
const CHILD_B = 'exe_01JCBCDEF0123456789ABCDEFG'
const DLG_A = 'dlg_01JBBCDEF0123456789ABCDEFG'
const DLG_B = 'dlg_01JCBCDEF0123456789ABCDEFG'
const ATT_A = 'att_01JBBCDEF0123456789ABCDEFG'
const ATT_B = 'att_01JCBCDEF0123456789ABCDEFG'
const ART_A = 'art_01JBBCDEF0123456789ABCDEFG'
const WSP = 'wsp_01JABCDEF0123456789ABCDEFG'
const PLN = 'pln_01JABCDEF0123456789ABCDEFG'

const progressEvent = (overrides) => ({
  type: 'delegation.progress',
  delegationId: DLG_A,
  parentExecutionId: PARENT,
  childExecutionId: CHILD_A,
  occurredAt: '2026-08-25T18:05:00.000Z',
  details: { state: 'running', childAttemptId: ATT_A },
  ...overrides,
})

const completedEvent = (overrides) => ({
  type: 'delegation.completed',
  delegationId: DLG_A,
  parentExecutionId: PARENT,
  childExecutionId: CHILD_A,
  occurredAt: '2026-08-25T18:06:00.000Z',
  details: { childAttemptId: ATT_A, terminalResultRef: ART_A },
  ...overrides,
})

const childBProgress = () =>
  progressEvent({
    delegationId: DLG_B,
    childExecutionId: CHILD_B,
    details: { state: 'running', childAttemptId: ATT_B },
  })

const childBCompleted = () =>
  completedEvent({
    delegationId: DLG_B,
    childExecutionId: CHILD_B,
    details: { childAttemptId: ATT_B, terminalResultRef: ART_A },
  })

function createFeed(provider, parentExecutionId = PARENT) {
  const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId })
  const dispatcher = new ChildProgressLeadDispatcher({ buffer })
  return {
    dispatcher,
    feed: new ChildProgressLeadFeed({
      publications: new SqliteDelegationEventPublisher(provider, parentExecutionId),
      dispatcher,
      generationOf: () => 1,
    }),
  }
}

const USAGE_NAMESPACE = 'child-usage-outcomes'
let directory
let databasePath

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cp-child-progress-feed-'))
  databasePath = join(directory, 'canonical.sqlite')
  const provider = new SqlitePersistenceProvider({ path: databasePath })
  await provider.migrate()
  provider.close()
})

afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
})

test('two children and human input flow through the durable publication path', async () => {
  const provider = new SqlitePersistenceProvider({ path: databasePath })
  await provider.migrate()
  const { feed } = createFeed(provider)

  await feed.publish(progressEvent(), `delegation:${DLG_A}:progress:1`)
  await feed.publish(childBProgress(), `delegation:${DLG_B}:progress:1`)
  expect(feed.takeDeliveries()).toEqual([])

  await feed.publish(completedEvent(), `delegation:${DLG_A}:completed:1`)
  await feed.publish(childBCompleted(), `delegation:${DLG_B}:completed:1`)
  const deliveries = feed.takeDeliveries()
  expect(deliveries).toHaveLength(2)
  expect(deliveries[0].sequence).toBe(1)
  expect(deliveries[1].sequence).toBe(2)

  // Both children are represented across the sealed packets' entries and
  // snapshots — the lead sees the whole window, not one branch.
  const delegations = new Set(
    deliveries.flatMap((delivery) => [
      ...delivery.packet.entries.map((entry) => entry.delegationId),
      ...delivery.packet.childSnapshots.map((snapshot) => snapshot.delegationId),
    ])
  )
  expect([...delegations].toSorted()).toStrictEqual([DLG_A, DLG_B])

  // Human input lands on the outbox in its own scheduling step.
  feed.acceptHumanInput({
    interactionId: 'int_01JBBCDEF0123456789ABCDEFG',
    kind: 'input',
    receivedAt: '2026-08-25T18:06:30.000Z',
  })
  expect(feed.takeDeliveries()[0]).toMatchObject({ kind: 'human_input' })

  // The canonical outlet retained every publication durably.
  const stored = await feed.list()
  expect(stored).toHaveLength(4)
  provider.close()
})

test('restart replays from the durable outlet exactly once and restores usage cost states', async () => {
  // Persist the usage cost-state snapshot through the canonical durable store.
  const running = new ChildUsageLedger()
  const identity = {
    parentExecutionId: PARENT,
    delegationId: DLG_A,
    childExecutionId: CHILD_A,
    childAttemptId: ATT_A,
  }
  running.recordEstimate(identity, {
    currency: 'USD',
    maximumMicrounits: 250_000,
    source: 'plan-compiler:v1',
  })
  running.recordReservation(identity, {
    schemaVersion: 1,
    workspaceId: WSP,
    executionId: CHILD_A,
    attemptId: ATT_A,
    executionPlanId: PLN,
    executionPlanDigest: `sha256:${'a'.repeat(64)}`,
    reservationKey: `runtime-attempt:${ATT_A}`,
    currency: 'USD',
    maximumMicrounits: 100_000,
    maximumTokens: 5_000,
  })
  running.recordReportedUsage(
    identity,
    {
      inputTokens: 120,
      outputTokens: 340,
      durationMs: 1_500,
      accounting: {
        schemaVersion: 1,
        sourceId: 'usage-source:managed-pi',
        fundingSource: 'hq_managed',
        currency: 'USD',
        chargedMicrounits: 42_000,
        costExact: true,
      },
    },
    { reportId: 'r:1' }
  )
  running.reconcile(identity, { reconciledAt: '2026-08-25T18:06:10.000Z' })
  running.settle(identity, {
    currency: 'USD',
    settledMicrounits: 42_000,
    settledAt: '2026-08-25T18:06:11.000Z',
    settlementRef: 'settle:1',
  })
  const before = running.status(identity)

  let provider = new SqlitePersistenceProvider({ path: databasePath })
  await provider.migrate()
  const snapshotId = recordId(`${DLG_A}:usage-outcome`)
  await provider.transaction(async (transaction) => {
    await transaction.put({
      namespace: USAGE_NAMESPACE,
      id: snapshotId,
      value: json(running.snapshot()),
    })
  })
  // Real restart: close the store, reopen it, rebuild every projection.
  provider.close()
  provider = new SqlitePersistenceProvider({ path: databasePath })
  await provider.migrate()

  const { feed } = createFeed(provider)
  const replayed = await feed.replay()
  expect(replayed).toEqual({ foldedEventCount: 4, duplicateEventCount: 0, rejectedEventCount: 0 })
  const rebuilt = feed.takeDeliveries()
  expect(rebuilt.length).toBeGreaterThan(0)
  // Replaying over the rebuilt projection is idempotent.
  const again = await feed.replay()
  expect(again.duplicateEventCount).toBe(4)
  expect(feed.takeDeliveries()).toEqual([])

  // The resolver's live caller: packet references resolve lazily against the
  // CURRENT durable publications at read time — never a capture-time snapshot.
  const liveAuthority = (outlet) => ({
    async authorize(reference) {
      if (reference.kind !== 'terminal_result') return { status: 'unavailable', reason: 'missing' }
      const events = await outlet.list()
      const recognitions = events.filter(
        (candidate) => candidate.details['terminalResultRef'] === reference.artifactId
      )
      if (recognitions.length === 0) return { status: 'unavailable', reason: 'missing' }
      const revoked = recognitions.some((candidate) =>
        events.some(
          (later) =>
            later.delegationId === candidate.delegationId &&
            later.type === 'delegation.cancelled' &&
            Date.parse(later.occurredAt) >= Date.parse(candidate.occurredAt)
        )
      )
      return revoked ? { status: 'forbidden', reason: 'revoked' } : { status: 'authorized' }
    },
  })
  const evidencePacket = rebuilt.find((delivery) => delivery.kind === 'evidence').packet
  expect(await resolveEvidenceReferences(evidencePacket, liveAuthority(feed))).toContainEqual({
    kind: 'terminal_result',
    artifactId: ART_A,
    status: 'authorized',
  })
  // Same packet, empty durable state: the read-time verdict flips — proof the
  // authority answers from current state, not from what the packet captured.
  const emptyOutlet = { list: async () => [] }
  expect(
    await resolveEvidenceReferences(evidencePacket, liveAuthority(emptyOutlet))
  ).toContainEqual({
    kind: 'terminal_result',
    artifactId: ART_A,
    status: 'unavailable',
    reason: 'missing',
  })
  // A later durable cancellation revokes the same reference at read time.
  await feed.publish(
    {
      type: 'delegation.cancelled',
      delegationId: DLG_A,
      parentExecutionId: PARENT,
      childExecutionId: CHILD_A,
      occurredAt: '2026-08-25T18:07:00.000Z',
      details: { reason: 'parent_cancelled' },
    },
    `delegation:${DLG_A}:cancelled:1`
  )
  expect(await resolveEvidenceReferences(evidencePacket, liveAuthority(feed))).toContainEqual({
    kind: 'terminal_result',
    artifactId: ART_A,
    status: 'forbidden',
    reason: 'revoked',
  })

  // Cost states restore from the durable bytes with their dedup horizons.
  const restored = await provider.transaction(async (transaction) => {
    const record = await transaction.get(USAGE_NAMESPACE, snapshotId)
    expect(record).toBeDefined()
    return record.value
  })
  const restarted = new ChildUsageLedger()
  restarted.restore(restored)
  expect(restarted.status(identity)).toStrictEqual(before)
  expect(restarted.status(identity).costState).toBe('settled')
  // The report dedup horizon survived: a redelivered report answers duplicate.
  const redelivery = restarted.recordReportedUsage(
    identity,
    {
      inputTokens: 120,
      outputTokens: 340,
      durationMs: 1_500,
      accounting: {
        schemaVersion: 1,
        sourceId: 'usage-source:managed-pi',
        fundingSource: 'hq_managed',
        currency: 'USD',
        chargedMicrounits: 42_000,
        costExact: true,
      },
    },
    { reportId: 'r:1' }
  )
  expect(redelivery.outcome).toBe('duplicate_report')
  provider.close()
})
