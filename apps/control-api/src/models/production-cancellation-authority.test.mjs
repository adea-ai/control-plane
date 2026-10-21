import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InMemoryExecutionRepository,
  InMemoryCommandAcceptanceRepository,
} from '@control-plane/domain'
import { InMemoryModelSelectionRepository } from '@control-plane/model-gateway'
import { InMemoryUsageLedger } from '@control-plane/usage-ledger'
import { createProductionPiLeadComposition } from './production-model-composition.ts'

const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}

function options(directory, committedCancellationAuthority) {
  return {
    directory,
    fundingDirectory: directory,
    modelConnections: {
      repository: new InMemoryModelSelectionRepository(),
      vault: { metadata: async () => undefined },
      currentAccountAuthority: { readCurrent: async () => undefined },
    },
    product: { readCurrent: async () => undefined },
    profiles: { resolveImmutable: async () => undefined },
    readiness: {
      gateway: { assertRequestReady: async () => undefined },
      target,
      buildRequest: async () => ({}),
    },
    admission: {
      scopeAuthority: { readCurrent: async () => undefined },
      executions: new InMemoryExecutionRepository(),
      commandRepository: new InMemoryCommandAcceptanceRepository(),
      planValidator: {
        authorize: async () => ({ outcome: 'denied' }),
        validate: async () => false,
      },
      plans: { get: async () => undefined },
      resolvePlan: async () => undefined,
      budgetAdmission: { reserve: async () => undefined },
      admissionPrincipalId: 'svc_agent-hq',
    },
    ledger: new InMemoryUsageLedger(),
    reconcileInference: async () => undefined,
    releaseExpired: async () => undefined,
    publicationAuthority: async () => undefined,
    leasePrincipalRef: 'lease:pi-production-test',
    modelAlias: 'pi-lead',
    ...(committedCancellationAuthority ? { committedCancellationAuthority } : {}),
  }
}

test('production composition never activates an old cancellation outbox object during construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-production-cancellation-authority-'))
  let observedThis
  const authority = {
    commit: async () => {
      throw new Error('commit is not exercised during composition')
    },
    pendingHandles() {
      observedThis = this
      return Promise.resolve([])
    },
    pendingForHandle: async () => [],
    acknowledge: async () => undefined,
  }
  let composition
  try {
    composition = await createProductionPiLeadComposition(options(directory, authority))
    expect(observedThis).toBeUndefined()
    const inspection = await composition.adapter.inspect()
    expect(inspection.capabilities.some(({ name }) => name === 'execution.cancel')).toBe(true)
  } finally {
    await composition?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('production composition preserves ordinary cancellation without an irreversible owner grant', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-production-cancellation-unavailable-'))
  let composition
  try {
    composition = await createProductionPiLeadComposition(options(directory))
    const inspection = await composition.adapter.inspect()
    expect(inspection.capabilities.some(({ name }) => name === 'execution.cancel')).toBe(true)
  } finally {
    await composition?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
