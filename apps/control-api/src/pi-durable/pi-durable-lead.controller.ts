import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  PI_DURABLE_LEAD_SERVICE,
  PiDurableLeadError,
  type PiDurableLeadService,
} from './pi-durable-lead.service.js'

@ApiTags('pi-durable')
@Controller({ path: 'pi-durable/lead-dispatches', version: '3' })
export class PiDurableLeadController {
  constructor(@Inject(PI_DURABLE_LEAD_SERVICE) private readonly service: PiDurableLeadService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('execution:read')
  @ApiOperation({
    summary: 'Recover a retained dispatch receipt by canonical intent without inference',
  })
  @ApiOkResponse({ description: 'Existing dispatch metadata or no receipt; no runtime started' })
  lookup(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.#invoke('lookup', input, request)
  }

  @Post('prepare')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('execution:accept')
  @ApiOperation({
    summary: 'Prepare canonical lead admission and funding disclosure before inference',
  })
  @ApiOkResponse({ description: 'Canonical payer confirmation; no runtime started' })
  prepare(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.#invoke('prepare', input, request)
  }

  @Post('dispatch')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireServiceAuthentication('execution:accept')
  @ApiOperation({ summary: 'Dispatch a canonical admitted lead intent through Pi Durable' })
  @ApiAcceptedResponse({ description: 'Opaque persistent dispatch receipt' })
  dispatch(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.#invoke('dispatch', input, request)
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('execution:read')
  @ApiOperation({ summary: 'Read the authorized stored lead dispatch status' })
  @ApiOkResponse({ description: 'Canonical runtime session and execution status' })
  status(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.#invoke('status', input, request)
  }

  @Post('progress')
  @HttpCode(HttpStatus.OK)
  @RequireServiceAuthentication('execution:read')
  @ApiOperation({ summary: 'Replay bounded authorized lead progress after a committed cursor' })
  @ApiOkResponse({ description: 'Persistent progress events and next sequence' })
  progress(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.#invoke('progress', input, request)
  }

  @Post('cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireServiceAuthentication('execution:cancel')
  @ApiOperation({ summary: 'Request cancellation using stored lead dispatch authority' })
  @ApiAcceptedResponse({ description: 'Durable cancellation status' })
  cancel(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.#invoke('cancel', input, request)
  }

  async #invoke(operation: keyof PiDurableLeadService, input: unknown, request: FastifyRequest) {
    if (!request.servicePrincipal)
      throw new ForbiddenException({
        code: 'PI_LEAD_SCOPE_REJECTED',
        message: 'Lead dispatch authority was rejected',
      })
    try {
      return await this.service[operation](input, request.servicePrincipal)
    } catch (error) {
      const code = error instanceof PiDurableLeadError ? error.code : 'PI_LEAD_UNAVAILABLE'
      const response = { code, message: 'Lead dispatch request could not be completed' }
      if (code === 'PI_LEAD_INVALID') throw new BadRequestException(response)
      if (code === 'PI_LEAD_SCOPE_REJECTED') throw new ForbiddenException(response)
      if (code === 'PI_LEAD_MISSING') throw new NotFoundException(response)
      if (
        code.endsWith('_CONFLICT') ||
        code === 'PI_LEAD_DEADLINE_EXPIRED' ||
        code === 'PI_LEAD_PREPARATION_REQUIRED' ||
        code === 'PI_LEAD_FUNDING_CONFIRMATION_STALE'
      )
        throw new ConflictException(response)
      throw new ServiceUnavailableException(response)
    }
  }
}
