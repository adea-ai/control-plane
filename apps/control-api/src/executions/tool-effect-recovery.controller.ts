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
import {
  ReadRequestEnvelopeSchema,
  StateChangingCommandEnvelopeSchema,
} from '@control-plane/contracts'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import type { ServicePrincipal } from '@control-plane/contracts'

export const TOOL_EFFECT_RECOVERY_SERVICE = Symbol('TOOL_EFFECT_RECOVERY_SERVICE')

export interface ToolEffectRecoveryService {
  inspect(envelope: unknown, principal: ServicePrincipal): Promise<unknown>
  reconcile(envelope: unknown, principal: ServicePrincipal): Promise<unknown>
}

export class UnavailableToolEffectRecoveryService implements ToolEffectRecoveryService {
  async inspect(): Promise<never> {
    throw new Error('TOOL_EFFECT_RECOVERY_NOT_CONFIGURED')
  }

  async reconcile(): Promise<never> {
    throw new Error('TOOL_EFFECT_RECOVERY_NOT_CONFIGURED')
  }
}

@ApiTags('executions')
@Controller({ path: 'executions/tool-effects', version: '1' })
@RequireServiceAuthentication('execution:reconcile')
export class ToolEffectRecoveryController {
  constructor(
    @Inject(TOOL_EFFECT_RECOVERY_SERVICE)
    private readonly service: ToolEffectRecoveryService
  ) {}

  @Post('inspect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inspect bounded Local tool effect reconciliation evidence' })
  @ApiOkResponse({ description: 'Redacted persisted effect evidence' })
  async inspect(@Body() input: unknown, @Req() request: FastifyRequest) {
    const parsed = ReadRequestEnvelopeSchema.safeParse(input)
    if (!parsed.success || parsed.data.operation !== 'execution.tool-effect.inspect')
      throw new BadRequestException({ code: 'TOOL_EFFECT_INSPECTION_INVALID' })
    try {
      return await this.service.inspect(parsed.data, requirePrincipal(request))
    } catch (error) {
      throw mapRecoveryError(error)
    }
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Reconcile a verified Local tool effect and request continuation' })
  @ApiAcceptedResponse({ description: 'Reconciliation or recovery activity accepted' })
  async reconcile(@Body() input: unknown, @Req() request: FastifyRequest) {
    const parsed = StateChangingCommandEnvelopeSchema.safeParse(input)
    if (!parsed.success || parsed.data.operation !== 'execution.tool-effect.reconcile')
      throw new BadRequestException({ code: 'TOOL_EFFECT_RECONCILIATION_INVALID' })
    try {
      return await this.service.reconcile(parsed.data, requirePrincipal(request))
    } catch (error) {
      throw mapRecoveryError(error)
    }
  }
}

function requirePrincipal(request: FastifyRequest): ServicePrincipal {
  if (!request.servicePrincipal) throw new ForbiddenException({ code: 'SERVICE_PRINCIPAL_MISSING' })
  return request.servicePrincipal
}

function mapRecoveryError(error: unknown): Error {
  const code = error instanceof Error ? error.message : ''
  if (code.endsWith('_INVALID')) return new BadRequestException({ code })
  if (code.endsWith('_MISSING')) return new NotFoundException({ code })
  if (code.endsWith('_SCOPE_REJECTED') || code.endsWith('_AUTHORITY_MISMATCH'))
    return new ForbiddenException({ code })
  if (code.endsWith('_CONFLICT') || code.endsWith('_STALE_REVISION'))
    return new ConflictException({ code })
  return new ServiceUnavailableException({
    code: code.startsWith('TOOL_EFFECT_') ? code : 'TOOL_EFFECT_RECOVERY_UNAVAILABLE',
    message: 'Tool effect reconciliation is unavailable',
  })
}
