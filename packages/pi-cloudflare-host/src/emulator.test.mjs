import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const enabled = process.env.RUN_CLOUDFLARE_EMULATOR === 'true'
async function message(socket) {
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('HIBERNATION_MESSAGE_DEADLINE')), 5000)
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout)
        resolve(JSON.parse(event.data))
      },
      { once: true }
    )
    socket.addEventListener(
      'error',
      (event) => {
        clearTimeout(timeout)
        reject(event.error ?? new Error('SOCKET_ERROR'))
      },
      { once: true }
    )
  })
  socket.send('observe')
  return result
}

// Opt-in: one workerd at a time, deterministic Pi task, all outbound provider traffic denied.
test.skipIf(!enabled)(
  'actual workerd owner + Pi storage/harness survives hibernation, restart and supported upgrade',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp-pi-cloudflare-'))
    let mf, socket
    try {
      const build = await Bun.build({
        entrypoints: [new URL('../tests/worker.mjs', import.meta.url).pathname],
        target: 'browser',
        external: ['node:*'],
      })
      if (!build.success) throw new AggregateError(build.logs, 'QUALIFICATION_BUNDLE_FAILED')
      const script = await build.outputs[0].text()
      const options = {
        name: 'qualifier',
        modules: true,
        script,
        compatibilityDate: '2026-09-26',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { OWNER: { className: 'RecoveryOwner', useSQLite: true } },
        resourcePersistencePath: directory,
        bindings: { RUNTIME_VERSION: '1.1.0', TASK_VERSION: '1', REVISION: '1', REVOKED: 'false' },
        outboundService: async () =>
          new Response('Qualification denies external traffic', { status: 403 }),
      }
      mf = new Miniflare(convertV4MiniflareOptions(options))
      async function json(path) {
        const response = await mf.dispatchFetch(`http://qualification/${path}`)
        if (!response.ok)
          throw new Error(`QUALIFICATION_HTTP_${response.status}: ${await response.text()}`)
        return response.json()
      }
      const accepted = await json('context-a/accept')
      expect(accepted.state).toBe('accepted')
      const replay = await json('context-a/accept')
      expect(replay.task).toEqual(accepted.task)
      expect((await json('context-a/wake')).state).toBe('completed')
      const before = await json('context-a/read')
      expect(before.result.output.planDigest).toBe(
        accepted.task.request.executionPlan.contentDigest
      )
      const summary = await json('context-a/summary')
      expect(summary.conversations).toHaveLength(1)
      expect(summary.events.map((event) => event.state)).toEqual([
        'accepted',
        'running',
        'completed',
      ])
      expect((await json('context-b/summary')).conversations).toEqual([])
      expect((await json('context-b/summary')).events).toEqual([])

      // Exercise workerd's scheduled alarm delivery, without the manual wake fixture route.
      await json('context-alarm/accept')
      const alarmDeadline = Date.now() + 5000
      let scheduled
      do {
        scheduled = await json('context-alarm/read')
        if (scheduled.state === 'completed') break
        await new Promise((resolve) => setTimeout(resolve, 50))
      } while (Date.now() < alarmDeadline)
      expect(scheduled.state).toBe('completed')
      expect((await json('context-alarm/summary')).events.map((event) => event.state)).toEqual([
        'accepted',
        'running',
        'completed',
      ])

      const response = await mf.dispatchFetch('http://qualification/context-a/socket', {
        headers: { Upgrade: 'websocket' },
      })
      expect(response.status).toBe(101)
      socket = response.webSocket
      socket.accept()
      const socketBefore = await message(socket)
      await mf.unsafeEvictDurableObject('qualifier', 'RecoveryOwner', {
        name: 'context-a',
        webSockets: 'hibernate',
      })
      const socketAfter = await message(socket)
      expect(socketAfter.bootId).not.toBe(socketBefore.bootId)
      expect(socketAfter.pins).toEqual(socketBefore.pins)
      expect(socketAfter.epoch).toBeGreaterThan(socketBefore.epoch)
      socket.close()
      socket = undefined
      expect((await json('context-a/read')).result).toEqual(before.result)

      const checkpoint = await json('context-a/checkpoint')
      expect(checkpoint.state).toBe('pending')
      await mf.dispose()
      mf = undefined
      mf = new Miniflare(
        convertV4MiniflareOptions({
          ...options,
          script: `${script}\n// Compatible qualification code revision 2`,
          bindings: { ...options.bindings, TASK_VERSION: '2', REVISION: '2' },
        })
      )
      const restarted = await json('context-a/read')
      expect(restarted.bootId).not.toBe(before.bootId)
      expect(restarted.revision).toBe('2')
      expect(restarted.result).toEqual(before.result)
      const upgraded = await json(`context-a/finish?taskId=${checkpoint.taskId}`)
      expect(upgraded.conversationId).toBe(checkpoint.conversationId)
      expect(upgraded.task.version).toBe(2)
      expect(upgraded.task.state.outcome).toEqual({
        status: 'completed',
        result: { exactPlanDigest: before.task.request.executionPlan.contentDigest },
      })

      await mf.dispose()
      mf = undefined
      mf = new Miniflare(
        convertV4MiniflareOptions({
          ...options,
          bindings: { ...options.bindings, RUNTIME_VERSION: '99.0.0' },
        })
      )
      expect((await mf.dispatchFetch('http://qualification/context-a/read')).status).toBe(500)
      await mf.dispose()
      mf = undefined
      mf = new Miniflare(
        convertV4MiniflareOptions({
          ...options,
          bindings: { ...options.bindings, TASK_VERSION: '2', REVISION: '3' },
        })
      )
      expect((await json('context-a/read')).result).toEqual(before.result)
      expect((await json('context-a/summary')).events).toEqual(summary.events)
    } finally {
      socket?.close()
      await mf?.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000
)

// Signals only a uniquely verified direct workerd child of this test runner, never a peer process.
function ownWorkerdPids() {
  let candidates
  try {
    candidates = execFileSync('pgrep', ['-P', String(process.pid), '-x', 'workerd'], {
      encoding: 'utf8',
      timeout: 1000,
    })
      .trim()
      .split('\n')
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
  if (candidates.some((pid) => !/^\d+$/.test(pid))) throw new Error('ABRUPT_INVALID_PROCESS_ID')
  let identities
  try {
    identities = execFileSync('ps', ['-p', candidates.join(','), '-o', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      timeout: 1000,
    })
  } catch (error) {
    if (error.status === 1) return [] // The selected child exited between enumeration and verification.
    throw error
  }
  return identities.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return match && Number(match[2]) === process.pid && basename(match[3]) === 'workerd'
      ? [Number(match[1])]
      : []
  })
}

test.skipIf(!enabled)(
  'actual abrupt workerd SIGKILL after a controlled effect requires trusted reconciliation without resend',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp-pi-cloudflare-abrupt-'))
    const effects = []
    let closes = 0,
      ledgerReady = false,
      releaseAck,
      mf
    try {
      const build = await Bun.build({
        entrypoints: [new URL('../tests/worker.mjs', import.meta.url).pathname],
        target: 'browser',
        external: ['node:*'],
      })
      if (!build.success) throw new AggregateError(build.logs, 'ABRUPT_BUNDLE_FAILED')
      const options = {
        name: 'abrupt-qualifier',
        modules: true,
        script: await build.outputs[0].text(),
        compatibilityDate: '2026-09-26',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { OWNER: { className: 'RecoveryOwner', useSQLite: true } },
        resourcePersistencePath: directory,
        bindings: {
          RUNTIME_VERSION: '1.1.0',
          TASK_VERSION: '1',
          REVISION: 'abrupt',
          REVOKED: 'false',
        },
        outboundService: async () => new Response('External traffic denied', { status: 403 }),
        serviceBindings: {
          EFFECTS: async (incoming) => {
            const url = new URL(incoming.url)
            if (url.hostname !== 'fixture') return new Response('Denied', { status: 403 })
            if (url.pathname === '/effect' && incoming.method === 'POST') {
              effects.push(await incoming.json())
              // No deduplication: a second physical invocation would visibly increment effects.
              return new Promise((resolve) => {
                releaseAck = () => resolve(new Response('Recorded'))
              })
            }
            if (url.pathname === '/close' && incoming.method === 'POST') {
              closes++
              return new Response('Closed')
            }
            if (url.pathname === '/receipt' && incoming.method === 'GET') {
              return ledgerReady && effects.length === 1
                ? Response.json({ ...effects[0], receiptRef: 'fixture-ledger:one' })
                : new Response('Unsettled', { status: 404 })
            }
            return new Response('Denied', { status: 403 })
          },
        },
      }
      mf = new Miniflare(convertV4MiniflareOptions(options))
      async function json(action) {
        const response = await mf.dispatchFetch(`http://qualification/context-a/${action}`)
        if (!response.ok)
          throw new Error(`ABRUPT_HTTP_${response.status}: ${await response.text()}`)
        return response.json()
      }
      const accepted = await json('accept')
      const before = await json('read')
      const inFlight = json('wake').then(
        () => 'unexpected-success',
        () => 'interrupted'
      )
      const deadline = Date.now() + 5000
      while (!releaseAck && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20))
      expect(effects).toHaveLength(1)
      expect(closes).toBe(0)
      const pids = ownWorkerdPids()
      if (pids.length !== 1) throw new Error(`ABRUPT_OWNERSHIP_UNPROVEN_${pids.length}`)
      const killedPid = pids[0]
      process.kill(killedPid, 'SIGKILL')
      const exitDeadline = Date.now() + 5000
      while (ownWorkerdPids().includes(killedPid) && Date.now() < exitDeadline)
        await new Promise((resolve) => setTimeout(resolve, 20))
      expect(ownWorkerdPids()).not.toContain(killedPid)
      releaseAck()
      expect(await inFlight).toBe('interrupted')
      // New workerd on the same durable SQLite root; no graceful engine/harness close occurred.
      await mf.dispose()
      mf = new Miniflare(convertV4MiniflareOptions(options))
      const recovered = await json('read')
      expect(recovered.bootId).not.toBe(before.bootId)
      expect(recovered.epoch).toBeGreaterThan(before.epoch)
      expect(recovered.state).toBe('reconciliation_required')
      expect(recovered.task).toEqual(accepted.task)
      expect(recovered.result).toBeUndefined()
      const checkpoint = await json('summary')
      expect(checkpoint.nativeTasks).toHaveLength(1)
      expect(checkpoint.nativeTasks[0].state.status).toBe('running')
      expect(checkpoint.nativeTasks[0].state.checkpoint).toEqual({ phase: 'checkpoint' })
      expect(checkpoint.nativeTasks[0].input).toEqual({
        planDigest: accepted.task.request.executionPlan.contentDigest,
        attemptId: accepted.task.request.attemptId,
      })
      expect((await json('accept')).state).toBe('reconciliation_required')
      expect((await json('wake')).state).toBe('reconciliation_required')
      expect((await json('reconcile')).state).toBe('reconciliation_required')
      expect(effects).toHaveLength(1)
      expect(closes).toBe(0)
      ledgerReady = true
      const settled = await json('reconcile')
      expect(settled.state).toBe('completed')
      expect(settled.result).toEqual(effects[0].result)
      expect(settled.settlement.receiptRef).toBe('fixture-ledger:one')
      expect((await json('reconcile')).settlement).toEqual(settled.settlement)
      expect((await json('wake')).result).toEqual(settled.result)
      const summary = await json('summary')
      expect(summary.events.map((e) => e.state)).toEqual([
        'accepted',
        'running',
        'reconciliation_required',
        'completed',
      ])
      expect(summary.conversations).toHaveLength(1)
      expect(summary.nativeTasks).toEqual(checkpoint.nativeTasks)
      expect(effects).toHaveLength(1)
      expect(closes).toBe(0)
    } finally {
      releaseAck?.()
      await mf?.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000
)
