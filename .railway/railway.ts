import { defineRailway, github, image, preserve, project, service, volume } from 'railway/iac'

const repository = 'adea-ai/control-plane'
const restateImage =
  'docker.restate.dev/restatedev/restate:1.7.7@sha256:dd1695b61c9de877d24bf9afe8a0ac5fb0f66d175c1bc397975d2252bd784eb2'

export default defineRailway((context) => {
  const production = context.isEnvironment('production')
  const applicationEnvironment = production ? 'production' : 'staging'
  // Both environments deploy from main: the staging environment is an
  // on-demand reference that is activated against main (or a tag) for
  // cloud-substrate debugging, then stood back down. There is no staging
  // branch; see infrastructure/railway/environment.json.
  const sourceBranch = 'main'
  const desiredReplicas = 1
  // Production image sources are release outputs, not source builds. The
  // container-promotion workflow sets each service to its scan-attested GHCR
  // digest; leaving source absent here prevents IaC reconciliation from
  // replacing that immutable digest with a repository build.
  const applicationSource = production ? undefined : github(repository, { branch: sourceBranch })
  const restateData = volume('restate-data', { sizeMB: 500, region: 'ams' })

  const controlApi = service('@control-plane/control-api', {
    ...(applicationSource === undefined ? {} : { source: applicationSource }),
    build: {
      builder: 'RAILPACK',
      buildCommand: 'bun run build --filter=@control-plane/control-api...',
      watchPatterns: ['/apps/control-api/**', '/packages/**', '/bun.lock', '/package.json'],
    },
    deploy: {
      startCommand: 'bun run --filter=@control-plane/control-api start',
      numReplicas: desiredReplicas,
      sleepApplication: false,
      healthcheckPath: '/ready',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      // The marketplace registry refresh downloads and verifies every immutable
      // catalog artifact (~50-128 MB transient per refresh, every 60s) and the
      // live Agent HQ poller keeps GC pressure continuous; 1 GiB at 0.25 CPU
      // OOM-killed the container in ~8-minute cycles.
      limitOverride: {
        containers: { cpu: 0.5, memoryBytes: 2_147_483_648 },
      },
    },
    networking: { privateNetworkEndpoint: 'control-planecontrol-api' },
    env: {
      APP_ENV: applicationEnvironment,
      // Reconciliation treats an omitted variable as a deletion (the CLI
      // documents "omit=delete"), so every variable that exists only in a
      // live environment must be declared as preserved or an apply removes
      // it. These four are production-side operational variables: the
      // marketplace registry poller credentials/URL (#507) and the legacy
      // APP_NAME / RAILWAY_DOCKERFILE_PATH pair left over from the pre-digest
      // deployment model.
      APP_NAME: preserve(),
      MARKETPLACE_REGISTRY_LATEST_URL: preserve(),
      MARKETPLACE_REGISTRY_TOKEN: preserve(),
      RAILWAY_DOCKERFILE_PATH: preserve(),
      DATABASE_URL: preserve(),
      CONTROL_PLANE_SECRET_ENCRYPTION_KEY: preserve(),
      CONTROL_PLANE_SERVICE_AUTH_ISSUER: preserve(),
      CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS: preserve(),
      CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS: preserve(),
      R2_ENDPOINT: preserve(),
      R2_BUCKET: 'ctrl-plane',
      R2_REGION: 'auto',
      // Staging and preview object keys live under an environment prefix so a shared
      // bucket cannot be addressed with production keys; production stays unprefixed.
      ...(production ? {} : { R2_PREFIX: 'staging/' }),
      R2_ACCESS_KEY_ID: preserve(),
      R2_SECRET_ACCESS_KEY: preserve(),
      RESTATE_INGRESS_URL: 'http://control-planerestate.railway.internal:8080',
      // Catalog approval gate (#188, ratified 2026-09-24): versions published
      // at or after the cutover need a recorded approval decision before they
      // resolve; earlier versions are grandfathered, so enabling with a
      // cutover never blocks the existing catalog. Staging stays off so
      // reference-environment debugging is not gated by approvals.
      CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED: production ? 'true' : 'false',
      ...(production
        ? { CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED_SINCE: '2026-09-25T00:00:00.000Z' }
        : {}),
    },
  })

  const workflowWorker = service('@control-plane/workflow-worker', {
    ...(applicationSource === undefined ? {} : { source: applicationSource }),
    build: {
      builder: 'RAILPACK',
      buildCommand: 'bun run build --filter=@control-plane/workflow-worker...',
      watchPatterns: ['/apps/workflow-worker/**', '/packages/**', '/bun.lock', '/package.json'],
    },
    deploy: {
      startCommand: 'bun run --filter=@control-plane/workflow-worker start',
      numReplicas: desiredReplicas,
      sleepApplication: false,
      healthcheckPath: '/ready',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      limitOverride: {
        containers: { cpu: 0.25, memoryBytes: 268_435_456 },
      },
    },
    networking: { privateNetworkEndpoint: 'control-planeworkflow-worker' },
    env: {
      PORT: '9080',
      APP_ENV: applicationEnvironment,
      // Same reconcile-safety rule as control-api: declared-but-preserved
      // production variables must never be omitted or an apply deletes them.
      APP_NAME: preserve(),
      RAILWAY_DOCKERFILE_PATH: preserve(),
      DATABASE_URL: preserve(),
      CONTROL_PLANE_SECRET_ENCRYPTION_KEY: preserve(),
      RESTATE_REQUEST_IDENTITY_PUBLIC_KEY: preserve(),
      R2_ENDPOINT: preserve(),
      R2_BUCKET: 'ctrl-plane',
      R2_REGION: 'auto',
      // Matches the control-api separation prefix for the same environment.
      ...(production ? {} : { R2_PREFIX: 'staging/' }),
      R2_ACCESS_KEY_ID: preserve(),
      R2_SECRET_ACCESS_KEY: preserve(),
      CONTROL_PLANE_CLOUD_RUNTIME: production ? 'disabled' : 'certification',
    },
  })

  const restate = service('restate', {
    source: image(restateImage),
    deploy: {
      numReplicas: desiredReplicas,
      sleepApplication: false,
      healthcheckPath: '/health',
      healthcheckTimeout: 60,
      restartPolicyType: 'ALWAYS',
      limitOverride: {
        containers: { cpu: 0.25, memoryBytes: 1_073_741_824 },
      },
    },
    networking: { privateNetworkEndpoint: 'control-planerestate' },
    env: {
      PORT: '9070',
      RESTATE_CLUSTER_NAME: `control-plane-${applicationEnvironment}`,
      RESTATE_NODE_NAME: `control-plane-${applicationEnvironment}-1`,
      RESTATE_AUTO_PROVISION: 'true',
      RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: '384 MiB',
      RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE:
        '/restate-data/request-identity-private.pem',
    },
    volumeMounts: { '/restate-data': restateData },
  })

  return project('control-plane', {
    resources: [controlApi, workflowWorker, restate, restateData],
  })
})
