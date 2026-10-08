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
