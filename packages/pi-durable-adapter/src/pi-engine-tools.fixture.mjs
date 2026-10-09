// Actual Pi SQLite process with a parent-owned loopback provider and scripted governed port.
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
await import('./pi-engine-source-loader.fixture.mjs')
const { createPiDurableEngine, PiDurableEngineToolBlockedError } = await import('./pi-engine.ts')

const [directory, baseUrl, mode] = process.argv.slice(2)
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const request = {
  sessionId: 'fixture:session',
  requestId: 'fixture:turn',
  input: 'Delegate the bounded objective.',
}
const sources = [],
  reservations = []
let pendingTask
const engine = createPiDurableEngine({
  directory,
  model: { provider: 'loopback', modelId: 'loopback-model' },
  maxOutputTokens: 32,
  assertAuthority: async () => {},
  authorizeInference: async (inference) => {
    reservations.push(inference.inferenceId)
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
            name: 'Loopback synthetic only',
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
  governedDelegateChild: {
    source: {
      workspaceId: id('wsp'),
      parentExecutionId: id('exe'),
      parentAttemptId: id('att'),
      runtimeHandleId: 'pi-durable:fixture',
      externalSessionId: request.sessionId,
      admittedTurnKey: request.requestId,
    },
    assertCurrent: async () => {},
    execute: async (input) => {
      sources.push(input)
      if (mode === 'pending')
        return {
          schemaVersion: 'pi-delegate-child-outcome/v1',
          state: 'awaiting_approval',
          toolCallId: id('tlc'),
          interactionId: id('int'),
          reasonCode: 'PI_CHILD_APPROVAL_PENDING',
        }
      await appendFile(join(directory, 'scripted-effect.log'), `${input.sourceKey}\n`)
      return {
        schemaVersion: 'pi-delegate-child-outcome/v1',
        state: 'succeeded',
        toolCallId: id('tlc'),
        delegationId: id('dlg'),
        childExecutionId: id('exe'),
        childAttemptId: id('att'),
      }
    },
  },
})
if (mode !== 'pending')
  pendingTask = (await engine.inspect(request.sessionId)).tasks.find(
    (task) => task.record.kind === 'pi.tool'
  )?.record
let result, blocked
try {
  result = await engine.run(request)
} catch (error) {
  if (!(error instanceof PiDurableEngineToolBlockedError)) throw error
  blocked = {
    outcome: error.outcome,
    source: error.source,
    sourceKey: error.sourceKey,
    inferences: error.inferences,
  }
}
await engine.close()
const effects = await readFile(join(directory, 'scripted-effect.log'), 'utf8').catch(() => '')
process.stdout.write(
  `${JSON.stringify({ result, blocked, sources, pendingTask, reservations, effects })}\n`
)
