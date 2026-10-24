import { z } from 'zod'

const Reference = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => value.trim() === value)
const Revision = z.number().int().nonnegative().safe()

/** Structural evidence only; parsing cannot establish independence from restored stores. */
export const PiRestoreGenerationSnapshotSchema = z.strictObject({
  lineageId: Reference,
  restoreGeneration: Reference,
  revision: Revision,
  state: z.enum(['open', 'closing']),
})
export type PiRestoreGenerationSnapshot = z.infer<typeof PiRestoreGenerationSnapshotSchema>

const ExpectedGenerationSchema = PiRestoreGenerationSnapshotSchema.omit({ state: true })
export type PiRestoreGenerationExpected = z.infer<typeof ExpectedGenerationSchema>

/**
 * The provider must live outside every restorable product, CP and native snapshot.
 * This port does not supply that provider, advance generations or fence writers.
 * Implementations must fail on missing or ambiguous current authority.
 */
export interface PiRestoreGenerationAuthorityPort {
  readCurrent(lineageId: string): Promise<PiRestoreGenerationSnapshot>
}

export class UnavailablePiRestoreGenerationAuthority implements PiRestoreGenerationAuthorityPort {
  async readCurrent(_lineageId: string): Promise<PiRestoreGenerationSnapshot> {
    throw new Error('PI_RESTORE_GENERATION_AUTHORITY_UNAVAILABLE')
  }
}

/**
 * Dormant evidence reader, with no production wiring or independent storage provider.
 * A successful async read is only a snapshot, NOT atomic write/effect authority:
 * authority may change immediately after it resolves. Native admission and every
 * writer still require their own qualified commit-time fence. No cached/local
 * digest, caller generation or previous successful read substitutes for authority.
 */
export class PiRestoreGenerationEvidenceReader {
  constructor(
    private readonly authority: PiRestoreGenerationAuthorityPort = new UnavailablePiRestoreGenerationAuthority()
  ) {}

  async readCurrent(expected: PiRestoreGenerationExpected): Promise<PiRestoreGenerationSnapshot> {
    // Parse before awaiting, so caller mutation cannot change the expected pins in flight.
    const pins = ExpectedGenerationSchema.parse(expected)
    const result = PiRestoreGenerationSnapshotSchema.safeParse(
      await this.authority.readCurrent(pins.lineageId)
    )
    if (!result.success) throw new Error('PI_RESTORE_GENERATION_AUTHORITY_INVALID')
    const current = result.data
    if (
      current.lineageId !== pins.lineageId ||
      current.restoreGeneration !== pins.restoreGeneration ||
      current.revision !== pins.revision ||
      current.state !== 'open'
    )
      throw new Error('PI_RESTORE_GENERATION_EVIDENCE_CONFLICT')
    return current
  }
}
