import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  assertMutationSucceeded,
  createRailwayClient,
  promoteRailwayImages,
} from '../scripts/promote-railway-images.mjs'

const manifests = [
  {
    target: 'control-api',
    image: 'ghcr.io/adea-ai/control-plane-control-api',
    digest: `sha256:${'a'.repeat(64)}`,
    sourceSha: 'source-sha',
  },
  {
    target: 'workflow-worker',
    image: 'ghcr.io/adea-ai/control-plane-workflow-worker',
    digest: `sha256:${'b'.repeat(64)}`,
    sourceSha: 'source-sha',
  },
]

function deployment(overrides = {}) {
  return {
    id: 'deployment-prior',
    status: 'SUCCESS',
    canRollback: true,
    deploymentStopped: false,
    meta: {
      image: 'ghcr.io/adea-ai/control-plane-control-api@sha256:prior',
      imageDigest: 'sha256:prior',
    },
    ...overrides,
  }
}

describe('container promotion', () => {
  test('rejects GraphQL mutations that return false', () => {
    assert.throws(
      () => assertMutationSucceeded({ serviceInstanceUpdate: false }, 'serviceInstanceUpdate'),
      /serviceInstanceUpdate returned false/
    )
    assert.doesNotThrow(() =>
      assertMutationSucceeded({ serviceInstanceUpdate: true }, 'serviceInstanceUpdate')
    )
  })

  test('connects and disconnects the service-level Railway source', async () => {
    const requests = []
    const client = createRailwayClient({
      token: 'project-token',
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body)
        requests.push(request)
        if (request.query.includes('serviceConnect')) {
          return Response.json({ data: { serviceConnect: { id: request.variables.id } } })
        }
        if (request.query.includes('serviceDisconnect')) {
          return Response.json({ data: { serviceDisconnect: { id: request.variables.id } } })
        }
        throw new Error('unexpected request')
      },
    })

    await client.updateSource('control-api', {
      image: `ghcr.io/adea-ai/control-plane-control-api@sha256:${'a'.repeat(64)}`,
      repo: null,
    })
    await client.updateSource('control-api', { image: null, repo: null })

    assert.match(requests[0].query, /serviceConnect/)
    assert.deepEqual(requests[0].variables.input, {
      image: `ghcr.io/adea-ai/control-plane-control-api@sha256:${'a'.repeat(64)}`,
      repo: null,
    })
    assert.match(requests[1].query, /serviceDisconnect/)
  })

  test('waits for the updated source before triggering deployment', async () => {
    const sources = new Map(
      manifests.map(({ target }) => [target, { image: `${target}@sha256:prior`, repo: null }])
    )
    const pendingSources = new Map()
    const deployments = new Map(
      manifests.map(({ target }) => [target, [deployment({ id: `${target}-prior` })]])
    )
    const sourceReads = new Map()

    const railway = {
      async getSource(target) {
        const reads = (sourceReads.get(target) ?? 0) + 1
        sourceReads.set(target, reads)
        if (reads >= 3 && pendingSources.has(target)) {
          sources.set(target, pendingSources.get(target))
          pendingSources.delete(target)
        }
        return sources.get(target)
      },
      async listDeployments(target) {
        return deployments.get(target)
      },
      async updateSource(target, source) {
        pendingSources.set(target, source)
      },
      async deploySource(target) {
        assert.equal(sourceReads.get(target), 3)
        assert.equal(pendingSources.has(target), false)
        const manifest = manifests.find((item) => item.target === target)
        deployments.set(target, [
          deployment({
            id: `${target}-promoted`,
            meta: {
              image: `${manifest.image}@${manifest.digest}`,
              imageDigest: manifest.digest,
            },
          }),
        ])
      },
      async rollbackDeployment() {},
      async removeDeployment() {},
    }

    await promoteRailwayImages({
      manifests,
      railway,
      pullImage: async () => {},
      sleep: async () => {},
      verifyRetries: 3,
    })

    assert.equal(sourceReads.get('control-api'), 3)
    assert.equal(sourceReads.get('workflow-worker'), 3)
  })

  test('restores every intended service when a later mutation is ambiguous', async () => {
    const sources = new Map([
      ['control-api', { image: 'control-api@sha256:prior', repo: null }],
      ['workflow-worker', { image: 'workflow-worker@sha256:prior', repo: null }],
    ])
    const deployments = new Map([
      [
        'control-api',
        [deployment({ id: 'control-prior', meta: { imageDigest: 'sha256:control-prior' } })],
      ],
      [
        'workflow-worker',
        [deployment({ id: 'worker-prior', meta: { imageDigest: 'sha256:worker-prior' } })],
      ],
    ])
    const calls = []
    const promoted = new Set()
    const rolledBack = new Set()
    let failNextRead = false
    let updateCount = 0
    const railway = {
      async getSource(target) {
        if (failNextRead) {
          failNextRead = false
          throw new Error('transient Railway read failure')
        }
        return sources.get(target)
      },
      async listDeployments(target) {
        const prior = deployments.get(target)[0]
        if (promoted.has(target) && !rolledBack.has(target)) {
          const manifest = manifests.find((item) => item.target === target)
          return [
            deployment({
              id: `${target}-promoted`,
              canRollback: false,
              meta: {
                image: `${manifest.image}@${manifest.digest}`,
                imageDigest: manifest.digest,
              },
            }),
            { ...prior, canRollback: true, deploymentStopped: true },
          ]
        }
        return [prior]
      },
      async updateSource(target, source) {
        calls.push(['update', target, source])
        sources.set(target, source)
        if (source.image?.includes('sha256:')) promoted.add(target)
        updateCount += 1
        if (updateCount === 2) {
          failNextRead = true
          throw new Error('response lost after commit')
        }
      },
      async deploySource(target) {
        calls.push(['deploy', target])
      },
      async rollbackDeployment(target, id) {
        calls.push(['rollback', target, id])
        rolledBack.add(target)
        throw new Error('rollback response lost after commit')
      },
      async removeDeployment(target, id) {
        calls.push(['remove', target, id])
      },
    }

    await assert.rejects(
      promoteRailwayImages({
        manifests,
        railway,
        pullImage: async () => {},
        sleep: async () => {},
        verifyRetries: 3,
      }),
      /response lost after commit/
    )

    assert.deepEqual(
      calls.filter(([operation]) => operation === 'rollback'),
      [
        ['rollback', 'workflow-worker', 'worker-prior'],
        ['rollback', 'control-api', 'control-prior'],
      ]
    )
    assert(calls.some(([operation, target]) => operation === 'update' && target === 'control-api'))
    assert(calls.some(([operation, target]) => operation === 'deploy' && target === 'control-api'))
    assert(
      calls.some(([operation, target]) => operation === 'update' && target === 'workflow-worker')
    )
  })

  test('returns a first activation to verified standby when no prior deployment exists', async () => {
    const calls = []
    const sources = new Map([
      ['control-api', { image: null, repo: null }],
      ['workflow-worker', { image: null, repo: null }],
    ])
    const activeDeployments = new Set()
    const removed = new Set()
    const railway = {
      async getSource(target) {
        return sources.get(target)
      },
      async listDeployments(target) {
        if (activeDeployments.has(target) && !removed.has(`new-${target}`)) {
          const manifest = manifests.find((item) => item.target === target)
          return [
            deployment({
              id: `new-${target}`,
              canRollback: false,
              meta: {
                image: `${manifest.image}@${manifest.digest}`,
                imageDigest: manifest.digest,
              },
            }),
          ]
        }
        return []
      },
      async updateSource(target, source) {
        calls.push(['update', target, source])
        sources.set(target, source)
        if (source.image !== null) activeDeployments.add(target)
        if (target === 'workflow-worker' && source.image !== null) {
          throw new Error('second service failed')
        }
      },
      async deploySource(target) {
        calls.push(['deploy', target])
      },
      async rollbackDeployment(target, id) {
        calls.push(['rollback', target, id])
      },
      async removeDeployment(target, id) {
        calls.push(['remove', target, id])
        removed.add(id)
        throw new Error('remove response lost after commit')
      },
    }

    await assert.rejects(
      promoteRailwayImages({
        manifests,
        railway,
        pullImage: async () => {},
        sleep: async () => {},
        verifyRetries: 3,
      }),
      /second service failed/
    )

    assert(
      calls.some(
        ([operation, target, id]) =>
          operation === 'remove' && target === 'control-api' && id === 'new-control-api'
      )
    )
    assert(!calls.some(([operation]) => operation === 'rollback'))
  })
})
