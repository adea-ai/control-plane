import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  ManagedPiAdapter,
  ManagedPiDriver,
  ManagedPiProcessClient,
} from '@control-plane/managed-pi-adapter'
import { DirectLocalRuntimeTransport } from '@control-plane/runtime-sdk'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { writeManagedPiRpcFixture } from '../packages/managed-pi-adapter/src/test-support/managed-pi-rpc-fixture.mjs'
import { DirectRuntimeActivityPort } from '../apps/local-control-plane/src/direct-runtime-activities.ts'

const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const recordId = (value) => `r-${createHash('sha256').update(value).digest('hex')}`

test.each([
  ['normal', 'completed', true],
  ['error-with-stats', 'failed', true],
  ['cancel-with-stats', 'cancelled', true],
  ['cancel-stats-delayed', 'cancelled', true],
  ['cancel-stats-hang', 'cancelled', false],
  ['text-fails-with-stats', 'failed', true],
  ['exit-with-stats-pending-text', 'failed', true],
  ['stats-missing', 'failed', false],
  ['stats-malformed', 'failed', false],
  ['stats-unsafe', 'failed', false],
  ['stats-total-overflow', 'failed', false],
])(
  'native Pi %s preserves known or unknown usage through Local lost effect and cold replay',
  async (mode, outcome, hasMeasurements) => {
    const expectedTokens =
      mode === 'error-with-stats'
        ? { inputTokens: 17, outputTokens: 4 }
        : mode === 'cancel-with-stats' || mode === 'cancel-stats-delayed'
          ? { inputTokens: 23, outputTokens: 6 }
          : { inputTokens: 11, outputTokens: 3 }
    const directory = await mkdtemp(join(tmpdir(), 'm11-local-native-usage-'))
    const executablePath = join(directory, 'pi-fixture.mjs')
    const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
    const input = {
      executionId,
      attemptId,
      effectKey: 'native-usage:dispatch',
      executionPlan: createExecutionPlanTestFixture({
        profileCapabilityRequirements: ['stream.output'],
        skillRequiredCapabilities: [],
      }),
    }
    let runtime
    let handle
    let starts = 0
    let publishes = 0
    let loseEffect = true
    const receipt = () =>
      persistence.transaction((tx) =>
        tx.get('runtime-terminal-usage', recordId(`${executionId}:${attemptId}`))
      )
    const createRuntime = () => {
      const adapter = new ManagedPiAdapter({
        transport: new DirectLocalRuntimeTransport(
          new ManagedPiDriver({
            client: new ManagedPiProcessClient({
              executablePath,
              dataDirectory: join(directory, 'native'),
              environment: { PATH: process.env.PATH ?? '/usr/bin:/bin', MOCK_MODE: mode },
              rpcTimeoutMs: 1_000,
              inputResolver: {
                resolve: async () => ({
                  systemPrompt: 'Fixture authority',
                  prompt: 'Fixture data',
                  provider: 'fixture',
                  model: 'fixture',
                }),
              },
            }),
            adapterVersion: '1.2.0',
            minimumRuntimeVersion: '0.84.0',
            maximumRuntimeVersionExclusive: '0.85.0',
          })
        ),
      })
      const start = adapter.start.bind(adapter)
      adapter.start = async (request) => {
        starts++
        handle = await start(request)
        return handle
      }
      return adapter
    }
    const objectStore = {
      put: async () => {
        expect((await receipt()).value.usage.inputTokens).toBe(11)
        publishes++
      },
    }
    const interrupted = {
      transaction: (operation) =>
        persistence.transaction((tx) =>
          operation(
            new Proxy(tx, {
              get(target, property) {
                if (property === 'put')
                  return async (record) => {
                    if (
                      loseEffect &&
                      record.namespace === 'workflow-effects' &&
                      record.id === recordId(input.effectKey)
                    ) {
                      loseEffect = false
                      throw new Error('LOST_NATIVE_EFFECT_COMMIT')
                    }
                    return target.put(record)
                  }
                const value = Reflect.get(target, property)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          )
        ),
    }
    try {
      await writeManagedPiRpcFixture(executablePath)
      await persistence.migrate()
      runtime = createRuntime()
      let activities = new DirectRuntimeActivityPort(interrupted, objectStore, runtime)
      if (outcome === 'cancelled')
        await activities.cancel({
          ...input,
          effectKey: 'native-usage:cancel',
          reason: 'user_request',
        })
      await expect(activities.dispatch(input)).rejects.toThrow('LOST_NATIVE_EFFECT_COMMIT')
      const measured = (await receipt())?.value
      expect(measured === undefined).toBe(!hasMeasurements)
      if (hasMeasurements) {
        expect(measured).toMatchObject({
          executionId,
          attemptId,
          state: outcome,
          usage: expectedTokens,
        })
        expect(Number.isSafeInteger(measured.usage.durationMs)).toBe(true)
        expect(measured.usage).not.toHaveProperty('cost')
        expect(measured.usage).not.toHaveProperty('accounting')
      }
      await runtime.cleanup(handle)
      handle = undefined
      persistence.close({ checkpoint: true })
      await persistence.migrate()
      runtime = createRuntime()
      activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
      const recovered = await activities.dispatch(input)
      expect(recovered.outcome).toBe(outcome)
      if (hasMeasurements) expect(recovered.terminalUsage).toEqual(measured.usage)
      else expect(recovered).not.toHaveProperty('terminalUsage')
      expect(await activities.dispatch(input)).toEqual(recovered)
      expect((await receipt())?.value).toEqual(measured)
      expect(starts).toBe(1)
      expect(publishes).toBe(outcome === 'completed' ? 2 : 0)
      await activities.cleanup({ ...input, effectKey: 'native-usage:cleanup' })
    } finally {
      if (handle !== undefined) await runtime.cleanup(handle)
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
