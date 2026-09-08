import {
  ModelCapabilitySchema,
  ModelProviderClassSchema,
  type ExecutionConstraintSet,
} from '@control-plane/domain'

export interface LocalModelRouteOptions {
  readonly provider: string
  readonly model: string
  readonly modelAlias: string
  readonly modelCapabilities: readonly string[]
  readonly providerClass: string
  readonly dataResidency: string
}

/** Validate declared route policy; native launchers must enforce these selectors separately. */
export class LocalRuntimeModelRoute {
  readonly provider: string
  readonly model: string
  readonly #alias: string
  readonly #capabilities: readonly ReturnType<typeof ModelCapabilitySchema.parse>[]
  readonly #providerClass: ReturnType<typeof ModelProviderClassSchema.parse>
  readonly #residency: 'us' | 'eu' | 'global' | 'local'

  constructor(
    options: LocalModelRouteOptions,
    readonly errorPrefix: 'MANAGED_PI' | 'ACP'
  ) {
    const token = (value: string, name: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value))
        throw new Error(`${errorPrefix}_${name}_INVALID`)
      return value
    }
    this.provider = token(options.provider, 'PROVIDER')
    this.model = token(options.model, 'MODEL')
    this.#alias = token(options.modelAlias, 'MODEL_ALIAS')
    this.#capabilities = options.modelCapabilities.map((value) =>
      ModelCapabilitySchema.parse(value)
    )
    this.#providerClass = ModelProviderClassSchema.parse(options.providerClass)
    const residency = options.dataResidency
    if (residency !== 'us' && residency !== 'eu' && residency !== 'global' && residency !== 'local')
      throw new Error(`${errorPrefix}_DATA_RESIDENCY_INVALID`)
    this.#residency = residency
  }

  assertEligible(policies: ExecutionConstraintSet['models']): void {
    const policy = policies.find((candidate) => candidate.alias === this.#alias)
    if (policy === undefined) throw new Error(`${this.errorPrefix}_MODEL_ALIAS_UNRESOLVED`)
    if (
      policy.providerPolicy.deniedProviders.includes(this.provider) ||
      !policy.providerPolicy.allowedClasses.includes(this.#providerClass) ||
      !policy.providerPolicy.dataResidency.includes(this.#residency) ||
      policy.requiredCapabilities.some((capability) => !this.#capabilities.includes(capability))
    )
      throw new Error(`${this.errorPrefix}_MODEL_ROUTE_INELIGIBLE`)
  }
}
