import { isBuiltin } from 'node:module'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript6'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ignored = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.vite', '.cache'])
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/
const inside = (directory, file) => file === directory || file.startsWith(`${directory}${sep}`)

export function workspaces(directory = root) {
  return ['apps', 'packages'].flatMap((parent) => {
    const base = join(directory, parent)
    if (!existsSync(base)) return []
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
      .map((entry) => {
        const dir = join(base, entry.name)
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        return { dir, manifest }
      })
  })
}

/** Includes type-only imports, re-exports, import types and literal require/import calls. */
export function specifiers(source, filename = 'source.ts') {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  if (file.parseDiagnostics.length) {
    throw new SyntaxError(
      ts.flattenDiagnosticMessageText(file.parseDiagnostics[0].messageText, '\n')
    )
  }
  const found = []
  const factories = new Set(['createRequire'])
  const moduleNamespaces = new Set()
  const requires = new Set(['require'])
  const visitAll = (node, action) => {
    action(node)
    ts.forEachChild(node, (child) => visitAll(child, action))
  }
  visitAll(file, (node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !['node:module', 'module'].includes(node.moduleSpecifier.text)
    )
      return
    const clause = node.importClause
    if (clause?.name) moduleNamespaces.add(clause.name.text)
    const bindings = clause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) moduleNamespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'createRequire')
          factories.add(element.name.text)
      }
    }
  })
  const isFactory = (node) =>
    ts.isIdentifier(node)
      ? factories.has(node.text)
      : ts.isPropertyAccessExpression(node) &&
        node.name.text === 'createRequire' &&
        ts.isIdentifier(node.expression) &&
        moduleNamespaces.has(node.expression.text)
  const isDependencyResolution = (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'resolve' &&
    ts.isMetaProperty(node.expression.expression) &&
    node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    /^(?:@[a-z0-9._~-]+\/)?[a-z0-9_~][a-z0-9._~-]*(?:\/[^\s]*)?$/i.test(node.arguments[0].text)
  // A require anchored at another declared package resolves that package's
  // dependencies, not this workspace's. Its import.meta.resolve edge is still
  // checked below; do not falsely require its transitives in this manifest.
  const isCreatedRequire = (node) =>
    ts.isCallExpression(node) &&
    isFactory(node.expression) &&
    !(node.arguments[0] && isDependencyResolution(node.arguments[0]))
  // Resolve local aliases before collecting calls, including aliases of aliases.
  let changed = true
  while (changed) {
    changed = false
    visitAll(file, (node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        !node.initializer ||
        requires.has(node.name.text)
      )
        return
      if (
        isCreatedRequire(node.initializer) ||
        (ts.isIdentifier(node.initializer) && requires.has(node.initializer.text))
      ) {
        requires.add(node.name.text)
        changed = true
      }
    })
  }

  const add = (node) => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    if (ts.isCallExpression(node)) {
      const literalImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const requireCall =
        (ts.isIdentifier(node.expression) && requires.has(node.expression.text)) ||
        isCreatedRequire(node.expression)
      const requireResolve =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        requires.has(node.expression.expression.text) &&
        node.expression.name.text === 'resolve'
      const importResolve =
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'resolve' &&
        ts.isMetaProperty(node.expression.expression) &&
        node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      if (literalImport || requireCall || requireResolve || importResolve) add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...new Set(found)]
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : files(file)
    return sourceExtension.test(extname(file)) ? [file] : []
  })
}

export function checkBoundaries(directory = root) {
  const errors = []
  let checked = 0
  const packages = workspaces(directory)
  for (const { dir, manifest } of packages) {
    const declared = new Set([
      manifest.name,
      ...Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      }),
    ])
    for (const file of files(dir)) {
      checked++
      let imports
      try {
        imports = specifiers(readFileSync(file, 'utf8'), file)
      } catch (error) {
        errors.push(`${relative(directory, file)}: cannot parse imports: ${error.message}`)
        continue
      }
      for (const specifier of imports) {
        if (isBuiltin(specifier) || specifier === 'bun' || specifier.startsWith('bun:')) continue
        if (specifier.startsWith('.') || specifier.startsWith('/')) {
          const target = resolve(realpathSync(dirname(file)), specifier)
          const resolved = existsSync(target) ? realpathSync(target) : target
          if (!inside(realpathSync(dir), resolved)) {
            errors.push(`${relative(directory, file)}: import ${specifier} leaves ${manifest.name}`)
          }
        } else if (specifier.startsWith('#')) {
          const keys = Object.keys(manifest.imports ?? {})
          if (
            !keys.some(
              (key) =>
                key === specifier ||
                (key.includes('*') &&
                  specifier.startsWith(key.split('*')[0]) &&
                  specifier.endsWith(key.split('*')[1]))
            )
          ) {
            errors.push(`${relative(directory, file)}: undeclared package import ${specifier}`)
          }
        } else {
          const name = specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0]
          if (!declared.has(name))
            errors.push(`${relative(directory, file)}: undeclared dependency ${name}`)
        }
      }
    }
  }
  return { packages: packages.length, files: checked, errors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkBoundaries()
  for (const error of result.errors) console.error(error)
  console.log(
    `Checked ${result.files} files in ${result.packages} packages; ${result.errors.length} boundary violations`
  )
  process.exitCode = result.errors.length ? 1 : 0
}
