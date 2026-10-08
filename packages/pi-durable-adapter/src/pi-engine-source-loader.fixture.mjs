// Test-only Node strip-types resolution for source files whose production imports target emitted .js.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const directory = new URL('./', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith(directory) &&
      specifier.startsWith('./') &&
      specifier.endsWith('.js')
    ) {
      const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context)
    }
    return nextResolve(specifier, context)
  },
})
