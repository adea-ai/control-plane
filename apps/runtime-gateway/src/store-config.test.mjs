import { expect, test } from 'bun:test'
import { runtimeGatewayStoreConfigFromEnvironment } from './composition.ts'

test('the gateway retains pooled CRUD credentials and configures direct application notifications', () => {
  const pooled =
    'postgres://app:private-password@ep-example-pooler.c-5.us-east-2.aws.neon.tech/control_plane'
  const direct = pooled.replace('-pooler.', '.')
  expect(
    runtimeGatewayStoreConfigFromEnvironment({
      RUNTIME_GATEWAY_STORE_BACKEND: 'postgres',
      DATABASE_URL: pooled,
      DATABASE_URL_UNPOOLED: direct,
    })
  ).toEqual({
    backend: 'postgres',
    credentials: { role: 'application', url: pooled },
    notificationUrl: direct,
  })
  expect(() =>
    runtimeGatewayStoreConfigFromEnvironment({
      RUNTIME_GATEWAY_STORE_BACKEND: 'postgres',
      DATABASE_URL: pooled,
    })
  ).toThrow()
})
