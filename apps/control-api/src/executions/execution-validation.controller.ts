import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  EXECUTION_VALIDATION_SERVICE,
  type ExecutionValidationService,
} from './execution-validation.service.js'

@ApiTags('executions')
@Controller({ path: 'executions', version: '1' })
@RequireServiceAuthentication('execution:validate')
export class ExecutionValidationController {
  constructor(
    @Inject(EXECUTION_VALIDATION_SERVICE)
    private readonly service: ExecutionValidationService
  ) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate and persist an immutable execution plan' })
  @ApiOkResponse({ description: 'Persisted execution plan reference' })
  validate(@Body() envelope: unknown, @Req() request: FastifyRequest) {
    return this.service.validate(envelope, request.servicePrincipal?.principalId ?? '')
  }
}
