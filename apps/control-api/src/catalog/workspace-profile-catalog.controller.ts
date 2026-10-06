import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { WorkspaceCatalogScopes } from '@control-plane/contracts'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  WORKSPACE_CATALOG_SERVICE,
  type WorkspaceCatalogService,
} from './workspace-catalog.service.js'

const principal = (request: FastifyRequest) => request.servicePrincipal?.principalId ?? ''

@ApiTags('catalog')
@Controller({ path: 'catalog/profiles', version: '1' })
export class WorkspaceAgentProfileCatalogController {
  constructor(
    @Inject(WORKSPACE_CATALOG_SERVICE) private readonly service: WorkspaceCatalogService
  ) {}

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.read)
  @ApiOperation({ summary: 'List workspace-owned and system AgentProfiles visible to it' })
  @ApiOkResponse({ description: 'One page of AgentProfile records with their latest version' })
  list(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.listProfiles(input, principal(request))
  }

  @Post('get')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.read)
  @ApiOperation({ summary: 'Get a visible AgentProfile, its versions and one exact version' })
  @ApiOkResponse({ description: 'Profile record, version summaries and selected definition' })
  get(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.getProfile(input, principal(request))
  }

  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.publish)
  @ApiOperation({ summary: 'Publish an immutable AgentProfile version owned by the workspace' })
  @ApiOkResponse({ description: 'Published profile version or original command receipt' })
  publish(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.publishProfile(input, principal(request))
  }

  @Post('deprecate')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.manage)
  @ApiOperation({ summary: 'Deprecate one workspace profile version or every published one' })
  @ApiOkResponse({ description: 'Changed profile versions or original command receipt' })
  deprecate(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.deprecateProfile(input, principal(request))
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.manage)
  @ApiOperation({ summary: 'Revoke one workspace profile version or every resolvable one' })
  @ApiOkResponse({ description: 'Changed profile versions or original command receipt' })
  revoke(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.revokeProfile(input, principal(request))
  }
}
