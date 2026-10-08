import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiDurableRuntimeAdapter } from '../packages/pi-durable-adapter/src/adapter.ts'
import { fixture } from '../packages/pi-durable-adapter/src/adapter.fixture.mjs'
import {
  workspacePlan,
  currentScope,
  explicitProjectPlan,
} from './pi-durable-workspace-scope.fixture.mjs'

function scoped(directory, overrides = {}, plan = workspacePlan()) {
  const base = fixture(directory)
  const admission = { ...base.admission, canonicalActorPrincipalId: 'product:user' }
  const request = {
    ...base.request,
    executionPlan: plan,
    attemptBudget: {
      ...base.request.attemptBudget,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
    },
  }
  const reads = []
  const options = {
    ...base.options,
    resolveAdmission: async () => admission,
    scopeAuthority: {
      readCurrent: async (input) => {
        reads.push(structuredClone(input))
        return currentScope(input)
      },
    },
    ...overrides,
  }
  return { request, admission, options, reads }
}

async function usingFixture(operation) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-workspace-scope-'))
  const adapters = []
  const open = (options) => {
    const adapter = new PiDurableRuntimeAdapter(options)
    adapters.push(adapter)
    return adapter
  }
  try {
    await operation(directory, open)
  } finally {
    for (const adapter of adapters) await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

test('workspace capability requires server scope authority and unconfigured adapter admits no records', async () => {
  await usingFixture(async (directory, open) => {
    const setup = scoped(directory, { scopeAuthority: undefined })
    const adapter = open(setup.options)
    expect(
      (await adapter.inspect()).capabilities.some((c) => c.name === 'execution.scope.workspace.v1')
    ).toBe(false)
    await expect(adapter.start(setup.request)).rejects.toThrow('PI_PLAN_RUNTIME_INELIGIBLE')
    expect(adapter.journal.list()).toHaveLength(0)
  })
})

test('qualified workspace admission rechecks exact scope, canonical actor and immutable plan on execution', async () => {
  await usingFixture(async (directory, open) => {
    const setup = scoped(directory)
    const adapter = open(setup.options)
    expect((await adapter.inspect()).capabilities).toContainEqual({
      name: 'execution.scope.workspace.v1',
      support: 'supported',
    })
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    expect((await adapter.status(handle)).state).toBe('completed')
    expect(setup.reads.length).toBeGreaterThanOrEqual(2)
    for (const read of setup.reads) {
      expect(read).toEqual({
        ...setup.request.executionPlan.correlation,
        callerPrincipalId: 'product:user',
        executionPlan: {
          executionPlanId: setup.request.executionPlan.executionPlanId,
          contentDigest: setup.request.executionPlan.contentDigest,
          schemaVersion: 2,
        },
      })
      expect(read.projectId).toBeUndefined()
    }
  })
})

test.each([
  { principalActive: false },
  { grantActive: false },
  { allowedPrincipalIds: [] },
  { allowedPrincipalIds: ['transport:service-reader'] },
  { callerPrincipalId: 'product:other' },
  { workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' },
  { expiresAt: '2026-10-08T00:00:00.000Z' },
  {
    executionScope: {
      schemaVersion: 1,
      kind: 'project',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    },
  },
  {
    executionPlan: {
      schemaVersion: 2,
      executionPlanId: 'plan_forged',
      contentDigest: `sha256:${'b'.repeat(64)}`,
    },
  },
])('current workspace authority fails closed before admission: %j', async (override) => {
  await usingFixture(async (directory, open) => {
    const setup = scoped(directory, {
      scopeAuthority: { readCurrent: async (input) => currentScope(input, override) },
    })
    const adapter = open(setup.options)
    await expect(adapter.start(setup.request)).rejects.toThrow('PI_AUTHORITY_REJECTED')
    expect(adapter.journal.list()).toHaveLength(0)
  })
})

test('workspace target and capability cannot substitute for retained canonical actor', async () => {
  await usingFixture(async (directory, open) => {
    const setup = scoped(directory)
    delete setup.admission.canonicalActorPrincipalId
    const adapter = open(setup.options)
    await expect(adapter.start(setup.request)).rejects.toThrow('PI_AUTHORITY_REJECTED')
    expect(adapter.journal.list()).toHaveLength(0)
  })
})

test('revoked scope denies actual SQLite reopen reconcile and session resume without replay', async () => {
  await usingFixture(async (directory, open) => {
    let grantActive = true
    let sends = 0
    const setup = scoped(directory, {
      scopeAuthority: { readCurrent: async (input) => currentScope(input, { grantActive }) },
      engineFactory: async () => ({
        run: async () => {
          sends++
          throw new Error('mock interrupted inference')
        },
        close: async () => {},
        cancel: async () => {},
      }),
    })
    const adapter = open(setup.options)
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    expect((await adapter.status(handle)).state).toBe('unknown')
    await adapter.close()
    grantActive = false
    const reopened = open(setup.options)
    const retained = reopened.journal.get(handle.handleId)
    await expect(reopened.reconcile(handle)).rejects.toThrow('PI_AUTHORITY_REJECTED')
    await expect(
      reopened.session({ operation: 'resume', sessionId: handle.externalSessionId })
    ).rejects.toThrow('PI_AUTHORITY_REJECTED')
    expect(reopened.journal.get(handle.handleId)).toEqual(retained)
    expect(sends).toBe(1)
  })
})

test('provider boundary callback rereads a grant revoked after native engine creation', async () => {
  await usingFixture(async (directory, open) => {
    let grantActive = true
    let sends = 0
    const setup = scoped(directory, {
      scopeAuthority: { readCurrent: async (input) => currentScope(input, { grantActive }) },
      engineFactory: async (options) => {
        grantActive = false
        return {
          run: async () => {
            await options.assertAuthority()
            sends++
            throw new Error('unreachable')
          },
          close: async () => {},
          cancel: async () => {},
        }
      },
    })
    const adapter = open(setup.options)
    const handle = await adapter.start(setup.request)
    await adapter.drain()
    expect(sends).toBe(0)
    expect((await adapter.status(handle)).state).toBe('unknown')
  })
})

test('explicit project plan2 requires current authority and the real project workspace binding', async () => {
  await usingFixture(async (directory, open) => {
    const plan = explicitProjectPlan()
    expect(plan.schemaVersion).toBe(2)
    const missing = scoped(directory, { scopeAuthority: undefined }, plan)
    await expect(open(missing.options).start(missing.request)).rejects.toThrow(
      'PI_AUTHORITY_REJECTED'
    )
    const foreign = scoped(
      directory,
      {
        scopeAuthority: {
          readCurrent: async (input) =>
            currentScope(input, { projectWorkspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' }),
        },
      },
      plan
    )
    await expect(open(foreign.options).start(foreign.request)).rejects.toThrow(
      'PI_AUTHORITY_REJECTED'
    )
    const ready = scoped(directory, {}, plan)
    const adapter = open(ready.options)
    const handle = await adapter.start(ready.request)
    await adapter.drain()
    expect((await adapter.status(handle)).state).toBe('completed')
  })
})
