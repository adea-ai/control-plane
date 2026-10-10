/**
 * Settles one `?workspace=` link at a time (Home receipt 1725).
 *
 * A link is an attempt keyed by its exact target. It is `switching` while its switch is in
 * flight, `settled` once the switch landed (its URL strip may still be pending), and `failed`
 * when the switch was refused. Only the current attempt may settle or strip the URL, so a late
 * completion for a link the navigation has moved past, or for an attempt a newer one replaced,
 * never touches the newer link. A settled or failed link never re-runs on its own: it must be
 * released (the param removed) and issued again, which starts a fresh attempt. Nothing here
 * retries in a loop.
 *
 * A settled link keeps its `workspace` param while it still carries a scoped destination
 * (channel, task, thread or message): that param is the surface's guard, so the surface can
 * apply the destination only against the target and not the workspace that was active before
 * the switch. The surface strips the whole link once it has consumed it.
 */

export type DeepLinkAttemptState = 'switching' | 'settled' | 'failed'

export type DeepLinkAttempts = Readonly<{
  /** Starts the attempt for `workspace` unless the current attempt already owns that link. */
  start(workspace: string): boolean
  /** The link left the URL: the next `?workspace=` is a new attempt. */
  release(): void
  /** The state of the current attempt, when it is for this exact link. */
  state(workspace: string): DeepLinkAttemptState | undefined
}>

export function createDeepLinkAttempts(options: {
  /** Performs the switch; resolves true when it landed and false when it was refused. */
  switchTo(workspace: string): Promise<boolean>
  /** The workspace the URL requests right now, if any. */
  requested(): string | undefined
  /** Strips the param for a link that settled while it is still the requested one. */
  consume(workspace: string): void
  /** True while the requested link carries a scoped destination the surface has not consumed. */
  retain(): boolean
}): DeepLinkAttempts {
  let current: { readonly workspace: string; state: DeepLinkAttemptState } | undefined
  return {
    start(workspace) {
      if (current?.workspace === workspace) return false
      const attempt = { state: 'switching' as DeepLinkAttemptState, workspace }
      current = attempt
      void options.switchTo(workspace).then((switched) => {
        if (current !== attempt) return
        if (!switched) {
          attempt.state = 'failed'
          return
        }
        attempt.state = 'settled'
        if (options.requested() === attempt.workspace && !options.retain())
          options.consume(attempt.workspace)
      })
      return true
    },
    release() {
      current = undefined
    },
    state(workspace) {
      return current?.workspace === workspace ? current.state : undefined
    },
  }
}
