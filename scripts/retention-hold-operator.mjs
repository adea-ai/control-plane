import { open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { userInfo } from 'node:os'
import {
  RetentionHoldScopeSchema,
  RetentionHoldSessionSchema,
  parseRetentionHoldPolicy,
} from '@control-plane/domain'
import { decidedRetentionPolicy } from '../packages/config/src/retention-policy.ts'

const MAX_JSON_BYTES = 262144
const ACTIONS = new Set(['create', 'release', 'sweep', 'assess'])

/** Read bounded UTF-8 JSON through a no-follow descriptor. */
export async function readBoundedRetentionHoldJson(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('INVALID_PATH')
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0)
    throw new Error('NOFOLLOW_UNAVAILABLE')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error('INVALID_FILE')
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const result = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > MAX_JSON_BYTES) throw new Error('INVALID_FILE')
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    )
  } finally {
    await file.close()
  }
}

/** Load target-bound operator policy; configuration is never taken from globals. */
export async function loadRetentionHoldOperatorPolicy({ path, target }) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('INVALID_POLICY_PATH')
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!Number.isInteger(uid)) throw new Error('PROCESS_UID_UNAVAILABLE')
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0)
    throw new Error('NOFOLLOW_UNAVAILABLE')

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let document
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size > MAX_JSON_BYTES ||
      stat.uid !== uid ||
      (stat.mode & 0o022) !== 0
    )
      throw new Error('INVALID_POLICY_FILE')
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const result = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > MAX_JSON_BYTES) throw new Error('INVALID_POLICY_FILE')
    document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    )
  } finally {
    await file.close()
  }

  const parsed = parseOperatorDocument(document)
  const parsedTarget = await parseTarget(target)
  if (!sameTarget(parsed.target, parsedTarget)) throw new Error('POLICY_TARGET_MISMATCH')
  const policy = parseRetentionHoldPolicy(parsed.policy)
  const decided = new Map(decidedRetentionPolicy.classes.map((entry) => [entry.id, entry]))
  for (const [classId, classPolicy] of Object.entries(policy)) {
    const decidedClass = decided.get(classId)
    if (decidedClass === undefined || decidedClass.holdOwner !== classPolicy.owner)
      throw new Error('POLICY_OWNER_MISMATCH')
  }

  const grants = parseGrants(parsed.grants, policy)
  const matchingGrants = (sessionInput, classId, action) => {
    const session = RetentionHoldSessionSchema.safeParse(sessionInput)
    if (!session.success || !Object.hasOwn(policy, classId)) return []
    return grants.filter(
      (grant) =>
        grant.actorPrincipalRef === session.data.actorPrincipalRef &&
        grant.authorityRef === session.data.authorityRef &&
        grant.classId === classId &&
        grant.actions.includes(action)
    )
  }

  return {
    policy,
    authorizeOwner: ({ session, owner, classId, scope, action }) => {
      if (!Object.hasOwn(policy, classId)) return false
      const classPolicy = policy[classId]
      if (classPolicy === undefined || classPolicy.owner !== owner) return false
      const requestedScope = RetentionHoldScopeSchema.safeParse(scope)
      if (!requestedScope.success || !classPolicy.scopes.includes(requestedScope.data.kind))
        return false
      return matchingGrants(session, classId, action).some((grant) =>
        scopeContains(grant.scope, requestedScope.data)
      )
    },
    authorizeClassAction: ({ session, classId, action }) => {
      return matchingGrants(session, classId, action).some((grant) => grant.scope.kind === 'class')
    },
  }
}

/** Read OS identity, optionally binding PostgreSQL authority to current_user. */
export async function readVerifiedRetentionHoldSession({ database } = {}) {
  let username
  try {
    username = userInfo().username
  } catch {
    throw new Error('OS_SESSION_UNAVAILABLE')
  }
  if (typeof username !== 'string' || username.length === 0)
    throw new Error('OS_SESSION_UNAVAILABLE')
  const actorPrincipalRef = `operator:os-user:${encodeURIComponent(username)}`
  if (database === undefined) {
    return RetentionHoldSessionSchema.parse({
      actorPrincipalRef,
      authorityRef: 'authority:sqlite:local-os',
    })
  }
  const { retentionHoldDatabaseAuthority } =
    await import('../packages/database/src/retention-hold-repository.ts')
  return RetentionHoldSessionSchema.parse({
    actorPrincipalRef,
    authorityRef: await retentionHoldDatabaseAuthority(database),
  })
}

function parseOperatorDocument(input) {
  if (!isPlainObject(input) || !exactKeys(input, ['schemaVersion', 'target', 'policy', 'grants']))
    throw new Error('INVALID_OPERATOR_POLICY')
  if (input.schemaVersion !== 1 || !Array.isArray(input.grants))
    throw new Error('INVALID_OPERATOR_POLICY')
  return {
    schemaVersion: 1,
    target: parseTargetShape(input.target),
    policy: input.policy,
    grants: input.grants,
  }
}

function parseTargetShape(input) {
  if (!isPlainObject(input)) throw new Error('INVALID_TARGET')
  if (input.backend === 'sqlite' && exactKeys(input, ['backend', 'database'])) {
    if (typeof input.database !== 'string' || !isAbsolute(input.database))
      throw new Error('INVALID_TARGET')
    return { backend: 'sqlite', database: input.database }
  }
  if (
    input.backend === 'postgres' &&
    (exactKeys(input, ['backend', 'database', 'host']) ||
      exactKeys(input, ['backend', 'database', 'host', 'port'])) &&
    typeof input.database === 'string' &&
    input.database.length > 0 &&
    typeof input.host === 'string' &&
    input.host.length > 0
  ) {
    // Older policies omitted the port, which historically meant PostgreSQL's
    // default. Preserve those policies only for that exact endpoint.
    const port = input.port === undefined ? 5432 : input.port
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_TARGET')
    return { backend: 'postgres', database: input.database, host: input.host, port }
  }
  throw new Error('INVALID_TARGET')
}

async function parseTarget(input) {
  const target = parseTargetShape(input)
  if (target.backend === 'sqlite') {
    const canonical = await realpath(target.database)
    return { backend: 'sqlite', database: canonical }
  }
  return target
}

function sameTarget(configured, actual) {
  return (
    configured.backend === actual.backend &&
    configured.database === actual.database &&
    (configured.backend !== 'postgres' ||
      (configured.host === actual.host && configured.port === actual.port))
  )
}

function parseGrants(input, policy) {
  const seen = new Set()
  return input.map((value) => {
    if (
      !isPlainObject(value) ||
      !exactKeys(value, ['actorPrincipalRef', 'authorityRef', 'classId', 'scope', 'actions']) ||
      typeof value.actorPrincipalRef !== 'string' ||
      value.actorPrincipalRef.length === 0 ||
      value.actorPrincipalRef.length > 256 ||
      typeof value.authorityRef !== 'string' ||
      value.authorityRef.length === 0 ||
      value.authorityRef.length > 256 ||
      typeof value.classId !== 'string' ||
      !Object.hasOwn(policy, value.classId) ||
      !Array.isArray(value.actions) ||
      value.actions.length === 0 ||
      value.actions.some((action) => typeof action !== 'string' || !ACTIONS.has(action)) ||
      new Set(value.actions).size !== value.actions.length
    )
      throw new Error('INVALID_OPERATOR_GRANT')
    const scope = RetentionHoldScopeSchema.parse(value.scope)
    const key = JSON.stringify([value.actorPrincipalRef, value.authorityRef, value.classId, scope])
    if (seen.has(key)) throw new Error('DUPLICATE_OPERATOR_GRANT')
    seen.add(key)
    return { ...value, scope }
  })
}

function scopeContains(grant, requested) {
  if (grant.kind === 'class') return true
  if (requested.kind === 'class' || grant.workspaceId !== requested.workspaceId) return false
  if (grant.kind === 'workspace') return true
  return requested.kind === 'project' && grant.projectId === requested.projectId
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).toSorted()
  const expected = keys.toSorted()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
