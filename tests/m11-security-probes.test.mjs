import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executionConstraintFixtures } from '@control-plane/domain'
import { NodeProcessRuntimeProvider } from '@control-plane/deployment'
import { ManagedPiAdapter, ManagedPiDriver } from '@control-plane/managed-pi-adapter'
import { RemoteRuntimeGatewayTransport } from '@control-plane/runtime-sdk'
import { PrivateFileSecretsProvider, SecretsProviderError } from '@control-plane/secrets'
import {
  MAX_RELAY_CIPHERTEXT_BYTES,
  MAX_RELAY_ENVELOPE_LIFETIME_MS,
  RelayEnvelopeError,
  decryptRelayPayload,
  encryptRelayPayload,
  generateHostEncryptionKeyPair,
} from '../packages/remote-control-relay/src/index.ts'
import {
  CedarPolicyDecisionPoint,
  FakeCedarEvaluator,
  InMemoryPolicyStore,
} from '../packages/policy/src/index.ts'
import {
  SecretCanaryGuard,
  assertCredentialPurpose,
  findCredentialLeaks,
} from '@control-plane/production-readiness'
import {
  ManagedPiGatewayClient,
  ReferenceManagedPiDriver,
  ReferenceManagedPiGatewayTransport,
} from '../packages/managed-pi-adapter/src/gateway.ts'

// M11.5 (#190) adversarial probes, queued against STM rows in
// docs/requirements/security-trust-source-audit.md. These are distinct from
// component tests: each probe drives a real trust boundary with hostile input
// and asserts the boundary fails closed (reject, deny, or unavailable).

const MAX_SECRET_BYTES = 64 * 1024
const opaqueAlphabet = '01JABCDEF0123456789ABCDEFGHJKMNPQ'
const opaqueId = (prefix, variant = '') =>
  `${prefix}_${('01JABCDEF0123456789' + variant).padEnd(26, 'A').slice(0, 26)}`
const digestText = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const now = '2026-09-14T12:00:00.000Z'
const later = (millis) => new Date(Date.parse(now) + millis).toISOString()

const workspaceA = opaqueId('wsp')
const workspaceB = opaqueId('wsp', 'BCDEFGH')
const policyCedar = 'permit(principal, action, resource);'
const policySnapshot = () => ({
  policyId: 'probe.default',
  version: 1,
  digest: digestText(policyCedar),
})

describe('M11.5 probes: workspace isolation (STM-001/013/021)', () => {
  const permitExecute = [
    { effect: 'permit', principalType: 'user', action: 'runtime:execute', resourceType: 'runtime' },
  ]

  async function activatedPolicy(rules = permitExecute) {
    const store = new InMemoryPolicyStore()
    const evaluator = new FakeCedarEvaluator(rules)
    const reference = policySnapshot()
    await store.publish({ ...reference, cedar: policyCedar, createdAt: now })
    await store.activate(reference.policyId, reference.version)
    return { store, evaluator, reference }
  }

  function policyRequest(overrides = {}) {
    return {
      requestId: opaqueId('req'),
      principal: {
        type: 'user',
        id: 'agent:probe-user',
        workspaceId: workspaceA,
        ...overrides.principal,
      },
      action: 'runtime:execute',
      resource: {
        type: 'runtime',
        id: 'runtime:probe-runtime',
        workspaceId: workspaceA,
        attributes: {},
        ...overrides.resource,
      },
      context: {
        workspaceId: workspaceA,
        requestedAt: now,
        ...overrides.context,
      },
      policySnapshot: overrides.policySnapshot ?? policySnapshot(),
      ...overrides.top,
    }
  }

  test('cross-workspace principal, resource, and context bindings each deny', async () => {
    const { store, evaluator } = await activatedPolicy()
    const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
    const mismatches = [
      { principal: { workspaceId: workspaceB }, label: 'principal outside' },
      { resource: { workspaceId: workspaceB }, label: 'resource outside' },
      { context: { workspaceId: workspaceB }, label: 'context outside' },
    ]
    for (const mismatch of mismatches) {
      const decision = await decisionPoint.authorize(policyRequest(mismatch))
      expect(decision.effect, mismatch.label).toBe('deny')
      expect(decision.reasonCode, mismatch.label).toBe('WORKSPACE_SCOPE_MISMATCH')
    }
  })

  test('same-scope permit still allows, so denial is scoped and not blanket', async () => {
    const { store, evaluator } = await activatedPolicy()
    const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
    const decision = await decisionPoint.authorize(policyRequest({}))
    expect(decision.effect).toBe('allow')
    expect(decision.reasonCode).toBe('CEDAR_PERMIT')
  })

  test('spoofed scope attributes cannot repair a typed scope mismatch', async () => {
    const { store, evaluator } = await activatedPolicy()
    const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
    const decision = await decisionPoint.authorize(
      policyRequest({
        principal: { workspaceId: workspaceB, attributes: { workspaceId: workspaceA } },
      })
    )
    expect(decision.effect).toBe('deny')
    expect(decision.reasonCode).toBe('WORKSPACE_SCOPE_MISMATCH')
  })

  test('malformed workspace identifiers are rejected at the boundary', async () => {
    const { store, evaluator } = await activatedPolicy()
    const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
    expect(
      decisionPoint.authorize(
        policyRequest({ context: { workspaceId: `wsp_${'../evil'.padEnd(26, 'A')}` } })
      )
    ).rejects.toThrow()
  })
})

describe('M11.5 probes: authorization elevation (STM-002/025)', () => {
  const permitExecute = [
    { effect: 'permit', principalType: 'user', action: 'runtime:execute', resourceType: 'runtime' },
  ]
  const cedar = 'permit(principal, action, resource);'

  async function storeWithRules(rules) {
    const store = new InMemoryPolicyStore()
    const evaluator = new FakeCedarEvaluator(rules)
    const reference = { policyId: 'probe.default', version: 1, digest: digestText(cedar) }
    await store.publish({ ...reference, cedar, createdAt: now })
    await store.activate(reference.policyId, reference.version)
    return { store, evaluator, reference }
  }

  function policyRequest(overrides = {}) {
    return {
      requestId: opaqueId('req'),
      principal: {
        type: 'user',
        id: 'agent:probe-user',
        workspaceId: workspaceA,
        ...overrides.principal,
      },
      action: 'runtime:execute',
      resource: {
        type: 'runtime',
        id: 'runtime:probe-runtime',
        workspaceId: workspaceA,
        attributes: {},
        ...overrides.resource,
      },
      context: { workspaceId: workspaceA, requestedAt: now, ...overrides.context },
      policySnapshot: overrides.policySnapshot ?? policySnapshot(),
      ...overrides.top,
    }
  }

  test('deny-by-default: unmapped actions deny even with an active policy', async () => {
    const { store, evaluator } = await storeWithRules([
      { effect: 'permit', principalType: 'user', action: 'tool:invoke', resourceType: 'tool' },
    ])
    const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
    const decision = await decisionPoint.authorize(
      policyRequest({
        resource: { type: 'policy', id: 'policy:probe-default' },
        top: { action: 'policy:update' },
      })
    )
    expect(decision.effect).toBe('deny')
    expect(decision.reasonCode).toBe('CEDAR_DENY')
  })

  test('runtime execute permits do not extend to the policy action family', async () => {
    const { store, evaluator } = await storeWithRules(permitExecute)
    const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
    const decision = await decisionPoint.authorize(
      policyRequest({
        resource: { type: 'policy', id: 'policy:probe-extension' },
        top: { action: 'policy:update' },
      })
    )
    expect(decision.effect).toBe('deny')
    expect(decision.reasonCode).toBe('CEDAR_DENY')
  })

  test('actions cannot cross resource types to reach another evaluator family', async () => {
    const { store, evaluator } = await storeWithRules(permitExecute)
    const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
    const decision = await decisionPoint.authorize(
      policyRequest({ resource: { type: 'tool', id: 'tool:probe-tool' } })
    )
    expect(decision.effect).toBe('deny')
    expect(decision.reasonCode).toBe('ACTION_RESOURCE_MISMATCH')
  })

  test('evaluator outage fails closed instead of opening the boundary', async () => {
    const { store, evaluator } = await storeWithRules(permitExecute)
    evaluator.fail = true
    const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
    const decision = await decisionPoint.authorize(policyRequest({}))
    expect(decision.effect).toBe('deny')
    expect(decision.reasonCode).toBe('POLICY_EVALUATOR_FAILED')
  })

  test('forbid overrides permit and revoked or missing snapshots deny', async () => {
    const { store, evaluator, reference } = await storeWithRules([
      ...permitExecute,
      {
        effect: 'forbid',
        principalType: 'user',
        action: 'runtime:execute',
        resourceType: 'runtime',
      },
    ])
    const decisionPoint = new CedarPolicyDecisionPoint({ store, evaluator })
    const forbidden = await decisionPoint.authorize(policyRequest({}))
    expect(forbidden.effect).toBe('deny')
    expect(forbidden.reasonCode).toBe('CEDAR_FORBID')

    await store.revoke(reference.policyId, reference.version)
    const revoked = await decisionPoint.authorize(
      policyRequest({ policySnapshot: { ...reference } })
    )
    expect(revoked.effect, 'revoked snapshot').toBe('deny')
    expect(revoked.reasonCode, 'revoked snapshot').toBe('POLICY_REVOKED')

    const missing = await decisionPoint.authorize(
      policyRequest({ policySnapshot: { ...reference, digest: digestText('other') } })
    )
    expect(missing.effect, 'missing snapshot').toBe('deny')
    expect(missing.reasonCode, 'missing snapshot').toBe('POLICY_MISSING')
  })

  test('policy store rejects digest forgery, version reuse, and revoked activation', async () => {
    const store = new InMemoryPolicyStore()
    const reference = { policyId: 'probe.default', version: 1, digest: digestText(cedar) }
    expect(
      store.publish({ ...reference, cedar, digest: digestText('forged'), createdAt: now })
    ).rejects.toMatchObject({ message: 'POLICY_DIGEST_MISMATCH' })
    await store.publish({ ...reference, cedar, createdAt: now })
    expect(store.publish({ ...reference, cedar, createdAt: now })).rejects.toMatchObject({
      message: 'POLICY_VERSION_EXISTS',
    })
    expect(store.resolve({ ...reference, digest: digestText('mutated') })).resolves.toBeUndefined()
    await store.revoke(reference.policyId, reference.version)
    expect(store.activate(reference.policyId, reference.version)).rejects.toMatchObject({
      message: 'POLICY_NOT_ACTIVATABLE',
    })
  })
})

describe('M11.5 probes: local secret file trust (STM-008/010/024)', () => {
  async function providerOver(root) {
    return new PrivateFileSecretsProvider({ rootDirectory: root })
  }

  test('reference traversal, provider confusion, and missing keys reject', async () => {
    await withScratchDirectory(async (root) => {
      await mkdir(join(root, 'provider'), { recursive: true })
      await writeFile(join(root, 'provider', 'api-key'), 'probe-secret-value-0001', { mode: 0o600 })
      const provider = await providerOver(root)
      const traversal = [
        'provider/../../../etc/passwd',
        'provider/..%2F..%2Fescape',
        '/etc/passwd',
        'provider/../../outside',
      ]
      for (const key of traversal) {
        expect(
          provider.resolve({ provider: 'file', key }),
          `traversal ${key}`
        ).rejects.toMatchObject({ code: 'SECRET_REFERENCE_INVALID' })
      }
      expect(provider.resolve({ provider: 'env', key: 'provider/api-key' })).rejects.toMatchObject({
        code: 'SECRET_REFERENCE_INVALID',
      })
      expect(
        provider.resolve({ provider: 'file', key: 'provider/absent-key' })
      ).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' })
    })
  })

  test('symlinked secret files and symlinked directories cannot escape the root', async () => {
    await withScratchDirectory(async (root) => {
      await withScratchDirectory(async (outside) => {
        await writeFile(join(outside, 'real-secret'), 'probe-secret-value-0002', { mode: 0o600 })
        await mkdir(join(root, 'provider'), { recursive: true })
        await symlink(join(outside, 'real-secret'), join(root, 'provider', 'linked-key'))
        await symlink(outside, join(root, 'linked-dir'))
        const provider = await providerOver(root)
        expect(
          provider.resolve({ provider: 'file', key: 'provider/linked-key' })
        ).rejects.toMatchObject({ code: 'SECRET_FILE_UNSAFE' })
        expect(
          provider.resolve({ provider: 'file', key: 'linked-dir/real-secret' })
        ).rejects.toMatchObject({ code: 'SECRET_FILE_UNSAFE' })
      })
    })
  })

  test('unsafe permissions, non-files, empty, and oversized values reject', async () => {
    await withScratchDirectory(async (root) => {
      await mkdir(join(root, 'provider'), { recursive: true })
      await writeFile(join(root, 'provider', 'loose'), 'probe-secret-value-0003', { mode: 0o644 })
      await writeFile(join(root, 'provider', 'empty'), '', { mode: 0o600 })
      await writeFile(join(root, 'provider', 'oversized'), 'x'.repeat(MAX_SECRET_BYTES + 1), {
        mode: 0o600,
      })
      const provider = await providerOver(root)
      for (const key of ['provider/loose', 'provider/empty', 'provider/oversized', 'provider']) {
        expect(provider.resolve({ provider: 'file', key }), `unsafe ${key}`).rejects.toThrow(
          SecretsProviderError
        )
      }
    })
  })

  test('a well-formed 0600 secret inside the root still resolves', async () => {
    await withScratchDirectory(async (root) => {
      await mkdir(join(root, 'provider'), { recursive: true })
      await writeFile(join(root, 'provider', 'api-key'), 'probe-secret-value-0004', { mode: 0o600 })
      const provider = await providerOver(root)
      const lease = await provider.resolve({ provider: 'file', key: 'provider/api-key' })
      expect(new TextDecoder().decode(lease.value)).toBe('probe-secret-value-0004')
    })
  })
})

describe('M11.5 probes: managed spawn policy (STM-010, CP-RNODE-025)', () => {
  test('symlinked executables outside the allowlist cannot launch', async () => {
    await withScratchDirectory(async (root) => {
      await symlink('/bin/ls', join(root, 'evil-echo'))
      const provider = new NodeProcessRuntimeProvider({
        spawnPolicy: { allowedExecutables: ['/bin/echo'] },
      })
      expect(
        provider.launch({ executable: join(root, 'evil-echo'), args: [] })
      ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_POLICY_VIOLATION' })
    })
  })

  test('allowlisted entries compared by real path admit their own targets', async () => {
    await withScratchDirectory(async (root) => {
      await symlink('/bin/echo', join(root, 'alias-echo'))
      const provider = new NodeProcessRuntimeProvider({
        spawnPolicy: { allowedExecutables: [join(root, 'alias-echo')] },
      })
      const handle = await provider.launch({ executable: '/bin/echo', args: ['probe-ok'] })
      expect(handle.pid).toBeGreaterThan(0)
      await handle.wait()
    })
  })

  test('working directory escapes and relative or missing cwd reject', async () => {
    await withScratchDirectory(async (root) => {
      await withScratchDirectory(async (outside) => {
        await symlink(outside, join(root, 'escape-link'))
        const provider = new NodeProcessRuntimeProvider({
          spawnPolicy: { allowedWorkingDirectories: [root] },
        })
        expect(
          provider.launch({ executable: '/bin/echo', args: [], cwd: join(root, 'escape-link') })
        ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_POLICY_VIOLATION' })
        expect(
          provider.launch({ executable: '/bin/echo', args: [], cwd: 'relative/path' })
        ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_POLICY_VIOLATION' })
        expect(provider.launch({ executable: '/bin/echo', args: [] })).rejects.toMatchObject({
          code: 'PROCESS_LAUNCH_POLICY_VIOLATION',
        })
      })
    })
  })

  test('argument, environment, and injection limits reject before spawn', async () => {
    const provider = new NodeProcessRuntimeProvider({
      spawnPolicy: {
        maximumArguments: 1,
        maximumArgumentLength: 8,
        maximumEnvironmentVariables: 1,
      },
    })
    expect(
      provider.launch({ executable: '/bin/echo', args: ['a'.repeat(64), 'b'] })
    ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_POLICY_VIOLATION' })
    expect(
      provider.launch({ executable: '/bin/echo', args: ['ok', 'extra'] })
    ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_POLICY_VIOLATION' })
    expect(
      provider.launch({ executable: '/bin/echo', args: ['ok'], environment: { A: '1', B: '2' } })
    ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_POLICY_VIOLATION' })
    expect(
      provider.launch({ executable: '/bin/echo', args: ['bad\0injection'] })
    ).rejects.toMatchObject({ code: 'PROCESS_LAUNCH_INVALID' })
    expect(provider.launch({ executable: '', args: [] })).rejects.toMatchObject({
      code: 'PROCESS_LAUNCH_INVALID',
    })
  })
})

describe('M11.5 probes: local grant admission (STM-010)', () => {
  const runtimeRequirements = [
    { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
    { capability: 'execution.cancel', necessity: 'required', minimumSupport: 'supported' },
  ]

  function grantFixture({ grantRef = 'grant:project-0001', transportWorkspace } = {}) {
    const driver = new ReferenceManagedPiDriver({ now: () => now, scenario: 'complete' })
    driver.setGrantState('grant:project-0001', 'granted')
    const identity = {
      nodeId: opaqueId('rnr'),
      workspaceId: workspaceA,
      runtimeConnectionId: opaqueId('rtc'),
      runtimeOpaqueRef: opaqueId('nref'),
      executionId: opaqueId('exe'),
      traceId: opaqueId('trc'),
    }
    const transport = new ReferenceManagedPiGatewayTransport({
      driver,
      now: () => now,
      nodeId: identity.nodeId,
      workspaceId: transportWorkspace ?? identity.workspaceId,
      runtimeConnectionId: identity.runtimeConnectionId,
      runtimeOpaqueRef: identity.runtimeOpaqueRef,
    })
    const commandIds = new Map()
    let commandIndex = 0
    const client = new ManagedPiGatewayClient({
      transport,
      ...identity,
      localProjectGrantRef: grantRef,
      now: () => new Date(now),
      commandId: (identifier) => {
        if (!commandIds.has(identifier)) {
          const suffix = opaqueAlphabet.slice(commandIndex, commandIndex + 26).padEnd(26, 'A')
          commandIds.set(identifier, `cmd_${suffix}`)
          commandIndex += 1
        }
        return commandIds.get(identifier)
      },
    })
    const adapter = new ManagedPiAdapter({
      transport: new RemoteRuntimeGatewayTransport(
        new ManagedPiDriver({ client, adapterVersion: '1.0.0' })
      ),
    })
    return { driver, transport, client, adapter }
  }

  test('malformed grant references never become a usable client', () => {
    expect(() => grantFixture({ grantRef: 'projects/project-0001' })).toThrow()
    expect(() => grantFixture({ grantRef: 'grant:has space' })).toThrow()
    expect(() => grantFixture({ grantRef: 'grant:/etc/passwd' })).toThrow()
    expect(() => grantFixture({ grantRef: 'grant:..' })).toThrow()
  })

  test('a well-formed but unregistered grant fails closed as missing', async () => {
    const { adapter } = grantFixture({ grantRef: 'grant:project-9999' })
    const inspection = await adapter.inspect(runtimeRequirements)
    expect(inspection.health).toBe('unavailable')
    expect(inspection.limitations).toContain('LOCAL_PROJECT_GRANT_MISSING')
  })

  test('a revoked grant reports unavailable and dispatches nothing', async () => {
    const { driver, adapter } = grantFixture()
    driver.setGrantState('grant:project-0001', 'revoked')
    const inspection = await adapter.inspect(runtimeRequirements)
    expect(inspection.health).toBe('unavailable')
    expect(inspection.limitations).toContain('LOCAL_PROJECT_GRANT_REVOKED')
  })

  test('commands bound to a foreign workspace are rejected at dispatch', async () => {
    const { adapter } = grantFixture({ transportWorkspace: workspaceB })
    await expect(adapter.start(managedPiStartCommand())).rejects.toThrow()
  })
})

function managedPiStartCommand() {
  const digest = (character) => `sha256:${character.repeat(64)}`
  return {
    attemptId: opaqueId('att'),
    idempotencyKey: 'm11-security-probe:start',
    executionPlan: {
      schemaVersion: 1,
      executionPlanId: opaqueId('pln'),
      contentDigest: digest('a'),
      profile: {
        profileId: opaqueId('prf'),
        profileVersionId: opaqueId('pfv'),
        version: 3,
        revision: 2,
        schemaVersion: 1,
        contentDigest: digest('b'),
      },
      skills: [
        {
          skillId: opaqueId('skl'),
          skillVersionId: opaqueId('skv'),
          revision: 4,
          schemaVersion: 1,
          semanticVersion: '2.1.0',
          contentDigest: digest('c'),
        },
      ],
      contextPackage: {
        contextPackageId: opaqueId('ctx'),
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
    },
  }
}

describe('M11.5 probes: secret canaries and credential purpose (STM-022/003)', () => {
  const canaries = ['probe-canary-token-0001', 'probe-canary-token-0002']

  test('canaries are found across nested sinks including error chains', () => {
    const guard = new SecretCanaryGuard(canaries)
    const leakyError = new Error('wrapper failed')
    leakyError.cause = new Error('root cause mentions probe-canary-token-0001')
    const sinks = {
      'nested-object': { deep: { list: ['safe', { value: 'see probe-canary-token-0002' }] } },
      'error-chain': leakyError,
    }
    for (const sink of Object.keys(sinks)) {
      expect(() => guard.assertSafe({ [sink]: sinks[sink] })).toThrow(`SECRET_CANARY_LEAK:${sink}`)
    }
    expect(() => guard.assertSafe({ events: ['clean'], nested: { ok: true } })).not.toThrow()
  })

  test('degenerate canary sets are rejected instead of silently weakening the guard', () => {
    expect(() => new SecretCanaryGuard([])).toThrow()
    expect(() => new SecretCanaryGuard(['short'])).toThrow()
    expect(() => new SecretCanaryGuard([canaries[0], canaries[0]])).toThrow()
  })

  test('credential scanners catch every token family in operator output', () => {
    // Sample values are assembled at runtime: this file is itself scanned by
    // scripts/scan-secrets.mjs, and the fixtures must match the scanner rules
    // when evaluated but not in the repository text.
    const samples = {
      'github-token': `ghp_${'A'.repeat(36)}`,
      'aws-access-key': `AKIA${'IOSFODNN7EXAMPLE'}`,
      'private-key': `-----BEGIN ${'PRIVATE KEY'}-----`,
      'slack-token': `xoxb-${'123456789012-abcdef'}`,
      'stripe-live-key': `sk_live_${'abcdefghijklmnop1234'}`,
      'google-api-key': `AIza${'A'.repeat(35)}`,
    }
    for (const [rule, sample] of Object.entries(samples)) {
      const findings = findCredentialLeaks('probe.log', `info: ${sample}\n`)
      expect(
        findings.some((finding) => finding.rule === rule),
        rule
      ).toBe(true)
    }
    expect(findCredentialLeaks('clean.log', 'no credentials in this output\n')).toEqual([])
  })

  test('credential envelopes reject purpose, audience, and shape confusion', () => {
    const envelope = {
      kind: 'connector',
      audience: 'github.com',
      subject: 'workspace-deploy',
      workspaceId: workspaceA,
    }
    expect(() => assertCredentialPurpose(envelope, 'provider', 'github.com')).toThrow(
      'CREDENTIAL_PURPOSE_MISMATCH'
    )
    expect(() => assertCredentialPurpose(envelope, 'connector', 'registry.npmjs.org')).toThrow(
      'CREDENTIAL_AUDIENCE_MISMATCH'
    )
    expect(() =>
      assertCredentialPurpose({ ...envelope, scope: 'write-all' }, 'connector', 'github.com')
    ).toThrow()
    expect(assertCredentialPurpose(envelope, 'connector', 'github.com')).toEqual(envelope)
  })
})

describe('M11.5 probes: HPKE relay envelopes (STM-028/029)', () => {
  const plaintext = new TextEncoder().encode('probe relay payload with no real secrets')

  async function envelopeSetup() {
    const host = await generateHostEncryptionKeyPair('host-probe-1', new Date(now))
    const encrypt = (overrides = {}) =>
      encryptRelayPayload({
        recipient: host,
        workspaceId: workspaceA,
        commandId: opaqueId('cmd'),
        payloadType: 'create_execution',
        payloadSchemaVersion: 1,
        issuedAt: now,
        expiresAt: later(60_000),
        plaintext,
        ...overrides,
      })
    return { host, encrypt }
  }

  const decryptInput = (envelope, host, overrides = {}) => ({
    envelope,
    recipient: host,
    expectedWorkspaceId: workspaceA,
    expectedHostId: 'host-probe-1',
    now: new Date(now),
    ...overrides,
  })

  test('roundtrip succeeds and wrong host, workspace, or rotation rejects', async () => {
    const { host, encrypt } = await envelopeSetup()
    const envelope = await encrypt()
    const decrypted = await decryptRelayPayload(decryptInput(envelope, host))
    expect(new TextDecoder().decode(decrypted)).toBe('probe relay payload with no real secrets')

    expect(
      decryptRelayPayload(decryptInput(envelope, host, { expectedHostId: 'host-probe-other' }))
    ).rejects.toMatchObject({ code: 'RELAY_ENVELOPE_RECIPIENT_MISMATCH' })
    expect(
      decryptRelayPayload(decryptInput(envelope, host, { expectedWorkspaceId: workspaceB }))
    ).rejects.toMatchObject({ code: 'RELAY_ENVELOPE_RECIPIENT_MISMATCH' })

    const rotated = await generateHostEncryptionKeyPair('host-probe-1', new Date(now))
    expect(decryptRelayPayload(decryptInput(envelope, rotated))).rejects.toMatchObject({
      code: 'RELAY_ENVELOPE_KEY_UNAVAILABLE',
    })
  })

  test('expired and clock-violating envelopes reject; lifetime is capped', async () => {
    const { host, encrypt } = await envelopeSetup()

    const expired = await encrypt({ issuedAt: later(-120_000), expiresAt: later(-60_000) })
    expect(decryptRelayPayload(decryptInput(expired, host))).rejects.toMatchObject({
      code: 'RELAY_ENVELOPE_EXPIRED',
    })

    const future = await encrypt({ issuedAt: later(10 * 60_000), expiresAt: later(11 * 60_000) })
    expect(decryptRelayPayload(decryptInput(future, host))).rejects.toMatchObject({
      code: 'RELAY_ENVELOPE_EXPIRED',
    })

    expect(encrypt({ expiresAt: later(MAX_RELAY_ENVELOPE_LIFETIME_MS + 1) })).rejects.toMatchObject(
      { code: 'RELAY_ENVELOPE_LIFETIME_INVALID' }
    )
    expect(encrypt({ issuedAt: later(60_000), expiresAt: now })).rejects.toMatchObject({
      code: 'RELAY_ENVELOPE_LIFETIME_INVALID',
    })
  })

  test('ciphertext and header tampering fail closed through AAD binding', async () => {
    const { host, encrypt } = await envelopeSetup()
    const envelope = await encrypt()
    const flipFirstByte = (value) => {
      const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
      bytes[0] ^= 0x01
      return Buffer.from(bytes)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '')
    }
    expect(
      decryptRelayPayload(
        decryptInput({ ...envelope, ciphertext: flipFirstByte(envelope.ciphertext) }, host)
      )
    ).rejects.toMatchObject({ code: 'RELAY_ENVELOPE_DECRYPTION_FAILED' })

    for (const headerTamper of [
      { commandId: opaqueId('cmd', 'ZABCDEF') },
      { payloadType: 'submit_input' },
      { workspaceId: workspaceB },
      { payloadSchemaVersion: 2 },
    ]) {
      expect(
        decryptRelayPayload(decryptInput({ ...envelope, ...headerTamper }, host)),
        JSON.stringify(headerTamper)
      ).rejects.toThrow(RelayEnvelopeError)
    }
  })

  test('cross-command ciphertext substitution and malformed frames reject', async () => {
    const { host, encrypt } = await envelopeSetup()
    const envelopeA = await encrypt()
    const envelopeB = await encrypt({ commandId: opaqueId('cmd', 'YABCDEF') })
    expect(
      decryptRelayPayload(decryptInput({ ...envelopeA, ciphertext: envelopeB.ciphertext }, host))
    ).rejects.toThrow(RelayEnvelopeError)

    for (const malformed of [
      { ...envelopeA, ciphertext: 'not base64!!' },
      { ...envelopeA, envelopeVersion: 2 },
      { ...envelopeA, suite: 'TLS_AES_128_GCM_SHA256' },
      { ...envelopeA, contentDigest: 'sha256:deadbeef' },
    ]) {
      expect(
        decryptRelayPayload(decryptInput(malformed, host)),
        JSON.stringify(malformed.suite ?? malformed.envelopeVersion)
      ).rejects.toThrow(RelayEnvelopeError)
    }
  })

  test('plaintext and ciphertext caps are enforced on encryption', async () => {
    const { encrypt } = await envelopeSetup()
    const oversized = new Uint8Array(MAX_RELAY_CIPHERTEXT_BYTES)
    expect(encrypt({ plaintext: oversized })).rejects.toMatchObject({
      code: 'RELAY_ENVELOPE_TOO_LARGE',
    })
  })
})

async function withScratchDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), 'm11-security-probe-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
