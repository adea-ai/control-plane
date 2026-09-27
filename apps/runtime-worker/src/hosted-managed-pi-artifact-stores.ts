import { createHash } from 'node:crypto'
import {
  ObjectStoreError,
  type ObjectStore,
  type StoredObjectDescriptor,
} from '@control-plane/object-store'
import { RuntimeArtifactReferenceSchema } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { type HostedArtifactStore } from './hosted-managed-pi-schemas.js'
import { artifactConflict, artifactReference, canonicalJson } from './hosted-managed-pi-protocol.js'

export class InMemoryHostedArtifactStore implements HostedArtifactStore {
  readonly #now: () => string
  readonly #records: Array<{
    readonly attemptId: string
    readonly createdAt: string
    readonly reference: z.output<typeof RuntimeArtifactReferenceSchema>
  }> = []

  constructor(options: { readonly now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async persist(input: {
    readonly attemptId: string
    readonly mediaType: string
    readonly value: z.util.JSONType
  }): Promise<z.output<typeof RuntimeArtifactReferenceSchema>> {
    const content = JSON.stringify(input.value)
    const index = this.#records.length
    const suffix = `${(index + 1).toString(32).toUpperCase()}`.padStart(26, '0')
    const reference = RuntimeArtifactReferenceSchema.parse({
      artifactId: `art_${suffix}`,
      version: 1,
      mediaType: input.mediaType,
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      sizeBytes: Buffer.byteLength(content),
      locator: 'artifact://hosted-managed-pi/result',
    })
    this.#records.push({ attemptId: input.attemptId, createdAt: this.#now(), reference })
    return structuredClone(reference)
  }

  references(): Array<z.output<typeof RuntimeArtifactReferenceSchema>> {
    return this.#records.map(({ reference }) => structuredClone(reference))
  }
}

export class ObjectStoreHostedArtifactStore implements HostedArtifactStore {
  readonly #objectStore: ObjectStore
  readonly #createObject: NonNullable<ObjectStore['putIfAbsent']>
  readonly #maxResultBytes: number
  readonly #pending = new Map<
    string,
    {
      readonly fingerprint: string
      readonly result: Promise<z.output<typeof RuntimeArtifactReferenceSchema>>
    }
  >()

  constructor(objectStore: ObjectStore, options: { readonly maxResultBytes?: number } = {}) {
    this.#objectStore = objectStore
    this.#maxResultBytes = options.maxResultBytes ?? 262144
    if (
      !Number.isSafeInteger(this.#maxResultBytes) ||
      this.#maxResultBytes < 1 ||
      this.#maxResultBytes > 64 * 1024 * 1024
    )
      throw new Error('HOSTED_ARTIFACT_LIMIT_INVALID')
    if (typeof objectStore.putIfAbsent !== 'function')
      throw new Error('HOSTED_ARTIFACT_CONDITIONAL_CREATE_REQUIRED')
    this.#createObject = objectStore.putIfAbsent.bind(objectStore)
  }

  persist(input: {
    readonly attemptId: string
    readonly mediaType: string
    readonly value: z.util.JSONType
  }): Promise<z.output<typeof RuntimeArtifactReferenceSchema>> {
    const attemptId = z
      .string()
      .regex(/^att_[0-9A-HJKMNP-TV-Z]{26}$/)
      .parse(input.attemptId)
    const mediaType = z.string().min(1).max(255).parse(input.mediaType)
    const body = new TextEncoder().encode(canonicalJson(z.json().parse(input.value)))
    if (body.byteLength > this.#maxResultBytes)
      return Promise.reject(new Error('HOSTED_ARTIFACT_TOO_LARGE'))
    const fingerprint = createHash('sha256')
      .update(mediaType)
      .update('\0')
      .update(body)
      .digest('hex')
    const current = this.#pending.get(attemptId)
    if (current !== undefined) {
      if (current.fingerprint !== fingerprint) return Promise.reject(artifactConflict())
      return current.result
    }
    // Coalesce only in-flight writes. A completed promise is not evidence that
    // the object still exists or that its bytes remain readable and intact.
    const result = this.#persist({ attemptId, mediaType, body }).finally(() => {
      this.#pending.delete(attemptId)
    })
    this.#pending.set(attemptId, { fingerprint, result })
    return result
  }

  async #persist(input: {
    readonly attemptId: string
    readonly mediaType: string
    readonly body: Uint8Array
  }): Promise<z.output<typeof RuntimeArtifactReferenceSchema>> {
    const key = `runtime-results/${input.attemptId}/result.json`
    const expectedDigest = `sha256:${createHash('sha256').update(input.body).digest('hex')}`
    let existing: StoredObjectDescriptor | undefined
    try {
      existing = await this.#objectStore.head(key)
    } catch (error) {
      if (!(error instanceof ObjectStoreError) || error.code !== 'OBJECT_STORE_NOT_FOUND') {
        throw error
      }
    }
    if (existing !== undefined) {
      if (
        existing.sha256 !== expectedDigest ||
        existing.size !== input.body.byteLength ||
        existing.contentType !== input.mediaType
      ) {
        throw artifactConflict()
      }
      this.#assertBinding(existing, key, input.attemptId, input.mediaType)
      return this.#read(input, key, expectedDigest)
    }
    const result = await this.#createObject({
      key,
      body: input.body,
      contentType: input.mediaType,
      metadata: { attempt: input.attemptId },
    })
    if (result.outcome === 'exists') {
      // Another independent writer may have won since our initial HEAD. The
      // precondition response alone is not evidence of matching durable bytes.
      const winner = await this.#objectStore.head(key)
      this.#assertBinding(winner, key, input.attemptId, input.mediaType)
      if (winner.sha256 !== expectedDigest || winner.size !== input.body.byteLength)
        throw artifactConflict()
      return this.#read(input, key, expectedDigest)
    }
    if (result.outcome !== 'created') throw new Error('HOSTED_ARTIFACT_INTEGRITY_FAILURE')
    const stored = result.object
    this.#assertBinding(stored, key, input.attemptId, input.mediaType)
    if (stored.sha256 !== expectedDigest || stored.size !== input.body.byteLength) {
      throw new Error('HOSTED_ARTIFACT_INTEGRITY_FAILURE')
    }
    // PUT/HEAD metadata alone cannot prove a durable terminal artifact.
    return this.#read(input, key, expectedDigest)
  }

  async #read(
    input: { readonly attemptId: string; readonly mediaType: string; readonly body: Uint8Array },
    key: string,
    expectedDigest: string
  ): Promise<z.output<typeof RuntimeArtifactReferenceSchema>> {
    const head = await this.#objectStore.head(key)
    this.#assertBinding(head, key, input.attemptId, input.mediaType)
    if (head.sha256 !== expectedDigest || head.size !== input.body.byteLength)
      throw new Error('HOSTED_ARTIFACT_INTEGRITY_FAILURE')
    const stored = await this.#objectStore.get(key)
    this.#assertBinding(stored, key, input.attemptId, input.mediaType)
    if (
      !(stored.body instanceof Uint8Array) ||
      stored.body.byteLength !== input.body.byteLength ||
      stored.size !== stored.body.byteLength ||
      stored.sha256 !== expectedDigest ||
      `sha256:${createHash('sha256').update(stored.body).digest('hex')}` !== expectedDigest
    )
      throw new Error('HOSTED_ARTIFACT_INTEGRITY_FAILURE')
    return artifactReference(input.attemptId, stored)
  }

  #assertBinding(
    stored: StoredObjectDescriptor,
    key: string,
    attemptId: string,
    mediaType: string
  ): void {
    if (!Number.isSafeInteger(stored.size) || stored.size < 0 || stored.size > this.#maxResultBytes)
      throw new Error('HOSTED_ARTIFACT_TOO_LARGE')
    if (
      stored.key !== key ||
      stored.metadata['attempt'] !== attemptId ||
      stored.contentType !== mediaType
    )
      throw new Error('HOSTED_ARTIFACT_INTEGRITY_FAILURE')
  }
}
