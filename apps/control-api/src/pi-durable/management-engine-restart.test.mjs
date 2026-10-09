// Synthetic but real-engine proof (#932/CP1043): the actual Pi durable engine,
// the actual management_call tool, the certified governed caller and a
// file-backed retained record across an ENGINE restart after an unknown effect.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createPiDurableEngine } from '@control-plane/pi-durable-adapter'
import {
  createPiDurableGovernedManagementCall,
  SqlitePiDurableManagementCallStore,
} from './management-governed-call.ts'
import { managementCanonicalRequestDigest } from './management-decision-issuer.ts'
import { DatabaseSync } from 'node:sqlite'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const run = {
  sessionId: 'engine-restart:session',
  requestId: 'engine-restart:turn',
  input: 'Apply the management change.',
}
const PRINCIPAL = 'user:0f3a2e1c-0000-4000-8000-0000000000bb'

test('engine restart after an unknown effect retains one decision and never resends', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-management-engine-'))
  const counts = { calls: 0, issued: 0 }
  const boundaries = []
  let observedSourceKey = ''
  let portExecutions = 0
  let retainedDecision = ''
  let providerRequests = 0
  const seenTools = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json()
      providerRequests += 1
      seenTools.push((body.tools ?? []).map((tool) => tool.function?.name))
      const first = providerRequests === 1
      const delta = first
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_management_1',
                type: 'function',
                function: {
                  name: 'management_call',
                  arguments: JSON.stringify({
                    operation: 'project.update',
                    input: { name: 'Renamed' },
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'Management receipt received.' }
      const chunks = [
        {
          id: 'chat_fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'loopback-model',
          choices: [{ index: 0, delta, finish_reason: null }],
        },
        {
          id: 'chat_fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'loopback-model',
          choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
      ]
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })
  const baseUrl = `${server.url}v1`
  const databasePath = join(directory, 'management.sqlite')
  const requestFor = (input) => ({
    approval: {
      allowedPrincipalIds: [PRINCIPAL],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      interactionId: id('int'),
      requestedAt: new Date(Date.now() - 1_000).toISOString(),
    },
    attemptId: input.source.parentAttemptId,
    audit: { principalRef: PRINCIPAL, traceId: id('trc') },
    executionId: input.source.parentExecutionId,
    grant: {
      operations: [input.operation],
      profileId: id('prf'),
      toolDefinitionId: id('tld'),
      toolVersionId: id('tlv'),
      workspaceId: input.source.workspaceId,
    },
    idempotencyKey: `pi-management:${input.sourceKey}`,
    input: input.input,
    operation: input.operation,
    policySnapshotRef: 'policy://engine-restart',
    profileId: id('prf'),
    requestId: id('req'),
    requestedAt: new Date().toISOString(),
    toolCallId: id('tlc'),
    toolDefinitionId: id('tld'),
    toolVersionId: id('tlv'),
    workspaceId: input.source.workspaceId,
  })
  const options = {
    directory,
    model: { provider: 'loopback', modelId: 'loopback-model' },
    maxOutputTokens: 32,
    assertAuthority: async () => {},
    authorizeInference: async () => ({
      maxOutputTokens: 32,
      maximumInputTokens: 1024,
      assertActive: async () => {},
    }),
    withModels: async (use) => {
      const models = createModels()
      models.setProvider(
        createProvider({
          id: 'loopback',
          baseUrl,
          auth: {
            apiKey: {
              name: 'Loopback synthetic fixture only',
              resolve: async () => ({ auth: { apiKey: 'fixture-no-paid-account' } }),
            },
          },
          models: [
            {
              id: 'loopback-model',
              provider: 'loopback',
              name: 'Loopback fixture',
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
      return use(models)
    },
    governedManagementCall: {
      source: {
        workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
        parentExecutionId: id('exe'),
        parentAttemptId: id('att'),
        runtimeHandleId: 'pi-durable:engine-restart',
        externalSessionId: run.sessionId,
        admittedTurnKey: run.requestId,
      },
      assertCurrent: async () => {},
      execute: async (input, _reader, signal) => {
        signal?.throwIfAborted()
        portExecutions += 1
        observedSourceKey = input.sourceKey
        const database = new DatabaseSync(databasePath)
        const caller = createPiDurableGovernedManagementCall({
          authority: {
            async assertCurrent(_request, boundary) {
              boundaries.push(boundary)
            },
          },
          store: new SqlitePiDurableManagementCallStore(database),
          issue: async ({ request }) => {
            counts.issued += 1
            return {
              canonicalRequestDigest: managementCanonicalRequestDigest(request),
              decision: `decision-jwt-${counts.issued}`,
              decisionId: `decision-${counts.issued}`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }
          },
          callAdea: async () => {
            counts.calls += 1
            throw new Error('TEST_TRANSPORT_UNKNOWN')
          },
          resolveTargetId: () => id('prj'),
        })
        try {
          return await caller.execute(requestFor(input))
        } finally {
          database.close()
        }
      },
    },
  }
  const engines = []
  const open = () => {
    const engine = createPiDurableEngine(options)
    engines.push(engine)
    return engine
  }
  try {
    const first = open()
    let firstError
    try {
      await first.run(run)
    } catch (error) {
      firstError = error
    }
    expect(String(firstError?.message)).toContain('PI_MANAGEMENT_RECONCILIATION_REQUIRED')
    expect(counts).toEqual({ calls: 1, issued: 1 })
    await first.close()

    const identityKey = JSON.stringify([
      options.governedManagementCall.source.workspaceId,
      `pi-management:${observedSourceKey}`,
    ])
    const firstDatabase = new DatabaseSync(databasePath)
    const firstStore = new SqlitePiDurableManagementCallStore(firstDatabase)
    const retainedAfterFirst = await firstStore.get(identityKey)
    firstDatabase.close()
    expect(retainedAfterFirst?.state).toBe('settled')
    expect(retainedAfterFirst?.decision).toBe('decision-jwt-1')
    expect(retainedAfterFirst?.outcome?.state).toBe('reconciliation_required')
    retainedDecision = retainedAfterFirst.decision

    const second = open()
    let secondError
    let secondResult
    try {
      secondResult = await second.run(run)
    } catch (error) {
      secondError = error
    }
    if (secondError !== undefined)
      expect(String(secondError?.message)).toContain('PI_MANAGEMENT_RECONCILIATION_REQUIRED')
    else expect(secondResult).toBeDefined()
    // The restarted engine resumed and re-invoked the same canonical task, but
    // the retained identity re-used the exact decision and made no new call.
    expect(portExecutions).toBe(2)
    expect(counts).toEqual({ calls: 1, issued: 1 })
    expect(boundaries.slice(0, 3)).toEqual(['admission', 'approval', 'effect'])
    // The restart re-validates current authority but never re-runs the effect
    // boundary or the transport for the retained identity.
    expect(boundaries.slice(3)).toEqual(['admission', 'approval'])
    const reopenedDatabase = new DatabaseSync(databasePath)
    const reopenedStore = new SqlitePiDurableManagementCallStore(reopenedDatabase)
    const retainedAfterRestart = await reopenedStore.get(identityKey)
    reopenedDatabase.close()
    expect(retainedAfterRestart?.decision).toBe(retainedDecision)
    expect(retainedAfterRestart?.decisionId).toBe('decision-1')
    await second.close()
  } finally {
    for (const engine of engines) await engine.close()
    await server.stop(true)
    rmSync(directory, { force: true, recursive: true })
  }
})
