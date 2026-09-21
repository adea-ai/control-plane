import {
  ManagedPiConfigurationSchema,
  type ManagedPiEvent,
  type ManagedPiStatus,
} from '@control-plane/managed-pi-adapter'
import {
  RuntimeArtifactReferenceSchema,
  RuntimeCapabilitySchema,
  type RuntimeApprovalRequest,
  type RuntimeCancelRequest,
  type RuntimeExecutionHandle,
  type RuntimeInputRequest,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const SemanticVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const AuthorityReferenceSchema = z
  .string()
  .min(12)
  .max(256)
  .regex(/^authz:[A-Za-z0-9._:-]+$/)
export const HostedAuthoritySchema = z
  .object({
    modelGrantRefs: z
      .array(AuthorityReferenceSchema)
      .max(32)
      .refine((values) => new Set(values).size === values.length),
    toolGrantRefs: z
      .array(AuthorityReferenceSchema)
      .max(128)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
const HostedSandboxSchema = ManagedPiConfigurationSchema.shape.limits.shape.sandbox

export const HostedRuntimeHostInspectionSchema = z
  .object({
    providerFamily: z.string().regex(/^[a-z][a-z0-9-]*$/),
    driverVersion: SemanticVersionSchema,
    harnessVersion: SemanticVersionSchema,
    health: z.enum(['healthy', 'degraded', 'unavailable']),
    capabilities: z
      .array(RuntimeCapabilitySchema)
      .max(64)
      .refine(
        (values) => new Set(values.map(({ name }) => name)).size === values.length,
        'Hosted capability identities must be unique'
      ),
    limitations: z.array(z.string().min(1).max(512)).max(64),
    capacity: z
      .object({
        maximumConcurrent: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        queued: z.number().int().nonnegative(),
      })
      .strict(),
    limits: z
      .object({
        maximumDurationMs: z.number().int().positive(),
        sandbox: HostedSandboxSchema,
      })
      .strict(),
    observedAt: TimestampSchema,
  })
  .strict()
  .refine(
    ({ capacity }) => capacity.active <= capacity.maximumConcurrent,
    'Active hosted work cannot exceed advertised capacity'
  )

export const HostedManagedPiLaunchRequestSchema = z
  .object({
    attemptId: z.string().regex(/^att_[0-9A-HJKMNP-TV-Z]{26}$/),
    idempotencyKey: z.string().min(1).max(256),
    configuration: ManagedPiConfigurationSchema,
    authority: HostedAuthoritySchema,
    sandbox: HostedSandboxSchema,
    maximumDurationMs: z.number().int().positive(),
    deadlineAt: TimestampSchema,
  })
  .strict()

export type HostedRuntimeHostInspection = z.output<typeof HostedRuntimeHostInspectionSchema>
export type HostedManagedPiLaunchRequest = z.output<typeof HostedManagedPiLaunchRequestSchema>
export type HostedManagedPiAuthority = z.output<typeof HostedAuthoritySchema>

export interface HostedArtifactStore {
  persist(input: {
    readonly attemptId: string
    readonly mediaType: string
    readonly value: z.util.JSONType
  }): Promise<z.output<typeof RuntimeArtifactReferenceSchema>>
}

export interface RuntimeHostProvider {
  inspect(): Promise<HostedRuntimeHostInspection>
  /** Read an admitted launch without launching work or renewing its authority/deadline.
   * Production providers must retain this receipt across worker restarts.
   */
  getLaunch(idempotencyKey: string): Promise<
    | {
        readonly request: HostedManagedPiLaunchRequest
        readonly handle: RuntimeExecutionHandle
      }
    | undefined
  >
  launch(request: HostedManagedPiLaunchRequest): Promise<RuntimeExecutionHandle>
  progress(
    handle: RuntimeExecutionHandle,
    afterSequence?: number,
    signal?: AbortSignal
  ): AsyncIterable<ManagedPiEvent>
  status(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus>
  reconcile(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus>
  submitInput(
    handle: RuntimeExecutionHandle,
    request: RuntimeInputRequest
  ): Promise<ManagedPiStatus>
  submitApproval(
    handle: RuntimeExecutionHandle,
    request: RuntimeApprovalRequest
  ): Promise<ManagedPiStatus>
  cancel(handle: RuntimeExecutionHandle, request: RuntimeCancelRequest): Promise<ManagedPiStatus>
  cleanup(handle: RuntimeExecutionHandle): Promise<void>
  close(): Promise<void>
}
