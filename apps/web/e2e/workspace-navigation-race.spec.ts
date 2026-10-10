import { expect, test } from '@playwright/test'

import { stripWorkspaceDeepLinkSearch } from '../src/lib/workspace-search'

// ---------------------------------------------------------------------------
// Coverage class: navigation-race regression. Runs the real
// @tanstack/solid-router the app loads (discovered from the page's own module
// graph) and pins the ordering hazard behind the task-board visibility
// failure: overlapping navigate calls replace the search with the value of
// whichever commits last, so a stale deep-link strip issued as a value would
// drop `app=kanban`; the functional updater used by consumeDeepLink strips the
// latest search and preserves the switch. Unlike account-directory-ui.spec.ts
// this lane injects nothing into the app request path; it only exercises the
// router instance already loaded by the dev server.
// ---------------------------------------------------------------------------

test('a stale deep-link value loses the app switch; the functional strip preserves it', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForTimeout(1_500)

  const result = await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name)
    const routerUrl = urls.find((url) =>
      /@tanstack\+solid-router@[^/]+\/node_modules\/@tanstack\/solid-router\/dist\/source\/index\.jsx/.test(
        url
      )
    )
    if (!routerUrl) throw new Error('solid-router module was not loaded by the app')

    const router = (await import(routerUrl)) as unknown as {
      createMemoryHistory: (options: { initialEntries: string[] }) => unknown
      createRootRoute: () => { addChildren: (children: unknown[]) => unknown }
      createRoute: (options: { getParentRoute: () => unknown; path: string }) => unknown
      createRouter: (options: unknown) => {
        navigate: (options: unknown) => Promise<unknown>
        state: { location: { search: Record<string, unknown> } }
      }
    }

    const root = router.createRootRoute()
    const index = router.createRoute({ getParentRoute: () => root, path: '/' })
    const routeTree = root.addChildren([index])
    const make = () =>
      router.createRouter({
        routeTree,
        history: router.createMemoryHistory({ initialEntries: ['/?channel=c1'] }),
      })

    // Failing interleave: the app switch commits first, then a stale
    // plain-value strip commits last.
    const stale = make()
    await Promise.all([
      stale.navigate({ search: { app: 'kanban' }, replace: true }).then(
        () => undefined,
        () => undefined
      ),
      stale.navigate({ search: {}, replace: true }).then(
        () => undefined,
        () => undefined
      ),
    ])

    // Fixed interleave: the strip is a functional updater, so it deletes the
    // deep-link keys from whatever the latest search is.
    const functional = make()
    await Promise.all([
      functional.navigate({ search: { app: 'kanban' }, replace: true }).then(
        () => undefined,
        () => undefined
      ),
      functional
        .navigate({
          search: (previous: Record<string, unknown>) => {
            const next = { ...previous }
            delete next.channel
            return next
          },
          replace: true,
        })
        .then(
          () => undefined,
          () => undefined
        ),
    ])

    return {
      staleSearch: stale.state.location.search,
      functionalSearch: functional.state.location.search,
    }
  })

  // The hazard is real: a plain value strip committed last drops the switch.
  expect(result.staleSearch).not.toHaveProperty('app')
  // The fix is deterministic: the functional strip keeps `app=kanban`.
  expect(result.functionalSearch).toEqual({ app: 'kanban' })
  // The app's helper produces exactly that functional-strip result.
  expect(stripWorkspaceDeepLinkSearch({ app: 'kanban', channel: 'c1' })).toEqual({
    app: 'kanban',
  })
})
