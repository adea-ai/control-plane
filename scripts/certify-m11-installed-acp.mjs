import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { AcpStdioClient } from '../packages/acp-adapter/src/stdio-client.ts'
import { pinnedAcpBuild } from './install-m11-codex-acp.mjs'

const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`

const [installation, nodeExecutable] = process.argv.slice(2)
assert(
  process.argv.length === 4 && isAbsolute(installation) && isAbsolute(nodeExecutable),
  'Usage: bun scripts/certify-m11-installed-acp.mjs /absolute/installation /absolute/node24'
)
const nodeVersion = execFileSync(nodeExecutable, ['--version'], {
  encoding: 'utf8',
  timeout: 5000,
}).trim()
assert.match(nodeVersion, /^v24\./)
const manifest = JSON.parse(await readFile(join(installation, 'installation.json'), 'utf8'))
for (const [key, value] of Object.entries(pinnedAcpBuild)) assert.equal(manifest[key], value)
assert.equal(manifest.status, 'built')
assert.equal(manifest.executable, 'source/dist/index.js')
const executable = join(installation, manifest.executable)
assert.equal(
  createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
  pinnedAcpBuild.bundleSha256
)
const directory = await mkdtemp(join(tmpdir(), 'm11-installed-acp-certification-'))
let rpc
let server
let requests = 0
try {
  const cwd = join(directory, 'workspace')
  const home = join(directory, 'home')
  const codexHome = join(directory, 'codex')
  for (const path of [cwd, home, codexHome]) await mkdir(path, { mode: 0o700 })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/responses')
        return new Response(null, { status: 404 })
      await request.arrayBuffer()
      requests++
      const item = {
        id: `msg_${requests}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Installed ACP verified.', annotations: [] }],
      }
      const result = {
        id: `resp_${requests}`,
        object: 'response',
        created_at: 1788838800,
        status: 'completed',
        model: 'gpt-5.4',
        output: [item],
        usage: {
          input_tokens: 11,
          output_tokens: 3,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }
      return new Response(
        event('response.created', { response: { ...result, status: 'in_progress', output: [] } }) +
          event('response.output_item.added', {
            output_index: 0,
            item: { ...item, status: 'in_progress', content: [] },
          }) +
          event('response.output_text.delta', {
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: item.content[0].text,
          }) +
          event('response.output_item.done', { output_index: 0, item }) +
          event('response.completed', { response: result }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })
  const open = async () => {
    const client = new AcpStdioClient({
      executablePath: nodeExecutable,
      args: [executable],
      cwd,
      environment: {
        PATH: `${dirname(nodeExecutable)}:/usr/bin:/bin`,
        HOME: home,
        CODEX_HOME: codexHome,
      },
      onNotification: () => undefined,
      onRequest: (id) => client.respondError(id, -32601, 'Certification does not authorize tools'),
    })
    rpc = client
    await client.start()
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    })
    assert.equal(initialized.protocolVersion, 1)
    await client.request('authenticate', {
      methodId: 'gateway',
      _meta: {
        gateway: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          headers: {},
          providerName: 'isolated-fixture',
        },
      },
    })
    return client
  }
  await open()
  const { sessionId } = await rpc.request('session/new', { cwd, mcpServers: [] })
  const prompt = async () => {
    const result = await rpc.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'Say hello.' }] },
      { timeoutMs: 30000 }
    )
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(result.usage.inputTokens, 11)
    assert.equal(result.usage.outputTokens, 3)
  }
  await prompt()
  await rpc.close()
  await open()
  await rpc.request('session/load', { sessionId, cwd, mcpServers: [] })
  await prompt()
  assert.equal(requests, 2)
  console.log(
    JSON.stringify(
      {
        suite: 'm11-installed-acp',
        bundleSha256: pinnedAcpBuild.bundleSha256,
        nodeVersion,
        requests,
        freshPromptUsage: { inputTokens: 11, outputTokens: 3 },
        restartedPromptUsage: { inputTokens: 11, outputTokens: 3 },
        scope:
          'native-stdio-process-restart-and-loaded-session-accounting; not Local launcher or in-flight recovery',
      },
      null,
      2
    )
  )
} finally {
  try {
    await rpc?.close()
  } finally {
    server?.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}
