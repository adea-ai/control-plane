import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2'
const PROJECT_ID = '18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f'
const ENVIRONMENT_ID = '52f5b0ac-2af0-4792-aa56-30d80e5db31e'
const SERVICE_IDS = Object.freeze({
  'control-api': '9167a33b-af0f-4780-8614-a5a161697c9c',
  'workflow-worker': 'd733ec0d-bda5-4be5-86b9-637154d282eb',
})

const DEPLOYMENTS_QUERY = `query($input: DeploymentListInput!) {
  deployments(input: $input, first: 20) {
    edges { node { id status canRollback deploymentStopped meta } }
  }
}`
const SOURCE_QUERY = `query($serviceId: String!, $environmentId: String!) {
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    source { image repo }
  }
}`
const CONNECT_MUTATION = `mutation($id: String!, $input: ServiceConnectInput!) {
  serviceConnect(id: $id, input: $input) { id }
}`
const DISCONNECT_MUTATION = `mutation($id: String!) {
  serviceDisconnect(id: $id) { id }
}`
const DEPLOY_MUTATION = `mutation($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
}`
const ROLLBACK_MUTATION = `mutation($id: String!) { deploymentRollback(id: $id) }`
const REMOVE_MUTATION = `mutation($id: String!) { deploymentRemove(id: $id) }`

export function assertMutationSucceeded(data, field) {
  if (data?.[field] !== true) {
    throw new Error(`Railway mutation ${field} returned false`)
  }
}

function normalizeSource(source) {
  return { image: source?.image ?? null, repo: source?.repo ?? null }
}

function activeSuccessfulDeployment(deployments) {
  return deployments.find(
    (deployment) => deployment.status === 'SUCCESS' && deployment.deploymentStopped === false
  )
}

function matchesExpectedDeployment(deployment, expectedImage, expectedDigest) {
  return deployment.meta?.image === expectedImage && deployment.meta?.imageDigest === expectedDigest
}

async function waitForExpectedSource({ target, expectedSource, railway, sleep, verifyRetries }) {
  for (let attempt = 0; attempt < verifyRetries; attempt += 1) {
    const source = normalizeSource(await railway.getSource(target))
    if (isDeepStrictEqual(source, expectedSource)) return
    await sleep(10_000)
  }
  throw new Error(`Timed out waiting for ${target} source configuration to become active`)
}

async function waitForExpectedDeployment({
  target,
  expectedImage,
  expectedDigest,
  knownDeploymentIds,
  railway,
  sleep,
  verifyRetries,
}) {
  for (let attempt = 0; attempt < verifyRetries; attempt += 1) {
    const deployments = await railway.listDeployments(target)
    const matches = deployments.filter((deployment) => deployment.meta?.image === expectedImage)
    const active = matches.find(
      (deployment) =>
        deployment.status === 'SUCCESS' &&
        deployment.deploymentStopped === false &&
        matchesExpectedDeployment(deployment, expectedImage, expectedDigest)
    )
    if (active) return active

    const newTerminal = matches.find(
      (deployment) =>
        !knownDeploymentIds.has(deployment.id) &&
        ['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED', 'NEEDS_APPROVAL'].includes(
          deployment.status
        )
    )
    if (newTerminal) {
      throw new Error(`Deployment for ${target} stopped with ${newTerminal.status}`)
    }
    await sleep(10_000)
  }
  throw new Error(`Timed out waiting for ${target} to deploy ${expectedImage}`)
}

async function reconcilePriorState({
  target,
  expectedImage,
  snapshot,
  railway,
  sleep,
  verifyRetries,
}) {
  let stableChecks = 0
  let lastReconciliationError
  let lastRollbackAttempt

  for (let attempt = 0; attempt < verifyRetries; attempt += 1) {
    let source
    let deployments
    try {
      source = normalizeSource(await railway.getSource(target))
      deployments = await railway.listDeployments(target)
    } catch (error) {
      lastReconciliationError = error
      stableChecks = 0
      await sleep(10_000)
      continue
    }

    if (!isDeepStrictEqual(source, snapshot.source)) {
      try {
        await railway.updateSource(target, snapshot.source)
      } catch (error) {
        lastReconciliationError = error
      }
    }

    const promotionDeployments = deployments.filter(
      (deployment) =>
        deployment.meta?.image === expectedImage && deployment.deploymentStopped === false
    )

    if (snapshot.deployment === undefined) {
      for (const deployment of promotionDeployments) {
        try {
          await railway.removeDeployment(target, deployment.id)
        } catch (error) {
          lastReconciliationError = error
        }
      }
    } else {
      const activePrior = deployments.find(
        (deployment) =>
          deployment.status === 'SUCCESS' &&
          deployment.deploymentStopped === false &&
          deployment.meta?.imageDigest === snapshot.deployment.meta?.imageDigest
      )
      const priorInProgress = deployments.some(
        (deployment) =>
          deployment.id !== snapshot.deployment.id &&
          deployment.meta?.imageDigest === snapshot.deployment.meta?.imageDigest &&
          ['QUEUED', 'INITIALIZING', 'BUILDING', 'DEPLOYING', 'WAITING'].includes(deployment.status)
      )
      const rollbackRetryDue =
        lastRollbackAttempt === undefined || attempt - lastRollbackAttempt >= 6
      if (
        (!activePrior || promotionDeployments.length > 0) &&
        !priorInProgress &&
        rollbackRetryDue
      ) {
        const prior = deployments.find((deployment) => deployment.id === snapshot.deployment.id)
        if (prior?.canRollback === true) {
          lastRollbackAttempt = attempt
          try {
            await railway.rollbackDeployment(target, snapshot.deployment.id)
          } catch (error) {
            lastReconciliationError = error
          }
        }
      }
    }

    let verifiedSource
    let verifiedDeployments
    try {
      verifiedSource = normalizeSource(await railway.getSource(target))
      verifiedDeployments = await railway.listDeployments(target)
    } catch (error) {
      lastReconciliationError = error
      stableChecks = 0
      await sleep(10_000)
      continue
    }

    const noActivePromotion = verifiedDeployments.every(
      (deployment) =>
        deployment.meta?.image !== expectedImage || deployment.deploymentStopped !== false
    )
    const priorStateActive =
      snapshot.deployment === undefined
        ? verifiedDeployments.every((deployment) => deployment.deploymentStopped !== false)
        : verifiedDeployments.some(
            (deployment) =>
              deployment.status === 'SUCCESS' &&
              deployment.deploymentStopped === false &&
              deployment.meta?.imageDigest === snapshot.deployment.meta?.imageDigest
          )

    if (
      isDeepStrictEqual(verifiedSource, snapshot.source) &&
      noActivePromotion &&
      priorStateActive
    ) {
      stableChecks += 1
      if (stableChecks >= 3) return
    } else {
      stableChecks = 0
    }
    await sleep(10_000)
  }

  throw new Error(`Rollback reconciliation failed for ${target}`, {
    cause: lastReconciliationError,
  })
}

async function rollbackTarget(options) {
  const { target, snapshot, railway } = options
  try {
    await railway.updateSource(target, snapshot.source)
  } catch {
    // A lost response is ambiguous; reconciliation below establishes truth.
  }
  await reconcilePriorState(options)
}

function validateManifests(manifests) {
  const byTarget = new Map()
  for (const manifest of manifests) {
    if (!(manifest.target in SERVICE_IDS)) {
      throw new Error(`Unsupported production target: ${manifest.target}`)
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(manifest.digest)) {
      throw new Error(`Invalid digest for ${manifest.target}`)
    }
    if (typeof manifest.image !== 'string' || !manifest.image.startsWith('ghcr.io/adea-ai/')) {
      throw new Error(`Invalid image for ${manifest.target}`)
    }
    if (byTarget.has(manifest.target)) throw new Error(`Duplicate target: ${manifest.target}`)
    byTarget.set(manifest.target, manifest)
  }
  if (byTarget.size !== Object.keys(SERVICE_IDS).length) {
    throw new Error('Promotion requires exactly the control-api and workflow-worker manifests')
  }
  return byTarget
}

export async function promoteRailwayImages({
  manifests,
  railway,
  pullImage,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  verifyRetries = 60,
}) {
  const byTarget = validateManifests(manifests)
  const snapshots = new Map()
  const intents = []

  for (const target of Object.keys(SERVICE_IDS)) {
    const manifest = byTarget.get(target)
    await pullImage(`${manifest.image}@${manifest.digest}`)
    const deployments = await railway.listDeployments(target)
    const current = activeSuccessfulDeployment(deployments)
    snapshots.set(target, {
      source: normalizeSource(await railway.getSource(target)),
      deployment: current,
      knownDeploymentIds: new Set(deployments.map(({ id }) => id)),
    })
  }

  try {
    for (const target of Object.keys(SERVICE_IDS)) {
      const manifest = byTarget.get(target)
      const expectedImage = `${manifest.image}@${manifest.digest}`
      const expectedSource = { image: expectedImage, repo: null }
      intents.push(target)
      await railway.updateSource(target, expectedSource)
      await waitForExpectedSource({
        target,
        expectedSource,
        railway,
        sleep,
        verifyRetries,
      })
      await railway.deploySource(target)
      await waitForExpectedDeployment({
        target,
        expectedImage,
        expectedDigest: manifest.digest,
        knownDeploymentIds: snapshots.get(target).knownDeploymentIds,
        railway,
        sleep,
        verifyRetries,
      })
    }
  } catch (promotionError) {
    const rollbackErrors = []
    for (const target of intents.toReversed()) {
      try {
        const manifest = byTarget.get(target)
        await rollbackTarget({
          target,
          expectedImage: `${manifest.image}@${manifest.digest}`,
          snapshot: snapshots.get(target),
          railway,
          sleep,
          verifyRetries,
        })
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [promotionError, ...rollbackErrors],
        `${promotionError.message}; rollback verification also failed`,
        { cause: promotionError }
      )
    }
    throw promotionError
  }
}

export function createRailwayClient({ token, fetchImpl = fetch }) {
  if (!token) throw new Error('RAILWAY_PRODUCTION_TOKEN is required')

  async function request(query, variables) {
    const response = await fetchImpl(RAILWAY_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Project-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(`Railway API returned HTTP ${response.status}`)
    if (body.errors)
      throw new Error(`Railway API rejected the operation: ${JSON.stringify(body.errors)}`)
    return body.data
  }

  function variablesForTarget(target) {
    return {
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_IDS[target],
    }
  }

  return {
    async getSource(target) {
      const { serviceId, environmentId } = variablesForTarget(target)
      const data = await request(SOURCE_QUERY, { serviceId, environmentId })
      return normalizeSource(data.serviceInstance.source)
    },
    async listDeployments(target) {
      const data = await request(DEPLOYMENTS_QUERY, { input: variablesForTarget(target) })
      return data.deployments.edges.map(({ node }) => node)
    },
    async updateSource(target, source) {
      const { serviceId } = variablesForTarget(target)
      if (source.image === null && source.repo === null) {
        const data = await request(DISCONNECT_MUTATION, { id: serviceId })
        if (data.serviceDisconnect?.id !== serviceId) {
          throw new Error('Railway mutation serviceDisconnect returned the wrong service')
        }
        return
      }

      const data = await request(CONNECT_MUTATION, { id: serviceId, input: source })
      if (data.serviceConnect?.id !== serviceId) {
        throw new Error('Railway mutation serviceConnect returned the wrong service')
      }
    },
    async deploySource(target) {
      const { serviceId, environmentId } = variablesForTarget(target)
      const data = await request(DEPLOY_MUTATION, { serviceId, environmentId })
      if (typeof data.serviceInstanceDeployV2 !== 'string' || !data.serviceInstanceDeployV2) {
        throw new Error('Railway mutation serviceInstanceDeployV2 returned no deployment ID')
      }
      return data.serviceInstanceDeployV2
    },
    async rollbackDeployment(_target, id) {
      const data = await request(ROLLBACK_MUTATION, { id })
      assertMutationSucceeded(data, 'deploymentRollback')
    },
    async removeDeployment(_target, id) {
      const data = await request(REMOVE_MUTATION, { id })
      assertMutationSucceeded(data, 'deploymentRemove')
    },
  }
}

async function pullDockerImage(reference) {
  const process = Bun.spawn(['docker', 'pull', reference], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(`Anonymous pull failed for ${reference}`)
}

async function main() {
  const paths = process.argv.slice(2)
  if (paths.length === 0) throw new Error('At least one promotion manifest is required')
  const manifests = await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(path, 'utf8')))
  )
  const railway = createRailwayClient({ token: process.env.RAILWAY_PRODUCTION_TOKEN })
  await promoteRailwayImages({ manifests, railway, pullImage: pullDockerImage })
}

if (import.meta.main) {
  await main()
}
