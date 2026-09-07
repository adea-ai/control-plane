import { describe, expect, test } from 'bun:test'
import {
  GatewayEnvelopeSchema,
  GatewayProtocolDeprecationSchema,
  GatewayProtocolManifest,
  ReferenceRuntimeNode,
  RuntimeNodeAuthenticationAttemptSchema,
  RuntimeNodeCredentialClaimsSchema,
  inventoryFixtures,
  negotiateGatewayProtocolVersion,
  runGatewayProtocolConformance,
} from './index.ts'

const ids = {
  command: 'cmd_01JABCDEF0123456789ABCDEFG',
  workspace: 'wsp_01JABCDEF0123456789ABCDEFG',
  node: 'rnr_01JABCDEF0123456789ABCDEFG',
  connection: 'rtc_01JABCDEF0123456789ABCDEFG',
  execution: 'exe_01JABCDEF0123456789ABCDEFG',
  attempt: 'att_01JABCDEF0123456789ABCDEFG',
  trace: 'trc_01JABCDEF0123456789ABCDEFG',
}

describe('Runtime Gateway protocol', () => {
  test('validates every golden envelope and rejects provider-native or privileged local payloads', async () => {
    const { golden, malformed } = await import('../fixtures/index.mjs')
    const node = new ReferenceRuntimeNode()

    for (const envelope of Object.values(golden)) {
      expect(GatewayEnvelopeSchema.parse(envelope)).toEqual(envelope)
      expect(node.observe(envelope)).toBe(envelope.type)
    }
    for (const envelope of Object.values(malformed)) {
      expect(GatewayEnvelopeSchema.safeParse(envelope).success).toBeFalse()
    }

    const serialized = JSON.stringify(golden)
    for (const concreteType of ['pi.command', 'acp.command', 'cortana.command']) {
      expect(serialized).not.toContain(concreteType)
    }
  })

  test('rejects privileged selector aliases at every payload depth', () => {
    for (const parameters of [
      { host: '127.0.0.1' },
      { nested: { file: '/tmp/runtime.sock' } },
      { options: [{ cwd: '/workspace' }] },
      { command: '/usr/local/bin/runtime' },
    ]) {
      expect(
        GatewayEnvelopeSchema.safeParse({
          ...runtimeCommand(),
          payload: { version: 1, parameters },
        }).success
      ).toBeFalse()
    }

    expect(
      GatewayEnvelopeSchema.safeParse({
        ...runtimeCommand(),
        payload: {
          version: 1,
          parameters: {
            prompt: 'summarize the selected document',
            profile: { profileId: 'prf_01JABCDEF0123456789ABCDEFG' },
            maxOutputBytes: 512,
            limits: { maximumTokens: 4096 },
          },
        },
      }).success
    ).toBeTrue()

    for (const parameters of [
      { accessToken: 'credential-value' },
      { refresh_token: 'credential-value' },
      { nested: { bearerToken: 'credential-value' } },
    ]) {
      expect(
        GatewayEnvelopeSchema.safeParse({
          ...runtimeCommand(),
          payload: { version: 1, parameters },
        }).success
      ).toBeFalse()
    }
  })

  test('negotiates compatible versions and fails closed when no major version overlaps', () => {
    expect(
      negotiateGatewayProtocolVersion(GatewayProtocolManifest.supported, [{ major: 1, minor: 0 }])
    ).toEqual({ major: 1, minor: 0 })
    expect(
      negotiateGatewayProtocolVersion(GatewayProtocolManifest.supported, [{ major: 2, minor: 0 }])
    ).toBeUndefined()
    expect(
      GatewayProtocolDeprecationSchema.safeParse({
        version: { major: 1, minor: 0 },
        deprecatedAt: '2026-09-01T00:00:00.000Z',
        sunsetAt: '2026-08-31T00:00:00.000Z',
      }).success
    ).toBeFalse()
  })

  test('recognizes redelivery without payload ambiguity and never re-executes an effect', () => {
    const node = new ReferenceRuntimeNode({ now: () => new Date('2026-08-25T12:00:01.000Z') })
    const command = runtimeCommand()

    const first = node.receive(command)
    const replay = node.receive(command)

    expect(first.ack.disposition).toBe('accepted')
    expect(replay.ack.disposition).toBe('replayed')
    expect(replay.result).toEqual(first.result)
    expect(node.effectCount(command.commandId)).toBe(1)
    expect(() => node.receive({ ...command, payloadHash: `sha256:${'b'.repeat(64)}` })).toThrow(
      'COMMAND_PAYLOAD_MISMATCH'
    )
  })

  test('supports durable runtime control commands and command-bound error correlation', async () => {
    const { golden } = await import('../fixtures/index.mjs')
    expect(
      GatewayEnvelopeSchema.safeParse({
        ...runtimeCommand(),
        protocolVersion: { major: 1, minor: 1 },
        operation: 'runtime.cancel',
        requiredCapabilities: ['execution.cancel'],
      }).success
    ).toBeTrue()
    expect(GatewayEnvelopeSchema.safeParse(golden.error).success).toBeTrue()
    expect(
      GatewayEnvelopeSchema.safeParse({ ...golden.error, payloadHash: undefined }).success
    ).toBeTrue()

    expect(
      GatewayEnvelopeSchema.safeParse({
        ...runtimeCommand(),
        protocolVersion: { major: 1, minor: 4 },
        operation: 'runtime.status',
        requiredCapabilities: ['stream.events'],
        payload: { version: 1, parameters: { reconcile: true } },
      }).success
    ).toBeTrue()
    expect(
      GatewayEnvelopeSchema.safeParse({
        ...runtimeCommand(),
        protocolVersion: { major: 1, minor: 5 },
        operation: 'runtime.session',
        requiredCapabilities: ['session.resume'],
        payload: { version: 1, parameters: { action: 'resume', sessionRef: 'opaque-session' } },
      }).success
    ).toBeTrue()
    expect(GatewayProtocolManifest.current).toEqual({ major: 1, minor: 5 })
  })

  test('fails closed instead of evicting duplicate-effect protection when its ledger is full', () => {
    const node = new ReferenceRuntimeNode({
      maxLedgerEntries: 1,
      now: () => new Date('2026-08-25T12:00:01.000Z'),
    })
    const first = runtimeCommand()
    node.receive(first)

    expect(() =>
      node.receive({
        ...first,
        commandId: 'cmd_01JABCDEF0123456789ABCDEFH',
        idempotencyKey: 'runtime-command:01JABCDEF0123456789ABCDEFH',
        payloadHash: `sha256:${'b'.repeat(64)}`,
      })
    ).toThrow('COMMAND_LEDGER_CAPACITY_EXCEEDED')
    expect(node.effectCount(first.commandId)).toBe(1)
  })

  test('represents zero, compatible, and alternate context providers without changing envelopes', () => {
    for (const inventory of Object.values(inventoryFixtures)) {
      expect(GatewayEnvelopeSchema.parse(inventory).type).toBe('inventory')
    }
    expect(inventoryFixtures.noProvider.contextProviders).toEqual([])
    expect(inventoryFixtures.cortanaCompatible.contextProviders[0]).toMatchObject({
      driverFamily: 'local-context',
      capabilities: ['context.status', 'context.read'],
    })
    expect(inventoryFixtures.alternateProvider.contextProviders[0].driverFamily).toBe(
      'alternate-context'
    )
  })

  test('supports additive v1.2 inventory deltas with correlated runtime versions', () => {
    const runtime = {
      ...inventoryFixtures.noProvider.runtimeDrivers[0],
      adapterVersion: '1.0.0',
      protocolVersion: { major: 1, minor: 2 },
    }
    const delta = {
      ...inventoryFixtures.noProvider,
      protocolVersion: { major: 1, minor: 2 },
      mode: 'delta',
      snapshotVersion: 2,
      baseSnapshotVersion: 1,
      runtimeDrivers: [runtime],
      removedRuntimeRefs: [],
    }
    expect(GatewayEnvelopeSchema.safeParse(delta).success).toBeTrue()
    expect(
      GatewayEnvelopeSchema.safeParse({ ...delta, baseSnapshotVersion: undefined }).success
    ).toBeFalse()
    expect(
      GatewayEnvelopeSchema.safeParse({
        ...delta,
        runtimeDrivers: [{ ...runtime, adapterVersion: undefined }],
      }).success
    ).toBeFalse()
  })

  test('bounds and correlates retained command outcomes in the v1.3 reconnect hello', async () => {
    const { golden } = await import('../fixtures/index.mjs')
    const retained = {
      commandId: ids.command,
      payloadHash: `sha256:${'a'.repeat(64)}`,
      status: 'running',
      observedAt: '2026-08-25T12:00:00.000Z',
    }
    const hello = {
      ...golden.hello,
      protocolVersion: { major: 1, minor: 3 },
      supportedVersions: [{ major: 1, minor: 3 }],
      retainedCommandOutcomes: [retained],
    }
    expect(GatewayEnvelopeSchema.safeParse(hello).success).toBeTrue()
    expect(
      GatewayEnvelopeSchema.safeParse({ ...hello, retainedCommandOutcomes: [retained, retained] })
        .success
    ).toBeFalse()
    expect(
      GatewayEnvelopeSchema.safeParse({ ...hello, protocolVersion: { major: 1, minor: 2 } }).success
    ).toBeFalse()
  })

  test('passes the reusable protocol conformance suite against the reference node', () => {
    expect(runGatewayProtocolConformance()).toEqual({ scenarios: 9, passed: 9 })
  })

  test('publishes strict provider-independent RuntimeNode identity contracts', () => {
    const claims = {
      schemaVersion: 1,
      credentialKind: 'runtime_node',
      credentialId: 'rgc_0000000000000001',
      issuer: 'https://identity.test.example',
      audience: 'control-plane-runtime-gateway',
      nodeId: ids.node,
      workspaceId: ids.workspace,
      keyId: 'rgk_000000000001',
      proofKeyThumbprint: `sha256:${'a'.repeat(64)}`,
      revocationVersion: 1,
      channelGeneration: 1,
      issuedAt: '2026-08-25T12:00:00.000Z',
      expiresAt: '2026-08-25T12:05:00.000Z',
    }
    expect(RuntimeNodeCredentialClaimsSchema.parse(claims)).toEqual(claims)
    expect(
      RuntimeNodeCredentialClaimsSchema.safeParse({ ...claims, credentialKind: 'browser_session' })
        .success
    ).toBeFalse()
    expect(
      RuntimeNodeAuthenticationAttemptSchema.safeParse({
        credential: 'signed_header.signed_credential_payload.signed_credential_signature',
        proof: { challenge: 'challenge-contract-0001', signature: 'signature_value' },
      }).success
    ).toBeTrue()
  })

  test('publishes a language-neutral JSON schema without server package dependencies', async () => {
    const schema = await import('../schema/gateway-envelope.v1.json', { with: { type: 'json' } })
    const manifest = await import('../package.json', { with: { type: 'json' } })

    expect(schema.default.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.default.oneOf).toHaveLength(9)
    expect(Object.keys(manifest.default.dependencies)).toEqual(['zod'])
    expect(Object.keys(manifest.default.devDependencies ?? {})).toEqual([])
  })
})

function runtimeCommand() {
  return {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 0 },
    sequence: 1,
    nodeId: ids.node,
    workspaceId: ids.workspace,
    traceId: ids.trace,
    sentAt: '2026-08-25T12:00:00.000Z',
    channelGeneration: 1,
    commandId: ids.command,
    idempotencyKey: 'runtime-command:01JABCDEF0123456789ABCDEFG',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    issuedAt: '2026-08-25T12:00:00.000Z',
    expiresAt: '2026-08-25T12:01:00.000Z',
    family: 'runtime',
    operation: 'runtime.execute',
    driver: { family: 'reference-runtime', version: '1.0.0' },
    runtimeConnectionId: ids.connection,
    executionId: ids.execution,
    attemptId: ids.attempt,
    requiredCapabilities: ['runtime.execute'],
    payload: { version: 1, parameters: { prompt: 'deterministic fixture' } },
  }
}
