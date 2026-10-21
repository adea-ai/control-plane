import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { Parser } from 'acorn'
import ts from 'typescript6'

const repositoryRoot = new URL('..', import.meta.url)
const scanRoots = ['packages', 'apps', 'scripts']
const requiredScanRoots = new Set(['packages', 'apps'])
const scanExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs'])
const ignoredDirectories = new Set(['node_modules', 'dist', 'coverage', '.turbo'])
const exceptionsPath = new URL('./digest-writer-exceptions.json', import.meta.url)
const digestFieldName = /(?:digest|hash|fingerprint|checksum|idempotency)/i
const persistenceMethods = new Set([
  'insert',
  'put',
  'save',
  'write',
  'upsert',
  'append',
  'persist',
])
const transientNodeKeys = new Set(['start', 'end', 'loc', 'range', 'raw', 'tokens', 'comments'])
const transpilers = new Map()
const analyzerStatsByResult = new WeakMap()

const isNode = (value) =>
  value !== null && typeof value === 'object' && typeof value.type === 'string'
const isFunctionNode = (node) =>
  node?.type === 'FunctionDeclaration' ||
  node?.type === 'FunctionExpression' ||
  node?.type === 'ArrowFunctionExpression'

function children(node) {
  const result = []
  for (const [key, value] of Object.entries(node)) {
    if (transientNodeKeys.has(key)) continue
    if (isNode(value)) result.push([value, key])
    else if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) result.push([child, key])
    }
  }
  return result
}

function visit(node, callback, parent = undefined, key = undefined) {
  if (!isNode(node)) return
  callback(node, parent, key)
  for (const [child, childKey] of children(node)) visit(child, callback, node, childKey)
}

function keyName(node) {
  if (!node) return undefined
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'PrivateIdentifier') return `#${node.name}`
  return undefined
}

function staticString(node) {
  if (!node) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((part) => part.value.cooked ?? part.value.raw).join('')
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left)
    const right = staticString(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

function memberName(node) {
  if (node?.type !== 'MemberExpression') return undefined
  return node.computed ? staticString(node.property) : keyName(node.property)
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function tokenFingerprint(source, start, end) {
  const tokenizer = Parser.tokenizer(source.slice(start, end), {
    ecmaVersion: 'latest',
    sourceType: 'module',
  })
  const tokens = []
  for (;;) {
    const token = tokenizer.getToken()
    if (token.type.label === 'eof') break
    const value = typeof token.value === 'bigint' ? `${token.value}n` : (token.value ?? null)
    tokens.push([token.type.label, value])
  }
  return createHash('sha256').update(JSON.stringify(tokens)).digest('hex')
}

function combineFingerprints(...parts) {
  return createHash('sha256').update(parts.join(':')).digest('hex')
}

function normalizePath(path) {
  return path.split(sep).join('/').replace(/^\.\//, '')
}

function transpileAndParse(path, source) {
  const extension = extname(path)
  const loader =
    extension === '.tsx'
      ? 'tsx'
      : extension === '.jsx'
        ? 'jsx'
        : ['.ts', '.mts', '.cts'].includes(extension)
          ? 'ts'
          : 'js'
  let transpiler = transpilers.get(loader)
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader, target: 'bun', jsx: 'react-jsx' })
    transpilers.set(loader, transpiler)
  }
  const javascript = transpiler.transformSync(source)
  const program = Parser.parse(javascript, {
    allowHashBang: true,
    ecmaVersion: 'latest',
    sourceType: 'module',
  })
  return { javascript, program }
}

function functionName(node, parent) {
  if (node.id?.name) return node.id.name
  if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier')
    return parent.id.name
  if (parent?.type === 'Property') return keyName(parent.key)
  if (parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') {
    return keyName(parent.key)
  }
  if (parent?.type === 'AssignmentExpression' && parent.left?.type === 'Identifier') {
    return parent.left.name
  }
  return undefined
}

function patternIdentifiers(pattern) {
  if (!pattern) return []
  if (pattern.type === 'Identifier') return [pattern]
  if (pattern.type === 'AssignmentPattern') return patternIdentifiers(pattern.left)
  if (pattern.type === 'RestElement') return patternIdentifiers(pattern.argument)
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(patternIdentifiers)
  if (pattern.type === 'ObjectPattern')
    return pattern.properties.flatMap((property) =>
      patternIdentifiers(property.type === 'RestElement' ? property.argument : property.value)
    )
  return []
}

function lexicalBinding(file, node, name = node?.name) {
  for (let scope = file.scopeByNode.get(node); scope; scope = scope.parent) {
    if (scope.bindings.has(name)) return scope.bindings.get(name)
  }
  return undefined
}

function bindingKey(file, node) {
  return lexicalBinding(file, node) ?? node.name
}

function parseFile(path, source) {
  const { javascript, program } = transpileAndParse(path, source)
  const parents = new WeakMap()
  const ownerByNode = new WeakMap()
  const functionByNode = new WeakMap()
  const scopeByNode = new WeakMap()
  const moduleScope = { kind: 'module', bindings: new Map() }
  const declare = (scope, pattern, initializer, kind = 'local') => {
    for (const identifier of patternIdentifiers(pattern)) {
      scope.bindings.set(identifier.name, {
        id: `${path}:${identifier.start}:${identifier.name}`,
        initializer,
        kind,
      })
    }
  }
  const functions = []
  const variableInitializers = new Map()
  const imports = new Map()
  const namespaceImports = new Map()
  const cryptoBindings = new Set()
  const hashVariables = new Set()

  const visitNode = (node, parent, key, inheritedOwner, enclosingFunction, inheritedScope) => {
    if (!isNode(node)) return
    if (parent) parents.set(node, parent)
    let scope = inheritedScope
    if (node.type === 'FunctionDeclaration' && node.id) declare(scope, node.id, node)
    if (node.type === 'VariableDeclarator') {
      let declarationScope = scope
      if (parent.kind === 'var') {
        while (declarationScope.parent && declarationScope.kind === 'block')
          declarationScope = declarationScope.parent
      }
      declare(declarationScope, node.id, node.init)
    }
    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers) declare(scope, specifier.local, undefined, 'import')
    }
    if (node.type === 'ClassDeclaration' && node.id) declare(scope, node.id, undefined)
    if (
      [
        'BlockStatement',
        'CatchClause',
        'ForStatement',
        'ForInStatement',
        'ForOfStatement',
        'SwitchStatement',
      ].includes(node.type)
    ) {
      scope = { kind: 'block', parent: scope, bindings: new Map() }
      if (node.type === 'CatchClause') declare(scope, node.param, undefined)
    }
    let owner = inheritedOwner ?? '<module>'
    let currentFunction = enclosingFunction
    if (isFunctionNode(node)) {
      scope = { kind: 'function', parent: scope, bindings: new Map() }
      for (const parameter of node.params) declare(scope, parameter, undefined)
      if (node.type === 'FunctionExpression' && node.id) declare(scope, node.id, node)
      const name = functionName(node, parent)
      if (name)
        owner =
          inheritedOwner && inheritedOwner !== '<module>' ? `${inheritedOwner}::${name}` : name
      const record = {
        body: node.body,
        name,
        node,
        owner,
        params: node.params,
        parentOwner: inheritedOwner ?? '<module>',
        path,
        scope,
      }
      functions.push(record)
      functionByNode.set(node, record)
      currentFunction = record
    }
    ownerByNode.set(node, owner)
    scopeByNode.set(node, scope)
    for (const [child, childKey] of children(node))
      visitNode(child, node, childKey, owner, currentFunction, scope)
  }
  visitNode(program, undefined, undefined, '<module>', undefined, moduleScope)

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      const moduleName = statement.source.value
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          const importedName = keyName(specifier.imported)
          imports.set(specifier.local.name, { importedName, moduleName })
          if (moduleName === 'node:crypto' && importedName === 'createHash') {
            cryptoBindings.add(specifier.local.name)
          }
        } else if (specifier.type === 'ImportDefaultSpecifier') {
          imports.set(specifier.local.name, { importedName: 'default', moduleName })
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          namespaceImports.set(specifier.local.name, moduleName)
          if (moduleName === 'node:crypto') cryptoBindings.add(specifier.local.name)
        }
      }
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.id.type === 'Identifier') {
          variableInitializers.set(declaration.id.name, declaration.init)
          if (
            isCreateHashExpression(declaration.init, {
              cryptoBindings,
              imports,
              namespaceImports,
              variableInitializers,
            })
          ) {
            hashVariables.add(declaration.id.name)
          }
        }
      }
    }
  }

  for (const record of functions) {
    record.variableInitializers = new Map(variableInitializers)
    record.cryptoBindings = cryptoBindings
    record.hashVariables = hashVariables
    collectFunctionVariables(record)
  }

  const file = {
    functions,
    functionByNode,
    scopeByNode,
    moduleScope,
    imports,
    javascript,
    namespaceImports,
    ownerByNode,
    parents,
    path,
    program,
    source,
    variableInitializers,
    cryptoBindings,
    hashVariables,
  }
  for (const record of functions) record.file = file
  file.sinkOccurrences = indexSinkOccurrences(file)
  return file
}

function collectFunctionVariables(record) {
  const walkBody = (node) => {
    if (!isNode(node) || (isFunctionNode(node) && node !== record.node)) return
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      record.variableInitializers.set(node.id.name, node.init)
      if (isCreateHashExpression(node.init, record)) record.hashVariables.add(node.id.name)
    }
    for (const [child] of children(node)) walkBody(child)
  }
  walkBody(record.body)
}

function isCreateHashExpression(expression, file) {
  if (!expression) return false
  if (expression.type === 'CallExpression') {
    const callee = expression.callee
    if (callee.type === 'Identifier') {
      if (file.cryptoBindings?.has(callee.name)) return true
      const binding = file.imports?.get(callee.name)
      if (binding?.moduleName === 'node:crypto' && binding.importedName === 'createHash')
        return true
      const alias = file.variableInitializers?.get(callee.name)
      if (alias && alias !== expression) return isCreateHashExpression(alias, file)
    }
    if (
      callee.type === 'MemberExpression' &&
      memberName(callee) === 'createHash' &&
      callee.object.type === 'Identifier' &&
      file.namespaceImports?.get(callee.object.name) === 'node:crypto'
    )
      return true
  }
  return false
}

function isLocaleCompareCall(node) {
  return node?.type === 'CallExpression' && memberName(node.callee) === 'localeCompare'
}

function isIntlCollatorFactory(node) {
  if (!node || !['CallExpression', 'NewExpression'].includes(node.type)) return false
  const callee = node.callee
  return (
    callee.type === 'MemberExpression' &&
    memberName(callee) === 'Collator' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Intl'
  )
}

function isIntlCollatorCompare(node, file, seen = new Set()) {
  if (node?.type !== 'MemberExpression' || memberName(node) !== 'compare') return false
  const object = node.object
  if (isIntlCollatorFactory(object)) return true
  if (object.type === 'Identifier') {
    const binding = lexicalBinding(file, object)
    if (!binding || seen.has(binding.id)) return false
    seen.add(binding.id)
    const initial = binding.initializer
    return isIntlCollatorFactory(initial) || isIntlCollatorCompare(initial, file, seen)
  }
  return false
}

function findLocaleComparatorNodes(expression, file, record, fileRecords, seen = new Set()) {
  if (!isNode(expression)) return []
  if (expression.type === 'Identifier') {
    const binding = lexicalBinding(file, expression)
    if (!binding || seen.has(binding.id)) return []
    seen.add(binding.id)
    const initializer = binding.initializer
    if (initializer) return findLocaleComparatorNodes(initializer, file, record, fileRecords, seen)
    const target = resolveFunctionTarget(expression, file, fileRecords)
    return target ? findFunctionLocaleComparators(target, fileRecords, seen) : []
  }
  if (isFunctionNode(expression))
    return findFunctionLocaleComparators(
      file.functionByNode.get(expression) ?? record,
      fileRecords,
      seen
    )
  if (isIntlCollatorCompare(expression, file)) return [{ file, node: expression }]
  const result = []
  visit(expression, (node) => {
    if (isLocaleCompareCall(node)) result.push({ file, node })
    else if (isIntlCollatorCompare(node, file)) result.push({ file, node })
  })
  return result
}

function findFunctionLocaleComparators(record, fileRecords, seen) {
  if (!record) return []
  const file = record.file
  const functionKey = `${file.path}:${record.owner}:${record.node.start}`
  if (seen.has(functionKey)) return []
  seen.add(functionKey)

  const result = []
  const walkBody = (node) => {
    if (!isNode(node)) return
    if (isFunctionNode(node)) return
    if (isLocaleCompareCall(node)) result.push({ file, node })
    else if (isIntlCollatorCompare(node, file)) result.push({ file, node })

    if (node.type === 'CallExpression') {
      const target = resolveFunctionTarget(node.callee, file, fileRecords)
      if (target) result.push(...findFunctionLocaleComparators(target, fileRecords, seen))
    }
    for (const [child] of children(node)) walkBody(child)
  }
  walkBody(record.body)
  return result
}

function buildSortSources(fileRecords) {
  const sources = new Map()
  const sourceById = new Map()
  const occurrences = new Map()
  for (const file of fileRecords.values()) {
    visit(file.program, (node) => {
      if (node.type !== 'CallExpression' || !['sort', 'toSorted'].includes(memberName(node.callee)))
        return
      const comparator = node.arguments[0]
      if (!comparator) return
      const record = nearestFunction(file, node)
      const comparatorNodes = findLocaleComparatorNodes(comparator, file, record, fileRecords)
      if (comparatorNodes.length === 0) return
      const statement = nearestStatement(file, node)
      for (const { file: comparatorFile, node: comparatorNode } of comparatorNodes) {
        const comparatorOwner =
          comparatorFile.ownerByNode.get(comparatorNode) ?? record?.owner ?? '<module>'
        const comparatorTokens = tokenFingerprint(
          comparatorFile.javascript,
          comparatorNode.start,
          comparatorNode.end
        )
        const sortTokens = tokenFingerprint(file.javascript, node.start, node.end)
        const statementTokens = statement
          ? tokenFingerprint(file.javascript, statement.start, statement.end)
          : sortTokens
        const fingerprint = combineFingerprints(sortTokens, statementTokens, comparatorTokens)
        const siteOwner = record?.owner ?? '<module>'
        const occurrenceKey = `${comparatorFile.path}:${comparatorOwner}:${file.path}:${siteOwner}:${fingerprint}`
        const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1
        occurrences.set(occurrenceKey, occurrence)
        const source = {
          fingerprint,
          kind: isLocaleCompareCall(comparatorNode) ? 'localeCompare' : 'Intl.Collator',
          line: lineAt(comparatorFile.javascript, comparatorNode.start),
          owner: comparatorOwner,
          occurrence,
          path: comparatorFile.path,
          siteOwner,
          sitePath: file.path,
        }
        const id = `${source.path}:${source.owner}:${source.sitePath}:${source.siteOwner}:${source.fingerprint}:${source.occurrence}`
        source.id = id
        sources.set(
          `${file.path}:${node.start}`,
          new Set([...(sources.get(`${file.path}:${node.start}`) ?? []), id])
        )
        sourceById.set(id, source)
      }
    })
  }
  return { sources, sourceById }
}

function nearestFunction(file, node) {
  let parent = file.parents.get(node)
  while (parent) {
    if (isFunctionNode(parent)) return file.functionByNode.get(parent)
    parent = file.parents.get(parent)
  }
  return undefined
}

function nearestStatement(file, node) {
  let current = node
  while (current) {
    if (
      current.type.endsWith('Statement') ||
      current.type === 'VariableDeclarator' ||
      current.type === 'Property'
    ) {
      return current
    }
    current = file.parents.get(current)
  }
  return node
}

function indexSinkOccurrences(file) {
  const occurrencesByNode = new WeakMap()
  const counts = new Map()
  visit(file.program, (node) => {
    const kinds = []
    if (node.type === 'CallExpression') {
      const name = memberName(node.callee)
      if (name === 'update') kinds.push('crypto-hash')
      if (persistenceMethods.has(name ?? '')) kinds.push('persistence')
    }
    if (
      node.type === 'Property' &&
      digestFieldName.test(staticString(node.key) ?? keyName(node.key) ?? '')
    ) {
      kinds.push('digest-field')
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.left.type === 'MemberExpression' &&
      digestFieldName.test(memberName(node.left) ?? '')
    ) {
      kinds.push('digest-field')
    }
    if (kinds.length === 0) return

    const owner = file.ownerByNode.get(node) ?? '<module>'
    const statement = nearestStatement(file, node)
    const nodeFingerprint = tokenFingerprint(file.javascript, node.start, node.end)
    const statementFingerprint = statement
      ? tokenFingerprint(file.javascript, statement.start, statement.end)
      : nodeFingerprint
    let nodeOccurrences = occurrencesByNode.get(node)
    if (!nodeOccurrences) {
      nodeOccurrences = new Map()
      occurrencesByNode.set(node, nodeOccurrences)
    }
    for (const kind of kinds) {
      const key = `${file.path}:${owner}:${kind}:${node.type}:${nodeFingerprint}:${statementFingerprint}`
      const occurrence = (counts.get(key) ?? 0) + 1
      counts.set(key, occurrence)
      nodeOccurrences.set(kind, occurrence)
    }
  })
  return occurrencesByNode
}

function resolveImportPath(fromPath, moduleName, fileRecords) {
  if (moduleName.startsWith('@control-plane/')) {
    const [packageName, ...subpath] = moduleName.slice('@control-plane/'.length).split('/')
    const baseDirectory = `packages/${packageName}`
    const base =
      subpath.length > 0
        ? `${baseDirectory}/src/${subpath.join('/')}`
        : `${baseDirectory}/src/index.ts`
    const candidates = [base]
    const extension = extname(base)
    if (extension === '.js')
      candidates.push(
        `${base.slice(0, -3)}.ts`,
        `${base.slice(0, -3)}.tsx`,
        `${base.slice(0, -3)}.mts`
      )
    else if (!extension) {
      for (const suffix of ['.ts', '.tsx', '.mts', '.cts', '.mjs'])
        candidates.push(`${base}${suffix}`)
      for (const suffix of ['/index.ts', '/index.tsx', '/index.mts', '/index.mjs'])
        candidates.push(`${base}${suffix}`)
    }
    const packagePath = candidates
      .map(normalizePath)
      .find((candidate) => fileRecords.has(candidate))
    if (packagePath) return packagePath
  }
  if (!moduleName.startsWith('.')) return undefined
  const base = normalizePath(join(dirname(fromPath), moduleName))
  const candidates = [base]
  const extension = extname(base)
  if (extension === '.js')
    candidates.push(
      `${base.slice(0, -3)}.ts`,
      `${base.slice(0, -3)}.tsx`,
      `${base.slice(0, -3)}.mts`
    )
  else if (extension === '.mjs')
    candidates.push(
      `${base.slice(0, -4)}.mjs`,
      `${base.slice(0, -4)}.ts`,
      `${base.slice(0, -4)}.mts`
    )
  else if (!extension) {
    for (const suffix of ['.ts', '.tsx', '.mts', '.cts', '.mjs'])
      candidates.push(`${base}${suffix}`)
    for (const suffix of ['/index.ts', '/index.tsx', '/index.mts', '/index.mjs'])
      candidates.push(`${base}${suffix}`)
  }
  return candidates.map(normalizePath).find((candidate) => fileRecords.has(candidate))
}

function resolveFunctionTarget(expression, file, fileRecords, seen = new Set()) {
  if (!expression) return undefined
  if (expression.type === 'Identifier') {
    const name = expression.name
    const binding = lexicalBinding(file, expression)
    if (!binding) return undefined
    if (seen.has(binding.id)) return undefined
    seen.add(binding.id)
    const initializer = binding.initializer
    if (initializer) {
      if (isFunctionNode(initializer)) return file.functionByNode.get(initializer)
      return resolveFunctionTarget(initializer, file, fileRecords, seen)
    }
    // A local/parameter declaration shadows an import even without a callable initializer.
    if (binding.kind !== 'import') return undefined
    const imported = file.imports.get(name)
    if (!imported) return undefined
    const importedPath = resolveImportPath(file.path, imported.moduleName, fileRecords)
    const targetFile = importedPath && fileRecords.get(importedPath)
    return (
      targetFile && resolveExportedFunction(targetFile, imported.importedName, fileRecords, seen)
    )
  }
  if (expression.type === 'MemberExpression' && expression.object.type === 'Identifier') {
    if (lexicalBinding(file, expression.object)?.kind !== 'import') return undefined
    const moduleName = file.namespaceImports.get(expression.object.name)
    const importedName = memberName(expression)
    if (!moduleName || !importedName) return undefined
    const importedPath = resolveImportPath(file.path, moduleName, fileRecords)
    const targetFile = importedPath && fileRecords.get(importedPath)
    return targetFile && resolveExportedFunction(targetFile, importedName, fileRecords, seen)
  }
  return undefined
}

function resolveExportedFunction(file, exportedName, fileRecords, seen = new Set()) {
  if (!file || !exportedName) return undefined
  const key = `${file.path}:${exportedName}`
  if (seen.has(key)) return undefined
  seen.add(key)
  const direct = file.moduleScope.bindings.get(exportedName)?.initializer
  if (direct && isFunctionNode(direct)) return file.functionByNode.get(direct)

  if (exportedName === 'default') {
    for (const statement of file.program.body) {
      if (statement.type !== 'ExportDefaultDeclaration') continue
      if (isFunctionNode(statement.declaration)) {
        return file.functionByNode.get(statement.declaration)
      }
      if (statement.declaration.type === 'Identifier') {
        return resolveFunctionTarget(statement.declaration, file, fileRecords, seen)
      }
    }
  }

  for (const statement of file.program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration) {
        const declarationName = statement.declaration.id?.name
        if (declarationName === exportedName) {
          return file.functionByNode.get(statement.declaration)
        }
      }
      for (const specifier of statement.specifiers) {
        if (keyName(specifier.exported) !== exportedName) continue
        if (statement.source) {
          const targetPath = resolveImportPath(file.path, statement.source.value, fileRecords)
          const targetFile = targetPath && fileRecords.get(targetPath)
          return (
            targetFile &&
            resolveExportedFunction(targetFile, keyName(specifier.local), fileRecords, seen)
          )
        }
        return resolveFunctionTarget(specifier.local, file, fileRecords, seen)
      }
    }
    if (statement.type === 'ExportAllDeclaration') {
      const targetPath = resolveImportPath(file.path, statement.source.value, fileRecords)
      const targetFile = targetPath && fileRecords.get(targetPath)
      const result =
        targetFile && resolveExportedFunction(targetFile, exportedName, fileRecords, seen)
      if (result) return result
    }
  }
  return undefined
}

function bindPattern(pattern, value, environment, file) {
  if (!pattern) return
  if (pattern.type === 'Identifier') {
    environment.set(bindingKey(file, pattern), new Set(value))
    return
  }
  if (pattern.type === 'AssignmentPattern') {
    bindPattern(pattern.left, value, environment, file)
    return
  }
  if (pattern.type === 'RestElement') {
    bindPattern(pattern.argument, value, environment, file)
    return
  }
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) bindPattern(element, value, environment, file)
    return
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') bindPattern(property.argument, value, environment, file)
      else bindPattern(property.value, value, environment, file)
    }
  }
}

function union(...values) {
  const result = new Set()
  for (const value of values) if (value) for (const entry of value) result.add(entry)
  return result
}

function cloneEnvironment(environment) {
  return new Map([...environment].map(([key, value]) => [key, new Set(value)]))
}

function localeSourceId(value) {
  if (value.startsWith('@digest:')) return value.slice('@digest:'.length)
  return value.startsWith('@parameter:') ? undefined : value
}

function isDigestValue(value) {
  return value.startsWith('@digest:')
}

function hashReceiver(expression, file, seen = new Set()) {
  if (!expression) return undefined
  if (expression.type === 'CallExpression') {
    if (isCreateHashExpression(expression, file)) return { allocation: expression }
    if (memberName(expression.callee) === 'update')
      return hashReceiver(expression.callee.object, file, seen)
  }
  if (expression.type === 'Identifier') {
    const binding = lexicalBinding(file, expression)
    if (!binding || seen.has(binding)) return undefined
    seen.add(binding)
    const receiver = hashReceiver(binding.initializer, file, seen)
    if (receiver) return { ...receiver, binding: receiver.binding ?? binding }
  }
  return undefined
}

function createAnalyzer(fileRecords) {
  const { sources: sortSources, sourceById } = buildSortSources(fileRecords)
  const flows = new Map()
  const returnTaintCache = new Map()
  const analyzerStats = { functionEvaluations: 0, functionCacheHits: 0, recursiveFallbacks: 0 }

  const report = (file, node, owner, kind, taints) => {
    if (!node) return
    const statement = nearestStatement(file, node)
    const nodeFingerprint = tokenFingerprint(file.javascript, node.start, node.end)
    const statementFingerprint = statement
      ? tokenFingerprint(file.javascript, statement.start, statement.end)
      : nodeFingerprint
    const sink = {
      fingerprint: combineFingerprints(nodeFingerprint, statementFingerprint),
      kind,
      line: lineAt(file.javascript, node.start),
      owner,
      occurrence: file.sinkOccurrences.get(node)?.get(kind) ?? 1,
      path: file.path,
    }
    for (const id of taints) {
      const source = sourceById.get(localeSourceId(id))
      if (!source) continue
      const flow = { sink, source }
      const key = flowKey(flow)
      flows.set(key, flow)
    }
  }

  const moduleEnvironments = new Map()
  const capturedEnvironments = new Map()
  const captureFunction = (node, environment, file) => {
    const target = file.functionByNode.get(node)
    if (!target) return
    const captures = capturedEnvironments.get(target) ?? new Set()
    captures.add(environment)
    capturedEnvironments.set(target, captures)
  }

  const evalExpression = (node, environment, file, record, callStack) => {
    if (!isNode(node)) return new Set()
    if (
      isFunctionNode(node) ||
      node.type === 'FunctionDeclaration' ||
      node.type === 'ClassDeclaration'
    ) {
      captureFunction(node, environment, file)
      return new Set()
    }
    switch (node.type) {
      case 'Identifier': {
        const receiver = hashReceiver(node, file)
        return union(
          environment.get(bindingKey(file, node)),
          receiver?.binding && environment.get(receiver.binding)
        )
      }
      case 'ParenthesizedExpression':
      case 'ChainExpression':
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'UnaryExpression':
      case 'UpdateExpression':
      case 'SpreadElement':
      case 'RestElement':
      case 'TSAsExpression':
      case 'TSTypeAssertion':
        return evalExpression(
          node.argument ?? node.expression,
          environment,
          file,
          record,
          callStack
        )
      case 'MemberExpression':
        return evalExpression(node.object, environment, file, record, callStack)
      case 'ArrayExpression':
        return union(
          ...node.elements.map((element) =>
            evalExpression(element, environment, file, record, callStack)
          )
        )
      case 'ObjectExpression': {
        const values = []
        for (const property of node.properties) {
          if (property.type === 'SpreadElement') {
            values.push(evalExpression(property.argument, environment, file, record, callStack))
            continue
          }
          const value = evalExpression(property.value, environment, file, record, callStack)
          values.push(value)
          if (digestFieldName.test(staticString(property.key) ?? keyName(property.key) ?? '')) {
            report(file, property, record?.owner ?? '<module>', 'digest-field', value)
          }
        }
        return union(...values)
      }
      case 'CallExpression': {
        const calleeName = memberName(node.callee)
        const argumentTaints = node.arguments.map((argument) =>
          argument.type === 'SpreadElement'
            ? evalExpression(argument.argument, environment, file, record, callStack)
            : evalExpression(argument, environment, file, record, callStack)
        )
        const receiverTaints =
          node.callee.type === 'MemberExpression'
            ? evalExpression(node.callee.object, environment, file, record, callStack)
            : new Set()
        const sortTaints = sortSources.get(`${file.path}:${node.start}`) ?? new Set()

        if (
          calleeName === 'sort' &&
          node.callee.object?.type === 'Identifier' &&
          sortTaints.size > 0
        ) {
          environment.set(bindingKey(file, node.callee.object), union(receiverTaints, sortTaints))
        }

        const hash = calleeName === 'update' ? hashReceiver(node.callee.object, file) : undefined
        if (hash) {
          report(
            file,
            node,
            record?.owner ?? '<module>',
            'crypto-hash',
            argumentTaints[0] ?? new Set()
          )
          const hashed = new Set(
            [...(argumentTaints[0] ?? [])]
              .map(localeSourceId)
              .filter(Boolean)
              .map((sourceId) => `@digest:${sourceId}`)
          )
          const state = union(receiverTaints, hashed)
          if (hash.binding) environment.set(hash.binding, state)
          return state
        }
        if (persistenceMethods.has(calleeName ?? '')) {
          const persistedDigests = union(
            ...argumentTaints.filter((value) => [...value].some(isDigestValue))
          )
          if (persistedDigests.size > 0) {
            report(file, node, record?.owner ?? '<module>', 'persistence', persistedDigests)
          }
        }

        const target = resolveFunctionTarget(node.callee, file, fileRecords)
        if (target) {
          return union(evaluateFunction(target, argumentTaints, callStack, environment), sortTaints)
        }

        if (calleeName === 'digest') return union(receiverTaints)
        if (sortTaints.size > 0) return union(receiverTaints, sortTaints)
        return union(receiverTaints, ...argumentTaints)
      }
      case 'NewExpression':
        return union(
          ...node.arguments.map((argument) =>
            evalExpression(argument, environment, file, record, callStack)
          )
        )
      case 'BinaryExpression':
      case 'LogicalExpression':
        return union(
          evalExpression(node.left, environment, file, record, callStack),
          evalExpression(node.right, environment, file, record, callStack)
        )
      case 'ConditionalExpression':
        return union(
          evalExpression(node.test, environment, file, record, callStack),
          evalExpression(node.consequent, environment, file, record, callStack),
          evalExpression(node.alternate, environment, file, record, callStack)
        )
      case 'SequenceExpression':
        return union(
          ...node.expressions.map((expression) =>
            evalExpression(expression, environment, file, record, callStack)
          )
        )
      case 'TemplateLiteral':
        return union(
          ...node.expressions.map((expression) =>
            evalExpression(expression, environment, file, record, callStack)
          )
        )
      case 'TaggedTemplateExpression':
        return union(
          evalExpression(node.tag, environment, file, record, callStack),
          evalExpression(node.quasi, environment, file, record, callStack)
        )
      case 'AssignmentExpression': {
        const right = evalExpression(node.right, environment, file, record, callStack)
        if (node.left.type === 'Identifier')
          environment.set(bindingKey(file, node.left), new Set(right))
        if (
          node.left.type === 'MemberExpression' &&
          digestFieldName.test(memberName(node.left) ?? '')
        ) {
          report(file, node, record?.owner ?? '<module>', 'digest-field', right)
        }
        return right
      }
      case 'Property': {
        const value = evalExpression(node.value, environment, file, record, callStack)
        if (digestFieldName.test(staticString(node.key) ?? keyName(node.key) ?? '')) {
          report(file, node, record?.owner ?? '<module>', 'digest-field', value)
        }
        return value
      }
      case 'ObjectPattern':
      case 'ArrayPattern':
        return new Set()
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return new Set()
      default: {
        const taints = []
        for (const [child] of children(node))
          taints.push(evalExpression(child, environment, file, record, callStack))
        return union(...taints)
      }
    }
  }

  const evaluateStatement = (statement, environment, file, record, callStack) => {
    if (!isNode(statement)) return { environment, returns: new Set() }
    switch (statement.type) {
      case 'Program':
      case 'BlockStatement': {
        let current = environment
        let returns = new Set()
        for (const child of statement.body) {
          const result = evaluateStatement(child, current, file, record, callStack)
          current = result.environment
          returns = union(returns, result.returns)
        }
        return { environment: current, returns }
      }
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        if (!statement.declaration) return { environment, returns: new Set() }
        if (statement.declaration.type.endsWith('Declaration'))
          return evaluateStatement(statement.declaration, environment, file, record, callStack)
        return {
          environment,
          returns: evalExpression(statement.declaration, environment, file, record, callStack),
        }
      case 'VariableDeclaration': {
        for (const declaration of statement.declarations) {
          const value = evalExpression(declaration.init, environment, file, record, callStack)
          bindPattern(declaration.id, value, environment, file)
        }
        return { environment, returns: new Set() }
      }
      case 'ReturnStatement':
        return {
          environment,
          returns: evalExpression(statement.argument, environment, file, record, callStack),
        }
      case 'ExpressionStatement':
      case 'ThrowStatement':
        evalExpression(
          statement.expression ?? statement.argument,
          environment,
          file,
          record,
          callStack
        )
        return { environment, returns: new Set() }
      case 'IfStatement': {
        evalExpression(statement.test, environment, file, record, callStack)
        const left = evaluateStatement(
          statement.consequent,
          cloneEnvironment(environment),
          file,
          record,
          callStack
        )
        const right = statement.alternate
          ? evaluateStatement(
              statement.alternate,
              cloneEnvironment(environment),
              file,
              record,
              callStack
            )
          : { environment: cloneEnvironment(environment), returns: new Set() }
        mergeEnvironment(environment, left.environment, right.environment)
        return { environment, returns: union(left.returns, right.returns) }
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement': {
        for (const key of ['init', 'left', 'right', 'test', 'update']) {
          const child = statement[key]
          if (!child) continue
          if (child.type?.endsWith('Declaration'))
            evaluateStatement(child, environment, file, record, callStack)
          else evalExpression(child, environment, file, record, callStack)
        }
        const body = evaluateStatement(
          statement.body,
          cloneEnvironment(environment),
          file,
          record,
          callStack
        )
        mergeEnvironment(environment, body.environment)
        return { environment, returns: body.returns }
      }
      case 'SwitchStatement': {
        evalExpression(statement.discriminant, environment, file, record, callStack)
        const outcomes = statement.cases.map((branch) => {
          const branchEnvironment = cloneEnvironment(environment)
          evalExpression(branch.test, branchEnvironment, file, record, callStack)
          return evaluateStatement(
            { type: 'BlockStatement', body: branch.consequent },
            branchEnvironment,
            file,
            record,
            callStack
          )
        })
        mergeEnvironment(environment, ...outcomes.map((outcome) => outcome.environment))
        return { environment, returns: union(...outcomes.map((outcome) => outcome.returns)) }
      }
      case 'TryStatement': {
        const outcomes = [
          evaluateStatement(
            statement.block,
            cloneEnvironment(environment),
            file,
            record,
            callStack
          ),
        ]
        if (statement.handler)
          outcomes.push(
            evaluateStatement(
              statement.handler.body,
              cloneEnvironment(environment),
              file,
              record,
              callStack
            )
          )
        if (statement.finalizer)
          outcomes.push(
            evaluateStatement(
              statement.finalizer,
              cloneEnvironment(environment),
              file,
              record,
              callStack
            )
          )
        mergeEnvironment(environment, ...outcomes.map((outcome) => outcome.environment))
        return { environment, returns: union(...outcomes.map((outcome) => outcome.returns)) }
      }
      case 'FunctionDeclaration':
        captureFunction(statement, environment, file)
        return { environment, returns: new Set() }
      case 'ClassDeclaration':
        return { environment, returns: new Set() }
      default:
        for (const [child] of children(statement)) {
          if (
            isFunctionNode(child) ||
            child.type === 'FunctionDeclaration' ||
            child.type === 'ClassDeclaration'
          )
            continue
          if (child.type.endsWith('Statement') || child.type === 'VariableDeclaration') {
            evaluateStatement(child, environment, file, record, callStack)
          } else evalExpression(child, environment, file, record, callStack)
        }
        return { environment, returns: new Set() }
    }
  }

  const mergeEnvironment = (destination, ...sources) => {
    for (const source of sources) {
      for (const [name, value] of source) destination.set(name, union(destination.get(name), value))
    }
  }

  const evaluateFunction = (record, argumentTaints, callStack, callerEnvironment) => {
    const invocationKey = `${record.path}:${record.node.start}`
    const environment = new Map()
    const inherited = [
      moduleEnvironments.get(record.file),
      ...(capturedEnvironments.get(record) ?? []),
      callerEnvironment,
    ]
    for (let scope = record.scope.parent; scope; scope = scope.parent) {
      for (const binding of scope.bindings.values()) {
        const taints = union(...inherited.map((values) => values?.get(binding)))
        if (taints.size > 0) environment.set(binding, taints)
      }
    }
    if (callStack.has(invocationKey)) {
      analyzerStats.recursiveFallbacks += 1
      return union(...argumentTaints, ...environment.values())
    }
    const taintKey = JSON.stringify(argumentTaints.map((taints) => [...taints].toSorted()))
    const captureKey = JSON.stringify(
      [...environment]
        .map(([binding, taints]) => [binding.id, [...taints].toSorted()])
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    )
    const cacheKey = `${invocationKey}\n${taintKey}\n${captureKey}`
    const cached = returnTaintCache.get(cacheKey)
    if (cached) {
      analyzerStats.functionCacheHits += 1
      return new Set(cached)
    }
    analyzerStats.functionEvaluations += 1
    const nextStack = new Set(callStack)
    nextStack.add(invocationKey)
    record.params.forEach((parameter, index) => {
      bindPattern(
        parameter,
        argumentTaints[index] ?? new Set([`@parameter:${index}`]),
        environment,
        record.file
      )
    })
    let result
    if (record.node.body.type !== 'BlockStatement') {
      result = evalExpression(record.node.body, environment, record.file, record, nextStack)
    } else {
      result = evaluateStatement(
        record.node.body,
        environment,
        record.file,
        record,
        nextStack
      ).returns
    }
    returnTaintCache.set(cacheKey, new Set(result))
    return result
  }

  for (const file of fileRecords.values()) moduleEnvironments.set(file, new Map())
  // Imports may be enumerated before their dependencies. Reach a monotone
  // fixed point over finite binding/taint sets instead of trusting file order.
  let moduleTaintsChanged
  do {
    moduleTaintsChanged = false
    for (const file of fileRecords.values()) {
      const previous = moduleEnvironments.get(file)
      const evaluated = cloneEnvironment(previous)
      evaluateStatement(file.program, evaluated, file, undefined, new Set())
      for (const [binding, taints] of evaluated) {
        const combined = union(previous.get(binding), taints)
        if (combined.size > (previous.get(binding)?.size ?? 0)) moduleTaintsChanged = true
        previous.set(binding, combined)
      }
    }
  } while (moduleTaintsChanged)
  for (const file of fileRecords.values()) {
    for (const record of file.functions) {
      evaluateFunction(
        record,
        record.params.map((_, index) => new Set([`@parameter:${index}`])),
        new Set()
      )
    }
  }

  const result = [...flows.values()].toSorted((left, right) => {
    const leftKey = flowKey(left)
    const rightKey = flowKey(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  analyzerStatsByResult.set(result, analyzerStats)
  return result
}

function flowKey(flow) {
  return [
    flow.source.path,
    flow.source.owner,
    flow.source.fingerprint,
    flow.source.sitePath,
    flow.source.siteOwner,
    flow.source.occurrence,
    flow.sink.path,
    flow.sink.owner,
    flow.sink.fingerprint,
    flow.sink.kind,
    flow.sink.occurrence,
  ].join('|')
}

export function matchesDigestWriterException(flow, exception) {
  return (
    flow.source.path === exception.source.path &&
    flow.source.owner === exception.source.owner &&
    flow.source.fingerprint === exception.source.fingerprint &&
    flow.source.sitePath === exception.source.sitePath &&
    flow.source.siteOwner === exception.source.siteOwner &&
    flow.source.occurrence === (exception.source.occurrence ?? 1) &&
    flow.sink.path === exception.sink.path &&
    flow.sink.owner === exception.sink.owner &&
    flow.sink.fingerprint === exception.sink.fingerprint &&
    flow.sink.kind === exception.sink.kind &&
    flow.sink.occurrence === (exception.sink.occurrence ?? 1)
  )
}

export function findUnapprovedDigestWriterFlows(flows, exceptions) {
  return flows.filter(
    (flow) => !exceptions.some((exception) => matchesDigestWriterException(flow, exception))
  )
}

function pathError(message, cause) {
  return new Error(message, { cause })
}

async function* walk(directory, fileSystem) {
  let entries
  try {
    entries = await fileSystem.readdir(directory, { withFileTypes: true })
  } catch (cause) {
    throw pathError(`could not read digest writer source directory ${directory}`, cause)
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) yield* walk(path, fileSystem)
    } else if (scanExtensions.has(extname(entry.name)) && !entry.name.includes('.test.')) {
      yield path
    }
  }
}

export async function collectDigestWriterFlows(
  root = repositoryRoot.pathname,
  fileSystem = { readdir, readFile, stat }
) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new Error('digest writer scan root must be a non-empty path')
  }
  const absoluteRoot = resolve(root)
  let rootStat
  try {
    rootStat = await fileSystem.stat(absoluteRoot)
  } catch (cause) {
    throw pathError(`could not inspect digest writer scan root ${absoluteRoot}`, cause)
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`digest writer scan root must be a directory: ${absoluteRoot}`)
  }
  let rootEntries
  try {
    rootEntries = await fileSystem.readdir(absoluteRoot, { withFileTypes: true })
  } catch (cause) {
    throw pathError(`could not read digest writer scan root ${absoluteRoot}`, cause)
  }
  const topLevelEntries = new Set(rootEntries.map((entry) => entry.name))

  const sources = new Map()
  let productionSourceCount = 0
  for (const scanRoot of scanRoots) {
    const directory = join(absoluteRoot, scanRoot)
    if (!topLevelEntries.has(scanRoot)) {
      if (requiredScanRoots.has(scanRoot)) {
        throw new Error(`required scan root ${directory} is missing`)
      }
      continue
    }

    let directoryStat
    try {
      directoryStat = await fileSystem.stat(directory)
    } catch (cause) {
      throw pathError(`could not inspect digest writer scan root ${directory}`, cause)
    }
    if (!directoryStat.isDirectory()) {
      throw new Error(`digest writer scan root must be a directory: ${directory}`)
    }

    for await (const path of walk(directory, fileSystem)) {
      const relativePath = normalizePath(relative(absoluteRoot, path))
      let source
      try {
        source = await fileSystem.readFile(path, 'utf8')
      } catch (cause) {
        throw pathError(`could not read digest writer source file ${path}`, cause)
      }
      sources.set(relativePath, source)
      if (scanRoot === 'packages' || scanRoot === 'apps') productionSourceCount += 1
    }
  }
  if (productionSourceCount === 0) {
    throw new Error(`no production source files found under apps/ or packages/ at ${absoluteRoot}`)
  }
  const relevantSources = selectRelevantSources(sources)
  const flows = findDigestWriterFlows(relevantSources)
  flows.scanStats = {
    sourceFiles: sources.size,
    candidateFiles: relevantSources.size,
    ...analyzerStatsByResult.get(flows),
  }
  return flows
}

function staticImportRecords(path, source) {
  if (!/\b(?:import|export)\b/.test(source)) return []
  const program = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false)
  const usedNames = new Set()
  const collectUses = (node) => {
    if (ts.isIdentifier(node)) usedNames.add(node.text)
    ts.forEachChild(node, collectUses)
  }
  const records = []
  for (const statement of program.statements) {
    const isImport = ts.isImportDeclaration(statement)
    const isExport = ts.isExportDeclaration(statement)
    if ((!isImport && !isExport) || (isExport && !statement.moduleSpecifier)) {
      collectUses(statement)
      continue
    }
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const localNames = []
    const clause = isImport ? statement.importClause : statement.exportClause
    if (isImport && clause?.name) localNames.push(clause.name.text)
    const bindings = isImport ? clause?.namedBindings : clause
    if (bindings && ts.isNamedImports(bindings)) {
      localNames.push(...bindings.elements.map((specifier) => specifier.name.text))
    }
    const namespace = bindings && ts.isNamespaceImport(bindings) ? bindings.name.text : undefined
    if (namespace) localNames.push(namespace)
    records.push({
      isExport,
      localNames,
      moduleName: statement.moduleSpecifier.text,
      namespace,
      usedNames,
    })
  }
  return records
}

export function selectRelevantSources(sources) {
  const fileSet = new Map(sources)
  const imports = new Map()
  const importers = new Map()
  for (const [path, source] of sources) {
    const dependencies = []
    const bindings = []
    for (const record of staticImportRecords(path, source)) {
      const dependency = resolveImportPath(path, record.moduleName, fileSet)
      if (!dependency) continue
      dependencies.push(dependency)
      const usages = { ...record, path }
      importers.set(dependency, [...(importers.get(dependency) ?? []), usages])
      bindings.push(usages)
    }
    imports.set(path, { dependencies, bindings })
  }

  const selected = new Set()
  const pending = []
  for (const [path, source] of sources) {
    if (
      path !== 'scripts/check-digest-writers.mjs' &&
      /localeCompare|Intl\s*\.\s*Collator|['"]locale['"]\s*\+/i.test(source)
    ) {
      selected.add(path)
      pending.push(path)
    }
  }

  // Follow the full static importer closure, but admit only re-export barrels,
  // likely digest writers, and modules that use an imported binding from an
  // affected module in an exported wrapper. This preserves innocuously named
  // helper chains without treating every consumer of a shared package as a
  // digest writer.
  const likelyWriterOrBarrel =
    /(?:\w*(?:hash|digest|fingerprint|checksum|idempotency|operationkey)\w*|\b(?:createHash|createHmac)\b|\b(?:insert|put|save|write|upsert|append|persist)\s*\(|\bexport\s*(?:\*|\{))/i
  while (pending.length > 0) {
    const dependency = pending.pop()
    for (const edge of importers.get(dependency) ?? []) {
      const importer = edge.path
      if (selected.has(importer) || importer === 'scripts/check-digest-writers.mjs') continue
      const importerSource = sources.get(importer) ?? ''
      const importsAffectedBinding =
        edge.isExport || edge.localNames.some((name) => edge.usedNames.has(name))
      const exportedWrapper =
        /\bexport\s+(?:async\s+)?(?:function|const|let|var|class|default)\b/.test(importerSource)
      if (
        !importsAffectedBinding ||
        (!edge.isExport && !likelyWriterOrBarrel.test(importerSource) && !exportedWrapper)
      )
        continue
      selected.add(importer)
      pending.push(importer)
    }
  }

  // Include statically imported crypto helpers reachable from an affected
  // writer. This keeps ordinary unrelated modules out of the AST while
  // preserving the local call graph for hash implementations.
  const sinkPending = [...selected]
  while (sinkPending.length > 0) {
    const importer = sinkPending.pop()
    for (const dependency of imports.get(importer)?.dependencies ?? []) {
      if (selected.has(dependency)) continue
      const source = sources.get(dependency) ?? ''
      if (!/node:crypto|createHash|\.digest\s*\(/.test(source)) continue
      selected.add(dependency)
      sinkPending.push(dependency)
    }
  }

  return new Map([...selected].map((path) => [path, sources.get(path)]))
}

async function readExceptions() {
  try {
    const parsed = JSON.parse(await readFile(exceptionsPath, 'utf8'))
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.exceptions)) {
      throw new Error('digest writer exceptions file has an unsupported schema')
    }
    return parsed.exceptions
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function formatFlow(flow) {
  return `${flow.sink.path}:${flow.sink.line} ${flow.sink.kind} in ${flow.sink.owner} receives locale-dependent bytes from ${flow.source.path}:${flow.source.line} ${flow.source.kind} in ${flow.source.owner}`
}

if (import.meta.main) {
  try {
    const rootArgument = process.argv.find((argument) => argument.startsWith('--root='))
    const root = rootArgument ? rootArgument.slice('--root='.length) : repositoryRoot.pathname
    const flows = await collectDigestWriterFlows(root)
    if (process.argv.includes('--stats')) console.error(JSON.stringify(flows.scanStats))
    if (process.argv.includes('--list-flows')) {
      console.log(JSON.stringify(flows, null, 2))
      process.exit(0)
    }
    const exceptions = await readExceptions()
    const unapproved = findUnapprovedDigestWriterFlows(flows, exceptions)
    if (unapproved.length > 0) {
      console.error(
        [
          'unapproved locale-dependent digest writer flows detected:',
          ...unapproved.map((flow) => `  ${formatFlow(flow)}`),
          '',
          'Use compareCodePointOrder/canonicalJsonStringify for new writers. Preserve historical',
          'formats only through exact source/sink exceptions in scripts/digest-writer-exceptions.json.',
          'The legacy CANONICAL-JSON marker is diagnostic only and never grants an exception.',
        ].join('\n')
      )
      process.exitCode = 1
    } else {
      console.log(
        `digest writer check passed: ${flows.length} flows matched exact reviewed exceptions`
      )
    }
  } catch (error) {
    console.error(
      `digest writer check could not analyze source: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

export function findDigestWriterFlows(sources) {
  const entries = sources instanceof Map ? [...sources] : Object.entries(sources)
  const fileRecords = new Map()
  for (const [path, source] of entries) {
    const normalized = normalizePath(path)
    fileRecords.set(normalized, parseFile(normalized, source))
  }
  return createAnalyzer(fileRecords)
}
