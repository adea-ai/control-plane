import { expect, test } from 'bun:test'
import { createLocalAcpRuntime } from './acp-runtime.ts'

test('explicit Local ACP factory opens native v1 without inheriting host environment', async () => {
  const source = `
    let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.method !== 'initialize') throw Error('unexpected method');
        if (message.params.protocolVersion !== 1 || process.env.HOME !== undefined)
          throw Error('configuration mismatch');
        process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:message.id, result:{
          protocolVersion:1, agentInfo:{name:'local-wire-fixture',version:'1.0.0'},
          agentCapabilities:{sessionCapabilities:{close:{}}}
        }}) + '\\n');
      }
    });
  `
  const runtime = createLocalAcpRuntime({
    executablePath: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    environment: {},
    externalSessionId: () => 'ses_01JABCDEF0123456789ABCDEFG',
    interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
    requestTimeoutMs: 2000,
  })
  try {
    expect(runtime.transportKind).toBe('direct-local')
    await runtime.open()
    expect(await runtime.inspect()).toBeDefined()
  } finally {
    await runtime.close()
    await runtime.close()
  }
})
