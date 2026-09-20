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
const UPDATE_MUTATION = `mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
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

async function waitForExpectedDeployment({
  target,
  expectedImage,
  expectedDigest,
  railway,
  sleep,
  verifyRetries,
}) {
  for (let attempt = 0; attempt < verifyRetries; attempt += 1) {
    const deployments = await railway.listDeployments(target)
    const match = deployments.find((deployment) => deployment.meta?.image === expectedImage)
    if (!match) {
      await sleep(10_000)
      continue
    }
    if (
      ['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED', 'NEEDS_APPROVAL'].includes(
        match.status
      )
    ) {
      throw new Error(`Deployment for ${target} stopped with ${match.status}`)
    }
    if (
      match.status === 'SUCCESS' &&
      match.deploymentStopped === false &&
      matchesExpectedDeployment(match, expectedImage, expectedDigest)
    ) {
      return match
    }
    await sleep(10_000)
  }
  throw new Error(`Timed out waiting for ${target} to deploy ${expectedImage}`)
}

async function waitForPriorState({ target, snapshot, railway, sleep, verifyRetries }) {
  for (let attempt = 0; attempt < verifyRetries; attempt += 1) {
    const deployments = await railway.listDeployments(target)
    const source = normalizeSource(await railway.getSource(target))
    if (!isDeepStrictEqual(source, snapshot.source)) {
      await sleep(10_000)
      continue
    }

    if (snapshot.deployment === undefined) {
      if (deployments.every((deployment) => deployment.deploymentStopped !== false)) return
    } else {
      const restored = deployments.find(
        (deployment) =>
          deployment.status === 'SUCCESS' &&
          deployment.deploymentStopped === false &&
          deployment.meta?.imageDigest === snapshot.deployment.meta?.imageDigest
      )
      if (restored) return
    }
    await sleep(10_000)
  }
  throw new Error(`Rollback verification failed for ${target}`)
}

async function rollbackTarget({ target, expectedImage, snapshot, railway, sleep, verifyRetries }) {
  const deployments = await railway.listDeployments(target)
  const source = normalizeSource(await railway.getSource(target))
  const promotionDeployments = deployments.filter(
    (deployment) =>
      deployment.meta?.image === expectedImage && deployment.deploymentStopped === false
  )
  const sourceChanged = source.image === expectedImage

  if (!sourceChanged && promotionDeployments.length === 0) return

  if (snapshot.deployment === undefined) {
    for (const deployment of promotionDeployments) {
      await railway.removeDeployment(target, deployment.id)
    }
  } else {
    const prior = deployments.find((deployment) => deployment.id === snapshot.deployment.id)
    if (prior?.canRollback !== true) {
      throw new Error(`Prior deployment for ${target} is no longer rollbackable`)
    }
    await railway.rollbackDeployment(target, snapshot.deployment.id)
  }

  await railway.updateSource(target, snapshot.source)
  await waitForPriorState({ target, snapshot, railway, sleep, verifyRetries })
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
    })
  }

  try {
    for (const target of Object.keys(SERVICE_IDS)) {
      const manifest = byTarget.get(target)
      const expectedImage = `${manifest.image}@${manifest.digest}`
      intents.push(target)
      await railway.updateSource(target, { image: expectedImage, repo: null })
      await waitForExpectedDeployment({
        target,
        expectedImage,
        expectedDigest: manifest.digest,
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
      const { serviceId, environmentId } = variablesForTarget(target)
      const data = await request(UPDATE_MUTATION, {
        serviceId,
        environmentId,
        input: { source },
      })
      assertMutationSucceeded(data, 'serviceInstanceUpdate')
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
