import { expect, test } from 'bun:test'
import {
  readPersistenceTransaction,
  withPersistenceReadScope,
  writePersistenceTransaction,
} from './read-scope.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const release = deferred()
  const calls = []
  const transaction = Object.fromEntries(
    ['get', 'list', 'scan'].map((name) => [
      name,
      async () => {
        calls.push(name)
        await release.promise
        return name
      },
    ])
  )
  let commits = 0
  const provider = {
    transaction: async (operation) => {
      const value = await operation(transaction)
      commits++
      return value
    },
  }
  return { provider, transaction, release, calls, commits: () => commits }
}

for (const name of ['get', 'list', 'scan']) {
  test(`detached individual ${name} prevents scoped transaction commit after its callback returns`, async () => {
    const f = fixture()
    let pending
    let result
    try {
      result = await f.provider
        .transaction((tx) =>
          withPersistenceReadScope(f.provider, tx, async () => {
            await readPersistenceTransaction(f.provider, async (read) => {
              pending = read[name]('scope-proof', 'value').catch((error) => error.message)
              return 'callback-completed'
            })
            return 'committed'
          })
        )
        .then(
          () => 'unsafe-commit',
          (error) => error.message
        )
    } finally {
      f.release.resolve()
      if (pending) expect(await pending).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
    }
    expect(result).toBe('PERSISTENCE_READ_SCOPE_PENDING')
    expect(f.commits()).toBe(0)
    expect(f.calls).toEqual([name])
  })
}

test('a different provider object cannot borrow the first transaction through a captured reader', async () => {
  const first = fixture(),
    second = fixture()
  first.release.resolve()
  second.release.resolve()
  let captured
  await withPersistenceReadScope(first.provider, first.transaction, async () => {
    await readPersistenceTransaction(first.provider, async (read) => {
      captured = read
    })
    await withPersistenceReadScope(second.provider, second.transaction, async () => {
      await expect(captured.get('scope-proof', 'value')).rejects.toThrow(
        'PERSISTENCE_READ_SCOPE_MISMATCH'
      )
      expect(
        await readPersistenceTransaction(second.provider, (read) =>
          read.get('scope-proof', 'value')
        )
      ).toBe('get')
    })
    expect(await captured.get('scope-proof', 'value')).toBe('get')
  })
  expect(first.calls).toEqual(['get'])
  expect(second.calls).toEqual(['get'])
})

test('nested same-provider scope expires its captured reader and restores the active outer reader', async () => {
  const outer = fixture(),
    inner = fixture()
  outer.release.resolve()
  inner.release.resolve()
  let outerRead, innerRead
  await withPersistenceReadScope(outer.provider, outer.transaction, async () => {
    await readPersistenceTransaction(outer.provider, async (read) => {
      outerRead = read
    })
    await withPersistenceReadScope(outer.provider, inner.transaction, async () => {
      await expect(outerRead.get('scope-proof', 'value')).rejects.toThrow(
        'PERSISTENCE_READ_SCOPE_MISMATCH'
      )
      await readPersistenceTransaction(outer.provider, async (read) => {
        innerRead = read
      })
      expect(await innerRead.get('scope-proof', 'value')).toBe('get')
    })
    await expect(innerRead.get('scope-proof', 'value')).rejects.toThrow(
      'PERSISTENCE_READ_SCOPE_CLOSED'
    )
    expect(await outerRead.get('scope-proof', 'value')).toBe('get')
  })
  await expect(outerRead.get('scope-proof', 'value')).rejects.toThrow(
    'PERSISTENCE_READ_SCOPE_CLOSED'
  )
  expect(outer.calls).toEqual(['get'])
  expect(inner.calls).toEqual(['get'])
})

test('detached unscoped read cannot outlive its provider transaction callback', async () => {
  const f = fixture()
  let pending
  const result = await readPersistenceTransaction(f.provider, async (read) => {
    pending = read.get('scope-proof', 'value').catch((error) => error.message)
    return 'callback-completed'
  }).then(
    () => 'unsafe-commit',
    (error) => error.message
  )
  f.release.resolve()
  expect(await pending).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
  expect(result).toBe('PERSISTENCE_READ_SCOPE_PENDING')
  expect(f.commits()).toBe(0)
})

test('catching nested pending rejection cannot commit the shared outer transaction', async () => {
  const f = fixture()
  let pending, innerError
  const result = await f.provider
    .transaction((tx) =>
      withPersistenceReadScope(f.provider, tx, async () => {
        await withPersistenceReadScope(f.provider, tx, async () => {
          await readPersistenceTransaction(f.provider, async (read) => {
            pending = read.get('scope-proof', 'value').catch((error) => error.message)
          })
        }).catch((error) => {
          innerError = error.message
        })
      })
    )
    .then(
      () => 'unsafe-commit',
      (error) => error.message
    )
  f.release.resolve()
  expect(await pending).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
  expect(innerError).toBe('PERSISTENCE_READ_SCOPE_PENDING')
  expect(result).toBe('PERSISTENCE_READ_SCOPE_PENDING')
  expect(f.commits()).toBe(0)
})

test('awaited individual operations and awaited nested scopes complete normally', async () => {
  const f = fixture()
  f.release.resolve()
  await f.provider.transaction((tx) =>
    withPersistenceReadScope(f.provider, tx, async () => {
      expect(
        await readPersistenceTransaction(f.provider, async (read) =>
          Promise.all([
            read.get('scope-proof', 'value'),
            read.list('scope-proof'),
            read.scan('scope-proof'),
          ])
        )
      ).toEqual(['get', 'list', 'scan'])
      await readPersistenceTransaction(f.provider, async () => {
        await withPersistenceReadScope(f.provider, tx, async () => {
          expect(
            await readPersistenceTransaction(f.provider, (read) => read.get('scope-proof', 'value'))
          ).toBe('get')
        })
      })
    })
  )
  expect(f.commits()).toBe(1)
})

test('detached nested same-transaction scope prevents commit before its first read begins', async () => {
  const f = fixture(),
    gate = deferred()
  f.release.resolve()
  let nested
  const result = await f.provider
    .transaction((tx) =>
      withPersistenceReadScope(f.provider, tx, async () => {
        nested = withPersistenceReadScope(f.provider, tx, async () => {
          await gate.promise
          return readPersistenceTransaction(f.provider, (read) => read.get('scope-proof', 'value'))
        }).catch((error) => error.message)
      })
    )
    .then(
      () => 'unsafe-commit',
      (error) => error.message
    )
  gate.resolve()
  const outcome = await nested
  expect(result).toBe('PERSISTENCE_READ_SCOPE_PENDING')
  expect(outcome).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
  expect(f.commits()).toBe(0)
  expect(f.calls).toEqual([])
})

test('a detached nested scope is tracked even when it never starts a read', async () => {
  const f = fixture(),
    gate = deferred()
  let nested
  const result = await f.provider
    .transaction((tx) =>
      withPersistenceReadScope(f.provider, tx, async () => {
        nested = withPersistenceReadScope(f.provider, tx, async () => {
          await gate.promise
          return 'late-success'
        }).catch((error) => error.message)
      })
    )
    .then(
      () => 'unsafe-commit',
      (error) => error.message
    )
  gate.resolve()
  expect(await nested).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
  expect(result).toBe('PERSISTENCE_READ_SCOPE_PENDING')
  expect(f.commits()).toBe(0)
})

test('catching a middle-scope refusal cannot detach a gated deepest scope from outer lifetime', async () => {
  const f = fixture(),
    gate = deferred()
  f.release.resolve()
  let deepest, middleError
  const result = await f.provider
    .transaction((tx) =>
      withPersistenceReadScope(f.provider, tx, async () => {
        await withPersistenceReadScope(f.provider, tx, async () => {
          deepest = withPersistenceReadScope(f.provider, tx, async () => {
            await gate.promise
            return readPersistenceTransaction(f.provider, (read) =>
              read.get('scope-proof', 'value')
            )
          }).catch((error) => error.message)
        }).catch((error) => {
          middleError = error.message
        })
      })
    )
    .then(
      () => 'unsafe-commit',
      (error) => error.message
    )
  gate.resolve()
  expect(await deepest).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
  expect(middleError).toBe('PERSISTENCE_READ_SCOPE_PENDING')
  expect(result).toBe('PERSISTENCE_READ_SCOPE_PENDING')
  expect(f.commits()).toBe(0)
  expect(f.calls).toEqual([])
})

test('a same-transaction scope cannot be resurrected from an expired async ancestor', async () => {
  const f = fixture(),
    gate = deferred()
  f.release.resolve()
  let late
  await f.provider.transaction((tx) =>
    withPersistenceReadScope(f.provider, tx, async () => {
      late = gate.promise
        .then(() =>
          withPersistenceReadScope(f.provider, tx, async () => {
            return readPersistenceTransaction(f.provider, (read) =>
              read.get('scope-proof', 'value')
            )
          })
        )
        .catch((error) => error.message)
    })
  )
  gate.resolve()
  expect(await late).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
  expect(f.commits()).toBe(1)
  expect(f.calls).toEqual([])
})

test('detached independent-provider scope keeps its own lifetime and does not block outer commit', async () => {
  const first = fixture(),
    second = fixture(),
    gate = deferred()
  second.release.resolve()
  let independent
  await first.provider.transaction((tx) =>
    withPersistenceReadScope(first.provider, tx, async () => {
      independent = second.provider.transaction((otherTx) =>
        withPersistenceReadScope(second.provider, otherTx, async () => {
          await gate.promise
          return readPersistenceTransaction(second.provider, (read) =>
            read.get('scope-proof', 'value')
          )
        })
      )
    })
  )
  expect(first.commits()).toBe(1)
  expect(second.commits()).toBe(0)
  gate.resolve()
  expect(await independent).toBe('get')
  expect(second.commits()).toBe(1)
  expect(first.calls).toEqual([])
})

test('closing only the middle ancestor fences a captured grandchild reader while outer stays active', async () => {
  const f = fixture(),
    gate = deferred(),
    started = deferred()
  f.release.resolve()
  let deepest, middleError
  await f.provider.transaction((tx) =>
    withPersistenceReadScope(f.provider, tx, async () => {
      await withPersistenceReadScope(f.provider, tx, async () => {
        deepest = withPersistenceReadScope(f.provider, tx, async () => {
          let captured
          await readPersistenceTransaction(f.provider, async (read) => {
            captured = read
          })
          started.resolve()
          await gate.promise
          return captured.get('scope-proof', 'value')
        }).catch((error) => error.message)
        await started.promise
        throw new Error('INTENTIONAL_MIDDLE_SCOPE_FAILURE')
      }).catch((error) => {
        middleError = error.message
      })
      expect(middleError).toBe('INTENTIONAL_MIDDLE_SCOPE_FAILURE')
      // This successful outer read witnesses that only the middle ancestor closed.
      expect(
        await readPersistenceTransaction(f.provider, (read) => read.get('scope-proof', 'value'))
      ).toBe('get')
      gate.resolve()
      expect(await deepest).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
      expect(f.calls).toEqual(['get'])
    })
  )
  expect(f.commits()).toBe(1)
})

test('closing outer ancestor fences all captured grandchild operations while middle and grandchild wait', async () => {
  const f = fixture(),
    gate = deferred(),
    started = deferred()
  f.release.resolve()
  let bridge, outcomes
  const result = await f.provider
    .transaction((tx) =>
      withPersistenceReadScope(f.provider, tx, async () => {
        bridge = withPersistenceReadScope(f.provider, tx, async () => {
          return withPersistenceReadScope(f.provider, tx, async () => {
            let captured
            await readPersistenceTransaction(f.provider, async (read) => {
              captured = read
            })
            started.resolve()
            await gate.promise
            outcomes = await Promise.all(
              ['get', 'list', 'scan'].map((name) =>
                captured[name]('scope-proof', 'value').catch((error) => error.message)
              )
            )
          })
        }).catch((error) => error.message)
        await started.promise
      })
    )
    .then(
      () => 'unsafe-commit',
      (error) => error.message
    )
  gate.resolve()
  expect(await bridge).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
  expect(outcomes).toEqual([
    'PERSISTENCE_READ_SCOPE_CLOSED',
    'PERSISTENCE_READ_SCOPE_CLOSED',
    'PERSISTENCE_READ_SCOPE_CLOSED',
  ])
  expect(result).toBe('PERSISTENCE_READ_SCOPE_PENDING')
  expect(f.commits()).toBe(0)
  expect(f.calls).toEqual([])
})

test('an independent-provider descendant remains valid after its spawning middle scope closes', async () => {
  const first = fixture(),
    second = fixture(),
    gate = deferred(),
    started = deferred()
  second.release.resolve()
  let independent, middleError
  await first.provider.transaction((tx) =>
    withPersistenceReadScope(first.provider, tx, async () => {
      await withPersistenceReadScope(first.provider, tx, async () => {
        independent = second.provider.transaction((otherTx) =>
          withPersistenceReadScope(second.provider, otherTx, async () => {
            started.resolve()
            await gate.promise
            return readPersistenceTransaction(second.provider, (read) =>
              read.get('scope-proof', 'value')
            )
          })
        )
        await started.promise
        throw new Error('INTENTIONAL_MIDDLE_SCOPE_FAILURE')
      }).catch((error) => {
        middleError = error.message
      })
      expect(middleError).toBe('INTENTIONAL_MIDDLE_SCOPE_FAILURE')
    })
  )
  expect(first.commits()).toBe(1)
  expect(second.commits()).toBe(0)
  gate.resolve()
  expect(await independent).toBe('get')
  expect(second.commits()).toBe(1)
  expect(first.calls).toEqual([])
  expect(second.calls).toEqual(['get'])
})

test('properly awaited three-level nesting and a caught grandchild failure leave outer usable', async () => {
  const f = fixture()
  f.release.resolve()
  await f.provider.transaction((tx) =>
    withPersistenceReadScope(f.provider, tx, async () => {
      await readPersistenceTransaction(f.provider, async () => {
        await withPersistenceReadScope(f.provider, tx, async () => {
          await withPersistenceReadScope(f.provider, tx, async () => {
            expect(
              await readPersistenceTransaction(f.provider, (read) =>
                Promise.all([
                  read.get('scope-proof', 'value'),
                  read.list('scope-proof'),
                  read.scan('scope-proof'),
                ])
              )
            ).toEqual(['get', 'list', 'scan'])
          })
          await expect(
            withPersistenceReadScope(f.provider, tx, async () => {
              throw new Error('INTENTIONAL_GRANDCHILD_FAILURE')
            })
          ).rejects.toThrow('INTENTIONAL_GRANDCHILD_FAILURE')
        })
      })
      expect(
        await readPersistenceTransaction(f.provider, (read) => read.get('scope-proof', 'value'))
      ).toBe('get')
    })
  )
  expect(f.calls).toEqual(['get', 'list', 'scan', 'get'])
  expect(f.commits()).toBe(1)
})

function interposedFixtures(kind) {
  const first = fixture(),
    second = fixture()
  first.release.resolve()
  second.release.resolve()
  if (kind === 'different provider') {
    return { first, second, outerProvider: first.provider, middleProvider: second.provider }
  }
  let opened = 0
  const provider = {
    transaction: (operation) =>
      (opened++ === 0 ? first.provider : second.provider).transaction(operation),
  }
  return { first, second, outerProvider: provider, middleProvider: provider }
}

for (const kind of ['different provider', 'different transaction']) {
  for (const name of ['get', 'list', 'scan']) {
    test(`an interposed ${kind} cannot hide a detached shared-transaction ${name} lifetime`, async () => {
      const f = interposedFixtures(kind),
        gate = deferred(),
        started = deferred()
      let middle, detached
      const outerResult = await f.outerProvider
        .transaction((txA) =>
          withPersistenceReadScope(f.outerProvider, txA, async () => {
            middle = f.middleProvider
              .transaction((txB) =>
                withPersistenceReadScope(f.middleProvider, txB, async () => {
                  detached = withPersistenceReadScope(f.outerProvider, txA, async () => {
                    started.resolve()
                    await gate.promise
                    return readPersistenceTransaction(f.outerProvider, (read) =>
                      read[name]('scope-proof', 'value')
                    )
                  }).catch((error) => error.message)
                  const result = await detached
                  // B's own transaction remains independent of the expired A scope.
                  expect(
                    await readPersistenceTransaction(f.middleProvider, (read) =>
                      read.get('scope-proof', 'value')
                    )
                  ).toBe('get')
                  return result
                })
              )
              .catch((error) => error.message)
            await started.promise
          })
        )
        .then(
          () => 'unsafe-commit',
          (error) => error.message
        )
      gate.resolve()
      const detachedResult = await middle
      expect({
        outerResult,
        detachedResult,
        firstCommits: f.first.commits(),
        secondCommits: f.second.commits(),
        firstCalls: f.first.calls,
        secondCalls: f.second.calls,
      }).toEqual({
        outerResult: 'PERSISTENCE_READ_SCOPE_PENDING',
        detachedResult: 'PERSISTENCE_READ_SCOPE_CLOSED',
        firstCommits: 0,
        secondCommits: 1,
        firstCalls: [],
        secondCalls: ['get'],
      })
    })
  }

  test(`an interposed ${kind} cannot resurrect an expired ancestor before its callback`, async () => {
    const f = interposedFixtures(kind),
      gate = deferred(),
      started = deferred()
    let middle,
      callbackEntries = 0
    await f.outerProvider.transaction((txA) =>
      withPersistenceReadScope(f.outerProvider, txA, async () => {
        middle = f.middleProvider.transaction((txB) =>
          withPersistenceReadScope(f.middleProvider, txB, async () => {
            started.resolve()
            await gate.promise
            const result = await withPersistenceReadScope(f.outerProvider, txA, async () => {
              callbackEntries++
              return readPersistenceTransaction(f.outerProvider, (read) =>
                read.get('scope-proof', 'value')
              )
            }).catch((error) => error.message)
            expect(
              await readPersistenceTransaction(f.middleProvider, (read) =>
                read.get('scope-proof', 'value')
              )
            ).toBe('get')
            return result
          })
        )
        await started.promise
      })
    )
    gate.resolve()
    expect({
      result: await middle,
      callbackEntries,
      firstCalls: f.first.calls,
      secondCalls: f.second.calls,
      firstCommits: f.first.commits(),
      secondCommits: f.second.commits(),
    }).toEqual({
      result: 'PERSISTENCE_READ_SCOPE_CLOSED',
      callbackEntries: 0,
      firstCalls: [],
      secondCalls: ['get'],
      firstCommits: 1,
      secondCommits: 1,
    })
  })

  test(`metadata writes remain denied through an interposed ${kind}`, async () => {
    const f = interposedFixtures(kind)
    let writeEntries = 0,
      outcome
    await f.outerProvider.transaction((txA) =>
      withPersistenceReadScope(f.outerProvider, txA, () =>
        f.middleProvider.transaction((txB) =>
          withPersistenceReadScope(f.middleProvider, txB, async () => {
            try {
              await writePersistenceTransaction(f.outerProvider, async () => {
                writeEntries++
              })
              outcome = 'unsafe-write'
            } catch (error) {
              outcome = error.message
            }
            expect(
              await readPersistenceTransaction(f.middleProvider, (read) =>
                read.get('scope-proof', 'value')
              )
            ).toBe('get')
          })
        )
      )
    )
    expect({
      outcome,
      writeEntries,
      firstCommits: f.first.commits(),
      secondCommits: f.second.commits(),
      firstCalls: f.first.calls,
    }).toEqual({
      outcome: 'PERSISTENCE_READ_SCOPE_WRITE_DENIED',
      writeEntries: 0,
      firstCommits: 1,
      secondCommits: 1,
      firstCalls: [],
    })
  })

  test(`properly awaited reentry through an interposed ${kind} preserves both transactions`, async () => {
    const f = interposedFixtures(kind)
    await f.outerProvider.transaction((txA) =>
      withPersistenceReadScope(f.outerProvider, txA, () =>
        f.middleProvider.transaction((txB) =>
          withPersistenceReadScope(f.middleProvider, txB, async () => {
            await withPersistenceReadScope(f.outerProvider, txA, async () => {
              expect(
                await readPersistenceTransaction(f.outerProvider, (read) =>
                  Promise.all(
                    ['get', 'list', 'scan'].map((name) => read[name]('scope-proof', 'value'))
                  )
                )
              ).toEqual(['get', 'list', 'scan'])
            })
            expect(
              await readPersistenceTransaction(f.middleProvider, (read) =>
                read.get('scope-proof', 'value')
              )
            ).toBe('get')
          })
        )
      )
    )
    expect(f.first.calls).toEqual(['get', 'list', 'scan'])
    expect(f.second.calls).toEqual(['get'])
    expect(f.first.commits()).toBe(1)
    expect(f.second.commits()).toBe(1)
  })
}

test('fresh metadata reads through another provider borrow only their matching active ancestor', async () => {
  const first = fixture(),
    second = fixture()
  first.release.resolve()
  second.release.resolve()
  let entries = 0
  const provider = {
    transaction: async (operation) => {
      if (++entries !== 1) throw new Error('REENTERED_LOCKED_PROVIDER')
      return first.provider.transaction(operation)
    },
  }
  await provider.transaction((txA) =>
    withPersistenceReadScope(provider, txA, () =>
      second.provider.transaction((txB) =>
        withPersistenceReadScope(second.provider, txB, async () => {
          expect(
            await readPersistenceTransaction(provider, (read) => read.get('scope-proof', 'value'))
          ).toBe('get')
          expect(
            await readPersistenceTransaction(second.provider, (read) => read.list('scope-proof'))
          ).toBe('list')
        })
      )
    )
  )
  expect(entries).toBe(1)
  expect(first.calls).toEqual(['get'])
  expect(second.calls).toEqual(['list'])
})

for (const kind of ['different provider', 'different transaction']) {
  test(`closing an interposed ${kind} does not close a still-active reentered ancestor`, async () => {
    const f = interposedFixtures(kind),
      gate = deferred(),
      started = deferred()
    let reentered
    await f.outerProvider.transaction((txA) =>
      withPersistenceReadScope(f.outerProvider, txA, async () => {
        await f.middleProvider
          .transaction((txB) =>
            withPersistenceReadScope(f.middleProvider, txB, async () => {
              reentered = withPersistenceReadScope(f.outerProvider, txA, async () => {
                started.resolve()
                await gate.promise
                return readPersistenceTransaction(f.outerProvider, (read) =>
                  read.get('scope-proof', 'value')
                )
              }).catch((error) => error.message)
              await started.promise
              throw new Error('INTENTIONAL_INTERPOSER_FAILURE')
            })
          )
          .catch((error) => expect(error.message).toBe('INTENTIONAL_INTERPOSER_FAILURE'))
        gate.resolve()
        expect(await reentered).toBe('get')
      })
    )
    expect(f.first.calls).toEqual(['get'])
    expect(f.second.calls).toEqual([])
    expect(f.first.commits()).toBe(1)
    expect(f.second.commits()).toBe(0)
  })
}

test('expired provider ancestry through a live independent scope refuses fresh reads and writes', async () => {
  const f = interposedFixtures('different provider'),
    gate = deferred(),
    started = deferred()
  let middle,
    writes = 0
  await f.outerProvider.transaction((txA) =>
    withPersistenceReadScope(f.outerProvider, txA, async () => {
      middle = f.middleProvider.transaction((txB) =>
        withPersistenceReadScope(f.middleProvider, txB, async () => {
          started.resolve()
          await gate.promise
          const read = await readPersistenceTransaction(f.outerProvider, (reader) =>
            reader.get('scope-proof', 'value')
          ).then(
            () => 'unsafe-read',
            (error) => error.message
          )
          let write
          try {
            await writePersistenceTransaction(f.outerProvider, async () => {
              writes++
            })
            write = 'unsafe-write'
          } catch (error) {
            write = error.message
          }
          expect(
            await readPersistenceTransaction(f.middleProvider, (reader) =>
              reader.get('scope-proof', 'value')
            )
          ).toBe('get')
          return { read, write }
        })
      )
      await started.promise
    })
  )
  gate.resolve()
  expect(await middle).toEqual({
    read: 'PERSISTENCE_READ_SCOPE_CLOSED',
    write: 'PERSISTENCE_READ_SCOPE_CLOSED',
  })
  expect(writes).toBe(0)
  expect(f.first.calls).toEqual([])
  expect(f.second.calls).toEqual(['get'])
  expect(f.first.commits()).toBe(1)
  expect(f.second.commits()).toBe(1)
})
