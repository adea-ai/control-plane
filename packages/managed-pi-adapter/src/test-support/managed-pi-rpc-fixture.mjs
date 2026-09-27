import { chmod, writeFile } from 'node:fs/promises'

export async function writeManagedPiRpcFixture(executablePath) {
  await writeFile(executablePath, managedPiRpcFixtureSource, { mode: 0o700 })
  await chmod(executablePath, 0o700)
}

const managedPiRpcFixtureSource = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
if (process.argv.includes('--version')) {
  process.stdout.write('0.84.2\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline = input.indexOf('\\n')
  while (newline >= 0) {
    const line = input.slice(0, newline).replace(/\\r$/, '')
    input = input.slice(newline + 1)
    if (line.length > 0) handle(JSON.parse(line))
    newline = input.indexOf('\\n')
  }
})
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n') }
function handle(command) {
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false } })
    return
  }
  if (command.type === 'prompt') {
    if (process.env.MOCK_MODE === 'reject') {
      send({ id: command.id, type: 'response', command: 'prompt', success: false, error: 'provider secret detail' })
      return
    }
    const promptIndex = process.argv.indexOf('--system-prompt')
    if (process.env.MOCK_RECORD_PATH) {
      writeFileSync(process.env.MOCK_RECORD_PATH, JSON.stringify({
        args: process.argv.slice(2),
        environment: {
          HOME: process.env.HOME ?? null,
          controlPlaneSecret: process.env.CONTROL_PLANE_SECRET ?? null,
          mockRecordPath: process.env.MOCK_RECORD_PATH ?? null,
        },
        prompt: command.message,
        systemPrompt: readFileSync(process.argv[promptIndex + 1], 'utf8'),
      }))
    }
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    if (['hold', 'cancel-with-stats', 'cancel-stats-delayed', 'cancel-stats-hang'].includes(process.env.MOCK_MODE)) return
    if (process.env.MOCK_MODE === 'error-with-stats') {
      queueMicrotask(() => {
        send({ type: 'agent_start' })
        send({ type: 'message_update', usage: { input: 999 }, assistantMessageEvent: { type: 'text_delta', delta: 'failed after partial usage ' } })
        send({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'provider detail' }], willRetry: false })
        send({ type: 'agent_settled' })
      })
      return
    }
    if (process.env.MOCK_MODE === 'exit-with-stats-pending-text') {
      queueMicrotask(() => {
        send({ type: 'agent_settled' })
        setTimeout(() => process.exit(17), 50)
      })
      return
    }
    if (process.env.MOCK_MODE === 'crash') {
      setTimeout(() => process.exit(17), 5)
      return
    }
    if (process.env.MOCK_MODE === 'oversized-frame') {
      queueMicrotask(() => process.stdout.write('x'.repeat(1_048_577)))
      return
    }
    if (process.env.MOCK_MODE === 'cancel-race' || process.env.MOCK_MODE === 'cancel-race-late-stats') {
      queueMicrotask(() => send({ type: 'agent_settled' }))
      return
    }
    queueMicrotask(() => {
      send({ type: 'agent_start' })
      send({ type: 'message_update', usage: { input: 11, output: 3 }, assistantMessageEvent: { type: 'text_delta', delta: 'fixture ' } })
      send({ type: 'agent_end', messages: [], willRetry: false })
      send({ type: 'agent_settled' })
    })
    return
  }
  if (command.type === 'get_last_assistant_text') {
    const respond = () => send({ id: command.id, type: 'response', command: command.type, success: true, data: { text: 'fixture result' } })
    if (process.env.MOCK_MODE === 'text-fails-with-stats') {
      send({ id: command.id, type: 'response', command: command.type, success: false, error: 'text unavailable' })
      return
    }
    if (process.env.MOCK_MODE === 'cancel-race') setTimeout(respond, 20)
    else if (process.env.MOCK_MODE === 'cancel-race-late-stats' || process.env.MOCK_MODE === 'settle-delayed-text' || process.env.MOCK_MODE === 'exit-with-stats-pending-text') setTimeout(respond, 800)
    else respond()
    return
  }
  if (command.type === 'get_session_stats') {
    let data = { tokens: { input: 11, output: 3 } }
    if (process.env.MOCK_MODE === 'error-with-stats') data = { tokens: { input: 17, output: 4 } }
    if (process.env.MOCK_MODE === 'cancel-with-stats' || process.env.MOCK_MODE === 'cancel-stats-delayed') data = { tokens: { input: 23, output: 6 } }
    if (process.env.MOCK_MODE === 'stats-missing') data = {}
    if (process.env.MOCK_MODE === 'stats-malformed') data = { tokens: { input: 1.5, output: 3 } }
    if (process.env.MOCK_MODE === 'stats-unsafe') data = { tokens: { input: Number.MAX_SAFE_INTEGER + 1, output: 0 } }
    if (process.env.MOCK_MODE === 'stats-total-overflow') data = { tokens: { input: Number.MAX_SAFE_INTEGER, output: 1 } }
    const respond = () => send({ id: command.id, type: 'response', command: command.type, success: true, data })
    if (process.env.MOCK_MODE === 'cancel-stats-hang') return
    if (process.env.MOCK_MODE === 'cancel-stats-delayed') setTimeout(respond, 150)
    else if (process.env.MOCK_MODE === 'cancel-race') setTimeout(respond, 20)
    else if (process.env.MOCK_MODE === 'cancel-race-late-stats') setTimeout(respond, 800)
    else respond()
    return
  }
  if (command.type === 'abort' || command.type === 'steer') {
    send({ id: command.id, type: 'response', command: command.type, success: true })
  }
}
`
