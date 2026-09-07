import { Module, type DynamicModule } from '@nestjs/common'
import { createOpenTelemetryMetricAdapter, createOpenTelemetryTraceAdapter } from '@control-plane/telemetry/opentelemetry'
import { createConsoleTraceAdapter, createTelemetry } from '@control-plane/telemetry'
import {
  DisabledServiceAuthenticator,
  SERVICE_AUTHENTICATOR,
  ServiceAuthenticationGuard,
  type ServiceAuthenticator,
} from './auth/service-authentication.js'
import { AuthenticationController } from './auth/authentication.controller.js'
import { HealthController } from './health/health.controller.js'
import { ExecutionAcceptanceController } from './executions/execution-acceptance.controller.js'
import {
  EXECUTION_ACCEPTANCE_SERVICE,
  UnavailableExecutionAcceptanceService,
  type ExecutionAcceptanceService,
} from './executions/execution-acceptance.service.js'
import { ExecutionValidationController } from './executions/execution-validation.controller.js'
import {
  EXECUTION_VALIDATION_SERVICE,
  UnavailableExecutionValidationService,
  type ExecutionValidationService,
} from './executions/execution-validation.service.js'
import { RequestLoggingInterceptor } from './http/request-logging.interceptor.js'
import {
  API_HEALTH,
  API_DEPENDENCY_READINESS,
  API_LOGGER,
  API_METADATA,
  API_READINESS,
  API_TELEMETRY,
  type ApiRuntimeBindings,
} from './http/tokens.js'
import { SystemController } from './system/system.controller.js'
import { SystemService } from './system/system.service.js'
import { RuntimeDiscoveryController } from './runtime-discovery/runtime-discovery.controller.js'
import {
  EmptyRuntimeDiscoveryRepository,
  RUNTIME_DISCOVERY_REPOSITORY,
  type RuntimeDiscoveryRepository,
} from './runtime-discovery/runtime-discovery.repository.js'
import { RuntimeDiscoveryService } from './runtime-discovery/runtime-discovery.service.js'
import { MarketplaceController } from './marketplace/marketplace.controller.js'
import { UnavailableMarketplaceInstallationService } from './marketplace/installation.js'
import type { MarketplaceInstallationAuthority } from './marketplace/installation.js'
import {
  MarketplaceRegistryService,
  UnavailableMarketplaceRegistryService,
} from './marketplace/registry.js'
import {
  MARKETPLACE_INSTALLATION_SERVICE,
  MARKETPLACE_REGISTRY_SERVICE,
} from './marketplace/tokens.js'
import { ProfileResolutionController } from './queries/profile-resolution.controller.js'
import {
  PROFILE_RESOLUTION_SERVICE,
  UnavailableProfileResolutionService,
  type ProfileResolutionService,
} from './queries/profile-resolution.service.js'
import { ProjectStateResolutionController } from './queries/project-state-resolution.controller.js'
import {
  PROJECT_STATE_RESOLUTION_SERVICE,
  UnavailableProjectStateResolutionService,
  type ProjectStateResolutionService,
} from './queries/project-state-resolution.service.js'
import { ContextPackageResolutionController } from './queries/context-package-resolution.controller.js'
import {
  CONTEXT_PACKAGE_RESOLUTION_SERVICE,
  UnavailableContextPackageResolutionService,
  type ContextPackageResolutionService,
} from './queries/context-package-resolution.service.js'

export interface AppModuleOptions extends ApiRuntimeBindings {
  readonly executionAcceptanceService?: ExecutionAcceptanceService
  readonly executionValidationService?: ExecutionValidationService
  readonly serviceAuthenticator?: ServiceAuthenticator
  readonly runtimeDiscoveryRepository?: RuntimeDiscoveryRepository
  readonly componentManifest?: () => Promise<unknown>
  readonly profileResolutionService?: ProfileResolutionService
  readonly projectStateResolutionService?: ProjectStateResolutionService
  readonly contextPackageResolutionService?: ContextPackageResolutionService
  readonly marketplaceRegistryService?: MarketplaceRegistryService
  readonly marketplaceInstallationService?: MarketplaceInstallationAuthority
}

@Module({})
export class AppModule {}

export function createAppModule(options: AppModuleOptions): DynamicModule {
  const traceAdapter =
    options.metadata.environment === 'development'
      ? createConsoleTraceAdapter(options.logger)
      : createOpenTelemetryTraceAdapter(options.metadata.serviceName)
  const telemetry =
    options.telemetry ??
    createTelemetry({
      serviceName: options.metadata.serviceName,
      logger: options.logger,
      traceAdapter,
      metricAdapter: createOpenTelemetryMetricAdapter(options.metadata.serviceName),
    })
  return {
    module: AppModule,
    controllers: [
      AuthenticationController,
      ContextPackageResolutionController,
      ExecutionAcceptanceController,
      ExecutionValidationController,
      HealthController,
      ProfileResolutionController,
      ProjectStateResolutionController,
      RuntimeDiscoveryController,
      MarketplaceController,
      SystemController,
    ],
    providers: [
      { provide: API_HEALTH, useValue: options.health },
      {
        provide: API_DEPENDENCY_READINESS,
        useValue: options.dependencyReadiness ?? (() => Promise.resolve(true)),
      },
      { provide: API_LOGGER, useValue: options.logger },
      { provide: API_METADATA, useValue: options.metadata },
      { provide: API_READINESS, useValue: options.readiness },
      { provide: API_TELEMETRY, useValue: telemetry },
      {
        provide: CONTEXT_PACKAGE_RESOLUTION_SERVICE,
        useValue:
          options.contextPackageResolutionService ??
          new UnavailableContextPackageResolutionService(),
      },
      {
        provide: EXECUTION_ACCEPTANCE_SERVICE,
        useValue: options.executionAcceptanceService ?? new UnavailableExecutionAcceptanceService(),
      },
      {
        provide: EXECUTION_VALIDATION_SERVICE,
        useValue: options.executionValidationService ?? new UnavailableExecutionValidationService(),
      },
      {
        provide: SERVICE_AUTHENTICATOR,
        useValue: options.serviceAuthenticator ?? new DisabledServiceAuthenticator(),
      },
      {
        provide: PROFILE_RESOLUTION_SERVICE,
        useValue: options.profileResolutionService ?? new UnavailableProfileResolutionService(),
      },
      {
        provide: PROJECT_STATE_RESOLUTION_SERVICE,
        useValue:
          options.projectStateResolutionService ?? new UnavailableProjectStateResolutionService(),
      },
      {
        provide: RUNTIME_DISCOVERY_REPOSITORY,
        useValue: options.runtimeDiscoveryRepository ?? new EmptyRuntimeDiscoveryRepository(),
      },
      {
        provide: MARKETPLACE_REGISTRY_SERVICE,
        useValue: options.marketplaceRegistryService ?? new UnavailableMarketplaceRegistryService(),
      },
      {
        provide: MARKETPLACE_INSTALLATION_SERVICE,
        useValue:
          options.marketplaceInstallationService ?? new UnavailableMarketplaceInstallationService(),
      },
      RequestLoggingInterceptor,
      ServiceAuthenticationGuard,
      RuntimeDiscoveryService,
      SystemService,
    ],
  }
}
