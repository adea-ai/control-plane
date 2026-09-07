import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(
  await readFile(`${repositoryRoot}/infrastructure/railway/services.json`, 'utf8')
)
const restate = JSON.parse(
  await readFile(`${repositoryRoot}/infrastructure/railway/restate.json`, 'utf8')
)
const environment = JSON.parse(
  await readFile(`${repositoryRoot}/infrastructure/railway/environment.json`, 'utf8')
)
const costPolicy = JSON.parse(
  await readFile(`${repositoryRoot}/infrastructure/railway/cost-policy.json`, 'utf8')
)
const railwayIac = await readFile(`${repositoryRoot}/.railway/railway.ts`, 'utf8')
const standbyScript = await readFile(`${repositoryRoot}/scripts/railway-standby.mjs`, 'utf8')

if (manifest.schemaVersion !== 1 || manifest.provider !== 'railway') {
  throw new Error('Railway service manifest must use schemaVersion 1 and provider railway.')
}

if (
  restate.schemaVersion !== 1 ||
  restate.runtime !== 'restate' ||
  restate.service !== 'workflow-worker' ||
  restate.railwayPortVariable !== 'PORT' ||
  restate.port !== 9080 ||
  !Array.isArray(restate.handlers) ||
  !restate.handlers.includes('run') ||
  !restate.handlers.includes('respondToInteraction') ||
  !restate.handlers.includes('cancelExecution')
) {
  throw new Error('Railway Restate contract is incomplete or points at the wrong service.')
}

const restateServer = restate.server
if (
  restateServer?.service !== 'restate' ||
  restateServer.version !== '1.7.7' ||
  !restateServer.image.endsWith(
    '@sha256:dd1695b61c9de877d24bf9afe8a0ac5fb0f66d175c1bc397975d2252bd784eb2'
  ) ||
  restateServer.nodeName !== restateServer.environment?.RESTATE_NODE_NAME ||
  restateServer.environment?.RESTATE_AUTO_PROVISION !== 'true' ||
  restateServer.environment?.RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE !== '384 MiB' ||
  restateServer.environment?.RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE !==
    '/restate-data/request-identity-private.pem' ||
  restateServer.dataMount !== '/restate-data' ||
  restateServer.healthPath !== '/health' ||
  JSON.stringify(restateServer.privatePorts) !==
    JSON.stringify({ ingress: 8080, admin: 9070, fabric: 5122 }) ||
  restateServer.public !== false
) {
  throw new Error('Railway Restate server must be immutable, private, and durably mounted.')
}

if (
  environment.schemaVersion !== 1 ||
  environment.provider !== 'railway' ||
  environment.profile !== 'cloud' ||
  environment.applicationEnvironment !== 'managed-cloud' ||
  environment.database?.provider !== 'neon' ||
  environment.database?.project !== 'control-plane' ||
  environment.database?.runtimeVariable !== 'DATABASE_URL' ||
  environment.database?.migrationVariable !== 'DATABASE_MIGRATION_URL' ||
  environment.database?.administrationVariable !== 'DATABASE_ADMIN_URL' ||
  environment.objectStore?.provider !== 'cloudflare-r2' ||
  environment.objectStore?.bucket !== 'ctrl-plane' ||
  environment.objectStore?.region !== 'auto' ||
  environment.secrets?.valuesCommitted !== false
) {
  throw new Error('Railway environment manifest is incomplete or contains committed secrets.')
}

const expectedEnvironments = {
  staging: {
    railwayEnvironment: 'staging',
    applicationEnvironment: 'staging',
    sourceBranch: 'staging',
    neonBranch: 'staging',
  },
  production: {
    railwayEnvironment: 'production',
    applicationEnvironment: 'production',
    sourceBranch: 'main',
    neonBranch: 'production',
  },
}
for (const [name, expectedEnvironment] of Object.entries(expectedEnvironments)) {
  const configuredEnvironment = environment.environments?.[name]
  if (
    configuredEnvironment?.railwayEnvironment !== expectedEnvironment.railwayEnvironment ||
    configuredEnvironment?.applicationEnvironment !== expectedEnvironment.applicationEnvironment ||
    configuredEnvironment?.sourceBranch !== expectedEnvironment.sourceBranch ||
    configuredEnvironment?.neon?.provider !== 'neon' ||
    configuredEnvironment?.neon?.project !== 'control-plane' ||
    configuredEnvironment?.neon?.branch !== expectedEnvironment.neonBranch
  ) {
    throw new Error(`Railway environment mapping is incomplete or crosses Neon branches: ${name}.`)
  }
}
if (
  environment.environments.staging.neon.branch === environment.environments.production.neon.branch
) {
  throw new Error('Railway staging and production must use distinct Neon branches.')
}

if (
  environment.services?.['control-api']?.includes('RESTATE_INGRESS_URL') !== true ||
  environment.services?.['workflow-worker']?.includes('RESTATE_REQUEST_IDENTITY_PUBLIC_KEY') !==
    true ||
  environment.services?.['workflow-worker']?.includes('CONTROL_PLANE_CLOUD_RUNTIME') !== true ||
  JSON.stringify(environment).includes('RESTATE_SERVICE_AUTH_TOKEN')
) {
  throw new Error('Railway Restate dependency ownership or request identity is invalid.')
}

for (const requiredFragment of [
  "service('@control-plane/control-api'",
  "service('@control-plane/workflow-worker'",
  "service('restate'",
  "volume('restate-data'",
  'preserve()',
  'RESTATE_REQUEST_IDENTITY_PUBLIC_KEY',
  "const sourceBranch = production ? 'main' : 'staging'",
  'branch: sourceBranch',
  'CONTROL_PLANE_CLOUD_RUNTIME',
  'CONTROL_PLANE_SERVICE_AUTH_ISSUER',
  'CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS',
  'CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS',
]) {
  if (!railwayIac.includes(requiredFragment)) {
    throw new Error(`Railway IaC is missing required project intent: ${requiredFragment}.`)
  }
}
if (railwayIac.includes('RESTATE_SERVICE_AUTH_TOKEN')) {
  throw new Error('Railway IaC must not retain the unsupported Restate service token contract.')
}
if (railwayIac.includes('CONTROL_PLANE_SERVICE_AUTH_TOKEN')) {
  throw new Error('Railway IaC must not retain the removed shared service-auth token.')
}
if (
  railwayIac.includes("service('@control-plane/runtime-worker'") ||
  railwayIac.includes("service('@control-plane/runtime-gateway'") ||
  railwayIac.includes("service('@control-plane/tool-gateway'")
) {
  throw new Error('Railway IaC must not deploy non-serving process targets as Cloud services.')
}

if (
  costPolicy.schemaVersion !== 1 ||
  costPolicy.provider !== 'railway' ||
  costPolicy.profile !== 'cloud-prelaunch'
) {
  throw new Error('Railway cost policy must define the versioned cloud-prelaunch profile.')
}
for (const environmentName of ['staging', 'production']) {
  const configured = costPolicy.environments?.[environmentName]
  if (
    configured?.sourceConnected !== false ||
    configured?.standbyAction !== 'remove-active-deployment' ||
    configured?.activationBranch !== (environmentName === 'staging' ? 'staging' : 'main')
  ) {
    throw new Error(`Railway standby policy is incomplete: ${environmentName}.`)
  }
  for (const serviceName of ['control-api', 'workflow-worker', 'restate']) {
    const service = configured.services?.[serviceName]
    if (
      service?.configuredReplicas !== 1 ||
      service?.runningReplicas !== 0 ||
      service?.serverless !== false
    ) {
      throw new Error(
        `Railway standby service policy is invalid: ${environmentName}/${serviceName}.`
      )
    }
  }
}
if (
  !railwayIac.includes('const desiredReplicas = 1') ||
  !railwayIac.includes('const applicationSource = production ? undefined : github') ||
  !standbyScript.includes('deploymentRemove') ||
  !standbyScript.includes('disconnect-source')
) {
  throw new Error('Railway activation and standby mechanisms are not reproducibly defined.')
}

const cloud = manifest.profiles?.cloud
if (!cloud || cloud.environment !== 'managed-cloud') {
  throw new Error('Railway manifest must define the managed-cloud profile.')
}

const expected = new Set(['control-api', 'workflow-worker'])
const services = cloud.services ?? []
if (
  services.length !== expected.size ||
  new Set(services.map(({ name }) => name)).size !== expected.size
) {
  throw new Error('Railway manifest must define each cloud service exactly once.')
}

for (const service of services) {
  if (!expected.has(service.name) || service.app !== service.name) {
    throw new Error(`Invalid Railway service mapping: ${service.name ?? '<unnamed>'}.`)
  }
  if (
    typeof service.public !== 'boolean' ||
    typeof service.buildCommand !== 'string' ||
    !service.buildCommand.includes(`--filter=@control-plane/${service.app}...`) ||
    !Array.isArray(service.requires)
  ) {
    throw new Error(`Invalid Railway service contract: ${service.name}.`)
  }
  if (service.name === 'workflow-worker' && (!service.healthPath || !service.readyPath)) {
    throw new Error(`Restate workflow endpoint must define health/readiness: ${service.name}.`)
  }
  if (service.public && (!service.healthPath || !service.readyPath)) {
    throw new Error(`Public Railway service must define health/readiness: ${service.name}.`)
  }
  const declared = environment.services?.[service.name]
  if (!Array.isArray(declared) || JSON.stringify(declared) !== JSON.stringify(service.requires)) {
    throw new Error(`Railway environment manifest is out of sync: ${service.name}.`)
  }
}

if (
  services
    .filter(({ public: isPublic }) => isPublic)
    .map(({ name }) => name)
    .join() !== 'control-api'
) {
  throw new Error('Only control-api may be public in the cloud profile.')
}

if (
  cloud.migration?.command !== 'bun --cwd=packages/database run db:migrate' ||
  JSON.stringify(cloud.migration?.requires) !== JSON.stringify(['DATABASE_MIGRATION_URL'])
) {
  throw new Error('Railway migration must remain an explicit DATABASE_MIGRATION_URL job.')
}

console.log(`Validated Railway cloud manifest for ${services.length} application services.`)
