import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  RUNTIME_NODE_CREDENTIAL_REVOCATION_SERVICE,
  type RuntimeNodeCredentialRevocationService,
} from './runtime-node-credential-revocation.service.js'

/**
 * Hosted RuntimeNode credential revocation. Requires `credential:write`, the connector
 * credential scope; the envelope workspace is the only scope. Revoking a credential
 * invalidates its gateway channels; no secret material is accepted or returned.
 */
@ApiTags('runtime-node-credentials')
@Controller({ path: 'runtime-node-credentials', version: '1' })
export class RuntimeNodeCredentialRevocationController {
  constructor(
    @Inject(RUNTIME_NODE_CREDENTIAL_REVOCATION_SERVICE)
    private readonly service: RuntimeNodeCredentialRevocationService
  ) {}

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('credential:write')
  @ApiOperation({ summary: 'Revoke one RuntimeNode credential and invalidate its channels' })
  @ApiOkResponse({ description: 'Revoked RuntimeNode credential metadata' })
  revoke(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.revoke(input, request.servicePrincipal?.principalId ?? '')
  }
}
