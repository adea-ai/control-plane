import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  CREDENTIAL_ADMINISTRATION_SERVICE,
  type CredentialAdministrationService,
} from './credential-administration.service.js'

/**
 * Workspace connector credentials. Mutations require `credential:write`, reads require
 * `credential:read`; the envelope workspace is the only scope. Secret values are write-only.
 */
@ApiTags('credentials')
@Controller({ path: 'credentials', version: '1' })
export class CredentialAdministrationController {
  constructor(
    @Inject(CREDENTIAL_ADMINISTRATION_SERVICE)
    private readonly service: CredentialAdministrationService
  ) {}

  @Post('create')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:write')
  @ApiOperation({ summary: 'Store a workspace connector secret once and return its metadata' })
  @ApiOkResponse({ description: 'Credential metadata; the secret is never returned' })
  create(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.create(input, request.servicePrincipal?.principalId ?? '')
  }

  @Post('rotate')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:write')
  @ApiOperation({ summary: 'Store a new secret revision for an existing credential' })
  @ApiOkResponse({ description: 'Credential metadata at the new revision' })
  rotate(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.rotate(input, request.servicePrincipal?.principalId ?? '')
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:write')
  @ApiOperation({ summary: 'Revoke a credential, its secret revisions and outstanding leases' })
  @ApiOkResponse({ description: 'Revoked credential metadata' })
  revoke(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.revoke(input, request.servicePrincipal?.principalId ?? '')
  }

  @Post('get')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:read')
  @ApiOperation({ summary: 'Read one workspace credential metadata record' })
  @ApiOkResponse({ description: 'Credential metadata without secret material' })
  get(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.get(input, request.servicePrincipal?.principalId ?? '')
  }

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:read')
  @ApiOperation({ summary: 'List workspace credential metadata' })
  @ApiOkResponse({ description: 'A page of credential metadata without secret material' })
  list(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.list(input, request.servicePrincipal?.principalId ?? '')
  }
}
