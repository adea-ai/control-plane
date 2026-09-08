import { BadRequestException, Catch, HttpException, HttpStatus } from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import type { ValidationError } from 'class-validator'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ErrorResponseEnvelopeSchema } from '@control-plane/contracts'
import { responseMetadata } from './request-context.js'

export interface ValidationDetail {
  readonly codes: readonly string[]
  readonly field: string
}

export function validationException(errors: ValidationError[]): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    details: flattenValidationErrors(errors),
    message: 'Request validation failed',
  })
}

@Catch()
export class NormalizedExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const request = http.getRequest<FastifyRequest>()
    const reply = http.getResponse<FastifyReply>()
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : isSchemaValidationError(exception)
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.INTERNAL_SERVER_ERROR
    const error = normalizedError(exception, status)
    const meta = responseMetadata(request)
    const identity = ErrorResponseEnvelopeSchema.omit({ error: true }).safeParse(request.body)
    if (!identity.success) {
      reply.status(status).send({ error, meta })
      return
    }
    const classification =
      status === 401
        ? 'authentication'
        : status === 403
          ? 'authorization'
          : status === 409
            ? 'conflict'
            : status === 503 || status === 429
              ? 'runtime_unavailable'
              : status >= 500
                ? 'internal'
                : 'validation'
    const source =
      classification === 'authentication'
        ? 'auth'
        : classification === 'authorization'
          ? 'policy'
          : classification === 'validation'
            ? 'client'
            : classification === 'conflict' || classification === 'runtime_unavailable'
              ? 'workflow'
              : 'system'
    const details =
      'details' in error && error.details !== undefined ? { diagnostics: error.details } : undefined
    const envelope = ErrorResponseEnvelopeSchema.safeParse({
      ...identity.data,
      error: {
        ...error,
        details,
        class: classification,
        source,
        retryable: status === 503 || status === 429,
      },
    })
    reply.status(status).send({
      ...(envelope.success
        ? envelope.data
        : {
            ...identity.data,
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Internal server error',
              class: 'internal',
              source: 'system',
              retryable: false,
            },
          }),
      meta,
    })
  }
}

function normalizedError(exception: unknown, status: number) {
  if (exception instanceof HttpException) {
    const response = exception.getResponse()
    if (isApiError(response)) {
      return {
        code: response.code,
        ...(response.details === undefined ? {} : { details: response.details }),
        message: response.message,
      }
    }
  }
  if (isSchemaValidationError(exception)) {
    return {
      code: 'VALIDATION_ERROR',
      details: exception.issues.map((issue) => ({
        codes: [issue.code],
        field: issue.path.map(String).join('.'),
      })),
      message: 'Request validation failed',
    }
  }
  if (status === HttpStatus.NOT_FOUND) return { code: 'NOT_FOUND', message: 'Resource not found' }
  if (status === HttpStatus.UNAUTHORIZED) return { code: 'UNAUTHORIZED', message: 'Unauthorized' }
  if (status >= 400 && status < 500) return { code: 'BAD_REQUEST', message: 'Request rejected' }
  return { code: 'INTERNAL_ERROR', message: 'Internal server error' }
}

function isSchemaValidationError(value: unknown): value is {
  readonly issues: readonly { readonly code: string; readonly path: readonly PropertyKey[] }[]
} {
  if (typeof value !== 'object' || value === null) return false
  const issues = Reflect.get(value, 'issues')
  return (
    Array.isArray(issues) &&
    issues.every(
      (issue) =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof Reflect.get(issue, 'code') === 'string' &&
        Array.isArray(Reflect.get(issue, 'path'))
    )
  )
}

function isApiError(value: unknown): value is {
  code: string
  details?: unknown
  message: string
} {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['code'] === 'string' && typeof candidate['message'] === 'string'
}

function flattenValidationErrors(errors: ValidationError[], parent = ''): ValidationDetail[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property
    const current = error.constraints
      ? [{ codes: Object.keys(error.constraints).sort(), field }]
      : []
    return [...current, ...flattenValidationErrors(error.children ?? [], field)]
  })
}
