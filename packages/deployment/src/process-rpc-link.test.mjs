import { spawn } from 'node:child_process'
import { describe, expect, test } from 'bun:test'
import { ProcessRpcDecodeError, ProcessRpcLink } from './process-rpc-link.ts'

const echoProgram = `
let buffer = ''
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let boundary
  while ((boundary = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 1)
    if (line.length === 0) continue
    let command
    try { command = JSON.parse(line) } catch { continue }
    if (command.echo !== undefined) send({ id: command.id, ok: true, value: command.echo })
    if (command.slow !== undefined) setTimeout(() => send({ id: command.id, ok: true, value: command.slow }), command.slow)
    if (command.emit !== undefined) { send({ broadcast: command.emit }); send({ id: command.id, ok: true, value: command.emit }) }
    if (command.missedId !== undefined) { send({ id: command.missedId, ok: true, value: 'late-result' }); send({ id: command.id, ok: true, value: 'done' }) }
    if (command.badJson === true) process.stdout.write('not-json\\n')
    if (command.softGarbage === true) process.stdout.write('<<<not-a-frame>>>\\n')
    if (command.hugeFrame === true) process.stdout.write('x'.repeat(1048577))
    if (command.crlf === true) { process.stdout.write('\\r\\n'); process.stdout.write(JSON.stringify({ id: command.id, ok: true, value: 'crlf' }) + '\\r\\n') }
    if (command.exit === true) process.exit(0)
    if (command.crash === true) process.exit(7)
  }
})
`

const stubbornProgram = `
process.on('SIGTERM', () => {})
process.stdout.write(JSON.stringify({ ready: true }) + '\\n')
setInterval(() => {}, 1_000)
`

async function untilLine(events, predicate) {
  for (let waited = 0; waited < 2_000; waited += 10) {
    if (events.lines.some(predicate)) return
    await delay(10)
  }
  throw new Error('TEST_CHILD_NOT_READY')
}

function testCodec() {
  return {
    encode: (request, id) => JSON.stringify(id === undefined ? request : { ...request, id }),
    decode: (line) => {
      if (line.startsWith('<<<')) throw new ProcessRpcDecodeError('TEST_SOFT_GARBAGE', false)
      const value = JSON.parse(line)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
      if (typeof value.id === 'string') {
        if (value.ok === true)
          return { kind: 'response', id: value.id, result: value.value ?? null }
        return { kind: 'response', id: value.id, error: new Error('TEST_REJECTED') }
      }
      return { kind: 'unmatched', message: value }
    },
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function untilSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

function startLink({
  program = echoProgram,
  linkOptions = {},
  // Detached so the default process-group signal strategy has a group to signal.
  detached = true,
} = {}) {
  const child = spawn(process.execPath, ['-e', program], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached,
  })
  const events = { lines: [], exits: [], failures: [], missed: [] }
  const options = {
    child,
    codec: testCodec(),
    maxFrameBytes: 1_048_576,
    formatFrameError: () => new Error('TEST_FRAME_TOO_LARGE'),
    formatExitError: (info) =>
      new Error(
        `TEST_EXITED:${info.code === null ? 'signal' : String(info.code)}:${info.signal ?? 'none'}`
      ),
    formatTimeoutError: (request) => new Error(`TEST_TIMEOUT:${String(request.slow ?? 'request')}`),
    notRunningError: () => new Error('TEST_NOT_RUNNING'),
    formatAbortError: () => new Error('TEST_ABORTED'),
    onLine: (message) => events.lines.push(message),
    onExit: (error) => events.exits.push(error),
    onFail: (error) => events.failures.push(error),
    onResponseMiss: (id, response) => events.missed.push([id, response]),
    ...linkOptions,
  }
  const link = new ProcessRpcLink(options)
  return { child, link, events }
}

async function withLink(setup, run) {
  const context = setup()
  try {
    await untilSpawn(context.child)
    return await run(context)
  } finally {
    await context.link.stop({ graceMs: 250, finalWaitMs: 250 }).catch(() => undefined)
  }
}

describe('ProcessRpcLink', () => {
  test('correlates concurrent requests and routes unmatched lines to onLine', async () => {
    await withLink(
      () => startLink(),
      async ({ link, events }) => {
        const [first, second, third] = await Promise.all([
          link.request({ echo: { n: 1 } }, { id: 'a1', timeoutMs: 1_000 }),
          link.request({ echo: [2] }, { id: 'a2', timeoutMs: 1_000 }),
          link.request({ emit: 'ping' }, { id: 'a3', timeoutMs: 1_000 }),
        ])
        expect(first).toEqual({ n: 1 })
        expect(second).toEqual([2])
        expect(third).toBe('ping')
        expect(events.lines).toEqual([{ broadcast: 'ping' }])
        expect(link.connected).toBe(true)
      }
    )
  })

  test('times out with a settled reason and keeps the link usable', async () => {
    await withLink(
      () => startLink(),
      async ({ link }) => {
        const reasons = []
        const pending = link.request(
          { slow: 150 },
          {
            id: 't1',
            timeoutMs: 20,
            onSettled: (reason) => reasons.push(reason),
          }
        )
        await expect(pending).rejects.toThrow('TEST_TIMEOUT:150')
        expect(reasons).toEqual(['timeout'])
        expect(link.connected).toBe(true)
        expect(await link.request({ echo: 'still-here' }, { id: 't2', timeoutMs: 500 })).toBe(
          'still-here'
        )
      }
    )
  })

  test('rejects aborted requests once without writing a cancellation frame', async () => {
    await withLink(
      () => startLink(),
      async ({ link }) => {
        const controller = new AbortController()
        const reasons = []
        const pending = link.request(
          { slow: 500 },
          {
            id: 'ab1',
            timeoutMs: 2_000,
            signal: controller.signal,
            onSettled: (reason) => reasons.push(reason),
          }
        )
        controller.abort()
        await expect(pending).rejects.toThrow('TEST_ABORTED')
        expect(reasons).toEqual(['abort'])
        expect(await link.request({ echo: 'ok' }, { id: 'ab2', timeoutMs: 500 })).toBe('ok')
      }
    )
  })

  test('sweeps every pending request on a fatal protocol failure and stops reading', async () => {
    await withLink(
      () => startLink(),
      async ({ link, events }) => {
        const reasons = []
        const swept = link.request(
          { slow: 300 },
          {
            id: 'f1',
            timeoutMs: 2_000,
            onSettled: (reason) => reasons.push(reason),
          }
        )
        const fatal = link.request(
          { badJson: true },
          {
            id: 'f2',
            timeoutMs: 2_000,
            onSettled: (reason) => reasons.push(reason),
          }
        )
        const fatalOutcome = await fatal.then(
          () => null,
          (error) => error
        )
        const sweptOutcome = await swept.then(
          () => null,
          (error) => error
        )
        expect(fatalOutcome).toBeInstanceOf(SyntaxError)
        expect(sweptOutcome).toBe(fatalOutcome)
        expect(reasons).toEqual(['failure', 'failure'])
        expect(events.failures).toHaveLength(1)
        expect(events.failures[0]).toBe(fatalOutcome)
        expect(events.exits[0]).toBe(events.failures[0])
        expect(link.connected).toBe(false)
        expect(link.failure).toBe(events.failures[0])
        const afterFailure = await link.request({ echo: 2 }, { id: 'f3', timeoutMs: 100 }).then(
          () => null,
          (error) => error
        )
        expect(afterFailure).toBe(events.failures[0])
      }
    )
  })

  test('non-fatal decode errors reject pending work without failing the link', async () => {
    await withLink(
      () => startLink(),
      async ({ link, events }) => {
        const pending = link.request({ softGarbage: true }, { id: 's1', timeoutMs: 1_000 })
        await expect(pending).rejects.toThrow('TEST_SOFT_GARBAGE')
        expect(events.failures).toHaveLength(0)
        expect(link.connected).toBe(true)
        expect(link.failure).toBeUndefined()
        expect(await link.request({ echo: 'recovered' }, { id: 's2', timeoutMs: 1_000 })).toBe(
          'recovered'
        )
      }
    )
  })

  test('enforces the inbound byte cap, fails pending work, and terminates the child', async () => {
    await withLink(
      () => startLink(),
      async ({ child, link, events }) => {
        const pending = link.request({ hugeFrame: true }, { id: 'h1', timeoutMs: 2_000 })
        await expect(pending).rejects.toThrow('TEST_FRAME_TOO_LARGE')
        expect(link.connected).toBe(false)
        expect(events.failures[0]?.message).toBe('TEST_FRAME_TOO_LARGE')
        await delay(120)
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      }
    )
  })

  test('stops gracefully through the SIGTERM ladder and is memoized', async () => {
    await withLink(
      () => startLink(),
      async ({ child, link }) => {
        const startedAt = Date.now()
        const confirmed = await link.stop({ graceMs: 2_000, finalWaitMs: 2_000 })
        expect(confirmed).toBe(true)
        expect(Date.now() - startedAt).toBeLessThan(2_000)
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
        expect(link.connected).toBe(false)
        expect(await link.stop()).toBe(true)
      }
    )
  })

  test('escapes to SIGKILL when the child ignores SIGTERM and reports unconfirmed without a final wait', async () => {
    await withLink(
      () => startLink({ program: stubbornProgram }),
      async ({ child, link, events }) => {
        await untilLine(events, (line) => line.ready === true)
        const confirmed = await link.stop({ graceMs: 80, finalWaitMs: 0 })
        expect(confirmed).toBe(false)
        await delay(80)
        expect(child.signalCode).toBe('SIGKILL')
      }
    )
  }, 5_000)

  test('confirms the exit when SIGKILL is given a final wait', async () => {
    await withLink(
      () => startLink({ program: stubbornProgram }),
      async ({ child, link, events }) => {
        await untilLine(events, (line) => line.ready === true)
        const confirmed = await link.stop({ graceMs: 80, finalWaitMs: 2_000 })
        expect(confirmed).toBe(true)
        expect(child.signalCode).toBe('SIGKILL')
      }
    )
  }, 5_000)

  test('signals the process group when the process-group strategy is selected', async () => {
    await withLink(
      () => startLink({ detached: true, linkOptions: { signalStrategy: 'process-group' } }),
      async ({ child, link }) => {
        const confirmed = await link.stop({ graceMs: 1_000, finalWaitMs: 1_000 })
        expect(confirmed).toBe(true)
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      }
    )
  })

  test('strips carriage returns and skips empty lines when configured', async () => {
    await withLink(
      () =>
        startLink({
          linkOptions: { stripCarriageReturn: true, skipEmptyLines: true },
        }),
      async ({ link }) => {
        expect(await link.request({ crlf: true }, { id: 'c1', timeoutMs: 1_000 })).toBe('crlf')
        expect(link.connected).toBe(true)
      }
    )
  })

  test('delivers responses for unknown ids to onResponseMiss exactly once per response', async () => {
    await withLink(
      () => startLink(),
      async ({ link, events }) => {
        const response = await link.request({ missedId: 'late-1' }, { id: 'm1', timeoutMs: 1_000 })
        expect(response).toBe('done')
        expect(events.missed).toEqual([['late-1', { result: 'late-result' }]])
        expect(link.connected).toBe(true)
      }
    )
  })

  test('transient exit mode sweeps pending work without recording a failure', async () => {
    await withLink(
      () => startLink({ linkOptions: { exitIsPermanentFailure: false } }),
      async ({ link, events }) => {
        const pending = link.request({ crash: true }, { id: 'x1', timeoutMs: 5_000 })
        await expect(pending).rejects.toThrow('TEST_EXITED:7:none')
        expect(events.exits).toHaveLength(1)
        expect(link.failure).toBeUndefined()
        expect(link.connected).toBe(false)
        await expect(link.request({ echo: 1 }, { id: 'x2', timeoutMs: 100 })).rejects.toThrow(
          'TEST_NOT_RUNNING'
        )
      }
    )
  })

  test('rejects oversized outbound frames without failing the link', async () => {
    await withLink(
      () => startLink({ linkOptions: { writeLimitBytes: 1_024 } }),
      async ({ link }) => {
        await expect(
          link.request({ echo: 'y'.repeat(4_096) }, { id: 'w1', timeoutMs: 200 })
        ).rejects.toThrow('PROCESS_RPC_MESSAGE_TOO_LARGE')
        expect(link.connected).toBe(true)
        expect(await link.request({ echo: 'ok' }, { id: 'w2', timeoutMs: 500 })).toBe('ok')
      }
    )
  })

  test('settles pending requests with raw stdin write failures when configured', async () => {
    await withLink(
      () =>
        startLink({
          linkOptions: { exitIsPermanentFailure: false, writeFailureRejectsPending: true },
        }),
      async ({ link }) => {
        const pending = link.request({ exit: true }, { id: 'e1', timeoutMs: 5_000 })
        await expect(pending).rejects.toThrow('TEST_EXITED:0:none')
        await expect(link.request({ echo: 1 }, { id: 'e2', timeoutMs: 1_000 })).rejects.toThrow()
      }
    )
  })
})
