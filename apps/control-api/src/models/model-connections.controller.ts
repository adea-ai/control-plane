import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  MODEL_CONNECTION_SERVICE,
  type ModelConnectionService,
} from './model-connections.service.js'

@ApiTags('model-connections')
@Controller({ path: 'model-connections', version: '1' })
export class ModelConnectionsController {
  constructor(@Inject(MODEL_CONNECTION_SERVICE) private readonly service: ModelConnectionService) {}
  @Post('selection/funding/get')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:read')
  @ApiOperation({
    summary: 'Read accepted model and explicit payer disclosure with current recorded authority',
  })
  @ApiOkResponse({
    description: 'Versioned ready/blocked funding view; confers no execution or spending authority',
  })
  funding(@Body() input: unknown, @Req() request: FastifyRequest) {
    if (!this.service.funding)
      throw new ServiceUnavailableException({
        code: 'MODEL_CONNECTIONS_NOT_CONFIGURED',
        message: 'Model funding is not configured',
      })
    return this.service.funding(input, request.servicePrincipal?.principalId ?? '')
  }
  @Post('create')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:write')
  @ApiOperation({
    summary: 'Bind an existing vault credential to a server-authorized provider account grant',
  })
  @ApiOkResponse({ description: 'Model connection metadata without reusable secrets' })
  create(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.create(input, request.servicePrincipal?.principalId ?? '')
  }
  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:write')
  @ApiOperation({ summary: 'Revoke a model connection and its workspace grant' })
  @ApiOkResponse({ description: 'Revoked model connection metadata' })
  revoke(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.revoke(input, request.servicePrincipal?.principalId ?? '')
  }
  @Post('list')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:read')
  @ApiOperation({ summary: 'List workspace model connections and exact target readiness' })
  @ApiOkResponse({ description: 'Opaque connection metadata and safe readiness reason codes' })
  list(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.list(input, request.servicePrincipal?.principalId ?? '')
  }
  @Post('defaults/get')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:read')
  @ApiOperation({ summary: 'Read separate workspace lead, child and direct model defaults' })
  @ApiOkResponse({ description: 'Versioned defaults without reusable secrets' })
  getDefaults(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.getDefaults(input, request.servicePrincipal?.principalId ?? '')
  }
  @Post('defaults/set')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:write')
  @ApiOperation({ summary: 'Compare and set workspace model defaults without widening grants' })
  @ApiOkResponse({ description: 'Accepted configuration revision' })
  setDefaults(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.setDefaults(input, request.servicePrincipal?.principalId ?? '')
  }
  @Post('selection/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:read')
  @ApiOperation({
    summary: 'Resolve a qualified model choice into immutable non-secret selection evidence',
  })
  @ApiOkResponse({ description: 'Selection snapshot; creates no model call or credential lease' })
  resolve(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.resolve(input, request.servicePrincipal?.principalId ?? '')
  }
}
