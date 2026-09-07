import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { test } from 'bun:test'

const readRepositoryFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('defines the Railway cloud service and migration manifest', async () => {
  const manifest = JSON.parse(await readRepositoryFile('infrastructure/railway/services.json'))
  const services = manifest.profiles.cloud.services

  assert.deepEqual(
    services.map(({ name }) => name),
    ['control-api', 'workflow-worker']
  )
  assert.deepEqual(
    services.filter(({ public: isPublic }) => isPublic).map(({ name }) => name),
    ['control-api']
  )
  assert.deepEqual(manifest.profiles.cloud.migration.requires, ['DATABASE_MIGRATION_URL'])
  assert.ok(
    services
      .find(({ name }) => name === 'workflow-worker')
      .requires.includes('CONTROL_PLANE_CLOUD_RUNTIME')
  )
  assert.equal(
    manifest.profiles.cloud.migration.command,
    'bun --cwd=packages/database run db:migrate'
  )
})

test('pins a durable private Restate runtime for Railway cloud', async () => {
  const manifest = JSON.parse(await readRepositoryFile('infrastructure/railway/restate.json'))

  assert.deepEqual(manifest.server, {
    service: 'restate',
    version: '1.7.7',
    image:
      'docker.restate.dev/restatedev/restate:1.7.7@sha256:dd1695b61c9de877d24bf9afe8a0ac5fb0f66d175c1bc397975d2252bd784eb2',
    nodeName: 'control-plane-staging-1',
    dataMount: '/restate-data',
    healthPath: '/health',
    privatePorts: { ingress: 8080, admin: 9070, fabric: 5122 },
    public: false,
    environment: {
      RESTATE_CLUSTER_NAME: 'control-plane-staging',
      RESTATE_NODE_NAME: 'control-plane-staging-1',
      RESTATE_AUTO_PROVISION: 'true',
      RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: '384 MiB',
      RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE:
        '/restate-data/request-identity-private.pem',
    },
  })
})

test('owns the active Railway project graph as code without committed secrets', async () => {
  const source = await readRepositoryFile('.railway/railway.ts')

  assert.match(source, /defineRailway/)
  assert.match(source, /service\('@control-plane\/control-api'/)
  assert.match(source, /service\('@control-plane\/workflow-worker'/)
  assert.match(source, /service\('restate'/)
  assert.match(source, /volume\('restate-data'/)
  assert.match(source, /docker\.restate\.dev\/restatedev\/restate:1\.7\.7@sha256:/)
  assert.match(source, /healthcheckPath: '\/ready'/)
  assert.match(source, /['"]\/restate-data['"]: restateData/)
  assert.match(source, /DATABASE_URL: preserve\(\)/)
  assert.match(source, /RESTATE_INGRESS_URL:/)
  assert.match(source, /RESTATE_REQUEST_IDENTITY_PUBLIC_KEY: preserve\(\)/)
  assert.match(source, /RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: '384 MiB'/)
  assert.match(
    source,
    /RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE:\s*'\/restate-data\/request-identity-private\.pem'/
  )
  assert.doesNotMatch(source, /\bRESTATE_REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE:/)
  assert.match(source, /CONTROL_PLANE_CLOUD_RUNTIME: production \? 'disabled' : 'certification'/)
  assert.match(source, /CONTROL_PLANE_SERVICE_AUTH_ISSUER: preserve\(\)/)
  assert.match(source, /CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS: preserve\(\)/)
  assert.match(source, /CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS: preserve\(\)/)
  assert.match(source, /volume\('restate-data', \{ sizeMB: 500, region: 'ams' \}\)/)
  assert.match(source, /const workflowWorker = service[\s\S]*?env: \{[\s\S]*?PORT: '9080'/)
  assert.doesNotMatch(source, /CONTROL_PLANE_SERVICE_AUTH_TOKEN/)
  assert.doesNotMatch(source, /RESTATE_SERVICE_AUTH_TOKEN/)
  assert.doesNotMatch(source, /\bCOMMIT_SHA:\s*preserve\(\)/)
  assert.doesNotMatch(source, /\bSERVICE_VERSION:\s*preserve\(\)/)
  assert.doesNotMatch(source, /(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY):\s*['"][^'"]+['"]/)
  assert.doesNotMatch(
    source,
    /service\('@control-plane\/(?:runtime-worker|runtime-gateway|tool-gateway)'/
  )
})

test('maps Railway staging and production to isolated Neon branches', async () => {
  const environment = JSON.parse(
    await readRepositoryFile('infrastructure/railway/environment.json')
  )
  const source = await readRepositoryFile('.railway/railway.ts')

  assert.deepEqual(environment.environments, {
    staging: {
      railwayEnvironment: 'staging',
      applicationEnvironment: 'staging',
      sourceBranch: 'main',
      neon: { provider: 'neon', project: 'control-plane', branch: 'staging' },
    },
    production: {
      railwayEnvironment: 'production',
      applicationEnvironment: 'production',
      sourceBranch: 'main',
      neon: { provider: 'neon', project: 'control-plane', branch: 'production' },
    },
  })
  assert.match(source, /const sourceBranch = 'main'/)
  assert.equal((source.match(/branch: sourceBranch/g) ?? []).length, 1)
})

test('defines a zero-compute production standby and bounded staging cost posture', async () => {
  const policy = JSON.parse(await readRepositoryFile('infrastructure/railway/cost-policy.json'))
  const source = await readRepositoryFile('.railway/railway.ts')

  assert.deepEqual(policy.environments.production, {
    availability: 'configured-not-running',
    sourceConnected: false,
    activationBranch: 'main',
    standbyAction: 'remove-active-deployment',
    services: {
      'control-api': { configuredReplicas: 1, runningReplicas: 0, serverless: false },
      'workflow-worker': { configuredReplicas: 1, runningReplicas: 0, serverless: false },
      restate: {
        configuredReplicas: 1,
        runningReplicas: 0,
        serverless: false,
        preserveVolume: true,
      },
    },
  })
  assert.equal(policy.environments.staging.availability, 'configured-on-demand-reference')
  assert.equal(policy.environments.staging.sourceConnected, false)
  assert.equal(policy.environments.staging.activationBranch, 'main')
  assert.equal(policy.environments.staging.standbyAction, 'remove-active-deployment')
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(policy.environments.staging.services).map(([name, value]) => [
        name,
        {
          configuredReplicas: value.configuredReplicas,
          runningReplicas: value.runningReplicas,
          serverless: value.serverless,
        },
      ])
    ),
    {
      'control-api': { configuredReplicas: 1, runningReplicas: 0, serverless: false },
      'workflow-worker': { configuredReplicas: 1, runningReplicas: 0, serverless: false },
      restate: { configuredReplicas: 1, runningReplicas: 0, serverless: false },
    }
  )
  assert.match(source, /const desiredReplicas = 1/)
  assert.equal((source.match(/numReplicas: desiredReplicas/g) ?? []).length, 3)
  assert.equal((source.match(/sleepApplication: false/g) ?? []).length, 3)
  assert.match(source, /const applicationSource = production \? undefined : github/)
})

test('plans a deterministic Railway standby transition without deleting services', async () => {
  const {
    main,
    assertDisconnectScope,
    planStandbyActions,
    railwayDisconnectArguments,
    railwayRemoveArguments,
    railwayRepoTriggersArguments,
  } = await import('../scripts/railway-standby.mjs')
  const disconnect = [{ type: 'disconnect-source', serviceId: 'shared-api' }]
  assert.throws(
    () =>
      assertDisconnectScope(disconnect, [
        { id: 'shared-api', source: { repo: 'production/repo' } },
      ]),
    /another Railway environment/
  )
  assert.doesNotThrow(() =>
    assertDisconnectScope(disconnect, [{ id: 'shared-api', source: { repo: null } }])
  )
  assert.throws(() => main(['--environment', 'staging']), /explicit --project/)
  const sourceOnly = planStandbyActions({
    environment: 'staging',
    services: [
      {
        id: 'shared-api',
        name: '@control-plane/control-api',
        source: { repo: 'staging/repo' },
        repoTriggerCount: 0,
      },
      { id: 'worker', name: '@control-plane/workflow-worker' },
      { id: 'restate', name: 'restate' },
    ],
  })
  assert.equal(sourceOnly[0].type, 'disconnect-source')

  assert.deepEqual(railwayRepoTriggersArguments('service-id'), [
    'api',
    '--raw-var',
    'id=service-id',
    '--compact',
    'query ServiceRepoTriggers($id: String!) { service(id: $id) { repoTriggers { edges { node { id environmentId } } pageInfo { hasNextPage } } } }',
  ])

  assert.deepEqual(railwayDisconnectArguments('service-id'), [
    'api',
    '--raw-var',
    'id=service-id',
    '--compact',
    'mutation Disconnect($id: String!) { serviceDisconnect(id: $id) { id } }',
  ])

  assert.deepEqual(railwayRemoveArguments('deployment-id'), [
    'api',
    '--raw-var',
    'id=deployment-id',
    '--compact',
    'mutation Remove($id: String!) { deploymentRemove(id: $id) }',
  ])

  assert.throws(
    () => main(['--environment', 'production', '--apply', '--confirm', 'staging']),
    /requires --confirm to exactly match/
  )
  assert.throws(
    () =>
      planStandbyActions({
        environment: 'staging',
        services: [{ id: 'obsolete', name: '@control-plane/runtime-worker' }],
      }),
    /Unexpected Railway service/
  )
  assert.throws(
    () => planStandbyActions({ environment: 'staging', services: [] }),
    /Missing expected Railway service.*control-api.*workflow-worker.*restate/
  )
  assert.throws(
    () =>
      planStandbyActions({
        environment: 'production',
        services: [
          { id: 'control-service', name: '@control-plane/control-api' },
          { id: 'worker-service', name: '@control-plane/workflow-worker' },
        ],
      }),
    /Missing expected Railway services: restate/
  )

  assert.deepEqual(
    planStandbyActions({
      environment: 'staging',
      services: [
        {
          id: 'control-service',
          name: '@control-plane/control-api',
          source: { repo: 'adea-ai/control-plane', image: null },
          repoTriggerCount: 1,
          deploymentId: 'control-deployment',
          deploymentStopped: false,
          replicas: { running: 0 },
        },
        {
          id: 'worker-service',
          name: '@control-plane/workflow-worker',
          source: { repo: 'adea-ai/control-plane', image: null },
          repoTriggerCount: 1,
          deploymentId: 'worker-deployment',
          replicas: { running: 1 },
          deployments: [
            { id: 'worker-pending-deployment', status: 'BUILDING' },
            { id: 'worker-deployment', status: 'SUCCESS' },
            { id: 'worker-crashed-deployment', status: 'CRASHED' },
            { id: 'worker-failed-deployment', status: 'FAILED' },
          ],
        },
        {
          id: 'restate-service',
          name: 'restate',
          source: { repo: null, image: 'restate@sha256:fixture' },
          deploymentId: 'restate-deployment',
          replicas: { running: 1 },
        },
      ],
    }),
    [
      {
        type: 'disconnect-source',
        environment: 'staging',
        serviceId: 'control-service',
        serviceName: '@control-plane/control-api',
      },
      {
        type: 'remove-deployment',
        deploymentId: 'control-deployment',
        serviceName: '@control-plane/control-api',
      },
      {
        type: 'disconnect-source',
        environment: 'staging',
        serviceId: 'worker-service',
        serviceName: '@control-plane/workflow-worker',
      },
      {
        type: 'remove-deployment',
        deploymentId: 'worker-deployment',
        serviceName: '@control-plane/workflow-worker',
      },
      {
        type: 'remove-deployment',
        deploymentId: 'worker-pending-deployment',
        serviceName: '@control-plane/workflow-worker',
      },
      {
        type: 'remove-deployment',
        deploymentId: 'restate-deployment',
        serviceName: 'restate',
      },
    ]
  )
})

test('uses a dependency-aware portable container build without AWS deployment assumptions', async () => {
  const dockerfile = await readRepositoryFile('infrastructure/containers/Dockerfile')
  const bake = await readRepositoryFile('infrastructure/containers/docker-bake.hcl')
  const entrypoint = await readRepositoryFile('infrastructure/containers/entrypoint.sh')

  assert.match(dockerfile, /bun install --frozen-lockfile/)
  assert.match(dockerfile, /^USER bun$/m)
  assert.doesNotMatch(dockerfile, /^\s*(?:ARG|ENV)\s+.*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY)/im)
  assert.match(bake, /context\s*=\s*"\."/)
  assert.doesNotMatch(bake, /platforms\s*=\s*\["linux\/arm64"\]/)
  assert.doesNotMatch(`${dockerfile}\n${bake}\n${entrypoint}`, /ECS|Terraform|ECR|AWS/i)
  for (const service of [
    'control-api',
    'workflow-worker',
    'runtime-worker',
    'runtime-gateway',
    'tool-gateway',
  ]) {
    assert.match(bake, new RegExp(`target "${service}"`))
    assert.match(bake, new RegExp(`APP_NAME = "${service}"`))
    assert.match(entrypoint, new RegExp(`\\b${service}\\b`))
  }
  assert.match(bake, /target "database-migrate"/)
  assert.match(dockerfile, /packages\/database.*db:migrate/s)
  assert.doesNotMatch(entrypoint, /\beval\b/)
})

test('packages the hosted simple profile as one hardened user-owned composition', async () => {
  const compose = await readRepositoryFile('infrastructure/compose/compose.yaml')
  const databaseRoles = await readRepositoryFile(
    'infrastructure/compose/postgres/bootstrap-roles.sh'
  )
  const dockerfile = await readRepositoryFile('infrastructure/containers/Dockerfile.hosted')
  const environment = await readRepositoryFile('infrastructure/compose/.env.example')
  const runbook = await readRepositoryFile('infrastructure/compose/README.md')
  const postgresBlock = compose.slice(
    compose.indexOf('  postgres:'),
    compose.indexOf('  database-migrate:')
  )
  const restateBlock = compose.slice(
    compose.indexOf('  restate:'),
    compose.indexOf('  control-plane-server:')
  )

  assert.match(compose, /^name: control-plane-hosted$/m)
  assert.match(compose, /profiles:\s*\[simple\]/)
  assert.match(compose, /APP_NAME:\s*local-control-plane/)
  assert.match(compose, /CONTROL_PLANE_BIND_HOST:\s*0\.0\.0\.0/)
  assert.match(
    compose,
    /\$\{CONTROL_PLANE_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{CONTROL_PLANE_PORT:-3000\}:3000/
  )
  assert.match(compose, /source:\s*\$\{CONTROL_PLANE_DATA_PATH:-\.\/data\/simple\}/)
  assert.match(compose, /target:\s*\/var\/lib\/control-plane/)
  assert.match(compose, /cap_drop:[\s\S]*?- ALL/)
  assert.match(compose, /no-new-privileges:true/)
  assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:3000\/ready'\)/)
  assert.match(compose, /^\s+POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:-\}$/m)
  assert.match(compose, /profiles:\s*\[server\]/)
  assert.match(compose, /postgres:18\.3-alpine@sha256:[a-f0-9]{64}/)
  assert.match(compose, /restatedev\/restate:1\.7\.7@sha256:[a-f0-9]{64}/)
  assert.match(compose, /condition:\s*service_completed_successfully/)
  assert.match(compose, /DATABASE_MIGRATION_URL:/)
  assert.match(compose, /postgresql:\/\/control_plane_migrator:/)
  assert.match(compose, /postgresql:\/\/control_plane_app:/)
  assert.doesNotMatch(compose, /DATABASE_(?:MIGRATION_)?URL:\s*postgresql:\/\/control_plane:/)
  assert.match(compose, /POSTGRES_MIGRATION_PASSWORD: \$\{POSTGRES_MIGRATION_PASSWORD:-\}/)
  assert.match(compose, /POSTGRES_APPLICATION_PASSWORD: \$\{POSTGRES_APPLICATION_PASSWORD:-\}/)
  assert.match(databaseRoles, /ALTER DEFAULT PRIVILEGES FOR ROLE control_plane_migrator/)
  assert.match(databaseRoles, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO control_plane_app/)
  assert.match(databaseRoles, /PostgreSQL role passwords must be distinct/)
  assert.match(databaseRoles, /ALTER DATABASE control_plane OWNER TO control_plane_migrator/)
  assert.match(databaseRoles, /ALTER TABLE %I\.%I OWNER TO control_plane_migrator/)
  assert.match(databaseRoles, /ALTER DOMAIN %I\.%I OWNER TO control_plane_migrator/)
  assert.match(databaseRoles, /rolname IN \('control_plane', 'control_plane_app'\)/)
  assert.match(databaseRoles, /deptype = 'e'/)
  assert.doesNotMatch(databaseRoles, /REASSIGN OWNED BY control_plane/)
  assert.match(databaseRoles, /REVOKE %I FROM control_plane_app/)
  assert.match(databaseRoles, /REVOKE ALL PRIVILEGES ON ALL TABLES/)
  assert.doesNotMatch(databaseRoles, /GRANT (?:ALL|CREATE).*TO control_plane_app/i)
  assert.match(compose, /APP_NAME:\s*hosted-control-plane/)
  assert.doesNotMatch(postgresBlock, /\n\s+ports:/)
  assert.doesNotMatch(restateBlock, /\n\s+ports:/)
  assert.match(dockerfile, /^FROM oven\/bun:1\.4\.0@sha256:[a-f0-9]{64}/m)
  assert.match(dockerfile, /ARG APP_NAME=local-control-plane/)
  assert.match(dockerfile, /bun install --frozen-lockfile --production --ignore-scripts/)
  assert.doesNotMatch(dockerfile, /COPY --from=build --chown=bun:bun \/workspace \/workspace/)
  assert.match(dockerfile, /^USER bun$/m)
  assert.match(environment, /CONTROL_PLANE_DATA_PATH=\.\/data\/simple/)
  assert.match(environment, /HOSTED_OBJECT_STORE=filesystem/)
  assert.match(compose, /HOSTED_OBJECT_STORE: \$\{HOSTED_OBJECT_STORE:-filesystem\}/)
  assert.match(compose, /S3_ENDPOINT: \$\{S3_ENDPOINT:-\}/)
  assert.match(runbook, /docker compose --profile simple up --build -d/)
  assert.match(runbook, /docker compose --profile server up --build -d/)
  assert.match(runbook, /sudo chown 1000:1000 data\/simple/)
  assert.match(runbook, /sudo chown 1000:1000 data\/server\/control-plane/)
  assert.match(runbook, /sudo chown 70:70 data\/server\/postgres/)
  assert.match(runbook, /sudo chown 0:0 data\/server\/restate/)
  assert.match(runbook, /Re-check these image ownership contracts/)
  assert.match(runbook, /127\.0\.0\.1:3000/)
  assert.match(runbook, /Stop the container before a filesystem-level backup/)
})

test('checks hosted credential persistence without weakening owner-only file permissions', async () => {
  const workflow = await readRepositoryFile('.github/workflows/m10-operability.yml')

  assert.match(
    workflow,
    /docker compose exec -T control-plane-simple sha256sum \/var\/lib\/control-plane\/auth\/local-api\.token/g
  )
  assert.doesNotMatch(workflow, /sha256sum "\$compose_root\/simple\/auth\/local-api\.token"/)
  assert.match(workflow, /sudo chown -R 70:70 "\$compose_root\/server\/postgres"/)
  assert.match(workflow, /sudo chown -R 0:0 "\$compose_root\/server\/restate"/)
})

test('does not retain the former AWS deployment tree', async () => {
  const packageManifest = JSON.parse(await readRepositoryFile('package.json'))
  const railwayValidator = await readRepositoryFile('scripts/validate-railway.mjs')
  const infrastructureDocs = await readRepositoryFile('docs/infrastructure.md')

  assert.equal(packageManifest.scripts['infra:validate'], 'bun scripts/validate-railway.mjs')
  assert.equal(packageManifest.scripts['infra:fmt:check'], undefined)
  assert.match(railwayValidator, /Railway cloud manifest/)
  assert.match(infrastructureDocs, /Cloud, Hosted\/VPS, and Local/)
  await assert.rejects(
    readRepositoryFile('infrastructure/terraform/environments/production/main.tf')
  )
})
