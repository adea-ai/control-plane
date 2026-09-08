import { expect, test } from 'bun:test'
import { AcpStdioClient } from './stdio-client.ts'

const program = `
let buffer = '';
let errorCaller;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let boundary;
  while ((boundary = buffer.indexOf('\\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
    if (message.method === 'echo') send({jsonrpc:'2.0', id:message.id, result:message.params});
    if (message.method === 'env') send({jsonrpc:'2.0', id:message.id, result:{provided:process.env.PROVIDED, hasParentPath:Object.hasOwn(process.env,'PATH')}});
    if (message.method === 'malformed') process.stdout.write('not-json\\n');
    if (message.method === 'huge') process.stdout.write('x'.repeat(1048577));
    if (message.method === 'invalid-utf8') process.stdout.write(Buffer.from([123,34,120,34,58,34,255,34,125,10]));
    if (message.method === 'fragmented') {
      const bytes = Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result:'✓'})+'\\n');
      const split = bytes.indexOf(0xe2) + 1;
      process.stdout.write(bytes.subarray(0,split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
    }
    if (message.method === 'exit') process.exit(0);
    if (message.method === 'rpc-error') send({jsonrpc:'2.0', id:message.id, error:{code:-32601,message:'private diagnostic'}});
    if (message.method === 'permission') send({jsonrpc:'2.0', id:'native-42',method:'session/request_permission',params:{sessionId:'s1'}});
    if (message.method === 'error-permission') { errorCaller=message.id; send({jsonrpc:'2.0',id:'unsupported-42',method:'unsupported/native',params:{}}); }
    if (message.id === 'unsupported-42' && message.error) send({jsonrpc:'2.0',id:errorCaller,result:message.error});
    if (message.method === 'close-burst') process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'close-now'})+'\\n'+JSON.stringify({jsonrpc:'2.0',method:'after-close'})+'\\n');
    if (message.id === 'native-42' && message.result) send({jsonrpc:'2.0',method:'answered',params:message.result});
  }
});
`

function client(overrides = {}) {
  return new AcpStdioClient({
    executablePath: process.execPath,
    args: ['-e', program],
    cwd: import.meta.dir,
    environment: { PROVIDED: 'explicit-value' },
    onNotification: () => {},
    onRequest: () => {},
    ...overrides,
  })
}

test('stdio can reject unsupported native requests with their original ID', async () => {
  const rpc = client({ onRequest: (id) => rpc.respondError(id, -32601, 'Method not supported') })
  try {
    await rpc.start()
    expect(await rpc.request('error-permission', {})).toEqual({
      code: -32601,
      message: 'Method not supported',
    })
    expect(() => rpc.respondError('unsupported-42', -32601, 'duplicate')).toThrow(
      'ACP_PROCESS_REQUEST_UNKNOWN'
    )
    expect(await rpc.request('echo', {})).toEqual({})
  } finally {
    await rpc.close()
  }
})

test('stdio stops delivering frames already buffered when a handler closes the client', async () => {
  const seen = []
  let resolveClosed
  const closed = new Promise((resolve) => {
    resolveClosed = resolve
  })
  const rpc = client({
    onNotification: (method) => {
      seen.push(method)
      if (method === 'close-now') rpc.close().then(resolveClosed)
    },
  })
  try {
    await rpc.start()
    rpc.notify('close-burst', {})
    await closed
    expect(seen).toEqual(['close-now'])
  } finally {
    await rpc.close()
  }
})

test('stdio exchanges correlated requests with an explicit child environment', async () => {
  const rpc = client()
  try {
    await rpc.start()
    expect(
      await Promise.all([rpc.request('echo', { text: 'unicode: ✓' }), rpc.request('echo', [42])])
    ).toEqual([{ text: 'unicode: ✓' }, [42]])
    expect(await rpc.request('env', {})).toEqual({
      provided: 'explicit-value',
      hasParentPath: false,
    })
    expect(await rpc.request('fragmented', {})).toBe('✓')
    await expect(rpc.start()).rejects.toThrow('ACP_PROCESS_ALREADY_STARTED')
  } finally {
    await rpc.close()
  }
  expect(rpc.connected).toBe(false)
})

test('stdio routes native requests and notifications without changing opaque IDs', async () => {
  let resolveNotification
  const notification = new Promise((resolve) => {
    resolveNotification = resolve
  })
  const rpc = client({
    onRequest: (id, method, params) => {
      expect([id, method, params]).toEqual([
        'native-42',
        'session/request_permission',
        { sessionId: 's1' },
      ])
      rpc.respond(id, { selected: 'opaque-option' })
    },
    onNotification: (method, params) => resolveNotification({ method, params }),
  })
  try {
    await rpc.start()
    rpc.notify('permission', {})
    expect(await notification).toEqual({
      method: 'answered',
      params: { selected: 'opaque-option' },
    })
    expect(() => rpc.respond('unknown', {})).toThrow('ACP_PROCESS_REQUEST_UNKNOWN')
  } finally {
    await rpc.close()
  }
})

test.each(['malformed', 'huge', 'invalid-utf8', 'exit'])(
  'stdio fails pending work and cleans up after %s output',
  async (method) => {
    const rpc = client()
    try {
      await rpc.start()
      await expect(rpc.request(method, {}, { timeoutMs: 1000 })).rejects.toThrow(
        /ACP_PROCESS_(PROTOCOL_ERROR|CLOSED)/
      )
      expect(rpc.connected).toBe(false)
    } finally {
      await rpc.close()
    }
  }
)

test('stdio closes pending work once and bounds outstanding request capacity', async () => {
  const rpc = client()
  try {
    await rpc.start()
    const pending = Array.from({ length: 128 }, () =>
      rpc.request('never', {}).catch((error) => error.message)
    )
    await expect(rpc.request('never', {})).rejects.toThrow('ACP_PROCESS_BACKPRESSURE')
    await Promise.all([rpc.close(), rpc.close()])
    expect(new Set(await Promise.all(pending))).toEqual(new Set(['ACP_PROCESS_CLOSING']))
    await expect(rpc.request('echo', {})).rejects.toThrow('ACP_PROCESS_CLOSING')
  } finally {
    await rpc.close()
  }
})

test('stdio bounds request waits and does not leak remote error messages', async () => {
  const rpc = client()
  try {
    await rpc.start()
    await expect(rpc.request('never', {}, { timeoutMs: 20 })).rejects.toThrow(
      'ACP_PROCESS_REQUEST_TIMEOUT'
    )
    const controller = new AbortController()
    const pending = rpc.request('never', {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('ACP_PROCESS_ABORTED')
    await expect(rpc.request('rpc-error', {})).rejects.toThrow('ACP_PROCESS_RPC_ERROR:-32601')
    await expect(rpc.request('echo', 'invalid-scalar')).rejects.toThrow()
    expect(await rpc.request('echo', { status: 'still-connected' })).toEqual({
      status: 'still-connected',
    })
  } finally {
    await rpc.close()
  }
})

test('stdio rejects relative paths before spawning and handles missing executables', async () => {
  expect(() => client({ executablePath: 'agent' })).toThrow('ACP_PROCESS_ABSOLUTE_PATH_REQUIRED')
  const rpc = client({ executablePath: '/nonexistent-control-plane-acp-test' })
  try {
    await expect(rpc.start()).rejects.toThrow('ACP_PROCESS_START_FAILED')
  } finally {
    await rpc.close()
  }
})
