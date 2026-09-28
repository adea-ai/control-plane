import { createHash, createPublicKey } from 'node:crypto'
import {
  RuntimeNodeCredentialClaimsSchema,
  RuntimeNodeIdSchema,
  RuntimeNodeWorkspaceIdSchema,
  type RuntimeNodeCredentialClaims,
  type RuntimeNodeIdentityInvalidation,
} from '@control-plane/runtime-gateway-protocol'
import { and, eq, exists, gt, isNull, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import {
  runtimeNodeIssuedCredentials,
  runtimeNodeVerificationKeys,
} from './schema/runtime-node-identity.js'

const REVOCATION_CHANNEL = 'runtime_node_credential_revocations_v1'
const MAX_SAFE_VERSION = Number.MAX_SAFE_INTEGER

export type RuntimeNodeVerificationKeyStatus = 'active' | 'retired' | 'revoked'

export interface RuntimeNodeVerificationKeyRecord {
  readonly keyId: string
  readonly nodeId: string
  readonly workspaceId: string
  readonly publicKeyPem: string
  readonly thumbprint: string
  readonly status: RuntimeNodeVerificationKeyStatus
}

export interface RuntimeNodeIssuedCredentialRecord {
  readonly credentialId: string
  readonly nodeId: string
  readonly workspaceId: string
  readonly keyId: string
  readonly claims: RuntimeNodeCredentialClaims
  readonly revocationVersion: number
  readonly issuedAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly consumedAt: string | null
}

export type RuntimeNodeIssuedCredentialInput = Omit<
  RuntimeNodeIssuedCredentialRecord,
  'revokedAt' | 'consumedAt'
> & {
  readonly revokedAt?: null
  readonly consumedAt?: null
}

export type RuntimeNodeCredentialConsumeResult =
  | 'consumed'
  | 'replayed'
  | 'revoked'
  | 'expired'
  | 'unknown'

export type RuntimeNodeIdentityRepositoryErrorCode =
  | 'RUNTIME_NODE_IDENTITY_INVALID_INPUT'
  | 'RUNTIME_NODE_IDENTITY_INVALID_PUBLIC_KEY'
  | 'RUNTIME_NODE_IDENTITY_THUMBPRINT_MISMATCH'
  | 'RUNTIME_NODE_IDENTITY_KEY_ID_COLLISION'
  | 'RUNTIME_NODE_IDENTITY_KEY_INACTIVE_CONFLICT'
  | 'RUNTIME_NODE_IDENTITY_KEY_NOT_ACTIVE'
  | 'RUNTIME_NODE_IDENTITY_SCOPE_MISMATCH'
  | 'RUNTIME_NODE_IDENTITY_CREDENTIAL_ID_COLLISION'
  | 'RUNTIME_NODE_IDENTITY_CREDENTIAL_NOT_FOUND'
  | 'RUNTIME_NODE_IDENTITY_VERSION_EXHAUSTED'
  | 'RUNTIME_NODE_IDENTITY_DATA_CORRUPT'

export class RuntimeNodeIdentityRepositoryError extends Error {
  constructor(readonly code: RuntimeNodeIdentityRepositoryErrorCode) {
    super(code)
    this.name = 'RuntimeNodeIdentityRepositoryError'
  }
}

export class PostgresRuntimeNodeIdentityRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async registerVerificationKey(
    input: RuntimeNodeVerificationKeyRecord
  ): Promise<RuntimeNodeVerificationKeyRecord> {
    const record = validateVerificationKeyInput(input)
    if (record.status !== 'active') fail('RUNTIME_NODE_IDENTITY_KEY_INACTIVE_CONFLICT')

    return this.database.transaction(async (tx) => {
      await lockIdentity(tx, 'key', record.keyId)
      const [current] = await tx
        .select({ status: runtimeNodeVerificationKeys.status })
        .from(runtimeNodeVerificationKeys)
        .where(eq(runtimeNodeVerificationKeys.keyId, record.keyId))
        .limit(1)
      if (current) {
        if (current.status !== 'active') fail('RUNTIME_NODE_IDENTITY_KEY_INACTIVE_CONFLICT')
        fail('RUNTIME_NODE_IDENTITY_KEY_ID_COLLISION')
      }
      const [row] = await tx.insert(runtimeNodeVerificationKeys).values(record).returning()
      if (!row) fail('RUNTIME_NODE_IDENTITY_DATA_CORRUPT')
      return parseVerificationKeyRow(row)
    })
  }

  async retireVerificationKey(
    keyIdInput: string,
    status: Extract<RuntimeNodeVerificationKeyStatus, 'retired' | 'revoked'>
  ): Promise<boolean> {
    const keyId = parseKeyId(keyIdInput)
    if (status !== 'retired' && status !== 'revoked') fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
    return this.database.transaction(async (tx) => {
      await lockIdentity(tx, 'key', keyId)
      const rows = await tx
        .update(runtimeNodeVerificationKeys)
        .set({ status })
        .where(
          and(
            eq(runtimeNodeVerificationKeys.keyId, keyId),
            eq(runtimeNodeVerificationKeys.status, 'active')
          )
        )
        .returning({ keyId: runtimeNodeVerificationKeys.keyId })
      if (rows[0]) {
        await tx.execute(sql`select pg_notify(${REVOCATION_CHANNEL}, ${`key:${keyId}`})`)
      }
      return rows.length === 1
    })
  }

  async getVerificationKey(
    keyIdInput: string
  ): Promise<RuntimeNodeVerificationKeyRecord | undefined> {
    const keyId = parseKeyId(keyIdInput)
    const [row] = await this.database
      .select()
      .from(runtimeNodeVerificationKeys)
      .where(eq(runtimeNodeVerificationKeys.keyId, keyId))
      .limit(1)
    return row === undefined ? undefined : parseVerificationKeyRow(row)
  }

  async insertIssuedCredential(
    input: RuntimeNodeIssuedCredentialInput
  ): Promise<RuntimeNodeIssuedCredentialRecord> {
    const record = validateIssuedCredentialInput(input)
    try {
      return await this.database.transaction(async (tx) => {
        await lockIdentity(tx, 'key', record.keyId)
        const [key] = await tx
          .select()
          .from(runtimeNodeVerificationKeys)
          .where(eq(runtimeNodeVerificationKeys.keyId, record.keyId))
          .limit(1)
        if (!key) fail('RUNTIME_NODE_IDENTITY_KEY_NOT_ACTIVE')
        if (key.nodeId !== record.nodeId || key.workspaceId !== record.workspaceId)
          fail('RUNTIME_NODE_IDENTITY_SCOPE_MISMATCH')
        if (key.status !== 'active') fail('RUNTIME_NODE_IDENTITY_KEY_NOT_ACTIVE')

        const [existing] = await tx
          .select({ credentialId: runtimeNodeIssuedCredentials.credentialId })
          .from(runtimeNodeIssuedCredentials)
          .where(eq(runtimeNodeIssuedCredentials.credentialId, record.credentialId))
          .limit(1)
        if (existing) fail('RUNTIME_NODE_IDENTITY_CREDENTIAL_ID_COLLISION')

        const [row] = await tx.insert(runtimeNodeIssuedCredentials).values(record).returning()
        if (!row) fail('RUNTIME_NODE_IDENTITY_DATA_CORRUPT')
        return parseIssuedCredentialRow(row)
      })
    } catch (error) {
      if (postgresErrorCode(error) === '23505')
        fail('RUNTIME_NODE_IDENTITY_CREDENTIAL_ID_COLLISION')
      throw error
    }
  }

  async getIssuedCredential(
    credentialIdInput: string
  ): Promise<RuntimeNodeIssuedCredentialRecord | undefined> {
    const credentialId = parseCredentialId(credentialIdInput)
    const [row] = await this.database
      .select()
      .from(runtimeNodeIssuedCredentials)
      .where(eq(runtimeNodeIssuedCredentials.credentialId, credentialId))
      .limit(1)
    return row === undefined ? undefined : parseIssuedCredentialRow(row)
  }

  async consumeCredential(
    credentialIdInput: string,
    revocationVersionInput: number,
    nowInput: Date | string
  ): Promise<RuntimeNodeCredentialConsumeResult> {
    const credentialId = parseCredentialId(credentialIdInput)
    const revocationVersion = parseVersion(revocationVersionInput)
    const now = parseTimestamp(nowInput)

    return this.database.transaction(async (tx) => {
      const [initial] = await tx
        .select()
        .from(runtimeNodeIssuedCredentials)
        .where(eq(runtimeNodeIssuedCredentials.credentialId, credentialId))
        .limit(1)
      if (!initial) return 'unknown'

      let current: RuntimeNodeIssuedCredentialRecord
      try {
        current = parseIssuedCredentialRow(initial)
      } catch {
        return 'revoked'
      }
      await lockIdentity(tx, 'key', current.keyId)

      const [key] = await tx
        .select()
        .from(runtimeNodeVerificationKeys)
        .where(
          and(
            eq(runtimeNodeVerificationKeys.keyId, current.keyId),
            eq(runtimeNodeVerificationKeys.nodeId, current.nodeId),
            eq(runtimeNodeVerificationKeys.workspaceId, current.workspaceId)
          )
        )
        .limit(1)
      if (!key || key.status !== 'active') return 'revoked'

      const activeKey = tx
        .select({ keyId: runtimeNodeVerificationKeys.keyId })
        .from(runtimeNodeVerificationKeys)
        .where(
          and(
            eq(runtimeNodeVerificationKeys.keyId, current.keyId),
            eq(runtimeNodeVerificationKeys.nodeId, current.nodeId),
            eq(runtimeNodeVerificationKeys.workspaceId, current.workspaceId),
            eq(runtimeNodeVerificationKeys.status, 'active')
          )
        )
      const consumed = await tx
        .update(runtimeNodeIssuedCredentials)
        .set({ consumedAt: now })
        .where(
          and(
            eq(runtimeNodeIssuedCredentials.credentialId, credentialId),
            eq(runtimeNodeIssuedCredentials.revocationVersion, revocationVersion),
            isNull(runtimeNodeIssuedCredentials.revokedAt),
            isNull(runtimeNodeIssuedCredentials.consumedAt),
            gt(runtimeNodeIssuedCredentials.expiresAt, now),
            exists(activeKey)
          )
        )
        .returning({ credentialId: runtimeNodeIssuedCredentials.credentialId })
      if (consumed.length === 1) return 'consumed'

      const [latest] = await tx
        .select()
        .from(runtimeNodeIssuedCredentials)
        .where(eq(runtimeNodeIssuedCredentials.credentialId, credentialId))
        .limit(1)
      if (!latest) return 'unknown'
      let latestRecord: RuntimeNodeIssuedCredentialRecord
      try {
        latestRecord = parseIssuedCredentialRow(latest)
      } catch {
        return 'revoked'
      }
      if (latestRecord.revokedAt !== null || latestRecord.revocationVersion !== revocationVersion)
        return 'revoked'
      if (Date.parse(latestRecord.expiresAt) <= now.getTime()) return 'expired'
      if (latestRecord.consumedAt !== null) return 'replayed'
      return 'revoked'
    })
  }

  async isCredentialRevoked(
    credentialIdInput: string,
    revocationVersionInput: number
  ): Promise<boolean> {
    const credentialId = parseCredentialId(credentialIdInput)
    const revocationVersion = parseVersion(revocationVersionInput)
    const [row] = await this.database
      .select({
        credential: runtimeNodeIssuedCredentials,
        keyStatus: runtimeNodeVerificationKeys.status,
      })
      .from(runtimeNodeIssuedCredentials)
      .leftJoin(
        runtimeNodeVerificationKeys,
        and(
          eq(runtimeNodeVerificationKeys.keyId, runtimeNodeIssuedCredentials.keyId),
          eq(runtimeNodeVerificationKeys.nodeId, runtimeNodeIssuedCredentials.nodeId),
          eq(runtimeNodeVerificationKeys.workspaceId, runtimeNodeIssuedCredentials.workspaceId)
        )
      )
      .where(eq(runtimeNodeIssuedCredentials.credentialId, credentialId))
      .limit(1)
    if (!row) return true
    try {
      const credential = parseIssuedCredentialRow(row.credential)
      return (
        credential.revokedAt !== null ||
        credential.revocationVersion !== revocationVersion ||
        row.keyStatus !== 'active'
      )
    } catch {
      return true
    }
  }

  async revokeCredential(
    credentialIdInput: string,
    nowInput: Date | string
  ): Promise<RuntimeNodeIssuedCredentialRecord> {
    const credentialId = parseCredentialId(credentialIdInput)
    const now = parseTimestamp(nowInput)
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(runtimeNodeIssuedCredentials)
        .where(eq(runtimeNodeIssuedCredentials.credentialId, credentialId))
        .limit(1)
      if (!current) fail('RUNTIME_NODE_IDENTITY_CREDENTIAL_NOT_FOUND')
      const parsed = parseIssuedCredentialRow(current)
      if (parsed.revokedAt !== null) return parsed
      if (parsed.revocationVersion >= MAX_SAFE_VERSION)
        fail('RUNTIME_NODE_IDENTITY_VERSION_EXHAUSTED')

      const [revoked] = await tx
        .update(runtimeNodeIssuedCredentials)
        .set({ revocationVersion: parsed.revocationVersion + 1, revokedAt: now })
        .where(
          and(
            eq(runtimeNodeIssuedCredentials.credentialId, credentialId),
            isNull(runtimeNodeIssuedCredentials.revokedAt)
          )
        )
        .returning()
      if (revoked) {
        await tx.execute(sql`select pg_notify(${REVOCATION_CHANNEL}, ${credentialId})`)
        return parseIssuedCredentialRow(revoked)
      }

      const [latest] = await tx
        .select()
        .from(runtimeNodeIssuedCredentials)
        .where(eq(runtimeNodeIssuedCredentials.credentialId, credentialId))
        .limit(1)
      if (!latest) fail('RUNTIME_NODE_IDENTITY_CREDENTIAL_NOT_FOUND')
      return parseIssuedCredentialRow(latest)
    })
  }

  async subscribeRevocations(
    listener: (invalidation: RuntimeNodeIdentityInvalidation) => void
  ): Promise<() => Promise<void>> {
    if (typeof listener !== 'function') fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
    const client = (
      this.database as ControlPlaneDatabase & {
        $client: {
          listen(
            channel: string,
            callback: (payload: string) => void
          ): Promise<{ unlisten(): Promise<void> }>
        }
      }
    ).$client
    const request = await client.listen(REVOCATION_CHANNEL, (payload) => {
      const invalidation = parseIdentityInvalidation(payload)
      if (!invalidation) return
      try {
        listener(invalidation)
      } catch {
        // Notification delivery is a wake-up hint; durable revocation checks remain authoritative.
      }
    })
    let subscribed = true
    return async () => {
      if (!subscribed) return
      subscribed = false
      await request.unlisten()
    }
  }
}

function validateVerificationKeyInput(
  input: RuntimeNodeVerificationKeyRecord
): RuntimeNodeVerificationKeyRecord {
  if (!input || typeof input !== 'object') fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  const keyId = parseKeyId(input.keyId)
  const nodeId = parseNodeId(input.nodeId)
  const workspaceId = parseWorkspaceId(input.workspaceId)
  const publicKeyPem = validatePublicKey(input.publicKeyPem)
  const thumbprint = validateThumbprint(input.thumbprint)
  if (thumbprint !== publicKeyThumbprint(publicKeyPem))
    fail('RUNTIME_NODE_IDENTITY_THUMBPRINT_MISMATCH')
  if (input.status !== 'active' && input.status !== 'retired' && input.status !== 'revoked')
    fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  return { keyId, nodeId, workspaceId, publicKeyPem, thumbprint, status: input.status }
}

function validateIssuedCredentialInput(
  input: RuntimeNodeIssuedCredentialInput
): typeof runtimeNodeIssuedCredentials.$inferInsert {
  if (!input || typeof input !== 'object') fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  if (
    (input.revokedAt !== undefined && input.revokedAt !== null) ||
    (input.consumedAt !== undefined && input.consumedAt !== null)
  )
    fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  const parsed = RuntimeNodeCredentialClaimsSchema.safeParse(input.claims)
  if (!parsed.success) fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  const claims = parsed.data
  const credentialId = parseCredentialId(input.credentialId)
  const nodeId = parseNodeId(input.nodeId)
  const workspaceId = parseWorkspaceId(input.workspaceId)
  const keyId = parseKeyId(input.keyId)
  const revocationVersion = parseVersion(input.revocationVersion)
  if (
    claims.credentialId !== credentialId ||
    claims.nodeId !== nodeId ||
    claims.workspaceId !== workspaceId ||
    claims.keyId !== keyId ||
    claims.revocationVersion !== revocationVersion ||
    claims.issuedAt !== input.issuedAt ||
    claims.expiresAt !== input.expiresAt
  )
    fail('RUNTIME_NODE_IDENTITY_SCOPE_MISMATCH')
  const issuedAt = parseTimestamp(claims.issuedAt)
  const expiresAt = parseTimestamp(claims.expiresAt)
  if (expiresAt.getTime() <= issuedAt.getTime()) fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  return {
    credentialId,
    nodeId,
    workspaceId,
    keyId,
    claims,
    revocationVersion,
    issuedAt,
    expiresAt,
    revokedAt: null,
    consumedAt: null,
  }
}

function parseVerificationKeyRow(
  row: typeof runtimeNodeVerificationKeys.$inferSelect
): RuntimeNodeVerificationKeyRecord {
  const key = validateVerificationKeyInput(row)
  if (key.status !== row.status) fail('RUNTIME_NODE_IDENTITY_DATA_CORRUPT')
  return key
}

function parseIssuedCredentialRow(
  row: typeof runtimeNodeIssuedCredentials.$inferSelect
): RuntimeNodeIssuedCredentialRecord {
  const claimsResult = RuntimeNodeCredentialClaimsSchema.safeParse(row.claims)
  if (!claimsResult.success) fail('RUNTIME_NODE_IDENTITY_DATA_CORRUPT')
  const claims = claimsResult.data
  if (
    claims.credentialId !== row.credentialId ||
    claims.nodeId !== row.nodeId ||
    claims.workspaceId !== row.workspaceId ||
    claims.keyId !== row.keyId ||
    row.revocationVersion !== claims.revocationVersion + (row.revokedAt === null ? 0 : 1) ||
    row.issuedAt.getTime() !== Date.parse(claims.issuedAt) ||
    row.expiresAt.getTime() !== Date.parse(claims.expiresAt) ||
    row.expiresAt.getTime() <= row.issuedAt.getTime()
  )
    fail('RUNTIME_NODE_IDENTITY_DATA_CORRUPT')
  return {
    credentialId: row.credentialId,
    nodeId: row.nodeId,
    workspaceId: row.workspaceId,
    keyId: row.keyId,
    claims,
    revocationVersion: row.revocationVersion,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    revokedAt: timestampToIso(row.revokedAt),
    consumedAt: timestampToIso(row.consumedAt),
  }
}

function validatePublicKey(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 64 ||
    value.length > 2048 ||
    !/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/.test(
      value
    )
  )
    fail('RUNTIME_NODE_IDENTITY_INVALID_PUBLIC_KEY')
  try {
    if (createPublicKey(value).asymmetricKeyType !== 'ed25519')
      fail('RUNTIME_NODE_IDENTITY_INVALID_PUBLIC_KEY')
  } catch {
    fail('RUNTIME_NODE_IDENTITY_INVALID_PUBLIC_KEY')
  }
  return value
}

function publicKeyThumbprint(value: string): string {
  const key = createPublicKey(value)
  return `sha256:${createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('hex')}`
}

function validateThumbprint(value: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  return value
}

function parseKeyId(value: string): string {
  if (typeof value !== 'string' || value.length > 128 || !/^rgk_[A-Za-z0-9_-]+$/.test(value))
    fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  return value
}

function parseCredentialId(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 128 ||
    !/^rgc_[A-Za-z0-9_-]+$/.test(value)
  )
    fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  return value
}

function isCredentialId(value: string): boolean {
  return value.length >= 8 && value.length <= 128 && /^rgc_[A-Za-z0-9_-]+$/.test(value)
}

function parseIdentityInvalidation(value: string): RuntimeNodeIdentityInvalidation | undefined {
  if (isCredentialId(value)) return { kind: 'credential', credentialId: value }
  if (value.startsWith('key:')) {
    const keyId = value.slice('key:'.length)
    if (keyId.length <= 128 && /^rgk_[A-Za-z0-9_-]+$/.test(keyId)) {
      return { kind: 'key', keyId }
    }
  }
  return undefined
}

function parseNodeId(value: string): string {
  const result = RuntimeNodeIdSchema.safeParse(value)
  if (!result.success) fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  return result.data
}

function parseWorkspaceId(value: string): string {
  const result = RuntimeNodeWorkspaceIdSchema.safeParse(value)
  if (!result.success) fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  return result.data
}

function parseVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_VERSION)
    fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  return value
}

function parseTimestamp(value: Date | string): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
    return new Date(value.getTime())
  }
  if (typeof value !== 'string' || value.length > 64) fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value))
    fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  const parsed = Date.parse(value)
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    fail('RUNTIME_NODE_IDENTITY_INVALID_INPUT')
  return new Date(parsed)
}

function timestampToIso(value: Date | null): string | null {
  if (value === null) return null
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    fail('RUNTIME_NODE_IDENTITY_DATA_CORRUPT')
  return value.toISOString()
}

async function lockIdentity(
  tx: Parameters<ControlPlaneDatabase['transaction']>[0] extends (transaction: infer T) => unknown
    ? T
    : never,
  kind: 'key',
  id: string
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-node-${kind}:${id}`}, 0))`
  )
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function fail(code: RuntimeNodeIdentityRepositoryErrorCode): never {
  throw new RuntimeNodeIdentityRepositoryError(code)
}
