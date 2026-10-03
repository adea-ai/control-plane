import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  planProductionConfig,
  resolveProductionTargetFromStatus,
  resolvePromotedProductionImage,
} from '../scripts/railway-production-plan.mjs'
import { resolveApplicationSource } from '../.railway/production-source.js'

const digest = `sha256:${'a'.repeat(64)}`
const productionImage = `ghcr.io/adea-ai/control-plane-control-api@${digest}`
const differentDigest = `sha256:${'b'.repeat(64)}`
const differentImage = `ghcr.io/adea-ai/control-plane-control-api@${differentDigest}`

const status = {
  id: 'project-id',
  name: 'control-plane',
  environments: {
    edges: [
      {
        node: {
          id: 'production-environment-id',
          name: 'production',
          serviceInstances: {
            edges: [
              {
                node: {
                  serviceId: 'control-api-service-id',
                  serviceName: '@control-plane/control-api',
                },
              },
            ],
          },
        },
      },
    ],
  },
}

function sourceSnapshot({
  image = productionImage,
  repo = null,
  deploymentImage = image,
  deploymentDigest = image?.split('@')[1],
  status: deploymentStatus = 'SUCCESS',
  deploymentStopped = false,
} = {}) {
  return {
    data: {
      serviceInstance: {
        source: { image, repo },
        activeDeployments: [
          {
            id: 'active-deployment-id',
            status: deploymentStatus,
            deploymentStopped,
            meta: { image: deploymentImage, imageDigest: deploymentDigest },
          },
        ],
      },
    },
  }
}

function createCommandRunner({
  statusOutput = status,
  statusOutputs,
  sourceSnapshots = [sourceSnapshot(), sourceSnapshot()],
  planOutput = 'Railway configuration\nProject control-plane\nEnvironment production\nPlan: 0 to add, 1 to change, 0 to destroy\n',
} = {}) {
  const calls = []
  let statusRead = 0
  let sourceRead = 0

  return {
    calls,
    runCommand(args, options) {
      calls.push({ args, options })
      if (args[0] === 'status') {
        const snapshots = statusOutputs ?? [statusOutput]
        const next = snapshots[Math.min(statusRead, snapshots.length - 1)]
        statusRead += 1
        return { status: 0, stdout: JSON.stringify(next), stderr: '' }
      }
      if (args[0] === 'api') {
        const next = sourceSnapshots[Math.min(sourceRead, sourceSnapshots.length - 1)]
        sourceRead += 1
        return { status: 0, stdout: JSON.stringify(next), stderr: '' }
      }
      if (args[0] === 'config' && args[1] === 'plan') {
        return { status: 0, stdout: planOutput, stderr: '' }
      }
      throw new Error(`Unexpected Railway command: ${args.join(' ')}`)
    },
  }
}

describe('Railway production image ownership', () => {
  test('resolves the production control-api IDs from the linked project by name', () => {
    assert.deepEqual(resolveProductionTargetFromStatus(status), {
      environmentId: 'production-environment-id',
      projectId: 'project-id',
      serviceId: 'control-api-service-id',
    })
  })

  test('rejects a different linked project before reading production state', () => {
    assert.throws(
      () => resolveProductionTargetFromStatus({ ...status, name: 'another-project' }),
      /linked project/i
    )
  })

  test('accepts the current immutable GHCR image only when the active success matches it', () => {
    assert.equal(resolvePromotedProductionImage(sourceSnapshot()), productionImage)
  })

  test('rejects an omitted or repository-connected image source', () => {
    assert.throws(
      () => resolvePromotedProductionImage(sourceSnapshot({ image: null })),
      /immutable production image/i
    )
    assert.throws(
      () =>
        resolvePromotedProductionImage(
          sourceSnapshot({ image: null, repo: 'adea-ai/control-plane' })
        ),
      /image source/i
    )
  })

  test('rejects mutable tags and image references for another repository', () => {
    assert.throws(
      () =>
        resolvePromotedProductionImage(
          sourceSnapshot({ image: 'ghcr.io/adea-ai/control-plane-control-api:latest' })
        ),
      /immutable production image/i
    )
    assert.throws(
      () =>
        resolvePromotedProductionImage(
          sourceSnapshot({ image: `ghcr.io/adea-ai/other-service@${digest}` })
        ),
      /immutable production image/i
    )
  })

  test('rejects a source whose active deployment is stale or still promoting', () => {
    assert.throws(
      () =>
        resolvePromotedProductionImage(
          sourceSnapshot({ deploymentImage: differentImage, deploymentDigest: differentDigest })
        ),
      /active successful deployment/i
    )
    assert.throws(
      () => resolvePromotedProductionImage(sourceSnapshot({ status: 'DEPLOYING' })),
      /active successful deployment/i
    )
  })

  test('rejects a deployment rotation while the production plan is being generated', () => {
    const rotatedDeployment = sourceSnapshot()
    rotatedDeployment.data.serviceInstance.activeDeployments[0].id = 'new-active-deployment-id'
    const commandRunner = createCommandRunner({
      sourceSnapshots: [sourceSnapshot(), rotatedDeployment],
    })

    assert.throws(
      () =>
        planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand }),
      /changed while planning/i
    )
  })

  test('keeps staging on the main GitHub source without a production image input', () => {
    assert.deepEqual(
      resolveApplicationSource({
        production: false,
        repository: 'adea-ai/control-plane',
        branch: 'main',
      }),
      { type: 'github', repo: 'adea-ai/control-plane', branch: 'main' }
    )
  })

  test('requires an exact immutable production image in the authoring config', () => {
    assert.throws(
      () => resolveApplicationSource({ production: true, productionImage: undefined }),
      /CONTROL_PLANE_PRODUCTION_IMAGE/i
    )
    assert.throws(
      () =>
        resolveApplicationSource({
          production: true,
          productionImage: 'ghcr.io/adea-ai/control-plane-control-api:latest',
        }),
      /CONTROL_PLANE_PRODUCTION_IMAGE/i
    )
    assert.deepEqual(resolveApplicationSource({ production: true, productionImage }), {
      type: 'image',
      image: productionImage,
    })
  })

  test('plans with the freshly verified production image and confirms the source is unchanged', () => {
    const commandRunner = createCommandRunner()
    const plan = planProductionConfig({
      env: { PATH: '/usr/bin' },
      runCommand: commandRunner.runCommand,
    })

    assert.equal(plan.image, productionImage)
    assert.match(plan.output, /Environment production/)
    const configCall = commandRunner.calls.find(({ args }) => args[0] === 'config')
    assert.equal(configCall.options.env.CONTROL_PLANE_PRODUCTION_IMAGE, productionImage)
    const invocationSession = commandRunner.calls[0].options.env.RAILWAY_AGENT_SESSION
    assert.match(
      invocationSession,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    assert.ok(
      commandRunner.calls.every(
        ({ options }) => options.env.RAILWAY_AGENT_SESSION === invocationSession
      )
    )
    assert.equal(commandRunner.calls[0].options.env.RAILWAY_CALLER, 'skill:use-railway@1.5.5')
  })

  test('rejects a stale caller-provided image before creating a plan', () => {
    const commandRunner = createCommandRunner()

    assert.throws(
      () =>
        planProductionConfig({
          env: { PATH: '/usr/bin', CONTROL_PLANE_PRODUCTION_IMAGE: differentImage },
          runCommand: commandRunner.runCommand,
        }),
      /does not match the current production image/i
    )
    assert.equal(
      commandRunner.calls.some(({ args }) => args[0] === 'config'),
      false
    )
  })

  test('preserves an explicitly supplied Railway audit session ID', () => {
    const commandRunner = createCommandRunner()

    planProductionConfig({
      env: { PATH: '/usr/bin', RAILWAY_AGENT_SESSION: 'operator-audit-session' },
      runCommand: commandRunner.runCommand,
    })

    assert.ok(
      commandRunner.calls.every(
        ({ options }) => options.env.RAILWAY_AGENT_SESSION === 'operator-audit-session'
      )
    )
  })

  test('fails closed when the source and active deployment digest do not match', () => {
    const commandRunner = createCommandRunner({
      sourceSnapshots: [
        sourceSnapshot({ deploymentImage: differentImage, deploymentDigest: differentDigest }),
      ],
    })

    assert.throws(
      () =>
        planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand }),
      /active successful deployment/i
    )
    assert.equal(
      commandRunner.calls.some(({ args }) => args[0] === 'config'),
      false
    )
  })

  test('withholds a plan that targets another environment or includes a source change', () => {
    const wrongEnvironment = createCommandRunner({
      planOutput: 'Project control-plane\nEnvironment staging\nPlan: no changes\n',
    })
    assert.throws(
      () =>
        planProductionConfig({
          env: { PATH: '/usr/bin' },
          runCommand: wrongEnvironment.runCommand,
        }),
      /production environment/i
    )

    const wrongProject = createCommandRunner({
      planOutput: 'Project another-project\nEnvironment production\nPlan: no changes\n',
    })
    assert.throws(
      () =>
        planProductionConfig({
          env: { PATH: '/usr/bin' },
          runCommand: wrongProject.runCommand,
        }),
      /control-plane project/i
    )

    const sourceDrift = createCommandRunner({
      planOutput:
        'Project control-plane\nEnvironment production\n  ~ Update control-api source.image\n',
    })
    assert.throws(
      () => planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: sourceDrift.runCommand }),
      /source change/i
    )

    for (const sourceField of ['source.type', 'source']) {
      const sourceFieldDrift = createCommandRunner({
        planOutput: `Project control-plane\nEnvironment production\n  ~ Update control-api ${sourceField} to null\n`,
      })
      assert.throws(
        () =>
          planProductionConfig({
            env: { PATH: '/usr/bin' },
            runCommand: sourceFieldDrift.runCommand,
          }),
        /source change/i
      )
    }
  })

  test('rejects a production source that changes while the plan is being generated', () => {
    const commandRunner = createCommandRunner({
      sourceSnapshots: [
        sourceSnapshot(),
        sourceSnapshot({
          image: differentImage,
          deploymentImage: differentImage,
          deploymentDigest: differentDigest,
        }),
      ],
    })

    assert.throws(
      () =>
        planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand }),
      /changed while planning/i
    )
  })

  test('rejects a linked project or environment switch during plan generation', () => {
    const switchedProject = { ...status, id: 'another-project-id' }
    const commandRunner = createCommandRunner({ statusOutputs: [status, switchedProject] })

    assert.throws(
      () =>
        planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand }),
      /linked Railway target changed/i
    )
  })
})
