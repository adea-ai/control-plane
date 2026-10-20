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
  PI_CHILD_PUBLICATION_SERVICE,
  PiChildPublicationService,
} from './child-publication-current.service.js'

@ApiTags('pi-durable-publication')
@Controller({ path: 'pi-durable/child-publication', version: '1' })
export class PiChildPublicationController {
  constructor(
    @Inject(PI_CHILD_PUBLICATION_SERVICE) private readonly service: PiChildPublicationService
  ) {}
  @Post('current')
  @HttpCode(200)
  @RequireServiceAuthentication('execution:read')
  @ApiOperation({
    summary: 'Check exact retained child terminal event against current CP delivery authority',
  })
  @ApiOkResponse({
    description:
      'Exact terminal event and parent binding; no result content or artifact read grant',
  })
  async current(@Body() input: unknown, @Req() request: FastifyRequest) {
    try {
      if (!request.servicePrincipal) throw new Error('PI_CHILD_PUBLICATION_UNAVAILABLE')
      return await this.service.current(input, request.servicePrincipal)
    } catch {
      throw new ServiceUnavailableException({
        code: 'PI_CHILD_PUBLICATION_UNAVAILABLE',
        message: 'Child publication authority is unavailable',
      })
    }
  }
}
