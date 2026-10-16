import 'reflect-metadata'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { VersioningType } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify/adapters/fastify-adapter.js'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { ModelReadinessReasonSchema } from '@control-plane/model-gateway'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'
import { NormalizedExceptionFilter } from '../http/errors.ts'
import { PiDurableLeadModule } from './pi-durable-lead.module.ts'
import { PiDurableLeadError } from './pi-durable-lead.service.ts'

const at = '2026-10-08T09:00:00.000Z'
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const principalId = 'svc_agent-hq'
const workspaceId = id('wsp')
const hash = (value) => createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')

async function open(service) {
  const claims = {
    audience: 'control-plane',
    credentialId: 'credential-local-test',
    credentialKind: 'service',
    issuedAt: at,
    expiresAt: '2026-10-08T10:00:00.000Z',
    issuer: 'https://test.invalid',
    keyId: 'test-key',
    principalId,
    workspaceIds: [workspaceId],
    projectIds: [],
    scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
  }
  const fastify = new FastifyAdapter({ logger: false })
  const app = await NestFactory.create(
    PiDurableLeadModule.register({
      service,
      serviceAuthenticator: new PolicyServiceAuthenticator({
        audience: 'control-plane',
        issuer: claims.issuer,
        now: () => new Date(at),
        logger: { write() {} },
        verifier: { verify: async () => claims },
        revocationChecker: { isRevoked: async () => false },
      }),
    }),
    fastify,
    { logger: false }
  )
  app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: '1' })
  app.useGlobalFilters(new NormalizedExceptionFilter())
  await app.init()
  await fastify.getInstance().ready()
  return app
}
const body = (operation, payload) => ({
  caller: { servicePrincipalId: principalId },
  contractVersion: { major: 1, minor: 0 },
  requestId: id('req'),
  workspaceId,
  correlation: { traceId: id('trc') },
  commandId: id('cmd'),
  idempotencyKey: 'transport-command:one',
  payloadHash: hash(payload),
  operation,
  issuedAt: at,
  payload,
})

test('every non-READY readiness reason reaches the caller as a bounded 409 on prepare and dispatch', async () => {
  const reasons = ModelReadinessReasonSchema.options.filter(
    (reason) => reason !== 'READY' && reason !== 'READINESS_UNAVAILABLE'
  )
  let next
  const app = await open({
    prepare: async () => {
      throw next
    },
    dispatch: async () => {
      throw next
    },
  })
  try {
    for (const route of ['prepare', 'dispatch'])
      for (const reasonCode of reasons) {
        next = new PiDurableLeadError('PI_LEAD_MODEL_NOT_READY', reasonCode)
        const response = await app.inject({
          method: 'POST',
          url: `/v3/pi-durable/lead-dispatches/${route}`,
          payload: body(`pi-durable.lead.${route}`, {}),
          headers: { authorization: 'Bearer local-http-test-token' },
        })
        expect(response.statusCode).toBe(409)
        const { error } = response.json()
        expect(error).toMatchObject({
          code: 'PI_LEAD_MODEL_NOT_READY',
          class: 'conflict',
          retryable: false,
          details: { reasonCode },
        })
        expect(Object.keys(error.details)).toEqual(['reasonCode'])
      }
  } finally {
    await app.close()
  }
})

test('an unreadable authority is a retryable 503 with the same code, and other failures are unchanged', async () => {
  let next
  const app = await open({
    prepare: async () => {
      throw next
    },
  })
  const prepare = () =>
    app.inject({
      method: 'POST',
      url: '/v3/pi-durable/lead-dispatches/prepare',
      payload: body('pi-durable.lead.prepare', {}),
      headers: { authorization: 'Bearer local-http-test-token' },
    })
  try {
    next = new PiDurableLeadError('PI_LEAD_MODEL_NOT_READY', 'READINESS_UNAVAILABLE')
    let response = await prepare()
    expect(response.statusCode).toBe(503)
    expect(response.json().error).toMatchObject({
      code: 'PI_LEAD_MODEL_NOT_READY',
      class: 'runtime_unavailable',
      retryable: true,
      details: { reasonCode: 'READINESS_UNAVAILABLE' },
    })
    next = new PiDurableLeadError('PI_LEAD_FUNDING_CONFIRMATION_STALE')
    response = await prepare()
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('PI_LEAD_FUNDING_CONFIRMATION_STALE')
    expect(response.json().error.details).toBeUndefined()
    next = new Error('provider said: sk-secret-value')
    response = await prepare()
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('PI_LEAD_UNAVAILABLE')
    expect(response.body).not.toContain('sk-secret-value')
  } finally {
    await app.close()
  }
})
