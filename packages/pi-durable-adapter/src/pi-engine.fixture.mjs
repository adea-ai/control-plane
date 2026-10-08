// Scripted Models boundary only; this is a real Pi Harness / Node SQLite process.
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
await import('./pi-engine-source-loader.fixture.mjs')
const { createPiDurableEngine } = await import('./pi-engine.ts')

const [directory, mode] = process.argv.slice(2)
const faux = fauxProvider()
let resolutions = 0
const reservations = []
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
const result = await engine.run(request)
const duplicate = await engine.run(request)
await engine.close()
process.stdout.write(
  `${JSON.stringify({ result, duplicate, resolutions, reservations, calls: faux.state.callCount })}\n`
)
