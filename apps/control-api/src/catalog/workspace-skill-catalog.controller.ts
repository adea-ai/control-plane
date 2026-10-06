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
@Controller({ path: 'catalog/skills', version: '1' })
export class WorkspaceSkillCatalogController {
  constructor(
    @Inject(WORKSPACE_CATALOG_SERVICE) private readonly service: WorkspaceCatalogService
  ) {}

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.read)
  @ApiOperation({ summary: 'List workspace-owned and system Skills visible to the workspace' })
  @ApiOkResponse({ description: 'One page of Skill records with their latest version summary' })
  list(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.listSkills(input, principal(request))
  }

  @Post('get')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.read)
  @ApiOperation({ summary: 'Get a visible Skill, its version history and one exact version' })
  @ApiOkResponse({ description: 'Skill record, version summaries and selected version content' })
  get(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.getSkill(input, principal(request))
  }

  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.publish)
  @ApiOperation({ summary: 'Publish an immutable Skill version owned by the workspace' })
  @ApiOkResponse({ description: 'Published Skill version or original command receipt' })
  publish(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.publishSkill(input, principal(request))
  }

  @Post('deprecate')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.manage)
  @ApiOperation({ summary: 'Deprecate one workspace Skill version or every published version' })
  @ApiOkResponse({ description: 'Changed Skill versions or original command receipt' })
  deprecate(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.deprecateSkill(input, principal(request))
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication(WorkspaceCatalogScopes.manage)
  @ApiOperation({ summary: 'Revoke one workspace Skill version or every resolvable version' })
  @ApiOkResponse({ description: 'Changed Skill versions or original command receipt' })
  revoke(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.revokeSkill(input, principal(request))
  }
}
