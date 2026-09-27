import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { ObjectStoreError, R2ObjectStore } from './index.ts'

function checksum(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function providerOutput(body, declaredBody = new Uint8Array()) {
  return {
    Body: body,
    ContentLength: declaredBody.byteLength,
    ContentType: 'application/octet-stream',
    Metadata: { 'control-plane-sha256': createHash('sha256').update(declaredBody).digest('hex') },
  }
}

function storeFor(output, maxObjectBytes = 4) {
  let calls = 0
  const store = new R2ObjectStore({
    bucket: 'ctrl-plane',
    client: {
      async send(command) {
        expect(command.constructor.name).toBe('GetObjectCommand')
        calls += 1
        return output
      },
    },
    maxObjectBytes,
  })
  return { store, calls: () => calls }
}

function addBulkTransformTrap(body, calls, transformed = new Uint8Array()) {
  body.transformToByteArray = async () => {
    calls.count += 1
    return transformed
  }
  return body
}

describe('R2ObjectStore bounded GET body reads', () => {
  test('destroys an unread stream when the bounded buffer allocation fails', async () => {
    let reads = 0
    const body = new Readable({
      read() {
        reads += 1
      },
    })
    const output = providerOutput(body)
    output.ContentLength = Number.MAX_SAFE_INTEGER
    const result = storeFor(output, Number.MAX_SAFE_INTEGER)

    await expect(result.store.get('allocation-failure/key')).rejects.toMatchObject({
      code: 'OBJECT_STORE_PROVIDER_FAILURE',
    })
    expect(reads).toBe(0)
    expect(body.destroyed).toBe(true)
  })

  test('rejects an over-limit declared length before reading and destroys the Node stream', async () => {
    let reads = 0
    let transforms = { count: 0 }
    const body = addBulkTransformTrap(
      new Readable({
        read() {
          reads += 1
          this.push(Buffer.from('large'))
          this.push(null)
        },
      }),
      transforms,
      new Uint8Array(5)
    )
    const declared = new Uint8Array(5)
    const output = providerOutput(body, declared)
    const result = storeFor(output, 4)

    await expect(result.store.get('bounded/key')).rejects.toMatchObject({
      code: 'OBJECT_STORE_TOO_LARGE',
      retryable: false,
    })

    expect(transforms.count).toBe(0)
    expect(reads).toBe(0)
    expect(body.destroyed).toBe(true)
  })

  test('enforces the cumulative bound when provider length understates a Node stream', async () => {
    let transforms = { count: 0 }
    const body = addBulkTransformTrap(
      Readable.from([Buffer.from('abc'), Buffer.from('de')]),
      transforms,
      Buffer.from('abcde')
    )
    const declared = Buffer.from('abcd')
    const result = storeFor(providerOutput(body, declared), 4)

    await expect(result.store.get('bounded/key')).rejects.toMatchObject({
      code: 'OBJECT_STORE_TOO_LARGE',
      retryable: false,
    })
    expect(transforms.count).toBe(0)
    expect(body.destroyed).toBe(true)
  })

  test('rejects a false declared length when the stream is longer but within the cap', async () => {
    const body = Readable.from([Buffer.from('abc')])
    const result = storeFor(providerOutput(body, Buffer.from('ab')), 4)

    await expect(result.store.get('false-length/key')).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
      retryable: false,
    })
    expect(body.destroyed).toBe(true)
  })

  test('reads multiple Node chunks and returns the exact verified bytes', async () => {
    const expected = new TextEncoder().encode('abcd')
    const transforms = { count: 0 }
    const body = addBulkTransformTrap(
      Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
      transforms,
      expected
    )
    const result = storeFor(providerOutput(body, expected), 4)

    await expect(result.store.get('bounded/key')).resolves.toMatchObject({
      size: 4,
      sha256: checksum(expected),
      body: expected,
    })
    expect(transforms.count).toBe(0)
  })

  test('supports an exact empty object and WHATWG readable streams', async () => {
    const empty = new Uint8Array()
    const emptyTransforms = { count: 0 }
    const emptyResult = storeFor(
      providerOutput(addBulkTransformTrap(Readable.from([]), emptyTransforms, empty), empty),
      4
    )
    await expect(emptyResult.store.get('empty/key')).resolves.toMatchObject({
      size: 0,
      sha256: checksum(empty),
      body: empty,
    })
    expect(emptyTransforms.count).toBe(0)

    const expected = new TextEncoder().encode('abcd')
    const webTransforms = { count: 0 }
    const whatwg = addBulkTransformTrap(
      new ReadableStream({
        start(controller) {
          controller.enqueue(expected.slice(0, 2))
          controller.enqueue(expected.slice(2))
          controller.close()
        },
      }),
      webTransforms,
      expected
    )
    const streamResult = storeFor(providerOutput(whatwg, expected), 4)
    await expect(streamResult.store.get('web/key')).resolves.toMatchObject({
      size: 4,
      sha256: checksum(expected),
      body: expected,
    })
    expect(webTransforms.count).toBe(0)
  })

  test('cancels a WHATWG stream before reading an over-limit declared object', async () => {
    let pulls = 0
    let cancellations = 0
    const body = new ReadableStream(
      {
        pull() {
          pulls += 1
          return new Promise(() => {})
        },
        cancel() {
          cancellations += 1
        },
      },
      { highWaterMark: 0 }
    )
    const result = storeFor(providerOutput(body, new Uint8Array(5)), 4)

    await expect(result.store.get('over-limit-web/key')).rejects.toMatchObject({
      code: 'OBJECT_STORE_TOO_LARGE',
      retryable: false,
    })
    expect(pulls).toBe(0)
    expect(cancellations).toBe(1)
  })

  test('copies yielded chunks so reused provider buffers cannot alter retained bytes', async () => {
    const reused = new Uint8Array([97, 98])
    let index = 0
    const body = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (index === 0) {
              index += 1
              return { done: false, value: reused }
            }
            if (index === 1) {
              index += 1
              reused.set([99, 100])
              return { done: false, value: reused }
            }
            return { done: true, value: undefined }
          },
        }
      },
    }
    const expected = new TextEncoder().encode('abcd')
    const result = storeFor(providerOutput(body, expected), 4)

    await expect(result.store.get('reused/key')).resolves.toMatchObject({ body: expected })
  })

  test('does not retain empty chunks while reading a bounded stream', async () => {
    const expected = new TextEncoder().encode('ok')
    const empty = new Uint8Array()
    let index = 0
    const body = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (index < 50000) {
              index += 1
              return { done: false, value: empty }
            }
            if (index === 50000) {
              index += 1
              return { done: false, value: expected }
            }
            return { done: true, value: undefined }
          },
        }
      },
    }
    const result = storeFor(providerOutput(body, expected), 4)

    await expect(result.store.get('empty-chunks/key')).resolves.toMatchObject({ body: expected })
    expect(index).toBe(50001)
  })

  test('destroys a body without reading it when the provider descriptor is malformed', async () => {
    let reads = 0
    const body = new Readable({
      read() {
        reads += 1
      },
    })
    const output = providerOutput(body)
    output.ContentLength = Number.NaN
    const result = storeFor(output)

    await expect(result.store.get('bad-header/key')).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
      retryable: false,
    })
    expect(reads).toBe(0)
    expect(body.destroyed).toBe(true)
  })

  test('sanitizes stream errors and cancels malformed byte streams', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('private-provider-stream-detail'))
      },
    })
    const expected = Buffer.from('a')
    const failed = storeFor(providerOutput(broken, expected), 4)
    try {
      await failed.store.get('failed/key')
      throw new Error('Expected GET to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectStoreError)
      expect(error).toMatchObject({ code: 'OBJECT_STORE_PROVIDER_FAILURE' })
      expect(JSON.stringify(error)).not.toContain('private-provider-stream-detail')
    }

    let cancelled = 0
    const malformed = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: 'not bytes' }
          },
          async return() {
            cancelled += 1
            return { done: true, value: undefined }
          },
        }
      },
    }
    const malformedResult = storeFor(providerOutput(malformed, expected), 4)
    await expect(malformedResult.store.get('malformed/key')).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    expect(cancelled).toBeGreaterThan(0)
  })
})
