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
import { ReadRequestEnvelopeSchema } from '@control-plane/contracts'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  PiDurableCurrentToolAuthorityError,
  type CurrentPiDurableToolRequest,
  type PiDurableCurrentToolAuthority,
  type PiDurableToolAuthorityBoundary,
} from './current-tool-authority.js'

/**
 * Injection token for the host-owned canonical current-authority port. The
 * production composition supplies the actual `createPiDurableCurrentToolAuthority`
 * instance; absent, the route fails closed through `UnavailablePiDurableCurrentToolAuthority`.
 */
export const PI_DURABLE_MANAGEMENT_CURRENT_AUTHORITY = Symbol(
  'PI_DURABLE_MANAGEMENT_CURRENT_AUTHORITY'
)

export const PI_DURABLE_MANAGEMENT_CURRENT_OPERATION = 'pi-durable.management-current.assert'

const boundaries = new Set<PiDurableToolAuthorityBoundary>([
  'admission',
  'approval',
  'effect',
  'publication',
])

export type PiDurableManagementCurrentAssertion = Readonly<{
  request: CurrentPiDurableToolRequest
  boundary: PiDurableToolAuthorityBoundary
}>

/**
 * Strict body decoder for the narrow assertion envelope. Unknown keys are
 * refused; the canonical request itself stays opaque to this adapter and is
 * validated by the canonical authority helper.
 */
export function parsePiDurableManagementCurrentAssertion(
  value: unknown
): PiDurableManagementCurrentAssertion {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('PI_MANAGEMENT_CURRENT_REQUEST_INVALID')
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('request') || !keys.includes('boundary'))
    throw new Error('PI_MANAGEMENT_CURRENT_REQUEST_INVALID')
  const { request, boundary } = value as { boundary: unknown; request: unknown }
  if (request === null || typeof request !== 'object' || Array.isArray(request))
    throw new Error('PI_MANAGEMENT_CURRENT_REQUEST_INVALID')
  if (typeof boundary !== 'string' || !boundaries.has(boundary as PiDurableToolAuthorityBoundary))
    throw new Error('PI_MANAGEMENT_CURRENT_REQUEST_INVALID')
  return {
    boundary: boundary as PiDurableToolAuthorityBoundary,
    request: request as CurrentPiDurableToolRequest,
  }
}

/** Fail-closed default: no canonical authority is installed. */
export class UnavailablePiDurableCurrentToolAuthority implements PiDurableCurrentToolAuthority {
  async assertCurrent(): Promise<void> {
    throw new PiDurableCurrentToolAuthorityError()
  }
}

/**
 * Repeatable current-authority assertion for an exact retained durable tool
 * call. The route returns `void`/an assert-only envelope, never a truthy grant,
 * and never consumes an approval: the single-owner durable effect claim lives
 * on the Adea side.
 */
@ApiTags('pi-durable-management-current')
@Controller({ path: 'pi-durable/management-current', version: '1' })
export class PiDurableManagementCurrentController {
  constructor(
    @Inject(PI_DURABLE_MANAGEMENT_CURRENT_AUTHORITY)
    private readonly authority: PiDurableCurrentToolAuthority
  ) {}

  @Post('assert')
  @HttpCode(200)
  @RequireServiceAuthentication('execution:read')
  @ApiOperation({
    summary: 'Assert current authority for an exact retained durable tool call (repeatable)',
  })
  @ApiOkResponse({
    description: 'Current authority asserted; no execution grant and no approval consumption',
  })
  async assert(@Body() input: unknown, @Req() request: FastifyRequest) {
    try {
      if (!request.servicePrincipal) throw new Error('PI_MANAGEMENT_CURRENT_UNAVAILABLE')
      const envelope = ReadRequestEnvelopeSchema.parse(input)
      if (envelope.operation !== PI_DURABLE_MANAGEMENT_CURRENT_OPERATION)
        throw new Error('PI_MANAGEMENT_CURRENT_REQUEST_INVALID')
      const assertion = parsePiDurableManagementCurrentAssertion(envelope.parameters)
      await this.authority.assertCurrent(assertion.request, assertion.boundary)
      return { asserted: true as const }
    } catch {
      throw new ServiceUnavailableException({
        code: 'PI_MANAGEMENT_CURRENT_UNAVAILABLE',
        message: 'Management current authority is unavailable',
      })
    }
  }
}
