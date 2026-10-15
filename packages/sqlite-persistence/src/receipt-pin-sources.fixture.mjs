// Test support for the receipt owner pin index (#1022): which receipt namespace
// pinned each owner, and which pins a full scan says are missing.
import {
  delegationReceiptNamespaces,
  receiptOwnerPinNamespace,
  receiptOwnerPins,
} from './delegation-retention.ts'

/** `kind:identity` -> the namespaces whose writers pinned it. */
export async function pinSources(provider) {
  const rows = await provider.transaction((transaction) =>
    transaction.list(receiptOwnerPinNamespace)
  )
  return Object.fromEntries(
    rows
      .filter((row) => row.value.kind !== undefined)
      .map((row) => [`${row.value.kind}:${row.value.identity}`, row.value.sources])
  )
}

/**
 * Pins that a retained receipt names but whose own namespace never recorded: a
 * writer that skipped its pin shows up here even when another writer pinned the
 * same owner.
 */
export async function missingPins(provider) {
  const indexed = await pinSources(provider)
  const missing = {}
  for (const namespace of delegationReceiptNamespaces) {
    const rows = await provider.transaction((transaction) => transaction.list(namespace))
    for (const row of rows) {
      const pins = receiptOwnerPins(namespace, row.value)
      for (const [kind, identities] of [
        ['execution', pins.executionIds],
        ['plan', pins.planIds],
      ])
        for (const identity of identities)
          if (!indexed[`${kind}:${identity}`]?.includes(namespace))
            (missing[`${kind}:${identity}`] ??= []).push(namespace)
    }
  }
  return missing
}
