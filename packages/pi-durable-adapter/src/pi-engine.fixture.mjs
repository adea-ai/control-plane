// Scripted Models boundary only; this is a real Pi Harness / Node SQLite process.
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
await import('./pi-engine-source-loader.fixture.mjs')
const { createPiDurableEngine } = await import('./pi-engine.ts')

const [directory, mode] = process.argv.slice(2)
const faux = fauxProvider()
let resolutions = 0
const reservations = []
let heartbeat
const engine = createPiDurableEngine({
  directory,
  model: { provider: 'faux', modelId: 'faux-1' },
  maxOutputTokens: 24,
  // Only the scripted request is declared safe to replay by this test's host authority.
  assertAuthority: async () => {},
  authorizeInference: async ({ inferenceId }) => {
    reservations.push(inferenceId)
    return {
      maxOutputTokens: 24,
      maximumInputTokens: faux.getModel().contextWindow,
      assertActive: async () => {},
    }
  },
  withModels: async (use) => {
    resolutions++
    const models = createModels()
    models.setProvider(faux.provider)
    return use(models)
  },
})
faux.setResponses([
  async (_context, options) => {
    if (options.maxTokens !== 24) throw new Error('output budget changed')
    if (mode === 'interrupt') {
      // A pending Promise alone does not keep Node alive until the parent signals it.
      heartbeat ??= setInterval(() => {}, 1000)
      process.stdout.write(
        `${JSON.stringify({ boundary: 'inference_started', inferenceId: reservations.at(-1) })}\n`
      )
      await new Promise(() => {})
    }
    return fauxAssistantMessage('Recovered answer')
  },
])

const request = {
  sessionId: 'restart-session',
  requestId: 'stable-turn',
  input: 'Restart question',
}
let result, duplicate
try {
  result = await engine.run(request)
  duplicate = await engine.run(request)
} finally {
  clearInterval(heartbeat)
  await engine.close()
}
process.stdout.write(
  `${JSON.stringify({ result, duplicate, resolutions, reservations, calls: faux.state.callCount })}\n`
)
