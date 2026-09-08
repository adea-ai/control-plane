import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ApiAcceptedResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  InteractionResponseCommandSchema,
  InteractionResponseCommandResultSchema,
  type InteractionResponseCommandResult,
} from '@control-plane/contracts'
import { InteractionError } from '@control-plane/domain'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'

export const INTERACTION_COMMAND_SERVICE = Symbol('INTERACTION_COMMAND_SERVICE')
export interface InteractionCommandService {
  respond(
    input: unknown,
    authenticatedPrincipalId: string
  ): Promise<InteractionResponseCommandResult>
}
export class UnavailableInteractionCommandService implements InteractionCommandService {
  async respond(): Promise<InteractionResponseCommandResult> {
    throw new Error('INTERACTION_COMMAND_NOT_CONFIGURED')
  }
}

@ApiTags('executions')
@Controller({ path: 'interactions', version: '1' })
@RequireServiceAuthentication('interaction:respond')
export class InteractionCommandController {
  constructor(
    @Inject(INTERACTION_COMMAND_SERVICE) private readonly service: InteractionCommandService
  ) {}

  @Post('respond')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Record an authorized interaction response and durably signal its workflow',
  })
  @ApiAcceptedResponse({ description: 'Signal acceptance only; not execution completion' })
  async respond(@Body() input: unknown, @Req() request: FastifyRequest) {
    const parsed = InteractionResponseCommandSchema.safeParse(input)
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INTERACTION_COMMAND_INVALID',
        message: 'Invalid interaction command',
      })
    try {
      return InteractionResponseCommandResultSchema.parse(
        await this.service.respond(parsed.data, request.servicePrincipal?.principalId ?? '')
      )
    } catch (error) {
      if (error instanceof InteractionError) {
        if (error.code === 'UNAUTHORIZED_INTERACTION_RESPONSE')
          throw new ForbiddenException({
            code: error.code,
            message: 'Interaction response is forbidden',
          })
        throw new ConflictException({
          code: error.code,
          message: 'Interaction response conflicts with current state',
        })
      }
      const code = error instanceof Error ? error.message : ''
      if (
        code === 'INTERACTION_COMMAND_CALLER_MISMATCH' ||
        code === 'INTERACTION_DELIVERY_SCOPE_REJECTED'
      )
        throw new ForbiddenException({ code, message: 'Interaction response is forbidden' })
      if (
        code === 'INTERACTION_COMMAND_PAYLOAD_CONFLICT' ||
        code === 'INTERACTION_DELIVERY_EXECUTION_INACTIVE'
      )
        throw new ConflictException({
          code,
          message: 'Interaction response conflicts with current state',
        })
      throw new ServiceUnavailableException({
        code: 'INTERACTION_COMMAND_UNCONFIRMED',
        message: 'Interaction command acceptance is unavailable',
      })
    }
  }
}
