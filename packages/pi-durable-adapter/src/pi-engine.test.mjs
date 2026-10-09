import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createModels } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createPiDurableEngine } from './pi-engine.ts'

const fixture = fileURLToPath(new URL('./pi-engine.fixture.mjs', import.meta.url))
const node =
  process.env.CONTROL_PLANE_TEST_NODE ?? (process.versions.bun ? 'node' : process.execPath)

function worker(directory, mode) {
  const child = spawn(node, ['--experimental-strip-types', fixture, directory, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const complete = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  const boundary = new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      if (stdout.includes('inference_started')) resolve()
    })
    child.on('error', reject)
    child.on('close', () => {
      if (!stdout.includes('inference_started'))
        reject(new Error(stderr || stdout || 'Worker ended before boundary'))
    })
  })
  // The resume worker does not emit the interrupted boundary.
  boundary.catch(() => {})
  return { child, complete, boundary }
}

describe('persistent Pi engine', () => {
  test('contract fault: strict JSON model callback accepts catalog and inference DTOs without registry escape', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-json-boundary-'))
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('JSON boundary answer')])
    const callbackResults = []
    function assertPlainJson(value) {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return
      if (typeof value === 'number' && Number.isFinite(value)) return
      if (Array.isArray(value)) {
        for (const item of value) assertPlainJson(item)
        return
      }
      if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        for (const item of Object.values(value)) assertPlainJson(item)
        return
      }
      throw new Error('MODEL_CALLBACK_NOT_PLAIN_JSON')
    }
    expect(() => assertPlainJson(undefined)).toThrow('MODEL_CALLBACK_NOT_PLAIN_JSON')
    expect(() => assertPlainJson({ leaked: () => {} })).toThrow('MODEL_CALLBACK_NOT_PLAIN_JSON')
    expect(() => assertPlainJson(new Map())).toThrow('MODEL_CALLBACK_NOT_PLAIN_JSON')
    const engine = createPiDurableEngine({
      directory,
      model: { provider: 'faux', modelId: 'faux-1' },
      maxOutputTokens: 32,
      assertAuthority: async () => {},
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(faux.provider)
        const result = await use(models)
        assertPlainJson(result)
        const serialized = JSON.parse(JSON.stringify(result))
        callbackResults.push(serialized)
        models.clearProviders()
        return serialized
      },
    })
    try {
      const result = await engine.run({
        sessionId: 'session',
        requestId: 'turn:1',
        input: 'Question',
      })
      expect(result.text).toBe('JSON boundary answer')
      expect(faux.state.callCount).toBe(1)
      expect(callbackResults).toHaveLength(2)
      expect(callbackResults[0]).toMatchObject({ provider: 'faux', id: 'faux-1', baseUrl: '' })
      expect(callbackResults[1]).toEqual({ completed: true })
      expect(
        callbackResults.every(
          (value) => !Object.hasOwn(value, 'getModel') && !Object.hasOwn(value, 'streamSimple')
        )
      ).toBe(true)
    } finally {
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('SIGKILL at inference boundary reopens the real store and deduplicates admitted input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-restart-'))
    let interrupted
    let resumed
    try {
      interrupted = worker(directory, 'interrupt')
      await interrupted.boundary
      const signalSent = interrupted.child.kill('SIGKILL')
      const killed = await interrupted.complete
      const exitEvidence = JSON.stringify(killed)
      expect(signalSent, exitEvidence).toBe(true)
      expect(killed.signal, exitEvidence).toBe('SIGKILL')
      resumed = worker(directory, 'resume')
      const recovered = await resumed.complete
      expect(recovered.code, recovered.stderr).toBe(0)
      const payload = JSON.parse(recovered.stdout.trim())
      const boundary = JSON.parse(killed.stdout.trim())
      expect(payload.result.text).toBe('Recovered answer')
      expect(payload.result.submissionId).toBe(payload.duplicate.submissionId)
      expect(payload.calls).toBe(1)
      expect(payload.resolutions).toBe(2)
      expect(payload.reservations).toEqual([boundary.inferenceId])
      expect(payload.result.inferences[0].inferenceId).toBe(boundary.inferenceId)
      expect(payload.duplicate.inferences).toEqual(payload.result.inferences)
    } finally {
      const ownedWorkers = [interrupted, resumed].filter(Boolean)
      for (const owned of ownedWorkers) {
        if (owned.child.exitCode === null && owned.child.signalCode === null)
          owned.child.kill('SIGKILL')
      }
      await Promise.allSettled(ownedWorkers.map((owned) => owned.complete))
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  test('replays a completed request without inference and rejects changed input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-'))
    let resolutions = 0
    let checks = 0
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('Stored answer')])
    const options = {
      directory,
      model: { provider: 'faux', modelId: 'faux-1' },
      maxOutputTokens: 32,
      assertAuthority: async () => {
        checks++
      },
      withModels: async (use) => {
        resolutions++
        const models = createModels()
        models.setProvider(faux.provider)
        return use(models)
      },
    }
    try {
      let engine = createPiDurableEngine(options)
      const first = await engine.run({
        sessionId: 'session',
        requestId: 'turn:1',
        input: 'Question',
      })
      expect(first.text).toBe('Stored answer')
      expect(first.usage.outputTokens).toBeGreaterThan(0)
      expect(resolutions).toBe(2)
      expect(checks).toBeGreaterThanOrEqual(2)
      await engine.close()
      engine = createPiDurableEngine(options)
      const replay = await engine.run({
        sessionId: 'session',
        requestId: 'turn:1',
        input: 'Question',
      })
      expect(replay.submissionId).toBe(first.submissionId)
      expect(replay.text).toBe('Stored answer')
      expect(faux.state.callCount).toBe(1)
      await expect(
        engine.run({ sessionId: 'session', requestId: 'turn:1', input: 'Changed' })
      ).rejects.toThrow('PI_REQUEST_ID_CONFLICT')
      await engine.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('revoked authority prevents inference and provider errors do not persist secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-'))
    const faux = fauxProvider()
    let checks = 0
    const engine = createPiDurableEngine({
      directory,
      model: { provider: 'faux', modelId: 'faux-1' },
      maxOutputTokens: 32,
      assertAuthority: async () => {
        if (++checks > 1) throw new Error('secret-sensitive-authority-detail')
      },
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(faux.provider)
        return use(models)
      },
    })
    try {
      await expect(
        engine.run({ sessionId: 'session', requestId: 'turn:1', input: 'Question' })
      ).rejects.toThrow()
      expect(faux.state.callCount).toBe(0)
      await engine.close()
      const bytes = await readFile(engine.storePath('session'))
      expect(bytes.toString()).not.toContain('secret-sensitive-authority-detail')
    } finally {
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('ledger reservation bounds inference and tool requests cannot execute effects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-effects-'))
    const faux = fauxProvider()
    let reservations = 0
    let offeredTools
    let suppliedMaxTokens
    faux.setResponses([
      async (context, options) => {
        offeredTools = context.messages
          .filter((message) => message.role === 'system')
          .flatMap((message) => message.tools ?? [])
        suppliedMaxTokens = options.maxTokens
        return fauxAssistantMessage(fauxToolCall('bash', { command: 'unauthorized effect' }), {
          stopReason: 'toolUse',
        })
      },
    ])
    const engine = createPiDurableEngine({
      directory,
      model: { provider: 'faux', modelId: 'faux-1' },
      maxOutputTokens: 32,
      assertAuthority: async () => {},
      authorizeInference: async ({ inferenceId }) => {
        expect(inferenceId).toMatch(/^pi-generation:\d+$/)
        reservations++
        return {
          maxOutputTokens: 7,
          maximumInputTokens: faux.getModel().contextWindow,
          assertActive: async () => {},
        }
      },
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(faux.provider)
        return use(models)
      },
    })
    try {
      await expect(
        engine.run({ sessionId: 'session', requestId: 'turn:1', input: 'Question' })
      ).rejects.toThrow('PI_SUBMISSION_UNANSWERED')
      expect(offeredTools).toEqual([])
      expect(suppliedMaxTokens).toBe(7)
      expect(reservations).toBe(1)
      expect(faux.state.callCount).toBe(1)
    } finally {
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('error content and metadata from the provider do not enter SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-error-'))
    const secret = 'fixture-credential-in-provider-error'
    const faux = fauxProvider()
    const provider = {
      ...faux.provider,
      streamSimple: () => {
        const events = createAssistantMessageEventStream()
        const error = {
          ...fauxAssistantMessage(secret, { stopReason: 'error', errorMessage: secret }),
          responseId: secret,
        }
        queueMicrotask(() => {
          events.push({ type: 'start', partial: error })
          events.push({ type: 'error', reason: 'error', error })
          events.end()
        })
        return events
      },
    }
    const engine = createPiDurableEngine({
      directory,
      model: { provider: 'faux', modelId: 'faux-1' },
      maxOutputTokens: 32,
      assertAuthority: async () => {},
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(provider)
        return use(models)
      },
    })
    try {
      await expect(
        engine.run({ sessionId: 'session', requestId: 'turn:1', input: 'Question' })
      ).rejects.toThrow()
      await engine.close()
      expect((await readFile(engine.storePath('session'))).toString()).not.toContain(secret)
    } finally {
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('cache writes cannot settle under a price contract without cache-write rates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-cache-'))
    const faux = fauxProvider()
    const provider = {
      ...faux.provider,
      streamSimple: (_model, _context, options) => {
        expect(options.cacheRetention).toBe('none')
        const message = fauxAssistantMessage('cache write')
        message.usage = { ...message.usage, cacheWrite: 1 }
        const events = createAssistantMessageEventStream()
        queueMicrotask(() => {
          events.push({ type: 'start', partial: { ...message, content: [] } })
          events.push({ type: 'done', reason: 'stop', message })
          events.end()
        })
        return events
      },
    }
    const engine = createPiDurableEngine({
      directory,
      model: { provider: 'faux', modelId: 'faux-1' },
      maxOutputTokens: 32,
      assertAuthority: async () => {},
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(provider)
        return use(models)
      },
    })
    try {
      await expect(
        engine.run({ sessionId: 'session', requestId: 'turn:1', input: 'Question' })
      ).rejects.toThrow('PI_SUBMISSION_UNANSWERED')
    } finally {
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('native cached input is normalized into total input for pinned-price settlement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-cache-counts-'))
    const faux = fauxProvider()
    const provider = {
      ...faux.provider,
      streamSimple: () => {
        const message = fauxAssistantMessage('cached reply')
        message.usage = {
          ...message.usage,
          input: 6,
          output: 3,
          cacheRead: 4,
          reasoning: 1,
          totalTokens: 13,
        }
        const events = createAssistantMessageEventStream()
        queueMicrotask(() => {
          events.push({ type: 'start', partial: { ...message, content: [] } })
          events.push({ type: 'done', reason: 'stop', message })
          events.end()
        })
        return events
      },
    }
    const engine = createPiDurableEngine({
      directory,
      model: { provider: 'faux', modelId: 'faux-1' },
      maxOutputTokens: 32,
      assertAuthority: async () => {},
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(provider)
        return use(models)
      },
    })
    try {
      const result = await engine.run({
        sessionId: 'session',
        requestId: 'turn:1',
        input: 'Question',
      })
      expect(result.usage.inputTokens).toBe(10)
      expect(result.inferences[0].usage.cachedInputTokens).toBe(4)
      expect(result.inferences[0].usage.reasoningTokens).toBe(1)
      expect(result.inferences[0].usage.outputTokens).toBe(3)
    } finally {
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an input hold smaller than the native model context prevents dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-input-bound-'))
    const faux = fauxProvider()
    const engine = createPiDurableEngine({
      directory,
      model: { provider: 'faux', modelId: 'faux-1' },
      maxOutputTokens: 32,
      assertAuthority: async () => {},
      authorizeInference: async () => ({
        maxOutputTokens: 32,
        maximumInputTokens: 1,
        assertActive: async () => {},
      }),
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(faux.provider)
        return use(models)
      },
    })
    try {
      await expect(
        engine.run({ sessionId: 'session', requestId: 'turn:1', input: 'Question' })
      ).rejects.toThrow('PI_SUBMISSION_UNANSWERED')
      expect(faux.state.callCount).toBe(0)
    } finally {
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('recorded spending revocation at the final send boundary prevents provider dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-spend-revoked-'))
    const faux = fauxProvider()
    let finalChecks = 0
    const engine = createPiDurableEngine({
      directory,
      model: { provider: 'faux', modelId: 'faux-1' },
      maxOutputTokens: 32,
      assertAuthority: async () => {},
      authorizeInference: async () => ({
        maxOutputTokens: 32,
        maximumInputTokens: faux.getModel().contextWindow,
        assertActive: async () => {
          finalChecks++
          throw new Error('SPENDING_REVOKED')
        },
      }),
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(faux.provider)
        return use(models)
      },
    })
    try {
      await expect(
        engine.run({ sessionId: 'session', requestId: 'turn:1', input: 'Question' })
      ).rejects.toThrow('PI_SUBMISSION_UNANSWERED')
      expect(finalChecks).toBe(1)
      expect(faux.state.callCount).toBe(0)
    } finally {
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('the physical fetch boundary rechecks delayed SDK authority and blocks hidden retries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-engine-physical-fetch-'))
    const originalFetch = globalThis.fetch
    const sent = []
    globalThis.fetch = async (_input, init) => {
      sent.push(init)
      return new Response('{}')
    }
    let active = true
    let sendChecks = 0
    const faux = fauxProvider()
    const provider = {
      ...faux.provider,
      streamSimple: (_model, _transcript, options) => {
        const events = createAssistantMessageEventStream()
        queueMicrotask(async () => {
          try {
            await options.fetch('https://example.invalid/inference', { redirect: 'follow' })
            await options.fetch('https://example.invalid/inference')
            events.push({
              type: 'done',
              reason: 'stop',
              message: fauxAssistantMessage('Unreachable'),
            })
          } catch (error) {
            events.push({
              type: 'error',
              reason: 'error',
              error: {
                ...fauxAssistantMessage(''),
                stopReason: 'error',
                errorMessage: error.message,
              },
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
        assertActive: async () => {
          sendChecks++
          if (!active) throw new Error('REVOKED')
        },
      }),
      withModels: async (use) => {
        const models = createModels()
        models.setProvider(provider)
        return use(models)
      },
    })
    try {
      await expect(
        engine.run({ sessionId: 'one', requestId: 'turn:1', input: 'Question' })
      ).rejects.toThrow('PI_SUBMISSION_UNANSWERED')
      expect(sent).toHaveLength(1)
      expect(sent[0].redirect).toBe('error')
      expect(sendChecks).toBe(2)
      // Simulate credential resolution revocation after streamSimple's preflight.
      const delayed = {
        ...provider,
        streamSimple: (...args) => {
          active = false
          return provider.streamSimple(...args)
        },
      }
      const denied = createPiDurableEngine({
        directory,
        model: { provider: 'faux', modelId: 'faux-1' },
        maxOutputTokens: 32,
        assertAuthority: async () => {},
        authorizeInference: async () => ({
          maxOutputTokens: 32,
          maximumInputTokens: faux.getModel().contextWindow,
          assertActive: async () => {
            if (!active) throw new Error('REVOKED')
          },
        }),
        withModels: async (use) => {
          const models = createModels()
          models.setProvider(delayed)
          return use(models)
        },
      })
      try {
        await expect(
          denied.run({ sessionId: 'two', requestId: 'turn:1', input: 'Question' })
        ).rejects.toThrow('PI_SUBMISSION_UNANSWERED')
        expect(sent).toHaveLength(1)
      } finally {
        await denied.close()
      }
    } finally {
      globalThis.fetch = originalFetch
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
