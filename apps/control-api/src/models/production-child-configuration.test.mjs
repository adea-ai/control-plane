import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProductionPiLeadComposition } from './production-model-composition.ts'

test('incomplete child authority or runtime denies before directory or SQLite creation', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pi-child-configuration-'))
  const fn = async () => {}
  const complete = {
    authority: { readCurrent: fn, admit: fn, assertCurrent: fn },
    forgetCanonicalModels: () => {},
    modelAuthority: {
      forExecution: fn,
      readRecordedDecision: fn,
      leasePrincipalRef: 'lease',
      modelAlias: 'child',
    },
    runtime: {
      governedDelegateChild: { prepare: fn },
      childProgress: { scan: fn },
      parentInbox: { list: fn },
      consumeParentInbox: fn,
      tools: { service: { execute: fn }, assertAuthority: fn },
    },
  }
  const malformed = [null, {}, { ...complete, runtime: {} }]
  for (const group of ['authority', 'modelAuthority', 'runtime']) {
    for (const key of Object.keys(complete[group])) {
      malformed.push({ ...complete, [group]: { ...complete[group], [key]: undefined } })
    }
  }
  malformed.push({ ...complete, forgetCanonicalModels: undefined })
  for (const [group, key] of [
    ['governedDelegateChild', 'prepare'],
    ['childProgress', 'scan'],
    ['parentInbox', 'list'],
    ['tools', 'assertAuthority'],
  ]) {
    malformed.push({
      ...complete,
      runtime: { ...complete.runtime, [group]: { ...complete.runtime[group], [key]: undefined } },
    })
  }
  try {
    for (const [index, children] of malformed.entries()) {
      const directory = join(parent, String(index))
      await expect(
        createProductionPiLeadComposition({
          directory,
          fundingDirectory: parent,
          admission: { scopeAuthority: {} },
          product: { readCurrent: fn },
          profiles: { resolveImmutable: fn },
          publicationAuthority: fn,
          releaseExpired: fn,
          reconcileInference: fn,
          modelConnections: { currentAccountAuthority: { readCurrent: fn } },
          children,
        })
      ).rejects.toThrow('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
      expect(existsSync(directory)).toBe(false)
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
