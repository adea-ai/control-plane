import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { RequireServiceAuthentication } from '../auth/service-authentication.js'
import {
  PROFILE_RESOLUTION_SERVICE,
  type ProfileResolutionService,
} from './profile-resolution.service.js'

@ApiTags('profiles')
@Controller({ path: 'profiles', version: '1' })
@RequireServiceAuthentication('profile:resolve')
export class ProfileResolutionController {
  constructor(
    @Inject(PROFILE_RESOLUTION_SERVICE)
    private readonly service: ProfileResolutionService
  ) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve an immutable published profile version' })
  @ApiOkResponse({ description: 'Published profile and pinned Skill versions' })
  resolve(@Body() envelope: unknown, @Req() request: FastifyRequest) {
    return this.service.resolve(envelope, request.servicePrincipal?.principalId ?? '')
  }
}
