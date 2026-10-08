import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { executionScopeOf } from '@control-plane/contracts'
import { z } from 'zod'
import {
  CommandInboxScopeSchema,
  commandInboxScopeKey,
  type CommandInboxScope,
} from './command-inbox.js'

export const RETIRED_COMMAND_KEY_METADATA_VERSION = 2 as const

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)

/** The retained proof is fixed-size and never contains the original scope values. */
export const RetiredCommandKeyMetadataSchema = z
  .object({
    metadataVersion: z.literal(RETIRED_COMMAND_KEY_METADATA_VERSION),
    identityDigest: Sha256HexSchema,
  })
  .strict()

export interface RetiredCommandKeyMetadata {
  readonly metadataVersion: typeof RETIRED_COMMAND_KEY_METADATA_VERSION
  readonly identityDigest: string
  readonly scopeKey: string
}

/** Exact v1 representation retained for replay compatibility during migration. */
export function retiredCommandScopeV1(scopeInput: CommandInboxScope): string {
  const scope = CommandInboxScopeSchema.parse(scopeInput)
  return commandInboxScopeKey(scope)
}

/** Exact v1 PostgreSQL key, retained for pre-migration tombstone lookup. */
export function retiredCommandKeyV1(scopeInput: CommandInboxScope): string {
  return sha256(retiredCommandScopeV1(scopeInput))
}

/**
 * Version 2 commits to the validated scoped identity without retaining its
 * values. The outer key can be recomputed from the stored fixed-size digest,
 * while a replay computes both digests from its supplied scope.
 */
export function retiredCommandKeyMetadataV2(
  scopeInput: CommandInboxScope
): RetiredCommandKeyMetadata {
  const scope = CommandInboxScopeSchema.parse(scopeInput)
  // Explicit project spelling must still find pre-scope tombstones.
  const { executionScope: _executionScope, ...legacyProjectScope } = scope
  const identityScope = executionScopeOf(scope).kind === 'project' ? legacyProjectScope : scope
  const canonicalIdentity = canonicalJsonStringify({ version: 2, scope: identityScope })
  if (canonicalIdentity === undefined) throw new Error('RETIRED_COMMAND_KEY_IDENTITY_INVALID')
  const identityDigest = sha256(
    `control-plane.retired-command-identity:v2\u0000${canonicalIdentity}`
  )
  return {
    metadataVersion: RETIRED_COMMAND_KEY_METADATA_VERSION,
    identityDigest,
    scopeKey: retiredCommandKeyFromMetadataV2(identityDigest),
  }
}

/** Re-derive the stored v2 scope key without persisting or exposing scope values. */
export function retiredCommandKeyFromMetadataV2(identityDigestInput: string): string {
  const identityDigest = Sha256HexSchema.parse(identityDigestInput)
  return sha256(`control-plane.retired-command-key:v2\u0000${identityDigest}`)
}

/** The safe lookup pair keeps legacy rows rejecting replays until expiry. */
export function retiredCommandKeyCandidates(scopeInput: CommandInboxScope): {
  readonly legacyScope: string
  readonly legacyKey: string
  readonly metadata: RetiredCommandKeyMetadata
} {
  const scope = CommandInboxScopeSchema.parse(scopeInput)
  return {
    legacyScope: retiredCommandScopeV1(scope),
    legacyKey: retiredCommandKeyV1(scope),
    metadata: retiredCommandKeyMetadataV2(scope),
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
