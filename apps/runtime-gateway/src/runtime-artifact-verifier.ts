import { createHash } from 'node:crypto'
import { RuntimeCommandRecordSchema, type RuntimeCommandRecord } from '@control-plane/domain'
import type { ObjectStore, StoredObjectDescriptor } from '@control-plane/deployment'
import { GatewayArtifactReferenceSchema } from '@control-plane/runtime-gateway-protocol'

type GatewayArtifactReference = ReturnType<typeof GatewayArtifactReferenceSchema.parse>

export interface RuntimeCommandArtifactVerifierOptions {
  readonly maxArtifactBytes?: number
}

const DEFAULT_MAX_ARTIFACT_BYTES = 262144
const ABSOLUTE_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

/** Verifies a terminal result against the deterministic object written for its attempt. */
export class RuntimeCommandArtifactVerifier {
  readonly #objectStore: ObjectStore
  readonly #maxArtifactBytes: number

  constructor(objectStore: ObjectStore, options: RuntimeCommandArtifactVerifierOptions = {}) {
    const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
    if (
      !Number.isSafeInteger(maxArtifactBytes) ||
      maxArtifactBytes <= 0 ||
      maxArtifactBytes > ABSOLUTE_MAX_ARTIFACT_BYTES
    ) {
      throw new Error('RUNTIME_ARTIFACT_LIMIT_INVALID')
    }
    this.#objectStore = objectStore
    this.#maxArtifactBytes = maxArtifactBytes
  }

  async verify(input: {
    readonly command: RuntimeCommandRecord
    readonly artifact: GatewayArtifactReference
  }): Promise<void> {
    try {
      const command = RuntimeCommandRecordSchema.parse(input.command)
      const artifact = GatewayArtifactReferenceSchema.parse(input.artifact)
      const key = `runtime-results/${command.attemptId}/result.json`
      const expectedArtifactId = `art_${command.attemptId.slice(4)}`
      if (
        artifact.artifactId !== expectedArtifactId ||
        !Number.isSafeInteger(artifact.sizeBytes) ||
        artifact.sizeBytes < 0 ||
        artifact.sizeBytes > this.#maxArtifactBytes
      ) {
        throw new Error('invalid reference')
      }

      const head = await this.#objectStore.head(key)
      this.#assertDescriptor(head, key, command.attemptId, artifact.mediaType)
      if (
        head.size !== artifact.sizeBytes ||
        head.sha256 !== artifact.digest ||
        head.size > this.#maxArtifactBytes
      ) {
        throw new Error('reference mismatch')
      }

      const stored = await this.#objectStore.get(key)
      this.#assertDescriptor(stored, key, command.attemptId, artifact.mediaType)
      if (
        stored.size !== head.size ||
        stored.sha256 !== head.sha256 ||
        stored.contentType !== head.contentType ||
        !this.#sameMetadata(stored.metadata, head.metadata) ||
        !(stored.body instanceof Uint8Array) ||
        stored.body.byteLength !== stored.size ||
        stored.body.byteLength !== artifact.sizeBytes ||
        this.#digest(stored.body) !== artifact.digest
      ) {
        throw new Error('stored bytes mismatch')
      }
    } catch {
      // Object-store exceptions can contain provider paths, credentials, or request data.
      throw new Error('RUNTIME_ARTIFACT_VERIFICATION_FAILED')
    }
  }

  #assertDescriptor(
    descriptor: StoredObjectDescriptor,
    key: string,
    attemptId: string,
    mediaType: string
  ): void {
    if (
      descriptor.key !== key ||
      descriptor.metadata['attempt'] !== attemptId ||
      descriptor.contentType !== mediaType ||
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size < 0 ||
      descriptor.size > this.#maxArtifactBytes ||
      !/^sha256:[a-f0-9]{64}$/.test(descriptor.sha256)
    ) {
      throw new Error('invalid stored descriptor')
    }
  }

  #digest(body: Uint8Array): string {
    return `sha256:${createHash('sha256').update(body).digest('hex')}`
  }

  #sameMetadata(
    left: Readonly<Record<string, string>>,
    right: Readonly<Record<string, string>>
  ): boolean {
    const leftKeys = Object.keys(left).toSorted()
    const rightKeys = Object.keys(right).toSorted()
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
    )
  }
}
