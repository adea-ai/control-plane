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
    createGovernedDelegateChild: fn,
    delegation: {
      records: {
        insert: fn,
        get: fn,
        findByChild: fn,
        listByParent: fn,
        compareAndSet: fn,
        allocate: fn,
      },
      lifecycle: { getExecution: fn },
      plans: { get: fn },
      events: { publish: fn, list: fn },
      scopeAdmission: { resolveCallerPrincipalId: fn },
      readCurrent: fn,
    },
    modelAuthority: {
      forExecution: fn,
      readRecordedDecision: fn,
      leasePrincipalRef: 'lease',
      modelAlias: 'child',
    },
    tools: { service: { execute: fn }, interactions: { get: fn } },
    runtime: {
      childProgress: { scan: fn },
      consumeParentInbox: fn,
    },
  }
  const malformed = [null, {}, { ...complete, runtime: {} }]
  for (const group of ['authority', 'delegation', 'modelAuthority', 'runtime', 'tools']) {
    for (const key of Object.keys(complete[group])) {
      malformed.push({ ...complete, [group]: { ...complete[group], [key]: undefined } })
    }
  }
  malformed.push({ ...complete, forgetCanonicalModels: undefined })
  malformed.push({ ...complete, createGovernedDelegateChild: undefined })
  for (const [group, key] of [['childProgress', 'scan']]) {
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
