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
  AdmissionControlCommandResultSchema,
  AdmissionResumeCommandSchema,
  AdmissionStopCommandSchema,
  type AdmissionControlCommandResult,
  type AdmissionResumeCommand,
  type AdmissionStopCommand,
  type ServicePrincipal,
} from '@control-plane/contracts'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'

export const ADMISSION_CONTROL_SERVICE = Symbol('ADMISSION_CONTROL_SERVICE')

/**
 * Workspace-scoped admission stop/resume supplied by the composition. The
 * principal is the authenticated caller the guard produced — the service never
 * accepts a self-asserted actor — and the scope is the envelope workspace the
 * credential was checked against.
 */
export interface AdmissionControlService {
  stop(
    input: AdmissionStopCommand,
    principal: ServicePrincipal
  ): Promise<AdmissionControlCommandResult>
  resume(
    input: AdmissionResumeCommand,
    principal: ServicePrincipal
  ): Promise<AdmissionControlCommandResult>
}

/** A composition without a reachable admission runtime reports explicit unavailability. */
export class UnavailableAdmissionControlService implements AdmissionControlService {
  async stop(): Promise<AdmissionControlCommandResult> {
    throw new Error('ADMISSION_CONTROL_NOT_CONFIGURED')
  }
  async resume(): Promise<AdmissionControlCommandResult> {
    throw new Error('ADMISSION_CONTROL_NOT_CONFIGURED')
  }
}

function normalizeAdmissionControlError(error: unknown): never {
  const code = error instanceof Error ? error.message : ''
  if (code === 'ADMISSION_CONTROL_SCOPE_FORBIDDEN' || code === 'ADMISSION_CONTROL_ACTOR_INVALID')
    throw new ForbiddenException({ code, message: 'Admission control is forbidden' })
  if (code === 'ADMISSION_CONTROL_COMMAND_CONFLICT')
    throw new ConflictException({
      code,
      message: 'Admission control conflicts with current state',
    })
  if (code === 'ADMISSION_CONTROL_COMMAND_INVALID')
    throw new BadRequestException({ code, message: 'Invalid admission control command' })
  // Infrastructure detail (why the runtime is unavailable, corrupt records,
  // missing configuration) stays behind one bounded code.
  throw new ServiceUnavailableException({
    code: 'ADMISSION_CONTROL_UNAVAILABLE',
    message: 'Admission control is unavailable',
  })
}

@ApiTags('executions')
@Controller({ path: 'executions', version: '1' })
@RequireServiceAuthentication('execution:admission')
export class AdmissionControlController {
  constructor(
    @Inject(ADMISSION_CONTROL_SERVICE) private readonly service: AdmissionControlService
  ) {}

  @Post('admission-stop')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Audited operator stop of new workflow-job admission for a workspace' })
  @ApiAcceptedResponse({
    description: 'The command committed; duplicates and replays are successful outcomes',
  })
  async stop(@Body() input: unknown, @Req() request: FastifyRequest) {
    const parsed = AdmissionStopCommandSchema.safeParse(input)
    if (!parsed.success)
      throw new BadRequestException({
        code: 'ADMISSION_CONTROL_INVALID',
        message: 'Invalid admission control command',
      })
    try {
      return AdmissionControlCommandResultSchema.parse(
        await this.service.stop(parsed.data, this.#principal(request))
      )
    } catch (error) {
      normalizeAdmissionControlError(error)
    }
  }

  @Post('admission-resume')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Audited operator resume of new workflow-job admission for a workspace',
  })
  @ApiAcceptedResponse({
    description: 'The command committed; duplicates and replays are successful outcomes',
  })
  async resume(@Body() input: unknown, @Req() request: FastifyRequest) {
    const parsed = AdmissionResumeCommandSchema.safeParse(input)
    if (!parsed.success)
      throw new BadRequestException({
        code: 'ADMISSION_CONTROL_INVALID',
        message: 'Invalid admission control command',
      })
    try {
      return AdmissionControlCommandResultSchema.parse(
        await this.service.resume(parsed.data, this.#principal(request))
      )
    } catch (error) {
      normalizeAdmissionControlError(error)
    }
  }

  #principal(request: FastifyRequest): ServicePrincipal {
    // The guard ran before the handler; a missing principal is an
    // authentication gap, never a reason to invent caller authority.
    const principal = request.servicePrincipal
    if (principal === undefined)
      throw new ForbiddenException({
        code: 'ADMISSION_CONTROL_ACTOR_INVALID',
        message: 'Admission control is forbidden',
      })
    return principal
  }
}
