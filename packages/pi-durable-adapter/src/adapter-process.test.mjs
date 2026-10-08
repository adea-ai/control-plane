import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { effectIdentity, interactionId, processAdapterFixture } from './adapter-process.fixture.mjs'

const fixturePath = fileURLToPath(new URL('./adapter-process.fixture.mjs', import.meta.url))
const node =
  process.env.CONTROL_PLANE_TEST_NODE ?? (process.versions.bun ? 'node' : process.execPath)

function childAtBoundary(directory, mode) {
  const child = spawn(node, ['--experimental-transform-types', fixturePath, directory, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let found
  const complete = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  const boundary = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Adapter child boundary timeout: ${stderr}`))
    }, 10000)
    child.stdout.on('data', (data) => {
      stdout += data
      for (const line of stdout.split('\n').filter(Boolean)) {
        let value
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        if (value.boundary === mode) {
          found = value
          clearTimeout(timer)
          resolve(value)
        }
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (!found) reject(new Error(stderr || stdout || 'Adapter child ended before boundary'))
    })
  })
  child.stderr.on('data', (data) => {
    stderr += data
  })
  return { child, boundary, complete }
}

async function evidence(directory) {
  return (await readFile(join(directory, 'process-evidence.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
async function events(adapter, handle, afterSequence = 0) {
  const result = []
  for await (const event of adapter.progress(handle, { afterSequence })) result.push(event)
  return result
}
async function kill(worker) {
  worker.child.kill('SIGKILL')
  const completed = await worker.complete
  expect(completed.signal, completed.stderr).toBe('SIGKILL')
}

describe('actual Pi adapter process restart with the default engine', () => {
  test('SIGKILL after scripted physical send leaves unresolved inference fenced across adapter/store reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-adapter-process-'))
    let worker
    let adapter
    try {
      worker = childAtBoundary(directory, 'native_send')
      const boundary = await worker.boundary
      expect(boundary.state).toBe('running')
      expect(
        (await evidence(directory)).filter((entry) => entry.boundary === 'native_send')
      ).toHaveLength(1)
      await kill(worker)
      const { options, request } = processAdapterFixture(directory)
      adapter = new PiDurableRuntimeAdapter(options)
      const handle = await adapter.start(request)
      expect(handle).toEqual(boundary.handle)
      expect((await adapter.reconcile(handle)).state).toBe('unknown')
      await adapter.drain()
      expect((await events(adapter, handle)).slice(0, boundary.events.length)).toEqual(
        boundary.events
      )
      expect(
        (await evidence(directory)).filter((entry) => entry.boundary === 'native_send')
      ).toHaveLength(1)
      await adapter.close()
      adapter = new PiDurableRuntimeAdapter(options)
      expect(await adapter.start(request)).toEqual(handle)
      expect((await adapter.reconcile(handle)).state).toBe('unknown')
      expect(
        (await evidence(directory)).filter((entry) => entry.boundary === 'native_send')
      ).toHaveLength(1)
    } finally {
      worker?.child.kill('SIGKILL')
      await adapter?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  test('SIGKILL before native dispatch recovers a proven-safe generation with exact attempt/session/cursor identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-adapter-process-safe-'))
    let worker
    let adapter
    try {
      worker = childAtBoundary(directory, 'before_native_dispatch')
      const boundary = await worker.boundary
      expect(boundary.state).toBe('running')
      const interrupted = await evidence(directory)
      expect(interrupted.filter((entry) => entry.boundary === 'native_send')).toHaveLength(0)
      await kill(worker)
      const { options, request } = processAdapterFixture(directory, 'safe_resume')
      adapter = new PiDurableRuntimeAdapter(options)
      const handle = await adapter.start(request)
      expect(handle).toEqual(boundary.handle)
      await adapter.reconcile(handle)
      await adapter.drain()
      const status = await adapter.status(handle)
      expect(status.state).toBe('completed')
      expect(status.result.output).toEqual({ text: 'Restarted adapter answer' })
      const completedEvents = await events(adapter, handle)
      expect(completedEvents.slice(0, boundary.events.length)).toEqual(boundary.events)
      expect(new Set(completedEvents.map((event) => event.sequence)).size).toBe(
        completedEvents.length
      )
      const sends = (await evidence(directory)).filter((entry) => entry.boundary === 'native_send')
      expect(sends).toHaveLength(1)
      expect(sends[0].inferenceKey).toBe(interrupted[0].inferenceKey)
      await adapter.close()
      adapter = new PiDurableRuntimeAdapter(options)
      expect(await adapter.start(request)).toEqual(handle)
      expect((await adapter.status(handle)).result).toEqual(status.result)
      const cursor = completedEvents[0].sequence
      expect(await events(adapter, handle, cursor)).toEqual(completedEvents.slice(1))
      expect(
        (await evidence(directory)).filter((entry) => entry.boundary === 'native_send')
      ).toHaveLength(1)
    } finally {
      worker?.child.kill('SIGKILL')
      await adapter?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  test('pending approval survives SIGKILL and accepts only a canonical verifier decision after reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-adapter-process-approval-'))
    let worker
    let adapter
    try {
      worker = childAtBoundary(directory, 'pending_approval')
      const boundary = await worker.boundary
      expect(boundary.state).toBe('awaiting_input')
      await kill(worker)
      const { options, request } = processAdapterFixture(directory)
      adapter = new PiDurableRuntimeAdapter(options)
      const handle = await adapter.start(request)
      expect(handle).toEqual(boundary.handle)
      const approval = {
        interactionId,
        idempotencyKey: 'approval-process:one',
        decision: 'approve',
      }
      await expect(adapter.submitApproval(handle, approval)).rejects.toThrow(
        'PI_APPROVAL_NOT_AUTHORITATIVE'
      )
      const decision = {
        executionId: request.executionId,
        attemptId: request.attemptId,
        effectIdentity,
        interactionId,
        principalRef: 'principal:owner',
        decision: 'approve',
      }
      await writeFile(
        join(directory, 'canonical-approval.json'),
        JSON.stringify({ ...decision, attemptId: 'att_01JBBCDEF0123456789ABCDEFG' })
      )
      await expect(adapter.submitApproval(handle, approval)).rejects.toThrow(
        'PI_APPROVAL_NOT_AUTHORITATIVE'
      )
      await writeFile(join(directory, 'canonical-approval.json'), JSON.stringify(decision))
      expect((await adapter.submitApproval(handle, approval)).state).toBe('awaiting_input')
      await adapter.close()
      adapter = new PiDurableRuntimeAdapter(options)
      expect(await adapter.start(request)).toEqual(handle)
      expect((await adapter.submitApproval(handle, approval)).state).toBe('awaiting_input')
      await expect(
        adapter.submitApproval(handle, { ...approval, decision: 'deny' })
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT')
      expect(
        (await evidence(directory)).filter((entry) => entry.boundary === 'native_send')
      ).toHaveLength(1)
    } finally {
      worker?.child.kill('SIGKILL')
      await adapter?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)
})
