// TEST ONLY. Real SQLite model/vault metadata and the actual credential callback;
// current account evidence and lease policy are explicit scripted trusted ports.
// No selection facade, native provider, Models object or live credential is substituted.
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ServiceCallerAssertionSchema,
} from '@control-plane/contracts'
import { CredentialVault, InMemorySecretProvider } from '@control-plane/credential-vault'
import {
  CurrentModelAccountAuthorization,
  CurrentModelAccountEvidenceSchema,
  ModelConnectionAdministration,
  ModelConnectionSchema,
  ModelSelectionService,
  PersistentModelSelectionRepository,
  WorkspaceModelDefaultsSchema,
  createPiDurableAccountAuthority,
} from '@control-plane/model-gateway'
import { PolicyDecisionSchema, PolicySnapshotReferenceSchema } from '@control-plane/policy'
import { SqliteCredentialVaultRepository } from '@control-plane/sqlite-persistence'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'

export const ProductionFactoryModelAlias = 'reasoning.standard'
export const ProductionFactoryModelTarget = Object.freeze({
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
})

/** The caller owns persistence and its lifetime. Reuse secretProvider when reopening
 * the fixture: SQLite retains encrypted references, while this synthetic backend is memory-only.
 * setupDefault provisions fixture metadata; the production factory creates its own real composition.
 */
export function createProductionFactoryModels(options) {
  const workspaceId = IdentifierSchemas.workspaceId.parse(options.workspaceId)
  const credentialRef = IdentifierSchemas.credentialId.parse(
    options.credentialRef ?? 'crd_01JABCDEF0123456789ABCDEFG'
  )
  const actorPrincipalId = options.actorPrincipalId
  const serviceId = (value) => ServiceCallerAssertionSchema.shape.servicePrincipalId.parse(value)
  const transportPrincipalId = serviceId(options.transportPrincipalId)
  const leasePrincipalRef = ModelConnectionSchema.shape.ownerRef.parse(options.leasePrincipalRef)
  const administratorPrincipalRef = serviceId(
    options.administratorPrincipalRef ?? 'svc_model-admin'
  )
  if (
    typeof actorPrincipalId !== 'string' ||
    !/^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      actorPrincipalId
    ) ||
    actorPrincipalId === transportPrincipalId ||
    actorPrincipalId === leasePrincipalRef
  )
    throw new Error('FACTORY_MODEL_PRINCIPALS_REQUIRED')
  if (!options.persistence || typeof options.persistence.transaction !== 'function')
    throw new Error('FACTORY_MODEL_PERSISTENCE_REQUIRED')
  const policySnapshot = PolicySnapshotReferenceSchema.parse(options.policySnapshot)
  const now = options.now ?? (() => '2026-10-08T00:00:00.000Z')
  const createdAt = now()
  const expiresAt = options.expiresAt ?? new Date(Date.parse(createdAt) + 3_600_000).toISOString()
  const providerModel = options.providerModel ?? 'gpt-5'
  const connectionRef = options.connectionRef ?? `mconn_${'6'.repeat(32)}`
  const repository = new PersistentModelSelectionRepository(options.persistence)
  const secretProvider = options.secretProvider ?? new InMemorySecretProvider()
  const state = {
    accountReads: 0,
    accountRequests: [],
    accountAvailable: true,
    leasePolicyChecks: 0,
    vaultPolicyAllowed: true,
  }
  let accountEvidence = CurrentModelAccountEvidenceSchema.parse({
    schemaVersion: 'model-account-authority/v1',
    evidenceRef: 'evidence:production-factory-account',
    observedAt: createdAt,
    expiresAt,
    workspaceId,
    credentialRef,
    credentialRevision: 1,
    provider: 'openai',
    accountRef: options.accountRef ?? 'account:production-factory',
    authKind: 'api_key',
    fundingSource: 'byo_api',
    models: [providerModel],
    workspaceGrant: {
      grantRef: options.grantRef ?? 'grant:production-factory-model',
      revision: 1,
      status: 'active',
      expiresAt,
    },
    allowedPrincipalRefs: [administratorPrincipalRef],
    targets: [ProductionFactoryModelTarget],
    entitlement: 'allowed',
    quota: 'available',
    residencyAllowed: true,
  })
  const currentAccountAuthority = createPiDurableAccountAuthority({
    registry: {
      piAiVersion: '1.1.0',
      piDurableVersion: '1.1.0',
      sourceRevision: '1cedd32724abfcb0915f76cc61b6827e2c16dbad',
      getModels: () => openaiProvider().getModels(),
    },
    currentAccount: {
      async readCurrent(input) {
        state.accountReads++
        state.accountRequests.push(structuredClone(input))
        if (
          !state.accountAvailable ||
          input.schemaVersion !== 'model-account-authority/v1' ||
          input.workspaceId !== workspaceId ||
          input.credentialRef !== credentialRef
        )
          return undefined
        // Fresh scripted observation on EVERY read; expiry/grant/quota/entitlement are not refreshed implicitly.
        return CurrentModelAccountEvidenceSchema.parse({
          ...accountEvidence,
          observedAt: input.requestedAt,
        })
      },
    },
  })
  const vault = new CredentialVault({
    provider: secretProvider,
    repository: new SqliteCredentialVaultRepository(options.persistence),
    now,
    decisionPoint: {
      async authorize(input) {
        state.leasePolicyChecks++
        const allowed =
          state.vaultPolicyAllowed &&
          input.action === 'credential:lease' &&
          input.principal.type === 'service' &&
          input.principal.id === leasePrincipalRef &&
          input.principal.workspaceId === workspaceId &&
          input.resource.type === 'credential' &&
          input.resource.id === credentialRef &&
          input.resource.workspaceId === workspaceId &&
          input.resource.attributes.operation === 'model:invoke' &&
          /^msel_[a-f0-9]{32}$/.test(input.resource.attributes.resourceRef) &&
          input.context.workspaceId === workspaceId &&
          canonicalJsonStringify(input.policySnapshot) === canonicalJsonStringify(policySnapshot)
        return PolicyDecisionSchema.parse({
          effect: allowed ? 'allow' : 'deny',
          decisionId: `sha256:${(allowed ? 'b' : 'c').repeat(64)}`,
          reasonCode: allowed ? 'FIXTURE_SCOPED_LEASE_ALLOW' : 'FIXTURE_SCOPED_LEASE_DENY',
          policySnapshot,
          evaluatedAt: input.context.requestedAt,
        })
      },
    },
  })
  const authorization = new CurrentModelAccountAuthorization(currentAccountAuthority, now)
  const administration = new ModelConnectionAdministration({
    repository,
    vault,
    grants: authorization,
  })
  const defaultsService = new ModelSelectionService({
    repository,
    vault,
    qualification: authorization,
    now,
  })
  const modelConnections = { repository, vault, currentAccountAuthority, now }
  return {
    modelConnections,
    repository,
    vault,
    secretProvider,
    state,
    modelAlias: ProductionFactoryModelAlias,
    target: ProductionFactoryModelTarget,
    refs: {
      workspaceId,
      credentialRef,
      credentialRevision: 1,
      connectionRef,
      providerModel,
      actorPrincipalId,
      transportPrincipalId,
      leasePrincipalRef,
      administratorPrincipalRef,
      accountRef: accountEvidence.accountRef,
      grantRef: accountEvidence.workspaceGrant.grantRef,
      deploymentCredentialRef: `vault://${credentialRef}/1`,
    },
    currentAccountEvidence: () => structuredClone(accountEvidence),
    setCurrentAccount(patch) {
      accountEvidence = CurrentModelAccountEvidenceSchema.parse({
        ...accountEvidence,
        ...structuredClone(patch),
      })
    },
    async setupDefault() {
      let metadata
      try {
        metadata = await vault.metadata(credentialRef, workspaceId)
      } catch (error) {
        if (error?.code !== 'CREDENTIAL_MISSING') throw error
      }
      if (!metadata)
        await vault.create({
          credentialId: credentialRef,
          workspaceId,
          connectorRef: 'model:production-factory',
          provider: 'openai',
          secret: 'synthetic-production-factory-api-key-only',
          createdAt,
          createdBy: administratorPrincipalRef,
          expiresAt,
        })
      const connection = ModelConnectionSchema.parse(
        await administration.connect({
          workspaceId,
          principalRef: administratorPrincipalRef,
          credentialRef,
          credentialRevision: 1,
          connectionRef,
        })
      )
      const current = await repository.getDefaults(workspaceId)
      if (current) {
        if (
          current.lead?.connectionRef !== connectionRef ||
          current.lead.providerModel !== providerModel
        )
          throw new Error('FACTORY_MODEL_DEFAULT_CHANGED')
        return { connection, defaults: current }
      }
      const defaults = await defaultsService.setDefaults(
        0,
        WorkspaceModelDefaultsSchema.parse({
          workspaceId,
          revision: 1,
          lead: { connectionRef, providerModel },
        })
      )
      return { connection, defaults }
    },
  }
}
