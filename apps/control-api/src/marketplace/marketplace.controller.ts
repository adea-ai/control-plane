import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import { responseMetadata } from '../http/request-context.js'
import type { MarketplaceRegistryService } from './registry.js'
import { MARKETPLACE_INSTALLATION_SERVICE, MARKETPLACE_REGISTRY_SERVICE } from './tokens.js'
import type {
  MarketplaceInstallEnvelope,
  MarketplaceInstallPlanEnvelope,
  MarketplaceInstallationAuthority,
} from './installation.js'
import { MarketplaceRegistryPlanError, planFailureResponse } from './agent-plugins.js'

@ApiTags('marketplace')
@Controller({ path: 'marketplace', version: '1' })
export class MarketplaceController {
  constructor(
    @Inject(MARKETPLACE_REGISTRY_SERVICE)
    private readonly registry: MarketplaceRegistryService,
    @Inject(MARKETPLACE_INSTALLATION_SERVICE)
    private readonly installations: MarketplaceInstallationAuthority
  ) {}

  @Post('catalog')
  @HttpCode(200)
  @RequireServiceAuthentication('marketplace:read')
  @ApiOperation({ summary: 'Discover the verified marketplace catalog through Control Plane' })
  @ApiOkResponse({ description: 'Verified catalog metadata and installation state' })
  async catalog(@Body() envelope: unknown, @Req() request: FastifyRequest) {
    const snapshot = await this.registry.getCatalog()
    const identity = readIdentity(envelope)
    return {
      data: {
        catalogId: snapshot.catalogId,
        releaseId: snapshot.releaseId,
        state: snapshot.state,
        artifacts: snapshot.artifacts,
        installations: await this.installations.list(identity.workspaceId),
      },
      meta: responseMetadata(request),
    }
  }

  @Post('install')
  @HttpCode(202)
  @RequireServiceAuthentication('marketplace:install')
  @ApiOperation({ summary: 'Request an idempotent, policy-checked marketplace installation' })
  @ApiAcceptedResponse({ description: 'Marketplace installation state' })
  async install(@Body() envelope: unknown, @Req() request: FastifyRequest) {
    const result = await this.installations.install(parseInstallEnvelope(envelope))
    return { data: result, meta: responseMetadata(request) }
  }

  @Post('install-plan')
  @HttpCode(200)
  @RequireServiceAuthentication('marketplace:install')
  @ApiOperation({ summary: 'Negotiate a capability-bound Agent Plugins installation plan' })
  @ApiOkResponse({ description: 'Advisory installation plan; activation remains policy-owned' })
  async installPlan(@Body() envelope: unknown, @Req() request: FastifyRequest) {
    if (!this.installations.plan) planFailureResponseUnavailable()
    try {
      const result = await this.installations.plan(parseInstallPlanEnvelope(envelope))
      return { data: result, meta: responseMetadata(request) }
    } catch (error) {
      if (error instanceof MarketplaceRegistryPlanError) planFailureResponse(error)
      throw error
    }
  }
}

function readIdentity(value: unknown): { workspaceId: string; userId: string } {
  if (
    !isObject(value) ||
    !isObject(value['parameters']) ||
    !isObject(value['parameters']['workspaceIdentity'])
  )
    throw new ServiceUnavailableException({
      code: 'MARKETPLACE_REQUEST_INVALID',
      message: 'Marketplace catalog request is invalid',
    })
  const parameters = value['parameters'] as Record<string, unknown>
  const identity = parameters['workspaceIdentity'] as Record<string, unknown>
  if (!stringValue(identity['workspaceId']) || !stringValue(identity['userId']))
    throw new ServiceUnavailableException({
      code: 'MARKETPLACE_REQUEST_INVALID',
      message: 'Marketplace catalog request is invalid',
    })
  return {
    userId: stringValue(identity['userId']),
    workspaceId: stringValue(identity['workspaceId']),
  }
}

function parseInstallPlanEnvelope(value: unknown): MarketplaceInstallPlanEnvelope {
  if (!isObject(value) || !isObject(value['payload']))
    throw new ServiceUnavailableException({
      code: 'MARKETPLACE_REQUEST_INVALID',
      message: 'Marketplace installation-plan request is invalid',
    })
  return value as MarketplaceInstallPlanEnvelope
}

function planFailureResponseUnavailable(): never {
  throw new ServiceUnavailableException({
    code: 'MARKETPLACE_INSTALLATION_NOT_CONFIGURED',
    message: 'Marketplace installation planning is not configured',
  })
}

function parseInstallEnvelope(value: unknown): MarketplaceInstallEnvelope {
  if (!isObject(value) || !isObject(value['payload']))
    throw new ServiceUnavailableException({
      code: 'MARKETPLACE_REQUEST_INVALID',
      message: 'Marketplace installation request is invalid',
    })
  return value as MarketplaceInstallEnvelope
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
