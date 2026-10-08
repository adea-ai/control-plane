import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGovernedChildCompositionFixture } from './pi-durable-governed-child-composition.fixture.mjs'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { PiDurableChildProgressScanner } from '../apps/control-api/src/pi-durable/child-progress-scanner.ts'

test('physical native child store reopen after observer fault publishes retained outcome once without a provider resend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'j1-native-child-store-restart-'))
  let f
  try {
    f = await createGovernedChildCompositionFixture(directory)
    expect((await f.storage.executions.getAttempt(f.leadRequest.attemptId)).state).toBe('queued')
    const lead = await f.leadRuntime.adapter.start(f.leadRequest)
    await f.leadRuntime.adapter.drain()
    await f.childRuntime.adapter.drain()
    expect((await f.leadRuntime.adapter.status(lead)).state).toBe('completed')
    expect(f.state.parentAtChildAdmission).toEqual([{ execution: 'running', attempt: 'running' }])
    const childRequest = f.host.starts[0]
    const childHandle = await f.childRuntime.adapter.start(childRequest)
    const terminal = await f.childRuntime.adapter.status(childHandle)
    expect(terminal.state).toBe('completed')
    const originalAdmission = await f.storage.admissions.getByRequestId(f.host.request.requestId)
    const faulted = new PiDurableChildProgressScanner({
      ...f.scanner.options,
      bridge: {
        async recordProgress(identity, progress) {
          await f.host.bridge.recordProgress(identity, progress)
          if (progress.state === 'running') throw new Error('INJECTED_AFTER_CANONICAL_RUNNING')
        },
      },
    })
    expect((await faulted.scan(f.childRuntime.adapter)).blocked).toHaveLength(1)
    expect((await f.storage.delegations.get(f.ids.delegationId)).state).toBe('running')
    expect(
      (await f.storage.events.list()).filter((row) => row.type === 'delegation.completed')
    ).toHaveLength(0)
    await f.reopenChild()
    expect(await f.childRuntime.adapter.start(childRequest)).toEqual(childHandle)
    expect((await f.childRuntime.adapter.status(childHandle)).result).toEqual(terminal.result)
    const resumed = new PiDurableChildProgressScanner(f.scanner.options)
    expect(await resumed.scan(f.childRuntime.adapter)).toEqual({
      published: 1,
      skipped: 0,
      blocked: [],
    })
    expect(await resumed.scan(f.childRuntime.adapter)).toEqual({
      published: 1,
      skipped: 0,
      blocked: [],
    })
    expect((await f.storage.delegations.get(f.ids.delegationId)).terminalPublication.status).toBe(
      'published'
    )
    expect(
      (await f.storage.events.list()).filter((row) => row.type === 'delegation.completed')
    ).toHaveLength(1)
    expect(await f.storage.admissions.getByRequestId(f.host.request.requestId)).toEqual(
      originalAdmission
    )
    expect(f.host.starts).toHaveLength(1)
    expect(f.child.requests).toHaveLength(1)
    expect(f.parentNative.requests).toHaveLength(2)
    expect(
      (await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)).filter(
        (row) => row.kind === 'model_usage'
      )
    ).toHaveLength(1)
    expect((await f.storage.executions.getExecution(f.ids.parentExecutionId)).state).toBe('running')
  } finally {
    await f?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('canonical parent termination denies a new child start while previously committed child evidence remains retainable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'j1-parent-terminal-evidence-'))
  let f
  try {
    f = await createGovernedChildCompositionFixture(directory)
    const lead = await f.leadRuntime.adapter.start(f.leadRequest)
    await f.leadRuntime.adapter.drain()
    await f.childRuntime.adapter.drain()
    expect((await f.leadRuntime.adapter.status(lead)).state).toBe('completed')
    const childRequest = f.host.starts[0]
    const childHandle = await f.childRuntime.adapter.start(childRequest)
    const childResult = await f.childRuntime.adapter.status(childHandle)
    expect(childResult.state).toBe('completed')
    const lifecycle = new ExecutionLifecycleService(f.storage.executions)
    const parentAttempt = await f.storage.executions.getAttempt(f.leadRequest.attemptId)
    await lifecycle.transitionAttempt({
      attemptId: parentAttempt.attemptId,
      expectedVersion: parentAttempt.version,
      to: 'completed',
      transitionedAt: '2026-08-25T18:03:00.000Z',
    })
    const parent = await lifecycle.getExecution(f.ids.parentExecutionId)
    await lifecycle.transitionExecution({
      executionId: parent.executionId,
      expectedVersion: parent.version,
      to: 'completed',
      transitionedAt: '2026-08-25T18:03:00.000Z',
    })
    await f.reopenChild()
    await expect(f.host.bridge.startChild(f.identity)).rejects.toThrow(
      'DELEGATION_RUNTIME_ADMISSION_DENIED'
    )
    expect(f.host.starts).toHaveLength(1)
    expect(f.child.requests).toHaveLength(1)
    const scanner = new PiDurableChildProgressScanner(f.scanner.options)
    expect(await scanner.scan(f.childRuntime.adapter)).toEqual({
      published: 1,
      skipped: 0,
      blocked: [],
    })
    expect(await scanner.scan(f.childRuntime.adapter)).toEqual({
      published: 1,
      skipped: 0,
      blocked: [],
    })
    expect(
      (await f.storage.events.list()).filter((row) => row.type === 'delegation.completed')
    ).toHaveLength(1)
    const terminal = await f.storage.delegations.get(f.ids.delegationId)
    expect(terminal.terminalPublication.status).toBe('published')
    expect((await f.storage.executions.getExecution(f.ids.parentExecutionId)).state).toBe(
      'completed'
    )
    expect(f.child.requests).toHaveLength(1)
    expect(
      (await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)).filter(
        (row) => row.kind === 'model_usage'
      )
    ).toHaveLength(1)
  } finally {
    await f?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
