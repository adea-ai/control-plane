import { z } from 'zod'
import type { AgentProfileRepository, SkillRepository } from './versioned-catalog.js'

/**
 * Catalog version approval decisions (#188, CP-PRD-PROFILE-APPROVE-001).
 *
 * An approval is a separate, version/digest-bound record with an attributable
 * actor — deliberately NOT the publication lifecycle state: publication and
 * approval are distinct facts, and this module records the latter. Decisions
 * are append-only per version revision; the latest revision's decision is the
 * current one. No execution path consults these records yet: recording an
 * approval never changes resolution or execution behavior on its own.
 */

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const CatalogVersionKindSchema = z.enum(['agent_profile', 'skill'])
export type CatalogVersionKind = z.output<typeof CatalogVersionKindSchema>

export const CatalogApprovalDecisionSchema = z
  .object({
    versionKind: CatalogVersionKindSchema,
    versionId: z.string().min(1).max(128),
    /** Version revision the decision was made against; stale revisions are refused. */
    revision: z.number().int().positive(),
    /** Content digest the decision is bound to; a mismatch means the version changed. */
    contentDigest: DigestSchema,
    decision: z.enum(['approved', 'rejected']),
    /** Authenticated principal recording the decision. */
    actorPrincipalRef: z.string().min(1).max(256),
    /** Authority the actor acted under (e.g. a scoped grant reference). */
    authorityRef: z.string().min(1).max(256).optional(),
    rationale: z.string().min(1).max(1024).optional(),
    decidedAt: TimestampSchema,
  })
  .strict()
export type CatalogApprovalDecision = z.output<typeof CatalogApprovalDecisionSchema>

export interface CatalogApprovalRepository {
  /** Appends a decision for its (versionKind, versionId, revision); false if one exists. */
  insert(decision: CatalogApprovalDecision): Promise<boolean>
  list(
    versionKind: CatalogVersionKind,
    versionId: string
  ): Promise<readonly CatalogApprovalDecision[]>
}

export type CatalogApprovalErrorCode =
  | 'CATALOG_APPROVAL_VERSION_MISSING'
  | 'CATALOG_APPROVAL_VERSION_NOT_APPROVABLE'
  | 'CATALOG_APPROVAL_STALE_VERSION'
  | 'CATALOG_APPROVAL_CONFLICT'

export class CatalogApprovalError extends Error {
  constructor(
    readonly code: CatalogApprovalErrorCode,
    readonly reference?: string
  ) {
    super(code)
    this.name = 'CatalogApprovalError'
  }
}

export interface CatalogApprovalServiceOptions {
  readonly approvals: CatalogApprovalRepository
  readonly versions: Pick<AgentProfileRepository, 'getAgentProfileVersion'> &
    Pick<SkillRepository, 'getSkillVersion'>
}

export class CatalogApprovalService {
  readonly #approvals: CatalogApprovalRepository
  readonly #versions: CatalogApprovalServiceOptions['versions']

  constructor(options: CatalogApprovalServiceOptions) {
    this.#approvals = options.approvals
    this.#versions = options.versions
  }

  /**
   * Records an approval or rejection against a version revision.
   *
   * Refusals (fail closed, no record written):
   * - unknown version → `CATALOG_APPROVAL_VERSION_MISSING`
   * - revoked or superseded version → `CATALOG_APPROVAL_VERSION_NOT_APPROVABLE`
   * - decision revision/digest not the version's current pair →
   *   `CATALOG_APPROVAL_STALE_VERSION` (approve what is actually there)
   *
   * Replay semantics: an identical decision (same revision, digest, decision
   * and actor) returns the recorded decision with `replayed: true`; a
   * different decision for the same revision → `CATALOG_APPROVAL_CONFLICT`.
   */
  async decide(
    input: unknown
  ): Promise<{ readonly decision: CatalogApprovalDecision; readonly replayed: boolean }> {
    const decision = CatalogApprovalDecisionSchema.parse(input)
    const version = await this.#load(decision.versionKind, decision.versionId)
    if (version === undefined) {
      throw new CatalogApprovalError('CATALOG_APPROVAL_VERSION_MISSING', decision.versionId)
    }
    if (version.lifecycle === 'revoked' || version.lifecycle === 'superseded') {
      throw new CatalogApprovalError('CATALOG_APPROVAL_VERSION_NOT_APPROVABLE', decision.versionId)
    }
    if (
      version.revision !== decision.revision ||
      version.contentDigest !== decision.contentDigest
    ) {
      throw new CatalogApprovalError('CATALOG_APPROVAL_STALE_VERSION', decision.versionId)
    }
    if (await this.#approvals.insert(decision)) return { decision, replayed: false }
    const existing = (await this.#approvals.list(decision.versionKind, decision.versionId)).find(
      (candidate) => candidate.revision === decision.revision
    )
    if (
      existing !== undefined &&
      existing.contentDigest === decision.contentDigest &&
      existing.decision === decision.decision &&
      existing.actorPrincipalRef === decision.actorPrincipalRef
    ) {
      return { decision: existing, replayed: true }
    }
    throw new CatalogApprovalError('CATALOG_APPROVAL_CONFLICT', decision.versionId)
  }

  /** The latest-revision decision recorded for a version, if any. */
  async inspect(input: {
    readonly versionKind: CatalogVersionKind
    readonly versionId: string
  }): Promise<CatalogApprovalDecision | undefined> {
    const kind = CatalogVersionKindSchema.parse(input.versionKind)
    const decisions = await this.#approvals.list(kind, input.versionId)
    return decisions.reduce<CatalogApprovalDecision | undefined>(
      (latest, candidate) =>
        latest === undefined || candidate.revision > latest.revision ? candidate : latest,
      undefined
    )
  }

  async #load(
    kind: CatalogVersionKind,
    versionId: string
  ): Promise<
    | { readonly revision: number; readonly contentDigest: string; readonly lifecycle: string }
    | undefined
  > {
    if (kind === 'agent_profile') {
      const version = await this.#versions.getAgentProfileVersion(versionId)
      return version === undefined
        ? undefined
        : {
            revision: version.revision,
            contentDigest: version.contentDigest,
            lifecycle: version.lifecycle,
          }
    }
    const version = await this.#versions.getSkillVersion(versionId)
    return version === undefined
      ? undefined
      : {
          revision: version.revision,
          contentDigest: version.manifest.contentDigest,
          lifecycle: version.lifecycle,
        }
  }
}

export const CatalogApprovalAdministrationRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('approvals.record'),
      decision: CatalogApprovalDecisionSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('approvals.show'),
      versionKind: CatalogVersionKindSchema,
      versionId: z.string().min(1).max(128),
    })
    .strict(),
])
export type CatalogApprovalAdministrationRequest = z.output<
  typeof CatalogApprovalAdministrationRequestSchema
>

export interface CatalogApprovalAdministrationResult {
  readonly status: 'applied'
  readonly operation: CatalogApprovalAdministrationRequest['operation']
  readonly replayed?: boolean
  readonly decision?: CatalogApprovalDecision
}

/**
 * Scoped administration surface for approval records (#188): the operator CLI
 * is the authority boundary (OS/database access, never an unauthenticated
 * endpoint), mirroring ContextProviderAdministration. Recording and inspecting
 * decisions never enables gating — that remains a separate, explicit change.
 */
export class CatalogApprovalAdministration {
  readonly #service: CatalogApprovalService

  constructor(options: CatalogApprovalServiceOptions) {
    this.#service = new CatalogApprovalService(options)
  }

  async apply(input: unknown): Promise<CatalogApprovalAdministrationResult> {
    const request = CatalogApprovalAdministrationRequestSchema.parse(input)
    if (request.operation === 'approvals.record') {
      const recorded = await this.#service.decide(request.decision)
      return {
        status: 'applied',
        operation: request.operation,
        replayed: recorded.replayed,
        decision: recorded.decision,
      }
    }
    const decision = await this.#service.inspect({
      versionKind: request.versionKind,
      versionId: request.versionId,
    })
    return {
      status: 'applied',
      operation: request.operation,
      ...(decision === undefined ? {} : { decision }),
    }
  }
}
