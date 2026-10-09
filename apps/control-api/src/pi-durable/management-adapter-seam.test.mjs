// Adapter-seam integration proof (#932/CP1043): the REAL adapter-built
// management engine port, the REAL certified governed caller and a file-backed
// retained store. One canonical request/idempotency identity; the retained
// decision is reused with no resend and no fresh decision.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PiDurableRuntimeAdapter } from '../../../../packages/pi-durable-adapter/src/adapter.ts'
import { piDurableToolSourceKey } from '../../../../packages/pi-durable-adapter/src/tool-source.ts'
import { fixture } from '../../../../packages/pi-durable-adapter/src/adapter.fixture.mjs'
import {
  createPiDurableGovernedManagementCall,
  SqlitePiDurableManagementCallStore,
} from './management-governed-call.ts'
import { managementCanonicalRequestDigest } from './management-decision-issuer.ts'

const PRINCIPAL = 'principal:one'
// Deterministic prepare contract: every request field derived from retained
// canonical data, never a fresh wall clock, or the retained request digest
// changes across restart and the caller refuses with authority_binding_mismatch.
const AT = '2026-10-08T00:00:00.000Z'
const TARGET = 'prj_01JABCDEF0123456789ABCDEFG'
const CALL_ARGS = { operation: 'project.update', input: { name: 'Renamed' } }
const conversationId = 'conversation:one'
const taskId = 'task:one'
const assistantEntryId = 'entry:one'
const callId = 'call:one'

/**
 * Releases the owned run gate, then attempts the start/run settlement and the
 * adapter close independently. Both failures are preserved; the caller removes
 * resources afterwards and reports the result.
 */
async function settleAdapter({ adapter, releaseRun, startPromise }) {
  releaseRun?.()
  let failure
  try {
    await startPromise
  } catch (error) {
    failure = error
  }
  try {
    await adapter?.close()
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], 'management adapter seam cleanup failed')
  }
  return failure
}

test('cleanup attempts adapter close even when the start promise rejects and preserves both failures', async () => {
  const startError = new Error('start failed')
  const closeError = new Error('close failed')
  let released = false
  let closed = false
  const failure = await settleAdapter({
    adapter: {
      async close() {
        closed = true
        throw closeError
      },
    },
    releaseRun: () => {
      released = true
    },
    startPromise: Promise.reject(startError),
  })
  expect(released).toBe(true)
  expect(closed).toBe(true)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toEqual([startError, closeError])
})

test('the adapter management port reuses one retained decision without resend', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-management-adapter-'))
  const database = new DatabaseSync(join(directory, 'calls.sqlite'))
  const counts = { issued: 0, calls: 0 }
  const prepared = []
  const boundaries = []
  let captured
  let adapter
  let startPromise
  let releaseRun
  const runGate = new Promise((resolve) => {
    releaseRun = resolve
  })
  let failure
  try {
    const { options, request, admission } = fixture(directory, {
      resolveAdmission: async () => ({
        ...admission,
        canonicalActorPrincipalId: PRINCIPAL,
      }),
      engineFactory: async (engineOptions) => {
        captured = engineOptions
        return {
          cancel: async () => releaseRun(),
          close: async () => releaseRun(),
          run: () =>
            runGate.then(() => ({
              inferences: [],
              submissionId: 'submission',
              text: '',
              usage: { costUsd: '0', durationMs: 0, inputTokens: 0, outputTokens: 0 },
            })),
        }
      },
    })
    const caller = createPiDurableGovernedManagementCall({
      authority: {
        async assertCurrent(_request, boundary) {
          boundaries.push(boundary)
        },
      },
      store: new SqlitePiDurableManagementCallStore(database),
      issue: async ({ request: candidate }) => {
        counts.issued += 1
        return {
          canonicalRequestDigest: managementCanonicalRequestDigest(candidate),
          decision: `decision-jwt-${counts.issued}`,
          decisionId: `decision-${counts.issued}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
      },
      callAdea: async () => {
        counts.calls += 1
        throw new Error('TEST_TRANSPORT_UNKNOWN')
      },
      resolveTargetId: () => TARGET,
    })
    options.governedManagementCall = {
      async prepare(authority, verified) {
        prepared.push({ authority, verified: structuredClone(verified) })
        return {
          approval: {
            allowedPrincipalIds: [PRINCIPAL],
            expiresAt: '2026-10-08T00:02:00.000Z',
            interactionId: 'int_01JABCDEF0123456789ABCDEFG',
            requestedAt: AT,
          },
          attemptId: request.attemptId,
          audit: { principalRef: PRINCIPAL, traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
          executionId: request.executionId,
          grant: {
            operations: [verified.args.operation],
            profileId: request.executionPlan.profile.profileId,
            toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
            toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
            workspaceId: request.executionPlan.correlation.workspaceId,
          },
          idempotencyKey: `pi-management:${verified.sourceKey}`,
          input: verified.args.input,
          operation: verified.args.operation,
          policySnapshotRef: 'policy://adapter-seam',
          profileId: request.executionPlan.profile.profileId,
          requestId: 'req_01JABCDEF0123456789ABCDEFG',
          requestedAt: AT,
          toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
          toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
          toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
          workspaceId: request.executionPlan.correlation.workspaceId,
        }
      },
      execute: async (candidate) => caller.execute(candidate),
    }
    adapter = new PiDurableRuntimeAdapter(options)
    startPromise = adapter.start(request)
    // Keep the raw promise for cleanup; attach a handler now so an assertion
    // failure before cleanup cannot surface as an unhandled rejection.
    startPromise.catch(() => {})
    let record
    for (let attempt = 0; attempt < 300; attempt += 1) {
      record = adapter.journal.list().find((item) => item.state === 'running')
      if (record && captured?.governedManagementCall) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const port = captured?.governedManagementCall
    expect(port).toBeDefined()
    const stored = record.admission
    const source = {
      schemaVersion: 'pi-tool-source/v1',
      workspaceId: request.executionPlan.correlation.workspaceId,
      parentExecutionId: request.executionId,
      parentAttemptId: request.attemptId,
      runtimeHandleId: record.handleId,
      externalSessionId: stored.handle.externalSessionId,
      admittedTurnKey: record.detail.turn?.requestId ?? `pi-turn:${record.attemptId}:initial`,
      conversationId,
      taskId,
      assistantEntryId,
      callId,
    }
    const sourceKey = piDurableToolSourceKey(source)
    const reader = {
      readTask: async () => ({
        abortRequested: false,
        conversationId,
        id: taskId,
        input: { assistant: assistantEntryId, callId },
        kind: 'pi.tool',
        state: {
          checkpoint: { arguments: CALL_ARGS, phase: 'execute', replay: 'safe' },
          status: 'running',
        },
        version: 1,
      }),
      readAssistantEntry: async () => ({
        conversationId,
        id: assistantEntryId,
        kind: 'pi.assistant',
        model: [
          {
            content: [
              { arguments: CALL_ARGS, id: callId, name: 'management_call', type: 'toolCall' },
            ],
            role: 'assistant',
          },
        ],
      }),
    }
    const input = { input: CALL_ARGS.input, operation: CALL_ARGS.operation, source, sourceKey }
    const first = await port.execute(input, reader, new AbortController().signal)
    expect(first).toEqual({
      code: 'PI_MANAGEMENT_EFFECT_UNKNOWN',
      state: 'reconciliation_required',
    })
    expect(counts).toEqual({ issued: 1, calls: 1 })
    expect(prepared).toHaveLength(1)
    expect(boundaries).toEqual(['admission', 'approval', 'effect'])
    const second = await port.execute(input, reader, new AbortController().signal)
    expect(second).toEqual(first)
    expect(counts).toEqual({ issued: 1, calls: 1 })
    expect(prepared).toHaveLength(2)
    expect(prepared[0].verified.sourceKey).toBe(prepared[1].verified.sourceKey)
    const identityKey = JSON.stringify([
      request.executionPlan.correlation.workspaceId,
      `pi-management:${sourceKey}`,
    ])
    const readDatabase = new DatabaseSync(join(directory, 'calls.sqlite'))
    const retained = await new SqlitePiDurableManagementCallStore(readDatabase).get(identityKey)
    readDatabase.close()
    expect(retained?.decision).toBe('decision-jwt-1')
    expect(retained?.decisionId).toBe('decision-1')
    expect(retained?.state).toBe('settled')
  } catch (error) {
    failure = error
  }
  // Release the owned run gate, then attempt the start settlement and the
  // adapter close independently; both failures are preserved.
  const cleanupFailure = await settleAdapter({ adapter, releaseRun, startPromise })
  database.close()
  rmSync(directory, { force: true, recursive: true })
  const failures = [failure, cleanupFailure].filter(Boolean)
  if (failures.length > 1)
    throw new AggregateError(failures, 'management adapter seam failed and cleanup failed')
  if (failures.length === 1) throw failures[0]
})
