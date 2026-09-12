import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  DurableInteractionCommandService,
  DurableExecutionCancellationService,
} from '@control-plane/domain'
import {
  DurableRemoteWorkflowRuntime,
  RuntimeDiscoveryAttemptRouter,
} from '@control-plane/workflow-worker'
import {
  HostedServerControlPlaneComposition,
  resolveHostedCompositionConfiguration,
  resolveHostedApiHost,
  resolveHostedObjectStore,
} from './index.ts'

describe('Hosted server composition', () => {
  test('maps the Restate request identity from the production environment', () => {
    const key = 'publickeyv1_w7YHemBctH5Ck2nQRQ47iBBqhNHy4FV7t2Usbye2A6f'
    expect(
      resolveHostedCompositionConfiguration({
        DATABASE_URL: 'postgresql://app:secret@postgres/control_plane',
        RESTATE_REQUEST_IDENTITY_PUBLIC_KEY: key,
      }).requestIdentityPublicKey
    ).toBe(key)
  })

  test('rejects missing or malformed Hosted signing configuration before allocating resources', () => {
    for (const requestIdentityPublicKey of [undefined, '', 'invalid', 'publickeyv1_0']) {
      expect(
        () =>
          new HostedServerControlPlaneComposition({
            dataDirectory: '/unused-hosted-test',
            databaseUrl: 'invalid-database-url',
            requestIdentityPublicKey,
          })
      ).toThrow('HOSTED_RESTATE_REQUEST_IDENTITY_REQUIRED')
    }
  })

  test('propagates the supported remote runtime activity port through the production launcher', () => {
    const contextAuthoring = {
      authority: { authorize: async () => undefined, resolveArtifact: async () => undefined },
    }
    const runtimeActivityPort = {
      dispatch: async () => ({ outcome: 'cancelled' }),
      applyInteraction: async () => ({ outcome: 'cancelled' }),
      cleanup: async () => undefined,
    }
    const configuration = resolveHostedCompositionConfiguration(
      {
        DATABASE_URL: 'postgresql://app:secret@postgres/control_plane',
        CONTROL_PLANE_DATA_DIR: '/var/lib/control-plane',
      },
      { runtimeActivityPort, contextAuthoring }
    )

    expect(configuration.runtimeActivityPort).toBe(runtimeActivityPort)
    expect(configuration.contextAuthoring).toBe(contextAuthoring)
    expect(configuration).toMatchObject({
      dataDirectory: '/var/lib/control-plane',
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
    })
  })

  test('reports PostgreSQL and separate Restate dependencies without changing core contracts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-'))
    const calls = []
    const authority = { authorize: async () => undefined, resolveArtifact: async () => undefined }
    const providerResolver = {
      resolve: async () => {
        throw new Error('UNEXPECTED_RETRIEVAL')
      },
    }
    const connection = {
      database: {},
      check: async () => calls.push('database:check'),
      close: async () => calls.push('database:close'),
    }
    const workflow = {
      profile: 'hosted-server',
      start: async () => calls.push('workflow:start'),
      health: async () => ({ ready: true, component: 'restate', version: '1.7.9' }),
      stop: async () => calls.push('workflow:stop'),
    }
    const composition = new HostedServerControlPlaneComposition({
      contextAuthoring: { authority, providerResolver },
      dataDirectory: directory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      connection,
      workflowRuntime: workflow,
      remoteControlFactory: (acceptance) => {
        expect(typeof acceptance.accept).toBe('function')
        return {
          start: async () => calls.push('relay:start'),
          stop: () => calls.push('relay:stop'),
          health: async () => ({
            ready: true,
            component: 'remote-control-relay',
            version: '1',
            details: { direction: 'outbound', listener: false },
          }),
        }
      },
      endpointFactory: {
        create: async () => ({
          run: async () => calls.push('endpoint:start'),
          shutdown: async () => calls.push('endpoint:stop'),
        }),
      },
    })
    try {
      expect(
        composition.executionValidationService.options.contextAuthoring.options.authority
      ).toBe(authority)
      expect(
        composition.executionValidationService.options.contextAuthoring.options.providerResolver
      ).toBe(providerResolver)
      await composition.start()
      expect(await composition.manifest()).toMatchObject({
        profile: 'hosted-server',
        topology: {
          externalServices: 2,
          persistence: 'postgresql',
          objectStore: 'filesystem',
          runtimeTransport: 'remote-gateway',
          remoteControl: 'outbound',
        },
      })
      expect((await composition.discovery.resolve('postgresql')).url.toString()).toBe(
        'postgresql://postgres/control_plane'
      )
      expect(composition.runtimeActivityPort).toBeInstanceOf(DurableRemoteWorkflowRuntime)
      expect(composition.interactionCommandService).toBeInstanceOf(DurableInteractionCommandService)
      expect(composition.executionCancellationService).toBeInstanceOf(
        DurableExecutionCancellationService
      )
      expect(composition.runtimeAttemptRouter).toBeInstanceOf(RuntimeDiscoveryAttemptRouter)
      expect(calls).toEqual([
        'database:check',
        'endpoint:start',
        'workflow:start',
        'relay:start',
        'database:check',
      ])
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
    expect(calls).toEqual([
      'database:check',
      'endpoint:start',
      'workflow:start',
      'relay:start',
      'database:check',
      'relay:stop',
      'workflow:stop',
      'endpoint:stop',
      'database:close',
    ])
  })

  test('keeps host publication loopback unless explicitly bound by the container profile', () => {
    expect(resolveHostedApiHost()).toBe('127.0.0.1')
    expect(resolveHostedApiHost('0.0.0.0')).toBe('0.0.0.0')
    expect(() => resolveHostedApiHost('public.example.com')).toThrow(
      'HOSTED_CONTROL_PLANE_BIND_HOST_INVALID'
    )
  })

  test('accepts an explicit S3-compatible ObjectStore without changing domain contracts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-s3-'))
    const calls = []
    const objectStore = {
      put: async () => {
        throw new Error('unused')
      },
      get: async () => {
        throw new Error('unused')
      },
      head: async () => {
        throw new Error('unused')
      },
      delete: async () => undefined,
      close: () => calls.push('object-store:close'),
    }
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory: directory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      connection: {
        database: {},
        check: async () => undefined,
        close: async () => undefined,
      },
      workflowRuntime: {
        profile: 'hosted-server',
        start: async () => undefined,
        health: async () => ({ ready: true, component: 'restate', version: '1.7.9' }),
        stop: async () => undefined,
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
      objectStore,
      objectStoreKind: 's3-compatible',
    })
    try {
      await composition.start()
      expect(await composition.manifest()).toMatchObject({
        topology: { objectStore: 's3-compatible' },
      })
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
    expect(calls).toEqual(['object-store:close'])
  })

  test('composes an explicit remote runtime activity port for server execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-runtime-'))
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory: directory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      connection: {
        database: {},
        check: async () => undefined,
        close: async () => undefined,
      },
      workflowRuntime: {
        profile: 'hosted-server',
        start: async () => undefined,
        health: async () => ({ ready: true, component: 'restate', version: '1.7.9' }),
        stop: async () => undefined,
      },
      runtimeActivityPort: {
        dispatch: async () => ({ outcome: 'cancelled' }),
        applyInteraction: async () => ({ outcome: 'cancelled' }),
        cleanup: async () => undefined,
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
    })
    try {
      await composition.start()
      expect(await composition.manifest()).toMatchObject({
        topology: { runtimeTransport: 'remote-gateway' },
      })
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails closed when S3-compatible topology is declared without an adapter', async () => {
    expect(
      () =>
        new HostedServerControlPlaneComposition({
          dataDirectory: '/tmp/control-plane-invalid-object-store',
          requestIdentityPublicKey: 'publickeyv1_w7YHemBctH5Ck2nQRQ47iBBqhNHy4FV7t2Usbye2A6f',
          databaseUrl: 'postgresql://app:secret@postgres/control_plane',
          connection: { database: {}, check: async () => undefined, close: async () => undefined },
          objectStoreKind: 's3-compatible',
        })
    ).toThrow('HOSTED_OBJECT_STORE_CONFIGURATION_INVALID')
  })

  test('loads optional S3-compatible storage only from complete HTTPS configuration', () => {
    const configured = resolveHostedObjectStore({
      HOSTED_OBJECT_STORE: 's3-compatible',
      S3_ENDPOINT: 'https://objects.example.test',
      S3_BUCKET: 'control-plane',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY_ID: 'access-key',
      S3_SECRET_ACCESS_KEY: 'secret-key',
    })
    expect(configured).toMatchObject({ objectStoreKind: 's3-compatible' })
    expect(configured.objectStore).toBeDefined()
    configured.objectStore.close()

    expect(resolveHostedObjectStore({})).toEqual({})
    expect(() =>
      resolveHostedObjectStore({
        HOSTED_OBJECT_STORE: 's3-compatible',
        S3_ENDPOINT: 'http://objects.example.test',
        S3_BUCKET: 'control-plane',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY_ID: 'access-key',
        S3_SECRET_ACCESS_KEY: 'secret-key',
      })
    ).toThrow('HOSTED_OBJECT_STORE_ENDPOINT_INVALID')
    expect(() => resolveHostedObjectStore({ HOSTED_OBJECT_STORE: 'unknown' })).toThrow(
      'HOSTED_OBJECT_STORE_KIND_INVALID'
    )
  })
})
