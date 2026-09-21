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
  readonly #pending = new Map<
    string,
    {
      readonly fingerprint: string
      readonly result: Promise<z.output<typeof RuntimeArtifactReferenceSchema>>
    }
  >()

  constructor(objectStore: ObjectStore) {
    this.#objectStore = objectStore
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
    const result = this.#persist({ attemptId, mediaType, body })
    this.#pending.set(attemptId, { fingerprint, result })
    return result.catch((error: unknown) => {
      this.#pending.delete(attemptId)
      throw error
    })
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
      return artifactReference(input.attemptId, existing)
    }
    const stored = await this.#objectStore.put({
      key,
      body: input.body,
      contentType: input.mediaType,
      metadata: { attempt: input.attemptId },
    })
    if (stored.sha256 !== expectedDigest || stored.size !== input.body.byteLength) {
      throw new Error('HOSTED_ARTIFACT_INTEGRITY_FAILURE')
    }
    return artifactReference(input.attemptId, stored)
  }
}
