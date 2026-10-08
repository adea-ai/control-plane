// TEST ONLY. Uses the actual production factory and HTTP application, never a fixture lead service.
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createProductionFactoryFixture } from '../tests/pi-production-factory.fixture.mjs'
import { createProductionFactoryServiceAuthenticator } from '../tests/pi-production-factory-auth.fixture.mjs'
import { createControlApiApplication } from '../apps/control-api/src/application.ts'

const config = JSON.parse(process.env.PI_PRODUCTION_FACTORY_TEST_CONFIG ?? 'null')
const productCredential = process.env.PI_PRODUCTION_FACTORY_PRODUCT_ASSERTION
if (
  !config?.workspaceId ||
  !config?.actorPrincipalId ||
  !config?.productProfilePin ||
  !config?.serviceTrust ||
  !config?.productReaderUrl ||
  !productCredential
)
  throw new Error('TEST_PRODUCTION_FACTORY_CONFIGURATION_REQUIRED')
const productUrl = new URL(config.productReaderUrl)
if (
  productUrl.protocol !== 'http:' ||
  productUrl.hostname !== '127.0.0.1' ||
  productUrl.pathname !== '/api/internal/pi-durable/lead-product/current' ||
  productUrl.username ||
  productUrl.password ||
  productUrl.search ||
  productUrl.hash
)
  throw new Error('TEST_OWNED_PRODUCT_READER_REQUIRED')
const originalFetch = globalThis.fetch
const revoked = new Set(config.revokedCredentialIds ?? [])
let host, app, closing
const close = () =>
  (closing ??= (async () => {
    try {
      await app?.close()
    } finally {
      await host?.close()
    }
  })())
try {
  host = await createProductionFactoryFixture({
    workspaceId: config.workspaceId,
    actorPrincipalId: config.actorPrincipalId,
    transportPrincipalId: config.serviceTrust.expectedPrincipalId,
    productProfilePin: config.productProfilePin,
    productHttp: {
      endpoint:
        'https://production-factory.test.invalid/api/internal/pi-durable/lead-product/current',
      credentials: { getExistingCredential: async () => productCredential },
      fetch: async (_endpoint, options) => originalFetch(productUrl, options),
    },
  })
  const serviceAuthenticator = createProductionFactoryServiceAuthenticator({
    ...config.serviceTrust,
    workspaceId: config.workspaceId,
    isRevoked: async (credentialId) => revoked.has(credentialId),
  })
  const metadata = {
    serviceName: 'control-api',
    version: 'test-candidate',
    commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    environment: 'test',
  }
  app = await createControlApiApplication({
    metadata,
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    logger: { write: () => {} },
    serviceAuthenticator,
    piDurableLeadService: host.composition.piDurableLeadService,
    piLeadPublicationService: host.composition.publicationService,
    modelConnectionService: host.composition.modelConnectionService,
  })
  await app.listen(0, '127.0.0.1')
  const address = await app.getUrl()
  process.stdout.write(
    `${JSON.stringify({
      baseUrl: address,
      workspaceId: host.workspaceId,
      principalId: host.principal.principalId,
      profileId: host.productProfilePin.profileId,
      profileVersion: host.productProfilePin.profileVersion,
      profileRevision: host.productProfilePin.profileRevision,
      profileVersionId: host.profile.profileVersionId,
      profileContentDigest: host.profile.contentDigest,
      target: host.models.target,
      credentialRef: host.models.refs.credentialRef,
      currentProductReaderConfigured: true,
      sourceIdentity: metadata.commitSha,
      trust: {
        issuer: config.serviceTrust.issuer,
        audience: config.serviceTrust.audience,
        keyId: config.serviceTrust.keyId,
      },
      qualification:
        'actual-production-factory; scripted-account-policy-and-provider; test-HTTP-product-bridge',
    })}\n`
  )
  // Private parent/child stdin controls; no additional HTTP scope or unauthenticated endpoint.
  const input = createInterface({ input: process.stdin })
  const terminate = () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  }
  input.once('close', terminate)
  input.on('line', (line) => {
    void (async () => {
      const request = JSON.parse(line)
      if (
        Object.keys(request).some((key) => !['id', 'command'].includes(key)) ||
        typeof request.id !== 'string'
      )
        throw new Error('TEST_CONTROL_INVALID')
      let data
      if (request.command === 'evidence')
        data = {
          ...host.state,
          canonical: host.canonicalCounts(),
          leasePolicyChecks: host.models.state.leasePolicyChecks,
          secretResolutions: host.models.secretProvider.resolveCount,
        }
      else if (request.command === 'drain') {
        await host.composition.adapter.drain()
        data = { drained: true }
      } else if (request.command === 'close') {
        await close()
        input.close()
        data = { closed: true }
      } else throw new Error('TEST_CONTROL_INVALID')
      process.stdout.write(`${JSON.stringify({ controlId: request.id, data })}\n`)
      if (request.command === 'close') process.exit(0)
    })().catch(() => {
      process.stdout.write(`${JSON.stringify({ controlError: 'TEST_CONTROL_INVALID' })}\n`)
    })
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, terminate)
} catch (error) {
  await close()
  throw error
}
