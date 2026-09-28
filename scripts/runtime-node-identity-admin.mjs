import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signBytes,
} from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  RuntimeNodeCredentialClaimsSchema,
  RuntimeNodeIdSchema,
  RuntimeNodeWorkspaceIdSchema,
} from '../packages/runtime-gateway-protocol/src/authentication.ts'

const MAX_PUBLIC_KEY_BYTES = 16 * 1024
const MAX_PRIVATE_KEY_BYTES = 16 * 1024
const CONFIRMATION_OPTIONS = ['host', 'port', 'database', 'confirm']
const COMMAND_OPTIONS = {
  'register-key': [...CONFIRMATION_OPTIONS, 'key-id', 'node-id', 'workspace-id', 'public-key'],
  issue: [
    ...CONFIRMATION_OPTIONS,
    'key-id',
    'node-id',
    'workspace-id',
    'issuer',
    'audience',
    'channel-generation',
    'ttl-seconds',
    'issuer-key-id',
    'issuer-private-key',
    'output',
  ],
  'revoke-credential': [...CONFIRMATION_OPTIONS, 'credential-id'],
  'retire-key': [...CONFIRMATION_OPTIONS, 'key-id'],
}

const ARGUMENT_DEFINITIONS = Object.fromEntries(
  [...new Set(Object.values(COMMAND_OPTIONS).flat())].map((name) => [name, { type: 'string' }])
)

const REPOSITORY_ERROR_CODES = {
  RUNTIME_NODE_IDENTITY_CREDENTIAL_ID_COLLISION: 'CREDENTIAL_ID_COLLISION',
  RUNTIME_NODE_IDENTITY_CREDENTIAL_NOT_FOUND: 'CREDENTIAL_NOT_FOUND',
  RUNTIME_NODE_IDENTITY_KEY_ID_COLLISION: 'KEY_ID_COLLISION',
  RUNTIME_NODE_IDENTITY_KEY_INACTIVE_CONFLICT: 'KEY_INACTIVE_CONFLICT',
  RUNTIME_NODE_IDENTITY_KEY_NOT_ACTIVE: 'KEY_NOT_ACTIVE',
  RUNTIME_NODE_IDENTITY_SCOPE_MISMATCH: 'SCOPE_MISMATCH',
  RUNTIME_NODE_IDENTITY_THUMBPRINT_MISMATCH: 'THUMBPRINT_MISMATCH',
}

export class RuntimeNodeIdentityAdminError extends Error {
  constructor(code) {
    super(code)
    this.name = 'RuntimeNodeIdentityAdminError'
    this.code = code
  }
}

function fail(code) {
  throw new RuntimeNodeIdentityAdminError(code)
}

/** Parse a command without printing parser details that might contain input values. */
export function parseRuntimeNodeIdentityAdminCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !Object.hasOwn(COMMAND_OPTIONS, argv[0]))
    fail('INVALID_ARGUMENTS')

  const command = argv[0]
  let values
  try {
    values = parseArgs({
      args: argv.slice(1),
      options: ARGUMENT_DEFINITIONS,
      strict: true,
      allowPositionals: false,
    }).values
  } catch {
    fail('INVALID_ARGUMENTS')
  }

  const allowed = new Set(COMMAND_OPTIONS[command])
  if (Object.keys(values).some((name) => !allowed.has(name))) fail('INVALID_ARGUMENTS')
  for (const name of COMMAND_OPTIONS[command]) {
    if (values[name] === undefined || values[name] === '') fail('INVALID_ARGUMENTS')
  }
  if (values.confirm !== command) fail('CONFIRMATION_REQUIRED')

  return { command, values }
}

/** Run an offline operator command. Dependencies are injectable for focused tests. */
export async function runRuntimeNodeIdentityAdmin({
  argv,
  env = process.env,
  dependencies = {},
  now = () => new Date(),
} = {}) {
  try {
    const invocation = parseRuntimeNodeIdentityAdminCommand(argv)
    const resolvedDependencies = await resolveDependencies(dependencies)
    let credentials
    try {
      credentials = resolvedDependencies.loadDatabaseCredentials(env, 'migration')
    } catch {
      fail('MIGRATION_CREDENTIALS_UNAVAILABLE')
    }
    if (credentials?.role !== 'migration' || typeof credentials.url !== 'string')
      fail('MIGRATION_CREDENTIALS_UNAVAILABLE')

    assertPostgresTarget(invocation.values, credentials.url)
    const prepared = await prepareCommand(invocation, now)

    let connection
    let operationError
    let result
    try {
      connection = await resolvedDependencies.createPostgresMigrationConnection(credentials)
      if (!connection || typeof connection.close !== 'function' || !connection.database)
        fail('DATABASE_API_UNAVAILABLE')
      const repository = resolvedDependencies.createRepository(connection.database)
      result = await executeCommand(invocation.command, prepared, repository, now)
    } catch (error) {
      operationError = normalizeAdminError(error)
    }
    if (connection) {
      try {
        await connection.close()
      } catch {
        if (!operationError)
          operationError = new RuntimeNodeIdentityAdminError('DATABASE_CLOSE_FAILED')
      }
    }
    if (operationError) throw operationError
    return result
  } catch (error) {
    throw normalizeAdminError(error)
  }
}

/** Compare the explicit operator target to the migration-role URL before connecting. */
export function assertPostgresTarget(values, migrationUrl) {
  const requestedPort = parsePort(values?.port)
  if (
    typeof values?.host !== 'string' ||
    values.host.length === 0 ||
    typeof values?.database !== 'string' ||
    values.database.length === 0
  )
    fail('INVALID_TARGET')

  let configured
  try {
    configured = new URL(migrationUrl)
  } catch {
    fail('INVALID_TARGET')
  }
  if (configured.protocol !== 'postgres:' && configured.protocol !== 'postgresql:')
    fail('INVALID_TARGET')

  let requestedHost
  let configuredDatabase
  try {
    requestedHost = canonicalHost(values.host)
    configuredDatabase = decodeURIComponent(configured.pathname.slice(1))
  } catch {
    fail('INVALID_TARGET')
  }
  const configuredPort = configured.port === '' ? 5432 : Number(configured.port)
  if (
    requestedHost !== canonicalHost(configured.hostname) ||
    requestedPort !== configuredPort ||
    values.database !== configuredDatabase
  )
    fail('TARGET_MISMATCH')
}

/** Write a completed credential by publishing a same-directory hard link. */
export async function writeCredentialAtomically(outputPath, credential) {
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath) || !credential)
    fail('OUTPUT_PATH_INVALID')

  const directory = dirname(outputPath)
  const leaf = basename(outputPath)
  if (leaf.length === 0 || leaf === '.' || leaf === '..') fail('OUTPUT_PATH_INVALID')
  try {
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('OUTPUT_PATH_INVALID')
    await assertOutputDoesNotExist(outputPath)
  } catch (error) {
    if (error instanceof RuntimeNodeIdentityAdminError) throw error
    fail('OUTPUT_PATH_INVALID')
  }

  const temporaryPath = join(
    directory,
    `.${leaf}.runtime-node-${randomBytes(12).toString('hex')}.tmp`
  )
  let file
  let published = false
  try {
    if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0)
      fail('NOFOLLOW_UNAVAILABLE')
    file = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    await file.chmod(0o600)
    await file.writeFile(credential, { encoding: 'utf8' })
    await file.sync()
    await file.close()
    file = undefined

    try {
      await link(temporaryPath, outputPath)
      published = true
    } catch (error) {
      if (error?.code === 'EEXIST') fail('OUTPUT_ALREADY_EXISTS')
      fail('OUTPUT_WRITE_FAILED')
    }
  } catch (error) {
    if (error instanceof RuntimeNodeIdentityAdminError) throw error
    fail('OUTPUT_WRITE_FAILED')
  } finally {
    if (file) {
      try {
        await file.close()
      } catch {
        // The stable operation error below is the only diagnostic exposed.
      }
    }
    if (!published) {
      try {
        await unlink(temporaryPath)
      } catch {
        // It may not have been created; never expose filesystem diagnostics.
      }
    }
  }
  try {
    await unlink(temporaryPath)
  } catch {
    // The credential is already atomically published with mode 0600.
  }
}

/** Stable CLI diagnostic; never includes paths, PEM, database URLs, or driver errors. */
export function runtimeNodeIdentityAdminDiagnostic(error) {
  const normalized = normalizeAdminError(error)
  return `RUNTIME_NODE_IDENTITY_ADMIN_${normalized.code}`
}

async function resolveDependencies(overrides) {
  let loadDatabaseCredentials = overrides.loadDatabaseCredentials
  let createPostgresMigrationConnection = overrides.createPostgresMigrationConnection
  let createRepository = overrides.createRepository

  if (!loadDatabaseCredentials) {
    try {
      ;({ loadDatabaseCredentials } = await import('@control-plane/config'))
    } catch {
      fail('DATABASE_API_UNAVAILABLE')
    }
  }
  if (!createPostgresMigrationConnection || !createRepository) {
    let database
    try {
      database = await import('@control-plane/database')
    } catch {
      fail('DATABASE_API_UNAVAILABLE')
    }
    createPostgresMigrationConnection ??= database.createPostgresMigrationConnection
    const Repository = database.PostgresRuntimeNodeIdentityRepository
    if (!createRepository && typeof Repository !== 'function') fail('DATABASE_API_UNAVAILABLE')
    createRepository ??= (connection) => new Repository(connection)
  }
  if (
    typeof loadDatabaseCredentials !== 'function' ||
    typeof createPostgresMigrationConnection !== 'function' ||
    typeof createRepository !== 'function'
  )
    fail('DATABASE_API_UNAVAILABLE')
  return { loadDatabaseCredentials, createPostgresMigrationConnection, createRepository }
}

async function prepareCommand({ command, values }, now) {
  if (command === 'register-key') {
    const keyId = validateKeyId(values['key-id'])
    const nodeId = parseNodeId(values['node-id'])
    const workspaceId = parseWorkspaceId(values['workspace-id'])
    const publicKey = await readEd25519PublicKey(values['public-key'])
    return {
      keyId,
      nodeId,
      workspaceId,
      publicKeyPem: publicKey.pem,
      thumbprint: publicKey.thumbprint,
    }
  }
  if (command === 'issue') {
    const keyId = validateKeyId(values['key-id'])
    const nodeId = parseNodeId(values['node-id'])
    const workspaceId = parseWorkspaceId(values['workspace-id'])
    const issuer = validateIssuer(values.issuer)
    const audience = validateAudience(values.audience)
    const channelGeneration = parsePositiveInteger(
      values['channel-generation'],
      'INVALID_CHANNEL_GENERATION'
    )
    const ttlSeconds = parseBoundedInteger(values['ttl-seconds'], 1, 600, 'INVALID_EXPIRY')
    const issuerKeyId = validateIssuerKeyId(values['issuer-key-id'])
    const issuerPrivateKey = await readEd25519PrivateKey(values['issuer-private-key'])
    await assertNewOutputPath(values.output)
    const issuedAt = readClock(now).toISOString()
    const expiresAt = new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString()
    return {
      keyId,
      nodeId,
      workspaceId,
      issuer,
      audience,
      channelGeneration,
      issuerKeyId,
      issuerPrivateKey,
      issuedAt,
      expiresAt,
      outputPath: values.output,
    }
  }
  if (command === 'revoke-credential') {
    return { credentialId: validateCredentialId(values['credential-id']) }
  }
  if (command === 'retire-key') return { keyId: validateKeyId(values['key-id']) }
  fail('INVALID_ARGUMENTS')
}

async function executeCommand(command, prepared, repository, now) {
  if (command === 'register-key') {
    if (typeof repository.registerVerificationKey !== 'function') fail('DATABASE_API_UNAVAILABLE')
    await repository.registerVerificationKey({ ...prepared, status: 'active' })
    return { status: 'registered', keyId: prepared.keyId }
  }
  if (command === 'issue') {
    if (
      typeof repository.getVerificationKey !== 'function' ||
      typeof repository.insertIssuedCredential !== 'function' ||
      typeof repository.revokeCredential !== 'function'
    )
      fail('DATABASE_API_UNAVAILABLE')
    const registered = await repository.getVerificationKey(prepared.keyId)
    if (!registered) fail('KEY_NOT_FOUND')
    if (registered.status !== 'active') fail('KEY_NOT_ACTIVE')
    if (registered.nodeId !== prepared.nodeId || registered.workspaceId !== prepared.workspaceId)
      fail('SCOPE_MISMATCH')
    const registeredKey = parseRegisteredPublicKey(registered)
    const claims = parseCredentialClaims({
      schemaVersion: 1,
      credentialKind: 'runtime_node',
      credentialId: `rgc_${randomBytes(24).toString('base64url')}`,
      issuer: prepared.issuer,
      audience: prepared.audience,
      nodeId: prepared.nodeId,
      workspaceId: prepared.workspaceId,
      keyId: prepared.keyId,
      proofKeyThumbprint: registeredKey.thumbprint,
      revocationVersion: 1,
      channelGeneration: prepared.channelGeneration,
      issuedAt: prepared.issuedAt,
      expiresAt: prepared.expiresAt,
    })
    const credential = signCredential(claims, prepared.issuerKeyId, prepared.issuerPrivateKey)
    const record = {
      credentialId: claims.credentialId,
      nodeId: claims.nodeId,
      workspaceId: claims.workspaceId,
      keyId: claims.keyId,
      claims,
      revocationVersion: claims.revocationVersion,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      revokedAt: null,
      consumedAt: null,
    }
    await repository.insertIssuedCredential(record)
    try {
      await writeCredentialAtomically(prepared.outputPath, credential)
    } catch (error) {
      try {
        await repository.revokeCredential(claims.credentialId, readClock(now))
      } catch {
        // Keep the output failure stable; the CLI never reveals driver details.
      }
      throw error
    }
    return { status: 'issued', credentialId: claims.credentialId }
  }
  if (command === 'revoke-credential') {
    if (typeof repository.revokeCredential !== 'function') fail('DATABASE_API_UNAVAILABLE')
    await repository.revokeCredential(prepared.credentialId, readClock(now))
    return { status: 'revoked', credentialId: prepared.credentialId }
  }
  if (command === 'retire-key') {
    if (typeof repository.retireVerificationKey !== 'function') fail('DATABASE_API_UNAVAILABLE')
    const retired = await repository.retireVerificationKey(prepared.keyId, 'retired')
    if (!retired) fail('KEY_NOT_ACTIVE')
    return { status: 'retired', keyId: prepared.keyId }
  }
  fail('INVALID_ARGUMENTS')
}

async function readEd25519PublicKey(path) {
  const pem = await readPemFile(path, MAX_PUBLIC_KEY_BYTES, 'PUBLIC_KEY_FILE_INVALID')
  try {
    if (
      pem.length < 64 ||
      pem.length > 2048 ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/.test(
        pem
      )
    )
      fail('PUBLIC_KEY_FILE_INVALID')
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') fail('PUBLIC_KEY_TYPE_INVALID')
    const canonicalPem = key.export({ format: 'pem', type: 'spki' }).toString()
    return { pem: canonicalPem, thumbprint: publicKeyThumbprint(key) }
  } catch (error) {
    if (error instanceof RuntimeNodeIdentityAdminError) throw error
    fail('PUBLIC_KEY_FILE_INVALID')
  }
}

async function readEd25519PrivateKey(path) {
  const bytes = await readSecurePrivateKeyFile(path)
  try {
    const key = createPrivateKey(bytes)
    if (key.asymmetricKeyType !== 'ed25519') fail('ISSUER_KEY_TYPE_INVALID')
    return key
  } catch (error) {
    if (error instanceof RuntimeNodeIdentityAdminError) throw error
    fail('ISSUER_KEY_FILE_INVALID')
  } finally {
    bytes.fill(0)
  }
}

async function readPemFile(path, maxBytes, errorCode) {
  const bytes = await readRegularNoFollowFile(path, maxBytes, errorCode)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(errorCode)
  } finally {
    bytes.fill(0)
  }
}

async function readSecurePrivateKeyFile(path) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!Number.isInteger(uid)) fail('OS_USER_UNAVAILABLE')
  const bytes = await readRegularNoFollowFile(
    path,
    MAX_PRIVATE_KEY_BYTES,
    'ISSUER_KEY_FILE_INVALID',
    {
      uid,
      private: true,
    }
  )
  if (bytes.length === 0) {
    bytes.fill(0)
    fail('ISSUER_KEY_FILE_INVALID')
  }
  return bytes
}

async function readRegularNoFollowFile(path, maxBytes, errorCode, policy = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('KEY_PATH_INVALID')
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0)
    fail('NOFOLLOW_UNAVAILABLE')
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size > maxBytes ||
      (policy.uid !== undefined && stat.uid !== policy.uid) ||
      (policy.private === true && (stat.mode & 0o077) !== 0)
    )
      fail(errorCode)
    const bytes = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) {
      bytes.fill(0)
      fail(errorCode)
    }
    return bytes.subarray(0, offset)
  } catch (error) {
    if (error instanceof RuntimeNodeIdentityAdminError) throw error
    fail(errorCode)
  } finally {
    if (file) {
      try {
        await file.close()
      } catch {
        fail(errorCode)
      }
    }
  }
}

function parseRegisteredPublicKey(registered) {
  try {
    if (typeof registered.publicKeyPem !== 'string') fail('KEY_RECORD_INVALID')
    const key = createPublicKey(registered.publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519') fail('KEY_RECORD_INVALID')
    const thumbprint = publicKeyThumbprint(key)
    if (registered.thumbprint !== thumbprint) fail('KEY_RECORD_INVALID')
    return { thumbprint }
  } catch (error) {
    if (error instanceof RuntimeNodeIdentityAdminError) throw error
    fail('KEY_RECORD_INVALID')
  }
}

function parseCredentialClaims(input) {
  const result = RuntimeNodeCredentialClaimsSchema.safeParse(input)
  if (!result.success) fail('CREDENTIAL_CLAIMS_INVALID')
  return result.data
}

function signCredential(claims, issuerKeyId, privateKey) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'RNGC', kid: issuerKeyId }),
    'utf8'
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const input = `${header}.${payload}`
  const signature = signBytes(null, Buffer.from(input, 'utf8'), privateKey).toString('base64url')
  return `${input}.${signature}`
}

function publicKeyThumbprint(key) {
  return `sha256:${createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('hex')}`
}

async function assertNewOutputPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('OUTPUT_PATH_INVALID')
  const directory = dirname(path)
  try {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('OUTPUT_PATH_INVALID')
  } catch (error) {
    if (error instanceof RuntimeNodeIdentityAdminError) throw error
    fail('OUTPUT_PATH_INVALID')
  }
  await assertOutputDoesNotExist(path)
}

async function assertOutputDoesNotExist(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    fail('OUTPUT_PATH_INVALID')
  }
  fail('OUTPUT_ALREADY_EXISTS')
}

function validateIssuer(value) {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      value.length > 512
    )
      fail('INVALID_ISSUER')
    return value
  } catch (error) {
    if (error instanceof RuntimeNodeIdentityAdminError) throw error
    fail('INVALID_ISSUER')
  }
}

function validateAudience(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 256 || value.trim() !== value)
    fail('INVALID_AUDIENCE')
  return value
}

function validateKeyId(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^rgk_[A-Za-z0-9_-]+$/.test(value))
    fail('INVALID_KEY_ID')
  return value
}

function validateCredentialId(value) {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 128 ||
    !/^rgc_[A-Za-z0-9_-]+$/.test(value)
  )
    fail('INVALID_CREDENTIAL_ID')
  return value
}

function validateIssuerKeyId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(value))
    fail('INVALID_ISSUER_KEY_ID')
  return value
}

function parseNodeId(value) {
  const result = RuntimeNodeIdSchema.safeParse(value)
  if (!result.success) fail('INVALID_NODE_ID')
  return result.data
}

function parseWorkspaceId(value) {
  const result = RuntimeNodeWorkspaceIdSchema.safeParse(value)
  if (!result.success) fail('INVALID_WORKSPACE_ID')
  return result.data
}

function parsePort(value) {
  const port = parseBoundedInteger(value, 1, 65535, 'INVALID_TARGET')
  return port
}

function parsePositiveInteger(value, code) {
  return parseBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER, code)
}

function parseBoundedInteger(value, min, max, code) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(code)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(code)
  return number
}

function canonicalHost(value) {
  if (typeof value !== 'string' || value.length === 0) fail('INVALID_TARGET')
  try {
    return new URL(`postgres://operator:unused@${value}:5432/target`).hostname.toLowerCase()
  } catch {
    fail('INVALID_TARGET')
  }
}

function readClock(now) {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('CLOCK_UNAVAILABLE')
  return value
}

function normalizeAdminError(error) {
  if (error instanceof RuntimeNodeIdentityAdminError) return error
  const mapped = REPOSITORY_ERROR_CODES[error?.code]
  return new RuntimeNodeIdentityAdminError(mapped ?? 'OPERATION_FAILED')
}
