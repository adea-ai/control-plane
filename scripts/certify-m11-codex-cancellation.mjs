import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { AcpStdioClient } from '../packages/acp-adapter/src/stdio-client.ts'
import { pinnedAcpBuild } from './install-m11-codex-acp.mjs'

// Explicit candidate-binary probe. This does not certify or modify a Local installation.
const [installation, nodeExecutable, nativeExecutable] = process.argv.slice(2)
assert(
  process.argv.length === 5 && [installation, nodeExecutable, nativeExecutable].every(isAbsolute),
  'Usage: bun scripts/certify-m11-codex-cancellation.mjs /absolute/acp-installation /absolute/node24 /absolute/native-codex'
)
const executable = join(installation, 'source/dist/index.js')
assert.equal(
  createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
  pinnedAcpBuild.bundleSha256
)
const nativeHash = createHash('sha256')
for await (const chunk of createReadStream(nativeExecutable)) nativeHash.update(chunk)
const nativeSha256 = nativeHash.digest('hex')
const directory = await mkdtemp(join(tmpdir(), 'm11-codex-cancel-probe-'))
let rpc
let server
let heartbeat
let requestStarted = false
let streamClosed = false
async function until(predicate) {
  const deadline = Date.now() + 15000
  while (!predicate()) {
    assert(Date.now() < deadline, 'Native cancellation did not close the provider stream')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
try {
  const cwd = join(directory, 'workspace')
  const home = join(directory, 'home')
  const codexHome = join(directory, 'codex')
  for (const path of [cwd, home, codexHome]) await mkdir(path, { mode: 0o700 })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/responses')
        return new Response(null, { status: 404 })
      await request.arrayBuffer()
      assert.equal(requestStarted, false, 'Cancellation must not start another model request')
      requestStarted = true
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_cancel","status":"in_progress","output":[]}}\n\n'
              )
            )
            heartbeat = setInterval(() => {
              controller.enqueue(new TextEncoder().encode(': pending\n\n'))
            }, 100)
          },
          cancel() {
            clearInterval(heartbeat)
            streamClosed = true
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })
  rpc = new AcpStdioClient({
    executablePath: nodeExecutable,
    args: [executable],
    cwd,
    environment: {
      PATH: `${dirname(nodeExecutable)}:/usr/bin:/bin`,
      HOME: home,
      CODEX_HOME: codexHome,
      CODEX_PATH: nativeExecutable,
    },
    onNotification: () => undefined,
    onRequest: (id) => rpc.respondError(id, -32601, 'Probe does not authorize tools'),
  })
  await rpc.start()
  await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  await rpc.request('authenticate', {
    methodId: 'gateway',
    _meta: {
      gateway: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        headers: {},
        providerName: 'isolated-cancellation-fixture',
      },
    },
  })
  const { sessionId } = await rpc.request('session/new', { cwd, mcpServers: [] })
  const prompt = rpc.request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: 'Wait for cancellation.' }] },
    { timeoutMs: 30000 }
  )
  // Attach immediately so a failed prompt cannot become an unhandled rejection while waiting.
  void prompt.catch(() => undefined)
  await until(() => requestStarted)
  rpc.notify('session/cancel', { sessionId })
  assert.equal((await prompt).stopReason, 'cancelled')
  await until(() => streamClosed)
  console.log(JSON.stringify({ nativeSha256, streamClosedBeforeCleanup: true, requests: 1 }))
} finally {
  try {
    await rpc?.close()
  } finally {
    clearInterval(heartbeat)
    server?.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}
