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
  activeDeployments,
  graphqlErrors,
} = {}) {
  return {
    ...(graphqlErrors ? { errors: graphqlErrors } : {}),
    data: {
      serviceInstance: {
        source: { image, repo },
        activeDeployments: activeDeployments ?? [
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

function controlApiService(options = {}) {
  return {
    serviceId: 'control-api-service-id',
    serviceName: '@control-plane/control-api',
    ...options,
  }
}

function productionEnvironment(options = {}) {
  const { services, ...rest } = options
  return {
    id: 'production-environment-id',
    name: 'production',
    serviceInstances: {
      edges: (services ?? [controlApiService()]).map((node) => ({ node })),
    },
    ...rest,
  }
}

function statusWithEnvironments(environments) {
  return { ...status, environments: { edges: environments.map((node) => ({ node })) } }
}

function createCommandRunner({
  statusOutput = status,
  statusOutputs,
  sourceSnapshots = [sourceSnapshot(), sourceSnapshot()],
  planOutput = 'Railway configuration\nProject control-plane\nEnvironment production\nPlan: 0 to add, 1 to change, 0 to destroy\n',
  failures = {},
} = {}) {
  const calls = []
  let statusRead = 0
  let sourceRead = 0

  return {
    calls,
    runCommand(args, options) {
      calls.push({ args, options })
      const failure = failures[args[0]]
      if (failure) {
        if (failure.throws) {
          throw new Error(failure.message ?? 'the command runner could not start the command')
        }
        return failure.result
      }
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

function refusalFrom(run) {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('the qualification expected a refusal and none was raised')
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

describe('Railway production source-plan offline qualification', () => {
  test('refuses a linked project that exposes more than one production environment', () => {
    const error = refusalFrom(() =>
      resolveProductionTargetFromStatus(
        statusWithEnvironments([
          productionEnvironment(),
          productionEnvironment({ id: 'second-production-environment-id' }),
        ])
      )
    )

    assert.match(error.message, /exactly one production environment/i)
  })

  test('refuses a linked project that exposes no production environment', () => {
    const error = refusalFrom(() => resolveProductionTargetFromStatus(statusWithEnvironments([])))

    assert.match(error.message, /exactly one production environment/i)
  })

  test('refuses a production environment that exposes more than one control-api service', () => {
    const error = refusalFrom(() =>
      resolveProductionTargetFromStatus(
        statusWithEnvironments([
          productionEnvironment({
            services: [controlApiService(), controlApiService({ serviceId: 'second-service-id' })],
          }),
        ])
      )
    )

    assert.match(error.message, /exactly one control-api service/i)
  })

  test('refuses a production environment that exposes no control-api service', () => {
    const error = refusalFrom(() =>
      resolveProductionTargetFromStatus(
        statusWithEnvironments([productionEnvironment({ services: [] })])
      )
    )

    assert.match(error.message, /exactly one control-api service/i)
  })

  test('ignores a production service that is not the control-api service', () => {
    const resolved = resolveProductionTargetFromStatus(
      statusWithEnvironments([
        productionEnvironment({
          services: [
            controlApiService({ serviceId: 'other-service-id', serviceName: '@control-plane/web' }),
            controlApiService(),
          ],
        }),
      ])
    )

    assert.equal(resolved.serviceId, 'control-api-service-id')
  })

  test('refuses a source that exposes more than one active deployment', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(
        sourceSnapshot({
          activeDeployments: [
            {
              id: 'active-deployment-id',
              status: 'SUCCESS',
              deploymentStopped: false,
              meta: { image: productionImage, imageDigest: productionImage.split('@')[1] },
            },
            {
              id: 'second-active-deployment-id',
              status: 'SUCCESS',
              deploymentStopped: false,
              meta: { image: productionImage, imageDigest: productionImage.split('@')[1] },
            },
          ],
        })
      )
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses a source that exposes no active deployment', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(sourceSnapshot({ activeDeployments: [] }))
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses a source that is connected to a repository instead of an image', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(sourceSnapshot({ repo: 'adea-ai/control-plane' }))
    )

    assert.match(error.message, /image source/i)
  })

  test('refuses a source query that returns GraphQL errors', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(
        sourceSnapshot({ graphqlErrors: [{ message: 'the environment is not visible' }] })
      )
    )

    assert.match(error.message, /GraphQL errors/i)
  })

  test('refuses a production environment without an environment identifier', () => {
    const error = refusalFrom(() =>
      resolveProductionTargetFromStatus(
        statusWithEnvironments([productionEnvironment({ id: undefined })])
      )
    )

    assert.match(error.message, /production environment ID is missing/i)
  })

  test('refuses a linked project without a project identifier', () => {
    const error = refusalFrom(() => resolveProductionTargetFromStatus({ ...status, id: undefined }))

    assert.match(error.message, /linked project ID is missing/i)
  })

  test('refuses a control-api service without a service identifier', () => {
    const error = refusalFrom(() =>
      resolveProductionTargetFromStatus(
        statusWithEnvironments([
          productionEnvironment({ services: [controlApiService({ serviceId: undefined })] }),
        ])
      )
    )

    assert.match(error.message, /control-api service ID is missing/i)
  })

  test('refuses an active deployment without an identifier', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(
        sourceSnapshot({
          activeDeployments: [
            {
              status: 'SUCCESS',
              deploymentStopped: false,
              meta: { image: productionImage, imageDigest: productionImage.split('@')[1] },
            },
          ],
        })
      )
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses an active deployment without deployment metadata', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(
        sourceSnapshot({
          activeDeployments: [
            { id: 'active-deployment-id', status: 'SUCCESS', deploymentStopped: false },
          ],
        })
      )
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses an active deployment whose image contradicts the source image', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(
        sourceSnapshot({
          activeDeployments: [
            {
              id: 'active-deployment-id',
              status: 'SUCCESS',
              deploymentStopped: false,
              meta: { image: differentImage, imageDigest: differentDigest },
            },
          ],
        })
      )
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses an active deployment whose metadata image alone contradicts the source', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(
        sourceSnapshot({
          activeDeployments: [
            {
              id: 'active-deployment-id',
              status: 'SUCCESS',
              deploymentStopped: false,
              meta: { image: differentImage, imageDigest: productionImage.split('@')[1] },
            },
          ],
        })
      )
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses an active deployment whose metadata digest alone contradicts the source', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(
        sourceSnapshot({
          activeDeployments: [
            {
              id: 'active-deployment-id',
              status: 'SUCCESS',
              deploymentStopped: false,
              meta: { image: productionImage, imageDigest: differentDigest },
            },
          ],
        })
      )
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses a production image that belongs to another repository', () => {
    const error = refusalFrom(() =>
      resolveApplicationSource({
        production: true,
        productionImage: `ghcr.io/adea-ai/other-service@${digest}`,
      })
    )

    assert.match(error.message, /CONTROL_PLANE_PRODUCTION_IMAGE/i)
  })

  test('refuses a production image whose digest is not a full sha256', () => {
    for (const candidateImage of [
      `ghcr.io/adea-ai/control-plane-control-api@sha256:${'a'.repeat(63)}`,
      `ghcr.io/adea-ai/control-plane-control-api@sha256:${'z'.repeat(64)}`,
      `ghcr.io/adea-ai/control-plane-control-api@${'a'.repeat(64)}`,
    ]) {
      const error = refusalFrom(() =>
        resolveApplicationSource({ production: true, productionImage: candidateImage })
      )

      assert.match(error.message, /CONTROL_PLANE_PRODUCTION_IMAGE/i)
    }
  })

  test('refuses a stopped deployment history', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(sourceSnapshot({ deploymentStopped: true }))
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses a deployment history whose newest deployment is stopped', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(sourceSnapshot({ status: 'STOPPED' }))
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses a deployment history whose newest deployment failed', () => {
    const error = refusalFrom(() =>
      resolvePromotedProductionImage(sourceSnapshot({ status: 'ERROR' }))
    )

    assert.match(error.message, /sole active successful deployment/i)
  })

  test('refuses a stopped source before a plan command is issued', () => {
    const commandRunner = createCommandRunner({
      sourceSnapshots: [sourceSnapshot({ deploymentStopped: true })],
    })

    const error = refusalFrom(() =>
      planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand })
    )

    assert.match(error.message, /sole active successful deployment/i)
    assert.equal(
      commandRunner.calls.some(({ args }) => args[0] === 'config'),
      false
    )
  })

  test('refuses a failed status command and withholds its output', () => {
    const commandRunner = createCommandRunner({
      failures: {
        status: { result: { status: 1, stdout: 'railway-output-marker', stderr: '' } },
      },
    })

    const error = refusalFrom(() =>
      planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand })
    )

    assert.match(error.message, /Railway status command failed; output was withheld\./)
    assert.equal(error.message.includes('railway-output-marker'), false)
  })

  test('refuses a failed source query and withholds its output', () => {
    const commandRunner = createCommandRunner({
      failures: {
        api: { result: { status: 1, stdout: 'railway-output-marker', stderr: '' } },
      },
    })

    const error = refusalFrom(() =>
      planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand })
    )

    assert.match(error.message, /Railway api command failed; output was withheld\./)
    assert.equal(error.message.includes('railway-output-marker'), false)
  })

  test('refuses a failed plan command and withholds its output', () => {
    const commandRunner = createCommandRunner({
      failures: {
        config: { result: { status: 1, stdout: 'railway-output-marker', stderr: '' } },
      },
    })

    const error = refusalFrom(() =>
      planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand })
    )

    assert.match(error.message, /Railway config command failed; output was withheld\./)
    assert.equal(error.message.includes('railway-output-marker'), false)
  })

  test('refuses a command that timed out', () => {
    const commandRunner = createCommandRunner({
      failures: {
        status: {
          result: {
            error: Object.assign(new Error('spawnSync railway ETIMEDOUT'), { code: 'ETIMEDOUT' }),
            status: null,
          },
        },
      },
    })

    const error = refusalFrom(() =>
      planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand })
    )

    assert.match(error.message, /Railway status command failed; output was withheld\./)
  })

  test('refuses a command runner that throws', () => {
    const commandRunner = createCommandRunner({
      failures: { status: { throws: true, message: 'the runner could not start railway' } },
    })

    const error = refusalFrom(() =>
      planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand })
    )

    assert.match(error.message, /Railway status command failed; output was withheld\./)
    assert.equal(error.message.includes('the runner could not start railway'), false)
  })

  test('refuses a status read that is not JSON', () => {
    const commandRunner = createCommandRunner({
      failures: { status: { result: { status: 0, stdout: 'not json at all', stderr: '' } } },
    })

    const error = refusalFrom(() =>
      planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand })
    )

    assert.match(error.message, /Railway status returned invalid JSON\./)
  })

  test('refuses a source read that is not JSON', () => {
    const commandRunner = createCommandRunner({
      failures: { api: { result: { status: 0, stdout: 'not json at all', stderr: '' } } },
    })

    const error = refusalFrom(() =>
      planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand })
    )

    assert.match(error.message, /Railway source query returned invalid JSON\./)
  })

  test('refuses the same input with the same refusal every time', () => {
    const run = () => {
      const commandRunner = createCommandRunner({
        failures: { status: { result: { status: 1, stdout: '', stderr: '' } } },
      })
      return refusalFrom(() =>
        planProductionConfig({ env: { PATH: '/usr/bin' }, runCommand: commandRunner.runCommand })
      )
    }

    const first = run()
    const second = run()

    assert.equal(first.message, second.message)
    assert.equal(first.name, second.name)
    assert.equal(first.message, 'Railway status command failed; output was withheld.')
  })

  test('names the refused fact in every refusal', () => {
    const cases = [
      {
        expected: /exactly one production environment/i,
        run: () =>
          resolveProductionTargetFromStatus(
            statusWithEnvironments([
              productionEnvironment(),
              productionEnvironment({ id: 'second-production-environment-id' }),
            ])
          ),
      },
      {
        expected: /exactly one control-api service/i,
        run: () =>
          resolveProductionTargetFromStatus(
            statusWithEnvironments([productionEnvironment({ services: [] })])
          ),
      },
      {
        expected: /production environment ID is missing/i,
        run: () =>
          resolveProductionTargetFromStatus(
            statusWithEnvironments([productionEnvironment({ id: undefined })])
          ),
      },
      {
        expected: /linked project ID is missing/i,
        run: () => resolveProductionTargetFromStatus({ ...status, id: undefined }),
      },
      {
        expected: /control-api service ID is missing/i,
        run: () =>
          resolveProductionTargetFromStatus(
            statusWithEnvironments([
              productionEnvironment({ services: [controlApiService({ serviceId: undefined })] }),
            ])
          ),
      },
      {
        expected: /GraphQL errors/i,
        run: () =>
          resolvePromotedProductionImage(
            sourceSnapshot({ graphqlErrors: [{ message: 'the environment is not visible' }] })
          ),
      },
      {
        expected: /image source/i,
        run: () =>
          resolvePromotedProductionImage(sourceSnapshot({ repo: 'adea-ai/control-plane' })),
      },
      {
        expected: /immutable production image/i,
        run: () =>
          resolvePromotedProductionImage(
            sourceSnapshot({ image: 'ghcr.io/adea-ai/control-plane-control-api:latest' })
          ),
      },
      {
        expected: /sole active successful deployment/i,
        run: () => resolvePromotedProductionImage(sourceSnapshot({ deploymentStopped: true })),
      },
      {
        expected: /sole active successful deployment/i,
        run: () => resolvePromotedProductionImage(sourceSnapshot({ status: 'ERROR' })),
      },
      {
        expected: /CONTROL_PLANE_PRODUCTION_IMAGE/i,
        run: () =>
          resolveApplicationSource({
            production: true,
            productionImage: `ghcr.io/adea-ai/other-service@${digest}`,
          }),
      },
    ]

    for (const { expected, run } of cases) {
      const error = refusalFrom(run)

      assert.match(error.message, expected)
      assert.match(error.message, /\.$/)
    }
  })
})
