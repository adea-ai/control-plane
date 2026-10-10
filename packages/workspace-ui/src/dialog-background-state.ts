/**
 * The workspace frame leaves the accessibility tree while a modal is open.
 * Kobalte schedules that `aria-hidden` write with `setTimeout →
 * requestAnimationFrame` and never guards it against disposal, while its
 * removal path is guarded and deferred: a write scheduled before close can
 * land afterwards and stick, leaving a visible board unqueryable by role.
 *
 * A panel that opened a modal captures the frame's pre-open state and, once
 * the modal is gone, restores exactly the state it captured. It never removes
 * another overlay's state and never writes a value it did not record.
 */
export type DialogBackgroundState = Readonly<{
  ariaHidden: string | null
  inert: boolean
  bodyPointerEvents: string
}>

export type DialogBackgroundElement = {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
}

export function captureDialogBackgroundState(
  element: DialogBackgroundElement | null | undefined,
  body: { style: { pointerEvents: string } }
): DialogBackgroundState | undefined {
  if (!element) return undefined
  return {
    ariaHidden: element.getAttribute('aria-hidden'),
    inert: element.hasAttribute('inert'),
    bodyPointerEvents: body.style.pointerEvents,
  }
}

/**
 * A modal that is actually present in the layout owns the background. A
 * hidden-but-mounted dialog must not block repair, so visibility is part of
 * the ownership test.
 */
export type DialogQueryRoot = {
  querySelectorAll(selector: string): ArrayLike<{ getClientRects(): ArrayLike<unknown> }>
}

/**
 * `self` is the dialog whose close is asking the question: it does not own
 * the background, and neither does anything nested inside it (a confirmation
 * alert living in the closing sheet's content). Only an overlay that outlives
 * this close counts.
 */
export function hasVisibleModal(
  root: DialogQueryRoot,
  self?: { contains(node: unknown): boolean }
): boolean {
  const dialogs = root.querySelectorAll('[role="dialog"], [role="alertdialog"]')
  for (let index = 0; index < dialogs.length; index += 1) {
    const dialog = dialogs[index]
    if (!dialog || dialog.getClientRects().length === 0) continue
    if (dialog === (self as unknown)) continue
    if (self?.contains(dialog)) continue
    return true
  }
  return false
}

/**
 * Restores the captured pre-open state. Returns whether anything changed.
 * Skipped while another modal is present so a second overlay keeps ownership
 * of the background it is hiding.
 *
 * `capturedWhileOtherModalOpen` marks a capture that was taken while another
 * visible modal already owned the background: the hidden state it recorded is
 * that modal's containment, not this frame's baseline, so restoring it would
 * leave the frame in the accessibility shadow of a modal that has since
 * closed. Once no other modal remains, such a capture restores the frame's
 * accessible baseline instead of a recorded hidden state (`true` aria-hidden,
 * an inert attribute, a `none` body pointer-events are all modal writes);
 * any other recorded value was the frame's own and is restored as captured.
 */
export function restoreDialogBackgroundState(options: {
  element: DialogBackgroundElement | null | undefined
  body: { style: { pointerEvents: string } }
  captured: DialogBackgroundState | undefined
  capturedWhileOtherModalOpen?: boolean
  hasOtherModal: () => boolean
}): boolean {
  const { element, body, captured, capturedWhileOtherModalOpen, hasOtherModal } = options
  if (!element || !captured) return false
  if (hasOtherModal()) return false

  const baseline = capturedWhileOtherModalOpen
    ? {
        ariaHidden: captured.ariaHidden === 'true' ? null : captured.ariaHidden,
        inert: false,
        bodyPointerEvents: captured.bodyPointerEvents === 'none' ? '' : captured.bodyPointerEvents,
      }
    : captured

  let changed = false
  if (baseline.ariaHidden === null) {
    if (element.getAttribute('aria-hidden') === 'true') {
      element.removeAttribute('aria-hidden')
      changed = true
    }
  } else if (element.getAttribute('aria-hidden') !== baseline.ariaHidden) {
    element.setAttribute('aria-hidden', baseline.ariaHidden)
    changed = true
  }
  if (!baseline.inert && element.hasAttribute('inert')) {
    element.removeAttribute('inert')
    changed = true
  }
  if (baseline.bodyPointerEvents !== 'none' && body.style.pointerEvents === 'none') {
    body.style.pointerEvents = baseline.bodyPointerEvents
    changed = true
  }
  return changed
}
