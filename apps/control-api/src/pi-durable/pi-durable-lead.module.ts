import { Module, type DynamicModule } from '@nestjs/common'
import {
  SERVICE_AUTHENTICATOR,
  ServiceAuthenticationGuard,
  type ServiceAuthenticator,
} from '../auth/service-authentication.js'
import { PiDurableLeadController } from './pi-durable-lead.controller.js'
import { PI_DURABLE_LEAD_SERVICE, type PiDurableLeadService } from './pi-durable-lead.service.js'

@Module({})
export class PiDurableLeadModule {
  static register(options: {
    readonly service: PiDurableLeadService
    readonly serviceAuthenticator: ServiceAuthenticator
  }): DynamicModule {
    return {
      module: PiDurableLeadModule,
      controllers: [PiDurableLeadController],
      providers: [
        { provide: PI_DURABLE_LEAD_SERVICE, useValue: options.service },
        { provide: SERVICE_AUTHENTICATOR, useValue: options.serviceAuthenticator },
        ServiceAuthenticationGuard,
      ],
      exports: [PI_DURABLE_LEAD_SERVICE],
    }
  }
}
