#!/usr/bin/env bun
// CP #190 independent trust-boundary probes.
//
// These probes are credential-free and synthetic. They never read a real secret,
// never contact a deployed profile, and never send production traffic. Every
// input is generated in-process (throwaway keys, temporary directories, in-memory
// fakes) so the suite can run on a developer machine or in CI without authority.
//
// Each probe demonstrates one confirmed finding from
// docs/evidence/m11-security-trust-boundary-audit-2026-10-21.md. A probe that
// still reproduces is an OPEN finding. A probe that no longer reproduces means
// the owning team changed the behaviour: the owner must convert that probe into
// a regression test inside the package they own, and this file must be updated
// in the same change so the audit record stays truthful.
//
// Usage: bun scripts/security-trust-boundary-probes.mjs
// Exit codes: 0 = every probe reproduced the recorded open finding,
//             2 = at least one probe stopped reproducing (owner fix landed),
//             1 = a probe could not run (harness problem, not a finding).
//
// F-04 re-verification, 2026-10-21: the owner fix for F-04 landed on `main` at
// 4e126a7c3e55bfb05b8bdfc390705b83f777c6d4 (#1224). Executed against that head, this suite
// reports `24 open, 2 resolved, 0 harness failures` and exits 2, and the two probes that no
// longer reproduce are CP190-P05 and CP190-P23, which are F-04's two probes. On the audited
// head 27f17bd55e0266439b5b3089163195c9e7a669be the tree is unchanged, the suite reports
// `26 open, 0 resolved, 0 harness failures` and exits 0, and the probes are left as they are:
// they are the record of the audited head, and the fix's head and its measurement are recorded
// in docs/evidence/m11-security-trust-boundary-audit-2026-10-21.md.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  InMemoryRelayMetadataCommandResultRepository,
  RelayCommandProcessor,
  RelayMetadataCommandProcessor,
  RelayMetadataCommandSchema,
  encryptRelayPayload,
  generateHostEncryptionKeyPair,
  publicEncryptionKey,
} from '../packages/remote-control-relay/src/index.ts'
import {
  CredentialVault,
  InMemorySecretProvider,
  containsSecret,
} from '@control-plane/credential-vault'
import { redactTelemetryValue } from '../packages/telemetry/src/index.ts'
import { createFilesystemCheckpoint } from '@control-plane/deployment'
import { E2bSandboxAdapter, SandboxCoordinator } from '@control-plane/sandbox'

const CANARY = 'cp190-synthetic-canary-0001'

/** @type {{ id: string, title: string, obligations: string[], run: () => Promise<{ reproduced: boolean, detail: string, harness?: boolean }> }[]} */
const probes = []

function probe(id, title, obligations, run) {
  probes.push({ id, title, obligations, run })
}

async function readSource(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

/**
 * Reads a source file that a probe depends on. A missing or empty file is a
 * harness failure, never a finding: a probe must never report "this module has
 * no grant check" because the module it named does not exist.
 */
async function readSourceStrict(relativePath) {
  const source = await readSource(relativePath).catch(() => undefined)
  if (source === undefined) throw new Error(`probe source file is missing: ${relativePath}`)
  if (source.trim().length === 0) throw new Error(`probe source file is empty: ${relativePath}`)
  return source
}

async function readJson(relativePath) {
  return JSON.parse(await readSource(relativePath))
}

// ---------------------------------------------------------------------------
// Relay / product remote-control boundary (STA-L46-09, STA-L66-01, STA-L68-02)
// ---------------------------------------------------------------------------

function metadataCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    workspaceId: 'wsp_synthetic_workspace',
    hostId: 'host_synthetic',
    commandId: 'cmd_synthetic_1',
    operation: 'approve',
    issuedAt: '2026-10-21T00:00:00.000Z',
    expiresAt: '2026-10-21T01:00:00.000Z',
    targetId: 'exe_synthetic_pending_interaction',
    ...overrides,
  }
}

probe(
  'CP190-P01',
  'The relay metadata command schema carries no authentication material of its own',
  ['STA-L46-09', 'STA-L66-01', 'STA-L68-02'],
  async () => {
    const parsed = RelayMetadataCommandSchema.safeParse(metadataCommand())
    if (!parsed.success) {
      return { reproduced: false, detail: 'metadata command schema rejected the synthetic command' }
    }
    const fields = Object.keys(parsed.data).toSorted()
    const authenticators = fields.filter((field) =>
      /signature|mac|hmac|token|credential|key|nonce|sequence|proof/i.test(field)
    )
    const documented = await readSource('docs/remote-control-relay.md')
    const delegated = documented.includes(
      'Authentication of that metadata transport remains the responsibility of the concrete relay client'
    )
    return {
      reproduced: authenticators.length === 0,
      detail: `metadata command fields = ${fields.join(', ')}; authentication fields present = ${authenticators.length}; the obligation is documented as delegated to the concrete relay client = ${delegated}`,
    }
  }
)

probe(
  'CP190-P02',
  'The relay host processor applies no authentication of its own to a metadata command',
  ['STA-L46-09', 'STA-L66-01'],
  async () => {
    const effects = []
    const processor = new RelayMetadataCommandProcessor(
      'host_synthetic',
      'wsp_synthetic_workspace',
      async (command) => {
        effects.push(command.operation)
        return { accepted: true }
      },
      new InMemoryRelayMetadataCommandResultRepository()
    )
    const result = await processor.process(metadataCommand(), new Date('2026-10-21T00:30:00.000Z'))
    const local = await readSource('apps/local-control-plane/src/composition.ts')
    const hosted = await readSource('apps/hosted-control-plane/src/composition.ts')
    const optIn =
      local.includes('readonly remoteControl?: RemoteControlHostAdapter<unknown>') &&
      hosted.includes('readonly remoteControl?: RemoteControlHostAdapter<unknown>')
    const relay = await readSource('packages/remote-control-relay/src/relay.ts')
    const fakeClientPresent = relay.includes('export class FakeOpaqueRelay')
    return {
      reproduced: result.outcome === 'accepted' && effects.length === 1,
      detail: `outcome=${result.outcome}, applied effects=${effects.join(',') || 'none'}; the processor adds no provenance check of its own. Reachability: the relay adapter is opt-in in both compositions = ${optIn}; the test fake FakeOpaqueRelay is present in the relay package = ${fakeClientPresent}, which does not by itself show it is the only client implementation. No deployed attacker-controlled ingress is claimed.`,
    }
  }
)

probe(
  'CP190-P03',
  'The relay processor offers no idempotency across command identifiers',
  ['STA-L16-01', 'STA-L68-03', 'STA-L78-01'],
  async () => {
    const effects = []
    const processor = new RelayMetadataCommandProcessor(
      'host_synthetic',
      'wsp_synthetic_workspace',
      async (command) => {
        effects.push(command.targetId)
        return { accepted: true }
      },
      new InMemoryRelayMetadataCommandResultRepository()
    )
    const now = new Date('2026-10-21T00:30:00.000Z')
    await processor.process(metadataCommand({ commandId: 'cmd_synthetic_a' }), now)
    await processor.process(metadataCommand({ commandId: 'cmd_synthetic_b' }), now)
    const adapter = await readSource('packages/remote-control-relay/src/adapter.ts')
    const injected = adapter.includes(
      'readonly metadataCommands?: RelayMetadataCommandProcessor<unknown>'
    )
    return {
      reproduced: effects.length === 2,
      detail: `effects applied for one target under two command ids = ${effects.length}; the effect callback is injected, so its own idempotency is the callback's property = ${injected}. This is not a duplicate-effect claim: create_execution is idempotent through the CommandInbox.`,
    }
  }
)

probe(
  'CP190-P04',
  'The relay effect and its idempotency receipt are two separate writes with no atomic binding',
  ['STA-L16-01', 'STA-L68-03', 'STA-L78-01'],
  async () => {
    const keyPair = await generateHostEncryptionKeyPair(
      'host_synthetic',
      new Date('2026-10-21T00:00:00.000Z')
    )
    const plaintext = new TextEncoder().encode('{"synthetic":true}')
    const envelope = await encryptRelayPayload({
      recipient: publicEncryptionKey(keyPair),
      workspaceId: 'wsp_synthetic_workspace',
      commandId: 'cmd_synthetic_content',
      payloadType: 'create_execution',
      payloadSchemaVersion: 1,
      issuedAt: '2026-10-21T00:00:00.000Z',
      expiresAt: '2026-10-21T01:00:00.000Z',
      plaintext,
    })
    let effects = 0
    let receiptPersisted = false
    const processor = new RelayCommandProcessor(
      'host_synthetic',
      'wsp_synthetic_workspace',
      () => keyPair,
      {
        get: async () => undefined,
        put: async () => {
          // The receipt write fails, as in a crash between the effect and the receipt.
          receiptPersisted = false
          throw new Error('synthetic_receipt_write_failure')
        },
      },
      async () => {
        effects += 1
        return { accepted: true }
      }
    )
    let thrown
    try {
      await processor.process(envelope, new Date('2026-10-21T00:30:00.000Z'))
    } catch (error) {
      thrown = error
    }
    const relay = await readSource('packages/remote-control-relay/src/relay.ts')
    const execution = await readSource('packages/remote-control-relay/src/execution.ts')
    const onlyInMemory =
      relay.includes('export class InMemoryRelayCommandResultRepository') &&
      relay.includes('export class InMemoryRelayMetadataCommandResultRepository') &&
      execution.includes('InMemoryRelayCommandResultRepository')
    const documented = await readSource('docs/remote-control-relay.md')
    const delegation = documented.includes(
      'the in-memory repository is a test/default seam, not restart durability'
    )
    return {
      reproduced:
        effects === 1 && receiptPersisted === false && thrown !== undefined && onlyInMemory,
      detail: `effects=${effects}, receipt persisted=${receiptPersisted}, threw=${thrown !== undefined}; the two writes are not atomic. The effect-before-receipt order is deliberate and safe: a receipt written first would record an effect that never happened. Only in-memory receipt repositories ship = ${onlyInMemory}; the durable repository is documented as a composition requirement = ${delegation}. create_execution is idempotent through the CommandInbox, so no duplicate live effect is claimed for it.`,
    }
  }
)

// ---------------------------------------------------------------------------
// Credential vault egress guard (STA-L40-17, STA-L40-18, STA-L76-03)
// ---------------------------------------------------------------------------

probe(
  'CP190-P05',
  'The credential-vault egress screen misses a returned carrier but a thrown error is sanitized',
  ['STA-L40-17', 'STA-L40-18', 'STA-L76-03'],
  async () => {
    const now = '2026-10-21T00:00:00.000Z'
    const allowDecisionPoint = {
      requests: [],
      async authorize(request) {
        this.requests.push(request)
        return {
          effect: 'allow',
          decisionId: `sha256:${'b'.repeat(64)}`,
          reasonCode: 'CEDAR_PERMIT',
          policySnapshot: request.policySnapshot,
          evaluatedAt: request.context.requestedAt,
        }
      },
    }
    const vault = new CredentialVault({
      provider: new InMemorySecretProvider(),
      now: () => now,
      decisionPoint: allowDecisionPoint,
    })
    await vault.create({
      credentialId: 'crd_01JABCDEF0123456789ABCDEFG',
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      connectorRef: 'connector:synthetic',
      provider: 'synthetic',
      secret: CANARY,
      createdAt: now,
    })
    const scope = {
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      operation: 'synthetic.call',
      resourceRef: 'tool:synthetic',
    }
    const first = await vault.lease({
      credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEFG',
      credentialId: 'crd_01JABCDEF0123456789ABCDEFG',
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
      workspaceId: scope.workspaceId,
      principalRef: 'service:tool-gateway',
      operation: scope.operation,
      resourceRef: scope.resourceRef,
      requestedAt: now,
      expiresAt: '2026-10-21T00:05:00.000Z',
      policySnapshot: {
        policyId: 'workspace-standard',
        version: 1,
        digest: `sha256:${'a'.repeat(64)}`,
      },
    })
    // Half one: a callback that RETURNS an Error carrier. The screen walks own
    // enumerable string keys, so the carrier is not inspected.
    let returned
    let blocked = false
    try {
      returned = await vault.use(first.capabilityRef, scope, async (secret) => new Error(secret))
    } catch (error) {
      blocked = error instanceof Error && /SECRET_EGRESS_BLOCKED/.test(error.message)
    }
    const carrierMissed = containsSecret(new Error(CANARY), CANARY) === false
    const carried = returned instanceof Error && returned.message.includes(CANARY)
    // Half two: a callback that THROWS. The vault converts the throw into a
    // bounded code, so the secret never leaves through the error path.
    const second = await vault.lease({
      credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEF2',
      credentialId: 'crd_01JABCDEF0123456789ABCDEFG',
      requestId: 'req_01JABCDEF0123456789ABCDEF2',
      workspaceId: scope.workspaceId,
      principalRef: 'service:tool-gateway',
      operation: scope.operation,
      resourceRef: scope.resourceRef,
      requestedAt: now,
      expiresAt: '2026-10-21T00:05:00.000Z',
      policySnapshot: {
        policyId: 'workspace-standard',
        version: 1,
        digest: `sha256:${'a'.repeat(64)}`,
      },
    })
    let thrownCode
    try {
      await vault.use(second.capabilityRef, scope, async (secret) => {
        throw new Error(secret)
      })
    } catch (error) {
      thrownCode = error instanceof Error ? error.message : String(error)
    }
    const thrownSanitized = thrownCode === 'PROVIDER_OPERATION_FAILED'
    const composition = await readSource('apps/control-api/src/cloud-composition.ts')
    const deniesWithoutDecisionPoint = composition.includes(
      'no policy decision point is composed, so leases deny'
    )
    return {
      reproduced: carrierMissed && carried && blocked === false && thrownSanitized,
      detail: `returned Error carrier not screened = ${carrierMissed && carried && blocked === false}; thrown error sanitized to PROVIDER_OPERATION_FAILED = ${thrownSanitized}; the Control API composition composes no decision point so leases deny = ${deniesWithoutDecisionPoint}. This is a bounded library callback-result contract gap: no deployed credential leakage is claimed or demonstrated.`,
    }
  }
)

probe(
  'CP190-P06',
  'Structured-log redaction misses compound credential key names',
  ['STA-L40-17', 'STA-L76-03'],
  async () => {
    const redacted = redactTelemetryValue({ sessionToken: CANARY })
    const leaked = JSON.stringify(redacted).includes(CANARY)
    return {
      reproduced: leaked,
      detail: `redactTelemetryValue({ sessionToken }) leaked the value = ${leaked}`,
    }
  }
)

// ---------------------------------------------------------------------------
// Local / private API trust boundary (STA-L08-01, STA-L46-06, STA-L46-17)
// ---------------------------------------------------------------------------

probe(
  'CP190-P07',
  'The Local private API derives workspace scope from the request body',
  ['STA-L08-01', 'STA-L46-06', 'STA-L46-17'],
  async () => {
    const source = await readSource('apps/control-api/src/auth/private-api-authentication.ts')
    const bodyDerived =
      /workspaceIds:\s*typeof workspaceId === 'string' \? \[workspaceId\] : \[\]/.test(source)
    const hosted = await readSource('apps/control-api/src/auth/service-authentication.ts')
    const claimChecked = hosted.includes('claims.workspaceIds.includes(envelope.workspaceId)')
    return {
      reproduced: bodyDerived && claimChecked,
      detail: `local authenticator copies body workspace ids = ${bodyDerived}; hosted authenticator compares signed claims = ${claimChecked}`,
    }
  }
)

// ---------------------------------------------------------------------------
// LocalProjectGrant reachability (STA-L17-01, STA-L42-09, STA-L42-10, STA-L69-02)
// ---------------------------------------------------------------------------

probe(
  'CP190-P08',
  'LocalProjectGrant discovery state is a hard-coded constant in the production path',
  ['STA-L17-01', 'STA-L42-09', 'STA-L69-02'],
  async () => {
    const source = await readSource('apps/runtime-gateway/src/runtime-inventory-ingestion.ts')
    const constant = source.includes(
      "localProjectGrant: { required: false, state: 'not_required' }"
    )
    return {
      reproduced: constant,
      detail: `runtime-inventory-ingestion.ts hard-codes the localProjectGrant state = ${constant}`,
    }
  }
)

probe(
  'CP190-P09',
  'The direct-local ACP and managed-Pi drivers never consult a project grant',
  ['STA-L17-01', 'STA-L42-09', 'STA-L69-02'],
  async () => {
    // The managed-Pi direct driver lives in the package entry module; an
    // earlier revision of this probe named a module that does not exist and
    // therefore reported a missing grant check for a missing file.
    const direct = [
      'packages/acp-adapter/src/index.ts',
      'packages/acp-adapter/src/acp-driver-execution.ts',
      'packages/managed-pi-adapter/src/index.ts',
    ]
    const findings = []
    for (const path of direct) {
      const source = await readSourceStrict(path)
      const mentionsGrant = /grantState|LocalProjectGrant|localProjectGrant/.test(source)
      findings.push(`${path}: grantChecked=${mentionsGrant}`)
    }
    return {
      reproduced: findings.every((finding) => finding.endsWith('grantChecked=false')),
      detail: findings.join('; '),
    }
  }
)

probe(
  'CP190-P10',
  'The canonical path containment a LocalProjectGrant would need does not exist',
  ['STA-L42-10', 'STA-L69-01'],
  async () => {
    const sources = [
      'packages/acp-adapter/src/index.ts',
      'packages/acp-adapter/src/acp-driver-execution.ts',
      'packages/managed-pi-adapter/src/index.ts',
      'packages/managed-pi-adapter/src/process-client.ts',
    ]
    const findings = []
    for (const path of sources) {
      const source = await readSourceStrict(path)
      findings.push(`${path}: hasRealpath=${source.includes('realpath')}`)
    }
    return {
      reproduced: findings.every((finding) => finding.endsWith('hasRealpath=false')),
      detail: findings.join('; '),
    }
  }
)

// ---------------------------------------------------------------------------
// Runtime Gateway command lifetime (STA-L61-08)
// ---------------------------------------------------------------------------

probe(
  'CP190-P11',
  'Runtime Gateway runtime commands are not bounded to the 24 h remote-command maximum',
  ['STA-L61-08'],
  async () => {
    const runtime = await readSource('apps/runtime-gateway/src/runtime-command-delivery.ts')
    const context = await readSource('apps/runtime-gateway/src/context-command-delivery.ts')
    const contextBounded = context.includes('EXPIRY_TOO_LONG')
    const runtimeBounded = runtime.includes('EXPIRY_TOO_LONG')
    return {
      reproduced: contextBounded && !runtimeBounded,
      detail: `context family bounded = ${contextBounded}; runtime family bounded = ${runtimeBounded}`,
    }
  }
)

// ---------------------------------------------------------------------------
// Local persistence and backups (STA-L76-01, STA-L76-03)
// ---------------------------------------------------------------------------

probe(
  'CP190-P12',
  'A Local filesystem checkpoint copies the private-file secrets directory in cleartext',
  ['STA-L76-01', 'STA-L76-03'],
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cp190-checkpoint-'))
    try {
      const source = join(root, 'data')
      const destination = join(root, 'checkpoint')
      await mkdir(join(source, 'secrets'), { recursive: true, mode: 0o700 })
      await writeFile(join(source, 'secrets', 'provider-key'), `${CANARY}\n`, { mode: 0o600 })
      await writeFile(join(source, 'control-plane.sqlite'), 'sqlite-placeholder', { mode: 0o600 })
      await createFilesystemCheckpoint({
        sourceDirectory: source,
        destinationDirectory: destination,
        profile: 'local',
      })
      const copied = await readFile(join(destination, 'secrets', 'provider-key'), 'utf8')
      return {
        reproduced: copied.includes(CANARY),
        detail: `checkpoint contains the cleartext provider secret = ${copied.includes(CANARY)}`,
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

probe(
  'CP190-P13',
  'SQLite WAL sidecars keep the pre-restriction file mode, inside an owner-only parent directory',
  ['STA-L76-01', 'STA-L23-03'],
  async () => {
    const source = await readSource('packages/sqlite-persistence/src/provider.ts')
    const parentMode = source.indexOf('await chmod(dirname(this.#path), 0o700)')
    const opened = source.indexOf('new DatabaseSync(this.#path)')
    const walIndex = source.indexOf('journal_mode = WAL')
    const chmodIndex = source.indexOf('chmod(this.#path, 0o600)', walIndex)
    const sidecarChmod = /chmod\([^)]*-wal/.test(source)
    // The parent directory is restricted before any file exists, so another UID
    // cannot traverse into it. The sidecar mode is a defense-in-depth gap, not
    // a demonstrated cross-UID read.
    const parentRestrictedFirst = parentMode >= 0 && parentMode < opened && parentMode < walIndex
    return {
      reproduced:
        parentRestrictedFirst && walIndex > opened && chmodIndex > walIndex && !sidecarChmod,
      detail: `parent chmod 0700 at ${parentMode} precedes the database at ${opened} and the WAL pragma at ${walIndex}; the main file is restricted to 0600 at ${chmodIndex}; a sidecar chmod exists = ${sidecarChmod}. Another UID cannot traverse the 0700 parent, so this is defense in depth and no cross-UID read is claimed.`,
    }
  }
)

// ---------------------------------------------------------------------------
// Portable export / import (STA-L08-01, STA-L76-03)
// ---------------------------------------------------------------------------

probe(
  'CP190-P14',
  'The portable import path scans with an empty sensitive-value list',
  ['STA-L76-03'],
  async () => {
    const source = await readSource('packages/profile-portability/src/migration.ts')
    const importScan = source.includes('assertSafeExport(manifest, [])')
    const exportScan = /assertSafeExport\(manifest, options\.sensitiveValues \?\? \[\]\)/.test(
      source
    )
    return {
      reproduced: importScan && exportScan,
      detail: `import uses an empty sensitive list = ${importScan}; export honours the caller list = ${exportScan}`,
    }
  }
)

probe(
  'CP190-P15',
  'Portable export secret references carry no workspace scope',
  ['STA-L08-01', 'STA-L76-03'],
  async () => {
    const source = await readSource('packages/profile-portability/src/manifest.ts')
    const start = source.indexOf('PortableSecretReferenceSchema')
    const schema = source.slice(start, start + 700)
    const scoped = /workspaceId/.test(schema)
    return {
      reproduced: !scoped,
      detail: `PortableSecretReferenceSchema declares workspaceId = ${scoped}`,
    }
  }
)

// ---------------------------------------------------------------------------
// Sandbox (STA-L46-17, STA-L77-01, STA-L83-02)
// ---------------------------------------------------------------------------

probe(
  'CP190-P16',
  'Sandbox credential bindings are injected after the ambient-credential denial runs',
  ['STA-L46-17', 'STA-L77-01'],
  async () => {
    const sandboxId = 'sbx_01JABCDEF0123456789ABCDEFG'
    const provider = {
      providerRef: 'synthetic',
      observed: undefined,
      create: async (request) => ({
        id: sandboxId,
        createdAt: '2026-10-21T00:00:00.000Z',
        expiresAt: '2026-10-21T01:00:00.000Z',
        metadata: {
          workspaceId: request.metadata.workspaceId,
          executionId: request.metadata.executionId,
          attemptId: request.metadata.attemptId,
        },
      }),
      execute: async (_sandboxId, request) => {
        provider.observed = request
        return {
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          timedOut: false,
          durationMs: 1,
          truncated: false,
        }
      },
      upload: async () => {},
      download: async () => new Uint8Array(),
      status: async () => ({ sandboxId, state: 'ready' }),
      destroy: async () => {},
      list: async () => [],
    }
    const adapter = new E2bSandboxAdapter({
      client: provider,
      resolveCredential: async () => CANARY,
    })
    const coordinator = new SandboxCoordinator({
      provider: adapter,
      promoter: {
        promote: async () => ({
          artifactId: 'art_synthetic',
          locator: 'synthetic',
          digest: `sha256:${'0'.repeat(64)}`,
          sizeBytes: 0,
        }),
      },
      now: () => '2026-10-21T00:00:00.000Z',
    })
    const handle = await coordinator.create({
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      policy: {
        template: 'base',
        timeoutMs: 60_000,
        limits: { cpuCount: 1, memoryMb: 256, storageMb: 128, outputBytes: 4096 },
        network: { mode: 'deny_all' },
      },
    })
    let denied = false
    let failure
    try {
      await coordinator.execute({
        sandboxId: handle.sandboxId,
        command: ['sh', '-c', 'env'],
        environment: {},
        credentialBindings: [
          { leaseId: 'crl_01JABCDEF0123456789ABCDEFG', environmentName: 'AWS_SESSION' },
        ],
        timeoutMs: 5_000,
      })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      denied = failure.includes('POLICY_DENIED')
    }
    const injected = JSON.stringify(provider.observed?.environment ?? {}).includes(CANARY)
    return {
      reproduced: denied === false && injected,
      detail: `policy denied = ${denied}; failure = ${failure ?? 'none'}; raw credential reached the provider environment = ${injected}`,
    }
  }
)

probe(
  'CP190-P17',
  'The sandbox metadata-service denial list is incomplete',
  ['STA-L77-01'],
  async () => {
    const source = await readSource('packages/sandbox/src/index.ts')
    const start = source.indexOf('function isMetadataHost')
    const body = source.slice(start, start + 400)
    const absent = ['169.254.170.2', 'fd00:ec2::254', '100.100.100.200', '169.254.169.253'].filter(
      (host) => !body.includes(host)
    )
    return {
      reproduced: absent.length > 0,
      detail: `known metadata endpoints absent from the deny list = ${absent.join(', ')}`,
    }
  }
)

probe(
  'CP190-P18',
  'The sandbox package is not composed into any application or runtime package',
  ['STA-L77-01', 'STA-L83-02'],
  async () => {
    const consumers = []
    for (const root of ['apps', 'packages']) {
      const entries = await readdir(new URL(`../${root}/`, import.meta.url), {
        withFileTypes: true,
      })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const manifestPath = `${root}/${entry.name}/package.json`
        const manifest = await readJson(manifestPath).catch(() => undefined)
        if (!manifest) continue
        const dependencies = {
          ...manifest.dependencies,
          ...manifest.devDependencies,
        }
        if (dependencies['@control-plane/sandbox'] !== undefined) consumers.push(manifestPath)
      }
    }
    return {
      reproduced: consumers.length === 0,
      detail: `workspace packages depending on @control-plane/sandbox = ${consumers.length}`,
    }
  }
)

// ---------------------------------------------------------------------------
// Managed cloud / abuse boundaries (STA-L40-09, STA-L54-11, STA-L57-01)
// ---------------------------------------------------------------------------

probe(
  'CP190-P19',
  'The public control API has no HTTP request rate limit',
  ['STA-L54-11', 'STA-L57-01'],
  async () => {
    const manifest = await readJson('apps/control-api/package.json')
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
    const rateLimit = Object.keys(dependencies).some((name) => /rate-limit/i.test(name))
    const source = await readSource('apps/control-api/src/application.ts')
    const configured = /rateLimit|rate_limit/.test(source)
    return {
      reproduced: rateLimit === false && configured === false,
      detail: `rate-limit dependency = ${rateLimit}; adapter rate-limit configuration = ${configured}`,
    }
  }
)

probe(
  'CP190-P20',
  'The Restate ingress submission carries no request credential',
  ['STA-L40-09', 'STA-L24-01'],
  async () => {
    const source = await readSource(
      'apps/control-api/src/executions/execution-acceptance.service.ts'
    )
    const start = source.indexOf('const response = await this.#fetch(')
    const block = start >= 0 ? source.slice(start, start + 900) : ''
    const carriesCredential = /authorization|x-restate|bearer|token/i.test(block)
    return {
      reproduced: carriesCredential === false,
      detail: `restate ingress POST carries an authorization header = ${carriesCredential}`,
    }
  }
)

// ---------------------------------------------------------------------------
// Reachability probes. These are static: they read composed source and prove
// where a control is or is not wired, without executing a product path.
// ---------------------------------------------------------------------------

probe(
  'CP190-P21',
  'No file under apps/ or packages/ outside the relay package builds the relay host adapter or the metadata processor, and no metadata effect implementation ships',
  ['STA-L46-09', 'STA-L52-01'],
  async () => {
    // Recursive static scan. It covers every TypeScript or JavaScript source file under
    // apps/ and packages/ except the relay package itself (which defines these constructs),
    // test files and declaration files. It proves nothing about code outside those paths,
    // generated code or code loaded at run time.
    const markers = [
      'new RelayMetadataCommandProcessor',
      'new RemoteControlHostAdapter',
      'createRelayExecutionMetadataCommandProcessor(',
    ]
    const skippedDirectories = new Set(['node_modules', 'dist', 'coverage', '.turbo'])
    const sourcePattern = /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/
    const clientNames = ['OutboundOpaqueRelayClient', 'FakeOpaqueRelay']
    const hits = []
    const clientReferences = []
    let scanned = 0
    async function scan(directory) {
      const entries = await readdir(new URL(`../${directory}/`, import.meta.url), {
        withFileTypes: true,
      })
      for (const entry of entries) {
        const path = `${directory}/${entry.name}`
        if (entry.isDirectory()) {
          if (skippedDirectories.has(entry.name) || path === 'packages/remote-control-relay')
            continue
          await scan(path)
          continue
        }
        if (!entry.isFile() || !sourcePattern.test(entry.name)) continue
        if (entry.name.endsWith('.d.ts') || /\.test\./.test(entry.name)) continue
        const text = await readSourceStrict(path)
        scanned += 1
        for (const marker of markers) {
          if (text.includes(marker)) hits.push(`${path}: ${marker}`)
        }
        for (const name of clientNames) {
          if (text.includes(name)) clientReferences.push(`${path}: ${name}`)
        }
      }
    }
    await scan('apps')
    await scan('packages')
    if (scanned === 0) {
      return { reproduced: false, harness: true, detail: 'the scan found no source files' }
    }
    const relay = await readSource('packages/remote-control-relay/src/relay.ts')
    const adapter = await readSource('packages/remote-control-relay/src/adapter.ts')
    const fakePresent = relay.includes('export class FakeOpaqueRelay')
    const injectedEffect = adapter.includes(
      'readonly metadataCommands?: RelayMetadataCommandProcessor<unknown>'
    )
    const injectedAccept = relay.includes(
      'readonly accept: (command: RelayMetadataCommand) => Promise<Result>'
    )
    return {
      reproduced:
        hits.length === 0 &&
        clientReferences.length === 0 &&
        fakePresent &&
        injectedEffect &&
        injectedAccept,
      detail: `source files scanned under apps/ and packages/ (excluding packages/remote-control-relay, tests and declarations) = ${scanned}; constructions of the relay adapter or metadata processor, or calls to the execution metadata-processor factory, found there = ${hits.length}; the test fake FakeOpaqueRelay is present in the relay package = ${fakePresent}; scanned files outside the relay package that name OutboundOpaqueRelayClient or FakeOpaqueRelay = ${clientReferences.length}; the metadata processor is injected = ${injectedEffect}; the metadata effect callback is injected = ${injectedAccept}. No shipped approve, deny or cancel effect was found, so no deployed unauthenticated approval path is claimed. The client checks are textual: they show that the fake is present and that no scanned file names the client interface or the fake, and they cannot prove that no other, structurally conforming client exists. The scan does not cover code outside apps/ and packages/, generated code or run-time loading.`,
    }
  }
)

probe(
  'CP190-P22',
  'The relay create_execution request carries the caller idempotency key and submit_input carries none',
  ['STA-L16-01', 'STA-L68-03'],
  async () => {
    const contracts = await readSource('packages/contracts/src/control-api.ts')
    const contextSchema = contracts.slice(
      contracts.indexOf('CommandContextSchema'),
      contracts.indexOf('CommandContextSchema') + 900
    )
    const carriesKey = /idempotencyKey/.test(contextSchema)
    const acceptance = contracts.slice(
      contracts.indexOf('ExecutionAcceptanceRequestSchema'),
      contracts.indexOf('ExecutionAcceptanceRequestSchema') + 200
    )
    const extendsContext = /CommandContextSchema\.extend/.test(acceptance)
    const execution = await readSource('packages/remote-control-relay/src/execution.ts')
    const submit = execution.slice(
      execution.indexOf('RelaySubmitInputRequestSchema'),
      execution.indexOf('RelaySubmitInputRequestSchema') + 600
    )
    const submitHasKey = /idempotencyKey/.test(submit)
    const inbox = await readSource('packages/domain/src/command-inbox.ts')
    const inboxKey = /idempotencyKey/.test(inbox)
    return {
      reproduced: carriesKey && extendsContext && submitHasKey === false && inboxKey,
      detail: `the acceptance request extends the context schema that carries idempotencyKey = ${carriesKey && extendsContext}; the relay submit_input schema carries an idempotency key = ${submitHasKey}; the CommandInbox binds an idempotency key = ${inboxKey}. create_execution is therefore idempotent in the CommandInbox, and the relay receipt adds no idempotency beyond the command id.`,
    }
  }
)

probe(
  'CP190-P23',
  'The composed model-selection path normalizes the leased callback result and rejects a non-plain carrier',
  ['STA-L40-17', 'STA-L40-18'],
  async () => {
    const service = await readSource('packages/model-gateway/src/selection-service.ts')
    const normalizer = service.slice(
      service.indexOf('function safeCredentialResult'),
      service.indexOf('function safeCredentialResult') + 2200
    )
    const rejectsPrototype =
      normalizer.includes('Object.getPrototypeOf(input) !== Object.prototype') &&
      normalizer.includes('Object.getPrototypeOf(input) !== null')
    const rejectsSymbols = normalizer.includes('Object.getOwnPropertySymbols(input).length')
    const usedOnTheLeasedPath = service.includes(
      'return safeCredentialResult(await operation(secret))'
    )
    const vault = await readSource('packages/credential-vault/src/vault.ts')
    const screen = vault.slice(vault.indexOf('export function containsSecret'))
    const ownEnumerableOnly = screen.includes('Object.entries(value).some(')
    const broker = await readSource('packages/credential-vault/src/tool-broker.ts')
    const rawResult = broker.includes('return this.#vault.use(')
    return {
      reproduced:
        rejectsPrototype && rejectsSymbols && usedOnTheLeasedPath && ownEnumerableOnly && rawResult,
      detail: `the model-selection leased path normalizes the result = ${usedOnTheLeasedPath}; the normalizer rejects a non-plain prototype = ${rejectsPrototype}; it rejects symbol keys = ${rejectsSymbols}. The vault screen itself is an own-enumerable-key traversal = ${ownEnumerableOnly}, and the credential broker returns the raw callback result = ${rawResult}. The composed path is protected; only the uncomposed raw-result callers can carry a non-plain container.`,
    }
  }
)

probe(
  'CP190-P24',
  'The managed-Pi direct driver checks no grant and its spawn policy leaves the working directory unconstrained',
  ['STA-L17-01', 'STA-L42-09', 'STA-L42-10'],
  async () => {
    const driver = await readSource('packages/managed-pi-adapter/src/index.ts')
    const driverStart = driver.slice(
      driver.indexOf('export class ManagedPiDriver'),
      driver.indexOf('export class ManagedPiDriver') + 6000
    )
    const checksGrant = /grantState|LocalProjectGrant|localProjectGrant/.test(driverStart)
    const local = await readSource('apps/local-control-plane/src/index.ts')
    const policy = local.slice(
      local.indexOf('spawnPolicy: { allowedExecutables: [executablePath] }') - 200,
      local.indexOf('spawnPolicy: { allowedExecutables: [executablePath] }') + 200
    )
    const workingDirectories = /allowedWorkingDirectories/.test(policy)
    const runtime = await readSource('packages/deployment/src/process-runtime.ts')
    const optional = runtime.includes(
      'Absent constraints leave the corresponding dimension unconstrained'
    )
    const acp = await readSource('apps/local-control-plane/src/installed-acp-runtime.ts')
    const acpCwd =
      acp.includes('cwd: options.cwd') && acp.includes('allowedWorkingDirectories: [options.cwd]')
    return {
      reproduced: checksGrant === false && workingDirectories === false && optional && acpCwd,
      detail: `the managed-Pi direct driver consults a grant = ${checksGrant}; its spawn policy names an allowed working directory = ${workingDirectories}; the policy documents absent dimensions as unconstrained = ${optional}; the ACP runtime runs the child in the operator-configured cwd and mirrors it into the allowlist = ${acpCwd}. The direct-local working directory is bounded by operator configuration, not by a grant.`,
    }
  }
)

probe(
  'CP190-P25',
  'The SQLite provider creates an owner-only parent, while the pi-durable adapter creates its own directory without one',
  ['STA-L76-01', 'STA-L23-03'],
  async () => {
    const provider = await readSource('packages/sqlite-persistence/src/provider.ts')
    const parentMode = provider.indexOf('await chmod(dirname(this.#path), 0o700)')
    const opened = provider.indexOf('new DatabaseSync(this.#path)')
    const wal = provider.indexOf('journal_mode = WAL')
    const providerOwnerOnly = parentMode >= 0 && parentMode < opened && parentMode < wal
    const journal = await readSource('packages/pi-durable-adapter/src/journal.ts')
    const journalDir = journal.slice(
      journal.indexOf('constructor(path: string)'),
      journal.indexOf('constructor(path: string)') + 400
    )
    const journalMode = /mkdirSync\(dirname\(path\), \{ recursive: true \}\)/.test(journalDir)
    const journalFileMode = /chmod\(/.test(journalDir)
    const lease = await readSource('packages/pi-durable-adapter/src/lease.ts')
    const leaseMode = /mkdirSync\(directory, \{ recursive: true \}\)/.test(lease)
    return {
      reproduced: providerOwnerOnly && journalMode && journalFileMode === false && leaseMode,
      detail: `the provider creates and restricts its parent to 0700 before the database and WAL exist = ${providerOwnerOnly}; the pi-durable journal creates its own directory without a mode = ${journalMode}; it never restricts the database file = ${journalFileMode}; the session lease creates its directory without a mode = ${leaseMode}. The provider path has no traversal path; the adapter-owned directory is the conditional one, because its protection is inherited from an ancestor the composition happens to create owner-only.`,
    }
  }
)

// The obligations are the ones the same two properties already carry elsewhere in this file:
// the metadata command schema's authentication obligation (CP190-P01) and the metadata command
// idempotency obligation (CP190-P22). The two atoms this probe previously cited, STA-L01-01 and
// STA-L02-01, do not exist in the cited inventory: its lowest clause is STA-L08-01, so they
// could not be traced to a requirement.
probe(
  'CP190-P26',
  'The relay document claims an authenticated metadata command schema that binds an idempotency key, and the schema has neither field',
  ['STA-L46-09', 'STA-L66-01', 'STA-L68-02', 'STA-L16-01', 'STA-L68-03'],
  async () => {
    const schema = await readSource('packages/remote-control-relay/src/protocol.ts')
    const start = schema.indexOf('export const RelayMetadataCommandSchema')
    const body = schema.slice(start, start + 900)
    const hasAuthentication = /auth|signature|credential|principal/i.test(body)
    const hasIdempotencyKey = /idempotency/i.test(body)
    const document = await readSource('docs/remote-control-relay.md')
    const claimsAuthenticated = /separate strict, authenticated command schema/.test(document)
    const claimsIdempotency = /bind each idempotency key to the exact command body/.test(document)
    return {
      reproduced:
        claimsAuthenticated && claimsIdempotency && !hasAuthentication && !hasIdempotencyKey,
      detail: `the document claims a separate strict, authenticated metadata command schema = ${claimsAuthenticated}; it claims each idempotency key is bound to the exact command body = ${claimsIdempotency}; the strict RelayMetadataCommandSchema carries an authentication field = ${hasAuthentication}; it carries an idempotency key field = ${hasIdempotencyKey}. The documented trust properties are not in the contract, so the schema cannot be the enforcement point the document describes.`,
    }
  }
)

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const results = []
let harnessFailures = 0
for (const entry of probes) {
  let outcome
  try {
    outcome = await entry.run()
  } catch (error) {
    outcome = {
      reproduced: false,
      detail: `probe could not run: ${error instanceof Error ? error.message : String(error)}`,
      harness: true,
    }
  }
  if (outcome.harness) harnessFailures += 1
  results.push({ ...entry, ...outcome })
}

const width = Math.max(...results.map((entry) => entry.id.length))
for (const entry of results) {
  const status = entry.harness ? 'HARNESS' : entry.reproduced ? 'OPEN' : 'RESOLVED'
  process.stdout.write(`${entry.id.padEnd(width)}  ${status.padEnd(8)}  ${entry.detail}\n`)
  process.stdout.write(
    `${' '.repeat(width)}          obligations: ${entry.obligations.join(', ')}\n`
  )
}

const open = results.filter((entry) => entry.reproduced).length
const resolved = results.filter((entry) => !entry.reproduced && !entry.harness).length
process.stdout.write(
  `\nCP #190 trust-boundary probes: ${open} open, ${resolved} resolved, ${harnessFailures} harness failures.\n`
)
process.stdout.write(
  'Every probe used synthetic in-process inputs; no secret was read and no traffic was sent.\n'
)

if (harnessFailures > 0) process.exit(1)
if (resolved > 0) {
  process.stdout.write(
    'At least one recorded finding no longer reproduces. Convert that probe into an owner regression test and update this file.\n'
  )
  process.exit(2)
}
process.exit(0)
