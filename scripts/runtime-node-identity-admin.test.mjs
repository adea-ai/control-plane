import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  runRuntimeNodeIdentityAdmin,
  runtimeNodeIdentityAdminDiagnostic,
  writeCredentialAtomically,
} from './runtime-node-identity-admin.mjs'

const FIXED_NOW = new Date('2026-09-28T12:00:00.000Z')
const NODE_ID = 'rnr_01JABCDEF0123456789ABCDEFG'
const WORKSPACE_ID = 'wsp_01JABCDEF0123456789ABCDEFG'
const KEY_ID = 'rgk_test_device_0001'
const ISSUER_KEY_ID = 'operator-issuer-v1'
const DATABASE_URL =
  'postgresql://migration:private@db.example.test:5433/control_plane?sslmode=require'

let temporaryDirectory

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'runtime-node-admin-test-'))
})

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('runtime node identity admin', () => {
  test.each([
    ['host', '--host', 'wrong.example.test'],
    ['port', '--port', '5432'],
    ['database', '--database', 'wrong_database'],
  ])('rejects a migration target mismatch for %s before connecting', async (_, option, value) => {
    const harness = createHarness()
    const args = registerArguments('/not-read.pem')
    args[args.indexOf(option) + 1] = value

    await expect(runAdmin(args, harness)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(harness.connectCount).toBe(0)
  })

  test('requires the exact confirmation for every mutation before loading credentials', async () => {
    const commands = [
      [
        'register-key',
        '--key-id',
        KEY_ID,
        '--node-id',
        NODE_ID,
        '--workspace-id',
        WORKSPACE_ID,
        '--public-key',
        '/key.pem',
      ],
      [
        'issue',
        '--key-id',
        KEY_ID,
        '--node-id',
        NODE_ID,
        '--workspace-id',
        WORKSPACE_ID,
        '--issuer',
        'https://identity.example.test',
        '--audience',
        'control-plane-gateway',
        '--channel-generation',
        '1',
        '--ttl-seconds',
        '300',
        '--issuer-key-id',
        ISSUER_KEY_ID,
        '--issuer-private-key',
        '/issuer.pem',
        '--output',
        '/credential',
      ],
      ['revoke-credential', '--credential-id', 'rgc_test_credential_0001'],
      ['retire-key', '--key-id', KEY_ID],
    ]
    for (const commandArgs of commands) {
      const harness = createHarness()
      const args = [
        commandArgs[0],
        ...commonArguments(commandArgs[0]),
        ...commandArgs.slice(1),
        '--confirm',
        'incorrect',
      ]
      await expect(runAdmin(args, harness)).rejects.toMatchObject({
        code: 'CONFIRMATION_REQUIRED',
      })
      expect(harness.credentialLoadCount).toBe(0)
      expect(harness.connectCount).toBe(0)
    }
  })

  test('keeps unexpected database errors behind a stable sanitized diagnostic', () => {
    expect(
      runtimeNodeIdentityAdminDiagnostic(
        new Error('postgresql://migration:secret@db.example.test/control_plane')
      )
    ).toBe('RUNTIME_NODE_IDENTITY_ADMIN_OPERATION_FAILED')
  })

  test('loads the production package API without connecting when migration credentials are absent', async () => {
    await expect(
      runRuntimeNodeIdentityAdmin({
        argv: registerArguments('/not-read.pem'),
        env: {},
      })
    ).rejects.toMatchObject({ code: 'MIGRATION_CREDENTIALS_UNAVAILABLE' })
  })

  test('registers only an Ed25519 SPKI key and derives the gateway thumbprint', async () => {
    const nodeKey = generateKeyPairSync('ed25519')
    const publicKeyPem = nodeKey.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const publicKeyPath = join(temporaryDirectory, 'node-public.pem')
    await writeFile(publicKeyPath, publicKeyPem, { mode: 0o600 })
    const harness = createHarness()

    const result = await runAdmin(registerArguments(publicKeyPath), harness)

    const expectedThumbprint = thumbprint(nodeKey.publicKey)
    expect(result).toEqual({ status: 'registered', keyId: KEY_ID })
    expect(harness.repository.registered).toEqual({
      keyId: KEY_ID,
      nodeId: NODE_ID,
      workspaceId: WORKSPACE_ID,
      publicKeyPem,
      thumbprint: expectedThumbprint,
      status: 'active',
    })
    expect(harness.closeCount).toBe(1)
  })

  test('rejects symlinked public keys without connecting', async () => {
    const nodeKey = generateKeyPairSync('ed25519')
    const actualPath = join(temporaryDirectory, 'actual-public.pem')
    const symlinkPath = join(temporaryDirectory, 'linked-public.pem')
    await writeFile(actualPath, nodeKey.publicKey.export({ format: 'pem', type: 'spki' }))
    await symlink(actualPath, symlinkPath)
    const harness = createHarness()

    await expect(runAdmin(registerArguments(symlinkPath), harness)).rejects.toMatchObject({
      code: 'PUBLIC_KEY_FILE_INVALID',
    })
    expect(harness.connectCount).toBe(0)
  })

  test('rejects private PEM supplied as a node verification key', async () => {
    const key = generateKeyPairSync('ed25519')
    const privatePath = join(temporaryDirectory, 'private.pem')
    await writeFile(privatePath, key.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    })
    const harness = createHarness()

    await expect(runAdmin(registerArguments(privatePath), harness)).rejects.toMatchObject({
      code: 'PUBLIC_KEY_FILE_INVALID',
    })
    expect(harness.connectCount).toBe(0)
  })

  test('rejects a non-Ed25519 issuer private key', async () => {
    const issuer = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privatePath = join(temporaryDirectory, 'issuer-rsa.pem')
    await writeFile(privatePath, issuer.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    })
    await chmod(privatePath, 0o600)
    const harness = createHarness()

    await expect(
      runAdmin(issueArguments(privatePath, join(temporaryDirectory, 'unused.rngc')), harness)
    ).rejects.toMatchObject({ code: 'ISSUER_KEY_TYPE_INVALID' })
    expect(harness.connectCount).toBe(0)
  })

  test('rejects symlinked and group/world-readable issuer private key files', async () => {
    const issuer = generateKeyPairSync('ed25519')
    const pem = issuer.privateKey.export({ format: 'pem', type: 'pkcs8' })
    const realPath = join(temporaryDirectory, 'issuer-real.pem')
    const linkedPath = join(temporaryDirectory, 'issuer-linked.pem')
    const readablePath = join(temporaryDirectory, 'issuer-readable.pem')
    await writeFile(realPath, pem, { mode: 0o600 })
    await symlink(realPath, linkedPath)
    await writeFile(readablePath, pem, { mode: 0o644 })
    await chmod(readablePath, 0o644)

    for (const path of [linkedPath, readablePath]) {
      const harness = createHarness()
      await expect(
        runAdmin(issueArguments(path, join(temporaryDirectory, 'unused.rngc')), harness)
      ).rejects.toMatchObject({
        code: 'ISSUER_KEY_FILE_INVALID',
      })
      expect(harness.connectCount).toBe(0)
    }
  })

  test('signs compatible RNGC claims, persists metadata only, and publishes mode 0600 without overwrite', async () => {
    const device = generateKeyPairSync('ed25519')
    const issuer = generateKeyPairSync('ed25519')
    const devicePem = device.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const issuerPrivatePath = join(temporaryDirectory, 'issuer-private.pem')
    const outputPath = join(temporaryDirectory, 'one-time-credential.rngc')
    await writeFile(issuerPrivatePath, issuer.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    })
    await chmod(issuerPrivatePath, 0o600)
    const harness = createHarness({
      verificationKey: {
        keyId: KEY_ID,
        nodeId: NODE_ID,
        workspaceId: WORKSPACE_ID,
        publicKeyPem: devicePem,
        thumbprint: thumbprint(device.publicKey),
        status: 'active',
      },
    })

    const result = await runAdmin(issueArguments(issuerPrivatePath, outputPath), harness)

    const token = await readFile(outputPath, 'utf8')
    const stats = await lstat(outputPath)
    const [headerPart, claimsPart, signaturePart] = token.split('.')
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))
    const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'))
    expect(header).toEqual({ alg: 'EdDSA', typ: 'RNGC', kid: ISSUER_KEY_ID })
    expect(
      verify(
        null,
        Buffer.from(`${headerPart}.${claimsPart}`),
        issuer.publicKey,
        Buffer.from(signaturePart, 'base64url')
      )
    ).toBe(true)
    expect(claims).toMatchObject({
      schemaVersion: 1,
      credentialKind: 'runtime_node',
      issuer: 'https://identity.example.test/runtime-nodes',
      audience: 'control-plane-runtime-gateway',
      nodeId: NODE_ID,
      workspaceId: WORKSPACE_ID,
      keyId: KEY_ID,
      proofKeyThumbprint: thumbprint(device.publicKey),
      revocationVersion: 1,
      channelGeneration: 7,
      issuedAt: '2026-09-28T12:00:00.000Z',
      expiresAt: '2026-09-28T12:05:00.000Z',
    })
    expect(result).toEqual({ status: 'issued', credentialId: claims.credentialId })
    expect(harness.repository.issued).toEqual({
      credentialId: claims.credentialId,
      nodeId: NODE_ID,
      workspaceId: WORKSPACE_ID,
      keyId: KEY_ID,
      claims,
      revocationVersion: 1,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      revokedAt: null,
      consumedAt: null,
    })
    expect(Object.keys(harness.repository.issued).toSorted()).toEqual(
      [
        'claims',
        'consumedAt',
        'credentialId',
        'expiresAt',
        'issuedAt',
        'keyId',
        'nodeId',
        'revocationVersion',
        'revokedAt',
        'workspaceId',
      ].toSorted()
    )
    expect(JSON.stringify(harness.repository.issued)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain(token)
    expect(stats.mode & 0o777).toBe(0o600)

    await expect(writeCredentialAtomically(outputPath, 'replacement-token')).rejects.toMatchObject({
      code: 'OUTPUT_ALREADY_EXISTS',
    })
    expect(await readFile(outputPath, 'utf8')).toBe(token)
  })

  test('rejects an inactive key and an exact node/workspace scope mismatch', async () => {
    const device = generateKeyPairSync('ed25519')
    const issuer = generateKeyPairSync('ed25519')
    const issuerPath = join(temporaryDirectory, 'issuer.pem')
    await writeFile(issuerPath, issuer.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    })
    await chmod(issuerPath, 0o600)
    const activeRecord = {
      keyId: KEY_ID,
      nodeId: NODE_ID,
      workspaceId: WORKSPACE_ID,
      publicKeyPem: device.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      thumbprint: thumbprint(device.publicKey),
      status: 'active',
    }

    const inactiveHarness = createHarness({
      verificationKey: { ...activeRecord, status: 'retired' },
    })
    await expect(
      runAdmin(
        issueArguments(issuerPath, join(temporaryDirectory, 'inactive.rngc')),
        inactiveHarness
      )
    ).rejects.toMatchObject({
      code: 'KEY_NOT_ACTIVE',
    })
    expect(inactiveHarness.repository.issued).toBeUndefined()

    const scopeHarness = createHarness({
      verificationKey: { ...activeRecord, workspaceId: 'wsp_01JBCDEFG0123456789ABCDEFG' },
    })
    await expect(
      runAdmin(issueArguments(issuerPath, join(temporaryDirectory, 'scope.rngc')), scopeHarness)
    ).rejects.toMatchObject({
      code: 'SCOPE_MISMATCH',
    })
    expect(scopeHarness.repository.issued).toBeUndefined()
  })

  test('validates HTTPS issuer, positive channel generation, and expiry at most 10 minutes', async () => {
    const issuer = generateKeyPairSync('ed25519')
    const issuerPath = join(temporaryDirectory, 'issuer.pem')
    await writeFile(issuerPath, issuer.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    })
    await chmod(issuerPath, 0o600)

    for (const [option, value, expectedCode] of [
      ['--issuer', 'http://identity.example.test', 'INVALID_ISSUER'],
      ['--channel-generation', '0', 'INVALID_CHANNEL_GENERATION'],
      ['--ttl-seconds', '601', 'INVALID_EXPIRY'],
    ]) {
      const harness = createHarness()
      const args = issueArguments(issuerPath, join(temporaryDirectory, `${option.slice(2)}.rngc`))
      args[args.indexOf(option) + 1] = value
      await expect(runAdmin(args, harness)).rejects.toMatchObject({ code: expectedCode })
      expect(harness.connectCount).toBe(0)
    }
  })

  test('persists credential revocation and retires keys through the repository contract', async () => {
    const harness = createHarness()
    const revokedId = 'rgc_test_credential_0001'

    const revokeResult = await runAdmin(
      [
        'revoke-credential',
        ...commonArguments('revoke-credential'),
        '--credential-id',
        revokedId,
        '--confirm',
        'revoke-credential',
      ],
      harness
    )
    const retireResult = await runAdmin(
      [
        'retire-key',
        ...commonArguments('retire-key'),
        '--key-id',
        KEY_ID,
        '--confirm',
        'retire-key',
      ],
      harness
    )

    expect(revokeResult).toEqual({ status: 'revoked', credentialId: revokedId })
    expect(harness.repository.revoked).toEqual({ credentialId: revokedId, now: FIXED_NOW })
    expect(retireResult).toEqual({ status: 'retired', keyId: KEY_ID })
    expect(harness.repository.retired).toEqual({ keyId: KEY_ID, status: 'retired' })
    expect(harness.closeCount).toBe(2)
  })
})

function createHarness({ verificationKey } = {}) {
  const repository = {
    async getVerificationKey() {
      return verificationKey
    },
    async registerVerificationKey(record) {
      repository.registered = record
      return record
    },
    async insertIssuedCredential(record) {
      repository.issued = record
      return record
    },
    async revokeCredential(credentialId, now) {
      repository.revoked = { credentialId, now }
      return { credentialId }
    },
    async retireVerificationKey(keyId, status) {
      repository.retired = { keyId, status }
      return true
    },
  }
  const harness = {
    repository,
    connectCount: 0,
    closeCount: 0,
    credentialLoadCount: 0,
  }
  harness.dependencies = {
    loadDatabaseCredentials(_env, role) {
      harness.credentialLoadCount += 1
      expect(role).toBe('migration')
      return { role: 'migration', url: DATABASE_URL }
    },
    createPostgresMigrationConnection(credentials) {
      harness.connectCount += 1
      expect(credentials.role).toBe('migration')
      return {
        database: { mocked: true },
        async close() {
          harness.closeCount += 1
        },
      }
    },
    createRepository() {
      return repository
    },
  }
  return harness
}

function commonArguments(_command) {
  return ['--host', 'db.example.test', '--port', '5433', '--database', 'control_plane']
}

function registerArguments(publicKeyPath) {
  return [
    'register-key',
    ...commonArguments('register-key'),
    '--key-id',
    KEY_ID,
    '--node-id',
    NODE_ID,
    '--workspace-id',
    WORKSPACE_ID,
    '--public-key',
    publicKeyPath,
    '--confirm',
    'register-key',
  ]
}

function issueArguments(issuerPrivateKeyPath, outputPath) {
  return [
    'issue',
    ...commonArguments('issue'),
    '--key-id',
    KEY_ID,
    '--node-id',
    NODE_ID,
    '--workspace-id',
    WORKSPACE_ID,
    '--issuer',
    'https://identity.example.test/runtime-nodes',
    '--audience',
    'control-plane-runtime-gateway',
    '--channel-generation',
    '7',
    '--ttl-seconds',
    '300',
    '--issuer-key-id',
    ISSUER_KEY_ID,
    '--issuer-private-key',
    issuerPrivateKeyPath,
    '--output',
    outputPath,
    '--confirm',
    'issue',
  ]
}

function runAdmin(argv, harness, overrides = {}) {
  return runRuntimeNodeIdentityAdmin({
    argv,
    env: {},
    now: () => new Date(FIXED_NOW),
    dependencies: {
      ...harness.dependencies,
      ...overrides,
    },
  })
}

function thumbprint(publicKey) {
  return `sha256:${createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex')}`
}
