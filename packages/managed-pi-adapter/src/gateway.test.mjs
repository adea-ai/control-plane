import { describe, expect, test } from 'bun:test'
import { executionConstraintFixtures } from '@control-plane/domain'
import {
  RemoteRuntimeGatewayTransport,
  RuntimeCompatibilityMatrixSchema,
} from '@control-plane/runtime-sdk'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { ManagedPiAdapter, ManagedPiDriver } from './index.ts'
import {
  ManagedPiGatewayClient,
  ReferenceManagedPiDriver,
  ReferenceManagedPiGatewayTransport,
} from './gateway.ts'

const now = '2026-08-25T12:00:00.000Z'
const digest = (character) => `sha256:${character.repeat(64)}`
const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  runtimeOpaqueRef: 'nref_01JABCDEF0123456789ABCDEFG',
}
const matrixUrl = new URL(
  '../../../docs/runtime-compatibility/runtime-certifications.v1.json',
  import.meta.url
)

function plan() {
  return {
    schemaVersion: 1,
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: digest('a'),
    profile: {
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
      version: 3,
      revision: 2,
      schemaVersion: 1,
      contentDigest: digest('b'),
    },
    skills: [
      {
        skillId: 'skl_01JABCDEF0123456789ABCDEFG',
        skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
        revision: 4,
        schemaVersion: 1,
        semanticVersion: '2.1.0',
        contentDigest: digest('c'),
      },
    ],
    contextPackage: {
      contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG',
      contentDigest: digest('d'),
      schemaVersion: 1,
      compilerVersion: '1.0.0',
    },
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
      { capability: 'execution.cancel', necessity: 'required', minimumSupport: 'supported' },
    ],
    constraints: globalThis.structuredClone(executionConstraintFixtures.write),
    policySnapshot: globalThis.structuredClone(executionConstraintFixtures.write.policySnapshot),
    outputContract: { contractRef: 'contract://execution-result/v1' },
  }
}

function fixture(scenario = 'complete', transportOptions = {}) {
  const driver = new ReferenceManagedPiDriver({ now: () => now, scenario })
  driver.setGrantState('grant:project-0001', 'granted')
  const transport = new ReferenceManagedPiGatewayTransport({
    driver,
    now: () => now,
    nodeId: ids.nodeId,
    workspaceId: ids.workspaceId,
    runtimeConnectionId: ids.runtimeConnectionId,
    runtimeOpaqueRef: ids.runtimeOpaqueRef,
    ...transportOptions,
  })
  const commandIds = new Map()
  let commandIndex = 0
  const client = new ManagedPiGatewayClient({
    transport,
    ...ids,
    localProjectGrantRef: 'grant:project-0001',
    now: () => new Date(now),
    commandId: (identity) => {
      if (!commandIds.has(identity)) {
        const suffix = '01JABCDEF0123456789ABCDEFGHJKMNPQ'.slice(commandIndex, commandIndex + 26)
        commandIds.set(identity, `cmd_${suffix.padEnd(26, 'A')}`)
        commandIndex += 1
      }
      return commandIds.get(identity)
    },
  })
  return {
    driver,
    transport,
    client,
    adapter: new ManagedPiAdapter({
      transport: new RemoteRuntimeGatewayTransport(
        new ManagedPiDriver({ client, adapterVersion: '1.0.0' })
      ),
    }),
  }
}

describe('non-co-located Managed Pi through Runtime Gateway', () => {
  test('matches the exact supported compatibility certification capability claim', async () => {
    const { adapter, transport } = fixture()
    const inspection = await adapter.inspect()
    const inventory = await transport.inventory()
    const matrix = RuntimeCompatibilityMatrixSchema.parse(
      JSON.parse(await readFile(matrixUrl, 'utf8'))
    )
    const certification = matrix.certifications.find(
      ({ certificationId }) => certificationId === 'managed-pi-reference-gateway-1-6-0'
    )

    expect(certification).toMatchObject({
      classification: 'supported',
      versions: {
        adapter: inspection.metadata.adapterVersion,
        driver: inspection.metadata.driverVersion,
        harness: inspection.metadata.harnessVersion,
        protocol: `${inventory.protocolVersion.major}.${inventory.protocolVersion.minor}.0`,
      },
    })
    expect(certification.verifiedCapabilities).toEqual(
      inspection.capabilities.map(({ name }) => name).sort()
    )
  })

  test('executes one normalized plan with canonical progress, result, and version provenance', async () => {
    const { adapter, transport } = fixture()

    expect(await adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'healthy',
      metadata: {
        adapterVersion: '1.0.0',
        driverVersion: '1.0.0',
        harnessVersion: '0.52.1',
        transportKind: 'remote-gateway',
      },
      capabilityEvaluation: { eligible: true },
    })
    const handle = await adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'managed-pi:gateway:start',
      executionPlan: plan(),
    })
    const progress = []
    for await (const event of adapter.progress(handle)) progress.push(event)

    expect(progress.map(({ type }) => type)).toEqual([
      'status',
      'output',
      'interaction',
      'usage',
      'artifact',
      'status',
    ])
    expect(await adapter.status(handle)).toMatchObject({
      state: 'completed',
      result: {
        output: { answer: 'managed-pi-complete' },
        usage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
      },
    })
    expect(transport.commands().map(({ operation }) => operation)).toEqual([
      'runtime.execute',
      'runtime.status',
    ])
    expect(transport.commands()[0]).toMatchObject({
      nodeId: ids.nodeId,
      workspaceId: ids.workspaceId,
      runtimeConnectionId: ids.runtimeConnectionId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      payload: {
        parameters: {
          grantRef: 'grant:project-0001',
          configuration: {
            profile: { version: 3, revision: 2 },
            skills: [{ semanticVersion: '2.1.0', revision: 4 }],
          },
        },
      },
    })
    expect(JSON.stringify(transport.commands())).not.toMatch(
      /\/Users\/|credential|apiKey|accessToken|privateKey/
    )
  })

  test('redelivers the same command after reconnect without duplicating execution', async () => {
    const { adapter, transport, driver } = fixture('running')
    const handle = await adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'managed-pi:gateway:reconnect',
      executionPlan: plan(),
    })
    const command = transport.commands()[0]

    transport.disconnect()
    expect((await adapter.inspect(plan().runtimeRequirements)).health).toBe('unavailable')
    transport.connect()
    const replay = await transport.redeliver(command.commandId)

    expect(replay.ack.disposition).toBe('replayed')
    expect(driver.effectCount(ids.attemptId, 'runtime.execute')).toBe(1)
    expect(await adapter.reconcile(handle)).toMatchObject({ state: 'running' })
  })

  test('maps cancellation, input, and revoked grants without ambient authority', async () => {
    const running = fixture('awaiting_input')
    const handle = await running.adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'managed-pi:gateway:interaction',
      executionPlan: plan(),
    })
    expect(await running.adapter.status(handle)).toMatchObject({ state: 'awaiting_input' })
    expect(
      await running.adapter.submitInput(handle, {
        interactionId: 'int_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'managed-pi:gateway:input',
        text: 'continue',
      })
    ).toMatchObject({ state: 'running' })
    expect(
      await running.adapter.cancel(handle, {
        idempotencyKey: 'managed-pi:gateway:cancel',
        requestedAt: now,
      })
    ).toMatchObject({ state: 'cancelled' })

    const revoked = fixture('running')
    revoked.driver.setGrantState('grant:project-0001', 'revoked')
    expect(await revoked.adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'unavailable',
      limitations: expect.arrayContaining(['LOCAL_PROJECT_GRANT_REVOKED']),
    })
    await expect(
      revoked.adapter.start({
        attemptId: ids.attemptId,
        idempotencyKey: 'managed-pi:gateway:revoked',
        executionPlan: plan(),
      })
    ).rejects.toMatchObject({ code: 'MANAGED_PI_INELIGIBLE' })
    expect(revoked.transport.commands()).toHaveLength(0)

    const revokedNode = fixture('running')
    revokedNode.transport.revokeNode()
    expect(await revokedNode.adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'unavailable',
      limitations: expect.arrayContaining(['RUNTIME_NODE_REVOKED']),
    })
    await expect(
      revokedNode.adapter.start({
        attemptId: ids.attemptId,
        idempotencyKey: 'managed-pi:gateway:revoked-node',
        executionPlan: plan(),
      })
    ).rejects.toMatchObject({ code: 'MANAGED_PI_INELIGIBLE' })
    expect(revokedNode.transport.commands()).toHaveLength(0)
  })

  test('rejects an incompatible managed Pi runtime before command delivery', async () => {
    const incompatible = fixture('running', { harnessVersion: '0.51.9' })

    expect(await incompatible.adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'unavailable',
      limitations: expect.arrayContaining(['UNSUPPORTED_PI_RUNTIME_VERSION:0.51.9']),
    })
    await expect(
      incompatible.adapter.start({
        attemptId: ids.attemptId,
        idempotencyKey: 'managed-pi:gateway:incompatible',
        executionPlan: plan(),
      })
    ).rejects.toMatchObject({ code: 'MANAGED_PI_INELIGIBLE' })
    expect(incompatible.transport.commands()).toHaveLength(0)
  })

  test('classifies crash, timeout, and ambiguous outcomes without automatic retry', async () => {
    for (const [scenario, state, code, retryable] of [
      ['crash', 'failed', 'PI_PROCESS_CRASHED', true],
      ['timeout', 'timed_out', 'PI_EXECUTION_TIMED_OUT', true],
      ['ambiguous', 'failed', 'PI_AMBIGUOUS_OUTCOME', false],
    ]) {
      const { adapter, driver } = fixture(scenario)
      const handle = await adapter.start({
        attemptId: ids.attemptId,
        idempotencyKey: `managed-pi:gateway:${scenario}`,
        executionPlan: plan(),
      })

      expect(await adapter.status(handle)).toMatchObject({
        state,
        error: { code, retryable },
      })
      expect(driver.effectCount(ids.attemptId, 'runtime.execute')).toBe(1)
    }
  })
})
