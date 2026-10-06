import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  PROJECT_STATE_INITIALIZATION_SERVICE,
  type ProjectStateInitializationService,
} from './project-state-initialization.service.js'

@ApiTags('project state')
@Controller({ path: 'project-states', version: '1' })
export class ProjectStateInitializationController {
  constructor(
    @Inject(PROJECT_STATE_INITIALIZATION_SERVICE)
    private readonly service: ProjectStateInitializationService
  ) {}

  @Post('initialize')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('project-state:initialize')
  @ApiOperation({ summary: "Initialize a project's empty revision-zero ProjectState" })
  @ApiOkResponse({ description: 'Revision-zero ProjectState reference or original receipt' })
  initialize(@Body() envelope: unknown, @Req() request: FastifyRequest) {
    return this.service.initialize(envelope, request.servicePrincipal?.principalId ?? '')
  }
}
