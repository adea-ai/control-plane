import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  GRAPH_ADMINISTRATION_SERVICE,
  type GraphAdministrationService,
} from './graph-administration.service.js'

@ApiTags('graphs')
@Controller({ path: 'graphs', version: '1' })
export class GraphAdministrationController {
  constructor(
    @Inject(GRAPH_ADMINISTRATION_SERVICE) private readonly service: GraphAdministrationService
  ) {}

  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('graph:publish')
  @ApiOperation({ summary: 'Publish a workspace-owned immutable graph version' })
  @ApiOkResponse({ description: 'Published graph snapshot or original command receipt' })
  publish(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.publish(input, request.servicePrincipal?.principalId ?? '')
  }

  @Post('deprecate')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('graph:manage')
  @ApiOperation({ summary: 'Deprecate a graph version using its expected revision' })
  @ApiOkResponse({ description: 'Changed graph snapshot or original command receipt' })
  deprecate(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.deprecate(input, request.servicePrincipal?.principalId ?? '')
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('graph:manage')
  @ApiOperation({ summary: 'Revoke a graph version using its expected revision' })
  @ApiOkResponse({ description: 'Changed graph snapshot or original command receipt' })
  revoke(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.revoke(input, request.servicePrincipal?.principalId ?? '')
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('graph:resolve')
  @ApiOperation({ summary: 'Inspect an exact workspace-owned graph version' })
  @ApiOkResponse({ description: 'Retained immutable graph content and current lifecycle' })
  resolve(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.resolve(input, request.servicePrincipal?.principalId ?? '')
  }
}
