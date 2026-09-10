import {
  redactDiagnostics,
  type ApplicationMetadata,
  type ManagedCloudConfiguration,
  type ServiceConfiguration,
  type ServiceName,
} from '@control-plane/config'
import type { StructuredLogger } from './logger.js'
import type { ProcessAdapter, ProcessEvent, ProcessListener } from './process.js'

export interface ServiceResource {
  readonly name: string
  readonly close: () => void | Promise<void>
}

export interface ServiceStartContext<Service extends ServiceName> {
  readonly config: ServiceConfiguration<Service>
  readonly managedCloud?: ManagedCloudConfiguration
  readonly metadata: ApplicationMetadata<Service>
  health(): HealthResponse
  markReady(): void
  readiness(): ReadinessResponse
  registerResource(name: string, close: ServiceResource['close']): void
}

export interface HealthResponse {
  readonly status: 'ok'
  readonly metadata: ApplicationMetadata
}

export interface ReadinessResponse {
  readonly status: 'not_ready' | 'ready'
  readonly metadata: ApplicationMetadata
}

export class ServiceRuntime<Service extends ServiceName> {
  readonly metadata: ApplicationMetadata<Service>
  readonly #config: ServiceConfiguration<Service>
  readonly #managedCloud: ManagedCloudConfiguration | undefined
  readonly #logger: StructuredLogger
  readonly #process: ProcessAdapter
  readonly #resources: ServiceResource[] = []
  readonly #listeners = new Map<ProcessEvent, ProcessListener>()
  #ready = false
  #shutdownPromise?: Promise<void>

  constructor(
    config: ServiceConfiguration<Service>,
    logger: StructuredLogger,
    processAdapter: ProcessAdapter,
    managedCloud?: ManagedCloudConfiguration
  ) {
    this.#config = config
    this.#managedCloud = managedCloud
    this.metadata = config.metadata
    this.#logger = logger
    this.#process = processAdapter
    this.#installProcessListeners()
  }

  context(): ServiceStartContext<Service> {
    return {
      config: this.#config,
      ...(this.#managedCloud === undefined ? {} : { managedCloud: this.#managedCloud }),
      metadata: this.metadata,
      health: () => this.health(),
      markReady: () => {
        this.#ready = true
      },
      readiness: () => this.readiness(),
      registerResource: (name, close) => {
        this.#resources.push({ name, close })
      },
    }
  }

  health(): HealthResponse {
    return { status: 'ok', metadata: this.metadata }
  }

  readiness(): ReadinessResponse {
    return { status: this.#ready ? 'ready' : 'not_ready', metadata: this.metadata }
  }

  shutdown(reason: string): Promise<void> {
    this.#shutdownPromise ??= this.#performShutdown(reason)
    return this.#shutdownPromise
  }

  async handleFatal(event: string, error: unknown): Promise<void> {
    this.#logger.write({
      level: 'error',
      event: 'service.fatal',
      metadata: this.metadata,
      details: { source: event, error: redactDiagnostics(error) },
    })
    this.#process.setExitCode(1)
    await this.shutdown(event)
  }

  #installProcessListeners(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      this.#addListener(signal, async () => {
        await this.shutdown(signal)
        this.#process.setExitCode(0)
      })
    }
    for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
      this.#addListener(event, (error) => this.handleFatal(event, error))
    }
  }

  #addListener(event: ProcessEvent, listener: ProcessListener): void {
    this.#listeners.set(event, listener)
    this.#process.on(event, listener)
  }

  async #performShutdown(reason: string): Promise<void> {
    this.#ready = false
    this.#logger.write({
      level: 'info',
      event: 'service.stopping',
      metadata: this.metadata,
      details: { reason },
    })
    for (const resource of [...this.#resources].toReversed()) {
      try {
        await resource.close()
      } catch (error) {
        this.#logger.write({
          level: 'error',
          event: 'service.resource_close_failed',
          metadata: this.metadata,
          details: { resource: resource.name, error: redactDiagnostics(error) },
        })
      }
    }
    for (const [event, listener] of this.#listeners) this.#process.off(event, listener)
    this.#listeners.clear()
    this.#logger.write({ level: 'info', event: 'service.stopped', metadata: this.metadata })
  }
}
