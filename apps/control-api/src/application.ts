import helmet from '@fastify/helmet'
import { managedCloudOperationalPolicy } from '@control-plane/config'
import { ValidationPipe, VersioningType, type VersioningOptions } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger'
import { createAppModule, type AppModuleOptions } from './app.module.js'
import { NormalizedExceptionFilter, validationException } from './http/errors.js'
import { attachRequestContext, requestIdFromHeaders } from './http/request-context.js'
import { RequestLoggingInterceptor } from './http/request-logging.interceptor.js'

const versioning: VersioningOptions = {
  defaultVersion: '1',
  prefix: 'v',
  type: VersioningType.URI,
}

export async function createControlApiApplication(
  options: AppModuleOptions
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: managedCloudOperationalPolicy.payload.gatewayFrameBytes,
    genReqId: requestIdFromHeaders,
    logger: false,
    trustProxy: false,
  })
  const fastify = adapter.getInstance()
  fastify.addHook('onRequest', attachRequestContext)
  await fastify.register(helmet)
  if (options.componentManifest !== undefined) {
    fastify.get('/v1/components', async (_request, response) => {
      response.header('cache-control', 'no-store')
      const ready = await Promise.resolve()
        .then(
          async () =>
            options.readiness().status === 'ready' &&
            (await options.dependencyReadiness?.()) === true
        )
        .catch(() => false)
      response.status(ready ? 200 : 503)
      return { schemaVersion: 1, ready }
    })
  }
  const application = await NestFactory.create<NestFastifyApplication>(
    createAppModule(options),
    adapter,
    { logger: false }
  )
  application.enableVersioning(versioning)
  application.useGlobalPipes(
    new ValidationPipe({
      exceptionFactory: validationException,
      forbidNonWhitelisted: true,
      stopAtFirstError: false,
      transform: true,
      validationError: { target: false, value: false },
      whitelist: true,
    })
  )
  application.useGlobalFilters(new NormalizedExceptionFilter())
  application.useGlobalInterceptors(application.get(RequestLoggingInterceptor))
  await application.init()
  await fastify.ready()
  return application
}

export function createOpenApiDocument(application: NestFastifyApplication): OpenAPIObject {
  const configuration = new DocumentBuilder()
    .setTitle('Control Plane API')
    .setDescription('Versioned service and public Control Plane HTTP contracts')
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'service-bearer')
    .build()
  return SwaggerModule.createDocument(application, configuration)
}
