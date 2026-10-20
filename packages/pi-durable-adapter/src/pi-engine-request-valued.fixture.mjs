import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
await import('./pi-engine-source-loader.fixture.mjs')
const { createPiDurableEngine } = await import('./pi-engine.ts')

const directory = await mkdtemp(join(tmpdir(), 'pi-node-request-fetch-'))
const originalFetch = globalThis.fetch
const sent = []
globalThis.fetch = async (input) => {
  sent.push({
    method: input.method,
    body: await input.text(),
    header: input.headers.get('x-pi-test'),
    redirect: input.redirect,
  })
  return new Response('{}')
}
const faux = fauxProvider()
const provider = {
  ...faux.provider,
  streamSimple: (_model, _transcript, options) => {
    const events = createAssistantMessageEventStream()
    queueMicrotask(async () => {
      try {
        await options.fetch(
          new Request('https://example.invalid/inference', {
            method: 'POST',
            headers: { 'x-pi-test': 'retained' },
            body: 'exact request body',
            redirect: 'follow',
          })
        )
        events.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('Done') })
      } catch (error) {
        events.push({
          type: 'error',
          reason: 'error',
          error: { ...fauxAssistantMessage(''), stopReason: 'error', errorMessage: error.message },
        })
      } finally {
        events.end()
      }
    })
    return events
  },
}
const engine = createPiDurableEngine({
  directory,
  model: { provider: 'faux', modelId: 'faux-1' },
  maxOutputTokens: 32,
  assertAuthority: async () => {},
  authorizeInference: async () => ({
    maxOutputTokens: 32,
    maximumInputTokens: faux.getModel().contextWindow,
    assertActive: async () => {},
    preparePhysicalSend: async () => {},
    armPhysicalSend: async () => {},
  }),
  withModels: async (use) => {
    const models = createModels()
    models.setProvider(provider)
    return use(models)
  },
})
try {
  await engine.run({ sessionId: 'node-request', requestId: 'turn:1', input: 'Question' })
  process.stdout.write(`${JSON.stringify(sent)}\n`)
} finally {
  globalThis.fetch = originalFetch
  await engine.close()
  await rm(directory, { recursive: true, force: true })
}
