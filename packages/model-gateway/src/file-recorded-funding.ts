import { createHash } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ModelFundingOwnerSchema,
} from '@control-plane/contracts'
import {
  ExecutionModelSelectionBindingSchema,
  type CurrentModelExecutionAuthority,
} from './execution-selection.js'
import {
  RecordedModelFundingDecisionSchema,
  type RecordedModelFundingAuthority,
} from './funding-view.js'
import { ModelSelectionError } from './selection-service.js'

const PayerRecord = z.strictObject({
  schemaVersion: z.literal('recorded-funding-payer/v1'),
  workspaceId: IdentifierSchemas.workspaceId,
  authorizationRef: z.string().min(1).max(256),
  fundingOwner: ModelFundingOwnerSchema,
  status: z.enum(['active', 'revoked']),
  expiresAt: z.iso.datetime(),
})
const deny = (): never => {
  throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
}
const same = (a: unknown, b: unknown) => canonicalJsonStringify(a) === canonicalJsonStringify(b)

/** Opt-in Node operator-owned metadata source. Files must already exist, be private,
 * owned by the host uid and not symlinks. This adapter never writes authorization,
 * credentials or provider account state and never reads legacy secret-containing files.
 * Spending authority must separately validate the SAME recorded grant at physical send.
 */
export function createFileRecordedModelFundingAuthority(options: {
  directory: string
  currentExecutionAuthority: CurrentModelExecutionAuthority
  now?: () => string
}): RecordedModelFundingAuthority {
  // Construct after package initialization: the existing HTTP/schema exports have
  // a legacy index cycle, so eager dependent schema construction can hit a TDZ.
  const HostRecord = z.strictObject({
    schemaVersion: z.literal('recorded-funding-host/v1'),
    binding: ExecutionModelSelectionBindingSchema,
    decision: RecordedModelFundingDecisionSchema,
    status: z.enum(['active', 'revoked']),
    expiresAt: z.iso.datetime(),
  })
  const uid = process.getuid?.()
  const now = options.now ?? (() => new Date().toISOString())
  let directory: string
  try {
    if (uid === undefined || lstatSync(options.directory).isSymbolicLink()) deny()
    directory = realpathSync(options.directory)
  } catch {
    return deny()
  }
  function privatePath(path: string) {
    for (let component = path; ; component = dirname(component)) {
      const stat = lstatSync(component)
      if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) deny()
      if (component === directory) return
      if (component === dirname(component)) deny()
    }
  }
  function read(path: string) {
    privatePath(path)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = fstatSync(fd)
      if (
        !before.isFile() ||
        before.uid !== uid ||
        (before.mode & 0o077) !== 0 ||
        before.size > 65536
      )
        deny()
      const raw = readFileSync(fd, 'utf8')
      const after = fstatSync(fd)
      if (raw.length > 65536 || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        deny()
      return { raw, value: JSON.parse(raw) }
    } finally {
      closeSync(fd)
    }
  }
  return {
    async readCurrent(input) {
      try {
        const binding = ExecutionModelSelectionBindingSchema.parse(input)
        await options.currentExecutionAuthority.assertCurrent(structuredClone(binding))
        const path = join(
          directory,
          binding.workspaceId,
          binding.executionId,
          `${binding.attemptId}.json`
        )
        const first = read(path)
        const record = HostRecord.parse(first.value)
        const payerPath = join(
          directory,
          binding.workspaceId,
          'payers',
          `${createHash('sha256').update(record.decision.fundingOwner.ownerRef).digest('hex')}.json`
        )
        const payerFirst = read(payerPath)
        const payer = PayerRecord.parse(payerFirst.value)
        const check = () => {
          const at = Date.parse(now())
          const decision = record.decision
          if (
            !Number.isFinite(at) ||
            record.status !== 'active' ||
            payer.status !== 'active' ||
            at >= Date.parse(record.expiresAt) ||
            at >= Date.parse(payer.expiresAt) ||
            Math.min(Date.parse(record.expiresAt), Date.parse(payer.expiresAt)) <
              Math.min(
                Date.parse(decision.grant.expiresAt),
                Date.parse(decision.price.validUntil)
              ) ||
            at < Date.parse(decision.grant.issuedAt) ||
            at >= Date.parse(decision.grant.expiresAt) ||
            at < Date.parse(decision.price.validFrom) ||
            at >= Date.parse(decision.price.validUntil) ||
            !same(record.binding, binding) ||
            payer.workspaceId !== binding.workspaceId ||
            payer.authorizationRef !== decision.grant.authorizationId ||
            !same(payer.fundingOwner, decision.fundingOwner) ||
            decision.executionPlanId !== binding.executionPlanId ||
            decision.executionPlanDigest !== binding.executionPlanDigest ||
            decision.selectionRef !== binding.selectionRef ||
            decision.selectionRevision !== binding.selectionRevision ||
            decision.canonicalActorPrincipalId !== binding.canonicalActorPrincipalId ||
            decision.authorityRevision !== binding.authorityRevision ||
            decision.grant.workspaceId !== binding.workspaceId ||
            decision.grant.executionId !== binding.executionId ||
            decision.grant.attemptId !== binding.attemptId ||
            decision.grant.principalRef !== binding.principalRef ||
            decision.grant.alias !== binding.modelAlias ||
            decision.grant.policySnapshotDigest !== binding.policySnapshotDigest
          )
            deny()
        }
        check()
        await options.currentExecutionAuthority.assertCurrent(structuredClone(binding))
        if (read(path).raw !== first.raw || read(payerPath).raw !== payerFirst.raw) deny()
        check()
        return structuredClone(record.decision)
      } catch {
        return deny()
      }
    },
  }
}
