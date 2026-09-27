import { describe, expect, test } from 'bun:test'
import { R2ObjectStore } from './index.ts'
import { S3Client } from '@aws-sdk/client-s3'

function storeWith(send) {
  return new R2ObjectStore({
    bucket: 'artifacts',
    prefix: 'test/',
    maxObjectBytes: 8,
    client: { send },
  })
}

const input = { key: 'attempt/result', body: new Uint8Array([1, 2]), metadata: { attempt: 'one' } }

describe('S3 conditional object creation', () => {
  test('SDK retries retain the create-only precondition on every HTTP request', async () => {
    const requests = []
    const client = new S3Client({
      endpoint: 'https://objects.example.test',
      region: 'auto',
      forcePathStyle: true,
      maxAttempts: 2,
      credentials: { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' },
      requestHandler: {
        async handle(request) {
          requests.push(request)
          if (requests.length === 1)
            return {
              response: {
                statusCode: 503,
                headers: {},
                body: new TextEncoder().encode(
                  '<Error><Code>ServiceUnavailable</Code><Message>fixture</Message></Error>'
                ),
              },
            }
          return { response: { statusCode: 200, headers: { etag: 'fixture-etag' } } }
        },
      },
    })
    const store = new R2ObjectStore({ bucket: 'artifacts', maxObjectBytes: 8, client })
    try {
      expect((await store.putIfAbsent(input)).outcome).toBe('created')
      expect(requests).toHaveLength(2)
      expect(requests.every((request) => request.headers['if-none-match'] === '*')).toBe(true)
    } finally {
      store.close()
    }
  })

  test('the installed AWS SDK serializes the precondition into the signed HTTP request', async () => {
    const requests = []
    const client = new S3Client({
      endpoint: 'https://objects.example.test',
      region: 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' },
      requestHandler: {
        async handle(request) {
          requests.push(request)
          return { response: { statusCode: 200, headers: { etag: 'fixture-etag' } } }
        },
      },
    })
    const store = new R2ObjectStore({ bucket: 'artifacts', maxObjectBytes: 8, client })
    try {
      expect((await store.putIfAbsent(input)).outcome).toBe('created')
      expect(requests).toHaveLength(1)
      expect(requests[0].headers['if-none-match']).toBe('*')
      expect(requests[0].headers.authorization).toContain('if-none-match')
    } finally {
      store.close()
    }
  })

  test('independent adapters competing for one provider key expose exactly one winner', async () => {
    const objects = new Map()
    const calls = []
    const send = async (command) => {
      calls.push(command)
      const key = command.input.Key
      if (command.input.IfNoneMatch !== '*') throw new Error('missing conditional fence')
      if (objects.has(key))
        throw Object.assign(new Error('exists'), { $metadata: { httpStatusCode: 412 } })
      objects.set(key, command.input.Body.slice())
      return {}
    }
    const first = storeWith(send)
    const second = storeWith(send)
    const results = await Promise.all([
      first.putIfAbsent(input),
      second.putIfAbsent({ ...input, body: new Uint8Array([3, 4]) }),
    ])
    expect(results.map((result) => result.outcome).toSorted()).toEqual(['created', 'exists'])
    expect(objects.get('test/attempt/result')).toEqual(input.body)
    expect(calls).toHaveLength(2)
  })

  test('sends one conditional PUT with the prefixed address and returns a created descriptor', async () => {
    const calls = []
    const store = storeWith(async (command) => {
      calls.push(command)
      return { ETag: 'etag' }
    })
    const result = await store.putIfAbsent(input)
    expect(result).toMatchObject({
      outcome: 'created',
      object: { key: input.key, size: 2, etag: 'etag', metadata: input.metadata },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].constructor.name).toBe('PutObjectCommand')
    expect(calls[0].input).toMatchObject({
      Bucket: 'artifacts',
      Key: 'test/attempt/result',
      IfNoneMatch: '*',
      ContentLength: 2,
    })
    expect(result.object.sha256).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('reports an existing winner without HEAD, GET, or an unconditional retry', async () => {
    const calls = []
    const store = storeWith(async (command) => {
      calls.push(command)
      throw Object.assign(new Error('private provider payload'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      })
    })
    expect(await store.putIfAbsent(input)).toEqual({ outcome: 'exists' })
    expect(calls).toHaveLength(1)
  })

  for (const status of [409, 403, 501, 503]) {
    test(`fails closed for HTTP ${status} without retrying or claiming an existing winner`, async () => {
      let calls = 0
      const store = storeWith(async () => {
        calls++
        throw Object.assign(new Error('credential-value'), {
          $metadata: { httpStatusCode: status },
        })
      })
      await expect(store.putIfAbsent(input)).rejects.toMatchObject({
        code: 'OBJECT_STORE_PROVIDER_FAILURE',
        retryable: status === 409 || status >= 500,
      })
      expect(calls).toBe(1)
    })
  }

  test('a lost write acknowledgement remains an ambiguous failure, not created or exists', async () => {
    const store = storeWith(async () => {
      throw new Error('credential-value')
    })
    try {
      await store.putIfAbsent(input)
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'OBJECT_STORE_PROVIDER_FAILURE', retryable: true })
      expect(JSON.stringify(error)).not.toContain('credential-value')
    }
  })

  test('validates size and unsafe keys before contacting the provider', async () => {
    let calls = 0
    const store = storeWith(async () => {
      calls++
      return {}
    })
    await expect(store.putIfAbsent({ ...input, key: '../escape' })).rejects.toMatchObject({
      code: 'OBJECT_STORE_INVALID_INPUT',
    })
    await expect(store.putIfAbsent({ ...input, body: new Uint8Array(9) })).rejects.toMatchObject({
      code: 'OBJECT_STORE_TOO_LARGE',
    })
    expect(calls).toBe(0)
  })

  test('ordinary mutable PUT remains separate and has no create-only precondition', async () => {
    const calls = []
    const store = storeWith(async (command) => {
      calls.push(command)
      return {}
    })
    expect((await store.put(input)).key).toBe(input.key)
    expect(calls[0].input.IfNoneMatch).toBeUndefined()
  })
})
