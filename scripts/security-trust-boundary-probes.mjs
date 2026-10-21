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
  'Relay metadata-only commands carry no authentication material',
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
    return {
      reproduced: authenticators.length === 0,
      detail: `metadata command fields = ${fields.join(', ')}; authentication fields present = ${authenticators.length}`,
    }
  }
)

probe(
  'CP190-P02',
  'A fabricated relay metadata command is accepted and its effect fires',
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
    return {
      reproduced: result.outcome === 'accepted' && effects.length === 1,
      detail: `outcome=${result.outcome}, applied effects=${effects.join(',') || 'none'}`,
    }
  }
)

probe(
  'CP190-P03',
  'The same logical relay effect repeats under a fresh command id',
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
    return {
      reproduced: effects.length === 2,
      detail: `effects applied for one target = ${effects.length}`,
    }
  }
)

probe(
  'CP190-P04',
  'The relay effect is applied before its durable idempotency receipt is written',
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
          // The durable receipt is lost, as in a crash between the effect and the receipt.
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
    return {
      reproduced: effects === 1 && receiptPersisted === false && thrown !== undefined,
      detail: `effects=${effects}, receipt persisted=${receiptPersisted}, threw=${thrown !== undefined} (a redelivery applies the effect again)`,
    }
  }
)

// ---------------------------------------------------------------------------
// Credential vault egress guard (STA-L40-17, STA-L40-18, STA-L76-03)
// ---------------------------------------------------------------------------

probe(
  'CP190-P05',
  'The credential-vault egress guard does not see a secret inside an Error carrier',
  ['STA-L40-17', 'STA-L40-18', 'STA-L76-03'],
  async () => {
    const now = '2026-10-21T00:00:00.000Z'
    const vault = new CredentialVault({
      provider: new InMemorySecretProvider(),
      now: () => now,
      decisionPoint: {
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
      },
    })
    await vault.create({
      credentialId: 'crd_01JABCDEF0123456789ABCDEFG',
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      connectorRef: 'connector:synthetic',
      provider: 'synthetic',
      secret: CANARY,
      createdAt: now,
    })
    const lease = await vault.lease({
      credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEFG',
      credentialId: 'crd_01JABCDEF0123456789ABCDEFG',
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      principalRef: 'service:tool-gateway',
      operation: 'synthetic.call',
      resourceRef: 'tool:synthetic',
      requestedAt: now,
      expiresAt: '2026-10-21T00:05:00.000Z',
      policySnapshot: {
        policyId: 'workspace-standard',
        version: 1,
        digest: `sha256:${'a'.repeat(64)}`,
      },
    })
    let escaped
    let blocked = false
    try {
      escaped = await vault.use(
        lease.capabilityRef,
        {
          workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
          operation: 'synthetic.call',
          resourceRef: 'tool:synthetic',
        },
        async (secret) => new Error(secret)
      )
    } catch (error) {
      blocked = error instanceof Error && /SECRET_EGRESS_BLOCKED/.test(error.message)
    }
    const carrierMissed = containsSecret(new Error(CANARY), CANARY) === false
    const leaked = escaped instanceof Error && escaped.message.includes(CANARY)
    return {
      reproduced: carrierMissed && leaked && blocked === false,
      detail: `containsSecret(new Error(canary))=false: ${carrierMissed}; egress blocked: ${blocked}; secret carried out of the lease: ${leaked}`,
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
    const direct = [
      'packages/acp-adapter/src/acp-driver-execution.ts',
      'packages/acp-adapter/src/process-transport.ts',
      'packages/managed-pi-adapter/src/managed-pi-driver.ts',
    ]
    const findings = []
    for (const path of direct) {
      const source = await readSource(path).catch(() => '')
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
      'packages/acp-adapter/src/acp-driver-execution.ts',
      'packages/managed-pi-adapter/src/managed-pi-driver.ts',
      'packages/managed-pi-adapter/src/process-client.ts',
    ]
    const findings = []
    for (const path of sources) {
      const source = await readSource(path).catch(() => '')
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
  'SQLite WAL sidecars are created before the database file is restricted to owner-only',
  ['STA-L76-01', 'STA-L23-03'],
  async () => {
    const source = await readSource('packages/sqlite-persistence/src/provider.ts')
    const walIndex = source.indexOf('journal_mode = WAL')
    const chmodIndex = source.indexOf('chmod(this.#path, 0o600)', walIndex)
    const sidecarChmod = /chmod\([^)]*-wal/.test(source)
    return {
      reproduced: walIndex >= 0 && chmodIndex > walIndex && !sidecarChmod,
      detail: `journal_mode=WAL at ${walIndex}, the following chmod(db) at ${chmodIndex}, sidecar chmod present = ${sidecarChmod}`,
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
