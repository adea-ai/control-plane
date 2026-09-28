import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { InventoryCredentialFenceInvalidError } from './runtime-credential-fence.ts'

describe('PostgreSQL runtime inventory credential fence', () => {
  test('normalizes invalid credential identity failures', () => {
    expect(new InventoryCredentialFenceInvalidError()).toMatchObject({
      name: 'InventoryCredentialFenceInvalidError',
      message: 'INVENTORY_CREDENTIAL_FENCE_INVALID',
      code: 'INVENTORY_CREDENTIAL_FENCE_INVALID',
    })
  })

  test('migration exposes only the row-locking writer fence to the application role', async () => {
    const migration = await readFile(
      new URL('../drizzle/0054_funny_santa_claus.sql', import.meta.url),
      'utf8'
    )
    const helperStart = migration.indexOf(
      'CREATE FUNCTION public.lock_runtime_node_credential_for_write('
    )
    const helperEnd = migration.indexOf('$runtime_node_inventory_credential_lock$;', helperStart)
    const helper = migration.slice(helperStart, helperEnd)

    expect(helperStart).toBeGreaterThanOrEqual(0)
    expect(helper).toContain('SECURITY DEFINER')
    expect(helper).toContain('FOR SHARE OF credential, verification_key')
    expect(helper.indexOf('FOR SHARE OF credential, verification_key')).toBeLessThan(
      helper.indexOf('actual_expires_at > clock_timestamp()')
    )
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.lock_runtime_node_credential_for_write(varchar, bigint, varchar, varchar) FROM PUBLIC'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.lock_runtime_node_credential_for_write(varchar, bigint, varchar, varchar) TO control_plane_app'
    )
    expect(migration).not.toContain(
      'GRANT UPDATE ON TABLE public.runtime_node_verification_keys TO control_plane_app'
    )
  })
})
