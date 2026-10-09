// Profile recovery and fenced rollback (CP1025 / M17.02.2).
//
// Proves the merged profile composition boundary across a crash and a
// rollback. A rebound profile binding revalidates the trusted topology,
// current authority and residency, then resumes the same upstream attempt
// through the selected adapter's supported idempotent semantics; it never
// resends the physical start and never converts a checkpoint across
// harnesses. Once the server-owned rollback fence closes, every operation on
// the previous owner fails closed before it can reach the upstream runtime,
// while exactly one new owner can resume at the next generation.
//
// Storage restore is proven at the composition boundary for every supported
// profile mapping. There is no crash-recovery engine here: the tests exercise
// the merged profile package and the upstream adapter's retained-handle
// semantics only.
import { describe, expect, test } from 'bun:test'
import { executionConstraintFixtures } from '@control-plane/domain'
import { ManagedPiAdapter, ManagedPiDriver } from '@control-plane/managed-pi-adapter'
import {
  DirectLocalRuntimeTransport,
  MockRuntimeAdapter,
  TransportedRuntimeAdapter,
} from '@control-plane/runtime-sdk'
import {
  bindProfileRuntime,
  bindProfileStorage,
  ExecutionProfiles,
  ProfileAdapterError,
} from './index.ts'

const component = (profile) => ({
  profile,
  start: async () => undefined,
  stop: async () => undefined,
  health: async () => ({ ready: true, component: 'fixture', version: '1.0.0' }),
})

const persistence = (profile, dialect) => ({
  profile,
  dialect,
  migrate: async () => undefined,
  health: async () => ({ ready: true, component: 'fixture', version: '1.0.0' }),
  transaction: async () => undefined,
  close: async () => undefined,
})

const composition = (
  profile,
  dialect = profile === 'hosted-server' || profile === 'cloud' ? 'postgresql' : 'sqlite'
) => ({
  profile,
  persistence: persistence(profile, dialect),
  workflow: component(profile),
  objectStore: {
    put: async () => ({}),
    get: async () => ({}),
    head: async () => ({}),
    delete: async () => undefined,
    close: async () => undefined,
  },
  secrets: {
    resolve: async () => ({}),
    health: async () => ({ ready: true, component: 'fixture', version: '1.0.0' }),
    close: async () => undefined,
  },
  coordination: { acquire: async () => undefined, close: async () => undefined },
  processes: { launch: async () => undefined, close: async () => undefined },
  discovery: { discover: async () => [] },
  observability: { write: () => undefined, close: async () => undefined },
})

const localPlacement = Object.freeze({
  controlPlaneHostId: 'local-host',
  runtimeHostId: 'local-host',
  runtimeLocation: 'local_device',
  coLocated: true,
})

const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const planId = 'pln_01JABCDEF0123456789ABCDEFG'
const digest = (character) => `sha256:${character.repeat(64)}`

function startRequest(idempotencyKey) {
  return {
    attemptId,
    idempotencyKey,
    executionPlan: {
      schemaVersion: 1,
      executionPlanId: planId,
      contentDigest: digest('a'),
      runtimeRequirements: [
        { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
      ],
    },
  }
}

function managedExecutionPlan() {
  return {
    schemaVersion: 1,
    executionPlanId: planId,
    contentDigest: digest('a'),
    profile: {
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
      version: 3,
      revision: 2,
      schemaVersion: 1,
      contentDigest: digest('b'),
    },
    skills: [],
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

const allowedGuards = (calls = []) => ({
  authority: {
    assertCurrent: async (context) => {
      calls.push(['authority', context])
    },
  },
  residency: {
    assertCurrent: async (context) => {
      calls.push(['residency', context])
    },
  },
})

const trustedTopology = (adapter, transport) => ({
  assertCurrent: async (_context, binding) => {
    if (binding.adapter !== adapter || binding.transport !== transport) {
      throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
        reason: 'TRUSTED_TOPOLOGY_REJECTED',
      })
    }
  },
})

async function collect(iterable) {
  for await (const _event of iterable) {
    // Drain progress; the guard refusal rejects the iteration.
  }
}

async function failureOf(run) {
  try {
    await run()
  } catch (error) {
    return error
  }
  return undefined
}

function refusalOf(run) {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

const managedPiNow = '2026-08-25T12:00:00.000Z'

/** Minimal managed-Pi client over the canonical driver contract. */
class RecordingManagedPiClient {
  starts = []
  executions = new Map()

  async inspect() {
    return {
      driverVersion: '1.0.0',
      runtimeVersion: '0.52.1',
      protocolVersion: '1.0.0',
      health: 'healthy',
      capabilities: [
        { name: 'stream.output', support: 'supported' },
        { name: 'execution.cancel', support: 'supported' },
        { name: 'interaction.user-input', support: 'supported' },
        { name: 'interaction.approval', support: 'supported' },
      ],
      limitations: [],
      observedAt: managedPiNow,
    }
  }

  async start(command) {
    this.starts.push(globalThis.structuredClone(command))
    const handle = {
      handleId: `managed-pi:${command.attemptId}`,
      attemptId: command.attemptId,
      startedAt: managedPiNow,
    }
    this.executions.set(handle.handleId, { handle, state: 'running' })
    return handle
  }

  async *progress(_handle, afterSequence = 0) {
    if (afterSequence < 1)
      yield { sequence: 1, occurredAt: managedPiNow, kind: 'status', state: 'running' }
  }

  async submitInput(handle) {
    return this.status(handle)
  }

  async submitApproval(handle) {
    return this.status(handle)
  }

  async cancel(handle, request) {
    const execution = this.executions.get(handle.handleId)
    execution.state = 'cancelled'
    execution.observedAt = request.requestedAt
    return this.status(handle)
  }

  async status(handle) {
    const execution = this.executions.get(handle.handleId)
    return { state: execution.state, observedAt: execution.observedAt ?? managedPiNow }
  }

  async reconcile(handle) {
    return this.status(handle)
  }

  async cleanup(handle) {
    this.executions.delete(handle.handleId)
  }
}

describe('profile recovery and fenced rollback', () => {
  test('once the rollback fence closes every operation on the old owner fails before upstream effects', async () => {
    const calls = []
    let authorityApproved = true
    const driver = new MockRuntimeAdapter()
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const binding = await bindProfileRuntime({
      profile: ExecutionProfiles.local,
      deployment: composition('local'),
      candidate: { adapter, transport, placement: localPlacement },
      guards: {
        authority: {
          assertCurrent: async (context) => {
            calls.push(['authority', context])
            if (!authorityApproved) throw new ProfileAdapterError('PROFILE_AUTHORITY_REJECTED')
          },
        },
        residency: {
          assertCurrent: async (context) => {
            calls.push(['residency', context])
          },
        },
      },
      topology: trustedTopology(adapter, transport),
      requiredCapabilities: [{ capability: 'stream.output', necessity: 'required' }],
    })
    const request = startRequest('recovery:fence')
    const handle = await binding.adapter.start(request)

    // The server-owned rollback fence closes: this owner's authority is no
    // longer approved, exactly as a revoked grant or drained generation.
    authorityApproved = false
    const operations = [
      () => binding.adapter.status(handle),
      () => binding.adapter.reconcile(handle),
      () => collect(binding.adapter.progress(handle)),
      () =>
        binding.adapter.submitInput(handle, {
          interactionId: 'int_01JABCDEF0123456789ABCDEFG',
          idempotencyKey: 'recovery:input',
          text: 'hello',
        }),
      () =>
        binding.adapter.submitApproval(handle, {
          interactionId: 'int_01JABCDEF0123456789ABCDEFG',
          idempotencyKey: 'recovery:approval',
          decision: 'approve',
        }),
      () =>
        binding.adapter.cancel(handle, {
          idempotencyKey: 'recovery:cancel',
          requestedAt: managedPiNow,
        }),
      () => binding.adapter.session({ operation: 'create', idempotencyKey: 'recovery:session' }),
      () => binding.adapter.cleanup(handle),
    ]
    for (const operation of operations) {
      const failure = await failureOf(operation)
      expect(failure?.code).toBe('PROFILE_AUTHORITY_REJECTED')
    }

    // Nothing reached the upstream runtime: the execution is untouched and
    // the retained attempt is still running with the same handle.
    expect((await driver.status(handle)).state).toBe('running')
    expect(calls.some(([guard]) => guard === 'authority')).toBe(true)
  })

  test('a new owner at the next generation resumes while the fenced owner stays refused', async () => {
    const driver = new MockRuntimeAdapter()
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const oldCalls = []
    let oldApproved = true
    const oldBinding = await bindProfileRuntime({
      profile: ExecutionProfiles.local,
      deployment: composition('local'),
      candidate: { adapter, transport, placement: localPlacement },
      guards: {
        authority: {
          assertCurrent: async (context) => {
            oldCalls.push(context)
            if (!oldApproved) throw new ProfileAdapterError('PROFILE_AUTHORITY_REJECTED')
          },
        },
        residency: { assertCurrent: async () => undefined },
      },
      topology: trustedTopology(adapter, transport),
    })
    const handle = await oldBinding.adapter.start(startRequest('recovery:new-owner'))

    // Rollback: the old owner is fenced; the next owner binds the retained
    // handle through a fresh approved authority and resumes it.
    oldApproved = false
    const newCalls = []
    const newBinding = await bindProfileRuntime({
      profile: ExecutionProfiles.local,
      deployment: composition('local'),
      candidate: { adapter, transport, placement: localPlacement },
      guards: allowedGuards(newCalls),
      topology: trustedTopology(adapter, transport),
    })
    const resumed = await newBinding.adapter.reconcile(handle)
    expect(resumed.state).toBe('running')
    expect(resumed.handle.handleId).toBe(handle.handleId)
    expect(resumed.handle.attemptId).toBe(handle.attemptId)
    // The new owner's guard saw the exact retained handle target.
    const handleContext = newCalls.find(
      ([kind, context]) => kind === 'authority' && context.operation === 'runtime.reconcile'
    )
    expect(handleContext?.[1].target).toMatchObject({
      kind: 'handle',
      handleId: handle.handleId,
      attemptId: handle.attemptId,
      startedAt: handle.startedAt,
    })
    // The fenced owner is not resurrected by the new owner's success.
    const refused = await failureOf(() => oldBinding.adapter.status(handle))
    expect(refused?.code).toBe('PROFILE_AUTHORITY_REJECTED')
  })

  test('a rebound profile resumes the retained managed-Pi attempt without resending the physical start', async () => {
    const client = new RecordingManagedPiClient()
    const transport = new DirectLocalRuntimeTransport(
      new ManagedPiDriver({ client, adapterVersion: '1.0.0' })
    )
    const adapter = new ManagedPiAdapter({ transport })
    const binding = await bindProfileRuntime({
      profile: ExecutionProfiles.local,
      deployment: composition('local'),
      candidate: { adapter, transport, placement: localPlacement },
      guards: allowedGuards(),
      topology: trustedTopology(adapter, transport),
      requiredCapabilities: [{ capability: 'stream.output', necessity: 'required' }],
    })
    const handle = await binding.adapter.start({
      attemptId,
      idempotencyKey: 'recovery:managed-pi',
      executionPlan: managedExecutionPlan(),
    })
    expect(client.starts).toHaveLength(1)

    // Crash/rebind: the guarded binding is discarded and a fresh binding
    // revalidates topology, authority and residency. The supported upstream
    // retained-handle semantics resume the exact attempt.
    const recovered = await bindProfileRuntime({
      profile: ExecutionProfiles.local,
      deployment: composition('local'),
      candidate: { adapter, transport, placement: localPlacement },
      guards: allowedGuards(),
      topology: trustedTopology(adapter, transport),
    })
    const status = await recovered.adapter.reconcile(handle)
    expect(status.state).toBe('running')
    expect(status.handle.handleId).toBe(handle.handleId)
    expect(status.handle.attemptId).toBe(attemptId)
    // Recovery never re-issues the physical start.
    expect(client.starts).toHaveLength(1)
  })

  test('every supported composition root rebinds after restore and never falls back across profiles', () => {
    const restores = [
      [ExecutionProfiles.local, 'local', 'sqlite'],
      [ExecutionProfiles.selfHosted, 'hosted-simple', 'sqlite'],
      [ExecutionProfiles.selfHosted, 'hosted-server', 'postgresql'],
      [ExecutionProfiles.hosted, 'cloud', 'postgresql'],
    ]
    for (const [profile, deploymentProfile, persistenceDialect] of restores) {
      expect(bindProfileStorage(profile, composition(deploymentProfile))).toMatchObject({
        profile,
        deploymentProfile,
        persistenceDialect,
      })
    }
    const mismatches = [
      [ExecutionProfiles.local, 'cloud'],
      [ExecutionProfiles.local, 'hosted-server'],
      [ExecutionProfiles.hosted, 'local'],
      [ExecutionProfiles.selfHosted, 'local'],
    ]
    for (const [profile, deploymentProfile] of mismatches) {
      const refusal = refusalOf(() => bindProfileStorage(profile, composition(deploymentProfile)))
      expect(refusal?.code).toBe('PROFILE_DEPLOYMENT_MISMATCH')
    }
  })
})
