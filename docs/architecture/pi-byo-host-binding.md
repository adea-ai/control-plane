# Pi BYO host binding and funding confirmation

This opt-in Node composition supplements the existing model connection APIs. It
does not activate a provider, create credentials or grant spending authority.
Issue #931 remains partial until the combined runtime/product and live provider
qualification is established.

`createCanonicalModelExecutionAuthority` reads the retained canonical Node intent,
ready marker, execution/attempt and immutable plan from server repositories. It
checks the authenticated product evidence and current kernel scope using the
original product actor. Transport, admission and vault lease principals remain
separate. Current product scope, selection and authority revision must still
match; expired, revoked, cancelling or superseded records deny.

`createPiDurableAccountAuthority` intersects authenticated current account evidence
with metadata from the supported Pi provider's `getModels()` abstraction. Its
first transport is the reviewed Pi Durable/pi-ai 1.1.0 source
`1cedd32724abfcb0915f76cc61b6827e2c16dbad`, OpenAI Responses, API key, BYO API,
remote host, `pi_durable_models`. Catalog membership establishes neither quota nor
entitlement. Unknown account, quota or residency state denies. This adapter never
constructs a custom provider or extracts OAuth/environment credentials. The product
composition applies this intersection to `piDurableRegistryMetadata`, the installed
pi-ai 1.1.0 catalog (package version verified by test). The host supplies only an
authenticated current account reader; deterministic fixtures do not qualify a live
provider.

`createFileRecordedModelFundingAuthority` is an optional local operator metadata
reader. Its configured directory and descendants must be private and owned by the
host uid, with no symlinks. It reads at most 64 KiB from each file and rereads both
files after awaited current execution checks. It never creates or modifies them:

- `<workspaceId>/<executionId>/<attemptId>.json`: strict
  `recorded-funding-host/v1` containing the exact accepted binding, existing
  `RecordedModelFundingDecision`, active/revoked status and expiry.
- `<workspaceId>/payers/<sha256(ownerRef)>.json`: strict
  `recorded-funding-payer/v1` containing workspace, authorization reference,
  explicit `ModelFundingOwner`, active/revoked status and expiry.

The independent payer record must exactly match the decision, including payer
revision and evidence reference. Both metadata expiries must cover the earlier
grant/price expiry; otherwise readiness denies instead of advertising a later
display deadline. Connection administrators and provider accounts never imply a
payer. These files are distinct from legacy credential-containing operator files.
Native spending must separately authenticate and validate the same recorded grant,
price and per-physical-send ledger allocation.

`createCanonicalModelHostComposition` combines those readers with
`createSqliteModelFundingConfirmations`. `prepareForReader(reader, deadline)`
derives the full binding from server records and retains the FULL existing ready
`model-funding-display/v1` view. The result is server-only metadata: binding,
funding view, confirmation reference, creation time, admission deadline and expiry.
Expiry is the minimum of five minutes, funding expiry and admission deadline.
The public prepare API and its opaque preparation reference remain owned by R1.
R1 retains this confirmation reference privately; client bodies never define a
binding or spending grant.

Each workspace/execution/attempt has one immutable SQLite winner. Retrying returns
that winner only while the exact current funding view still matches. Changed
payer/account/auth/source, selection/authority revision, blocked readiness or
expiry rejects `PI_LEAD_FUNDING_CONFIRMATION_STALE`. Missing evidence rejects
`PI_LEAD_FUNDING_CONFIRMATION_REQUIRED`. A changed payer cannot replace a prepared
winner: canonical cancellation/expiry and a fresh attempt are required.

Both native provider and recorded-spending consumers must use the SAME
`forExecution(binding)` facade. Its confirmed execution authority rereads current
funding at every resolution and credential-use boundary, including reopen and the
physical-send guard. Facades hold references only; the bounded cache fails closed
at capacity. Host terminal cleanup may forget a facade. No credential, Models
registry or lease is retained in this cache or confirmation store.

Preparing creates no physical-send reservation. R1 owns idempotent expiry/abandon
cleanup of the canonical UNUSED attempt allocation, including startup recovery;
this composition never releases an in-flight allocation. Existing direct and
legacy runtimes remain unchanged.
