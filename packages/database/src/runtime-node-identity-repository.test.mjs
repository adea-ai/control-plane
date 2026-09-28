import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  runtimeNodeIssuedCredentials,
  runtimeNodeVerificationKeys,
} from './schema/runtime-node-identity.ts'

describe('RuntimeNode identity persistence schema', () => {
  test('stores public keys and issued claims separately without token or private-key columns', () => {
    const keyColumns = getTableConfig(runtimeNodeVerificationKeys).columns.map(({ name }) => name)
    const credentialColumns = getTableConfig(runtimeNodeIssuedCredentials).columns.map(
      ({ name }) => name
    )

    expect(keyColumns).toEqual([
      'key_id',
      'node_id',
      'workspace_id',
      'public_key_pem',
      'thumbprint',
      'status',
      'created_at',
    ])
    expect(credentialColumns).toEqual([
      'credential_id',
      'node_id',
      'workspace_id',
      'key_id',
      'claims',
      'revocation_version',
      'issued_at',
      'expires_at',
      'revoked_at',
      'consumed_at',
    ])
    expect([...keyColumns, ...credentialColumns].join(' ')).not.toMatch(
      /private_key|credential_string|signature|secret/u
    )

    const keyTable = getTableConfig(runtimeNodeVerificationKeys)
    const credentialTable = getTableConfig(runtimeNodeIssuedCredentials)
    expect(keyTable.checks.map(({ name }) => name)).toContain(
      'runtime_node_verification_keys_status_check'
    )
    expect(credentialTable.foreignKeys).toHaveLength(1)
  })

  test('migration grants the gateway reads and consumption-only credential updates', async () => {
    const migration = await readFile(
      new URL('../drizzle/0054_funny_santa_claus.sql', import.meta.url),
      'utf8'
    )
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.runtime_node_verification_keys TO control_plane_app'
    )
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.runtime_node_issued_credentials TO control_plane_app'
    )
    expect(migration).toContain(
      'GRANT UPDATE (consumed_at) ON TABLE public.runtime_node_issued_credentials TO control_plane_app'
    )
    expect(migration).toContain('CREATE TRIGGER runtime_node_issued_credentials_consumption_once')
    expect(migration).toContain(
      'OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at'
    )
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.runtime_node_issued_credentials FROM control_plane_app'
    )
    expect(
      migration.indexOf('CREATE UNIQUE INDEX "runtime_node_verification_keys_scope_unique"')
    ).toBeLessThan(
      migration.indexOf('ADD CONSTRAINT "runtime_node_issued_credentials_key_scope_fk"')
    )
  })
})
