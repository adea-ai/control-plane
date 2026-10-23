import { expect, test } from 'bun:test'
import { runtimeGatewayStoreConfigFromEnvironment } from './composition.ts'

test('the gateway uses its explicit application endpoint for CRUD and notifications', () => {
  const direct =
    'postgres://control_plane_app:synthetic-test-password@postgres.railway.internal:5432/railway?sslmode=verify-full'
  const expected = {
    backend: 'postgres',
    credentials: { role: 'application', url: direct },
    notificationUrl: direct,
  }
  expect(
    runtimeGatewayStoreConfigFromEnvironment({
      RUNTIME_GATEWAY_STORE_BACKEND: 'postgres',
      DATABASE_URL: direct,
    })
  ).toEqual(expected)
  expect(
    runtimeGatewayStoreConfigFromEnvironment({
      RUNTIME_GATEWAY_STORE_BACKEND: 'postgres',
      DATABASE_URL: direct,
      DATABASE_URL_UNPOOLED: direct,
    })
  ).toEqual(expected)
  expect(() =>
    runtimeGatewayStoreConfigFromEnvironment({
      RUNTIME_GATEWAY_STORE_BACKEND: 'postgres',
      DATABASE_URL: direct,
      DATABASE_URL_UNPOOLED: direct.replace(
        'postgres.railway.internal',
        'unrelated.example.invalid'
      ),
    })
  ).toThrow()
})
