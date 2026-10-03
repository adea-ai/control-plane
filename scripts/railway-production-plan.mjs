import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const applicationImagePattern =
  /^ghcr\.io\/adea-ai\/control-plane-control-api@sha256:([0-9a-f]{64})$/
const apiQuery = `query ProductionSourceOwnership($serviceId: String!, $environmentId: String!) {
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    source { image repo }
    activeDeployments { id status deploymentStopped meta }
  }
}`

function requireNonEmptyString(value, description) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Railway ${description} is missing from the linked project.`)
  }
  return value
}

export function resolveProductionTargetFromStatus(status) {
  if (status?.name !== 'control-plane') {
    throw new Error('The linked project must be control-plane before planning production.')
  }

  const environments = status.environments?.edges
    ?.map(({ node }) => node)
    .filter((environment) => environment?.name === 'production')
  if (!Array.isArray(environments) || environments.length !== 1) {
    throw new Error('The linked project must expose exactly one production environment.')
  }

  const services = environments[0].serviceInstances?.edges
    ?.map(({ node }) => node)
    .filter((service) => service?.serviceName === '@control-plane/control-api')
  if (!Array.isArray(services) || services.length !== 1) {
    throw new Error('The production environment must expose exactly one control-api service.')
  }

  return {
    environmentId: requireNonEmptyString(environments[0].id, 'production environment ID'),
    projectId: requireNonEmptyString(status.id, 'linked project ID'),
    serviceId: requireNonEmptyString(services[0].serviceId, 'control-api service ID'),
  }
}

function resolvePromotedProductionState(apiResponse) {
  if (Array.isArray(apiResponse?.errors) && apiResponse.errors.length > 0) {
    throw new Error('Railway source query returned GraphQL errors.')
  }
  const service = apiResponse?.data?.serviceInstance
  const source = service?.source
  if (!source || source.repo !== null) {
    throw new Error('Production control-api must have an image source and no connected repository.')
  }

  const image = source.image
  const match = typeof image === 'string' ? applicationImagePattern.exec(image) : null
  if (!match) {
    throw new Error('Production control-api must use its immutable production image digest.')
  }

  const deployments = service.activeDeployments
  if (
    !Array.isArray(deployments) ||
    deployments.length !== 1 ||
    deployments[0]?.status !== 'SUCCESS' ||
    deployments[0]?.deploymentStopped !== false ||
    typeof deployments[0]?.id !== 'string' ||
    deployments[0].id.length === 0 ||
    deployments[0]?.meta?.image !== image ||
    deployments[0]?.meta?.imageDigest !== `sha256:${match[1]}`
  ) {
    throw new Error(
      'Production source must match the sole active successful deployment and its image digest.'
    )
  }

  return { deploymentId: deployments[0].id, image }
}

export function resolvePromotedProductionImage(apiResponse) {
  return resolvePromotedProductionState(apiResponse).image
}

function parseJson(stdout, description) {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`Railway ${description} returned invalid JSON.`)
  }
}

function findRailwayBinary(pathValue) {
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = resolve(directory, 'railway')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH without displaying paths or command output.
    }
  }
  throw new Error('Railway CLI was not found on PATH.')
}

function runRailway(args, environment) {
  const result = spawnSync('railway', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Railway ${args[0]} command failed; output was withheld.`)
  }
  return result.stdout
}

function readProductionSource(target, callRailway, commandOptions) {
  const stdout = callRailway(
    [
      'api',
      '--compact',
      apiQuery,
      '--raw-var',
      `serviceId=${target.serviceId}`,
      '--raw-var',
      `environmentId=${target.environmentId}`,
    ],
    commandOptions
  )
  return resolvePromotedProductionState(parseJson(stdout, 'source query'))
}

function assertPlanTargetsProduction(output) {
  if (!/^Project\s+control-plane\s*$/im.test(output)) {
    throw new Error('Railway plan did not target the linked control-plane project.')
  }
  if (!/^Environment\s+production\s*$/im.test(output)) {
    throw new Error('Railway plan did not target the production environment.')
  }
  if (/\bsource(?:\.[a-z][\w-]*)?\b/i.test(output)) {
    throw new Error('Railway production plan contains a source change and was withheld.')
  }
}

export function planProductionConfig(options = {}) {
  const env = options.env ?? process.env
  const injectedRunner = options.runCommand
  const runCommand =
    injectedRunner ?? ((args, commandOptions) => runRailway(args, commandOptions.env))
  const railwayBinary = injectedRunner ? (env._ ?? 'railway') : findRailwayBinary(env.PATH)
  const callRailway = (args, commandOptions) => {
    const result = runCommand(args, commandOptions)
    if (typeof result === 'string') return result
    if (result?.error || result?.status !== 0) {
      throw new Error(`Railway ${args[0]} command failed; output was withheld.`)
    }
    return result.stdout
  }
  const commandEnvironment = {
    ...process.env,
    ...env,
    _: railwayBinary,
    NO_COLOR: '1',
    RAILWAY_CALLER: env.RAILWAY_CALLER ?? 'skill:use-railway@1.5.5',
    RAILWAY_AGENT_SESSION: env.RAILWAY_AGENT_SESSION ?? randomUUID(),
  }
  const commandOptions = { cwd: repositoryRoot, env: commandEnvironment }

  const statusOutput = callRailway(['status', '--json'], commandOptions)
  const target = resolveProductionTargetFromStatus(parseJson(statusOutput, 'status'))
  const liveState = readProductionSource(target, callRailway, commandOptions)

  if (
    env.CONTROL_PLANE_PRODUCTION_IMAGE !== undefined &&
    env.CONTROL_PLANE_PRODUCTION_IMAGE !== liveState.image
  ) {
    throw new Error('CONTROL_PLANE_PRODUCTION_IMAGE does not match the current production image.')
  }

  const planOutput = callRailway(['config', 'plan'], {
    cwd: repositoryRoot,
    env: { ...commandEnvironment, CONTROL_PLANE_PRODUCTION_IMAGE: liveState.image },
  })
  assertPlanTargetsProduction(planOutput)

  const statusAfterPlanning = resolveProductionTargetFromStatus(
    parseJson(callRailway(['status', '--json'], commandOptions), 'status')
  )
  if (
    statusAfterPlanning.projectId !== target.projectId ||
    statusAfterPlanning.environmentId !== target.environmentId ||
    statusAfterPlanning.serviceId !== target.serviceId
  ) {
    throw new Error('Linked Railway target changed while planning; discard the plan and retry.')
  }

  const stateAfterPlanning = readProductionSource(target, callRailway, commandOptions)
  if (
    stateAfterPlanning.image !== liveState.image ||
    stateAfterPlanning.deploymentId !== liveState.deploymentId
  ) {
    throw new Error('Production source changed while planning; discard the plan and retry.')
  }

  return { image: liveState.image, output: planOutput }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const plan = planProductionConfig()
    process.stdout.write(plan.output)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
