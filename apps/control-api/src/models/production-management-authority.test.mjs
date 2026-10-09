import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProductionPiLeadComposition } from './production-model-composition.ts'

/** Malformed canonical authority bindings must fail closed before any directory/SQLite allocation. */
test('malformed management authority denies before directory or SQLite creation', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pi-management-authority-'))
  const fn = async () => {}
  const base = {
    admission: { scopeAuthority: {} },
    modelConnections: { currentAccountAuthority: { readCurrent: fn } },
    product: { readCurrent: fn },
    profiles: { resolveImmutable: fn },
    publicationAuthority: fn,
    reconcileInference: fn,
    releaseExpired: fn,
  }
  const malformed = [
    { service: { execute: fn } },
    { service: { execute: fn }, interactions: {} },
    { service: {}, interactions: { get: fn } },
  ]
  try {
    for (const [index, managementAuthority] of malformed.entries()) {
      const directory = join(parent, String(index))
      await expect(
        createProductionPiLeadComposition({
          ...base,
          directory,
          fundingDirectory: parent,
          managementAuthority,
        })
      ).rejects.toThrow('PI_PRODUCTION_BINDING_REQUIRED')
      expect(existsSync(directory)).toBe(false)
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
