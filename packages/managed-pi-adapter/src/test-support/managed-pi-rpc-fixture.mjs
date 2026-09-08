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
    if (process.env.MOCK_MODE === 'hold') return
    if (process.env.MOCK_MODE === 'crash') {
      setTimeout(() => process.exit(17), 5)
      return
    }
    if (process.env.MOCK_MODE === 'oversized-frame') {
      queueMicrotask(() => process.stdout.write('x'.repeat(1_048_577)))
      return
    }
    if (process.env.MOCK_MODE === 'cancel-race') {
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
    if (process.env.MOCK_MODE === 'cancel-race') setTimeout(respond, 20)
    else respond()
    return
  }
  if (command.type === 'get_session_stats') {
    const respond = () => send({ id: command.id, type: 'response', command: command.type, success: true, data: { tokens: { input: 11, output: 3 } } })
    if (process.env.MOCK_MODE === 'cancel-race') setTimeout(respond, 20)
    else respond()
    return
  }
  if (command.type === 'abort' || command.type === 'steer') {
    send({ id: command.id, type: 'response', command: command.type, success: true })
  }
}
`
