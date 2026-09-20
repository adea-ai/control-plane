import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  assertMutationSucceeded,
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
    const rolledBack = new Set()
    let updateCount = 0
    const railway = {
      async getSource(target) {
        return sources.get(target)
      },
      async listDeployments(target) {
        const prior = deployments.get(target)[0]
        const source = sources.get(target)
        if (
          source.image?.includes(manifests.find((item) => item.target === target).digest) &&
          !rolledBack.has(target)
        ) {
          const manifest = manifests.find((item) => item.target === target)
          return [
            deployment({
              id: `${target}-promoted`,
              canRollback: false,
              meta: { image: source.image, imageDigest: manifest.digest },
            }),
            { ...prior, deploymentStopped: true },
          ]
        }
        return [prior]
      },
      async updateSource(target, source) {
        calls.push(['update', target, source])
        sources.set(target, source)
        updateCount += 1
        if (updateCount === 2) throw new Error('response lost after commit')
      },
      async rollbackDeployment(target, id) {
        calls.push(['rollback', target, id])
        rolledBack.add(target)
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
        verifyRetries: 1,
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
    assert(
      calls.some(([operation, target]) => operation === 'update' && target === 'workflow-worker')
    )
  })

  test('returns a first activation to verified standby when no prior deployment exists', async () => {
    const promotedImage = `${manifests[0].image}@${manifests[0].digest}`
    const calls = []
    const sources = new Map([
      ['control-api', { image: null, repo: null }],
      ['workflow-worker', { image: null, repo: null }],
    ])
    const removed = new Set()
    const railway = {
      async getSource(target) {
        return sources.get(target)
      },
      async listDeployments(target) {
        if (
          target === 'control-api' &&
          sources.get(target).image === promotedImage &&
          !removed.has('new-control')
        ) {
          return [
            deployment({
              id: 'new-control',
              canRollback: false,
              meta: { image: promotedImage, imageDigest: manifests[0].digest },
            }),
          ]
        }
        return []
      },
      async updateSource(target, source) {
        calls.push(['update', target, source])
        sources.set(target, source)
        if (target === 'workflow-worker' && source.image !== null) {
          throw new Error('second service failed')
        }
      },
      async rollbackDeployment(target, id) {
        calls.push(['rollback', target, id])
      },
      async removeDeployment(target, id) {
        calls.push(['remove', target, id])
        removed.add(id)
      },
    }

    await assert.rejects(
      promoteRailwayImages({
        manifests,
        railway,
        pullImage: async () => {},
        sleep: async () => {},
        verifyRetries: 1,
      }),
      /second service failed/
    )

    assert(
      calls.some(
        ([operation, target, id]) =>
          operation === 'remove' && target === 'control-api' && id === 'new-control'
      )
    )
    assert(!calls.some(([operation]) => operation === 'rollback'))
  })
})
