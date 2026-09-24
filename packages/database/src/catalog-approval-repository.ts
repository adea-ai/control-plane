import { and, asc, eq } from 'drizzle-orm'
import {
  CatalogApprovalDecisionSchema,
  type CatalogApprovalDecision,
  type CatalogApprovalRepository,
  type CatalogVersionKind,
} from '@control-plane/domain'
import type { ControlPlaneDatabase } from './connection.js'
import { catalogApprovals } from './schema/catalog.js'

const parse = <Value>(input: unknown): Value => CatalogApprovalDecisionSchema.parse(input) as Value

function approvalRow(input: CatalogApprovalDecision) {
  return {
    versionKind: input.versionKind,
    versionId: input.versionId,
    revision: input.revision,
    contentDigest: input.contentDigest,
    decision: input.decision,
    actorPrincipalRef: input.actorPrincipalRef,
    authorityRef: input.authorityRef ?? null,
    rationale: input.rationale ?? null,
    decidedAt: new Date(input.decidedAt),
  }
}

function decisionFromRow(row: typeof catalogApprovals.$inferSelect) {
  return {
    versionKind: row.versionKind,
    versionId: row.versionId,
    revision: row.revision,
    contentDigest: row.contentDigest,
    decision: row.decision,
    actorPrincipalRef: row.actorPrincipalRef,
    ...(row.authorityRef === null ? {} : { authorityRef: row.authorityRef }),
    ...(row.rationale === null ? {} : { rationale: row.rationale }),
    decidedAt: row.decidedAt.toISOString(),
  }
}

/**
 * PostgreSQL persistence for catalog approval decisions (#188): append-only
 * per (versionKind, versionId, revision) — the composite primary key makes the
 * insert idempotent under concurrency, and a decision is never updated.
 */
export class PostgresCatalogApprovalRepository implements CatalogApprovalRepository {
  constructor(private readonly database: ControlPlaneDatabase) {}

  async insert(decision: CatalogApprovalDecision): Promise<boolean> {
    const result = await this.database
      .insert(catalogApprovals)
      .values(approvalRow(CatalogApprovalDecisionSchema.parse(decision)))
      .onConflictDoNothing()
      .returning({ revision: catalogApprovals.revision })
    return result.length === 1
  }

  async list(
    versionKind: CatalogVersionKind,
    versionId: string
  ): Promise<readonly CatalogApprovalDecision[]> {
    const rows = await this.database
      .select()
      .from(catalogApprovals)
      .where(
        and(
          eq(catalogApprovals.versionKind, versionKind),
          eq(catalogApprovals.versionId, versionId)
        )
      )
      .orderBy(asc(catalogApprovals.revision))
    return rows.map((row) => parse<CatalogApprovalDecision>(decisionFromRow(row)))
  }
}
