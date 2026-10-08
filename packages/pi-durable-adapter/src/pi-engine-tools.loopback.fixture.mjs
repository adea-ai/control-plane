// Test-only actual Pi/SQLite loopback transport; provider and governed effects are scripted.
import { expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createPiDurableEngine } from './pi-engine.ts'
import { verifyPiDurableToolSource } from './tool-source.ts'
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const run = {
  sessionId: 'fixture:session',
  requestId: 'fixture:turn',
  input: 'Delegate the bounded objective.',
}
const source = {
  workspaceId: id('wsp'),
  parentExecutionId: id('exe'),
  parentAttemptId: id('att'),
  runtimeHandleId: 'pi-durable:fixture',
  externalSessionId: run.sessionId,
  admittedTurnKey: run.requestId,
}
const succeeded = {
  schemaVersion: 'pi-delegate-child-outcome/v1',
  state: 'succeeded',
  toolCallId: id('tlc'),
  delegationId: id('dlg'),
  childExecutionId: id('exe'),
  childAttemptId: id('att'),
}
export async function createNativeEngineToolFixture({
  callName = 'delegate_child',
  argumentsInput = { objective: 'Inspect the child scope' },
  execute,
  enabled = true,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-native-tool-'))
  const requests = [],
    sources = [],
    receipts = []
  let effects = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      const tool = requests.length === 1
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_delegate_1',
                type: 'function',
                function: { name: callName, arguments: JSON.stringify(argumentsInput) },
              },
            ],
          }
        : { role: 'assistant', content: 'Child delegation receipt received.' }
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
          choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
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
  const options = {
    directory,
    model: { provider: 'loopback', modelId: 'loopback-model' },
    maxOutputTokens: 32,
    assertAuthority: async () => {},
    authorizeInference: async (input) => {
      receipts.push(input.inferenceId)
      return { maxOutputTokens: 32, maximumInputTokens: 1024, assertActive: async () => {} }
    },
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
    ...(enabled
      ? {
          governedDelegateChild: {
            source,
            assertCurrent: async (retained) => {
              expect(retained).toMatchObject(source)
            },
            execute: async (input, reader, signal) => {
              expect(Object.keys(reader).toSorted()).toEqual(['readAssistantEntry', 'readTask'])
              expect(signal).toBeInstanceOf(AbortSignal)
              signal.throwIfAborted()
              const verified = await verifyPiDurableToolSource(
                input.source,
                { objective: input.objective },
                {
                  ...reader,
                  assertCurrent: async (retained) => {
                    expect(retained).toMatchObject(source)
                  },
                }
              )
              expect(verified).toEqual(input)
              const task = await reader.readTask(input.source)
              const entry = await reader.readAssistantEntry(input.source)
              expect(typeof task.id).toBe('number')
              expect(typeof entry.id).toBe('number')
              sources.push(structuredClone(input))
              if (execute)
                return execute(input, () => {
                  effects++
                })
              effects++
              return succeeded
            },
          },
        }
      : {}),
  }
  const engines = []
  return {
    options,
    requests,
    sources,
    receipts,
    baseUrl,
    effects: () => effects,
    open() {
      const engine = createPiDurableEngine(options)
      engines.push(engine)
      return engine
    },
    async close() {
      for (const engine of engines) await engine.close()
      await server.stop(true)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
