import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  PI_LEAD_PUBLICATION_SERVICE,
  PiLeadPublicationService,
} from './publication-current.service.js'

@ApiTags('pi-durable-publication')
@Controller({ path: 'pi-durable/lead-publication', version: '1' })
export class PiLeadPublicationController {
  constructor(
    @Inject(PI_LEAD_PUBLICATION_SERVICE) private readonly service: PiLeadPublicationService
  ) {}
  @Post('current')
  @HttpCode(200)
  @RequireServiceAuthentication('execution:read')
  @ApiOperation({
    summary: 'Check exact completed lead result against current lock-safe CP publication authority',
  })
  @ApiOkResponse({
    description:
      'Exact completed result digest and current CP delivery binding; no output or execution authority',
  })
  async current(@Body() input: unknown, @Req() request: FastifyRequest) {
    try {
      if (!request.servicePrincipal) throw new Error('PI_LEAD_PUBLICATION_UNAVAILABLE')
      return await this.service.current(input, request.servicePrincipal)
    } catch {
      throw new ServiceUnavailableException({
        code: 'PI_LEAD_PUBLICATION_UNAVAILABLE',
        message: 'Lead publication authority is unavailable',
      })
    }
  }
}
