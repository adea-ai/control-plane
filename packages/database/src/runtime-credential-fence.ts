import type { CredentialRevocationFence } from '@control-plane/domain'
import { sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'

type CredentialFenceTransaction = Pick<
  Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0],
  'execute'
>

export class InventoryCredentialFenceInvalidError extends Error {
  readonly code = 'INVENTORY_CREDENTIAL_FENCE_INVALID' as const

  constructor() {
    super('INVENTORY_CREDENTIAL_FENCE_INVALID')
    this.name = 'InventoryCredentialFenceInvalidError'
  }
}

/**
 * Locks and validates the credential and verification key through this
 * transaction's commit. The SECURITY DEFINER function is intentionally the
 * only write-time identity access available to the gateway application role.
 */
export async function assertRuntimeCredentialFence(
  transaction: CredentialFenceTransaction,
  fence: CredentialRevocationFence | undefined,
  scope: { readonly nodeId: string; readonly workspaceId: string }
): Promise<void> {
  if (
    !fence ||
    typeof fence.credentialId !== 'string' ||
    fence.credentialId.length === 0 ||
    !Number.isSafeInteger(fence.revocationVersion) ||
    fence.revocationVersion < 1 ||
    Object.keys(fence).length !== 2 ||
    !Object.hasOwn(fence, 'credentialId') ||
    !Object.hasOwn(fence, 'revocationVersion')
  )
    throw new InventoryCredentialFenceInvalidError()

  const [identity] = await transaction.execute(sql`
    select public.lock_runtime_node_credential_for_write(
      ${fence.credentialId}::varchar,
      ${fence.revocationVersion}::bigint,
      ${scope.nodeId}::varchar,
      ${scope.workspaceId}::varchar
    ) as valid
  `)
  if (identity?.['valid'] !== true) throw new InventoryCredentialFenceInvalidError()
}
