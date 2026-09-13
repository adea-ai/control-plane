import { createHash } from 'node:crypto'
import type {
  ObjectStore,
  ObjectStoreErrorCode,
  PutObjectInput,
  StoredObject,
  StoredObjectDescriptor,
} from '@control-plane/deployment'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

export * from './filesystem.js'

const MAX_KEY_BYTES = 1_024
const MAX_CONTENT_TYPE_BYTES = 255
const MAX_METADATA_ENTRIES = 16
const MAX_METADATA_BYTES = 8_192
const CHECKSUM_METADATA_KEY = 'control-plane-sha256'

export type {
  ObjectStore,
  ObjectStoreErrorCode,
  PutObjectInput,
  StoredObject,
  StoredObjectDescriptor,
} from '@control-plane/deployment'

export class ObjectStoreError extends Error {
  constructor(
    readonly code: ObjectStoreErrorCode,
    readonly retryable: boolean
  ) {
    super('Object store operation failed')
    this.name = 'ObjectStoreError'
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { name: this.name, message: this.message, code: this.code, retryable: this.retryable }
  }
}

export interface S3CompatibleObjectStoreConfiguration {
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /**
   * Optional environment separation prefix applied to every object key. Staging and
   * preview environments use a distinct prefix so their objects cannot be addressed
   * with production keys from the same bucket.
   */
  readonly prefix?: string
}

export interface R2ObjectStoreConfiguration extends S3CompatibleObjectStoreConfiguration {
  readonly region: 'auto'
}

interface S3ObjectClient {
  send(command: unknown): Promise<unknown>
  destroy?(): void
}

export interface R2ObjectStoreOptions {
  readonly bucket: string
  readonly client: S3ObjectClient
  readonly maxObjectBytes: number
  readonly prefix?: string
}

export interface CreateR2ObjectStoreOptions {
  readonly maxObjectBytes: number
  readonly createClient?: (configuration: S3ClientConfig) => S3ObjectClient
}

export function createR2ObjectStore(
  configuration: R2ObjectStoreConfiguration,
  options: CreateR2ObjectStoreOptions
): R2ObjectStore {
  return createS3CompatibleObjectStore(configuration, options)
}

export function createS3CompatibleObjectStore(
  configuration: S3CompatibleObjectStoreConfiguration,
  options: CreateR2ObjectStoreOptions
): R2ObjectStore {
  const createClient = options.createClient ?? ((value) => new S3Client(value) as S3ObjectClient)
  const client = createClient({
    endpoint: configuration.endpoint,
    region: configuration.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
    },
  })
  return new R2ObjectStore({
    bucket: configuration.bucket,
    client,
    maxObjectBytes: options.maxObjectBytes,
    ...(configuration.prefix === undefined ? {} : { prefix: configuration.prefix }),
  })
}

export class R2ObjectStore implements ObjectStore {
  readonly #bucket: string
  readonly #client: S3ObjectClient
  readonly #maxObjectBytes: number
  readonly #prefix: string

  constructor(options: R2ObjectStoreOptions) {
    if (!/^[A-Za-z0-9._-]{3,63}$/.test(options.bucket)) invalidInput()
    if (!Number.isSafeInteger(options.maxObjectBytes) || options.maxObjectBytes <= 0) invalidInput()
    const prefix = options.prefix ?? ''
    if (
      prefix !== '' &&
      (!/^[A-Za-z0-9._/-]{1,128}$/.test(prefix) ||
        prefix.startsWith('/') ||
        prefix.includes('//') ||
        prefix.split('/').some((segment) => segment === '.' || segment === '..'))
    )
      invalidInput()
    this.#bucket = options.bucket
    this.#prefix = prefix
    this.#client = options.client
    this.#maxObjectBytes = options.maxObjectBytes
  }

  /** Internal bucket address for a caller-visible key; descriptors expose the visible key. */
  #address(visibleKey: string): string {
    return this.#prefix === '' ? visibleKey : `${this.#prefix}${visibleKey}`
  }

  async put(input: PutObjectInput): Promise<StoredObjectDescriptor> {
    const visibleKey = validKey(input.key)
    const key = this.#address(visibleKey)
    if (!(input.body instanceof Uint8Array)) invalidInput()
    if (input.body.byteLength > this.#maxObjectBytes) tooLarge()
    const contentType = optionalContentType(input.contentType)
    const metadata = validMetadata(input.metadata ?? {})
    const sha256 = digest(input.body)
    try {
      const output = asRecord(
        await this.#client.send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            Body: input.body,
            ContentLength: input.body.byteLength,
            ...(contentType === undefined ? {} : { ContentType: contentType }),
            Metadata: { ...metadata, [CHECKSUM_METADATA_KEY]: sha256.slice('sha256:'.length) },
          })
        )
      )
      const etag = optionalString(output['ETag'])
      return descriptor({
        key: visibleKey,
        size: input.body.byteLength,
        ...(contentType === undefined ? {} : { contentType }),
        ...(etag === undefined ? {} : { etag }),
        sha256,
        metadata,
      })
    } catch (error) {
      throw normalizeProviderError(error)
    }
  }

  async get(keyValue: string): Promise<StoredObject> {
    const visibleKey = validKey(keyValue)
    const key = this.#address(visibleKey)
    try {
      const output = asRecord(
        await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }))
      )
      const body = await readBody(output['Body'])
      if (body.byteLength > this.#maxObjectBytes) tooLarge()
      const result = descriptorFromProvider(visibleKey, output)
      if (result.size !== body.byteLength) integrityFailure()
      if (result.sha256 !== digest(body)) integrityFailure()
      return { ...result, body }
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      throw normalizeProviderError(error)
    }
  }

  async head(keyValue: string): Promise<StoredObjectDescriptor> {
    const visibleKey = validKey(keyValue)
    const key = this.#address(visibleKey)
    try {
      const output = asRecord(
        await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }))
      )
      const result = descriptorFromProvider(visibleKey, output)
      if (result.size > this.#maxObjectBytes) tooLarge()
      return result
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      throw normalizeProviderError(error)
    }
  }

  async delete(keyValue: string): Promise<void> {
    const key = this.#address(validKey(keyValue))
    try {
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }))
    } catch (error) {
      throw normalizeProviderError(error)
    }
  }

  close(): void {
    this.#client.destroy?.()
  }
}

function descriptorFromProvider(
  key: string,
  output: Readonly<Record<string, unknown>>
): StoredObjectDescriptor {
  const size = output['ContentLength']
  if (!Number.isSafeInteger(size) || (size as number) < 0) integrityFailure()
  const providerMetadata = stringRecord(output['Metadata'])
  const checksum = providerMetadata[CHECKSUM_METADATA_KEY]
  if (checksum === undefined || !/^[0-9a-f]{64}$/i.test(checksum)) integrityFailure()
  const metadata = Object.fromEntries(
    Object.entries(providerMetadata).filter(([name]) => name !== CHECKSUM_METADATA_KEY)
  )
  const contentType = optionalString(output['ContentType'])
  const etag = optionalString(output['ETag'])
  return descriptor({
    key,
    size: size as number,
    ...(contentType === undefined ? {} : { contentType }),
    ...(etag === undefined ? {} : { etag }),
    sha256: `sha256:${checksum.toLowerCase()}`,
    metadata,
  })
}

function descriptor(input: {
  readonly key: string
  readonly size: number
  readonly contentType?: string
  readonly etag?: string
  readonly sha256: `sha256:${string}`
  readonly metadata: Readonly<Record<string, string>>
}): StoredObjectDescriptor {
  return {
    key: input.key,
    size: input.size,
    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
    ...(input.etag === undefined ? {} : { etag: input.etag }),
    sha256: input.sha256,
    metadata: { ...input.metadata },
  }
}

async function readBody(value: unknown): Promise<Uint8Array> {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof Reflect.get(value, 'transformToByteArray') !== 'function'
  ) {
    integrityFailure()
  }
  const transformed = await Reflect.apply(Reflect.get(value, 'transformToByteArray'), value, [])
  if (!(transformed instanceof Uint8Array)) integrityFailure()
  return transformed
}

function validKey(value: string): string {
  const bytes = Buffer.byteLength(value)
  const segments = value.split('/')
  if (
    bytes === 0 ||
    bytes > MAX_KEY_BYTES ||
    value.startsWith('/') ||
    containsControlCharacter(value) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    invalidInput()
  }
  return value
}

function optionalContentType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (
    Buffer.byteLength(value) === 0 ||
    Buffer.byteLength(value) > MAX_CONTENT_TYPE_BYTES ||
    /[\r\n]/.test(value)
  ) {
    invalidInput()
  }
  return value
}

function validMetadata(value: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(value)
  if (entries.length > MAX_METADATA_ENTRIES) invalidInput()
  let bytes = 0
  const metadata: Record<string, string> = {}
  for (const [name, entry] of entries) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      name === CHECKSUM_METADATA_KEY ||
      containsControlCharacter(entry)
    ) {
      invalidInput()
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(entry)
    if (bytes > MAX_METADATA_BYTES) invalidInput()
    metadata[name] = entry
  }
  return metadata
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function normalizeProviderError(error: unknown): ObjectStoreError {
  const metadata =
    typeof error === 'object' && error !== null ? asRecord(Reflect.get(error, '$metadata')) : {}
  const status = metadata['httpStatusCode']
  const name = error instanceof Error ? error.name : undefined
  if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') {
    return new ObjectStoreError('OBJECT_STORE_NOT_FOUND', false)
  }
  const retryable =
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500) ||
    status === undefined
  return new ObjectStoreError('OBJECT_STORE_PROVIDER_FAILURE', retryable)
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) as number
    return code <= 31 || code === 127
  })
}

function invalidInput(): never {
  throw new ObjectStoreError('OBJECT_STORE_INVALID_INPUT', false)
}

function tooLarge(): never {
  throw new ObjectStoreError('OBJECT_STORE_TOO_LARGE', false)
}

function integrityFailure(): never {
  throw new ObjectStoreError('OBJECT_STORE_INTEGRITY_FAILURE', false)
}
