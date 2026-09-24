import { ForbiddenException } from '@nestjs/common'
import {
  evaluateVersionApproval,
  type CatalogApprovalPolicy,
  type CatalogApprovalRepository,
  type CatalogVersionKind,
} from '@control-plane/domain'

/**
 * Shared approval enforcement for control-api resolution and validation
 * services (#188): the same decision semantics everywhere, denied with a
 * stable `<KIND>_APPROVAL_*` code. Callers pass the version's current
 * revision/digest so stale decisions never count.
 */
export interface CatalogApprovalGateOptions {
  readonly approvals: Pick<CatalogApprovalRepository, 'list'>
  readonly policy: CatalogApprovalPolicy
}

export async function assertCatalogVersionApproved(
  gate: CatalogApprovalGateOptions,
  label: 'PROFILE' | 'SKILL',
  versionKind: CatalogVersionKind,
  versionId: string,
  version: {
    readonly revision: number
    readonly contentDigest: string
    readonly publishedAt?: string | undefined
  }
): Promise<void> {
  const { verdict, reason } = await evaluateVersionApproval({
    approvals: gate.approvals,
    versionKind,
    versionId,
    policy: gate.policy,
    version,
  })
  if (verdict === 'approved' || verdict === 'not_required' || verdict === 'grandfathered') return
  const code = verdict === 'rejected' ? `${label}_APPROVAL_REJECTED` : `${label}_APPROVAL_MISSING`
  throw new ForbiddenException({ code, message: 'Catalog version approval is required', reason })
}
