import { once } from 'node:events'
import { createServer } from 'node:http'

export interface NativeModelListener {
  readonly origin: string
  close(): Promise<void>
}

/** One owned, loopback-only listener per attempt. Its private bearer capability
 * is checked by the broker; disconnects propagate cancellation to the send.
 */
export async function startNativeModelListener(
  fetch: (request: Request) => Promise<Response>
): Promise<NativeModelListener> {
  const server = createServer(
    {
      maxHeaderSize: 16_384,
      headersTimeout: 5_000,
      requestTimeout: 15_000,
      keepAliveTimeout: 1_000,
    },
    async (incoming, outgoing) => {
      const abort = new AbortController()
      const disconnected = () => {
        if (!outgoing.writableFinished) abort.abort()
      }
      incoming.once('aborted', disconnected)
      outgoing.once('close', disconnected)
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        if (
          incoming.method !== 'POST' ||
          incoming.url !== '/v1/chat/completions' ||
          incoming.rawHeaders.filter(
            (_, i) => i % 2 === 0 && incoming.rawHeaders[i]?.toLowerCase() === 'authorization'
          ).length !== 1
        )
          throw new Error('INVALID_NATIVE_REQUEST')
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of incoming) {
          bytes += chunk.length
          if (bytes > 1_048_576) throw new Error('INVALID_NATIVE_REQUEST')
          chunks.push(Buffer.from(chunk))
        }
        abort.signal.throwIfAborted()
        const result = await fetch(
          new Request('http://127.0.0.1/v1/chat/completions', {
            method: 'POST',
            headers: {
              authorization: incoming.headers.authorization ?? '',
              'content-type': incoming.headers['content-type'] ?? '',
            },
            body: Buffer.concat(chunks).toString('utf8'),
            signal: abort.signal,
          })
        )
        outgoing.writeHead(result.status, Object.fromEntries(result.headers))
        if (result.body) {
          reader = result.body.getReader()
          while (true) {
            const next = await reader.read()
            abort.signal.throwIfAborted()
            if (next.done) break
            if (!outgoing.write(next.value)) await once(outgoing, 'drain', { signal: abort.signal })
          }
        }
        outgoing.end()
      } catch {
        abort.abort()
        if (!outgoing.headersSent && !outgoing.destroyed) {
          outgoing.writeHead(400, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          })
          outgoing.end(JSON.stringify({ error: { code: 'MODEL_BROKER_INVALID_REQUEST' } }))
        } else outgoing.destroy()
      } finally {
        await reader?.cancel().catch(() => undefined)
        reader?.releaseLock()
        incoming.off('aborted', disconnected)
        outgoing.off('close', disconnected)
      }
    }
  )
  server.maxConnections = 16
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('MODEL_BROKER_LISTENER_UNAVAILABLE')
    let closing: Promise<void> | undefined
    return {
      origin: `http://127.0.0.1:${address.port}`,
      close: () =>
        (closing ??= new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })),
    }
  } catch (error) {
    server.close()
    server.closeAllConnections()
    throw error
  }
}
