import { Config, Context, Effect, Layer } from 'effect'

/**
 * Lease policy bounds via Effect Config. Defaults are the exact constants of
 * the pre-Effect implementation, so behavior is identical unless an operator
 * explicitly overrides the environment variables.
 */

export interface VaultConfigValues {
  readonly maximumCredentialLeaseClockSkewMs: number
  readonly maximumCredentialLeaseTtlMs: number
}

export class VaultConfig
  extends Context.Tag('credential-vault/VaultConfig')<VaultConfig, VaultConfigValues>()
{}

export const VaultConfigLayer: Layer.Layer<VaultConfig> = Layer.effect(
  VaultConfig,
  Effect.all({
    maximumCredentialLeaseClockSkewMs: Config.integer('CREDENTIAL_VAULT_MAX_CLOCK_SKEW_MS').pipe(
      Config.withDefault(30_000)
    ),
    maximumCredentialLeaseTtlMs: Config.integer('CREDENTIAL_VAULT_MAX_LEASE_TTL_MS').pipe(
      Config.withDefault(300_000)
    ),
  }).pipe(Effect.orDie)
)
