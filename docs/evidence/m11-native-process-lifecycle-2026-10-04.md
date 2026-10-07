# M11 native Pi duration and terminal child lifecycle

At base `7bb52a9da0967c5af9c0a51eee3efaa38d035f90`, the native process client
received the compiled duration limit but did not apply it to the running process.
Completion and cancellation persisted terminal outcomes while their owned child
remained alive until a separate cleanup call. The Local environment-configured
runtime factory in `apps/local-control-plane/src/index.ts` reaches this client
through `createLocalManagedPiRuntime` and direct runtime transport.

The client now starts a monotonic deadline after native process startup, before
the RPC startup handshake. It initiates abort on expiry, captures validated usage
within a bounded window, reaps its child, and durably publishes `timed_out`.
Completion, failure and cancellation also reap their owned child before exposing
the terminal receipt through status or progress. Terminal transitions clear the
deadline timer; long duration limits use timer chunks to avoid Node timer overflow.

Deadline and cancellation cleanup permit up to 500ms for abort and 500ms for the stats snapshot,
then two seconds for SIGTERM and one second for SIGKILL/exit acknowledgement.
Unconfirmed stopping throws `PI_PROCESS_STOP_UNCONFIRMED`; cleanup retains working
state and native admission rather than publishing a confirmed receipt or allowing
a new native start. Unknown stats remain absent, never a fabricated zero.

The native receipt reader accepts the already published `timed_out` status.
Existing successful/failed/cancelled receipts keep their format. An older reader
rejects the newly produced timeout receipt as uncertain; native admission still
requires reconciliation rather than starting the attempt again after rollback.
Input materialization and admission precede this native-process timer; full
workflow deadlines remain a separate boundary.

Regressions use a real, isolated Node child running the repository RPC fixture;
they do not call a model provider or the local Docker engine. They observe its
recorded PID, assert exit before separate cleanup, exercise a SIGTERM-resistant
child with no stats, recover timeout usage/unknown state after reconstruction,
and reap after a lost abort acknowledgement while retaining validated usage. They
reject a lost stopping acknowledgement without another native start. The
existing late-stats regression now verifies the closed link and frozen live/cold
usage after the child is reaped. Tests record planned ownership before launch,
retain PID/cwd receipts, and remove each fixture. The outer runner records its
process group, enforces 20 seconds, reconciles descendants and removes cached
dependency links and its exclusive fixture root.

The final native test file passed 28 cases/217 assertions in 16.913s, including
the separate lost-abort-ack and lost-stop-ack regressions. Focused tests load changed source directly
with existing cached dependency exports; current-head CI must validate the whole
candidate. The initial regression run reproduced live completion/cancellation
children and absent deadline enforcement; its stubborn-child case reached Bun's
test timeout, and the outer owned fixture was removed. The cancellation-ACK
regression first failed with `PI_RPC_TIMEOUT:abort`, then passed after bounded
abort waiting was made independent of child stopping.

The scoped finding is P2, owned by the current Codex implementation task, with a
2026-10-04 remediation target. The regression fix is prepared; current-head
review and CI remain its publication gates.

This is scoped #188/#194 implementation and synthetic process evidence. It does
not prove real pinned Pi/provider behavior, actual model stream termination,
cross-profile deployed acceptance, sleep/wake/host-loss recovery, or dollar/token
budget enforcement and trusted usage settlement. Those gates, physical retention,
the full M11 acceptance matrix and the final independent frozen audit remain open.
