// Test-owned process harness. Only children spawned here may be signalled.
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(
  new URL('./pi-child-continuation-process.fixture.mjs', import.meta.url)
)
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function createUnfinishedChildProcessHarness(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'j1-unfinished-child-'))
  const children = new Set()
  let transport
  try {
    const { createChildProcessTransport } =
      await import('./pi-child-continuation-process.fixture.mjs')
    transport = await createChildProcessTransport(options)
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  async function evidence() {
    try {
      return (await readFile(join(directory, 'process-evidence.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  function start(mode, runtime = 'node') {
    const command = runtime === 'bun' ? process.execPath : 'node'
    const args = runtime === 'bun' ? [] : ['--experimental-transform-types']
    const child = spawn(command, [...args, worker, directory, mode, transport.baseUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        PI_CHILD_PROCESS_EMITTED: runtime === 'node' ? 'true' : 'false',
      },
    })
    let output = ''
    let stdout = ''
    const events = []
    child.stdout.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-16384)
      stdout += chunk
      const lines = stdout.split('\n')
      stdout = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('{')) continue
        events.push(JSON.parse(line))
      }
    })
    child.stderr.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-16384)
    })
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    // Attach a handler immediately; callers still observe the original failure.
    exit.catch(() => {})
    const owned = { child, exit, events, output: () => output }
    children.add(owned)
    return owned
  }
  async function waitFor(predicate, owned, timeout = 20000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const rows = await evidence()
      const result = predicate([...rows, ...(owned?.events ?? [])])
      if (result) return result
      if (owned && (owned.child.exitCode !== null || owned.child.signalCode !== null)) {
        throw new Error(`J1_WORKER_EXIT_BEFORE_EVIDENCE: ${owned.output()}`)
      }
      await delay(10)
    }
    throw new Error(`J1_PROCESS_EVIDENCE_TIMEOUT: ${owned?.output() ?? ''}`)
  }
  async function kill(owned) {
    if (!children.has(owned)) throw new Error('J1_FOREIGN_PROCESS_SIGNAL_DENIED')
    if (owned.child.exitCode === null && owned.child.signalCode === null)
      owned.child.kill('SIGKILL')
    return owned.exit
  }
  return {
    directory,
    transport,
    evidence,
    start,
    waitFor,
    kill,
    async setClock(now) {
      await writeFile(join(directory, 'current-time.json'), JSON.stringify(now))
    },
    async descriptor() {
      return JSON.parse(await readFile(join(directory, 'child-descriptor.json'), 'utf8'))
    },
    async close() {
      await Promise.all(
        [...children].map(async ({ child, exit }) => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
            await exit.catch(() => {})
          }
        })
      )
      await transport.close()
      if (process.env.J1_PROOF_EVIDENCE_DIR) {
        const target = join(process.env.J1_PROOF_EVIDENCE_DIR, basename(directory))
        await mkdir(target, { recursive: true })
        for (const name of ['process-evidence.jsonl', 'child-descriptor.json']) {
          try {
            await copyFile(join(directory, name), join(target, name))
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }
        await writeFile(
          join(target, 'worker-output.json'),
          JSON.stringify(
            [...children].map(({ child, output }) => ({
              pid: child.pid,
              exitCode: child.exitCode,
              signalCode: child.signalCode,
              output: output(),
            }))
          )
        )
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}
