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
  ExecutionCancellationCommandSchema,
  ExecutionCancellationCommandResultSchema,
  type ExecutionCancellationCommandResult,
} from '@control-plane/contracts'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'

export const EXECUTION_CANCELLATION_SERVICE = Symbol('EXECUTION_CANCELLATION_SERVICE')
export interface ExecutionCancellationService {
  cancel(
    input: unknown,
    authenticatedPrincipalId: string
  ): Promise<ExecutionCancellationCommandResult>
}
export class UnavailableExecutionCancellationService implements ExecutionCancellationService {
  async cancel(): Promise<ExecutionCancellationCommandResult> {
    throw new Error('EXECUTION_CANCELLATION_NOT_CONFIGURED')
  }
}
@ApiTags('executions')
@Controller({ path: 'executions', version: '1' })
@RequireServiceAuthentication('execution:cancel')
export class ExecutionCancellationController {
  constructor(
    @Inject(EXECUTION_CANCELLATION_SERVICE) private readonly service: ExecutionCancellationService
  ) {}

  @Post('cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Durably request cancellation of an authorized execution' })
  @ApiAcceptedResponse({
    description: 'Signal acceptance only; not native cancellation confirmation',
  })
  async cancel(@Body() input: unknown, @Req() request: FastifyRequest) {
    const parsed = ExecutionCancellationCommandSchema.safeParse(input)
    if (!parsed.success)
      throw new BadRequestException({
        code: 'EXECUTION_CANCELLATION_INVALID',
        message: 'Invalid cancellation command',
      })
    try {
      return ExecutionCancellationCommandResultSchema.parse(
        await this.service.cancel(parsed.data, request.servicePrincipal?.principalId ?? '')
      )
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      if (
        code === 'EXECUTION_CANCELLATION_CALLER_MISMATCH' ||
        code === 'EXECUTION_CANCELLATION_SCOPE_REJECTED'
      )
        throw new ForbiddenException({ code, message: 'Execution cancellation is forbidden' })
      if (
        code === 'EXECUTION_CANCELLATION_PAYLOAD_CONFLICT' ||
        code === 'EXECUTION_CANCELLATION_EXECUTION_INACTIVE'
      )
        throw new ConflictException({ code, message: 'Cancellation conflicts with current state' })
      throw new ServiceUnavailableException({
        code: 'EXECUTION_CANCELLATION_UNCONFIRMED',
        message: 'Cancellation acceptance is unavailable',
      })
    }
  }
}
