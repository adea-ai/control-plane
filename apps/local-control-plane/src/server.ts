import http, { type Server } from 'node:http'
import type { HealthResponse, ReadinessResponse } from '@control-plane/bootstrap'
import type { LocalComponentManifest } from './composition.js'

const MAX_REQUEST_TARGET_BYTES = 2_048

export interface LocalApiServerOptions {
  readonly port: number
  readonly manifest: () => Promise<LocalComponentManifest>
  readonly health: () => HealthResponse
  readonly readiness: () => ReadinessResponse
}

export class LocalApiServer {
  readonly #port: number
  readonly #manifest: LocalApiServerOptions['manifest']
  readonly #health: LocalApiServerOptions['health']
  readonly #readiness: LocalApiServerOptions['readiness']
  #server: Server | undefined

  constructor(options: LocalApiServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new Error('LOCAL_API_PORT_INVALID')
    }
    this.#port = options.port
    this.#manifest = options.manifest
    this.#health = options.health
    this.#readiness = options.readiness
  }

  get address(): string | undefined {
    const address = this.#server?.address()
    return typeof address === 'object' && address !== null
      ? `http://127.0.0.1:${address.port}`
      : undefined
  }

  start(): Promise<void> {
    if (this.#server !== undefined) throw new Error('LOCAL_API_ALREADY_STARTED')
    const server = http.createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store')
      response.setHeader('content-type', 'application/json')
      response.setHeader('x-content-type-options', 'nosniff')
      if (
        request.url === undefined ||
        Buffer.byteLength(request.url) > MAX_REQUEST_TARGET_BYTES ||
        request.method !== 'GET'
      ) {
        writeJson(response, 405, { code: 'METHOD_NOT_ALLOWED' })
        return
      }
      if (request.url === '/health') {
        writeJson(response, 200, this.#health())
        return
      }
      if (request.url === '/ready') {
        const readiness = this.#readiness()
        const manifest = await this.#manifest().catch(() => undefined)
        const ready =
          readiness.status === 'ready' &&
          manifest !== undefined &&
          manifest.components.every((component) => component.ready)
        writeJson(response, ready ? 200 : 503, {
          ...readiness,
          status: ready ? 'ready' : 'not_ready',
        })
        return
      }
      if (request.url === '/v1/components') {
        const manifest = await this.#manifest().catch(() => undefined)
        const ready =
          this.#readiness().status === 'ready' &&
          manifest !== undefined &&
          manifest.components.every((component) => component.ready)
        writeJson(response, ready ? 200 : 503, { schemaVersion: 1, ready })
        return
      }
      writeJson(response, 404, { code: 'NOT_FOUND' })
    })
    this.#server = server
    return new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  }

  close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status)
  response.end(JSON.stringify(body))
}
